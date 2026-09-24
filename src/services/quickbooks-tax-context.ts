import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { QuickBooksCredentialRuntimeEnv } from "../config/quickbooks-runtime-types";
import type { JwtClaims } from "../lib/auth";
import { withTenantRlsContext } from "../lib/tenant-rls";
import { currentQuickBooksConnectionGeneration } from "./quickbooks-connection-events";
import { lockQuickBooksInvoicePublication } from "./quickbooks-locks";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "./quickbooks-setup";
import { taxReviewLineSchema, usTaxAddressSchema } from "./quickbooks-tax-review-contract";
import { issueQuickBooksTaxContextFormToken, verifyQuickBooksTaxContextFormToken } from "./quickbooks-tax-context-form-token";

type Actor = Pick<JwtClaims, "tenantId" | "userId" | "authVersion">;
type Tx = Prisma.TransactionClient;
type Environment = "sandbox" | "production";
const id = z.string().min(1).max(191).regex(/^[A-Za-z0-9_-]+$/);
const ver = z.number().int().min(1).max(2_147_483_647);
const rev = z.number().int().min(0).max(2_147_483_647);
const mapSchema = z.strictObject({ id, reviewVersion: ver, reviewedAtUtc: z.iso.datetime({ precision: 3 }), providerId: id });
export const invoiceTaxContextInputSchema = z.strictObject({
  invoiceId: id, invoiceVersion: ver, expectedRevision: rev, idempotencyKey: z.string().uuid(),
  transactionDate: z.iso.date(), origin: usTaxAddressSchema, destination: usTaxAddressSchema,
  connection: z.strictObject({ id, realmId: z.string().regex(/^\d{1,64}$/), environment: z.enum(["sandbox", "production"]),
    connectedAtUtc: z.iso.datetime({ precision: 3 }), generation: ver }),
  customerMapping: mapSchema,
  lines: z.array(z.strictObject({ invoiceLineItemId: id, taxIntent: taxReviewLineSchema.shape.taxIntent, itemMapping: mapSchema })).min(1).max(500),
});
export type InvoiceTaxContextInput = z.infer<typeof invoiceTaxContextInputSchema>;
export const invoiceTaxContextFormSubmissionSchema = z.strictObject({
  transactionDate: z.iso.date(), origin: usTaxAddressSchema, destination: usTaxAddressSchema,
  lines: z.array(z.strictObject({ invoiceLineItemId: id, taxIntent: taxReviewLineSchema.shape.taxIntent })).min(1).max(500),
  expectedContextRevision: rev, commandKey: z.string().uuid(), sourceToken: z.string().min(1).max(2_048),
});

export class QuickBooksTaxContextError extends Error {
  constructor(readonly code: string, readonly statusCode = 409) { super(code); this.name = "QuickBooksTaxContextError"; }
}
function reject(code: string, status = 409): never { throw new QuickBooksTaxContextError(code, status); }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const itemKey = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
const txOptions = { maxWait: 10_000, timeout: 15_000 };

async function lockManager(tx: Tx, actor: Actor) {
  const rows = await tx.$queryRaw<Array<{ id: string; role: string; authVersion: number }>>(Prisma.sql`
    SELECT m."id", m."role", u."authVersion" FROM "TenantUser" m
    JOIN "User" u ON u."id" = m."userId" JOIN "Tenant" t ON t."id" = m."tenantId"
    WHERE m."tenantId" = ${actor.tenantId} AND m."userId" = ${actor.userId}
      AND m."deletedAtUtc" IS NULL AND u."deletedAtUtc" IS NULL AND t."deletedAtUtc" IS NULL
    FOR SHARE OF m, u, t`);
  const manager = rows[0];
  if (!manager || !["owner", "admin"].includes(manager.role) || manager.authVersion !== actor.authVersion) {
    reject("QUICKBOOKS_TAX_MANAGER_REQUIRED", 403);
  }
  return manager.id;
}

