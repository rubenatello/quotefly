import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { setTenantRlsContext } from "../../src/lib/tenant-rls";
import { capabilitiesForRole, type AccessContext } from "../../src/lib/access-policy";
import { claimQuickBooksInvoicePublish, quickBooksInvoiceHasCanonicalReconciliation,
  quickBooksInvoiceLinkAvailable, quickBooksInvoiceReconciliationAvailable,
  quickBooksInvoiceRetryAvailable } from "../../src/services/quickbooks-invoices";
import { reconcileQuickBooksInvoice } from "../../src/services/quickbooks-reconciliation";
import { invalidateQuickBooksHostedPaymentLinks } from "../../src/services/quickbooks-credentials";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "../../src/services/quickbooks-setup";
import {
  assembleReviewedTaxEstimate, claimReviewedTaxEstimate, finalizeTaxEstimateSandboxProof,
  retainTaxEstimateIdentity,
} from "../../src/services/quickbooks-tax-estimate-ledger";
import {
  assertQuickBooksTaxInvoiceCreateFence, claimReviewedQuickBooksTaxInvoice,
  QUICKBOOKS_TAX_INVOICE_RESULT_UNKNOWN, readCanonicalTaxInvoiceCredentialTarget,
  quarantineExpiredQuickBooksTaxInvoiceAttempt,
  recordQuickBooksTaxInvoiceProjectionMatch, retainCreatedQuickBooksTaxInvoiceIdentity,
} from "../../src/services/quickbooks-tax-invoices";
import type { TaxReviewSource } from "../../src/services/quickbooks-tax-review-contract";
import { readQuickBooksTaxProviderFacts } from "../../src/services/quickbooks-tax-provider-facts";
import { confirmInvoiceTaxContext, lockAndReadCurrentInvoiceTaxContext } from "../../src/services/quickbooks-tax-context";
import { contextInput, syntheticFacts, syntheticReview, testRuntime } from "../helpers/tax-review-fixture";

vi.mock("../../src/services/quickbooks-tax-provider-facts", () => ({ readQuickBooksTaxProviderFacts: vi.fn() }));

const keys = { QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "synthetic-tax-invoice-lifecycle-key-for-tests-only" };
const sources = new Map<string, TaxReviewSource>();
const tenantIds: string[] = [];
const userIds: string[] = [];
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const runtimePrisma = new Proxy(prisma, {
  get(target, property) {
    if (property === "$transaction") {
      return <T>(action: (tx: Prisma.TransactionClient) => Promise<T>, options?: {
        maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel;
      }) => target.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
        return action(tx);
      }, options);
    }
    return Reflect.get(target, property);
  },
}) as PrismaClient;

