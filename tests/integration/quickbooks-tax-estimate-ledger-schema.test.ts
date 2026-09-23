import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, test } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { FORCED_TENANT_RLS_TABLES, withTenantRlsContext } from "../../src/lib/tenant-rls";

const tenantIds: string[] = [];
const userIds: string[] = [];
const hash = "a".repeat(64);
const otherHash = "b".repeat(64);
const uncertaintyCode = "QUICKBOOKS_ESTIMATE_RECONCILIATION_REQUIRED";

async function fixture() {
  const stamp = randomUUID();
  const tenant = await prisma.tenant.create({ data: { name: "Tax schema fixture", slug: stamp } });
  tenantIds.push(tenant.id);
  const user = await prisma.user.create({ data: { email: `${stamp}@example.test`, fullName: "Schema owner", passwordHash: "synthetic" } });
  userIds.push(user.id);
  const actor = await prisma.tenantUser.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" } });
  const customer = await prisma.customer.create({ data: { tenantId: tenant.id, fullName: "Synthetic tax customer", phone: stamp } });
  const connection = await prisma.quickBooksConnection.create({ data: { tenantId: tenant.id, realmId: stamp, environment: "sandbox" } });
  const f = { tenant, user, actor, customer, connection };
  return { ...f, ...await invoiceFixture(f, 1) };
}

async function invoiceFixture(f: { tenant: { id: string }; customer: { id: string } }, invoiceNumber: number) {
  const quote = await prisma.quote.create({ data: { tenantId: f.tenant.id, customerId: f.customer.id, serviceType: "PLUMBING", title: "Tax schema quote", scopeText: "Synthetic", internalCostSubtotal: 10, customerPriceSubtotal: 100, taxAmount: 8, totalAmount: 108 } });
  const job = await prisma.job.create({ data: { tenantId: f.tenant.id, customerId: f.customer.id, sourceQuoteId: quote.id, jobNumber: invoiceNumber, title: "Tax schema job", scopeSnapshot: "Synthetic", serviceType: "PLUMBING", acceptedAtUtc: new Date() } });
  const invoice = await prisma.invoice.create({ data: { tenantId: f.tenant.id, customerId: f.customer.id, sourceQuoteId: quote.id, jobId: job.id, invoiceNumber, titleSnapshot: "Tax schema invoice", subtotalAmount: 100, taxAmount: 8, totalAmount: 108, balanceDue: 108 } });
  return { quote, job, invoice };
}

function reviewed(f: Awaited<ReturnType<typeof fixture>>, override: Partial<Prisma.QuickBooksTaxEstimateOperationUncheckedCreateInput> = {}): Prisma.QuickBooksTaxEstimateOperationUncheckedCreateInput {
  return { tenantId: f.tenant.id, invoiceId: f.invoice.id, customerId: f.customer.id, sourceQuoteId: f.quote.id, quickBooksConnectionId: f.connection.id, requestedByTenantUserId: f.actor.id, reviewedByTenantUserId: f.actor.id, providerRealmId: f.connection.realmId, reviewRevision: 1, contractVersion: 1, invoiceVersion: 1, connectionGenerationAtUtc: f.connection.connectedAtUtc, sourceSnapshot: { currency: "USD", total: "108.00" }, estimateAstSnapshot: { Line: [] }, sourceHash: hash, estimateAstHash: hash, reviewBindingDigest: hash, bindingKeyId: "tax-test-v1", estimateRequestId: `estimate-${randomUUID()}`, invoiceRequestId: `invoice-${randomUUID()}`, reviewedAtUtc: new Date(), ...override };
}

function runtime<T>(tenantId: string | null, action: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
    return tenantId ? withTenantRlsContext(tx, tenantId, action) : action(tx);
  });
}

function processing(): Prisma.QuickBooksTaxEstimateOperationUpdateInput {
  const now = new Date();
  return { status: "ESTIMATE_PROCESSING", attemptCount: 1, attemptTokenHash: hash, claimTokenHash: hash, lastAttemptAtUtc: now, claimExpiresAtUtc: new Date(now.getTime() + 60_000) };
}