async function lockSource(tx: Tx, tenantId: string, invoiceId: string) {
  await lockQuickBooksInvoicePublication(tx, tenantId, invoiceId);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "QuickBooksConnection" WHERE "tenantId" = ${tenantId} FOR SHARE`);
  const link = await tx.invoice.findFirst({ where: { tenantId, id: invoiceId },
    select: { customerId: true, jobId: true, sourceQuoteId: true } });
  if (!link) reject("QUICKBOOKS_TAX_INVOICE_CHANGED", 404);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Customer" WHERE "tenantId"=${tenantId} AND "id"=${link.customerId} FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Job" WHERE "tenantId"=${tenantId} AND "id"=${link.jobId} FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Quote" WHERE "tenantId"=${tenantId} AND "id"=${link.sourceQuoteId} FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Invoice" WHERE "tenantId"=${tenantId} AND "id"=${invoiceId} FOR SHARE`);
}

async function loadBinding(tx: Tx, tenantId: string, environment: Environment, invoiceId: string) {
  const connection = await tx.quickBooksConnection.findFirst({ where: {
    tenantId, environment, status: "CONNECTED", deletedAtUtc: null, disconnectRequestedAtUtc: null,
    scopes: { has: "com.intuit.quickbooks.accounting" }, setupConfirmedAtUtc: { not: null },
    setupConfirmedByTenantUserId: { not: null }, setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
    realmBinding: { is: { tenantId, active: true } },
  }, select: { id: true, realmId: true, environment: true, connectedAtUtc: true, setupConfirmedAtUtc: true,
    setupConfirmedByTenantUserId: true, setupChecklistVersion: true, scopes: true,
    realmBinding: { select: { realmId: true, active: true, createdAt: true } } } });
  const generation = await currentQuickBooksConnectionGeneration(tx, tenantId);
  if (!connection || connection.realmBinding?.realmId !== connection.realmId || generation < 1) reject("QUICKBOOKS_TAX_CONNECTION_CHANGED");
  const invoice = await tx.invoice.findFirst({ where: {
    tenantId, id: invoiceId, deletedAtUtc: null, archivedAtUtc: null, status: "DRAFT", paymentStatus: "PENDING",
    amountPaid: 0, currency: "USD", customer: { deletedAtUtc: null, archivedAtUtc: null },
    job: { deletedAtUtc: null, archivedAtUtc: null, status: { not: "CANCELED" } },
    sourceQuote: { deletedAtUtc: null, archivedAtUtc: null, status: "ACCEPTED" },
  }, select: { id: true, version: true, customerId: true, jobId: true, sourceQuoteId: true, currency: true,
    subtotalAmount: true, taxAmount: true, totalAmount: true, balanceDue: true, updatedAt: true,
    customer: { select: { updatedAt: true } }, job: { select: { updatedAt: true } },
    sourceQuote: { select: { updatedAt: true } },
    lineItems: { where: { sectionType: "INCLUDED" }, orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true, position: true, description: true, quantity: true, unitPrice: true, lineTotal: true, createdAt: true } } } });
  if (!invoice) reject("QUICKBOOKS_TAX_INVOICE_CHANGED", 404);
  if (!invoice.totalAmount.equals(invoice.balanceDue) || invoice.lineItems.length < 1 || invoice.lineItems.length > 500
    || new Set(invoice.lineItems.map((line) => line.position)).size !== invoice.lineItems.length) reject("QUICKBOOKS_TAX_INVOICE_CHANGED");
  const amounts = [invoice.subtotalAmount, invoice.taxAmount, invoice.totalAmount];
  if (amounts.some((amount) => !amount.isFinite() || amount.isNegative())
    || !invoice.subtotalAmount.plus(invoice.taxAmount).equals(invoice.totalAmount)
    || !invoice.lineItems.reduce((sum, line) => sum.plus(line.lineTotal), new Prisma.Decimal(0)).equals(invoice.subtotalAmount)
    || invoice.lineItems.some((line) => line.position < 0 || line.position > 999 || !line.quantity.isFinite()
      || !line.quantity.isPositive() || !line.unitPrice.isFinite() || line.unitPrice.isNegative()
      || !line.lineTotal.isFinite() || line.lineTotal.isNegative()
      || !line.quantity.mul(line.unitPrice).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).equals(line.lineTotal))) {
    reject("QUICKBOOKS_TAX_INVOICE_CHANGED");
  }
  const [direct, legacy, attempted] = await Promise.all([
    tx.quickBooksInvoiceOperation.findFirst({ where: { tenantId, invoiceId }, select: { id: true } }),
    tx.quickBooksInvoiceSync.findFirst({ where: { tenantId, quoteId: invoice.sourceQuoteId, quickBooksInvoiceId: { not: null } }, select: { id: true } }),
    tx.quickBooksTaxEstimateOperation.findFirst({ where: { tenantId, invoiceId, OR: [
      { attemptCount: { gt: 0 } }, { attemptTokenHash: { not: null } }, { lastAttemptAtUtc: { not: null } },
      { providerEstimateId: { not: null } }, { status: { notIn: ["REVIEWED", "FAILED", "SUPERSEDED"] } },
    ] }, select: { id: true } }),
  ]);
  if (direct || legacy) reject("QUICKBOOKS_TAX_COMPETING_INVOICE_OPERATION");
  if (attempted) reject("QUICKBOOKS_TAX_RECONCILIATION_REQUIRED");
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "QuickBooksCustomerMap"
    WHERE "tenantId"=${tenantId} AND "quickBooksConnectionId"=${connection.id}
      AND "customerId"=${invoice.customerId} AND "deletedAtUtc" IS NULL ORDER BY "id" FOR SHARE`);
  let customerMaps = await tx.quickBooksCustomerMap.findMany({ where: { tenantId, customerId: invoice.customerId,
    quickBooksConnectionId: connection.id, reviewedByTenantUserId: { not: null }, reviewedAtUtc: { not: null }, deletedAtUtc: null },
    select: { id: true, reviewVersion: true, reviewedAtUtc: true, quickBooksCustomerId: true, quickBooksDisplayName: true } });
  const customerMap = customerMaps[0];
  if (customerMaps.length !== 1 || !customerMap?.reviewedAtUtc || customerMap.reviewVersion < 1) reject("QUICKBOOKS_TAX_MAPPING_CHANGED");
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "QuickBooksCustomerMap" WHERE "tenantId"=${tenantId} AND "id"=${customerMap.id} FOR SHARE`);
  customerMaps = await tx.quickBooksCustomerMap.findMany({ where: { tenantId, customerId: invoice.customerId,
    quickBooksConnectionId: connection.id, reviewedByTenantUserId: { not: null }, reviewedAtUtc: { not: null }, deletedAtUtc: null },
    select: { id: true, reviewVersion: true, reviewedAtUtc: true, quickBooksCustomerId: true, quickBooksDisplayName: true } });
  if (customerMaps.length !== 1 || customerMaps[0].id !== customerMap.id
    || !customerMaps[0].reviewedAtUtc || customerMaps[0].reviewVersion < 1) reject("QUICKBOOKS_TAX_MAPPING_CHANGED");
  const keys = [...new Set(invoice.lineItems.map((line) => itemKey(line.description)))].sort();
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "QuickBooksItemMap"
    WHERE "tenantId"=${tenantId} AND "quickBooksConnectionId"=${connection.id}
      AND "itemKey" IN (${Prisma.join(keys)}) AND "deletedAtUtc" IS NULL ORDER BY "id" FOR SHARE`);
  let maps = await tx.quickBooksItemMap.findMany({ where: { tenantId, quickBooksConnectionId: connection.id,
    itemKey: { in: keys }, reviewedByTenantUserId: { not: null }, reviewedAtUtc: { not: null }, deletedAtUtc: null },
    select: { id: true, itemKey: true, reviewVersion: true, reviewedAtUtc: true, quickBooksItemId: true, quickBooksItemName: true } });
  if (maps.length !== keys.length || maps.some((entry) => !entry.reviewedAtUtc || entry.reviewVersion < 1)) reject("QUICKBOOKS_TAX_MAPPING_CHANGED");
  const mapIds = maps.map((entry) => entry.id).sort();
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "QuickBooksItemMap" WHERE "tenantId"=${tenantId} AND "id" IN (${Prisma.join(mapIds)}) ORDER BY "id" FOR SHARE`);
  maps = await tx.quickBooksItemMap.findMany({ where: { tenantId, id: { in: mapIds }, quickBooksConnectionId: connection.id,
    itemKey: { in: keys }, reviewedByTenantUserId: { not: null }, reviewedAtUtc: { not: null }, deletedAtUtc: null },
    select: { id: true, itemKey: true, reviewVersion: true, reviewedAtUtc: true, quickBooksItemId: true, quickBooksItemName: true } });
  if (maps.length !== keys.length || maps.some((entry) => !entry.reviewedAtUtc || entry.reviewVersion < 1)) reject("QUICKBOOKS_TAX_MAPPING_CHANGED");
  const lines = invoice.lineItems.map((line) => {
    const map = maps.find((entry) => entry.itemKey === itemKey(line.description));
    if (!map?.reviewedAtUtc) reject("QUICKBOOKS_TAX_MAPPING_CHANGED");
    return { invoiceLineItemIdSnapshot: line.id, position: line.position, description: line.description,
      quantity: line.quantity.toFixed(2), unitPrice: line.unitPrice.toFixed(2), amount: line.lineTotal.toFixed(2),
      createdAtUtc: line.createdAt.toISOString(), itemMapId: map.id, itemMapReviewVersion: map.reviewVersion,
      itemMapReviewedAtUtc: map.reviewedAtUtc.toISOString(), providerItemId: map.quickBooksItemId,
      itemKey: map.itemKey, itemDisplayName: map.quickBooksItemName };
  });
  const stableCustomerMap = customerMaps[0];
  return { tenantId, invoiceId: invoice.id, invoiceVersion: invoice.version, customerId: invoice.customerId,
    jobId: invoice.jobId, sourceQuoteId: invoice.sourceQuoteId,
    sourceLifecycle: { invoiceUpdatedAtUtc: invoice.updatedAt.toISOString(), customerUpdatedAtUtc: invoice.customer.updatedAt.toISOString(),
      jobUpdatedAtUtc: invoice.job.updatedAt.toISOString(), quoteUpdatedAtUtc: invoice.sourceQuote.updatedAt.toISOString() },
    quickBooksConnectionId: connection.id, providerRealmId: connection.realmId, environment: connection.environment as Environment,
    connectionConnectedAtUtc: connection.connectedAtUtc.toISOString(), connectionGeneration: generation,
    setup: { confirmedAtUtc: connection.setupConfirmedAtUtc!.toISOString(),
      confirmedByTenantUserId: connection.setupConfirmedByTenantUserId!, checklistVersion: connection.setupChecklistVersion!,
      scopes: [...connection.scopes].sort(), realmBoundAtUtc: connection.realmBinding!.createdAt.toISOString(),
      realmActive: connection.realmBinding!.active },
    customerMapId: stableCustomerMap.id, customerMapReviewVersion: stableCustomerMap.reviewVersion,
    customerMapReviewedAtUtc: stableCustomerMap.reviewedAtUtc!.toISOString(), providerCustomerId: stableCustomerMap.quickBooksCustomerId,
    customerDisplayName: stableCustomerMap.quickBooksDisplayName, currency: invoice.currency,
    subtotalAmount: invoice.subtotalAmount.toFixed(2), quotedTaxAmount: invoice.taxAmount.toFixed(2),
    totalAmount: invoice.totalAmount.toFixed(2), lines };
}

