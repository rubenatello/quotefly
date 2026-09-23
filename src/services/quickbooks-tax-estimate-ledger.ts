import { createHash, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { JwtClaims } from "../lib/auth";
import { withTenantRlsContext } from "../lib/tenant-rls";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "./quickbooks-setup";
import { lockQuickBooksInvoicePublication } from "./quickbooks-locks";
import { createQuickBooksTaxReview, verifyQuickBooksTaxReview, type TaxReviewSource } from "./quickbooks-tax-review-contract";

type Transaction = Prisma.TransactionClient;
type Actor = Pick<JwtClaims, "tenantId" | "userId" | "authVersion">;
type KeyEnvironment = {
  QUICKBOOKS_TOKEN_ENCRYPTION_KEY: string;
  QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS?: string;
};
const CLAIM_MS = 120_000;
const FACT_MAX_AGE_MS = 5 * 60_000;
const REVIEW_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 15_000 };
const UNCERTAIN_CODE = "QUICKBOOKS_ESTIMATE_RECONCILIATION_REQUIRED";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const normalizedText = (value: string) => value.normalize("NFC").trim();
const itemKey = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);

/** Fixed diagnostics only; never attach input, snapshots, provider errors or keys. */
export class QuickBooksTaxLedgerError extends Error {
  constructor(readonly code: string) { super(code); this.name = "QuickBooksTaxLedgerError"; }
}
function reject(code: string): never { throw new QuickBooksTaxLedgerError(code); }

function keyFor(secret: string) {
  const material = secret.trim();
  if (material.length < 32) return reject("QUICKBOOKS_TAX_REVIEW_KEY_UNAVAILABLE");
  const key = Buffer.from(hkdfSync("sha256", material, "quotefly/quickbooks", "quotefly/quickbooks/tax-review/v1", 32)).toString("hex");
  return { key, id: sha256(`quotefly/quickbooks/tax-review/key-id:${key}`).slice(0, 32) };
}

/** Internal trusted-reader boundary, not a route or a client-supplied-facts signer. */
export function prepareQuickBooksTaxEstimateReview(source: unknown, environment: KeyEnvironment) {
  return createQuickBooksTaxReview(source, keyFor(environment.QUICKBOOKS_TOKEN_ENCRYPTION_KEY).key);
}

function verifiedReview(source: unknown, binding: string, environment: KeyEnvironment) {
  const candidates = [environment.QUICKBOOKS_TOKEN_ENCRYPTION_KEY, environment.QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS]
    .filter((value): value is string => Boolean(value?.trim()));
  for (const candidate of candidates) {
    const derived = keyFor(candidate);
    if (verifyQuickBooksTaxReview(source, derived.key, binding)) {
      return { review: createQuickBooksTaxReview(source, derived.key), keyId: derived.id };
    }
  }
  return reject("QUICKBOOKS_TAX_REVIEW_CHANGED");
}

async function lockManager(tx: Transaction, actor: Actor) {
  // Stabilize live authorization without blocking FK KEY SHARE checks from a
  // lifecycle audit transaction whose customer/job/quote row we may next await.
  // NO KEY UPDATE still excludes demotion, authVersion and soft-delete writes.
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Tenant" WHERE "id" = ${actor.tenantId} FOR NO KEY UPDATE`);
  const rows = await tx.$queryRaw<Array<{ id: string; role: string; authVersion: number }>>(Prisma.sql`
    SELECT membership."id", membership."role", account."authVersion"
    FROM "TenantUser" membership JOIN "User" account ON account."id" = membership."userId"
    JOIN "Tenant" tenant ON tenant."id" = membership."tenantId"
    WHERE membership."tenantId" = ${actor.tenantId} AND membership."userId" = ${actor.userId}
      AND membership."deletedAtUtc" IS NULL AND account."deletedAtUtc" IS NULL AND tenant."deletedAtUtc" IS NULL
    FOR NO KEY UPDATE OF membership, account, tenant
  `);
  const member = rows[0];
  if (!member || !["owner", "admin"].includes(member.role) || member.authVersion !== actor.authVersion) {
    return reject("QUICKBOOKS_TAX_MANAGER_REQUIRED");
  }
  return member.id;
}

