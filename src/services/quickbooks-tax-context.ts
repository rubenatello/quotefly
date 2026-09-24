import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { JwtClaims } from "../lib/auth";
import { withTenantRlsContext } from "../lib/tenant-rls";
import { currentQuickBooksConnectionGeneration } from "./quickbooks-connection-events";
import { lockQuickBooksInvoicePublication } from "./quickbooks-locks";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "./quickbooks-setup";
import { taxReviewLineSchema, usTaxAddressSchema } from "./quickbooks-tax-review-contract";

type Actor = Pick<JwtClaims, "tenantId" | "userId" | "authVersion">;
type Transaction = Prisma.TransactionClient;
type Environment = "sandbox" | "production";
const id = z.string().min(1).max(191).regex(/^[A-Za-z0-9_-]+$/);
const version = z.number().int().min(1).max(2_147_483_647);
const mapping = z.strictObject({ id, reviewVersion: version, reviewedAtUtc: z.iso.datetime({ precision: 3 }), providerId: id });
export const invoiceTaxContextInputSchema = z.strictObject({
  invoiceId: id, invoiceVersion: version, expectedRevision: z.number().int().min(0).max(2_147_483_647),
  idempotencyKey: z.string().uuid(), transactionDate: z.iso.date(),
  origin: usTaxAddressSchema, destination: usTaxAddressSchema,
  connection: z.strictObject({ id, realmId: z.string().regex(/^\d{1,64}$/), environment: z.enum(["sandbox", "production"]),
    connectedAtUtc: z.iso.datetime({ precision: 3 }), generation: version }),
  customerMapping: mapping,
  lines: z.array(z.strictObject({ invoiceLineItemId: id, taxIntent: taxReviewLineSchema.shape.taxIntent, itemMapping: mapping })).min(1).max(500),
});
export type InvoiceTaxContextInput = z.infer<typeof invoiceTaxContextInputSchema>;

/** Fixed diagnostics only. Never attach addresses, snapshots, SQL, or input. */
export class QuickBooksTaxContextError extends Error {
  readonly statusCode = 409;
  constructor(readonly code: string) { super(code); this.name = "QuickBooksTaxContextError"; }
}
function reject(code: string): never { throw new QuickBooksTaxContextError(code); }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const itemKey = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
const transactionOptions = { maxWait: 10_000, timeout: 15_000 };

async function lockManager(tx: Transaction, actor: Actor) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Tenant" WHERE "id" = ${actor.tenantId} FOR NO KEY UPDATE`);
  const rows = await tx.$queryRaw<Array<{ id: string; role: string; authVersion: number }>>(Prisma.sql`
    SELECT member."id", member."role", account."authVersion" FROM "TenantUser" member
    JOIN "User" account ON account."id" = member."userId" JOIN "Tenant" tenant ON tenant."id" = member."tenantId"
    WHERE member."tenantId" = ${actor.tenantId} AND member."userId" = ${actor.userId}
      AND member."deletedAtUtc" IS NULL AND account."deletedAtUtc" IS NULL AND tenant."deletedAtUtc" IS NULL
    FOR NO KEY UPDATE OF member, account, tenant`);
  const manager = rows[0];
  if (!manager || !["owner", "admin"].includes(manager.role) || manager.authVersion !== actor.authVersion) {
    reject("QUICKBOOKS_TAX_MANAGER_REQUIRED");
  }
  return manager.id;
}

async function lockSource(tx: Transaction, tenantId: string, invoiceId: string) {
  await lockQuickBooksInvoicePublication(tx, tenantId, invoiceId);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "QuickBooksConnection" WHERE "tenantId" = ${tenantId} FOR UPDATE`);
  const linked = await tx.invoice.findFirst({ where: { tenantId, id: invoiceId }, select: { customerId: true, jobId: true, sourceQuoteId: true } });
  if (!linked) reject("QUICKBOOKS_TAX_INVOICE_CHANGED");
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Customer" WHERE "tenantId" = ${tenantId} AND "id" = ${linked.customerId} FOR NO KEY UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Job" WHERE "tenantId" = ${tenantId} AND "id" = ${linked.jobId} FOR NO KEY UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Quote" WHERE "tenantId" = ${tenantId} AND "id" = ${linked.sourceQuoteId} FOR NO KEY UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Invoice" WHERE "tenantId" = ${tenantId} AND "id" = ${invoiceId} FOR NO KEY UPDATE`);
  // InvoiceLineItem snapshots already deny runtime UPDATE/DELETE. Do not grant
  // mutation privileges merely to take SELECT FOR SHARE; the invoice parent
  // lock stabilizes supported source writers and the complete set is rechecked.
}