async function fixture() {
  const stamp = randomUUID();
  const observed = new Date();
  const tenant = await prisma.tenant.create({ data: { name: "Tax Invoice lifecycle", slug: stamp } });
  tenantIds.push(tenant.id);
  const user = await prisma.user.create({ data: { email: `${stamp}@example.test`, fullName: "Tax Invoice owner", passwordHash: "synthetic" } });
  userIds.push(user.id);
  const member = await prisma.tenantUser.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" } });
  const customer = await prisma.customer.create({ data: { tenantId: tenant.id, fullName: "Synthetic taxable customer", phone: stamp } });
  const quote = await prisma.quote.create({ data: { tenantId: tenant.id, customerId: customer.id, status: "ACCEPTED", serviceType: "PLUMBING", title: "Synthetic taxable quote", scopeText: "Synthetic", internalCostSubtotal: 10, customerPriceSubtotal: 100, taxAmount: 8, totalAmount: 108 } });
  const job = await prisma.job.create({ data: { tenantId: tenant.id, customerId: customer.id, sourceQuoteId: quote.id, jobNumber: 1, title: "Synthetic taxable job", scopeSnapshot: "Synthetic", serviceType: "PLUMBING", acceptedAtUtc: observed } });
  const invoice = await prisma.invoice.create({ data: { tenantId: tenant.id, customerId: customer.id, sourceQuoteId: quote.id, jobId: job.id, invoiceNumber: 1, titleSnapshot: "Synthetic taxable invoice", subtotalAmount: 100, taxAmount: 8, totalAmount: 108, balanceDue: 108, dueAtUtc: new Date(Date.now() + 86_400_000) } });
  const line = await prisma.invoiceLineItem.create({ data: { tenantId: tenant.id, invoiceId: invoice.id, description: "Synthetic materials", quantity: 2, unitPrice: 50, lineTotal: 100, position: 0 } });
  const connection = await prisma.quickBooksConnection.create({ data: { tenantId: tenant.id, realmId: `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`, environment: "sandbox", status: "CONNECTED", connectedAtUtc: observed, scopes: ["com.intuit.quickbooks.accounting"], setupConfirmedAtUtc: observed, setupConfirmedByTenantUserId: member.id, setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION } });
  await prisma.quickBooksRealmBinding.create({ data: { tenantId: tenant.id, quickBooksConnectionId: connection.id, realmId: connection.realmId, active: true } });
  const customerMap = await prisma.quickBooksCustomerMap.create({ data: { tenantId: tenant.id, quickBooksConnectionId: connection.id, customerId: customer.id, quickBooksCustomerId: "42", reviewVersion: 1, reviewedAtUtc: observed, reviewedByTenantUserId: member.id } });
  const itemMap = await prisma.quickBooksItemMap.create({ data: { tenantId: tenant.id, quickBooksConnectionId: connection.id, itemKey: "synthetic materials", quickBooksItemId: "51", quickBooksItemName: "Synthetic materials", reviewVersion: 1, reviewedAtUtc: observed, reviewedByTenantUserId: member.id } });
  const source: TaxReviewSource = {
    contractVersion: 2, tenantId: tenant.id, invoiceId: invoice.id, invoiceVersion: invoice.version,
    customerId: customer.id, sourceQuoteId: quote.id, jobId: job.id,
    invoiceTaxContext: { id: "pending", revision: 1, inputHash: "d".repeat(64), confirmedByTenantUserId: member.id, confirmedAtUtc: observed.toISOString() },
    transactionDate: observed.toISOString().slice(0, 10), currency: "USD",
    subtotal: "100.00", quotedTax: "8.00", total: "108.00",
    connection: { id: connection.id, realmId: connection.realmId, connectedAtUtc: observed.toISOString(), generation: 1, environment: "sandbox" },
    customerMapping: { id: customerMap.id, reviewVersion: 1, reviewedAtUtc: observed.toISOString(), providerId: "42" },
    customerFacts: { providerCustomerId: "42", providerSyncToken: "0", observedAtUtc: observed.toISOString(), exemption: "TAXABLE", exemptionReasonId: null, fingerprint: "e".repeat(64) },
    origin: { Line1: "123 Synthetic Origin", City: "San Francisco", CountrySubDivisionCode: "CA", PostalCode: "94105", Country: "US" },
    destination: { Line1: "456 Synthetic Destination", City: "Los Angeles", CountrySubDivisionCode: "CA", PostalCode: "90001", Country: "US" },
    preferences: { observedAtUtc: observed.toISOString(), fingerprint: "a".repeat(64), companyInfoFingerprint: "b".repeat(64), companyObservedAtUtc: observed.toISOString(), capabilities: { companyPrerequisitesReady: true, automatedTaxCalculationProven: false, usCompany: true, companyAddressComplete: true, salesTaxEnabled: true, estimatesEnabled: true, usdHomeCurrency: true, progressInvoicingEnabled: false, reasons: [] } },
    lines: [{ invoiceLineItemId: line.id, position: 0, description: "Synthetic materials", quantity: "2.00", unitPrice: "50.00", amount: "100.00", taxIntent: "TAXABLE", itemMapping: { id: itemMap.id, reviewVersion: 1, reviewedAtUtc: observed.toISOString(), providerId: "51" }, itemFacts: { providerItemId: "51", providerSyncToken: "0", observedAtUtc: observed.toISOString(), taxClassificationFingerprint: "c".repeat(64) } }],
  };
  const actor = { tenantId: tenant.id, userId: user.id, authVersion: 0, requestId: randomUUID() };
  return { tenant, user, member, customer, quote, job, invoice, connection, source, actor };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function access(f: Fixture): AccessContext {
  return { tenantId: f.tenant.id, tenantUserId: f.member.id, userId: f.user.id, role: "owner", capabilities: capabilitiesForRole("owner"), requestId: randomUUID() };
}
async function canonicalEstimate(f: Fixture) {
  await confirmInvoiceTaxContext(runtimePrisma, f.actor, "sandbox", contextInput(f.source));
  const context = await prisma.invoiceTaxContext.findFirstOrThrow({ where: { tenantId: f.tenant.id, invoiceId: f.invoice.id, supersededAtUtc: null } });
  f.source.invoiceTaxContext = { id: context.id, revision: context.revision, inputHash: context.inputHash, confirmedByTenantUserId: context.confirmedByTenantUserId, confirmedAtUtc: context.confirmedAtUtc.toISOString() };
  sources.set(f.tenant.id, f.source);
  const row = await assembleReviewedTaxEstimate(runtimePrisma, f.actor, testRuntime(keys), { invoiceId: f.invoice.id, expectedContextRevision: context.revision });
  const claim = await claimReviewedTaxEstimate(runtimePrisma, f.actor, testRuntime(keys), row.id);
  if (claim.outcome !== "CLAIMED") throw new Error("Expected tax Estimate claim");
  const attempt = { tenantId: f.tenant.id, operationId: row.id, estimateRequestId: claim.estimateRequestId, sourceHash: claim.sourceHash, claimToken: claim.claimToken };
  const identity = { providerEstimateId: `estimate-${randomUUID()}`, providerEstimateSyncToken: "0", providerEstimateUpdatedAtUtc: "2026-10-03T20:00:00.000Z" };
  await retainTaxEstimateIdentity(runtimePrisma, attempt, identity);
  const estimate = { Id: identity.providerEstimateId, SyncToken: identity.providerEstimateSyncToken, MetaData: { LastUpdatedTime: identity.providerEstimateUpdatedAtUtc }, ...structuredClone(syntheticReview(f.source, keys).estimateAst), TxnTaxDetail: { TotalTax: 8 }, TotalAmt: 108 };
  await finalizeTaxEstimateSandboxProof(runtimePrisma, testRuntime(keys), attempt, estimate);
  return { row: await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: row.id } }), estimate };
}
async function claimedInvoice(f: Fixture) {
  const canonical = await canonicalEstimate(f);
  const result = await claimReviewedQuickBooksTaxInvoice(runtimePrisma, f.actor, testRuntime(keys), { taxEstimateOperationId: canonical.row.id, idempotencyKey: randomUUID() });
  if (result.outcome !== "CLAIMED") throw new Error("Expected tax Invoice claim");
  return { canonical, result, attempt: { tenantId: f.tenant.id, operationId: result.operation.id, providerRequestId: result.operation.providerRequestId, attemptToken: result.claimToken } };
}
function invoiceProjection(estimate: Record<string, unknown>, providerInvoiceId: string) {
  const { Id: estimateId, SyncToken: _sync, MetaData: _meta, TxnTaxDetail, TotalAmt, ...ast } = estimate;
  return { Id: providerInvoiceId, SyncToken: "0", MetaData: { LastUpdatedTime: "2026-10-03T20:01:00.000Z" }, ...ast, TxnTaxDetail, TotalAmt, LinkedTxn: [{ TxnId: estimateId, TxnType: "Estimate" }] };
}