async function lockInvoice(tx: Transaction, tenantId: string, invoiceId: string) {
  await lockQuickBooksInvoicePublication(tx, tenantId, invoiceId);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "QuickBooksConnection" WHERE "tenantId" = ${tenantId} FOR UPDATE`);
  const linked = await tx.invoice.findFirst({ where: { tenantId, id: invoiceId },
    select: { customerId: true, jobId: true, sourceQuoteId: true } });
  if (!linked) return;
  // Keep the exact linked lifecycle rows stable until the final source checks
  // and ledger write commit. Follow the customer -> job -> quote -> invoice order.
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Customer" WHERE "tenantId" = ${tenantId} AND "id" = ${linked.customerId} FOR NO KEY UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Job" WHERE "tenantId" = ${tenantId} AND "id" = ${linked.jobId} FOR NO KEY UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Quote" WHERE "tenantId" = ${tenantId} AND "id" = ${linked.sourceQuoteId} FOR NO KEY UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Invoice" WHERE "tenantId" = ${tenantId} AND "id" = ${invoiceId} FOR NO KEY UPDATE`);
}

function requireFreshFacts(source: TaxReviewSource, now: Date) {
  const observations = [source.preferences.observedAtUtc, source.customerFacts.observedAtUtc,
    ...source.lines.map((line) => line.itemFacts.observedAtUtc)];
  if (observations.some((timestamp) => {
    const age = now.getTime() - Date.parse(timestamp);
    return age < -5_000 || age > FACT_MAX_AGE_MS;
  })) reject("QUICKBOOKS_TAX_FACTS_STALE");
}