async function currentSource(tx: Transaction, tenantId: string, environment: Environment, input: InvoiceTaxContextInput) {
  const connection = await tx.quickBooksConnection.findFirst({ where: {
    tenantId, id: input.connection.id, realmId: input.connection.realmId, environment,
    connectedAtUtc: new Date(input.connection.connectedAtUtc), status: "CONNECTED", deletedAtUtc: null,
    disconnectRequestedAtUtc: null, scopes: { has: "com.intuit.quickbooks.accounting" },
    setupConfirmedAtUtc: { not: null }, setupConfirmedByTenantUserId: { not: null }, setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
    realmBinding: { is: { tenantId, active: true, realmId: input.connection.realmId } },
  }, select: { id: true, realmId: true, environment: true, connectedAtUtc: true } });
  const generation = await currentQuickBooksConnectionGeneration(tx, tenantId);
  if (!connection || environment !== input.connection.environment || generation !== input.connection.generation) {
    reject("QUICKBOOKS_TAX_CONNECTION_CHANGED");
  }
  const invoice = await tx.invoice.findFirst({ where: {
    tenantId, id: input.invoiceId, version: input.invoiceVersion, deletedAtUtc: null, archivedAtUtc: null,
    status: "DRAFT", paymentStatus: "PENDING", amountPaid: 0, currency: "USD",
    customer: { deletedAtUtc: null, archivedAtUtc: null }, job: { deletedAtUtc: null, archivedAtUtc: null, status: { not: "CANCELED" } },
    sourceQuote: { deletedAtUtc: null, archivedAtUtc: null, status: "ACCEPTED" },
  }, select: { id: true, version: true, customerId: true, jobId: true, sourceQuoteId: true, currency: true,
    subtotalAmount: true, taxAmount: true, totalAmount: true, balanceDue: true,
    lineItems: { where: { sectionType: "INCLUDED" }, orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true, position: true, description: true, quantity: true, unitPrice: true, lineTotal: true } } } });
  if (!invoice || !invoice.totalAmount.equals(invoice.balanceDue)) reject("QUICKBOOKS_TAX_INVOICE_CHANGED");
  if (invoice.lineItems.length !== input.lines.length || new Set(input.lines.map((line) => line.invoiceLineItemId)).size !== input.lines.length
    || invoice.lineItems.some((line, index) => line.id !== input.lines[index].invoiceLineItemId)
    || new Set(invoice.lineItems.map((line) => line.position)).size !== invoice.lineItems.length) reject("QUICKBOOKS_TAX_LINES_CHANGED");
  const totals = [invoice.subtotalAmount, invoice.taxAmount, invoice.totalAmount];
  if (totals.some((amount) => !amount.isFinite() || amount.isNegative())
    || !invoice.subtotalAmount.plus(invoice.taxAmount).equals(invoice.totalAmount)
    || !invoice.lineItems.reduce((sum, line) => sum.plus(line.lineTotal), new Prisma.Decimal(0)).equals(invoice.subtotalAmount)
    || invoice.lineItems.some((line) => line.position < 0 || line.position > 999
      || !line.quantity.isFinite() || !line.quantity.isPositive() || !line.unitPrice.isFinite() || line.unitPrice.isNegative()
      || !line.lineTotal.isFinite() || line.lineTotal.isNegative()
      || !line.quantity.mul(line.unitPrice).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).equals(line.lineTotal))) {
    reject("QUICKBOOKS_TAX_INVOICE_CHANGED");
  }

  const [direct, legacy, attemptedTax] = await Promise.all([
    tx.quickBooksInvoiceOperation.findFirst({ where: { tenantId, invoiceId: invoice.id }, select: { id: true } }),
    tx.quickBooksInvoiceSync.findFirst({ where: { tenantId, quoteId: invoice.sourceQuoteId, quickBooksInvoiceId: { not: null } }, select: { id: true } }),
    tx.quickBooksTaxEstimateOperation.findFirst({ where: { tenantId, invoiceId: invoice.id, OR: [
      { attemptCount: { gt: 0 } }, { attemptTokenHash: { not: null } }, { lastAttemptAtUtc: { not: null } }, { providerEstimateId: { not: null } },
      { status: { notIn: ["REVIEWED", "FAILED", "SUPERSEDED"] } },
    ] }, select: { id: true } }),
  ]);
  if (direct || legacy) reject("QUICKBOOKS_TAX_COMPETING_INVOICE_OPERATION");
  if (attemptedTax) reject("QUICKBOOKS_TAX_RECONCILIATION_REQUIRED");

  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "QuickBooksCustomerMap" WHERE "tenantId" = ${tenantId} AND "id" = ${input.customerMapping.id} FOR SHARE`);
  const mapIds = [...new Set(input.lines.map((line) => line.itemMapping.id))].sort();
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "QuickBooksItemMap" WHERE "tenantId" = ${tenantId} AND "id" IN (${Prisma.join(mapIds)}) ORDER BY "id" FOR SHARE`);
  const customerMap = await tx.quickBooksCustomerMap.findFirst({ where: {
    tenantId, id: input.customerMapping.id, customerId: invoice.customerId, quickBooksConnectionId: connection.id,
    reviewVersion: input.customerMapping.reviewVersion, reviewedAtUtc: new Date(input.customerMapping.reviewedAtUtc),
    quickBooksCustomerId: input.customerMapping.providerId, reviewedByTenantUserId: { not: null }, deletedAtUtc: null,
  }, select: { id: true, reviewVersion: true, reviewedAtUtc: true, quickBooksCustomerId: true } });
  if (!customerMap?.reviewedAtUtc) reject("QUICKBOOKS_TAX_MAPPING_CHANGED");
  const itemMaps = await tx.quickBooksItemMap.findMany({ where: { tenantId, id: { in: mapIds }, quickBooksConnectionId: connection.id,
    reviewedByTenantUserId: { not: null }, deletedAtUtc: null },
    select: { id: true, itemKey: true, reviewVersion: true, reviewedAtUtc: true, quickBooksItemId: true } });
  const lines = invoice.lineItems.map((line, index) => {
    const intent = input.lines[index];
    const map = itemMaps.find((entry) => entry.id === intent.itemMapping.id);
    if (!map?.reviewedAtUtc || map.itemKey !== itemKey(line.description) || map.reviewVersion !== intent.itemMapping.reviewVersion
      || map.reviewedAtUtc.toISOString() !== intent.itemMapping.reviewedAtUtc || map.quickBooksItemId !== intent.itemMapping.providerId) {
      reject("QUICKBOOKS_TAX_MAPPING_CHANGED");
    }
    return { invoiceLineItemIdSnapshot: line.id, position: line.position, description: line.description,
      quantity: line.quantity.toFixed(2), unitPrice: line.unitPrice.toFixed(2), amount: line.lineTotal.toFixed(2),
      taxIntent: intent.taxIntent, itemMapId: map.id, itemMapReviewVersion: map.reviewVersion,
      itemMapReviewedAtUtc: map.reviewedAtUtc.toISOString(), providerItemId: map.quickBooksItemId, itemKey: map.itemKey };
  });
  // Conflicting tax intents for one mapped provider item are not inferred away.
  if (lines.some((line) => lines.some((other) => other.providerItemId === line.providerItemId && other.taxIntent !== line.taxIntent))) {
    reject("QUICKBOOKS_TAX_LINES_CHANGED");
  }
  return { tenantId, invoiceId: invoice.id, invoiceVersion: invoice.version, customerId: invoice.customerId,
    jobId: invoice.jobId, sourceQuoteId: invoice.sourceQuoteId, quickBooksConnectionId: connection.id,
    providerRealmId: connection.realmId, environment: connection.environment, connectionConnectedAtUtc: connection.connectedAtUtc.toISOString(),
    connectionGeneration: generation, customerMapId: customerMap.id, customerMapReviewVersion: customerMap.reviewVersion,
    customerMapReviewedAtUtc: customerMap.reviewedAtUtc.toISOString(), providerCustomerId: customerMap.quickBooksCustomerId,
    transactionDate: input.transactionDate, origin: input.origin, destination: input.destination, currency: invoice.currency,
    subtotalAmount: invoice.subtotalAmount.toFixed(2), quotedTaxAmount: invoice.taxAmount.toFixed(2), totalAmount: invoice.totalAmount.toFixed(2), lines };
}

