import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, test, vi } from "vitest";
import { buildServer } from "../../src/app";
import { env } from "../../src/config/env";
import { prisma } from "../../src/lib/prisma";
import { withTenantRlsContext } from "../../src/lib/tenant-rls";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "../../src/services/quickbooks-setup";
import { listQuickBooksDeadLetters, replayQuickBooksDeadLetter } from "../../src/services/quickbooks-webhook-replay";

const tenantIds: string[] = [];
async function fixture() {
  const stamp = randomUUID();
  const tenant = await prisma.tenant.create({ data: { name: "Recovery fixture", slug: stamp,
    subscriptionStatus: "trialing", trialStartsAtUtc: new Date(), trialEndsAtUtc: new Date(Date.now() + 86_400_000) } });
  tenantIds.push(tenant.id);
  const user = await prisma.user.create({ data: { email: `${stamp}@example.com`, passwordHash: "synthetic", fullName: "Test owner" } });
  const member = await prisma.tenantUser.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" } });
  const connection = await prisma.quickBooksConnection.create({ data: {
    tenantId: tenant.id, realmId: stamp, environment: "sandbox", status: "CONNECTED",
    setupConfirmedAtUtc: new Date(), setupConfirmedByTenantUserId: member.id,
    setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
  } });
  await prisma.quickBooksRealmBinding.create({ data: { tenantId: tenant.id, quickBooksConnectionId: connection.id, realmId: stamp } });
  const payload = { entity: { name: "Payment", id: "private-provider-id", operation: "Update" },
    quoteflyPendingInvoiceIds: [], quoteflyPendingProviderInvoiceIds: [],
    quoteflyInvoiceRetryCounts: [["private-invoice-id", 8]], quoteflyInvoiceTerminalFailures: [["PRIVATE", 1]],
    quoteflyUnrelated: "preserved" };
  const event = await prisma.quickBooksWebhookEvent.create({ data: {
    tenantId: tenant.id, quickBooksConnectionId: connection.id, realmId: stamp, webhookEventId: stamp,
    eventType: "Payment", entityId: "private-provider-id", operation: "Update", status: "DEAD", attemptCount: 8,
    deadAtUtc: new Date(), claimTokenHash: "a".repeat(64), claimExpiresAtUtc: new Date(),
    nextAttemptAtUtc: new Date(), lastError: "private provider details", payload,
  } });
  const actor = { tenantId: tenant.id, userId: user.id, authVersion: 0 };
  const input = { eventId: event.id, reason: "PROVIDER_RECOVERED" as const, idempotencyKey: randomUUID() };
  return { tenant, user, member, connection, event, payload, actor, input,
    replay: () => replayQuickBooksDeadLetter(prisma, actor, env, input) };
}