type Binding = Awaited<ReturnType<typeof loadBinding>>;
function buildSource(binding: Binding, input: InvoiceTaxContextInput) {
  if (input.invoiceId !== binding.invoiceId || input.invoiceVersion !== binding.invoiceVersion) {
    reject("QUICKBOOKS_TAX_INVOICE_CHANGED");
  }
  const trustedConnection = { id: binding.quickBooksConnectionId, realmId: binding.providerRealmId,
    environment: binding.environment, connectedAtUtc: binding.connectionConnectedAtUtc, generation: binding.connectionGeneration };
  if (canonical(input.connection) !== canonical(trustedConnection)) reject("QUICKBOOKS_TAX_CONNECTION_CHANGED");
  if (input.lines.length !== binding.lines.length || new Set(input.lines.map((line) => line.invoiceLineItemId)).size !== input.lines.length
    || binding.lines.some((line, index) => line.invoiceLineItemIdSnapshot !== input.lines[index].invoiceLineItemId)) {
    reject("QUICKBOOKS_TAX_LINES_CHANGED");
  }
  const trustedCustomerMap = { id: binding.customerMapId, reviewVersion: binding.customerMapReviewVersion,
    reviewedAtUtc: binding.customerMapReviewedAtUtc, providerId: binding.providerCustomerId };
  if (canonical(input.customerMapping) !== canonical(trustedCustomerMap)
    || binding.lines.some((line, index) => canonical(input.lines[index].itemMapping) !== canonical({
      id: line.itemMapId, reviewVersion: line.itemMapReviewVersion,
      reviewedAtUtc: line.itemMapReviewedAtUtc, providerId: line.providerItemId }))) {
    reject("QUICKBOOKS_TAX_MAPPING_CHANGED");
  }
  const lines = binding.lines.map((line, index) => ({ ...line, taxIntent: input.lines[index].taxIntent }));
  if (lines.some((line) => lines.some((other) => other.providerItemId === line.providerItemId && other.taxIntent !== line.taxIntent))) {
    reject("QUICKBOOKS_TAX_LINES_CHANGED");
  }
  const { sourceLifecycle: _lifecycle, setup: _setup, customerDisplayName: _customerName, ...parent } = binding;
  return { ...parent, transactionDate: input.transactionDate, origin: input.origin, destination: input.destination,
    lines: lines.map(({ createdAtUtc: _created, itemDisplayName: _display, ...line }) => line) };
}

