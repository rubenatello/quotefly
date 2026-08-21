import assert from "node:assert/strict";
import test from "node:test";
import { Prisma, ServiceCategory } from "@prisma/client";
import { addMissingTenantStarterCatalog } from "../../src/services/tenant-starter-catalog";

interface CatalogRow {
  id: string;
  tenantId: string;
  serviceType: ServiceCategory;
  catalogKey: string | null;
  name: string;
  deletedAtUtc: Date | null;
}

function transactionHarness(initialRows: CatalogRow[], simulateOutsideLockConflict = false) {
  const rows = initialRows.map((row) => ({ ...row }));
  let createManyCalls = 0;
  let initialLookupComplete = false;
  let queryRawCalls = 0;

  const transaction = {
    $queryRaw: async () => {
      queryRawCalls += 1;
      if (queryRawCalls === 1) return [{ id: "tenant-catalog-test" }];
      initialLookupComplete = true;
      return rows.map((row) => ({ catalogKey: row.catalogKey, name: row.name }));
    },
    workPreset: {
      count: async () => rows.filter((row) => row.deletedAtUtc === null).length,
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        const ids = new Set(where.id.in);
        return rows.filter((row) => ids.has(row.id));
      },
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        assert.equal(initialLookupComplete, true);
        createManyCalls += 1;
        if (simulateOutsideLockConflict) {
          const conflictedCandidate = data[0]!;
          rows.push({
            id: "preexisting-race-row",
            tenantId: String(conflictedCandidate.tenantId),
            serviceType: conflictedCandidate.serviceType as ServiceCategory,
            catalogKey: String(conflictedCandidate.catalogKey),
            name: String(conflictedCandidate.name),
            deletedAtUtc: null,
          });
          const insertedCandidate = data[1]!;
          rows.push({
            id: String(insertedCandidate.id),
            tenantId: String(insertedCandidate.tenantId),
            serviceType: insertedCandidate.serviceType as ServiceCategory,
            catalogKey: String(insertedCandidate.catalogKey),
            name: String(insertedCandidate.name),
            deletedAtUtc: null,
          });
          return { count: 1 };
        }
        for (const candidate of data) {
          rows.push({
            id: String(candidate.id),
            tenantId: String(candidate.tenantId),
            serviceType: candidate.serviceType as ServiceCategory,
            catalogKey: String(candidate.catalogKey),
            name: String(candidate.name),
            deletedAtUtc: null,
          });
        }
        return { count: data.length };
      },
    },
  } as unknown as Prisma.TransactionClient;

  return {
    transaction,
    getCreateManyCalls: () => createManyCalls,
    getRows: () => rows,
  };
}

for (const [state, deletedAtUtc] of [
  ["active", null],
  ["archived", new Date("2026-08-20T12:00:00.000Z")],
] as const) {
  test(`${state} custom products reserve normalized starter names without being mutated`, async () => {
    const existing: CatalogRow = {
      id: `${state}-custom-general-labor`,
      tenantId: "tenant-catalog-test",
      serviceType: ServiceCategory.CONSTRUCTION,
      catalogKey: null,
      name: "  GENERAL   labor ",
      deletedAtUtc,
    };
    const harness = transactionHarness([existing]);

    const result = await addMissingTenantStarterCatalog(harness.transaction, {
      tenantId: existing.tenantId,
      serviceType: ServiceCategory.CONSTRUCTION,
      catalogKeys: ["general_labor"],
    });

    assert.deepEqual(result, {
      requestedCount: 1,
      createdCount: 0,
      skippedCount: 1,
      products: [],
    });
    assert.equal(harness.getCreateManyCalls(), 0);
    assert.deepEqual(harness.getRows(), [existing]);
  });
}

test("indexing results contain only rows inserted with this request's generated IDs", async () => {
  const harness = transactionHarness([], true);
  const result = await addMissingTenantStarterCatalog(harness.transaction, {
    tenantId: "tenant-catalog-test",
    serviceType: ServiceCategory.CONSTRUCTION,
    catalogKeys: ["general_labor", "site_prep"],
  });

  assert.equal(result.createdCount, 1);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.products.length, 1);
  assert.notEqual(result.products[0]?.id, "preexisting-race-row");
  assert.equal(harness.getRows()[0]?.id, "preexisting-race-row");
});