async function requireCurrentSource(tx: Transaction, actor: Actor, source: TaxReviewSource, now: Date) {
  if (source.tenantId !== actor.tenantId) reject("QUICKBOOKS_TAX_REVIEW_CHANGED");
  requireFreshFacts(source, now);
  const [invoiceOperation, legacyInvoice] = await Promise.all([
    tx.quickBooksInvoiceOperation.findUnique({ where: {
      tenantId_invoiceId: { tenantId: actor.tenantId, invoiceId: source.invoiceId },
    }, select: { id: true } }),
    tx.quickBooksInvoiceSync.findFirst({ where: {
      tenantId: actor.tenantId, quoteId: source.sourceQuoteId,
      // Local soft deletion does not erase the remote financial record.
      quickBooksInvoiceId: { not: null },
    }, select: { id: true } }),
  ]);
  if (invoiceOperation || legacyInvoice) reject("QUICKBOOKS_TAX_COMPETING_INVOICE_OPERATION");
  const connection = await tx.quickBooksConnection.findFirst({ where: {
    id: source.connection.id, tenantId: actor.tenantId, realmId: source.connection.realmId,
    connectedAtUtc: new Date(source.connection.connectedAtUtc), environment: source.connection.environment,
    status: "CONNECTED", deletedAtUtc: null, disconnectRequestedAtUtc: null,
    setupConfirmedAtUtc: { not: null }, setupConfirmedByTenantUserId: { not: null },
    setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
    realmBinding: { is: { tenantId: actor.tenantId, realmId: source.connection.realmId, active: true } },
  }, select: { id: true } });
  if (!connection) reject("QUICKBOOKS_TAX_CONNECTION_CHANGED");
  const invoice = await tx.invoice.findFirst({ where: {
    id: source.invoiceId, tenantId: actor.tenantId, version: source.invoiceVersion,
    customerId: source.customerId, sourceQuoteId: source.sourceQuoteId,
    deletedAtUtc: null, archivedAtUtc: null, status: "DRAFT", paymentStatus: "PENDING", amountPaid: 0,
    customer: { deletedAtUtc: null, archivedAtUtc: null },
    job: { deletedAtUtc: null, archivedAtUtc: null },
    sourceQuote: { deletedAtUtc: null, archivedAtUtc: null, status: "ACCEPTED" },
  }, select: { currency: true, subtotalAmount: true, taxAmount: true, totalAmount: true, balanceDue: true,
    lineItems: { where: { sectionType: "INCLUDED" }, orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true, position: true, description: true, quantity: true, unitPrice: true, lineTotal: true } } } });
  if (!invoice || invoice.currency !== source.currency || invoice.subtotalAmount.toFixed(2) !== source.subtotal
    || invoice.taxAmount.toFixed(2) !== source.quotedTax || invoice.totalAmount.toFixed(2) !== source.total
    || !invoice.balanceDue.equals(invoice.totalAmount)
    || invoice.lineItems.length !== source.lines.length) reject("QUICKBOOKS_TAX_INVOICE_CHANGED");
  for (const [index, line] of invoice.lineItems.entries()) {
    const reviewed = source.lines[index];
    if (line.id !== reviewed.invoiceLineItemId || line.position !== reviewed.position
      || normalizedText(line.description) !== reviewed.description || line.quantity.toFixed(2) !== reviewed.quantity
      || line.unitPrice.toFixed(2) !== reviewed.unitPrice || line.lineTotal.toFixed(2) !== reviewed.amount) {
      reject("QUICKBOOKS_TAX_INVOICE_CHANGED");
    }
  }
  // Lock reviewed mapping rows while their versions and ownership are checked.
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "QuickBooksCustomerMap" WHERE "tenantId" = ${actor.tenantId}
    AND "id" = ${source.customerMapping.id} FOR SHARE`);
  const mapIds = [...new Set(source.lines.map((line) => line.itemMapping.id))].sort();
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "QuickBooksItemMap" WHERE "tenantId" = ${actor.tenantId}
    AND "id" IN (${Prisma.join(mapIds)}) ORDER BY "id" FOR SHARE`);
  const customerMap = await tx.quickBooksCustomerMap.findFirst({ where: {
    id: source.customerMapping.id, tenantId: actor.tenantId, customerId: source.customerId,
    quickBooksConnectionId: source.connection.id, quickBooksCustomerId: source.customerMapping.providerId,
    reviewVersion: source.customerMapping.reviewVersion, reviewedAtUtc: new Date(source.customerMapping.reviewedAtUtc),
    reviewedByTenantUserId: { not: null }, deletedAtUtc: null,
  }, select: { id: true } });
  const itemMaps = await tx.quickBooksItemMap.findMany({ where: {
    id: { in: mapIds }, tenantId: actor.tenantId, quickBooksConnectionId: source.connection.id,
    deletedAtUtc: null, reviewedByTenantUserId: { not: null },
  }, select: { id: true, itemKey: true, quickBooksItemId: true, reviewVersion: true, reviewedAtUtc: true } });
  if (!customerMap) reject("QUICKBOOKS_TAX_MAPPING_CHANGED");
  for (const line of source.lines) {
    const map = itemMaps.find((entry) => entry.id === line.itemMapping.id);
    if (!map || map.itemKey !== itemKey(line.description) || map.quickBooksItemId !== line.itemMapping.providerId
      || map.reviewVersion !== line.itemMapping.reviewVersion || map.reviewedAtUtc?.toISOString() !== line.itemMapping.reviewedAtUtc) {
      reject("QUICKBOOKS_TAX_MAPPING_CHANGED");
    }
  }
}

const summarySelect = {
  id: true, status: true, reviewRevision: true, sourceHash: true, estimateAstHash: true,
  estimateRequestId: true, invoiceRequestId: true, providerEstimateId: true, reviewedAtUtc: true,
} as const satisfies Prisma.QuickBooksTaxEstimateOperationSelect;

/**
 * Append an exact, already signed internal review. No provider call or financial
 * total update occurs. Public routes must not pass untrusted provider facts here.
 */