const assessment = (revision: number | null, staleReason: string | null) => ({ revision,
  current: revision !== null && staleReason === null, staleReason, taxCalculationProven: false as const, publishingAuthorized: false as const });
type ContextRow = Prisma.InvoiceTaxContextGetPayload<{ include: { lines: true } }>;
function storedInput(row: ContextRow) {
  return invoiceTaxContextInputSchema.safeParse({ invoiceId: row.invoiceId, invoiceVersion: row.invoiceVersion,
    expectedRevision: row.revision, idempotencyKey: "00000000-0000-4000-8000-000000000000",
    transactionDate: row.transactionDate.toISOString().slice(0, 10), origin: row.origin, destination: row.destination,
    connection: { id: row.quickBooksConnectionId, realmId: row.providerRealmId, environment: row.environment,
      connectedAtUtc: row.connectionConnectedAtUtc.toISOString(), generation: row.connectionGeneration },
    customerMapping: { id: row.customerMapId, reviewVersion: row.customerMapReviewVersion,
      reviewedAtUtc: row.customerMapReviewedAtUtc.toISOString(), providerId: row.providerCustomerId },
    lines: row.lines.map((line) => ({ invoiceLineItemId: line.invoiceLineItemIdSnapshot, taxIntent: line.taxIntent,
      itemMapping: { id: line.itemMapId, reviewVersion: line.itemMapReviewVersion,
        reviewedAtUtc: line.itemMapReviewedAtUtc.toISOString(), providerId: line.providerItemId } })) });
}
function assess(binding: Binding, row: ContextRow | null) {
  if (!row) return assessment(null, "QUICKBOOKS_TAX_CONTEXT_REQUIRED");
  const input = storedInput(row); if (!input.success) return assessment(row.revision, "QUICKBOOKS_TAX_CONTEXT_CHANGED");
  try { return assessment(row.revision, digest(canonical(buildSource(binding, input.data))) === row.inputHash ? null : "QUICKBOOKS_TAX_CONTEXT_CHANGED"); }
  catch (error) { if (error instanceof QuickBooksTaxContextError) return assessment(row.revision, error.code); throw error; }
}

