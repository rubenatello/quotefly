import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { parseQuickBooksMonitorEnv } from "../../src/config/quickbooks-monitor-env";
import { ALERT_CODES, observeQuickBooksHealth, monitorConfigurationHash, type AlertObservation } from "../../src/services/quickbooks-monitor-contract";
import { claimQuickBooksAlertDelivery, deliverQuickBooksAlert, evaluateQuickBooksAlerts, ALERT_RETRY_WINDOW_MS } from "../../src/services/quickbooks-operational-monitor";
import { aggregateQuickBooksOperationalRows, loadQuickBooksOperationalHealth, loadQuickBooksOperationalRow } from "../../src/services/quickbooks-operational-health";

const prisma = new PrismaClient();
const runtimeUrl = new URL(process.env.DATABASE_URL!);
runtimeUrl.searchParams.set("options", "-c role=quotefly_runtime");
const runtime = new PrismaClient({ datasources: { db: { url: runtimeUrl.toString() } } });
const env = parseQuickBooksMonitorEnv({ DATABASE_URL: process.env.DATABASE_URL, RESEND_API_KEY: "synthetic", PASSWORD_RESET_EMAIL_FROM: "alerts@example.com", QUICKBOOKS_ALERT_EMAIL: "operations@example.com", QUICKBOOKS_MONITOR_ENVIRONMENT_LABEL: "test", QUICKBOOKS_MONITOR_EXPECT_RECONCILIATION: "true", QUICKBOOKS_MONITOR_EXPECT_CDC: "true" });
const configurationHash = monitorConfigurationHash(env);
const base = new Date("2026-09-20T00:00:00Z");
const at = (seconds: number) => new Date(base.getTime() + seconds * 1000);
function observations(severity: AlertObservation["severity"]): AlertObservation[] {
  return ALERT_CODES.map((alertCode) => ({ alertCode, severity: alertCode === "WEBHOOK_BACKLOG" ? severity : "HEALTHY", metrics: { count: alertCode === "WEBHOOK_BACKLOG" && severity !== "HEALTHY" ? 2 : 0, ageMs: 900001 } }));
}

beforeEach(async () => {
  await prisma.quickBooksOperationalAlertDelivery.deleteMany();
  await prisma.quickBooksOperationalAlertState.deleteMany();
});
afterAll(async () => { await runtime.$disconnect(); await prisma.$disconnect(); });

