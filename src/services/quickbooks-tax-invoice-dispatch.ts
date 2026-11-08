import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { QuickBooksCredentialRuntimeEnv } from "../config/quickbooks-runtime-types";
import { withTenantRlsContext } from "../lib/tenant-rls";
import { lockAndReadCurrentCanonicalTaxEstimate } from "./quickbooks-tax-estimate-ledger";
import { getSerializedQuickBooksAccessToken, runQuickBooksProviderRequestWithRefresh } from "./quickbooks-credentials";
import { createQuickBooksInvoice, createQuickBooksInvoiceWriteControl,
  classifyQuickBooksInvoiceWriteFailure, fetchQuickBooksCanonicalTaxEstimate,
  fetchQuickBooksCanonicalTaxInvoice } from "./quickbooks";
import { assertQuickBooksTaxInvoiceCreateFence, claimReviewedQuickBooksTaxInvoice,
  quarantineQuickBooksTaxInvoiceAttempt, QuickBooksTaxInvoiceError,
  readCanonicalTaxInvoiceCredentialTarget, recordQuickBooksTaxInvoiceProjectionMatch,
  retainCreatedQuickBooksTaxInvoiceIdentity } from "./quickbooks-tax-invoices";

const commandSchema = z.strictObject({ taxEstimateOperationId: z.string().min(1).max(191),
  idempotencyKey: z.string().uuid() });
const READBACK_BUDGET_MS = 20_000;
type Actor = Readonly<{ tenantId: string; userId: string; authVersion: number; requestId: string }>;
type Runtime = QuickBooksCredentialRuntimeEnv & Readonly<{
  QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: boolean;
  QUICKBOOKS_OAUTH_ONLY_MODE: boolean;
}>;
type Outcome = "DISABLED" | "EXISTING_ATTEMPT" | "NO_POST_FAILURE" | "RESULT_UNKNOWN"
  | "IDENTITY_RETAINED_READBACK_PENDING" | "EVIDENCE_RECORDED";

export class QuickBooksTaxInvoiceDispatchError extends Error {
  constructor(readonly code: string) { super(code); this.name = "QuickBooksTaxInvoiceDispatchError"; }
}

function result(outcome: Outcome, providerCreateAttempted = false, providerIdentityRetained = false,
  recoveryStatePersisted = false) {
  return Object.freeze({ outcome, providerCreateAttempted, providerIdentityRetained,
    recoveryStatePersisted, estimateInvoiceParityProven: false as const,
    publishingAuthorized: false as const });
}

function sameConnection(left: { id: string; tenantId: string; realmId: string; environment: string; generation: number },
  right: { id: string; tenantId: string; realmId: string; environment: string; generation: number }) {
  return left.id === right.id && left.tenantId === right.tenantId && left.realmId === right.realmId
    && left.environment === right.environment && left.generation === right.generation;
}

/** Internal only. No route/worker registers this dispatcher, and no result authorizes publication.
 * A create is invoked once. After uncertainty or restart, recovery must use a separately reviewed GET-only path.
 */
