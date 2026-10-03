import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { QuickBooksCredentialRuntimeEnv } from "../config/quickbooks-runtime-types";
import { withTenantRlsContext } from "../lib/tenant-rls";
import { lockQuickBooksInvoicePublication } from "./quickbooks-locks";
import { QUICKBOOKS_INVOICE_IDENTITY_BIND_BUDGET_MS } from "./quickbooks";
import { lockAndReadCurrentCanonicalTaxEstimate } from "./quickbooks-tax-estimate-ledger";
import { evaluateQuickBooksTaxInvoiceParity, QuickBooksTaxInvoiceParityError } from "./quickbooks-tax-invoice-parity";

const CLAIM_MS = 120_000;
export const QUICKBOOKS_TAX_INVOICE_PARITY_CONTRACT_VERSION = 1;
export const QUICKBOOKS_TAX_INVOICE_RESULT_UNKNOWN = "QUICKBOOKS_TAX_INVOICE_RESULT_UNKNOWN";
const id = z.string().min(1).max(191);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
// Match the durable Estimate identity grammar before retaining an immutable ID.
const providerInvoiceId = z.string().min(1).max(191).regex(/^[A-Za-z0-9_-]+$/);
const commandSchema = z.strictObject({ taxEstimateOperationId: id,
  idempotencyKey: z.string().uuid() });
const retainedSchema = z.strictObject({ tenantId: id, operationId: id,
  providerRequestId: id, attemptToken: z.string().regex(/^[a-f0-9]{64}$/), providerInvoiceId });
const quarantineSchema = retainedSchema.omit({ providerInvoiceId: true }).extend({
  failureCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,190}$/),
});
const projectionSchema = retainedSchema.extend({ canonicalEstimate: z.unknown(), canonicalInvoice: z.unknown() });
const expiredAttemptSchema = z.strictObject({ tenantId: id, operationId: id });
const fenceSchema = z.strictObject({
  tenantId: id,
  operationId: id,
  taxEstimateOperationId: id,
  providerRequestId: id,
  attemptToken: z.string().regex(/^[a-f0-9]{64}$/),
  payloadHash: digest,
  processingStartedAtUtc: z.iso.datetime({ precision: 3 }),
  claimExpiresAtUtc: z.iso.datetime({ precision: 3 }),
});

type Actor = Readonly<{ tenantId: string; userId: string; authVersion: number; requestId: string }>;