describe("durable operational alert transitions", () => {
  test("concurrent evaluators queue one OPEN; identical/older samples do not advance warnings", async () => {
    expect(await evaluateQuickBooksAlerts(runtime, observations("WARNING"), base, configurationHash)).toBe(0);
    await Promise.all([evaluateQuickBooksAlerts(runtime, observations("WARNING"), base, configurationHash), evaluateQuickBooksAlerts(runtime, observations("WARNING"), at(-60), configurationHash)]);
    expect(await prisma.quickBooksOperationalAlertDelivery.count()).toBe(0);
    await Promise.all([evaluateQuickBooksAlerts(runtime, observations("WARNING"), at(60), configurationHash), evaluateQuickBooksAlerts(runtime, observations("WARNING"), at(60), configurationHash)]);
    expect(await prisma.quickBooksOperationalAlertDelivery.count()).toBe(1);
    expect(await prisma.quickBooksOperationalAlertState.findUnique({ where: { alertCode: "WEBHOOK_BACKLOG" } })).toMatchObject({ active: true, incidentGeneration: 1, failureStreak: 2 });
  });

  test("critical opens immediately, reminder only after 24h, recovery requires two healthy samples", async () => {
    expect(await evaluateQuickBooksAlerts(runtime, observations("CRITICAL"), base, configurationHash)).toBe(1);
    expect(await evaluateQuickBooksAlerts(runtime, observations("CRITICAL"), at(86399), configurationHash)).toBe(0);
    expect(await evaluateQuickBooksAlerts(runtime, observations("CRITICAL"), at(86430), configurationHash)).toBe(1);
    expect(await evaluateQuickBooksAlerts(runtime, observations("HEALTHY"), at(86490), configurationHash)).toBe(0);
    expect(await evaluateQuickBooksAlerts(runtime, observations("HEALTHY"), at(86550), configurationHash)).toBe(1);
    expect((await prisma.quickBooksOperationalAlertDelivery.findMany({ orderBy: { observedAtUtc: "asc" } })).map((row) => row.transition)).toEqual(["OPEN", "REMINDER", "RECOVER"]);
    expect(await evaluateQuickBooksAlerts(runtime, observations("CRITICAL"), at(86610), configurationHash)).toBe(1);
    expect(await prisma.quickBooksOperationalAlertState.findUnique({ where: { alertCode: "WEBHOOK_BACKLOG" } })).toMatchObject({ incidentGeneration: 2 });
  });

  test("warning escalation is queued once without repeatedly escalating after a partial recovery", async () => {
    await evaluateQuickBooksAlerts(runtime, observations("WARNING"), base, configurationHash);
    await evaluateQuickBooksAlerts(runtime, observations("WARNING"), at(60), configurationHash);
    expect(await evaluateQuickBooksAlerts(runtime, observations("CRITICAL"), at(120), configurationHash)).toBe(1);
    await evaluateQuickBooksAlerts(runtime, observations("HEALTHY"), at(180), configurationHash);
    expect(await evaluateQuickBooksAlerts(runtime, observations("CRITICAL"), at(240), configurationHash)).toBe(0);
    expect(await prisma.quickBooksOperationalAlertDelivery.count()).toBe(2);
  });

  test("concurrent delivery claims are exclusive and an expired lease retains the payload and key", async () => {
    await evaluateQuickBooksAlerts(runtime, observations("CRITICAL"), base, configurationHash);
    const claims = await Promise.all([claimQuickBooksAlertDelivery(runtime, base), claimQuickBooksAlertDelivery(runtime, base)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const initial = claims.find(Boolean)!;
    const retry = await claimQuickBooksAlertDelivery(runtime, at(31));
    expect(retry?.dedupeKeyHash).toBe(initial.dedupeKeyHash);
    expect(retry?.claimToken).not.toBe(initial.claimToken);
    expect(retry?.metrics).toEqual(initial.metrics);
  });

  test("ambiguous sends retry the same key and payload; successful records never resend", async () => {
    await evaluateQuickBooksAlerts(runtime, observations("CRITICAL"), base, configurationHash);
    const attempts: unknown[] = [];
    const send = async (_env: typeof env, message: unknown, key: string) => { attempts.push({ message, key }); if (attempts.length === 1) throw new Error("secret provider failure"); };
    expect(await deliverQuickBooksAlert(runtime, env, base, send)).toBe("retry");
    expect(await deliverQuickBooksAlert(runtime, env, at(60), send)).toBe("sent");
    expect(attempts[0]).toEqual(attempts[1]);
    expect(await deliverQuickBooksAlert(runtime, env, at(120), send)).toBe("idle");
    expect(await prisma.quickBooksOperationalAlertDelivery.findFirst()).toMatchObject({ status: "SENT", lastErrorCode: null });
  });

  test("retries stop before provider idempotency retention and changed recipients are quarantined", async () => {
    await evaluateQuickBooksAlerts(runtime, observations("CRITICAL"), base, configurationHash);
    await claimQuickBooksAlertDelivery(runtime, base);
    expect(await claimQuickBooksAlertDelivery(runtime, new Date(base.getTime() + ALERT_RETRY_WINDOW_MS))).toBeNull();
    expect(await prisma.quickBooksOperationalAlertDelivery.findFirst()).toMatchObject({ status: "TERMINAL", lastErrorCode: "DELIVERY_UNCONFIRMED" });
    await evaluateQuickBooksAlerts(runtime, observations("CRITICAL"), at(86400), configurationHash);
    let calls = 0;
    expect(await deliverQuickBooksAlert(runtime, { ...env, QUICKBOOKS_ALERT_EMAIL: "changed@example.com" }, at(86400), async () => { calls += 1; })).toBe("terminal");
    expect(calls).toBe(0);
  });

  test("repeated token refresh attempts cannot postpone persistent failure alerts", async () => {
    const tokenSamples = (count: number): AlertObservation[] => observations("HEALTHY").map((sample) => sample.alertCode === "TOKEN_FAILURE"
      ? { ...sample, metrics: { count, ageMs: 1000 } } : sample);
    expect(await evaluateQuickBooksAlerts(runtime, tokenSamples(1), base, configurationHash)).toBe(0);
    expect(await evaluateQuickBooksAlerts(runtime, tokenSamples(1), at(301), configurationHash)).toBe(0);
    expect(await evaluateQuickBooksAlerts(runtime, tokenSamples(1), at(361), configurationHash)).toBe(1);
    expect(await evaluateQuickBooksAlerts(runtime, tokenSamples(1), at(901), configurationHash)).toBe(1);
    expect(await evaluateQuickBooksAlerts(runtime, tokenSamples(0), at(961), configurationHash)).toBe(0);
    expect(await evaluateQuickBooksAlerts(runtime, tokenSamples(1), at(1021), configurationHash)).toBe(0);
    expect(await prisma.quickBooksOperationalAlertState.findUnique({ where: { alertCode: "TOKEN_FAILURE" } })).toMatchObject({ conditionSinceUtc: base, active: true, severity: "CRITICAL" });
    await evaluateQuickBooksAlerts(runtime, tokenSamples(0), at(1081), configurationHash);
    expect(await evaluateQuickBooksAlerts(runtime, tokenSamples(0), at(1141), configurationHash)).toBe(1);
    expect(await prisma.quickBooksOperationalAlertState.findUnique({ where: { alertCode: "TOKEN_FAILURE" } })).toMatchObject({ conditionSinceUtc: null, active: false });
  });

  test("normal five-minute CDC cadence never opens an incident; a stalled cursor warns, escalates and recovers", async () => {
    let providerCursor = base;
    const sample = (seconds: number, completePoll: boolean) => {
      if (completePoll) providerCursor = at(seconds);
      const now = at(seconds);
      return observeQuickBooksHealth({ ...aggregateQuickBooksOperationalRows([], now), cdcCursorCount: 1,
        maximumCdcLagMs: now.getTime() - providerCursor.getTime() + 120000 },
        { status: "RUNNING", fresh: true, heartbeatAtUtc: now, startedAtUtc: base, cycleStartedAtUtc: now, lastCycleDurationMs: 0, metrics: {} }, env, now);
    };
    // Offset monitor samples 30s from the five-minute poll cadence. Raw lag exceeds 5m
    // for two consecutive samples per cycle, while actual recovery age remains healthy.
    for (let seconds = 30; seconds < 1200; seconds += 60) {
      providerCursor = at(Math.floor(seconds / 300) * 300);
      expect(await evaluateQuickBooksAlerts(runtime, sample(seconds, false), at(seconds), configurationHash)).toBe(0);
    }
    expect(await evaluateQuickBooksAlerts(runtime, sample(1200, true), at(1200), configurationHash)).toBe(0);
    expect(await prisma.quickBooksOperationalAlertDelivery.count()).toBe(0);
    // Stop completing polls after minute20. Warning needs two samples beyond five elapsed minutes.
    expect(await evaluateQuickBooksAlerts(runtime, sample(1560, false), at(1560), configurationHash)).toBe(0);
    expect(await evaluateQuickBooksAlerts(runtime, sample(1620, false), at(1620), configurationHash)).toBe(1);
    expect(await evaluateQuickBooksAlerts(runtime, sample(2160, false), at(2160), configurationHash)).toBe(1);
    expect(await evaluateQuickBooksAlerts(runtime, sample(2220, true), at(2220), configurationHash)).toBe(0);
    expect(await evaluateQuickBooksAlerts(runtime, sample(2280, false), at(2280), configurationHash)).toBe(1);
    expect((await prisma.quickBooksOperationalAlertDelivery.findMany({ orderBy: { observedAtUtc: "asc" } })).map((row) => ({ code: row.alertCode, transition: row.transition })))
      .toEqual([{ code: "CDC_RECOVERY", transition: "OPEN" }, { code: "CDC_RECOVERY", transition: "ESCALATE" }, { code: "CDC_RECOVERY", transition: "RECOVER" }]);
  });

  test("an exhausted queue head does not delay the following eligible reminder", async () => {
    await evaluateQuickBooksAlerts(runtime, observations("CRITICAL"), base, configurationHash);
    await claimQuickBooksAlertDelivery(runtime, base);
    await evaluateQuickBooksAlerts(runtime, observations("CRITICAL"), at(86400), configurationHash);
    let sends = 0;
    expect(await deliverQuickBooksAlert(runtime, env, at(86400), async () => { sends += 1; })).toBe("sent");
    expect(sends).toBe(1);
    expect(await prisma.quickBooksOperationalAlertDelivery.count({ where: { status: "TERMINAL" } })).toBe(1);
    expect(await prisma.quickBooksOperationalAlertDelivery.count({ where: { status: "SENT" } })).toBe(1);
  });

  test("runtime cannot delete monitor state or delivery history", async () => {
    await evaluateQuickBooksAlerts(runtime, observations("CRITICAL"), base, configurationHash);
    await expect(runtime.quickBooksOperationalAlertDelivery.deleteMany()).rejects.toThrow();
    await expect(runtime.quickBooksOperationalAlertState.deleteMany()).rejects.toThrow();
  });

  test("complete keyset scan includes tenants past page two and preserves forced RLS", async () => {
    const prefix = `monitor-${Date.now()}-`;
    const tenants = Array.from({ length: 205 }, (_, index) => ({ id: `${prefix}${String(index).padStart(3, "0")}`, slug: `${prefix}${index}`, name: "Synthetic monitor fixture" }));
    await prisma.tenant.createMany({ data: tenants });
    const last = tenants[204];
    const first = tenants[0];
    try {
      const connection = await prisma.quickBooksConnection.create({ data: { tenantId: last.id, realmId: "synthetic-monitor-realm", status: "NEEDS_REAUTH", environment: "sandbox", updatedAt: at(-1000) } });
      await prisma.quickBooksWebhookEvent.create({ data: { tenantId: last.id, quickBooksConnectionId: connection.id, webhookEventId: `${prefix}dead`, realmId: "synthetic-monitor-realm", eventType: "Invoice", operation: "Update", payload: {}, status: "DEAD" } });
      const own = await loadQuickBooksOperationalRow(runtime, last.id, base);
      const other = await loadQuickBooksOperationalRow(runtime, first.id, base);
      expect(own.tokenReauthCount).toBe(1);
      expect(own.webhookDeadCount).toBe(1);
      expect(other.tokenReauthCount).toBe(0);
      expect(other.webhookDeadCount).toBe(0);
      const full = await loadQuickBooksOperationalHealth(runtime, base);
      expect(full.tenantCount).toBeGreaterThanOrEqual(205);
      expect(full.tokenReauthCount).toBeGreaterThanOrEqual(1);
      expect(full.webhookDeadCount).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(full)).not.toContain(last.id);
      expect(JSON.stringify(full)).not.toContain("synthetic-monitor-realm");
    } finally {
      await prisma.quickBooksWebhookEvent.deleteMany({ where: { tenantId: last.id } });
      await prisma.quickBooksConnection.deleteMany({ where: { tenantId: last.id } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenants.map((tenant) => tenant.id) } } });
    }
  });
});
