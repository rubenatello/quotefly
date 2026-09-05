import type { FastifyInstance } from "fastify";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { buildServer } from "../../src/app";
import { env } from "../../src/config/env";
import { prisma } from "../../src/lib/prisma";
import {
  loadWorkerHeartbeatFleet,
  QUICKBOOKS_RECONCILIATION_WORKER_KEY,
  recordWorkerHeartbeat,
} from "../../src/services/worker-heartbeats";
import {
  loadFreshQuickBooksWorkerOperationalInstances,
  loadQuickBooksWorkerOperationalState,
} from "../../src/services/quickbooks-operational-health";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "../../src/services/quickbooks-setup";
import {
  QUICKBOOKS_PROVIDER_WINDOW_MS,
  QUICKBOOKS_WORKER_OPERATIONAL_SCHEMA,
} from "../../src/services/quickbooks-worker-operational";

let monitorBearerSequence = 0;
let MONITOR_BEARER = "quotefly-integration-monitor-bearer-v1-initial";
const WARNING_URL = "/v1/internal/quickbooks/monitor/warning";
const CRITICAL_URL = "/v1/internal/quickbooks/monitor/critical";

let app: FastifyInstance;
let remoteAddressSequence = 1;
let originalRuntime: {
  monitorBearer: string;
  providerWorkflowsEnabled: boolean;
  oauthOnlyMode: boolean;
  reconciliationWorkerEnabled: boolean;
  cdcWorkerEnabled: boolean;
};

function nextRemoteAddress() {
  return `203.0.113.${remoteAddressSequence++}`;
}

function workerOperationalMetrics(
  startedAtUtc: Date,
  providerWindow: Partial<{
    callCount: number;
    failureCount: number;
    throttleCount: number;
    timeoutCount: number;
    slowCount: number;
    degradedCallCount: number;
    maximumDurationMs: number;
  }> = {},
) {
  return {
    quickBooksOperational: {
      schema: QUICKBOOKS_WORKER_OPERATIONAL_SCHEMA,
      environment: "sandbox" as const,
      providerWindow: {
        windowMs: QUICKBOOKS_PROVIDER_WINDOW_MS,
        callCount: 0,
        failureCount: 0,
        throttleCount: 0,
        timeoutCount: 0,
        slowCount: 0,
        degradedCallCount: 0,
        maximumDurationMs: 0,
        ...providerWindow,
      },
      retention: {
        startupAtUtc: startedAtUtc.toISOString(),
        lastSucceededAtUtc: startedAtUtc.toISOString(),
        unresolvedFailure: false,
        consecutiveFailureCount: 0,
      },
    },
  };
}

function monitorRequest(
  url: string,
  options: { authorization?: string; remoteAddress?: string; forwardedFor?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (options.authorization) headers.authorization = options.authorization;
  if (options.forwardedFor) headers["x-forwarded-for"] = options.forwardedFor;
  return app.inject({
    method: "GET",
    url,
    remoteAddress: options.remoteAddress ?? nextRemoteAddress(),
    headers,
  });
}

function useOauthOnlyPhase() {
  app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED = true;
  app.env.QUICKBOOKS_OAUTH_ONLY_MODE = true;
  app.env.QUICKBOOKS_RECONCILIATION_WORKER_ENABLED = false;
  app.env.QUICKBOOKS_CDC_WORKER_ENABLED = false;
}

function useReconciliationPhase() {
  app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED = true;
  app.env.QUICKBOOKS_OAUTH_ONLY_MODE = false;
  app.env.QUICKBOOKS_RECONCILIATION_WORKER_ENABLED = true;
  app.env.QUICKBOOKS_CDC_WORKER_ENABLED = false;
}

function useCdcPhase() {
  useReconciliationPhase();
  app.env.QUICKBOOKS_CDC_WORKER_ENABLED = true;
}

async function createTenant(label: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return prisma.tenant.create({
    data: { name: `${label} Services`, slug: `${label.toLowerCase()}-${stamp}` },
  });
}

async function createCdcConnection(
  label: string,
  options: {
    status: "CONNECTED" | "DISCONNECTED";
    confirmed: boolean;
    changedSinceUtc: Date;
    terminalAtUtc?: Date;
    nextAttemptAtUtc?: Date;
  },
) {
  const tenant = await createTenant(label);
  let membershipId: string | undefined;
  if (options.confirmed) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({
      data: {
        email: `${label.toLowerCase()}-${stamp}@example.com`,
        fullName: `${label} Owner`,
        passwordHash: "synthetic-test-hash",
      },
    });
    const membership = await prisma.tenantUser.create({
      data: { tenantId: tenant.id, userId: user.id, role: "owner" },
    });
    membershipId = membership.id;
  }
  const connection = await prisma.quickBooksConnection.create({
    data: {
      tenantId: tenant.id,
      realmId: `realm-${label.toLowerCase()}-${tenant.id}`,
      environment: "sandbox",
      status: options.status,
      ...(options.confirmed
        ? {
            setupConfirmedAtUtc: new Date(),
            setupConfirmedByTenantUserId: membershipId,
            setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
          }
        : {}),
    },
  });
  const cursor = await prisma.quickBooksCdcCursor.create({
    data: {
      tenantId: tenant.id,
      quickBooksConnectionId: connection.id,
      changedSinceUtc: options.changedSinceUtc,
      terminalAtUtc: options.terminalAtUtc,
      nextAttemptAtUtc: options.nextAttemptAtUtc,
    },
  });
  return { tenant, connection, cursor };
}