function attemptEvidence() {
  return { attemptCount: 1, attemptTokenHash: hash, lastAttemptAtUtc: new Date() };
}

function canonical(): Prisma.QuickBooksTaxEstimateOperationUpdateInput {
  return { ...attemptEvidence(), status: "ESTIMATE_CANONICAL", providerEstimateId: `provider-${randomUUID()}`, providerEstimateSyncToken: "0", providerEstimateUpdatedAtUtc: new Date(), canonicalEstimateHash: hash, providerSubtotal: "100.00", providerTax: "8.00", providerTotal: "108.00", canonicalAtUtc: new Date() };
}

describe("QuickBooks tax Estimate restricted ledger schema", () => {
  afterAll(async () => {
    // Only this file's synthetic fixtures, using the guarded test migration role.
    await prisma.quickBooksTaxEstimateOperation.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  test("forces RLS and grants runtime only the explicit mutable columns", async () => {
    expect(FORCED_TENANT_RLS_TABLES).toContain("QuickBooksTaxEstimateOperation");
    const rows = await prisma.$queryRaw<Array<{ enabled: boolean; forced: boolean; tableUpdate: boolean; remove: boolean; truncate: boolean }>>`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced,
        has_table_privilege('quotefly_runtime', oid, 'UPDATE') AS "tableUpdate",
        has_table_privilege('quotefly_runtime', oid, 'DELETE') AS remove,
        has_table_privilege('quotefly_runtime', oid, 'TRUNCATE') AS truncate
      FROM pg_class WHERE relname = 'QuickBooksTaxEstimateOperation'`;
    expect(rows).toEqual([{ enabled: true, forced: true, tableUpdate: false, remove: false, truncate: false }]);
    const columns = await prisma.$queryRaw<Array<{ name: string }>>`
      SELECT attname AS name FROM pg_attribute
      WHERE attrelid = '"QuickBooksTaxEstimateOperation"'::regclass AND attnum > 0 AND NOT attisdropped
        AND has_column_privilege('quotefly_runtime', attrelid, attname, 'UPDATE') ORDER BY attname`;
    expect(columns.map((column) => column.name)).toEqual([
      "attemptCount", "attemptTokenHash", "canonicalAtUtc", "canonicalEstimateHash", "claimExpiresAtUtc", "claimTokenHash", "failedAtUtc", "lastAttemptAtUtc", "lastFailureCode", "providerEstimateId", "providerEstimateSyncToken", "providerEstimateUpdatedAtUtc", "providerSubtotal", "providerTax", "providerTotal", "status", "supersededAtUtc", "uncertainAtUtc", "updatedAt",
    ]);
  });

  test("runtime reads and inserts fail closed without the matching tenant context", async () => {
    const a = await fixture(); const b = await fixture();
    const row = await runtime(a.tenant.id, (tx) => tx.quickBooksTaxEstimateOperation.create({ data: reviewed(a) }));
    expect(await runtime(null, (tx) => tx.quickBooksTaxEstimateOperation.findMany())).toEqual([]);
    expect(await runtime(b.tenant.id, (tx) => tx.quickBooksTaxEstimateOperation.findUnique({ where: { id: row.id } }))).toBeNull();
    expect(await runtime(a.tenant.id, (tx) => tx.quickBooksTaxEstimateOperation.findUnique({ where: { id: row.id } }))).toMatchObject({ id: row.id });
    await expect(runtime(null, (tx) => tx.quickBooksTaxEstimateOperation.create({ data: reviewed(b) }))).rejects.toThrow();
    await expect(runtime(a.tenant.id, (tx) => tx.quickBooksTaxEstimateOperation.create({ data: reviewed(b) }))).rejects.toThrow();
    const foreignUpdate = await runtime(b.tenant.id, (tx) => tx.quickBooksTaxEstimateOperation.updateMany({ where: { id: row.id }, data: { status: "SUPERSEDED", supersededAtUtc: new Date() } }));
    expect(foreignUpdate.count).toBe(0);
  });

  test("composite FKs reject foreign actors, connections, invoices and customer/quote identity", async () => {
    const a = await fixture(); const b = await fixture();
    const invalid: Array<Partial<Prisma.QuickBooksTaxEstimateOperationUncheckedCreateInput>> = [
      { requestedByTenantUserId: b.actor.id }, { reviewedByTenantUserId: b.actor.id },
      { quickBooksConnectionId: b.connection.id }, { invoiceId: b.invoice.id },
      { sourceQuoteId: b.quote.id }, { customerId: b.customer.id },
    ];
    for (const override of invalid) {
      await expect(runtime(a.tenant.id, (tx) => tx.quickBooksTaxEstimateOperation.create({ data: reviewed(a, override) }))).rejects.toThrow();
    }
    const second = await invoiceFixture(a, 2);
    // Both invoices and quotes are in this tenant, but their source identity differs.
    await expect(runtime(a.tenant.id, (tx) => tx.quickBooksTaxEstimateOperation.create({ data: reviewed(a, { sourceQuoteId: second.quote.id }) }))).rejects.toThrow();
    await expect(runtime(a.tenant.id, (tx) => tx.quickBooksTaxEstimateOperation.create({ data: reviewed(a, { invoiceId: second.invoice.id }) }))).rejects.toThrow();
  });

  test("runtime cannot update reviewed identity or delete/truncate ledger evidence", async () => {
    const f = await fixture();
    const row = await runtime(f.tenant.id, (tx) => tx.quickBooksTaxEstimateOperation.create({ data: reviewed(f) }));
    for (const query of [
      Prisma.sql`UPDATE "QuickBooksTaxEstimateOperation" SET "sourceHash" = "sourceHash" WHERE id = ${row.id}`,
      Prisma.sql`UPDATE "QuickBooksTaxEstimateOperation" SET "estimateRequestId" = 'replacement' WHERE id = ${row.id}`,
      Prisma.sql`DELETE FROM "QuickBooksTaxEstimateOperation" WHERE id = ${row.id}`,
      Prisma.sql`TRUNCATE "QuickBooksTaxEstimateOperation"`,
    ]) await expect(runtime(f.tenant.id, (tx) => tx.$executeRaw(query))).rejects.toThrow();
    expect(await prisma.quickBooksTaxEstimateOperation.count({ where: { id: row.id } })).toBe(1);
  });

  test("the immutable trigger protects every reviewed identity field even from owner updates", async () => {
    const f = await fixture(); const row = await prisma.quickBooksTaxEstimateOperation.create({ data: reviewed(f) });
    const changes: Array<Prisma.QuickBooksTaxEstimateOperationUncheckedUpdateInput> = [
      { id: randomUUID() }, { tenantId: randomUUID() }, { invoiceId: randomUUID() }, { customerId: randomUUID() }, { sourceQuoteId: randomUUID() }, { quickBooksConnectionId: randomUUID() }, { requestedByTenantUserId: randomUUID() }, { reviewedByTenantUserId: randomUUID() }, { providerRealmId: "changed" },
      { reviewRevision: 2 }, { contractVersion: 2 }, { invoiceVersion: 2 }, { connectionGenerationAtUtc: new Date(0) }, { sourceSnapshot: { changed: true } }, { estimateAstSnapshot: { changed: true } }, { sourceHash: otherHash }, { estimateAstHash: otherHash }, { reviewBindingDigest: otherHash }, { bindingKeyId: "changed" }, { estimateRequestId: "changed" }, { invoiceRequestId: "changed" }, { reviewedAtUtc: new Date(0) }, { createdAt: new Date(0) },
    ];
    for (const data of changes) await expect(prisma.quickBooksTaxEstimateOperation.update({ where: { id: row.id }, data })).rejects.toThrow(/immutable/);
  });

  test("runtime can claim, quarantine and retain a late ID without changing dispatch identity", async () => {
    const f = await fixture(); const original = reviewed(f);
    const row = await runtime(f.tenant.id, (tx) => tx.quickBooksTaxEstimateOperation.create({ data: original }));
    const update = (data: Prisma.QuickBooksTaxEstimateOperationUpdateInput) => runtime(f.tenant.id, (tx) => tx.quickBooksTaxEstimateOperation.update({ where: { id: row.id }, data }));
    await update(processing());
    await update({ status: "ESTIMATE_RECONCILIATION_REQUIRED", claimTokenHash: null, claimExpiresAtUtc: null, uncertainAtUtc: new Date(), lastFailureCode: uncertaintyCode });
    await update({ providerEstimateId: "late-estimate" });
    for (const data of [{ providerEstimateId: null }, { providerEstimateId: "different" }, { attemptTokenHash: null }, { attemptTokenHash: otherHash }]) {
      await expect(update(data)).rejects.toThrow(/write-once/);
      await expect(prisma.quickBooksTaxEstimateOperation.update({ where: { id: row.id }, data })).rejects.toThrow(/write-once/);
    }
    await update({ status: "SUPERSEDED", supersededAtUtc: new Date() });
    expect(await prisma.quickBooksTaxEstimateOperation.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ attemptTokenHash: hash, providerEstimateId: "late-estimate", estimateRequestId: original.estimateRequestId, invoiceRequestId: original.invoiceRequestId });
  });

  test("claim, uncertainty, failure and supersession fields cannot contradict their state", async () => {
    const f = await fixture(); const row = await prisma.quickBooksTaxEstimateOperation.create({ data: reviewed(f) });
    const invalid: Prisma.QuickBooksTaxEstimateOperationUpdateInput[] = [
      { status: "ESTIMATE_PROCESSING" }, { claimTokenHash: hash }, { claimExpiresAtUtc: new Date() },
      { ...processing(), attemptTokenHash: null }, { ...processing(), attemptTokenHash: otherHash },
      { ...processing(), claimExpiresAtUtc: new Date(0) }, { ...processing(), attemptCount: 0 },
      { status: "ESTIMATE_RECONCILIATION_REQUIRED" },
      { status: "ESTIMATE_RECONCILIATION_REQUIRED", uncertainAtUtc: new Date(), lastFailureCode: "ARBITRARY_CODE" },
      { status: "FAILED" }, { status: "FAILED", failedAtUtc: new Date() },
      { status: "SUPERSEDED" }, { supersededAtUtc: new Date() },
    ];
    for (const data of invalid) await expect(runtime(f.tenant.id, (tx) => tx.quickBooksTaxEstimateOperation.update({ where: { id: row.id }, data }))).rejects.toThrow();
    await runtime(f.tenant.id, (tx) => tx.quickBooksTaxEstimateOperation.update({ where: { id: row.id }, data: { status: "FAILED", failedAtUtc: new Date(), lastFailureCode: "QUICKBOOKS_ESTIMATE_REJECTED" } }));
  });

  test.each(["owner", "runtime"])("%s cannot create or update inconsistent original-attempt evidence", async (role) => {
    const f = await fixture();
    const run = <T>(action: (tx: Prisma.TransactionClient) => Promise<T>) => role === "runtime"
      ? runtime(f.tenant.id, action)
      : action(prisma);
    const invalid = [
      { ...attemptEvidence(), attemptCount: 2 },
      { attemptCount: 0, attemptTokenHash: hash },
      { attemptCount: 0, lastAttemptAtUtc: new Date() },
      { attemptCount: 1, attemptTokenHash: null, lastAttemptAtUtc: new Date() },
      { attemptCount: 1, attemptTokenHash: hash, lastAttemptAtUtc: null },
      { providerEstimateId: "identity-without-original-attempt" },
    ];
    for (const data of invalid) {
      await expect(run((tx) => tx.quickBooksTaxEstimateOperation.create({ data: reviewed(f, data) })))
        .rejects.toThrow(/QbTaxEstimate_(attempt_evidence|provider_attempt)_check/);
    }
    const row = await run((tx) => tx.quickBooksTaxEstimateOperation.create({ data: reviewed(f) }));
    for (const data of invalid) {
      await expect(run((tx) => tx.quickBooksTaxEstimateOperation.update({ where: { id: row.id }, data })))
        .rejects.toThrow(/QbTaxEstimate_(attempt_evidence|provider_attempt)_check/);
    }
    // Superseded evidence still accepts its original late result, without a new attempt.
    await run((tx) => tx.quickBooksTaxEstimateOperation.update({ where: { id: row.id }, data: {
      ...attemptEvidence(), status: "SUPERSEDED", supersededAtUtc: new Date(),
    } }));
    const retained = await run((tx) => tx.quickBooksTaxEstimateOperation.update({ where: { id: row.id }, data: { providerEstimateId: "valid-late-id" } }));
    expect(retained).toMatchObject({ status: "SUPERSEDED", attemptCount: 1, attemptTokenHash: hash, providerEstimateId: "valid-late-id" });
  });

  test("canonical proof is complete, finite, positive-tax and arithmetically exact", async () => {
    const f = await fixture(); const row = await prisma.quickBooksTaxEstimateOperation.create({ data: reviewed(f) });
    const good = canonical();
    const invalid: Prisma.QuickBooksTaxEstimateOperationUpdateInput[] = [
      { status: "ESTIMATE_CANONICAL" }, { providerEstimateSyncToken: "0" }, { canonicalEstimateHash: hash },
      { ...good, providerEstimateId: null }, { ...good, providerEstimateSyncToken: null }, { ...good, providerEstimateUpdatedAtUtc: null }, { ...good, canonicalEstimateHash: null }, { ...good, providerSubtotal: null }, { ...good, providerTax: null }, { ...good, providerTotal: null }, { ...good, canonicalAtUtc: null },
      { ...good, providerTax: "0.00", providerTotal: "100.00" }, { ...good, providerSubtotal: "-1.00", providerTotal: "7.00" }, { ...good, providerTotal: "108.01" }, { ...good, status: "REVIEWED" },
      { ...good, providerSubtotal: new Prisma.Decimal("NaN"), providerTax: new Prisma.Decimal("NaN"), providerTotal: new Prisma.Decimal("NaN") },
    ];
    for (const data of invalid) await expect(runtime(f.tenant.id, (tx) => tx.quickBooksTaxEstimateOperation.update({ where: { id: row.id }, data }))).rejects.toThrow();
    const saved = await runtime(f.tenant.id, (tx) => tx.quickBooksTaxEstimateOperation.update({ where: { id: row.id }, data: good }));
    expect(saved.providerTotal?.toFixed(2)).toBe("108.00");
    expect(saved.status).toBe("ESTIMATE_CANONICAL");
    for (const data of [
      { providerEstimateSyncToken: "1" }, { providerEstimateUpdatedAtUtc: new Date(0) }, { canonicalEstimateHash: otherHash }, { providerSubtotal: "99.00" }, { providerTax: "9.00" }, { providerTotal: "109.00" }, { canonicalAtUtc: new Date(0) },
      { providerEstimateSyncToken: null, providerEstimateUpdatedAtUtc: null, canonicalEstimateHash: null, providerSubtotal: null, providerTax: null, providerTotal: null, canonicalAtUtc: null, status: "REVIEWED" as const },
    ]) await expect(prisma.quickBooksTaxEstimateOperation.update({ where: { id: row.id }, data })).rejects.toThrow(/write-once/);
  });

  test("concurrent reviews have one active winner and retain earlier revision evidence", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([1, 2].map((reviewRevision) => runtime(f.tenant.id, (tx) => tx.quickBooksTaxEstimateOperation.create({ data: reviewed(f, { reviewRevision }) }))));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = await prisma.quickBooksTaxEstimateOperation.findFirstOrThrow({ where: { tenantId: f.tenant.id } });
    await runtime(f.tenant.id, (tx) => tx.quickBooksTaxEstimateOperation.update({ where: { id: winner.id }, data: { status: "SUPERSEDED", supersededAtUtc: new Date() } }));
    await expect(runtime(f.tenant.id, (tx) => tx.quickBooksTaxEstimateOperation.create({ data: reviewed(f, { reviewRevision: winner.reviewRevision }) }))).rejects.toThrow();
    await runtime(f.tenant.id, (tx) => tx.quickBooksTaxEstimateOperation.create({ data: reviewed(f, { reviewRevision: 3 }) }));
    expect(await prisma.quickBooksTaxEstimateOperation.count({ where: { tenantId: f.tenant.id } })).toBe(2);
  });

  test("separate Estimate/Invoice request IDs are nonblank, distinct and unique across revisions", async () => {
    const f = await fixture();
    const first = await prisma.quickBooksTaxEstimateOperation.create({ data: reviewed(f, { status: "SUPERSEDED", supersededAtUtc: new Date() }) });
    for (const override of [{ estimateRequestId: " " }, { invoiceRequestId: " " }, { estimateRequestId: "same", invoiceRequestId: "same" }, { estimateRequestId: first.estimateRequestId }, { invoiceRequestId: first.invoiceRequestId }]) {
      await expect(runtime(f.tenant.id, (tx) => tx.quickBooksTaxEstimateOperation.create({ data: reviewed(f, { reviewRevision: 2, ...override }) }))).rejects.toThrow();
    }
    const second = await runtime(f.tenant.id, (tx) => tx.quickBooksTaxEstimateOperation.create({ data: reviewed(f, { reviewRevision: 2 }) }));
    expect(second.estimateRequestId).not.toBe(second.invoiceRequestId);
  });

  test("a provider Estimate can bind to only one operation per connection", async () => {
    const f = await fixture(); const second = { ...f, ...await invoiceFixture(f, 2) };
    const row = await prisma.quickBooksTaxEstimateOperation.create({ data: reviewed(f, { ...attemptEvidence(), providerEstimateId: "same-provider-id" }) });
    await expect(runtime(f.tenant.id, (tx) => tx.quickBooksTaxEstimateOperation.create({ data: reviewed(second, { ...attemptEvidence(), providerEstimateId: "same-provider-id" }) }))).rejects.toThrow();
    const other = await fixture();
    const distinctConnection = await runtime(other.tenant.id, (tx) => tx.quickBooksTaxEstimateOperation.create({ data: reviewed(other, { ...attemptEvidence(), providerEstimateId: row.providerEstimateId }) }));
    expect(distinctConnection.quickBooksConnectionId).not.toBe(row.quickBooksConnectionId);
  });

  test("hashes, fixed failure codes, identity strings and positive versions reject malformed values", async () => {
    const f = await fixture();
    const invalid: Array<Partial<Prisma.QuickBooksTaxEstimateOperationUncheckedCreateInput>> = [
      { sourceHash: "A".repeat(64) }, { estimateAstHash: "short" }, { reviewBindingDigest: "g".repeat(64) }, { attemptTokenHash: "invalid" }, { claimTokenHash: "invalid" }, { canonicalEstimateHash: "invalid" },
      { lastFailureCode: "Private provider prose" }, { reviewRevision: 0 }, { contractVersion: 0 }, { invoiceVersion: 0 }, { attemptCount: -1 }, { providerRealmId: " " }, { bindingKeyId: " " }, { providerEstimateId: " " },
    ];
    for (const override of invalid) await expect(runtime(f.tenant.id, (tx) => tx.quickBooksTaxEstimateOperation.create({ data: reviewed(f, override) }))).rejects.toThrow();
    expect(await prisma.quickBooksTaxEstimateOperation.count({ where: { tenantId: f.tenant.id } })).toBe(0);
  });
});
