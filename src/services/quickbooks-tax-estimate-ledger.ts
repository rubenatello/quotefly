import { createHash, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Prisma, type PrismaClient, type QuickBooksTaxEstimateOperation } from "@prisma/client";
import { z } from "zod";
import type { QuickBooksCredentialRuntimeEnv } from "../config/quickbooks-runtime-types";
import { lockAndReadCurrentInvoiceTaxContext } from "./quickbooks-tax-context";
import { readQuickBooksTaxProviderFacts } from "./quickbooks-tax-provider-facts";
import type { JwtClaims } from "../lib/auth";
import { withTenantRlsContext } from "../lib/tenant-rls";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "./quickbooks-setup";
import { lockQuickBooksInvoicePublication } from "./quickbooks-locks";
import { createQuickBooksTaxReview, type TaxReviewSource } from "./quickbooks-tax-review-contract";

type Transaction = Prisma.TransactionClient;
type Actor = Pick<JwtClaims, "tenantId" | "userId" | "authVersion">;
const CLAIM_MS = 120_000;
const FACT_MAX_AGE_MS = 5 * 60_000;
const REVIEW_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 15_000 };
const UNCERTAIN_CODE = "QUICKBOOKS_ESTIMATE_RECONCILIATION_REQUIRED";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const normalizedText = (value: string) => value.normalize("NFC").trim();
const itemKey = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sameHexDigest(left: string, right: string) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function freeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

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

function reviewKeys(environment: QuickBooksCredentialRuntimeEnv) {
  const current = keyFor(environment.QUICKBOOKS_TOKEN_ENCRYPTION_KEY);
  const previousMaterial = environment.QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS?.trim();
  const previous = previousMaterial ? keyFor(previousMaterial) : null;
  return { current, previous };
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
  const observations = [source.preferences.companyObservedAtUtc, source.preferences.observedAtUtc, source.customerFacts.observedAtUtc,
    ...source.lines.map((line) => line.itemFacts.observedAtUtc)];
  if (observations.some((timestamp) => {
    const age = now.getTime() - Date.parse(timestamp);
    return age < -5_000 || age > FACT_MAX_AGE_MS;
  })) reject("QUICKBOOKS_TAX_FACTS_STALE");
}