const assessment = (revision: number | null, staleReason: string | null) => ({ revision, current: revision !== null && staleReason === null,
  staleReason, taxCalculationProven: false as const, publishingAuthorized: false as const });

/** Capture only. No provider request, financial mutation, or tax-calculation authority. */
export async function confirmInvoiceTaxContext(prisma: PrismaClient, actor: Actor, environment: Environment, value: unknown) {
  const parsed = invoiceTaxContextInputSchema.safeParse(value);
  if (!parsed.success) reject("QUICKBOOKS_TAX_CONTEXT_INPUT_INVALID");
  const input = parsed.data;
  return withTenantRlsContext(prisma, actor.tenantId, async (tx) => {
    const managerId = await lockManager(tx, actor);
    await lockSource(tx, actor.tenantId, input.invoiceId);
    const source = await currentSource(tx, actor.tenantId, environment, input);
    const inputHash = hash(canonical(source));
    const idempotencyKeyHash = hash(`quotefly/invoice-tax-context/v1:${input.idempotencyKey}`);
    const previous = await tx.invoiceTaxContext.findFirst({ where: { tenantId: actor.tenantId, invoiceId: input.invoiceId, supersededAtUtc: null } });
    const replay = await tx.invoiceTaxContext.findFirst({ where: { tenantId: actor.tenantId, invoiceId: input.invoiceId, idempotencyKeyHash } });
    if (replay) {
      if (replay.id === previous?.id && replay.inputHash === inputHash) return assessment(replay.revision, null);
      reject("QUICKBOOKS_TAX_CONTEXT_IDEMPOTENCY_CONFLICT");
    }
    if (input.expectedRevision !== (previous?.revision ?? 0)) reject("QUICKBOOKS_TAX_CONTEXT_REVISION_CHANGED");
    // A successful key must remain durably bound to its accepted source. An
    // unchanged submission with a new key creates no revision, so reject it
    // rather than acknowledge an unrecorded command as an idempotent success.
    if (previous?.inputHash === inputHash) reject("QUICKBOOKS_TAX_CONTEXT_UNCHANGED");
    const now = new Date();
    // The shared publication lock serializes review replacement with tax claims.
    await tx.quickBooksTaxEstimateOperation.updateMany({ where: { tenantId: actor.tenantId, invoiceId: input.invoiceId,
      supersededAtUtc: null, status: { in: ["REVIEWED", "FAILED"] }, attemptCount: 0, attemptTokenHash: null, providerEstimateId: null },
      data: { status: "SUPERSEDED", supersededAtUtc: now } });
    if (previous) await tx.invoiceTaxContext.updateMany({ where: { tenantId: actor.tenantId, id: previous.id, supersededAtUtc: null }, data: { supersededAtUtc: now } });
    const { lines, ...parent } = source;
    const row = await tx.invoiceTaxContext.create({ data: { ...parent,
      transactionDate: new Date(`${source.transactionDate}T00:00:00.000Z`),
      lineCount: lines.length, revision: (previous?.revision ?? 0) + 1, inputHash, idempotencyKeyHash, confirmedByTenantUserId: managerId, confirmedAtUtc: now,
      // Prisma propagates both contextId and tenantId through the composite relation.
      lines: { create: lines } }, select: { revision: true } });
    return assessment(row.revision, null);
  }, transactionOptions);
}