export class QuickBooksTaxInvoiceError extends Error {
  constructor(readonly code: string) { super(code); this.name = "QuickBooksTaxInvoiceError"; }
}
function reject(code: string): never { throw new QuickBooksTaxInvoiceError(code); }
const sha256Text = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter(key => record[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
const sha256Canonical = (value: unknown) => sha256Text(canonicalJson(value));
function freeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function sameToken(value: string | null, token: string) {
  const digest = sha256Text(token);
  return Boolean(value && /^[a-f0-9]{64}$/.test(value)
    && timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(digest, "hex")));
}
const money = (value: Prisma.Decimal) => value.toFixed(2);
function providerDocNumber(invoiceNumber: number) { return `QF-${String(invoiceNumber).padStart(6, "0")}`; }
function providerMarker(tenantId: string, invoiceId: string) {
  return `QuoteFly:${sha256Text(`${tenantId}:${invoiceId}`).slice(0, 24)}`;
}

const taxOperationSelect = {
  id: true, tenantId: true, invoiceId: true, quickBooksConnectionId: true,
  requestedByTenantUserId: true, status: true, commandKeyHash: true, payloadHash: true,
  providerRealmId: true, claimTokenHash: true, providerRequestId: true,
  providerInvoiceId: true, providerDocNumber: true, attemptCount: true,
  processingStartedAtUtc: true, claimExpiresAtUtc: true, lastAttemptAtUtc: true,
  failedAtUtc: true, lastFailureCode: true, taxEstimateOperationId: true,
  taxAttemptTokenHash: true, taxCanonicalInvoiceHash: true,
  taxProjectionMatchedAtUtc: true, taxParityContractVersion: true,
} as const satisfies Prisma.QuickBooksInvoiceOperationSelect;

async function readAndLockTaxOperation(tx: Prisma.TransactionClient, tenantId: string, operationId: string) {
  const preliminary = await tx.quickBooksInvoiceOperation.findFirst({ where: { id: operationId, tenantId },
    select: { invoiceId: true } });
  if (!preliminary) reject("QUICKBOOKS_TAX_INVOICE_OPERATION_NOT_FOUND");
  await lockQuickBooksInvoicePublication(tx, tenantId, preliminary.invoiceId);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "QuickBooksInvoiceOperation"
    WHERE "id"=${operationId} AND "tenantId"=${tenantId} FOR UPDATE`);
  const operation = await tx.quickBooksInvoiceOperation.findFirst({ where: { id: operationId, tenantId },
    select: taxOperationSelect });
  if (!operation?.taxEstimateOperationId || !operation.taxAttemptTokenHash) {
    reject("QUICKBOOKS_TAX_INVOICE_OPERATION_NOT_FOUND");
  }
  return operation;
}

function requireAttempt(operation: Awaited<ReturnType<typeof readAndLockTaxOperation>>,
  input: { providerRequestId: string; attemptToken: string }) {
  if (operation.providerRequestId !== input.providerRequestId
    || !sameToken(operation.taxAttemptTokenHash, input.attemptToken)) {
    reject("QUICKBOOKS_TAX_INVOICE_ATTEMPT_INVALID");
  }
}

async function degradeExpiredTaxInvoiceAttempt(tx: Prisma.TransactionClient,
  operation: Awaited<ReturnType<typeof readAndLockTaxOperation>>,
  audit: { actorTenantUserId: string | null; requestId: string }) {
  const now = new Date();
  if (operation.status !== "PROCESSING" || !operation.claimExpiresAtUtc
    || operation.claimExpiresAtUtc.getTime() > now.getTime()) {
    return { expired: false as const, operation };
  }
  const updated = await tx.quickBooksInvoiceOperation.update({ where: { id: operation.id }, data: {
    status: "RECONCILIATION_REQUIRED", claimTokenHash: null, claimExpiresAtUtc: null,
    failedAtUtc: now, lastFailureCode: QUICKBOOKS_TAX_INVOICE_RESULT_UNKNOWN,
  }, select: taxOperationSelect });
  await tx.invoiceEvent.create({ data: {
    tenantId: operation.tenantId, invoiceId: operation.invoiceId,
    actorTenantUserId: audit.actorTenantUserId, type: "PROVIDER_RECONCILIATION_REQUIRED",
    requestId: audit.requestId.slice(0, 191),
  } });
  return { expired: true as const, operation: updated };
}

/** Internal recovery only: expires durable intent without depending on current publishing authority. */
export async function quarantineExpiredQuickBooksTaxInvoiceAttempt(prisma: PrismaClient, raw: unknown) {
  const parsed = expiredAttemptSchema.safeParse(raw);
  if (!parsed.success) reject("QUICKBOOKS_TAX_INVOICE_INPUT_INVALID");
  const input = parsed.data;
  return withTenantRlsContext(prisma, input.tenantId, async tx => {
    const operation = await readAndLockTaxOperation(tx, input.tenantId, input.operationId);
    const result = await degradeExpiredTaxInvoiceAttempt(tx, operation, {
      actorTenantUserId: null, requestId: "quickbooks-tax-invoice-expired-attempt",
    });
    return freeze({ outcome: result.expired ? "QUARANTINED" as const : "UNCHANGED" as const,
      operation: result.operation, publishingAuthorized: false as const });
  }, { maxWait: 10_000, timeout: 15_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

function taxInvoiceRequest(review: Awaited<ReturnType<typeof lockAndReadCurrentCanonicalTaxEstimate>>,
  invoice: { invoiceNumber: number; dueAtUtc: Date }, tenantId: string) {
  const source = review.review.source;
  return {
    DocNumber: providerDocNumber(invoice.invoiceNumber),
    TxnDate: source.transactionDate,
    DueDate: invoice.dueAtUtc.toISOString().slice(0, 10),
    PrivateNote: providerMarker(tenantId, source.invoiceId),
    CustomerRef: { value: source.customerMapping.providerId },
    CurrencyRef: { value: "USD" as const },
    ShipFromAddr: source.origin,
    ShipAddr: source.destination,
    Line: review.review.estimateAst.Line,
    LinkedTxn: [{ TxnId: review.current.providerEstimateId!, TxnType: "Estimate" as const }],
  };
}

async function currentInvoiceForRequest(tx: Prisma.TransactionClient,
  review: Awaited<ReturnType<typeof lockAndReadCurrentCanonicalTaxEstimate>>, tenantId: string, now: Date) {
  const source = review.review.source;
  const invoice = await tx.invoice.findFirst({ where: { id: source.invoiceId, tenantId,
    version: source.invoiceVersion, status: "DRAFT", archivedAtUtc: null, deletedAtUtc: null,
    customer: { archivedAtUtc: null, deletedAtUtc: null },
    job: { status: { not: "CANCELED" }, archivedAtUtc: null, deletedAtUtc: null },
    sourceQuote: { status: "ACCEPTED", archivedAtUtc: null, deletedAtUtc: null } },
  select: { invoiceNumber: true, dueAtUtc: true, currency: true, subtotalAmount: true,
    taxAmount: true, totalAmount: true } });
  if (!invoice || !invoice.dueAtUtc || invoice.dueAtUtc.getTime() < now.getTime()
    || invoice.currency !== "USD" || invoice.subtotalAmount.toFixed(2) !== source.subtotal
    || invoice.taxAmount.toFixed(2) !== source.quotedTax || invoice.totalAmount.toFixed(2) !== source.total) {
    reject("QUICKBOOKS_TAX_INVOICE_SOURCE_CHANGED");
  }
  return { ...invoice, dueAtUtc: invoice.dueAtUtc };
}

function connectionTarget(actor: Actor,
  review: Awaited<ReturnType<typeof lockAndReadCurrentCanonicalTaxEstimate>>) {
  const connection = review.review.source.connection;
  return { id: connection.id, tenantId: actor.tenantId, realmId: connection.realmId,
    environment: connection.environment, generation: connection.generation };
}

function dispatchDescriptor(actor: Actor,
  review: Awaited<ReturnType<typeof lockAndReadCurrentCanonicalTaxEstimate>>,
  operation: Awaited<ReturnType<typeof readAndLockTaxOperation>>,
  attemptToken: string, requestProjection: ReturnType<typeof taxInvoiceRequest>) {
  if (!operation.taxEstimateOperationId || !operation.processingStartedAtUtc || !operation.claimExpiresAtUtc) {
    reject("QUICKBOOKS_TAX_INVOICE_OPERATION_STALE");
  }
  return freeze({
    attempt: {
      tenantId: actor.tenantId,
      operationId: operation.id,
      taxEstimateOperationId: operation.taxEstimateOperationId,
      providerRequestId: operation.providerRequestId,
      attemptToken,
      payloadHash: operation.payloadHash,
      processingStartedAtUtc: operation.processingStartedAtUtc.toISOString(),
      claimExpiresAtUtc: operation.claimExpiresAtUtc.toISOString(),
    },
    connection: connectionTarget(actor, review),
    requestProjection,
  });
}

/** Resolves the current canonical parent before any attempt is consumed. */
export async function readCanonicalTaxInvoiceCredentialTarget(prisma: PrismaClient, actor: Actor,
  environment: QuickBooksCredentialRuntimeEnv, taxEstimateOperationId: string) {
  if (!id.safeParse(taxEstimateOperationId).success) reject("QUICKBOOKS_TAX_INVOICE_INPUT_INVALID");
  return withTenantRlsContext(prisma, actor.tenantId, async tx => {
    const reviewed = await lockAndReadCurrentCanonicalTaxEstimate(tx, actor, environment,
      taxEstimateOperationId, { discoverBoundInvoiceOperation: true });
    if (reviewed.existingTaxInvoiceOperationId) reject("QUICKBOOKS_TAX_INVOICE_OPERATION_EXISTS");
    return freeze({ outcome: "READY" as const, taxEstimateOperationId: reviewed.current.id,
      connection: connectionTarget(actor, reviewed), publishingAuthorized: false as const });
  }, { maxWait: 10_000, timeout: 15_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

/** Creates durable internal intent only. No caller in this slice dispatches it. */
export async function claimReviewedQuickBooksTaxInvoice(prisma: PrismaClient, actor: Actor,
  environment: QuickBooksCredentialRuntimeEnv, raw: unknown) {
  const parsed = commandSchema.safeParse(raw);
  if (!parsed.success) reject("QUICKBOOKS_TAX_INVOICE_INPUT_INVALID");
  const input = parsed.data;
  return withTenantRlsContext(prisma, actor.tenantId, async tx => {
    const reviewed = await lockAndReadCurrentCanonicalTaxEstimate(tx, actor, environment,
      input.taxEstimateOperationId, { discoverBoundInvoiceOperation: true });
    const source = reviewed.review.source;
    const readyInvoice = await currentInvoiceForRequest(tx, reviewed, actor.tenantId, new Date());
    const commandKeyHash = sha256Text(`quickbooks-tax-invoice:${actor.tenantId}:${input.idempotencyKey}`);
    const existing = await tx.quickBooksInvoiceOperation.findFirst({
      where: { tenantId: actor.tenantId, invoiceId: source.invoiceId }, select: taxOperationSelect,
    });
    if (existing) {
      if (existing.taxEstimateOperationId === reviewed.current.id
        && existing.providerRequestId === reviewed.current.invoiceRequestId) {
        const result = await degradeExpiredTaxInvoiceAttempt(tx, existing, {
          actorTenantUserId: reviewed.managerId, requestId: actor.requestId,
        });
        if (result.expired) {
          return freeze({ outcome: "DUPLICATE" as const, operation: result.operation,
            claimToken: null, requestProjection: null, dispatch: null,
            publishingAuthorized: false as const });
        }
      }
      if (existing.taxEstimateOperationId === reviewed.current.id
        && existing.commandKeyHash === commandKeyHash
        && existing.providerRequestId === reviewed.current.invoiceRequestId) {
        return freeze({ outcome: "DUPLICATE" as const, operation: existing,
          claimToken: null, requestProjection: null, dispatch: null,
          publishingAuthorized: false as const });
      }
      reject("QUICKBOOKS_TAX_INVOICE_OPERATION_EXISTS");
    }
    const requestProjection = taxInvoiceRequest(reviewed, { invoiceNumber: readyInvoice.invoiceNumber,
      dueAtUtc: readyInvoice.dueAtUtc }, actor.tenantId);
    const payloadHash = sha256Canonical(requestProjection);
    const attemptToken = randomBytes(32).toString("hex");
    const attemptTokenHash = sha256Text(attemptToken);
    const now = new Date();
    const operation = await tx.quickBooksInvoiceOperation.create({ data: {
      tenantId: actor.tenantId, invoiceId: source.invoiceId,
      quickBooksConnectionId: source.connection.id, requestedByTenantUserId: reviewed.managerId,
      status: "PROCESSING", commandKeyHash, payloadHash,
      providerRealmId: source.connection.realmId, claimTokenHash: attemptTokenHash,
      providerRequestId: reviewed.current.invoiceRequestId,
      providerDocNumber: providerDocNumber(readyInvoice.invoiceNumber), attemptCount: 1,
      reconciliationCount: 0, processingStartedAtUtc: now,
      claimExpiresAtUtc: new Date(now.getTime() + CLAIM_MS), lastAttemptAtUtc: now,
      taxEstimateOperationId: reviewed.current.id, taxAttemptTokenHash: attemptTokenHash,
    }, select: taxOperationSelect });
    await tx.invoiceEvent.create({ data: { tenantId: actor.tenantId, invoiceId: source.invoiceId,
      actorTenantUserId: reviewed.managerId, type: "PROVIDER_SYNC_STARTED",
      requestId: actor.requestId.slice(0, 191), commandKeyHash, commandPayloadHash: payloadHash } });
    return freeze({ outcome: "CLAIMED" as const, operation, claimToken: attemptToken,
      requestProjection, dispatch: dispatchDescriptor(actor, reviewed, operation, attemptToken, requestProjection),
      publishingAuthorized: false as const });
  }, { maxWait: 10_000, timeout: 15_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

/** Final provider-write fence. It performs no I/O and returns restricted internal data only. */
export async function assertQuickBooksTaxInvoiceCreateFence(prisma: PrismaClient, actor: Actor,
  environment: QuickBooksCredentialRuntimeEnv, raw: unknown) {
  const parsed = fenceSchema.safeParse(raw);
  if (!parsed.success) reject("QUICKBOOKS_TAX_INVOICE_INPUT_INVALID");
  const input = parsed.data;
  if (input.tenantId !== actor.tenantId) reject("QUICKBOOKS_TAX_INVOICE_ATTEMPT_INVALID");
  const requiredRemainingMs = environment.QUICKBOOKS_PROVIDER_TIMEOUT_MS
    + QUICKBOOKS_INVOICE_IDENTITY_BIND_BUDGET_MS;
  if (!Number.isSafeInteger(requiredRemainingMs) || requiredRemainingMs <= 0 || requiredRemainingMs >= CLAIM_MS) {
    reject("QUICKBOOKS_TAX_INVOICE_INPUT_INVALID");
  }
  return withTenantRlsContext(prisma, actor.tenantId, async tx => {
    const preliminary = await tx.quickBooksInvoiceOperation.findFirst({ where: {
      id: input.operationId, tenantId: actor.tenantId, taxEstimateOperationId: input.taxEstimateOperationId,
    }, select: { id: true } });
    if (!preliminary) reject("QUICKBOOKS_TAX_INVOICE_OPERATION_NOT_FOUND");
    const reviewed = await lockAndReadCurrentCanonicalTaxEstimate(tx, actor, environment,
      input.taxEstimateOperationId, { allowedInvoiceOperationId: input.operationId });
    const operation = await readAndLockTaxOperation(tx, actor.tenantId, input.operationId);
    requireAttempt(operation, input);
    const now = new Date();
    if (operation.taxEstimateOperationId !== reviewed.current.id || operation.status !== "PROCESSING"
      || operation.attemptCount !== 1 || operation.providerInvoiceId || operation.taxCanonicalInvoiceHash
      || !sameToken(operation.claimTokenHash, input.attemptToken)
      || operation.providerRequestId !== reviewed.current.invoiceRequestId
      || operation.payloadHash !== input.payloadHash
      || operation.quickBooksConnectionId !== reviewed.review.source.connection.id
      || operation.providerRealmId !== reviewed.review.source.connection.realmId
      || operation.processingStartedAtUtc?.toISOString() !== input.processingStartedAtUtc
      || operation.claimExpiresAtUtc?.toISOString() !== input.claimExpiresAtUtc
      || !operation.claimExpiresAtUtc
      || operation.claimExpiresAtUtc.getTime() <= now.getTime() + requiredRemainingMs) {
      reject("QUICKBOOKS_TAX_INVOICE_OPERATION_STALE");
    }
    const invoice = await currentInvoiceForRequest(tx, reviewed, actor.tenantId, now);
    const requestProjection = taxInvoiceRequest(reviewed, invoice, actor.tenantId);
    if (sha256Canonical(requestProjection) !== operation.payloadHash
      || providerDocNumber(invoice.invoiceNumber) !== operation.providerDocNumber) {
      reject("QUICKBOOKS_TAX_INVOICE_OPERATION_STALE");
    }
    return freeze({ outcome: "FENCED" as const,
      dispatch: dispatchDescriptor(actor, reviewed, operation, input.attemptToken, requestProjection),
      providerCreateFencePassed: true as const, publishingAuthorized: false as const });
  }, { maxWait: 10_000, timeout: 15_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

/** Retains an irreversible provider identity even after local authority becomes stale. */
export async function retainCreatedQuickBooksTaxInvoiceIdentity(prisma: PrismaClient, raw: unknown) {
  const parsed = retainedSchema.safeParse(raw);
  if (!parsed.success) reject("QUICKBOOKS_TAX_INVOICE_INPUT_INVALID");
  const input = parsed.data;
  return withTenantRlsContext(prisma, input.tenantId, async tx => {
    const operation = await readAndLockTaxOperation(tx, input.tenantId, input.operationId);
    requireAttempt(operation, input);
    if (operation.providerInvoiceId && operation.providerInvoiceId !== input.providerInvoiceId) {
      reject("QUICKBOOKS_TAX_INVOICE_PROVIDER_ID_CONFLICT");
    }
    if (operation.providerInvoiceId === input.providerInvoiceId) {
      return Object.freeze({ outcome: "ALREADY_RETAINED" as const, operation,
        canContinue: false as const, providerContinuationAuthorized: false as const,
        publishingAuthorized: false as const });
    }
    const now = new Date();
    let updated: typeof operation;
    try {
      updated = await tx.quickBooksInvoiceOperation.update({ where: { id: operation.id }, data: {
        providerInvoiceId: input.providerInvoiceId,
        status: "RECONCILIATION_REQUIRED", claimTokenHash: null,
        claimExpiresAtUtc: null, failedAtUtc: now,
        lastFailureCode: "QUICKBOOKS_TAX_INVOICE_IDENTITY_RETAINED",
      }, select: taxOperationSelect });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
        reject("QUICKBOOKS_TAX_INVOICE_PROVIDER_ID_CONFLICT");
      }
      throw error;
    }
    return Object.freeze({ outcome: "RETAINED" as const,
      operation: updated, canContinue: false as const, providerContinuationAuthorized: false as const,
      publishingAuthorized: false as const });
  }, { maxWait: 10_000, timeout: 15_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

async function quarantine(tx: Prisma.TransactionClient,
  operation: Awaited<ReturnType<typeof readAndLockTaxOperation>>, failureCode: string) {
  if (operation.status === "RECONCILIATION_REQUIRED" && operation.lastFailureCode === failureCode) return operation;
  return tx.quickBooksInvoiceOperation.update({ where: { id: operation.id }, data: {
    status: "RECONCILIATION_REQUIRED", claimTokenHash: null, claimExpiresAtUtc: null,
    failedAtUtc: new Date(), lastFailureCode: failureCode,
  }, select: taxOperationSelect });
}

export async function quarantineQuickBooksTaxInvoiceAttempt(prisma: PrismaClient, raw: unknown) {
  const parsed = quarantineSchema.safeParse(raw);
  if (!parsed.success) reject("QUICKBOOKS_TAX_INVOICE_INPUT_INVALID");
  const input = parsed.data;
  return withTenantRlsContext(prisma, input.tenantId, async tx => {
    const operation = await readAndLockTaxOperation(tx, input.tenantId, input.operationId);
    requireAttempt(operation, input);
    const updated = await quarantine(tx, operation, input.failureCode);
    return Object.freeze({ outcome: "QUARANTINED" as const, operation: updated,
      publishingAuthorized: false as const });
  }, { maxWait: 10_000, timeout: 15_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

/** Records an exact projection match but deliberately leaves the operation quarantined. */
export async function recordQuickBooksTaxInvoiceProjectionMatch(prisma: PrismaClient, actor: Actor,
  environment: QuickBooksCredentialRuntimeEnv, raw: unknown) {
  const parsed = projectionSchema.safeParse(raw);
  if (!parsed.success) reject("QUICKBOOKS_TAX_INVOICE_INPUT_INVALID");
  const input = parsed.data;
  return withTenantRlsContext(prisma, actor.tenantId, async tx => {
    if (actor.tenantId !== input.tenantId) reject("QUICKBOOKS_TAX_INVOICE_ATTEMPT_INVALID");
    const preliminary = await tx.quickBooksInvoiceOperation.findFirst({ where: {
      id: input.operationId, tenantId: actor.tenantId }, select: { taxEstimateOperationId: true } });
    if (!preliminary?.taxEstimateOperationId) reject("QUICKBOOKS_TAX_INVOICE_OPERATION_NOT_FOUND");
    const reviewed = await lockAndReadCurrentCanonicalTaxEstimate(tx, actor, environment,
      preliminary.taxEstimateOperationId, { allowedInvoiceOperationId: input.operationId });
    const operation = await readAndLockTaxOperation(tx, actor.tenantId, input.operationId);
    requireAttempt(operation, input);
    if (!operation.providerInvoiceId || input.providerInvoiceId !== operation.providerInvoiceId
      || (input.canonicalInvoice as { Id?: unknown } | null)?.Id !== operation.providerInvoiceId) {
      const quarantined = await quarantine(tx, operation, "QUICKBOOKS_TAX_INVOICE_PROVIDER_ID_MISMATCH");
      return Object.freeze({ outcome: "QUARANTINED" as const, operation: quarantined,
        failureCode: "QUICKBOOKS_TAX_INVOICE_PROVIDER_ID_MISMATCH", publishingAuthorized: false as const });
    }
    const source = reviewed.review.source;
    let result: ReturnType<typeof evaluateQuickBooksTaxInvoiceParity>;
    try {
      result = evaluateQuickBooksTaxInvoiceParity({
        sourceSnapshot: source, estimateAstSnapshot: reviewed.review.estimateAst,
        ledger: { status: reviewed.current.status, supersededAtUtc: reviewed.current.supersededAtUtc,
          tenantId: reviewed.current.tenantId, invoiceId: reviewed.current.invoiceId,
          invoiceVersion: reviewed.current.invoiceVersion, quickBooksConnectionId: reviewed.current.quickBooksConnectionId,
          providerRealmId: reviewed.current.providerRealmId, connectionGeneration: reviewed.current.connectionGeneration,
          invoiceTaxContextId: reviewed.current.invoiceTaxContextId,
          invoiceTaxContextRevision: reviewed.current.invoiceTaxContextRevision,
          invoiceTaxContextInputHash: reviewed.current.invoiceTaxContextInputHash,
          sourceHash: reviewed.current.sourceHash, estimateAstHash: reviewed.current.estimateAstHash,
          providerEstimateId: reviewed.current.providerEstimateId,
          providerEstimateSyncToken: reviewed.current.providerEstimateSyncToken,
          providerEstimateUpdatedAtUtc: reviewed.current.providerEstimateUpdatedAtUtc?.toISOString(),
          canonicalEstimateHash: reviewed.current.canonicalEstimateHash,
          providerSubtotal: money(reviewed.current.providerSubtotal!), providerTax: money(reviewed.current.providerTax!),
          providerTotal: money(reviewed.current.providerTotal!) },
        currentIdentity: { tenantId: source.tenantId, invoiceId: source.invoiceId,
          invoiceVersion: source.invoiceVersion, quickBooksConnectionId: source.connection.id,
          providerRealmId: source.connection.realmId, connectionGeneration: source.connection.generation,
          invoiceTaxContextId: source.invoiceTaxContext.id,
          invoiceTaxContextRevision: source.invoiceTaxContext.revision,
          invoiceTaxContextInputHash: source.invoiceTaxContext.inputHash },
        canonicalEstimate: input.canonicalEstimate, canonicalInvoice: input.canonicalInvoice,
      });
    } catch (error) {
      if (!(error instanceof QuickBooksTaxInvoiceParityError)) throw error;
      const quarantined = await quarantine(tx, operation, error.code.slice(0, 191));
      return Object.freeze({ outcome: "QUARANTINED" as const, operation: quarantined,
        failureCode: error.code, publishingAuthorized: false as const });
    }
    if (operation.taxCanonicalInvoiceHash) {
      if (operation.taxCanonicalInvoiceHash !== result.canonicalInvoiceHash) {
        reject("QUICKBOOKS_TAX_INVOICE_PROJECTION_CONFLICT");
      }
      return Object.freeze({ outcome: "ALREADY_RECORDED" as const, operation,
        projectionMatches: true as const, estimateInvoiceParityProven: false as const,
        publishingAuthorized: false as const });
    }
    const now = new Date();
    const updated = await tx.quickBooksInvoiceOperation.update({ where: { id: operation.id }, data: {
      status: "RECONCILIATION_REQUIRED", claimTokenHash: null, claimExpiresAtUtc: null,
      failedAtUtc: now, lastFailureCode: "QUICKBOOKS_TAX_PROJECTION_REQUIRES_TRUSTED_PROVENANCE",
      taxCanonicalInvoiceHash: result.canonicalInvoiceHash, taxProjectionMatchedAtUtc: now,
      taxParityContractVersion: QUICKBOOKS_TAX_INVOICE_PARITY_CONTRACT_VERSION,
    }, select: taxOperationSelect });
    return Object.freeze({ outcome: "RECORDED" as const, operation: updated,
      projectionMatches: true as const, estimateInvoiceParityProven: false as const,
      publishingAuthorized: false as const });
  }, { maxWait: 10_000, timeout: 15_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