async function requireCurrentSource(tx: Transaction, actor: Actor, source: TaxReviewSource, now: Date) {
  if (source.tenantId !== actor.tenantId) reject("QUICKBOOKS_TAX_REVIEW_CHANGED");
  requireFreshFacts(source, now);
  const currentContext = await lockAndReadCurrentInvoiceTaxContext(tx, actor, source.connection.environment,
    source.invoiceId, source.invoiceTaxContext.revision);
  const context = currentContext.row;
  if (context.id !== source.invoiceTaxContext.id || context.inputHash !== source.invoiceTaxContext.inputHash
    || context.confirmedByTenantUserId !== source.invoiceTaxContext.confirmedByTenantUserId
    || context.confirmedAtUtc.toISOString() !== source.invoiceTaxContext.confirmedAtUtc
    || context.connectionGeneration !== source.connection.generation || context.jobId !== source.jobId) {
    reject("QUICKBOOKS_TAX_CONTEXT_CHANGED");
  }
  // Rebuild all local decisions from the immutable current context, carrying
  // forward only its originally observed provider facts. Binding the context
  // identity alone would not detect a source assembled with different addresses,
  // transaction date or per-line tax intent by a future internal caller.
  const rebuilt = sourceFromContext(currentContext, {
    customer: { providerCustomerId: source.customerFacts.providerCustomerId, providerSyncToken: source.customerFacts.providerSyncToken,
      observedAtUtc: source.customerFacts.observedAtUtc, classification: source.customerFacts.exemption === "TAXABLE" ? "TAXABLE" : "UNKNOWN",
      fingerprint: source.customerFacts.fingerprint },
    items: source.lines.map(line => ({ providerItemId: line.itemFacts.providerItemId, providerSyncToken: line.itemFacts.providerSyncToken,
      observedAtUtc: line.itemFacts.observedAtUtc, classification: line.taxIntent, fingerprint: line.itemFacts.taxClassificationFingerprint })),
    companyInfo: { observedAtUtc: source.preferences.companyObservedAtUtc, fingerprint: source.preferences.companyInfoFingerprint },
    preferences: { observedAtUtc: source.preferences.observedAtUtc, fingerprint: source.preferences.fingerprint },
    capabilities: source.preferences.capabilities, observedFromUtc: source.preferences.observedAtUtc, observedThroughUtc: source.preferences.observedAtUtc,
    blockers: [], providerFactsSupported: true, automatedTaxCalculationProven: false, publishingAuthorized: false,
  });
  const parseOnlyKey = "internal-context-comparison-not-a-signing-authority";
  if (createQuickBooksTaxReview(rebuilt, parseOnlyKey).sourceHash !== createQuickBooksTaxReview(source, parseOnlyKey).sourceHash) {
    reject("QUICKBOOKS_TAX_CONTEXT_CHANGED");
  }
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
    customerId: source.customerId, sourceQuoteId: source.sourceQuoteId, jobId: source.jobId,
    deletedAtUtc: null, archivedAtUtc: null, status: "DRAFT", paymentStatus: "PENDING", amountPaid: 0,
    customer: { deletedAtUtc: null, archivedAtUtc: null },
    job: { deletedAtUtc: null, archivedAtUtc: null, status: { not: "CANCELED" } },
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

function verifiedStoredReview(current: QuickBooksTaxEstimateOperation, environment: QuickBooksCredentialRuntimeEnv) {
  if (current.contractVersion !== 2 || !current.invoiceTaxContextId || !current.invoiceTaxContextRevision
    || !current.invoiceTaxContextInputHash || !current.connectionGeneration) reject("QUICKBOOKS_TAX_CONTEXT_BINDING_REQUIRED");
  try {
    const keys = reviewKeys(environment);
    const signingKey = current.bindingKeyId === keys.current.id ? keys.current
      : current.bindingKeyId === keys.previous?.id ? keys.previous : null;
    if (!signingKey) return reject("QUICKBOOKS_TAX_STORED_REVIEW_INVALID");
    const snapshot = createQuickBooksTaxReview(current.sourceSnapshot, signingKey.key);
    const storedAst = canonicalJson(current.estimateAstSnapshot);
    const recomputedAst = canonicalJson(snapshot.estimateAst);
    if (snapshot.sourceHash !== current.sourceHash || snapshot.estimateAstHash !== current.estimateAstHash
      || sha256(storedAst) !== current.estimateAstHash || storedAst !== recomputedAst
      || !sameHexDigest(sha256(snapshot.binding), current.reviewBindingDigest)
      || current.tenantId !== snapshot.source.tenantId || current.invoiceId !== snapshot.source.invoiceId
      || current.customerId !== snapshot.source.customerId || current.sourceQuoteId !== snapshot.source.sourceQuoteId
      || current.quickBooksConnectionId !== snapshot.source.connection.id
      || current.providerRealmId !== snapshot.source.connection.realmId
      || current.connectionGenerationAtUtc.toISOString() !== snapshot.source.connection.connectedAtUtc
      || current.invoiceTaxContextId !== snapshot.source.invoiceTaxContext.id
      || current.invoiceTaxContextRevision !== snapshot.source.invoiceTaxContext.revision
      || current.invoiceTaxContextInputHash !== snapshot.source.invoiceTaxContext.inputHash
      || current.connectionGeneration !== snapshot.source.connection.generation) {
      return reject("QUICKBOOKS_TAX_STORED_REVIEW_INVALID");
    }
    if (snapshot.source.connection.environment !== environment.QUICKBOOKS_ENVIRONMENT) {
      return reject("QUICKBOOKS_TAX_ENVIRONMENT_MISMATCH");
    }
    if (!snapshot.assessment.providerPrerequisitesReady || !snapshot.assessment.reviewSourceReady) {
      return reject("QUICKBOOKS_TAX_REVIEW_NOT_READY");
    }
    return snapshot;
  } catch (error) {
    if (error instanceof QuickBooksTaxLedgerError) throw error;
    return reject("QUICKBOOKS_TAX_STORED_REVIEW_INVALID");
  }
}

function connectionTarget(actor: Actor, source: TaxReviewSource) {
  return freeze({
    id: source.connection.id,
    tenantId: actor.tenantId,
    realmId: source.connection.realmId,
    environment: source.connection.environment,
    generation: source.connection.generation,
  });
}

const summarySelect = {
  id: true, status: true, reviewRevision: true, sourceHash: true, estimateAstHash: true,
  estimateRequestId: true, invoiceRequestId: true, providerEstimateId: true, reviewedAtUtc: true,
} as const satisfies Prisma.QuickBooksTaxEstimateOperationSelect;

/** Private persistence: only the server assembler below constructs and signs input. */
async function persistReviewedTaxEstimate(tx: Transaction, actor: Actor, actorId: string,
  review: ReturnType<typeof createQuickBooksTaxReview>, keyId: string, now: Date) {
    const previous = await tx.quickBooksTaxEstimateOperation.findFirst({ where: {
      tenantId: actor.tenantId, invoiceId: review.source.invoiceId, supersededAtUtc: null,
    } });
    if (previous?.sourceHash === review.sourceHash && previous.estimateAstHash === review.estimateAstHash
      && previous.bindingKeyId === keyId) {
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
      invoiceTaxContextId: review.source.invoiceTaxContext.id, invoiceTaxContextRevision: review.source.invoiceTaxContext.revision,
      invoiceTaxContextInputHash: review.source.invoiceTaxContext.inputHash, connectionGeneration: review.source.connection.generation,
      invoiceVersion: review.source.invoiceVersion, providerRealmId: review.source.connection.realmId,
      connectionGenerationAtUtc: new Date(review.source.connection.connectedAtUtc),
      sourceSnapshot: JSON.parse(review.sourceJson) as Prisma.InputJsonValue,
      estimateAstSnapshot: review.estimateAst as unknown as Prisma.InputJsonValue,
      sourceHash: review.sourceHash, estimateAstHash: review.estimateAstHash,
      reviewBindingDigest: sha256(review.binding), bindingKeyId: keyId,
      estimateRequestId: randomUUID(), invoiceRequestId: randomUUID(), reviewedAtUtc: now,
    }, select: summarySelect });

}