/** Rechecks the complete source. Returns no addresses, prices, mappings, or provider data. */
export async function readInvoiceTaxContextAssessment(prisma: PrismaClient, actor: Actor, environment: Environment, invoiceId: string) {
  if (!id.safeParse(invoiceId).success) reject("QUICKBOOKS_TAX_CONTEXT_INPUT_INVALID");
  return withTenantRlsContext(prisma, actor.tenantId, async (tx) => {
    await lockManager(tx, actor);
    await lockSource(tx, actor.tenantId, invoiceId);
    const row = await tx.invoiceTaxContext.findFirst({ where: { tenantId: actor.tenantId, invoiceId, supersededAtUtc: null }, include: { lines: { orderBy: { position: "asc" } } } });
    if (!row) return assessment(null, "QUICKBOOKS_TAX_CONTEXT_REQUIRED");
    const input = parseStoredContext(row);
    if (!input.success) return assessment(row.revision, "QUICKBOOKS_TAX_CONTEXT_CHANGED");
    try {
      const source = await currentSource(tx, actor.tenantId, environment, input.data);
      return assessment(row.revision, hash(canonical(source)) === row.inputHash ? null : "QUICKBOOKS_TAX_CONTEXT_CHANGED");
    } catch (error) {
      if (error instanceof QuickBooksTaxContextError) return assessment(row.revision, error.code);
      throw error;
    }
  }, transactionOptions);
}