async function createWebhookEvent(
  connection: { id: string; tenantId: string; realmId: string },
  label: string,
  options: {
    status: "RECEIVED" | "FAILED" | "PROCESSING";
    receivedAtUtc: Date;
    nextAttemptAtUtc?: Date;
    claimExpiresAtUtc?: Date;
  },
) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return prisma.quickBooksWebhookEvent.create({
    data: {
      tenantId: connection.tenantId,
      quickBooksConnectionId: connection.id,
      webhookEventId: `monitor-${label}-${stamp}`,
      realmId: connection.realmId,
      eventType: "Invoice",
      entityId: `invoice-${label}`,
      operation: "Update",
      payload: { fixture: true },
      status: options.status,
      receivedAtUtc: options.receivedAtUtc,
      nextAttemptAtUtc: options.nextAttemptAtUtc,
      claimExpiresAtUtc: options.claimExpiresAtUtc,
    },
  });
}

describe("QuickBooks content-free operational monitors", () => {
  beforeAll(() => {
    originalRuntime = {
      monitorBearer: env.QUICKBOOKS_MONITOR_BEARER,
      providerWorkflowsEnabled: env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED,
      oauthOnlyMode: env.QUICKBOOKS_OAUTH_ONLY_MODE,
      reconciliationWorkerEnabled: env.QUICKBOOKS_RECONCILIATION_WORKER_ENABLED,
      cdcWorkerEnabled: env.QUICKBOOKS_CDC_WORKER_ENABLED,
    };
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    monitorBearerSequence += 1;
    MONITOR_BEARER = `quotefly-integration-monitor-bearer-v1-${monitorBearerSequence}`;
    Object.assign(env, {
      QUICKBOOKS_MONITOR_BEARER: MONITOR_BEARER,
      QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: true,
      QUICKBOOKS_OAUTH_ONLY_MODE: true,
      QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: false,
      QUICKBOOKS_CDC_WORKER_ENABLED: false,
    });
    app = buildServer();
    await app.ready();
    useOauthOnlyPhase();
    await prisma.workerHeartbeatInstance.deleteMany({
      where: { workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY },
    });
    await prisma.workerHeartbeat.deleteMany({
      where: { workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY },
    });
    await prisma.quickBooksWebhookEvent.deleteMany();
    await prisma.tenant.deleteMany();
    await prisma.user.deleteMany();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  afterAll(async () => {
    Object.assign(env, {
      QUICKBOOKS_MONITOR_BEARER: originalRuntime.monitorBearer,
      QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: originalRuntime.providerWorkflowsEnabled,
      QUICKBOOKS_OAUTH_ONLY_MODE: originalRuntime.oauthOnlyMode,
      QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: originalRuntime.reconciliationWorkerEnabled,
      QUICKBOOKS_CDC_WORKER_ENABLED: originalRuntime.cdcWorkerEnabled,
    });
    await prisma.$disconnect();
  });

  test("accepts only the independent Authorization bearer and never authenticates from a query", async () => {
    const privateValue = "must-never-appear-in-monitor-response";
    const requests = [
      await monitorRequest(WARNING_URL),
      await monitorRequest(`${WARNING_URL}?token=${encodeURIComponent(MONITOR_BEARER)}`),
      await monitorRequest(WARNING_URL, { authorization: `Bearer ${privateValue}` }),
    ];
    for (const response of requests) {
      expect(response.statusCode).toBe(401);
      expect(response.body).toBe("");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toContain(MONITOR_BEARER);
      expect(response.body).not.toContain(privateValue);
    }

    const allowed = await monitorRequest(WARNING_URL, {
      authorization: `Bearer ${MONITOR_BEARER}`,
    });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.body).toBe("");
    expect(allowed.headers["cache-control"]).toBe("no-store");
  });

  test("fails closed and content-free when the API monitor bearer is not configured", async () => {
    app.env.QUICKBOOKS_MONITOR_BEARER = "";
    const response = await monitorRequest(CRITICAL_URL, {
      authorization: `Bearer ${MONITOR_BEARER}`,
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).toBe("");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  test("does not require a heartbeat in OAuth-only but requires one in reconciliation", async () => {
    const oauthOnly = await monitorRequest(CRITICAL_URL, {
      authorization: `Bearer ${MONITOR_BEARER}`,
    });
    expect(oauthOnly.statusCode).toBe(204);

    useReconciliationPhase();
    const missingWorker = await monitorRequest(CRITICAL_URL, {
      authorization: `Bearer ${MONITOR_BEARER}`,
    });
    expect(missingWorker.statusCode).toBe(503);
    expect(missingWorker.body).toBe("");

    const heartbeatAtUtc = new Date();
    await recordWorkerHeartbeat(prisma, {
      workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      instanceRefHash: "9".repeat(64),
      status: "RUNNING",
      startedAtUtc: heartbeatAtUtc,
      cycleStartedAtUtc: heartbeatAtUtc,
      heartbeatAtUtc,
      metrics: workerOperationalMetrics(heartbeatAtUtc),
    });
    const ready = await monitorRequest(CRITICAL_URL, {
      authorization: `Bearer ${MONITOR_BEARER}`,
    });
    expect(ready.statusCode).toBe(204);
    expect(ready.body).toBe("");
  });

  test("separates the five-minute warning from the fifteen-minute critical queue threshold", async () => {
    const fixture = await createCdcConnection("MonitorQueue", {
      status: "CONNECTED",
      confirmed: true,
      changedSinceUtc: new Date(),
    });
    const tenant = fixture.tenant;
    const realmId = "realm-monitor-private";
    const connection = await prisma.quickBooksConnection.update({
      where: { id: fixture.connection.id },
      data: { realmId },
    });
    const event = await prisma.quickBooksWebhookEvent.create({
      data: {
        tenantId: tenant.id,
        quickBooksConnectionId: connection.id,
        webhookEventId: "monitor-warning-event",
        realmId,
        eventType: "Invoice",
        entityId: "invoice-monitor-warning",
        operation: "Update",
        payload: { privateValue: "monitor-payload-must-not-render" },
        status: "FAILED",
        nextAttemptAtUtc: new Date(Date.now() - 1_000),
        receivedAtUtc: new Date(Date.now() - 6 * 60 * 1_000),
      },
    });

    const warning = await monitorRequest(WARNING_URL, {
      authorization: `Bearer ${MONITOR_BEARER}`,
    });
    const notCritical = await monitorRequest(CRITICAL_URL, {
      authorization: `Bearer ${MONITOR_BEARER}`,
    });
    expect(warning.statusCode).toBe(503);
    expect(notCritical.statusCode).toBe(204);
    expect(warning.body).toBe("");
    expect(notCritical.body).toBe("");

    await prisma.quickBooksWebhookEvent.update({
      where: { id: event.id },
      data: { receivedAtUtc: new Date(Date.now() - 16 * 60 * 1_000) },
    });
    const critical = await monitorRequest(CRITICAL_URL, {
      authorization: `Bearer ${MONITOR_BEARER}`,
    });
    expect(critical.statusCode).toBe(503);
    expect(critical.body).toBe("");
    expect(critical.body).not.toContain(realmId);
    expect(critical.body).not.toContain("monitor-payload-must-not-render");
  });

  test("ignores webhook work until its connection and retry lease are worker-eligible", async () => {
    const oldAtUtc = new Date(Date.now() - 30 * 60 * 1_000);
    const unconfirmed = await createCdcConnection("MonitorWebhookUnconfirmed", {
      status: "CONNECTED",
      confirmed: false,
      changedSinceUtc: new Date(),
    });
    await createWebhookEvent(unconfirmed.connection, "unconfirmed", {
      status: "RECEIVED",
      receivedAtUtc: oldAtUtc,
    });
    const disconnected = await createCdcConnection("MonitorWebhookDisconnected", {
      status: "DISCONNECTED",
      confirmed: true,
      changedSinceUtc: new Date(),
    });
    await createWebhookEvent(disconnected.connection, "disconnected", {
      status: "RECEIVED",
      receivedAtUtc: oldAtUtc,
    });
    const scheduled = await createCdcConnection("MonitorWebhookScheduled", {
      status: "CONNECTED",
      confirmed: true,
      changedSinceUtc: new Date(),
    });
    const scheduledEvent = await createWebhookEvent(scheduled.connection, "scheduled", {
      status: "FAILED",
      receivedAtUtc: new Date(Date.now() - 6 * 60 * 1_000),
      nextAttemptAtUtc: new Date(Date.now() + 10 * 60 * 1_000),
    });
    const leased = await createCdcConnection("MonitorWebhookLeased", {
      status: "CONNECTED",
      confirmed: true,
      changedSinceUtc: new Date(),
    });
    await createWebhookEvent(leased.connection, "leased", {
      status: "PROCESSING",
      receivedAtUtc: oldAtUtc,
      claimExpiresAtUtc: new Date(Date.now() + 10 * 60 * 1_000),
    });

    const ignoredWarning = await monitorRequest(WARNING_URL, {
      authorization: `Bearer ${MONITOR_BEARER}`,
    });
    const ignoredCritical = await monitorRequest(CRITICAL_URL, {
      authorization: `Bearer ${MONITOR_BEARER}`,
    });
    expect(ignoredWarning.statusCode).toBe(204);
    expect(ignoredCritical.statusCode).toBe(204);

    await prisma.quickBooksWebhookEvent.update({
      where: { id: scheduledEvent.id },
      data: { nextAttemptAtUtc: new Date(Date.now() - 1_000) },
    });
    const dueWarning = await monitorRequest(WARNING_URL, {
      authorization: `Bearer ${MONITOR_BEARER}`,
    });
    const dueNotCritical = await monitorRequest(CRITICAL_URL, {
      authorization: `Bearer ${MONITOR_BEARER}`,
    });
    expect(dueWarning.statusCode).toBe(503);
    expect(dueNotCritical.statusCode).toBe(204);
  });

  test("treats durable reauthorization state as immediately critical without leaking connection data", async () => {
    const tenant = await createTenant("MonitorReauth");
    const privateRealm = "realm-reauth-must-not-render";
    await prisma.quickBooksConnection.create({
      data: {
        tenantId: tenant.id,
        realmId: privateRealm,
        environment: "sandbox",
        status: "NEEDS_REAUTH",
        tokenRefreshFailureStartedAtUtc: new Date(),
        lastError: "QUICKBOOKS_REAUTH_REQUIRED",
      },
    });
    const response = await monitorRequest(CRITICAL_URL, {
      authorization: `Bearer ${MONITOR_BEARER}`,
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).toBe("");
    expect(response.body).not.toContain(privateRealm);
    expect(response.body).not.toContain("QUICKBOOKS_REAUTH_REQUIRED");
  });

  test("alerts only for CDC cursors eligible for the enabled worker phase", async () => {
    useCdcPhase();
    const heartbeatAtUtc = new Date();
    await recordWorkerHeartbeat(prisma, {
      workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      instanceRefHash: "8".repeat(64),
      status: "RUNNING",
      startedAtUtc: heartbeatAtUtc,
      cycleStartedAtUtc: heartbeatAtUtc,
      heartbeatAtUtc,
      metrics: workerOperationalMetrics(heartbeatAtUtc),
    });
    const oldCursorAtUtc = new Date(Date.now() - 30 * 60 * 1_000);
    await createCdcConnection("MonitorUnconfirmedCdc", {
      status: "CONNECTED",
      confirmed: false,
      changedSinceUtc: oldCursorAtUtc,
    });
    await createCdcConnection("MonitorDisconnectedCdc", {
      status: "DISCONNECTED",
      confirmed: true,
      changedSinceUtc: oldCursorAtUtc,
      terminalAtUtc: new Date(),
    });
    await createCdcConnection("MonitorScheduledCdc", {
      status: "CONNECTED",
      confirmed: true,
      changedSinceUtc: oldCursorAtUtc,
      nextAttemptAtUtc: new Date(Date.now() + 30 * 60 * 1_000),
    });
    const eligible = await createCdcConnection("MonitorEligibleCdc", {
      status: "CONNECTED",
      confirmed: true,
      changedSinceUtc: new Date(Date.now() - 60 * 1_000),
    });

    const ignoredWarning = await monitorRequest(WARNING_URL, {
      authorization: `Bearer ${MONITOR_BEARER}`,
    });
    const ignoredCritical = await monitorRequest(CRITICAL_URL, {
      authorization: `Bearer ${MONITOR_BEARER}`,
    });
    expect(ignoredWarning.statusCode).toBe(204);
    expect(ignoredCritical.statusCode).toBe(204);

    await prisma.quickBooksCdcCursor.update({
      where: { id: eligible.cursor.id },
      data: { changedSinceUtc: new Date(Date.now() - 11 * 60 * 1_000) },
    });
    const eligibleWarning = await monitorRequest(WARNING_URL, {
      authorization: `Bearer ${MONITOR_BEARER}`,
    });
    const eligibleNotCritical = await monitorRequest(CRITICAL_URL, {
      authorization: `Bearer ${MONITOR_BEARER}`,
    });
    expect(eligibleWarning.statusCode).toBe(503);
    expect(eligibleNotCritical.statusCode).toBe(204);

    await prisma.quickBooksCdcCursor.update({
      where: { id: eligible.cursor.id },
      data: { terminalAtUtc: new Date() },
    });
    const terminalCritical = await monitorRequest(CRITICAL_URL, {
      authorization: `Bearer ${MONITOR_BEARER}`,
    });
    expect(terminalCritical.statusCode).toBe(503);
    expect(terminalCritical.body).toBe("");
  });

  test("reduces operational health across every fresh worker instance", async () => {
    useReconciliationPhase();
    const degradedStartedAtUtc = new Date(Date.now() - 1_000);
    await recordWorkerHeartbeat(prisma, {
      workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      instanceRefHash: "6".repeat(64),
      status: "RUNNING",
      startedAtUtc: degradedStartedAtUtc,
      cycleStartedAtUtc: degradedStartedAtUtc,
      heartbeatAtUtc: new Date(),
      metrics: workerOperationalMetrics(degradedStartedAtUtc, {
        callCount: 3,
        failureCount: 3,
        timeoutCount: 3,
        degradedCallCount: 3,
        maximumDurationMs: 100,
      }),
    });
    const healthyStartedAtUtc = new Date();
    await recordWorkerHeartbeat(prisma, {
      workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      instanceRefHash: "7".repeat(64),
      status: "RUNNING",
      startedAtUtc: healthyStartedAtUtc,
      cycleStartedAtUtc: healthyStartedAtUtc,
      heartbeatAtUtc: healthyStartedAtUtc,
      metrics: workerOperationalMetrics(healthyStartedAtUtc),
    });

    const response = await monitorRequest(CRITICAL_URL, {
      authorization: `Bearer ${MONITOR_BEARER}`,
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).toBe("");
  });

  test("keeps worker topology and operational rows on one repeatable database snapshot", async () => {
    useReconciliationPhase();
    const baselineStartedAtUtc = new Date();
    await recordWorkerHeartbeat(prisma, {
      workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      instanceRefHash: "c".repeat(64),
      status: "RUNNING",
      startedAtUtc: baselineStartedAtUtc,
      cycleStartedAtUtc: baselineStartedAtUtc,
      heartbeatAtUtc: baselineStartedAtUtc,
      metrics: workerOperationalMetrics(baselineStartedAtUtc),
    });

    const concurrentPrisma = new PrismaClient();
    try {
      const frozen = await prisma.$transaction(async (transaction) => {
        const workerFleet = await loadWorkerHeartbeatFleet(
          transaction,
          QUICKBOOKS_RECONCILIATION_WORKER_KEY,
          { apiReleaseSha: null, requireReleaseIdentity: false },
        );
        expect(workerFleet.counts.freshLiveInstanceCount).toBe(1);

        const overlappingStartedAtUtc = new Date(baselineStartedAtUtc.getTime() - 1_000);
        await concurrentPrisma.workerHeartbeatInstance.create({
          data: {
            workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
            instanceRefHash: "d".repeat(64),
            status: "RUNNING",
            startedAtUtc: overlappingStartedAtUtc,
            cycleStartedAtUtc: overlappingStartedAtUtc,
            heartbeatAtUtc: baselineStartedAtUtc,
            observedAtUtc: baselineStartedAtUtc,
            lastCycleDurationMs: null,
            releaseSha: null,
            metrics: workerOperationalMetrics(overlappingStartedAtUtc),
            updatedAt: baselineStartedAtUtc,
          },
        });

        const workerOperationalInstances = await loadFreshQuickBooksWorkerOperationalInstances(transaction);
        return { workerFleet, workerOperationalInstances };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

      expect(frozen.workerOperationalInstances).toHaveLength(
        frozen.workerFleet.counts.freshLiveInstanceCount,
      );
      const afterCommit = await loadQuickBooksWorkerOperationalState(prisma, {
        apiReleaseSha: null,
        requireReleaseIdentity: false,
      });
      expect(afterCommit.workerFleet.counts.freshLiveInstanceCount).toBe(2);
      expect(afterCommit.workerOperationalInstances).toHaveLength(2);
    } finally {
      await concurrentPrisma.$disconnect();
    }
  });

  test("fails closed and content-free for malformed worker operational health", async () => {
    useReconciliationPhase();
    const heartbeatAtUtc = new Date();
    await recordWorkerHeartbeat(prisma, {
      workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY,
      instanceRefHash: "5".repeat(64),
      status: "RUNNING",
      startedAtUtc: heartbeatAtUtc,
      cycleStartedAtUtc: heartbeatAtUtc,
      heartbeatAtUtc,
      metrics: {},
    });
    const response = await monitorRequest(WARNING_URL, {
      authorization: `Bearer ${MONITOR_BEARER}`,
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).toBe("");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  test("fails closed without returning a database error", async () => {
    vi.spyOn(app.prisma.tenant, "findMany").mockRejectedValueOnce(
      new Error("database-user@private-host must not render"),
    );
    const response = await monitorRequest(CRITICAL_URL, {
      authorization: `Bearer ${MONITOR_BEARER}`,
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).toBe("");
    expect(response.body).not.toContain("database-user");
    expect(response.body).not.toContain("private-host");
  });

  test("applies one authenticated shared quota across tiers despite forged forwarding identities", async () => {
    for (let index = 0; index < 8; index += 1) {
      const rejected = await monitorRequest(WARNING_URL, {
        authorization: "Bearer invalid-monitor-credential-with-sufficient-length",
        remoteAddress: nextRemoteAddress(),
        forwardedFor: `2001:db8:${index.toString(16)}::1, 198.51.100.${index + 1}`,
      });
      expect(rejected.statusCode).toBe(401);
    }

    for (let index = 0; index < 6; index += 1) {
      const response = await monitorRequest(index % 2 === 0 ? WARNING_URL : CRITICAL_URL, {
        authorization: `Bearer ${MONITOR_BEARER}`,
        remoteAddress: nextRemoteAddress(),
        forwardedFor: `2001:db8:${index.toString(16)}::2, 203.0.113.${index + 1}`,
      });
      expect(response.statusCode).toBe(204);
    }
    const limited = await monitorRequest(WARNING_URL, {
      authorization: `Bearer ${MONITOR_BEARER}`,
      remoteAddress: nextRemoteAddress(),
      forwardedFor: "::ffff:192.0.2.10, 198.51.100.200",
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.body).toBe("");
    expect(limited.headers["cache-control"]).toBe("no-store");
  });
});