type ContextSeed = Awaited<ReturnType<typeof lockAndReadCurrentInvoiceTaxContext>>;
type ProviderFacts = Awaited<ReturnType<typeof readQuickBooksTaxProviderFacts>>;
function sourceFromContext(seed: ContextSeed, facts: ProviderFacts): TaxReviewSource {
  const { row, source } = seed;
  return {
    contractVersion: 2, tenantId: source.tenantId, invoiceId: source.invoiceId, invoiceVersion: source.invoiceVersion,
    customerId: source.customerId, sourceQuoteId: source.sourceQuoteId, jobId: source.jobId,
    invoiceTaxContext: { id: row.id, revision: row.revision, inputHash: row.inputHash,
      confirmedByTenantUserId: row.confirmedByTenantUserId, confirmedAtUtc: row.confirmedAtUtc.toISOString() },
    transactionDate: source.transactionDate, currency: "USD", subtotal: source.subtotalAmount,
    quotedTax: source.quotedTaxAmount, total: source.totalAmount,
    connection: { id: source.quickBooksConnectionId, realmId: source.providerRealmId,
      environment: row.environment as "sandbox" | "production", connectedAtUtc: source.connectionConnectedAtUtc, generation: source.connectionGeneration },
    customerMapping: { id: source.customerMapId, providerId: source.providerCustomerId,
      reviewedAtUtc: source.customerMapReviewedAtUtc, reviewVersion: source.customerMapReviewVersion },
    customerFacts: { providerCustomerId: facts.customer.providerCustomerId, providerSyncToken: facts.customer.providerSyncToken,
      observedAtUtc: facts.customer.observedAtUtc, exemption: facts.customer.classification,
      exemptionReasonId: null, fingerprint: facts.customer.fingerprint },
    origin: source.origin, destination: source.destination,
    preferences: { observedAtUtc: facts.preferences.observedAtUtc, fingerprint: facts.preferences.fingerprint,
      companyObservedAtUtc: facts.companyInfo.observedAtUtc, companyInfoFingerprint: facts.companyInfo.fingerprint, capabilities: facts.capabilities },
    lines: source.lines.map(line => {
      const fact = facts.items.find(item => item.providerItemId === line.providerItemId);
      if (!fact || fact.classification !== line.taxIntent) reject("QUICKBOOKS_TAX_FACTS_UNSUPPORTED");
      return { invoiceLineItemId: line.invoiceLineItemIdSnapshot, position: line.position, description: line.description,
        quantity: line.quantity, unitPrice: line.unitPrice, amount: line.amount, taxIntent: line.taxIntent,
        itemMapping: { id: line.itemMapId, reviewVersion: line.itemMapReviewVersion, reviewedAtUtc: line.itemMapReviewedAtUtc, providerId: line.providerItemId },
        itemFacts: { providerItemId: fact.providerItemId, providerSyncToken: fact.providerSyncToken, observedAtUtc: fact.observedAtUtc,
          taxClassificationFingerprint: fact.fingerprint } };
    }),
  };
}
const assembleInput = z.strictObject({ invoiceId: z.string().min(1).max(191).regex(/^[A-Za-z0-9_-]+$/),
  expectedContextRevision: z.number().int().min(1).max(2_147_483_647) });