export async function persistReviewedTaxEstimate(prisma: PrismaClient, actor: Actor, environment: KeyEnvironment,
  input: { source: unknown; binding: string }) {
  const { review, keyId } = verifiedReview(input.source, input.binding, environment);
  if (!review.assessment.providerPrerequisitesReady || !review.assessment.reviewSourceReady) {
    reject("QUICKBOOKS_TAX_REVIEW_NOT_READY");
  }
  return withTenantRlsContext(prisma, actor.tenantId, async (tx) => {
    const actorId = await lockManager(tx, actor);
    await lockInvoice(tx, actor.tenantId, review.source.invoiceId);
    const now = new Date();
    await requireCurrentSource(tx, actor, review.source, now);
    const previous = await tx.quickBooksTaxEstimateOperation.findFirst({ where: {
      tenantId: actor.tenantId, invoiceId: review.source.invoiceId, supersededAtUtc: null,
    } });
    if (previous?.sourceHash === review.sourceHash && previous.estimateAstHash === review.estimateAstHash) {
      return tx.quickBooksTaxEstimateOperation.findFirstOrThrow({ where: { id: previous.id, tenantId: actor.tenantId }, select: summarySelect });
    }
    if (previous) {
      if (!["REVIEWED", "FAILED"].includes(previous.status) || previous.providerEstimateId || previous.attemptTokenHash || previous.attemptCount !== 0) {
        reject("QUICKBOOKS_TAX_RECONCILIATION_REQUIRED");
      }
      await tx.quickBooksTaxEstimateOperation.updateMany({ where: { id: previous.id, tenantId: actor.tenantId, status: previous.status },
        data: { status: "SUPERSEDED", supersededAtUtc: now } });
    }
    const last = await tx.quickBooksTaxEstimateOperation.findFirst({ where: { tenantId: actor.tenantId, invoiceId: review.source.invoiceId },
      orderBy: { reviewRevision: "desc" }, select: { reviewRevision: true } });
    return tx.quickBooksTaxEstimateOperation.create({ data: {
      tenantId: actor.tenantId, invoiceId: review.source.invoiceId, customerId: review.source.customerId,
      sourceQuoteId: review.source.sourceQuoteId, quickBooksConnectionId: review.source.connection.id,
      requestedByTenantUserId: actorId, reviewedByTenantUserId: actorId, status: "REVIEWED",
      reviewRevision: (last?.reviewRevision ?? 0) + 1, contractVersion: review.source.contractVersion,
      invoiceVersion: review.source.invoiceVersion, providerRealmId: review.source.connection.realmId,
      connectionGenerationAtUtc: new Date(review.source.connection.connectedAtUtc),
      sourceSnapshot: JSON.parse(review.sourceJson) as Prisma.InputJsonValue,
      estimateAstSnapshot: review.estimateAst as unknown as Prisma.InputJsonValue,
      sourceHash: review.sourceHash, estimateAstHash: review.estimateAstHash,
      reviewBindingDigest: sha256(input.binding), bindingKeyId: keyId,
      estimateRequestId: randomUUID(), invoiceRequestId: randomUUID(), reviewedAtUtc: now,
    }, select: summarySelect });
  }, REVIEW_TRANSACTION_OPTIONS);
}