describe("QuickBooks taxable Invoice lifecycle", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  beforeAll(() => {
    fetchSpy.mockRejectedValue(new Error("Provider calls are forbidden in lifecycle tests"));
    vi.mocked(readQuickBooksTaxProviderFacts).mockImplementation(async (_client, _env, input) => {
      const source = sources.get(input.tenantId);
      if (!source) throw new Error("Missing synthetic provider facts");
      return syntheticFacts(source);
    });
  });
  afterAll(async () => {
    try { expect(fetchSpy).not.toHaveBeenCalled(); } finally {
      fetchSpy.mockRestore();
      await prisma.quickBooksInvoiceOperation.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.quickBooksTaxEstimateOperation.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.invoiceTaxContextLine.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.invoiceTaxContext.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.$disconnect();
    }
  });

  test("claim is single-attempt, parent-bound and idempotent without provider authority", async () => {
    const f = await fixture();
    const canonical = await canonicalEstimate(f);
    const idempotencyKey = randomUUID();
    const [first, second] = await Promise.all([
      claimReviewedQuickBooksTaxInvoice(runtimePrisma, f.actor, testRuntime(keys), { taxEstimateOperationId: canonical.row.id, idempotencyKey }),
      claimReviewedQuickBooksTaxInvoice(runtimePrisma, f.actor, testRuntime(keys), { taxEstimateOperationId: canonical.row.id, idempotencyKey }),
    ]);
    const claimed = first.outcome === "CLAIMED" ? first : second;
    const duplicate = first.outcome === "DUPLICATE" ? first : second;
    expect(claimed).toMatchObject({ outcome: "CLAIMED", publishingAuthorized: false, operation: { attemptCount: 1, providerRequestId: canonical.row.invoiceRequestId, taxEstimateOperationId: canonical.row.id } });
    expect(duplicate).toMatchObject({ outcome: "DUPLICATE", claimToken: null, requestProjection: null, publishingAuthorized: false });
    if (claimed.outcome !== "CLAIMED") throw new Error("Expected claimed result");
    expect(claimed.operation.taxAttemptTokenHash).toBe(sha256(claimed.claimToken));
    expect(await prisma.quickBooksInvoiceOperation.count({ where: { tenantId: f.tenant.id, invoiceId: f.invoice.id } })).toBe(1);
    const stored = await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: claimed.operation.id } });
    expect(quickBooksInvoiceHasCanonicalReconciliation(stored)).toBe(false);
    expect(quickBooksInvoiceLinkAvailable(stored)).toBe(false);
    expect(quickBooksInvoiceReconciliationAvailable(stored)).toBe(false);
    expect(quickBooksInvoiceRetryAvailable(stored)).toBe(false);
    await expect(runtimePrisma.$transaction(tx => claimQuickBooksInvoicePublish(tx, access(f), { invoiceId: f.invoice.id, invoiceVersion: f.invoice.version, idempotencyKey: randomUUID(), reviewBinding: "invalid", reviewSecret: keys.QUICKBOOKS_TOKEN_ENCRYPTION_KEY })))
      .rejects.toMatchObject({ code: "QUICKBOOKS_TAX_INVOICE_WORKFLOW_UNAVAILABLE" });
  });

  test("credential target consumes no attempt and the matching create fence is read-only and deeply frozen", async () => {
    const f = await fixture();
    const canonical = await canonicalEstimate(f);
    const beforeTarget = await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: canonical.row.id } });
    const target = await readCanonicalTaxInvoiceCredentialTarget(runtimePrisma, f.actor, testRuntime(keys), canonical.row.id);
    expect(target).toEqual({ outcome: "READY", taxEstimateOperationId: canonical.row.id,
      connection: { id: f.connection.id, tenantId: f.tenant.id, realmId: f.connection.realmId,
        environment: "sandbox", generation: 1 }, publishingAuthorized: false });
    expect(Object.isFrozen(target)).toBe(true);
    expect(Object.isFrozen(target.connection)).toBe(true);
    expect(await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: canonical.row.id } }))
      .toEqual(beforeTarget);
    expect(await prisma.quickBooksInvoiceOperation.count({ where: { tenantId: f.tenant.id } })).toBe(0);

    const result = await claimReviewedQuickBooksTaxInvoice(runtimePrisma, f.actor, testRuntime(keys), {
      taxEstimateOperationId: canonical.row.id, idempotencyKey: randomUUID(),
    });
    if (result.outcome !== "CLAIMED") throw new Error("Expected tax Invoice claim");
    const operationBefore = await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: result.operation.id } });
    const invoiceBefore = await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoice.id } });
    const fenced = await assertQuickBooksTaxInvoiceCreateFence(runtimePrisma, f.actor, testRuntime(keys), {
      ...result.dispatch.attempt,
    });
    expect(fenced).toMatchObject({ outcome: "FENCED", providerCreateFencePassed: true,
      publishingAuthorized: false, dispatch: { attempt: result.dispatch.attempt,
        connection: target.connection, requestProjection: result.requestProjection } });
    expect(Object.isFrozen(fenced)).toBe(true);
    expect(Object.isFrozen(fenced.dispatch)).toBe(true);
    expect(Object.isFrozen(fenced.dispatch.requestProjection)).toBe(true);
    expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: result.operation.id } }))
      .toEqual(operationBefore);
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoice.id } })).toEqual(invoiceBefore);
    await expect(readCanonicalTaxInvoiceCredentialTarget(runtimePrisma, f.actor, testRuntime(keys), canonical.row.id))
      .rejects.toMatchObject({ code: "QUICKBOOKS_TAX_INVOICE_OPERATION_EXISTS" });
  });

  test("create fence rejects tenant, attempt, hash and lease mismatches without authorizing or mutating", async () => {
    const f = await fixture(); const { result } = await claimedInvoice(f);
    const foreign = await fixture();
    const before = await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: result.operation.id } });
    const fence = { ...result.dispatch.attempt };
    await expect(assertQuickBooksTaxInvoiceCreateFence(runtimePrisma, foreign.actor, testRuntime(keys), fence))
      .rejects.toMatchObject({ code: "QUICKBOOKS_TAX_INVOICE_ATTEMPT_INVALID" });
    await expect(assertQuickBooksTaxInvoiceCreateFence(runtimePrisma, f.actor, testRuntime(keys), {
      ...fence, attemptToken: "0".repeat(64),
    })).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_INVOICE_ATTEMPT_INVALID" });
    await expect(assertQuickBooksTaxInvoiceCreateFence(runtimePrisma, f.actor, testRuntime(keys), {
      ...fence, payloadHash: "0".repeat(64),
    })).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_INVOICE_OPERATION_STALE" });
    await expect(assertQuickBooksTaxInvoiceCreateFence(runtimePrisma, f.actor, {
      ...testRuntime(keys), QUICKBOOKS_ENVIRONMENT: "production",
    }, fence)).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_ENVIRONMENT_MISMATCH" });
    expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: result.operation.id } }))
      .toEqual(before);

    const expiredAt = new Date(result.operation.processingStartedAtUtc!.getTime() + 1);
    await prisma.quickBooksInvoiceOperation.update({ where: { id: result.operation.id },
      data: { claimExpiresAtUtc: expiredAt } });
    await expect(assertQuickBooksTaxInvoiceCreateFence(runtimePrisma, f.actor, testRuntime(keys), {
      ...fence, claimExpiresAtUtc: expiredAt.toISOString(),
    })).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_INVOICE_OPERATION_STALE" });
    expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: result.operation.id } }))
      .toMatchObject({ status: "PROCESSING", attemptCount: 1, providerInvoiceId: null });
  });

  test("create fence rechecks live authority, source, mapping and connection generation", async () => {
    const cases: Array<{ name: string; mutate: (f: Fixture) => Promise<unknown> }> = [
      { name: "manager role", mutate: f => prisma.tenantUser.update({ where: { id: f.member.id }, data: { role: "viewer" } }) },
      { name: "auth version", mutate: f => prisma.user.update({ where: { id: f.user.id }, data: { authVersion: { increment: 1 } } }) },
      { name: "invoice source", mutate: f => prisma.invoice.update({ where: { id: f.invoice.id }, data: { version: { increment: 1 } } }) },
      { name: "mapping", mutate: f => prisma.quickBooksItemMap.update({ where: { id: f.source.lines[0].itemMapping.id }, data: { reviewVersion: { increment: 1 } } }) },
      { name: "connection generation", mutate: f => prisma.quickBooksConnectionEvent.create({ data: {
        tenantId: f.tenant.id, quickBooksConnectionId: f.connection.id, actorTenantUserId: f.member.id,
        requestId: randomUUID(), action: "RECONNECTED", outcome: "SUCCEEDED", connectionGeneration: 2,
      } }) },
    ];
    for (const entry of cases) {
      const f = await fixture(); const { result } = await claimedInvoice(f);
      const operationBefore = await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: result.operation.id } });
      await entry.mutate(f);
      await expect(assertQuickBooksTaxInvoiceCreateFence(runtimePrisma, f.actor, testRuntime(keys), {
        ...result.dispatch.attempt,
      }), entry.name).rejects.toMatchObject({ code: expect.stringMatching(/^QUICKBOOKS_TAX_/) });
      expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: result.operation.id } }), entry.name)
        .toEqual(operationBefore);
    }
  });

  test("concurrent repeated expired claims reconcile the original attempt without replacement", async () => {
    const f = await fixture(); const canonical = await canonicalEstimate(f); const idempotencyKey = randomUUID();
    const claimed = await claimReviewedQuickBooksTaxInvoice(runtimePrisma, f.actor, testRuntime(keys), {
      taxEstimateOperationId: canonical.row.id, idempotencyKey,
    });
    if (claimed.outcome !== "CLAIMED") throw new Error("Expected tax Invoice claim");
    await prisma.quickBooksInvoiceOperation.update({ where: { id: claimed.operation.id },
      data: { claimExpiresAtUtc: new Date(claimed.operation.processingStartedAtUtc!.getTime() + 1) } });
    const repeated = await Promise.all([
      claimReviewedQuickBooksTaxInvoice(runtimePrisma, f.actor, testRuntime(keys), {
        taxEstimateOperationId: canonical.row.id, idempotencyKey,
      }),
      claimReviewedQuickBooksTaxInvoice(runtimePrisma, f.actor, testRuntime(keys), {
        taxEstimateOperationId: canonical.row.id, idempotencyKey,
      }),
    ]);
    expect(repeated).toHaveLength(2);
    for (const result of repeated) {
      expect(result).toMatchObject({ outcome: "DUPLICATE", claimToken: null,
        requestProjection: null, dispatch: null, publishingAuthorized: false,
        operation: { id: claimed.operation.id, status: "RECONCILIATION_REQUIRED", attemptCount: 1,
          providerInvoiceId: null, claimTokenHash: null, claimExpiresAtUtc: null,
          lastFailureCode: QUICKBOOKS_TAX_INVOICE_RESULT_UNKNOWN } });
    }
    expect(await prisma.quickBooksInvoiceOperation.count({ where: { tenantId: f.tenant.id, invoiceId: f.invoice.id } })).toBe(1);
    expect(await prisma.invoiceEvent.count({ where: { tenantId: f.tenant.id, invoiceId: f.invoice.id,
      type: "PROVIDER_RECONCILIATION_REQUIRED" } })).toBe(1);
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoice.id } }))
      .toMatchObject({ status: "DRAFT", version: f.invoice.version });
  });

  test("expired recovery survives authority, source and generation drift and audits once", async () => {
    const f = await fixture(); const { canonical, result, attempt } = await claimedInvoice(f);
    await prisma.quickBooksInvoiceOperation.update({ where: { id: result.operation.id },
      data: { claimExpiresAtUtc: new Date(result.operation.processingStartedAtUtc!.getTime() + 1) } });
    await prisma.tenantUser.update({ where: { id: f.member.id }, data: { role: "viewer" } });
    await prisma.user.update({ where: { id: f.user.id }, data: { authVersion: { increment: 1 } } });
    await prisma.invoice.update({ where: { id: f.invoice.id }, data: { version: { increment: 1 } } });
    await prisma.quickBooksConnectionEvent.create({ data: {
      tenantId: f.tenant.id, quickBooksConnectionId: f.connection.id, actorTenantUserId: f.member.id,
      requestId: randomUUID(), action: "RECONNECTED", outcome: "SUCCEEDED", connectionGeneration: 2,
    } });
    await prisma.quickBooksTaxEstimateOperation.update({ where: { id: canonical.row.id },
      data: { status: "SUPERSEDED", supersededAtUtc: new Date() } });
    const invoiceBefore = await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoice.id } });
    const parentBefore = await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: canonical.row.id } });
    const input = { tenantId: f.tenant.id, operationId: result.operation.id };
    const recovered = await Promise.all([
      quarantineExpiredQuickBooksTaxInvoiceAttempt(runtimePrisma, input),
      quarantineExpiredQuickBooksTaxInvoiceAttempt(runtimePrisma, input),
    ]);
    expect(recovered.map(value => value.outcome).sort()).toEqual(["QUARANTINED", "UNCHANGED"]);
    for (const value of recovered) {
      expect(value).toMatchObject({ publishingAuthorized: false, operation: {
        id: result.operation.id, status: "RECONCILIATION_REQUIRED", attemptCount: 1,
        providerRequestId: result.operation.providerRequestId, payloadHash: result.operation.payloadHash,
        taxAttemptTokenHash: result.operation.taxAttemptTokenHash, providerInvoiceId: null,
        claimTokenHash: null, claimExpiresAtUtc: null, lastFailureCode: QUICKBOOKS_TAX_INVOICE_RESULT_UNKNOWN,
      } });
    }
    const events = await prisma.invoiceEvent.findMany({ where: { tenantId: f.tenant.id,
      invoiceId: f.invoice.id, type: "PROVIDER_RECONCILIATION_REQUIRED" } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorTenantUserId: null,
      requestId: "quickbooks-tax-invoice-expired-attempt" });
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoice.id } })).toEqual(invoiceBefore);
    expect(await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: canonical.row.id } }))
      .toEqual(parentBefore);
    expect(await prisma.quickBooksInvoiceOperation.count({ where: { tenantId: f.tenant.id } })).toBe(1);
    await retainCreatedQuickBooksTaxInvoiceIdentity(runtimePrisma, { ...attempt,
      providerInvoiceId: "late-after-expired-recovery" });
    const retained = await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: result.operation.id } });
    expect(await quarantineExpiredQuickBooksTaxInvoiceAttempt(runtimePrisma, input))
      .toMatchObject({ outcome: "UNCHANGED", operation: { providerInvoiceId: "late-after-expired-recovery",
        lastFailureCode: "QUICKBOOKS_TAX_INVOICE_IDENTITY_RETAINED" }, publishingAuthorized: false });
    expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: result.operation.id } }))
      .toEqual(retained);
  });

  test("expired recovery cannot shorten a live lease or cross a tenant boundary", async () => {
    const f = await fixture(); const { result } = await claimedInvoice(f);
    const foreign = await fixture();
    const before = await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: result.operation.id } });
    const input = { tenantId: f.tenant.id, operationId: result.operation.id };
    expect(await quarantineExpiredQuickBooksTaxInvoiceAttempt(runtimePrisma, input))
      .toMatchObject({ outcome: "UNCHANGED", publishingAuthorized: false });
    await expect(quarantineExpiredQuickBooksTaxInvoiceAttempt(runtimePrisma, {
      ...input, now: new Date(Date.now() + 300_000),
    })).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_INVOICE_INPUT_INVALID" });
    await expect(quarantineExpiredQuickBooksTaxInvoiceAttempt(runtimePrisma, {
      ...input, tenantId: foreign.tenant.id,
    })).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_INVOICE_OPERATION_NOT_FOUND" });
    expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: result.operation.id } }))
      .toEqual(before);
    expect(await prisma.invoiceEvent.count({ where: { tenantId: f.tenant.id, invoiceId: f.invoice.id,
      type: "PROVIDER_RECONCILIATION_REQUIRED" } })).toBe(0);
  });

  test("expired recovery racing late identity retention cannot lose the provider identity", async () => {
    const f = await fixture(); const { result, attempt } = await claimedInvoice(f);
    await prisma.quickBooksInvoiceOperation.update({ where: { id: result.operation.id },
      data: { claimExpiresAtUtc: new Date(result.operation.processingStartedAtUtc!.getTime() + 1) } });
    await Promise.all([
      quarantineExpiredQuickBooksTaxInvoiceAttempt(runtimePrisma, { tenantId: f.tenant.id,
        operationId: result.operation.id }),
      retainCreatedQuickBooksTaxInvoiceIdentity(runtimePrisma, { ...attempt,
        providerInvoiceId: "late-racing-expired-recovery" }),
    ]);
    expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: result.operation.id } }))
      .toMatchObject({ providerInvoiceId: "late-racing-expired-recovery", status: "RECONCILIATION_REQUIRED",
        taxAttemptTokenHash: result.operation.taxAttemptTokenHash, attemptCount: 1,
        lastFailureCode: "QUICKBOOKS_TAX_INVOICE_IDENTITY_RETAINED", claimTokenHash: null,
        claimExpiresAtUtc: null });
    expect(await prisma.invoiceEvent.count({ where: { tenantId: f.tenant.id, invoiceId: f.invoice.id,
      type: "PROVIDER_RECONCILIATION_REQUIRED" } })).toBeLessThanOrEqual(1);
  });

  test("late provider identity is retained and quarantined after all current authority becomes stale", async () => {
    const f = await fixture(); const { canonical, result, attempt } = await claimedInvoice(f);
    await prisma.tenantUser.update({ where: { id: f.member.id }, data: { role: "viewer" } });
    await prisma.user.update({ where: { id: f.user.id }, data: { authVersion: { increment: 1 } } });
    await prisma.quickBooksConnection.update({ where: { id: f.connection.id }, data: {
      status: "DISCONNECTED", disconnectRequestedAtUtc: new Date(), disconnectedAtUtc: new Date(),
    } });
    await prisma.quickBooksTaxEstimateOperation.update({ where: { id: canonical.row.id }, data: { status: "SUPERSEDED", supersededAtUtc: new Date() } });
    const retained = await retainCreatedQuickBooksTaxInvoiceIdentity(runtimePrisma, { ...attempt, providerInvoiceId: "invoice-late-retained" });
    expect(retained).toMatchObject({ outcome: "RETAINED", canContinue: false, providerContinuationAuthorized: false,
      publishingAuthorized: false, operation: { status: "RECONCILIATION_REQUIRED", providerInvoiceId: "invoice-late-retained", lastFailureCode: "QUICKBOOKS_TAX_INVOICE_IDENTITY_RETAINED" } });
    const originalAttemptHash = result.operation.taxAttemptTokenHash;
    await prisma.$transaction(tx => invalidateQuickBooksHostedPaymentLinks(tx, f.tenant.id, f.connection.id));
    expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: result.operation.id } }))
      .toMatchObject({ providerInvoiceId: "invoice-late-retained", taxAttemptTokenHash: originalAttemptHash,
        status: "RECONCILIATION_REQUIRED", lastFailureCode: "QUICKBOOKS_CONNECTION_REAUTH_RECONCILIATION_REQUIRED" });
    const credential = vi.fn(async () => "never");
    await expect(reconcileQuickBooksInvoice({ prisma: runtimePrisma, runtimeEnv: testRuntime(keys) as unknown as Parameters<typeof reconcileQuickBooksInvoice>[0]["runtimeEnv"], tenantId: f.tenant.id, invoiceId: f.invoice.id, trigger: "manual", getAccessToken: credential }))
      .rejects.toMatchObject({ code: "QUICKBOOKS_TAX_INVOICE_WORKFLOW_UNAVAILABLE" });
    expect(credential).not.toHaveBeenCalled();
  });

  test("exact projection evidence records once while mismatch quarantines without changing the local Invoice", async () => {
    const f = await fixture(); const { canonical, result, attempt } = await claimedInvoice(f);
    const providerInvoiceId = `invoice-${randomUUID()}`;
    await retainCreatedQuickBooksTaxInvoiceIdentity(runtimePrisma, { ...attempt, providerInvoiceId });
    const before = await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoice.id } });
    const mismatch = invoiceProjection(canonical.estimate, providerInvoiceId);
    mismatch.TotalAmt = 109;
    expect(await recordQuickBooksTaxInvoiceProjectionMatch(runtimePrisma, f.actor, testRuntime(keys), { ...attempt, providerInvoiceId, canonicalEstimate: canonical.estimate, canonicalInvoice: mismatch }))
      .toMatchObject({ outcome: "QUARANTINED", failureCode: "QUICKBOOKS_TAX_INVOICE_PROJECTION_MISMATCH", publishingAuthorized: false });
    const exact = invoiceProjection(canonical.estimate, providerInvoiceId);
    const recorded = await recordQuickBooksTaxInvoiceProjectionMatch(runtimePrisma, f.actor, testRuntime(keys), { ...attempt, providerInvoiceId, canonicalEstimate: canonical.estimate, canonicalInvoice: exact });
    expect(recorded).toMatchObject({ outcome: "RECORDED", projectionMatches: true, estimateInvoiceParityProven: false, publishingAuthorized: false, operation: { status: "RECONCILIATION_REQUIRED", taxParityContractVersion: 1, lastFailureCode: "QUICKBOOKS_TAX_PROJECTION_REQUIRES_TRUSTED_PROVENANCE" } });
    expect(await recordQuickBooksTaxInvoiceProjectionMatch(runtimePrisma, f.actor, testRuntime(keys), { ...attempt, providerInvoiceId, canonicalEstimate: canonical.estimate, canonicalInvoice: structuredClone(exact) }))
      .toMatchObject({ outcome: "ALREADY_RECORDED", projectionMatches: true, publishingAuthorized: false });
    const operationBeforeRepeat = await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: result.operation.id } });
    expect(await retainCreatedQuickBooksTaxInvoiceIdentity(runtimePrisma, { ...attempt, providerInvoiceId }))
      .toMatchObject({ outcome: "ALREADY_RETAINED", operation: recorded.operation,
        canContinue: false, providerContinuationAuthorized: false, publishingAuthorized: false });
    expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: result.operation.id } }))
      .toEqual(operationBeforeRepeat);
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: f.invoice.id } })).toEqual(before);
    await expect(prisma.quickBooksInvoiceOperation.update({ where: { id: result.operation.id }, data: { taxCanonicalInvoiceHash: "f".repeat(64) } }))
      .rejects.toThrow(/write-once/);
  });

  test("malformed provider identities cannot mutate retention or projection evidence", async () => {
    const f = await fixture(); const { canonical, result, attempt } = await claimedInvoice(f);
    const before = await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: result.operation.id } });
    const invalidIds = ["", " ", "invoice 1", "invoice\n1", "invoice\t1", "invoice\u00001", "invoice\u200b1",
      ".", "..", "invoice/1", "invoice\\1", "invoice?1", "invoice#1", "https://example.test/invoice/1", "a".repeat(192)];
    for (const providerInvoiceId of invalidIds) {
      await expect(retainCreatedQuickBooksTaxInvoiceIdentity(runtimePrisma, { ...attempt, providerInvoiceId }))
        .rejects.toMatchObject({ code: "QUICKBOOKS_TAX_INVOICE_INPUT_INVALID" });
      await expect(recordQuickBooksTaxInvoiceProjectionMatch(runtimePrisma, f.actor, testRuntime(keys), {
        ...attempt, providerInvoiceId, canonicalEstimate: canonical.estimate,
        canonicalInvoice: invoiceProjection(canonical.estimate, providerInvoiceId),
      })).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_INVOICE_INPUT_INVALID" });
    }
    expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: result.operation.id } })).toEqual(before);
    expect(await retainCreatedQuickBooksTaxInvoiceIdentity(runtimePrisma, { ...attempt, providerInvoiceId: "12345_QBO-invoice" }))
      .toMatchObject({ outcome: "RETAINED", publishingAuthorized: false });
  });

  test("database invariants force RLS, deny runtime deletion and reject partial proof tuples", async () => {
    const f = await fixture(); const { result } = await claimedInvoice(f);
    const flags = await prisma.$queryRaw<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='public."QuickBooksInvoiceOperation"'::regclass`;
    expect(flags).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const privileges = await prisma.$queryRaw<Array<{ can_delete: boolean; public_execute: boolean }>>`
      SELECT has_table_privilege('quotefly_runtime','public."QuickBooksInvoiceOperation"','DELETE') AS can_delete,
        has_function_privilege('public','public.quotefly_tax_invoice_operation_immutable()','EXECUTE') AS public_execute`;
    expect(privileges).toEqual([{ can_delete: false, public_execute: false }]);
    await expect(prisma.quickBooksInvoiceOperation.update({ where: { id: result.operation.id }, data: { taxCanonicalInvoiceHash: "a".repeat(64), taxProjectionMatchedAtUtc: new Date() } }))
      .rejects.toThrow(/QbInvoiceOperation_tax_mode_check/);
    expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: result.operation.id } }))
      .toMatchObject({ taxCanonicalInvoiceHash: null, taxProjectionMatchedAtUtc: null, taxParityContractVersion: null });
  });

  test("exact lifecycle seam rejects wrong identities and stale local source", async () => {
    const f = await fixture(); const { canonical, result } = await claimedInvoice(f);
    await expect(runtimePrisma.$transaction(tx => lockAndReadCurrentInvoiceTaxContext(tx, f.actor, "sandbox",
      f.invoice.id, f.source.invoiceTaxContext.revision, {
        expectedTaxEstimateOperationId: canonical.row.id, allowedInvoiceOperationId: randomUUID(),
      }))).rejects.toMatchObject({ code: expect.stringMatching(/^QUICKBOOKS_TAX_/) });
    await expect(runtimePrisma.$transaction(tx => lockAndReadCurrentInvoiceTaxContext(tx, f.actor, "sandbox",
      f.invoice.id, f.source.invoiceTaxContext.revision, {
        expectedTaxEstimateOperationId: randomUUID(), allowedInvoiceOperationId: result.operation.id,
      }))).rejects.toMatchObject({ code: expect.stringMatching(/^QUICKBOOKS_TAX_/) });
    await prisma.invoice.update({ where: { id: f.invoice.id }, data: { version: { increment: 1 } } });
    await expect(recordQuickBooksTaxInvoiceProjectionMatch(runtimePrisma, f.actor, testRuntime(keys), {
      tenantId: f.tenant.id, operationId: result.operation.id, providerRequestId: result.operation.providerRequestId,
      attemptToken: result.claimToken, providerInvoiceId: "never", canonicalEstimate: canonical.estimate,
      canonicalInvoice: invoiceProjection(canonical.estimate, "never"),
    })).rejects.toMatchObject({ code: expect.stringMatching(/^QUICKBOOKS_TAX_/) });
  });

  test("provider identity uniqueness failure is fixed and preserves both operations", async () => {
    const f = await fixture(); const { result, attempt } = await claimedInvoice(f);
    const quote = await prisma.quote.create({ data: { tenantId: f.tenant.id, customerId: f.customer.id,
      status: "ACCEPTED", serviceType: "PLUMBING", title: "Collision quote", scopeText: "Synthetic",
      internalCostSubtotal: 1, customerPriceSubtotal: 1, taxAmount: 0, totalAmount: 1 } });
    const job = await prisma.job.create({ data: { tenantId: f.tenant.id, customerId: f.customer.id,
      sourceQuoteId: quote.id, jobNumber: 2, title: "Collision job", scopeSnapshot: "Synthetic",
      serviceType: "PLUMBING", acceptedAtUtc: new Date() } });
    const invoice = await prisma.invoice.create({ data: { tenantId: f.tenant.id, customerId: f.customer.id,
      sourceQuoteId: quote.id, jobId: job.id, invoiceNumber: 2, titleSnapshot: "Collision invoice",
      subtotalAmount: 1, taxAmount: 0, totalAmount: 1, balanceDue: 1 } });
    const now = new Date();
    const competing = await prisma.quickBooksInvoiceOperation.create({ data: { tenantId: f.tenant.id,
      invoiceId: invoice.id, quickBooksConnectionId: f.connection.id, requestedByTenantUserId: f.member.id,
      status: "RECONCILIATION_REQUIRED", commandKeyHash: sha256(randomUUID()), payloadHash: sha256(randomUUID()),
      providerRealmId: f.connection.realmId, providerRequestId: randomUUID(), providerInvoiceId: "invoice-collision",
      providerDocNumber: "QF-000002", attemptCount: 1, reconciliationCount: 0,
      processingStartedAtUtc: now, lastAttemptAtUtc: now, failedAtUtc: now,
      lastFailureCode: "QUICKBOOKS_CREATED_IDENTITY_RETAINED" } });
    await expect(retainCreatedQuickBooksTaxInvoiceIdentity(runtimePrisma, { ...attempt,
      providerInvoiceId: "invoice-collision" })).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_INVOICE_PROVIDER_ID_CONFLICT" });
    expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: result.operation.id } }))
      .toMatchObject({ providerInvoiceId: null, taxAttemptTokenHash: result.operation.taxAttemptTokenHash });
    expect(await prisma.quickBooksInvoiceOperation.findUniqueOrThrow({ where: { id: competing.id } }))
      .toMatchObject({ providerInvoiceId: "invoice-collision" });
  });

  test("tenant RLS, composite parent binding and immutable tax mode reject foreign or forged lifecycle access", async () => {
    const owner = await fixture(); const owned = await claimedInvoice(owner);
    const foreign = await fixture();
    const parentTenant = await fixture(); const unrelatedParent = await canonicalEstimate(parentTenant);
    await expect(claimReviewedQuickBooksTaxInvoice(runtimePrisma, foreign.actor, testRuntime(keys), {
      taxEstimateOperationId: owned.canonical.row.id, idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_OPERATION_NOT_FOUND" });
    await expect(readCanonicalTaxInvoiceCredentialTarget(runtimePrisma, foreign.actor, testRuntime(keys),
      owned.canonical.row.id)).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_OPERATION_NOT_FOUND" });
    await expect(retainCreatedQuickBooksTaxInvoiceIdentity(runtimePrisma, {
      ...owned.attempt, tenantId: foreign.tenant.id, providerInvoiceId: "foreign-denied",
    })).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_INVOICE_OPERATION_NOT_FOUND" });
    const hidden = await runtimePrisma.$transaction(async tx => {
      await setTenantRlsContext(tx, foreign.tenant.id);
      return tx.quickBooksInvoiceOperation.findUnique({ where: { id: owned.result.operation.id } });
    });
    expect(hidden).toBeNull();
    await expect(retainCreatedQuickBooksTaxInvoiceIdentity(runtimePrisma, {
      ...owned.attempt, attemptToken: "0".repeat(64), providerInvoiceId: "wrong-token-denied",
    })).rejects.toMatchObject({ code: "QUICKBOOKS_TAX_INVOICE_ATTEMPT_INVALID" });

    const now = new Date(); const attemptHash = "a".repeat(64);
    await expect(runtimePrisma.$transaction(async tx => {
      await setTenantRlsContext(tx, foreign.tenant.id);
      return tx.quickBooksInvoiceOperation.create({ data: {
        tenantId: foreign.tenant.id, invoiceId: foreign.invoice.id,
        quickBooksConnectionId: foreign.connection.id, requestedByTenantUserId: foreign.member.id,
        status: "PROCESSING", commandKeyHash: sha256(randomUUID()), payloadHash: sha256(randomUUID()),
        providerRealmId: foreign.connection.realmId, claimTokenHash: attemptHash,
        providerRequestId: unrelatedParent.row.invoiceRequestId, providerDocNumber: "QF-009999",
        attemptCount: 1, reconciliationCount: 0, processingStartedAtUtc: now,
        claimExpiresAtUtc: new Date(now.getTime() + 60_000), lastAttemptAtUtc: now,
        taxEstimateOperationId: unrelatedParent.row.id, taxAttemptTokenHash: attemptHash,
      } });
    })).rejects.toThrow(/QbInvoiceOperation_tax_estimate_binding_fkey|foreign key constraint/i);

    await expect(prisma.quickBooksInvoiceOperation.update({ where: { id: owned.result.operation.id },
      data: { status: "SUCCEEDED", succeededAtUtc: new Date() } }))
      .rejects.toThrow(/QbInvoiceOperation_tax_mode_check/);
    await expect(prisma.quickBooksInvoiceOperation.update({ where: { id: owned.result.operation.id },
      data: { taxEstimateOperationId: null } }))
      .rejects.toThrow(/mode binding is immutable/);
  });
});