async function persist(tx: Tx, actor: Actor, managerId: string, binding: Binding, input: InvoiceTaxContextInput) {
  const source = buildSource(binding, input); const inputHash = digest(canonical(source));
  const keyHash = digest(`quotefly/invoice-tax-context/v1:${input.idempotencyKey}`);
  const previous = await tx.invoiceTaxContext.findFirst({ where: { tenantId: actor.tenantId, invoiceId: input.invoiceId, supersededAtUtc: null } });
  const replay = await tx.invoiceTaxContext.findFirst({ where: { tenantId: actor.tenantId, invoiceId: input.invoiceId, idempotencyKeyHash: keyHash } });
  if (replay) {
    if (replay.id === previous?.id && replay.inputHash === inputHash) return { ...assessment(replay.revision, null), replayed: true, confirmedAtUtc: replay.confirmedAtUtc.toISOString() };
    reject("QUICKBOOKS_TAX_CONTEXT_IDEMPOTENCY_CONFLICT");
  }
  if (input.expectedRevision !== (previous?.revision ?? 0)) reject("QUICKBOOKS_TAX_CONTEXT_REVISION_CHANGED");
  if (previous?.inputHash === inputHash) reject("QUICKBOOKS_TAX_CONTEXT_UNCHANGED");
  const now = new Date();
  await tx.quickBooksTaxEstimateOperation.updateMany({ where: { tenantId: actor.tenantId, invoiceId: input.invoiceId,
    supersededAtUtc: null, status: { in: ["REVIEWED", "FAILED"] }, attemptCount: 0, attemptTokenHash: null, providerEstimateId: null },
    data: { status: "SUPERSEDED", supersededAtUtc: now } });
  if (previous) await tx.invoiceTaxContext.updateMany({ where: { tenantId: actor.tenantId, id: previous.id, supersededAtUtc: null }, data: { supersededAtUtc: now } });
  const { lines, ...parent } = source;
  const row = await tx.invoiceTaxContext.create({ data: { ...parent, transactionDate: new Date(`${source.transactionDate}T00:00:00.000Z`),
    lineCount: lines.length, revision: (previous?.revision ?? 0) + 1, inputHash, idempotencyKeyHash: keyHash,
    confirmedByTenantUserId: managerId, confirmedAtUtc: now, lines: { create: lines } },
    select: { revision: true, confirmedAtUtc: true } });
  return { ...assessment(row.revision, null), replayed: false, confirmedAtUtc: row.confirmedAtUtc.toISOString() };
}