/** A durable internal lease, explicitly not permission to issue a provider write. */
export async function claimReviewedTaxEstimate(prisma: PrismaClient, actor: Actor, operationId: string) {
  return withTenantRlsContext(prisma, actor.tenantId, async (tx) => {
    await lockManager(tx, actor);
    const operation = await tx.quickBooksTaxEstimateOperation.findFirst({ where: { id: operationId, tenantId: actor.tenantId } });
    if (!operation) return reject("QUICKBOOKS_TAX_OPERATION_NOT_FOUND");
    await lockInvoice(tx, actor.tenantId, operation.invoiceId);
    const current = await tx.quickBooksTaxEstimateOperation.findFirstOrThrow({ where: { id: operation.id, tenantId: actor.tenantId } });
    const now = new Date();
    if (current.status === "ESTIMATE_PROCESSING" && current.claimExpiresAtUtc && current.claimExpiresAtUtc <= now) {
      await tx.quickBooksTaxEstimateOperation.updateMany({ where: { id: current.id, tenantId: actor.tenantId, status: "ESTIMATE_PROCESSING" },
        data: { status: "ESTIMATE_RECONCILIATION_REQUIRED", claimTokenHash: null, claimExpiresAtUtc: null,
          uncertainAtUtc: now, lastFailureCode: UNCERTAIN_CODE } });
      return { outcome: "RECONCILIATION_REQUIRED" as const, publishingAuthorized: false as const };
    }
    if (current.status !== "REVIEWED" || current.attemptCount !== 0 || current.attemptTokenHash || current.providerEstimateId) {
      return { outcome: "NOT_CLAIMED" as const, publishingAuthorized: false as const };
    }
    // Persisted source is immutable; parsing does not require an old rotated key.
    const snapshot = createQuickBooksTaxReview(current.sourceSnapshot, "internal-snapshot-validation-not-a-signing-authority");
    if (snapshot.sourceHash !== current.sourceHash || snapshot.estimateAstHash !== current.estimateAstHash) {
      return reject("QUICKBOOKS_TAX_STORED_REVIEW_INVALID");
    }
    await requireCurrentSource(tx, actor, snapshot.source, now);
    const claimToken = randomBytes(32).toString("base64url");
    const tokenHash = sha256(claimToken);
    const updated = await tx.quickBooksTaxEstimateOperation.updateMany({ where: {
      id: current.id, tenantId: actor.tenantId, status: "REVIEWED", attemptCount: 0, supersededAtUtc: null,
    }, data: { status: "ESTIMATE_PROCESSING", claimTokenHash: tokenHash, attemptTokenHash: tokenHash,
      claimExpiresAtUtc: new Date(now.getTime() + CLAIM_MS), attemptCount: 1, lastAttemptAtUtc: now } });
    if (updated.count !== 1) return { outcome: "NOT_CLAIMED" as const, publishingAuthorized: false as const };
    return { outcome: "CLAIMED" as const, operationId: current.id, claimToken,
      estimateRequestId: current.estimateRequestId, invoiceRequestId: current.invoiceRequestId,
      sourceHash: current.sourceHash, publishingAuthorized: false as const };
  }, REVIEW_TRANSACTION_OPTIONS);
}