function parseStoredContext(row: Prisma.InvoiceTaxContextGetPayload<{ include: { lines: true } }>) {
  const invoiceId = row.invoiceId;
  const input = invoiceTaxContextInputSchema.safeParse({ invoiceId, invoiceVersion: row.invoiceVersion, expectedRevision: row.revision,
      idempotencyKey: "00000000-0000-4000-8000-000000000000", transactionDate: row.transactionDate.toISOString().slice(0, 10),
      origin: row.origin, destination: row.destination,
      connection: { id: row.quickBooksConnectionId, realmId: row.providerRealmId, environment: row.environment,
        connectedAtUtc: row.connectionConnectedAtUtc.toISOString(), generation: row.connectionGeneration },
      customerMapping: { id: row.customerMapId, reviewVersion: row.customerMapReviewVersion, reviewedAtUtc: row.customerMapReviewedAtUtc.toISOString(), providerId: row.providerCustomerId },
      lines: row.lines.map((line) => ({ invoiceLineItemId: line.invoiceLineItemIdSnapshot, taxIntent: line.taxIntent,
        itemMapping: { id: line.itemMapId, reviewVersion: line.itemMapReviewVersion, reviewedAtUtc: line.itemMapReviewedAtUtc.toISOString(), providerId: line.providerItemId } })) });
  return input;
}

/** Internal transaction boundary. Caller must keep the returned source private. */
export async function lockAndReadCurrentInvoiceTaxContext(tx: Transaction, actor: Actor, environment: Environment,
  invoiceId: string, expectedRevision: number) {
  const managerId = await lockManager(tx, actor);
  await lockSource(tx, actor.tenantId, invoiceId);
  const row = await tx.invoiceTaxContext.findFirst({ where: { tenantId: actor.tenantId, invoiceId, supersededAtUtc: null },
    include: { lines: { orderBy: { position: "asc" } } } });
  if (!row) reject("QUICKBOOKS_TAX_CONTEXT_REQUIRED");
  if (row.revision !== expectedRevision) reject("QUICKBOOKS_TAX_CONTEXT_REVISION_CHANGED");
  const input = parseStoredContext(row);
  if (!input.success) reject("QUICKBOOKS_TAX_CONTEXT_CHANGED");
  const source = await currentSource(tx, actor.tenantId, environment, input.data);
  if (hash(canonical(source)) !== row.inputHash) reject("QUICKBOOKS_TAX_CONTEXT_CHANGED");
  return { row, source, managerId };
}