export async function confirmInvoiceTaxContext(prisma: PrismaClient, actor: Actor, environment: Environment, value: unknown) {
  const parsed = invoiceTaxContextInputSchema.safeParse(value);
  if (!parsed.success) reject("QUICKBOOKS_TAX_CONTEXT_INPUT_INVALID", 400);
  return withTenantRlsContext(prisma, actor.tenantId, async (tx) => {
    const managerId = await lockManager(tx, actor); await lockSource(tx, actor.tenantId, parsed.data.invoiceId);
    return persist(tx, actor, managerId, await loadBinding(tx, actor.tenantId, environment, parsed.data.invoiceId), parsed.data);
  }, txOptions);
}
export async function readInvoiceTaxContextAssessment(prisma: PrismaClient, actor: Actor, environment: Environment, invoiceId: string) {
  if (!id.safeParse(invoiceId).success) reject("QUICKBOOKS_TAX_CONTEXT_INPUT_INVALID", 400);
  return withTenantRlsContext(prisma, actor.tenantId, async (tx) => {
    await lockManager(tx, actor); await lockSource(tx, actor.tenantId, invoiceId);
    const row = await tx.invoiceTaxContext.findFirst({ where: { tenantId: actor.tenantId, invoiceId, supersededAtUtc: null },
      include: { lines: { orderBy: { position: "asc" } } } });
    try { return assess(await loadBinding(tx, actor.tenantId, environment, invoiceId), row); }
    catch (error) {
      if (row && error instanceof QuickBooksTaxContextError) return assessment(row.revision, error.code);
      throw error;
    }
  }, txOptions);
}
export async function lockAndReadCurrentInvoiceTaxContext(tx: Tx, actor: Actor, environment: Environment,
  invoiceId: string, expectedRevision: number) {
  const managerId = await lockManager(tx, actor); await lockSource(tx, actor.tenantId, invoiceId);
  const binding = await loadBinding(tx, actor.tenantId, environment, invoiceId);
  const row = await tx.invoiceTaxContext.findFirst({ where: { tenantId: actor.tenantId, invoiceId, supersededAtUtc: null },
    include: { lines: { orderBy: { position: "asc" } } } });
  if (!row) reject("QUICKBOOKS_TAX_CONTEXT_REQUIRED");
  if (row.revision !== expectedRevision) reject("QUICKBOOKS_TAX_CONTEXT_REVISION_CHANGED");
  const input = storedInput(row); if (!input.success) reject("QUICKBOOKS_TAX_CONTEXT_CHANGED");
  const source = buildSource(binding, input.data);
  if (digest(canonical(source)) !== row.inputHash) reject("QUICKBOOKS_TAX_CONTEXT_CHANGED");
  return { row, source, managerId };
}

