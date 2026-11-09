import assert from "node:assert/strict";
import test from "node:test";
import {
  nextQuickBooksWorkerScanAt,
  visitQuickBooksWorkerTenantPage,
} from "../../src/services/quickbooks-worker-scheduler";

test("incomplete revocation, CDC and retention cycles continue on the next tick", () => {
  const nowMs = 20_000;
  for (const intervalMs of [5_000, 15_000, 3_600_000]) {
    const nextScanAt = nextQuickBooksWorkerScanAt({ cycleComplete: false }, intervalMs, nowMs);
    assert.equal(nextScanAt, nowMs);
    // Both the active and idle pause remain sufficient to reach the next page.
    assert.ok(nowMs + 100 >= nextScanAt);
    assert.ok(nowMs + 1_000 >= nextScanAt);
  }
});

test("complete cycles wait their full cadence from the end of the final page", () => {
  const nowMs = 20_000;
  for (const intervalMs of [5_000, 15_000, 3_600_000]) {
    const nextScanAt = nextQuickBooksWorkerScanAt({ cycleComplete: true }, intervalMs, nowMs);
    assert.equal(nextScanAt, nowMs + intervalMs);
    assert.ok(nowMs + 1_000 < nextScanAt);
  }
});

test("a 101-tenant retention cycle drains in three bounded ticks before its hourly pause", async () => {
  const tenants = Array.from({ length: 101 }, (_, i) => ({ id: String(i).padStart(3, "0") }));
  const visited: string[] = [];
  const pageSizes: number[] = [];
  let cursor: string | null = null;
  let nextScanAt = 0;
  let nowMs = 0;
  for (let tick = 0; tick < 3; tick += 1) {
    assert.ok(nowMs >= nextScanAt);
    const page = await visitQuickBooksWorkerTenantPage({
      afterTenantId: cursor,
      loadPage: async (after, take) => tenants.filter((tenant) => after === null || tenant.id > after).slice(0, take),
      visit: async (tenant) => { visited.push(tenant.id); },
    });
    cursor = page.nextAfterTenantId;
    pageSizes.push(page.tenantCount);
    nextScanAt = nextQuickBooksWorkerScanAt(page, 3_600_000, nowMs);
    nowMs += 1_000; // Existing idle pause, with no webhook backlog.
  }
  assert.deepEqual(pageSizes, [50, 50, 1]);
  assert.deepEqual(visited, tenants.map((tenant) => tenant.id));
  assert.equal(cursor, null);
  assert.equal(nextScanAt, 3_602_000);
  assert.ok(nowMs < nextScanAt);
});

test("an exact full page reaches its empty tail on the next tick before waiting", async () => {
  const first = await visitQuickBooksWorkerTenantPage({
    afterTenantId: null, pageSize: 1,
    loadPage: async () => [{ id: "only-tenant" }], visit: async () => {},
  });
  assert.equal(nextQuickBooksWorkerScanAt(first, 15_000, 0), 0);
  const tail = await visitQuickBooksWorkerTenantPage({
    afterTenantId: first.nextAfterTenantId, pageSize: 1,
    loadPage: async () => [], visit: async () => { assert.fail("An empty tail must not visit a tenant"); },
  });
  assert.equal(tail.cycleComplete, true);
  assert.equal(nextQuickBooksWorkerScanAt(tail, 15_000, 1_000), 16_000);
});
