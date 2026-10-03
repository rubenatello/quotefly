import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { QuickBooksCredentialRuntimeEnv } from "../config/quickbooks-runtime-types";
import { withTenantRlsContext } from "../lib/tenant-rls";
import { lockQuickBooksInvoicePublication } from "./quickbooks-locks";
import { lockAndReadCurrentCanonicalTaxEstimate } from "./quickbooks-tax-estimate-ledger";
import { evaluateQuickBooksTaxInvoiceParity, QuickBooksTaxInvoiceParityError } from "./quickbooks-tax-invoice-parity";

const CLAIM_MS = 120_000;
export const QUICKBOOKS_TAX_INVOICE_PARITY_CONTRACT_VERSION = 1;
const id = z.string().min(1).max(191);
const commandSchema = z.strictObject({ taxEstimateOperationId: id,
  idempotencyKey: z.string().uuid() });
const retainedSchema = z.strictObject({ tenantId: id, operationId: id,
  providerRequestId: id, attemptToken: z.string().regex(/^[a-f0-9]{64}$/), providerInvoiceId: id });
const quarantineSchema = retainedSchema.omit({ providerInvoiceId: true }).extend({
  failureCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,190}$/),
});
const projectionSchema = retainedSchema.extend({ canonicalEstimate: z.unknown(), canonicalInvoice: z.unknown() });

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
    const invoice = await tx.invoice.findFirst({ where: { id: source.invoiceId, tenantId: actor.tenantId,
      version: source.invoiceVersion, status: "DRAFT", archivedAtUtc: null, deletedAtUtc: null,
      customer: { archivedAtUtc: null, deletedAtUtc: null },
      job: { status: { not: "CANCELED" }, archivedAtUtc: null, deletedAtUtc: null },
      sourceQuote: { status: "ACCEPTED", archivedAtUtc: null, deletedAtUtc: null } },
    select: { invoiceNumber: true, dueAtUtc: true, currency: true, subtotalAmount: true,
      taxAmount: true, totalAmount: true } });
    if (!invoice || !invoice.dueAtUtc || invoice.dueAtUtc.getTime() < Date.now()
      || invoice.currency !== "USD" || invoice.subtotalAmount.toFixed(2) !== source.subtotal
      || invoice.taxAmount.toFixed(2) !== source.quotedTax || invoice.totalAmount.toFixed(2) !== source.total) {
      reject("QUICKBOOKS_TAX_INVOICE_SOURCE_CHANGED");
    }
    const readyInvoice = { ...invoice, dueAtUtc: invoice.dueAtUtc };
    const commandKeyHash = sha256Text(`quickbooks-tax-invoice:${actor.tenantId}:${input.idempotencyKey}`);
    const existing = await tx.quickBooksInvoiceOperation.findFirst({
      where: { tenantId: actor.tenantId, invoiceId: source.invoiceId }, select: taxOperationSelect,
    });
    if (existing) {
      if (existing.taxEstimateOperationId === reviewed.current.id
        && existing.commandKeyHash === commandKeyHash
        && existing.providerRequestId === reviewed.current.invoiceRequestId) {
        return Object.freeze({ outcome: "DUPLICATE" as const, operation: existing,
          claimToken: null, requestProjection: null, publishingAuthorized: false as const });
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
    return Object.freeze({ outcome: "CLAIMED" as const, operation, claimToken: attemptToken,
      requestProjection, publishingAuthorized: false as const });
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
    return Object.freeze({ outcome: operation.providerInvoiceId ? "ALREADY_RETAINED" as const : "RETAINED" as const,
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