export async function dispatchReviewedQuickBooksTaxInvoiceOnce(params: {
  prisma: PrismaClient; actor: Actor; runtimeEnv: Runtime; command: unknown;
}) {
  const { prisma, actor, runtimeEnv } = params;
  const parsed = commandSchema.safeParse(params.command);
  if (!parsed.success) throw new QuickBooksTaxInvoiceDispatchError("QUICKBOOKS_TAX_INVOICE_INPUT_INVALID");
  if (runtimeEnv.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED !== true
    || runtimeEnv.QUICKBOOKS_OAUTH_ONLY_MODE !== false) return result("DISABLED");

  // Credential refresh precedes durable create intent. Never put CREATE inside the refresh callback.
  let target: Awaited<ReturnType<typeof readCanonicalTaxInvoiceCredentialTarget>>;
  try {
    target = await readCanonicalTaxInvoiceCredentialTarget(prisma, actor, runtimeEnv, parsed.data.taxEstimateOperationId);
  } catch (error) {
    if (error instanceof QuickBooksTaxInvoiceError && error.code === "QUICKBOOKS_TAX_INVOICE_OPERATION_EXISTS") {
      return result("EXISTING_ATTEMPT");
    }
    throw error;
  }
  const accessToken = await getSerializedQuickBooksAccessToken({ prisma, runtimeEnv, connection: target.connection });
  const claimed = await claimReviewedQuickBooksTaxInvoice(prisma, actor, runtimeEnv, parsed.data);
  if (claimed.outcome !== "CLAIMED") return result("EXISTING_ATTEMPT");
  const dispatch = claimed.dispatch;
  const retainedInput = { tenantId: actor.tenantId, operationId: claimed.operation.id,
    providerRequestId: dispatch.attempt.providerRequestId, attemptToken: dispatch.attempt.attemptToken };
  const persistFailure = async (failureCode: string, providerInvoiceId?: string) => {
    try {
      await quarantineQuickBooksTaxInvoiceAttempt(prisma, { ...retainedInput, failureCode,
        ...(providerInvoiceId ? { providerInvoiceId } : {}) });
      return true;
    } catch {
      // A database outage must not cause another create. The original lease/attempt remains recoverable.
      return false;
    }
  };
  if (!sameConnection(target.connection, dispatch.connection)) {
    return result("NO_POST_FAILURE", false, false,
      await persistFailure("QUICKBOOKS_TAX_INVOICE_CREDENTIAL_TARGET_CHANGED"));
  }
  const control = createQuickBooksInvoiceWriteControl({
    payload: dispatch.requestProjection, providerRequestId: dispatch.attempt.providerRequestId,
    realmId: dispatch.connection.realmId, claimDeadlineAtMs: Date.parse(dispatch.attempt.claimExpiresAtUtc),
    beforeCreate: async () => {
      const fenced = await assertQuickBooksTaxInvoiceCreateFence(prisma, actor, runtimeEnv, dispatch.attempt);
      if (!sameConnection(target.connection, fenced.dispatch.connection)
        || JSON.stringify(fenced.dispatch) !== JSON.stringify(dispatch)) {
        throw new QuickBooksTaxInvoiceDispatchError("QUICKBOOKS_TAX_INVOICE_DISPATCH_CHANGED");
      }
    },
  });
  let providerInvoiceId: string;
  try {
    const created = await createQuickBooksInvoice(runtimeEnv, dispatch.connection.realmId, accessToken,
      dispatch.requestProjection, dispatch.attempt.providerRequestId, control);
    providerInvoiceId = created.Id;
  } catch (error) {
    const classified = classifyQuickBooksInvoiceWriteFailure(error, control);
    const code = !control.postAttempted ? "QUICKBOOKS_TAX_INVOICE_PRECREATE_FAILED"
      : classified.ambiguous ? "QUICKBOOKS_TAX_INVOICE_RESULT_UNKNOWN" : "QUICKBOOKS_TAX_INVOICE_CREATE_REJECTED";
    return result(control.postAttempted ? "RESULT_UNKNOWN" : "NO_POST_FAILURE",
      control.postAttempted, false, await persistFailure(code));
  }

  // Save the irreversible provider identity before any canonical GET or local authority recheck.
  try {
    await retainCreatedQuickBooksTaxInvoiceIdentity(prisma, { ...retainedInput, providerInvoiceId });
  } catch {
    // The fallback transaction must carry the known irreversible identity too.
    // Persisting an ID-less failure here would discard evidence after a transient DB failure.
    const retained = await persistFailure("QUICKBOOKS_TAX_INVOICE_IDENTITY_RETENTION_PENDING", providerInvoiceId);
    return result(retained ? "IDENTITY_RETAINED_READBACK_PENDING" : "RESULT_UNKNOWN", true, retained, retained);
  }
  try {
    // Retention itself grants no continuation. Recheck the actor, current source and connection
    // before acquiring credentials for GET-only evidence collection after the irreversible write.
    const current = await withTenantRlsContext(prisma, actor.tenantId, (tx) =>
      lockAndReadCurrentCanonicalTaxEstimate(tx, actor, runtimeEnv, dispatch.attempt.taxEstimateOperationId,
        { allowedInvoiceOperationId: claimed.operation.id }));
    const connection = current.review.source.connection;
    if (!sameConnection(dispatch.connection, { ...connection, tenantId: actor.tenantId })) {
      throw new QuickBooksTaxInvoiceDispatchError("QUICKBOOKS_TAX_INVOICE_CONNECTION_CHANGED");
    }
    const deadlineAtMs = Date.now() + READBACK_BUDGET_MS;
    const expectedEstimateId = dispatch.requestProjection.LinkedTxn[0].TxnId;
    const observations = await runQuickBooksProviderRequestWithRefresh({ prisma, runtimeEnv,
      connection: dispatch.connection, operation: async (token) => {
        const canonicalInvoice = await fetchQuickBooksCanonicalTaxInvoice(runtimeEnv,
          dispatch.connection.realmId, token, providerInvoiceId, { deadlineAtMs, expectedEstimateId });
        const canonicalEstimate = await fetchQuickBooksCanonicalTaxEstimate(runtimeEnv,
          dispatch.connection.realmId, token, expectedEstimateId, { deadlineAtMs });
        return { canonicalInvoice, canonicalEstimate };
      } });
    const recorded = await recordQuickBooksTaxInvoiceProjectionMatch(prisma, actor, runtimeEnv,
      { ...retainedInput, providerInvoiceId, ...observations });
    return result(recorded.outcome === "RECORDED" || recorded.outcome === "ALREADY_RECORDED"
      ? "EVIDENCE_RECORDED" : "IDENTITY_RETAINED_READBACK_PENDING", true, true, true);
  } catch {
    return result("IDENTITY_RETAINED_READBACK_PENDING", true, true,
      await persistFailure("QUICKBOOKS_TAX_INVOICE_CANONICAL_READBACK_PENDING"));
  }
}