export async function loadInvoiceTaxContextForm(prisma: PrismaClient, actor: Actor,
  environment: QuickBooksCredentialRuntimeEnv, invoiceId: string) {
  if (!id.safeParse(invoiceId).success) reject("QUICKBOOKS_TAX_CONTEXT_INPUT_INVALID", 400);
  return withTenantRlsContext(prisma, actor.tenantId, async (tx) => {
    const managerId = await lockManager(tx, actor); await lockSource(tx, actor.tenantId, invoiceId);
    const binding = await loadBinding(tx, actor.tenantId, environment.QUICKBOOKS_ENVIRONMENT, invoiceId);
    const row = await tx.invoiceTaxContext.findFirst({ where: { tenantId: actor.tenantId, invoiceId, supersededAtUtc: null },
      include: { lines: { orderBy: { position: "asc" } } } });
    const current = assess(binding, row); const expectedContextRevision = row?.revision ?? 0;
    const issued = issueQuickBooksTaxContextFormToken(environment, { tid: actor.tenantId, uid: actor.userId, mid: managerId,
      av: actor.authVersion, iid: invoiceId, rev: expectedContextRevision }, binding);
    const branding = await tx.tenantBranding.findFirst({ where: { tenantId: actor.tenantId, deletedAtUtc: null },
      select: { addressLine1: true, addressLine2: true, city: true, state: true, postalCode: true } });
    const origin = usTaxAddressSchema.safeParse({ Line1: branding?.addressLine1, Line2: branding?.addressLine2 || undefined,
      City: branding?.city, CountrySubDivisionCode: branding?.state, PostalCode: branding?.postalCode, Country: "US" });
    const prior = row ? storedInput(row) : null;
    return { invoice: { id: binding.invoiceId, version: binding.invoiceVersion, currency: binding.currency,
      subtotalAmount: binding.subtotalAmount, taxAmount: binding.quotedTaxAmount, totalAmount: binding.totalAmount,
      lines: binding.lines.map((line) => ({ invoiceLineItemId: line.invoiceLineItemIdSnapshot, position: line.position,
        description: line.description, quantity: line.quantity, unitPrice: line.unitPrice, amount: line.amount,
        mapping: { reviewed: true as const, displayName: line.itemDisplayName } })) },
      currentContext: { revision: current.revision, current: current.current, staleReason: current.staleReason,
        decisions: prior?.success ? { transactionDate: prior.data.transactionDate, origin: prior.data.origin,
          destination: prior.data.destination, lines: prior.data.lines.map((line) => ({
            invoiceLineItemId: line.invoiceLineItemId, taxIntent: line.taxIntent })) } : null,
        confirmedAtUtc: row?.confirmedAtUtc.toISOString() ?? null },
      suggestions: { origin: origin.success ? origin.data : null, destination: null },
      expectedContextRevision, sourceToken: issued.token, sourceTokenExpiresAtUtc: issued.expiresAtUtc,
      taxCalculationProven: false as const, publishingAuthorized: false as const };
  }, txOptions);
}