async function setupFence(tx: Transaction, tenantId: string) {
  const row = await tx.quickBooksConnection.findFirstOrThrow({ where: { tenantId },
    select: { setupConfirmedAtUtc: true, setupConfirmedByTenantUserId: true, setupChecklistVersion: true, scopes: true } });
  return JSON.stringify([row.setupConfirmedAtUtc, row.setupConfirmedByTenantUserId, row.setupChecklistVersion, [...row.scopes].sort()]);
}
/**
 * Manager-authorized, provider-GET-only review assembly. Caller supplies no prices,
 * provider identities, addresses, tax facts or signed source. Network I/O occurs
 * strictly between the two short transactions; final authorization/source checks
 * and signing/persistence commit together. This never authorizes publishing.
 */
export async function assembleReviewedTaxEstimate(prisma: PrismaClient, actor: Actor,
  environment: QuickBooksCredentialRuntimeEnv, input: { invoiceId: string; expectedContextRevision: number }) {
  const parsed = assembleInput.safeParse(input);
  if (!parsed.success) reject("QUICKBOOKS_TAX_REVIEW_INPUT_INVALID");
  const command = parsed.data;
  const seed = await withTenantRlsContext(prisma, actor.tenantId, async tx => ({
    ...await lockAndReadCurrentInvoiceTaxContext(tx, actor, environment.QUICKBOOKS_ENVIRONMENT, command.invoiceId, command.expectedContextRevision),
    setupFence: await setupFence(tx, actor.tenantId),
  }), REVIEW_TRANSACTION_OPTIONS);
  const facts = await readQuickBooksTaxProviderFacts(prisma, environment, {
    tenantId: actor.tenantId, connection: { id: seed.row.quickBooksConnectionId, realmId: seed.row.providerRealmId,
      environment: environment.QUICKBOOKS_ENVIRONMENT, connectedAtUtc: seed.row.connectionConnectedAtUtc.toISOString(), generation: seed.row.connectionGeneration },
    providerCustomerId: seed.row.providerCustomerId,
    lines: seed.source.lines.map(line => ({ providerItemId: line.providerItemId, taxIntent: line.taxIntent })),
  });
  if (!facts.providerFactsSupported || facts.blockers.length) reject("QUICKBOOKS_TAX_FACTS_UNSUPPORTED");
  return withTenantRlsContext(prisma, actor.tenantId, async tx => {
    const current = await lockAndReadCurrentInvoiceTaxContext(tx, actor, environment.QUICKBOOKS_ENVIRONMENT, command.invoiceId, command.expectedContextRevision);
    if (current.row.id !== seed.row.id || current.row.inputHash !== seed.row.inputHash
      || await setupFence(tx, actor.tenantId) !== seed.setupFence) reject("QUICKBOOKS_TAX_CONTEXT_CHANGED");
    const source = sourceFromContext(current, facts);
    const now = new Date();
    requireFreshFacts(source, now);
    const key = keyFor(environment.QUICKBOOKS_TOKEN_ENCRYPTION_KEY);
    const review = createQuickBooksTaxReview(source, key.key);
    if (!review.assessment.providerPrerequisitesReady || !review.assessment.reviewSourceReady) reject("QUICKBOOKS_TAX_REVIEW_NOT_READY");
    return { ...await persistReviewedTaxEstimate(tx, actor, current.managerId, review, key.id, now),
      taxCalculationProven: false as const, publishingAuthorized: false as const };
  }, REVIEW_TRANSACTION_OPTIONS);
}

