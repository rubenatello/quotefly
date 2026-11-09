import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { JwtClaims } from "../lib/auth";
import { withTenantRlsContext } from "../lib/tenant-rls";
import { InvoicePublicSelect, InvoiceServiceError } from "./invoices";
import { QuickBooksInvoiceOperationPublicSelect, quickBooksInvoiceRetryAvailable } from "./quickbooks-invoices";
import { lockQuickBooksInvoicePublication } from "./quickbooks-locks";

export const invoiceDueDateInputSchema = z.strictObject({
  invoiceVersion: z.number().int().min(1).max(2_147_483_646),
  dueAtUtc: z.string().datetime({ offset: true }),
});
type Actor = Pick<JwtClaims, "tenantId" | "userId" | "authVersion">;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function reject(code: string, message: string, status = 409): never {
  throw new InvoiceServiceError(status, code, message);
}

/** A local command: no provider credentials, flags, or network calls are required. */
export async function updateInvoiceDueDate(prisma: PrismaClient, actor: Actor, invoiceId: string,
  value: unknown, idempotencyKey: string, requestId: string) {
  const parsed = invoiceDueDateInputSchema.safeParse(value);
  if (!parsed.success) reject("INVOICE_DUE_DATE_INVALID", "Choose a valid future due date.", 400);
  const input = parsed.data;
  const due = new Date(input.dueAtUtc);
  if (!Number.isFinite(due.getTime())) reject("INVOICE_DUE_DATE_INVALID", "Choose a valid future due date.", 400);
  const commandKeyHash = hash(`invoice-due-date:${actor.tenantId}:${idempotencyKey}`);
  const commandPayloadHash = hash(JSON.stringify([invoiceId, input.invoiceVersion, due.toISOString()]));
  return withTenantRlsContext(prisma, actor.tenantId, async tx => {
    const managers = await tx.$queryRaw<Array<{ id: string; role: string; authVersion: number }>>(Prisma.sql`
      SELECT m."id", m."role", u."authVersion" FROM "TenantUser" m
      JOIN "User" u ON u."id" = m."userId" JOIN "Tenant" t ON t."id" = m."tenantId"
      WHERE m."tenantId" = ${actor.tenantId} AND m."userId" = ${actor.userId}
        AND m."deletedAtUtc" IS NULL AND u."deletedAtUtc" IS NULL AND t."deletedAtUtc" IS NULL
      FOR SHARE OF m, u, t`);
    const manager = managers[0];
    if (!manager || !["owner", "admin"].includes(manager.role) || manager.authVersion !== actor.authVersion) {
      reject("INVOICE_MANAGER_REQUIRED", "An active owner or admin must update this invoice.", 403);
    }
    await tx.$queryRaw(Prisma.sql`SELECT 1::int FROM (
      SELECT pg_advisory_xact_lock(hashtextextended(${`invoice-due-date:${actor.tenantId}:${commandKeyHash}`}, 0))
    ) acquired`);
    const replay = await tx.invoiceEvent.findFirst({ where: { tenantId: actor.tenantId, commandKeyHash } });
    if (replay && (replay.invoiceId !== invoiceId || replay.commandPayloadHash !== commandPayloadHash)) {
      reject("IDEMPOTENCY_KEY_REUSED", "This command key was already used for a different update.");
    }
    await lockQuickBooksInvoicePublication(tx, actor.tenantId, invoiceId);
    const link = await tx.invoice.findFirst({ where: { tenantId: actor.tenantId, id: invoiceId },
      select: { customerId: true, jobId: true, sourceQuoteId: true } });
    if (!link) reject("INVOICE_NOT_FOUND", "Invoice not found for tenant.", 404);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Customer" WHERE "tenantId"=${actor.tenantId} AND "id"=${link.customerId} FOR SHARE`);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Job" WHERE "tenantId"=${actor.tenantId} AND "id"=${link.jobId} FOR SHARE`);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Quote" WHERE "tenantId"=${actor.tenantId} AND "id"=${link.sourceQuoteId} FOR SHARE`);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Invoice" WHERE "tenantId"=${actor.tenantId} AND "id"=${invoiceId} FOR UPDATE`);
    const activeWhere = { tenantId: actor.tenantId, id: invoiceId, deletedAtUtc: null, archivedAtUtc: null,
      customer: { deletedAtUtc: null, archivedAtUtc: null },
      job: { deletedAtUtc: null, archivedAtUtc: null }, sourceQuote: { deletedAtUtc: null, archivedAtUtc: null } };
    const invoice = await tx.invoice.findFirst({ where: activeWhere, select: InvoicePublicSelect });
    if (!invoice) reject("INVOICE_NOT_FOUND", "Invoice not found for tenant.", 404);
    // Exact replay reads current state without repeating validation of the old command or mutating it.
    if (replay) return { invoice, duplicate: true };
    const now = new Date();
    if (invoice.status !== "DRAFT" || invoice.paymentStatus !== "PENDING" || !invoice.amountPaid.isZero()
      || invoice.issuedAtUtc || invoice.sentAtUtc || invoice.paidAtUtc || invoice.voidedAtUtc
      || invoice.job.status === "CANCELED" || invoice.sourceQuote.status !== "ACCEPTED") {
      reject("INVOICE_DUE_DATE_LOCKED", "Only an unpaid draft invoice can have its due date changed.");
    }
    if (invoice.version !== input.invoiceVersion) reject("INVOICE_VERSION_CHANGED", "The invoice changed. Reload it before saving.");
    if (due.getTime() <= now.getTime()) reject("INVOICE_DUE_DATE_INVALID", "Choose a future due date.", 400);
    if (invoice.dueAtUtc?.getTime() === due.getTime()) reject("INVOICE_DUE_DATE_UNCHANGED", "Choose a different due date.");
    const [direct, legacy, estimates] = await Promise.all([
      tx.quickBooksInvoiceOperation.findFirst({ where: { tenantId: actor.tenantId, invoiceId },
        select: { ...QuickBooksInvoiceOperationPublicSelect, archivedAtUtc: true, claimTokenHash: true } }),
      tx.quickBooksInvoiceSync.findFirst({ where: { tenantId: actor.tenantId, quoteId: invoice.sourceQuoteId }, select: { id: true } }),
      tx.quickBooksTaxEstimateOperation.findMany({ where: { tenantId: actor.tenantId, invoiceId }, select: {
        attemptCount: true, attemptTokenHash: true, lastAttemptAtUtc: true, claimTokenHash: true, claimExpiresAtUtc: true,
        providerEstimateId: true, providerEstimateSyncToken: true, providerEstimateUpdatedAtUtc: true,
        canonicalEstimateHash: true, providerSubtotal: true, providerTax: true, providerTotal: true,
        uncertainAtUtc: true, canonicalAtUtc: true, status: true,
      } }),
    ]);
    if (direct && (direct.archivedAtUtc || !quickBooksInvoiceRetryAvailable(direct) || direct.claimTokenHash
      || direct.providerInvoiceStatus || direct.providerUpdatedAtUtc || direct.invoiceLinkFetchedAtUtc || direct.reconciliationCount > 0)) {
      reject("INVOICE_DUE_DATE_PROVIDER_LOCKED", "Resolve the accounting operation before changing this due date.");
    }
    if (legacy) {
      reject("INVOICE_DUE_DATE_PROVIDER_LOCKED", "Resolve the accounting operation before changing this due date.");
    }
    if (estimates.some(row => row.attemptCount !== 0 || row.attemptTokenHash || row.lastAttemptAtUtc
      || row.claimTokenHash || row.claimExpiresAtUtc || row.providerEstimateId || row.providerEstimateSyncToken
      || row.providerEstimateUpdatedAtUtc || row.canonicalEstimateHash || row.providerSubtotal !== null
      || row.providerTax !== null || row.providerTotal !== null || row.uncertainAtUtc || row.canonicalAtUtc
      || !["REVIEWED", "FAILED", "SUPERSEDED"].includes(row.status))) {
      reject("INVOICE_DUE_DATE_PROVIDER_LOCKED", "Resolve the accounting operation before changing this due date.");
    }
    await tx.quickBooksTaxEstimateOperation.updateMany({ where: { tenantId: actor.tenantId, invoiceId,
      supersededAtUtc: null, status: { in: ["REVIEWED", "FAILED"] }, attemptCount: 0, attemptTokenHash: null,
      lastAttemptAtUtc: null, providerEstimateId: null, claimTokenHash: null, claimExpiresAtUtc: null,
      providerEstimateSyncToken: null, providerEstimateUpdatedAtUtc: null, canonicalEstimateHash: null,
      providerSubtotal: null, providerTax: null, providerTotal: null, uncertainAtUtc: null, canonicalAtUtc: null },
      data: { status: "SUPERSEDED", supersededAtUtc: now } });
    // Keep the tax context and its explicit TAXABLE intent. Its older invoice version makes it stale.
    const updated = await tx.invoice.updateMany({ where: { ...activeWhere, version: input.invoiceVersion,
      status: "DRAFT", paymentStatus: "PENDING", amountPaid: 0, issuedAtUtc: null, sentAtUtc: null,
      paidAtUtc: null, voidedAtUtc: null }, data: { dueAtUtc: due, version: { increment: 1 } } });
    if (updated.count !== 1) reject("INVOICE_VERSION_CHANGED", "The invoice changed. Reload it before saving.");
    await tx.invoiceEvent.create({ data: { tenantId: actor.tenantId, invoiceId, actorTenantUserId: manager.id,
      type: "UPDATED", fromStatus: invoice.status, toStatus: invoice.status,
      fromPaymentStatus: invoice.paymentStatus, toPaymentStatus: invoice.paymentStatus,
      commandKeyHash, commandPayloadHash, requestId: requestId.slice(0, 191) } });
    return { invoice: await tx.invoice.findFirstOrThrow({ where: activeWhere, select: InvoicePublicSelect }), duplicate: false };
  }, { maxWait: 10_000, timeout: 15_000 });
}