type AttemptIdentity = { tenantId: string; operationId: string; estimateRequestId: string; sourceHash: string; claimToken: string };
function sameAttempt(stored: string | null, token: string) {
  if (!stored || !/^[a-f0-9]{64}$/.test(stored) || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  return timingSafeEqual(Buffer.from(stored, "hex"), Buffer.from(sha256(token), "hex"));
}

/**
 * Retain a late response even after a lease expires or the manager disconnects.
 * The original high-entropy attempt token authorizes ONLY recording its result.
 * This function never resumes a write or makes the review canonical.
 */
export async function retainTaxEstimateIdentity(prisma: PrismaClient, attempt: AttemptIdentity, providerEstimateId: string) {
  if (!/^[A-Za-z0-9_-]{1,191}$/.test(providerEstimateId)) reject("QUICKBOOKS_TAX_PROVIDER_ID_INVALID");
  let attemptedConnectionId: string | undefined;
  return withTenantRlsContext(prisma, attempt.tenantId, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "QuickBooksTaxEstimateOperation"
      WHERE "id" = ${attempt.operationId} AND "tenantId" = ${attempt.tenantId} FOR UPDATE`);
    const operation = await tx.quickBooksTaxEstimateOperation.findFirst({ where: {
      id: attempt.operationId, tenantId: attempt.tenantId, estimateRequestId: attempt.estimateRequestId, sourceHash: attempt.sourceHash,
    } });
    if (!operation || !sameAttempt(operation.attemptTokenHash, attempt.claimToken)) reject("QUICKBOOKS_TAX_ATTEMPT_INVALID");
    if (operation.providerEstimateId) {
      if (operation.providerEstimateId !== providerEstimateId) reject("QUICKBOOKS_TAX_PROVIDER_ID_CONFLICT");
      return { retained: true };
    }
    attemptedConnectionId = operation.quickBooksConnectionId;
    const now = new Date();
    const updated = await tx.quickBooksTaxEstimateOperation.updateMany({ where: {
      id: operation.id, tenantId: attempt.tenantId, providerEstimateId: null, attemptTokenHash: operation.attemptTokenHash,
    }, data: operation.status === "SUPERSEDED" ? { providerEstimateId } : {
      providerEstimateId, status: "ESTIMATE_RECONCILIATION_REQUIRED", claimTokenHash: null,
      claimExpiresAtUtc: null, uncertainAtUtc: now, lastFailureCode: UNCERTAIN_CODE } });
    if (updated.count !== 1) {
      const latest = await tx.quickBooksTaxEstimateOperation.findFirst({ where: { id: operation.id, tenantId: attempt.tenantId }, select: { providerEstimateId: true } });
      if (latest?.providerEstimateId !== providerEstimateId) reject("QUICKBOOKS_TAX_PROVIDER_ID_CONFLICT");
    }
    return { retained: true };
  }).catch(async (error: unknown) => {
    if (attemptedConnectionId && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const target = error.meta?.target;
      const providerIdentityConflict = target === "QbTaxEstimate_connection_provider_estimate_key"
        || (Array.isArray(target) && target.length === 2
          && target.includes("quickBooksConnectionId") && target.includes("providerEstimateId"));
      if (providerIdentityConflict) reject("QUICKBOOKS_TAX_PROVIDER_ID_CONFLICT");
      // PostgreSQL can omit P2002's target for a column-granted runtime role.
      // After rollback, confirm only the exact durable conflicting identity;
      // never classify an unspecified uniqueness failure by its code alone.
      if (target == null && error.meta?.modelName === "QuickBooksTaxEstimateOperation") {
        const conflicting = await withTenantRlsContext(prisma, attempt.tenantId, (tx) =>
          tx.quickBooksTaxEstimateOperation.findFirst({ where: {
            tenantId: attempt.tenantId, quickBooksConnectionId: attemptedConnectionId,
            providerEstimateId, id: { not: attempt.operationId },
          }, select: { id: true } }));
        if (conflicting) reject("QUICKBOOKS_TAX_PROVIDER_ID_CONFLICT");
      }
    }
    throw error;
  });
}

export async function markTaxEstimateUncertain(prisma: PrismaClient, attempt: AttemptIdentity) {
  return withTenantRlsContext(prisma, attempt.tenantId, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "QuickBooksTaxEstimateOperation"
      WHERE "id" = ${attempt.operationId} AND "tenantId" = ${attempt.tenantId} FOR UPDATE`);
    const operation = await tx.quickBooksTaxEstimateOperation.findFirst({ where: {
      id: attempt.operationId, tenantId: attempt.tenantId, estimateRequestId: attempt.estimateRequestId, sourceHash: attempt.sourceHash,
    } });
    if (!operation || !sameAttempt(operation.attemptTokenHash, attempt.claimToken)) reject("QUICKBOOKS_TAX_ATTEMPT_INVALID");
    const updated = await tx.quickBooksTaxEstimateOperation.updateMany({ where: {
      id: operation.id, tenantId: attempt.tenantId, status: "ESTIMATE_PROCESSING", attemptTokenHash: operation.attemptTokenHash,
    }, data: { status: "ESTIMATE_RECONCILIATION_REQUIRED", claimTokenHash: null, claimExpiresAtUtc: null,
      uncertainAtUtc: new Date(), lastFailureCode: UNCERTAIN_CODE } });
    return { outcome: updated.count === 1 ? "QUARANTINED" as const : "UNCHANGED" as const,
      status: updated.count === 1 ? "ESTIMATE_RECONCILIATION_REQUIRED" as const : operation.status,
      publishingAuthorized: false as const };
  });
}