describe("authorized QuickBooks dead-letter replay", () => {
  afterAll(async () => {
    // Test-only cleanup uses the guarded dedicated database's migration role.
    await prisma.quickBooksWebhookReplay.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.$disconnect();
  });

  test("queues once, strips only checkpoints, preserves provider facts and audits without content", async () => {
    const f = await fixture();
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No provider call permitted"));
    try {
      const result = await f.replay();
      expect(result).toMatchObject({ eventId: f.event.id, outcome: "QUEUED" });
      expect(await prisma.quickBooksWebhookEvent.findUniqueOrThrow({ where: { id: f.event.id } })).toMatchObject({
        status: "RECEIVED", attemptCount: 0, claimTokenHash: null, claimExpiresAtUtc: null,
        nextAttemptAtUtc: null, processedAtUtc: null, deadAtUtc: null, lastError: null,
        payload: { entity: f.payload.entity, quoteflyUnrelated: "preserved" },
      });
      const audit = await prisma.quickBooksWebhookReplay.findUniqueOrThrow({ where: { id: result.replayId } });
      expect(audit).toMatchObject({ tenantId: f.tenant.id, actorTenantUserId: f.member.id,
        priorAttemptCount: 8, priorFailureCode: "QUICKBOOKS_REVIEW_REQUIRED" });
      expect(JSON.stringify(audit)).not.toMatch(/private provider|private-provider|private-invoice|preserved/);
      expect(audit.commandHash).not.toBe(f.input.idempotencyKey);
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });

  test("same command is idempotent concurrently and after processing and inbox retention", async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([f.replay(), f.replay()]);
    expect(a).toEqual(b);
    await prisma.quickBooksWebhookEvent.update({ where: { id: f.event.id }, data: { status: "PROCESSED" } });
    expect(await f.replay()).toEqual(a);
    await prisma.quickBooksWebhookEvent.delete({ where: { id: f.event.id } });
    expect(await f.replay()).toEqual(a);
    expect(await prisma.quickBooksWebhookReplay.count({ where: { tenantId: f.tenant.id } })).toBe(1);
    await expect(replayQuickBooksDeadLetter(prisma, f.actor, env, { ...f.input, reason: "MAPPING_CORRECTED" }))
      .rejects.toMatchObject({ status: 409, code: "QUICKBOOKS_REPLAY_KEY_CONFLICT" });
  });

  test("different concurrent keys cannot queue the same dead event twice", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.replay(), replayQuickBooksDeadLetter(prisma, f.actor, env, { ...f.input, idempotencyKey: randomUUID() })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.quickBooksWebhookReplay.count({ where: { tenantId: f.tenant.id } })).toBe(1);
  });

  test("cross-tenant events are indistinguishable from absent events and list is bounded/content-free", async () => {
    const f = await fixture(); const other = await fixture();
    await expect(replayQuickBooksDeadLetter(prisma, other.actor, env, f.input)).rejects.toMatchObject({ status: 404 });
    const list = await listQuickBooksDeadLetters(prisma, f.actor, env, 1);
    expect(list.events).toHaveLength(1);
    expect(list.events[0]).toMatchObject({ id: f.event.id, type: "Payment", reason: "QUICKBOOKS_REVIEW_REQUIRED" });
    expect(JSON.stringify(list)).not.toMatch(/private|realmId|payload|entityId|webhookEventId/);
  });

  test("cursor pages reach an older replayable event behind 27 manual-review events", async () => {
    const f = await fixture();
    await prisma.quickBooksWebhookEvent.update({ where: { id: f.event.id }, data: { deadAtUtc: new Date("2026-01-01T00:00:00Z") } });
    await prisma.quickBooksWebhookEvent.createMany({ data: Array.from({ length: 27 }, () => ({
      tenantId: f.tenant.id, quickBooksConnectionId: f.connection.id, realmId: f.connection.realmId,
      webhookEventId: randomUUID(), eventType: "Invoice", entityId: "private-deleted-invoice", operation: "Delete" as const,
      status: "DEAD" as const, deadAtUtc: new Date("2026-02-01T00:00:00Z"), payload: {},
    })) });
    const first = await listQuickBooksDeadLetters(prisma, f.actor, env, 25);
    expect(first).toMatchObject({ total: 28, hasMore: true });
    expect(first.events).toHaveLength(25);
    expect(first.events.every((event) => !event.replaySupported)).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    const second = await listQuickBooksDeadLetters(prisma, f.actor, env, 25, first.nextCursor!);
    expect(second).toMatchObject({ total: 28, hasMore: false, nextCursor: null });
    expect(second.events).toHaveLength(3);
    expect(second.events.at(-1)).toMatchObject({ id: f.event.id, replaySupported: true });
    expect(new Set([...first.events, ...second.events].map((event) => event.id)).size).toBe(28);
    expect(await f.replay()).toMatchObject({ outcome: "QUEUED" });
    expect((await listQuickBooksDeadLetters(prisma, f.actor, env, 25)).total).toBe(27);
    // The service caps direct callers too, independent of route validation.
    expect((await listQuickBooksDeadLetters(prisma, f.actor, env, 1_000)).events.length).toBeLessThanOrEqual(50);
  });

  test("foreign, malformed and replayed cursor anchors reject without tenant disclosure", async () => {
    const f = await fixture();
    const other = await fixture();
    const cursor = Buffer.from(JSON.stringify({ id: f.event.id, at: f.event.deadAtUtc?.toISOString() ?? null }), "utf8").toString("base64url");
    await expect(listQuickBooksDeadLetters(prisma, other.actor, env, 25, cursor)).rejects.toMatchObject({
      status: 400, code: "QUICKBOOKS_RECOVERY_CURSOR_INVALID", message: "Refresh recovery events to continue.",
    });
    await expect(listQuickBooksDeadLetters(prisma, f.actor, env, 25, "!")).rejects.toMatchObject({
      status: 400, code: "QUICKBOOKS_RECOVERY_CURSOR_INVALID",
    });
    await f.replay();
    await expect(listQuickBooksDeadLetters(prisma, f.actor, env, 25, cursor)).rejects.toMatchObject({
      status: 400, code: "QUICKBOOKS_RECOVERY_CURSOR_INVALID", message: "Refresh recovery events to continue.",
    });
    await prisma.quickBooksWebhookEvent.update({ where: { id: f.event.id }, data: { status: "DEAD", deadAtUtc: new Date(f.event.deadAtUtc!.getTime() + 1_000) } });
    await expect(listQuickBooksDeadLetters(prisma, f.actor, env, 25, cursor)).rejects.toMatchObject({
      status: 400, code: "QUICKBOOKS_RECOVERY_CURSOR_INVALID",
    });
  });

  test.each(["member", "deleted-member", "deleted-user", "revoked-session"])("rejects %s using live transactional authorization", async (condition) => {
    const f = await fixture();
    if (condition === "member") await prisma.tenantUser.update({ where: { id: f.member.id }, data: { role: "member" } });
    if (condition === "deleted-member") await prisma.tenantUser.update({ where: { id: f.member.id }, data: { deletedAtUtc: new Date() } });
    if (condition === "deleted-user") await prisma.user.update({ where: { id: f.user.id }, data: { deletedAtUtc: new Date() } });
    if (condition === "revoked-session") await prisma.user.update({ where: { id: f.user.id }, data: { authVersion: 1 } });
    await expect(f.replay()).rejects.toMatchObject({ status: 403 });
    await expect(listQuickBooksDeadLetters(prisma, f.actor, env, 25)).rejects.toMatchObject({ status: 403 });
  });

  test.each(["Invoice", "RefundReceipt"])("never replays deleted %s", async (eventType) => {
    const f = await fixture();
    await prisma.quickBooksWebhookEvent.update({ where: { id: f.event.id }, data: { eventType, operation: "Delete" } });
    await expect(f.replay()).rejects.toMatchObject({ status: 409, code: "QUICKBOOKS_EVENT_NOT_REPLAYABLE" });
    expect((await listQuickBooksDeadLetters(prisma, f.actor, env, 25)).events[0]?.replaySupported).toBe(false);
  });

  test("permits supported payment deletion recovery and current admins", async () => {
    const f = await fixture();
    await prisma.tenantUser.update({ where: { id: f.member.id }, data: { role: "admin" } });
    await prisma.quickBooksWebhookEvent.update({ where: { id: f.event.id }, data: { operation: "Delete" } });
    expect(await f.replay()).toMatchObject({ outcome: "QUEUED" });
  });

  test("rejects paused runtime and stale company bindings", async () => {
    const f = await fixture();
    for (const override of [{ QUICKBOOKS_OAUTH_ONLY_MODE: true }, { QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: false },
      { QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: false }, { QUICKBOOKS_WEBHOOK_VERIFIER: "" }]) {
      await expect(replayQuickBooksDeadLetter(prisma, f.actor, { ...env, ...override }, f.input)).rejects.toMatchObject({ status: 503 });
    }
    await prisma.quickBooksConnection.update({ where: { id: f.connection.id }, data: { realmId: randomUUID() } });
    await expect(f.replay()).rejects.toMatchObject({ status: 409, code: "QUICKBOOKS_CONNECTION_REVIEW_REQUIRED" });
    expect(await prisma.quickBooksWebhookReplay.count({ where: { tenantId: f.tenant.id } })).toBe(0);
  });

  test("audit enforces forced RLS, append-only runtime grants and composite actor tenant boundary", async () => {
    const f = await fixture(); const other = await fixture(); const result = await f.replay();
    const metadata = await prisma.$queryRaw<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'QuickBooksWebhookReplay'`;
    expect(metadata[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      expect(await tx.quickBooksWebhookReplay.count()).toBe(0);
      await withTenantRlsContext(tx, other.tenant.id, async (scoped) => {
        expect(await scoped.quickBooksWebhookReplay.findFirst({ where: { id: result.replayId } })).toBeNull();
      });
    });
    for (const sql of [Prisma.sql`UPDATE "QuickBooksWebhookReplay" SET "reason" = 'MAPPING_CORRECTED' WHERE "id" = ${result.replayId}`,
      Prisma.sql`DELETE FROM "QuickBooksWebhookReplay" WHERE "id" = ${result.replayId}`]) {
      await expect(prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
        await withTenantRlsContext(tx, f.tenant.id, (scoped) => scoped.$executeRaw(sql));
      })).rejects.toThrow();
    }
    await expect(prisma.quickBooksWebhookReplay.create({ data: { tenantId: other.tenant.id, actorTenantUserId: f.member.id,
      eventId: f.event.id, reason: "PROVIDER_RECOVERED", priorFailureCode: "QUICKBOOKS_REVIEW_REQUIRED", priorAttemptCount: 8, commandHash: "e".repeat(64) } })).rejects.toThrow();
  });

  test("HTTP boundary requires authentication, current manager, strict reason and idempotency key", async () => {
    const f = await fixture(); const app = buildServer();
    try {
      await app.ready();
      const url = `/v1/integrations/quickbooks/recovery/events/${f.event.id}/replay`;
      expect((await app.inject({ method: "GET", url: "/v1/integrations/quickbooks/recovery/events" })).statusCode).toBe(401);
      const token = app.jwt.sign({ ...f.actor, email: f.user.email, role: "owner" });
      const headers = { authorization: `Bearer ${token}` };
      const invalidCursor = await app.inject({ method: "GET", url: "/v1/integrations/quickbooks/recovery/events?cursor=invalid!", headers });
      expect(invalidCursor.statusCode).toBe(400);
      expect(invalidCursor.json()).toEqual({ error: "Refresh recovery events to continue.", code: "QUICKBOOKS_RECOVERY_CURSOR_INVALID" });
      const firstPage = await app.inject({ method: "GET", url: "/v1/integrations/quickbooks/recovery/events?limit=1", headers });
      expect(firstPage.statusCode).toBe(200);
      expect(firstPage.json()).toMatchObject({ total: 1, hasMore: false, nextCursor: null });
      expect((await app.inject({ method: "POST", url, headers, payload: { reason: "PROVIDER_RECOVERED" } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url, headers: { ...headers, "idempotency-key": randomUUID() }, payload: { reason: "freeform private text" } })).statusCode).toBe(400);
      const response = await app.inject({ method: "POST", url, headers: { ...headers, "idempotency-key": randomUUID() }, payload: { reason: "PROVIDER_RECOVERED" } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ outcome: "QUEUED" });
      await prisma.tenantUser.update({ where: { id: f.member.id }, data: { role: "member" } });
      expect((await app.inject({ method: "GET", url: "/v1/integrations/quickbooks/recovery/events", headers })).statusCode).toBe(403);
    } finally { await app.close(); }
  });
});