/**
 * Resolve a reviewed operation to its current credential target without
 * consuming an attempt. This returns identifiers only; credential material is
 * acquired separately by the serialized credential service.
 */
export async function readTaxEstimateCredentialTarget(prisma: PrismaClient, actor: Actor,
  environment: QuickBooksCredentialRuntimeEnv, operationId: string) {
  return withTenantRlsContext(prisma, actor.tenantId, async (tx) => {
    await lockManager(tx, actor);
    const operation = await tx.quickBooksTaxEstimateOperation.findFirst({ where: { id: operationId, tenantId: actor.tenantId } });
    if (!operation) return reject("QUICKBOOKS_TAX_OPERATION_NOT_FOUND");
    await lockInvoice(tx, actor.tenantId, operation.invoiceId);
    const current = await tx.quickBooksTaxEstimateOperation.findFirstOrThrow({ where: { id: operation.id, tenantId: actor.tenantId } });
    if (current.status !== "REVIEWED" || current.supersededAtUtc || current.attemptCount !== 0
      || current.attemptTokenHash || current.claimTokenHash || current.claimExpiresAtUtc || current.lastAttemptAtUtc
      || current.providerEstimateId) reject("QUICKBOOKS_TAX_OPERATION_NOT_READY");
    const snapshot = verifiedStoredReview(current, environment);
    await requireCurrentSource(tx, actor, snapshot.source, new Date());
    return freeze({ outcome: "READY" as const, connection: connectionTarget(actor, snapshot.source),
      publishingAuthorized: false as const });
  }, REVIEW_TRANSACTION_OPTIONS);
}

/** A durable internal lease, explicitly not permission to issue a provider write. */
export async function claimReviewedTaxEstimate(prisma: PrismaClient, actor: Actor,
  environment: QuickBooksCredentialRuntimeEnv, operationId: string) {
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
    const snapshot = verifiedStoredReview(current, environment);
    await requireCurrentSource(tx, actor, snapshot.source, now);
    const claimToken = randomBytes(32).toString("base64url");
    const tokenHash = sha256(claimToken);
    const claimExpiresAtUtc = new Date(now.getTime() + CLAIM_MS);
    const updated = await tx.quickBooksTaxEstimateOperation.updateMany({ where: {
      id: current.id, tenantId: actor.tenantId, status: "REVIEWED", attemptCount: 0, supersededAtUtc: null,
    }, data: { status: "ESTIMATE_PROCESSING", claimTokenHash: tokenHash, attemptTokenHash: tokenHash,
      claimExpiresAtUtc, attemptCount: 1, lastAttemptAtUtc: now } });
    if (updated.count !== 1) return { outcome: "NOT_CLAIMED" as const, publishingAuthorized: false as const };
    const attempt = freeze({ tenantId: actor.tenantId, operationId: current.id,
      estimateRequestId: current.estimateRequestId, sourceHash: current.sourceHash, claimToken,
      claimExpiresAtUtc: claimExpiresAtUtc.toISOString() });
    const dispatch = freeze({ attempt, connection: connectionTarget(actor, snapshot.source), estimateAst: snapshot.estimateAst });
    return { outcome: "CLAIMED" as const, operationId: current.id, claimToken,
      estimateRequestId: current.estimateRequestId, invoiceRequestId: current.invoiceRequestId,
      sourceHash: current.sourceHash, dispatch, publishingAuthorized: false as const };
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