export async function confirmInvoiceTaxContextForm(prisma: PrismaClient, actor: Actor,
  environment: QuickBooksCredentialRuntimeEnv, invoiceId: string, value: unknown) {
  if (!id.safeParse(invoiceId).success) reject("QUICKBOOKS_TAX_CONTEXT_INPUT_INVALID", 400);
  const parsed = invoiceTaxContextFormSubmissionSchema.safeParse(value);
  if (!parsed.success) reject("QUICKBOOKS_TAX_CONTEXT_INPUT_INVALID", 400);
  const form = parsed.data;
  return withTenantRlsContext(prisma, actor.tenantId, async (tx) => {
    const managerId = await lockManager(tx, actor); await lockSource(tx, actor.tenantId, invoiceId);
    const binding = await loadBinding(tx, actor.tenantId, environment.QUICKBOOKS_ENVIRONMENT, invoiceId);
    verifyQuickBooksTaxContextFormToken(environment, form.sourceToken, { tid: actor.tenantId, uid: actor.userId,
      mid: managerId, av: actor.authVersion, iid: invoiceId, rev: form.expectedContextRevision }, binding);
    if (form.lines.length !== binding.lines.length || new Set(form.lines.map((line) => line.invoiceLineItemId)).size !== form.lines.length
      || binding.lines.some((line, index) => line.invoiceLineItemIdSnapshot !== form.lines[index].invoiceLineItemId)) {
      reject("QUICKBOOKS_TAX_LINES_CHANGED");
    }
    const input: InvoiceTaxContextInput = { invoiceId, invoiceVersion: binding.invoiceVersion,
      expectedRevision: form.expectedContextRevision, idempotencyKey: form.commandKey, transactionDate: form.transactionDate,
      origin: form.origin, destination: form.destination,
      connection: { id: binding.quickBooksConnectionId, realmId: binding.providerRealmId, environment: binding.environment,
        connectedAtUtc: binding.connectionConnectedAtUtc, generation: binding.connectionGeneration },
      customerMapping: { id: binding.customerMapId, reviewVersion: binding.customerMapReviewVersion,
        reviewedAtUtc: binding.customerMapReviewedAtUtc, providerId: binding.providerCustomerId },
      lines: form.lines.map((line, index) => ({ ...line, itemMapping: { id: binding.lines[index].itemMapId,
        reviewVersion: binding.lines[index].itemMapReviewVersion, reviewedAtUtc: binding.lines[index].itemMapReviewedAtUtc,
        providerId: binding.lines[index].providerItemId } })) };
    return persist(tx, actor, managerId, binding, input);
  }, txOptions);
}
