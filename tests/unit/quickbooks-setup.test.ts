import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  QUICKBOOKS_ACCOUNTING_SCOPE,
  QUICKBOOKS_SETUP_CHECKLIST_VERSION,
  deriveQuickBooksSetupReadiness,
  type QuickBooksSetupConnectionState,
  type QuickBooksSetupRuntime,
} from "../../src/services/quickbooks-setup.js";
import {
  isTrustedQuickBooksAuthorizationUrl,
  normalizeQuickBooksStatusPayload,
} from "../../web/src/lib/quickbooks.js";
import {
  compareRuntimeReleaseShas,
  releaseShaFromMetrics,
  resolveRuntimeReleaseSha,
} from "../../src/lib/release-identity.js";

const runtime: QuickBooksSetupRuntime = {
  providerConfigured: true,
  providerWorkflowsEnabled: true,
  webhookConfigured: true,
  hostedPaymentsEnabled: true,
  reconciliationWorkerEnabled: true,
  reconciliationWorkerHealthy: true,
  cdcWorkerEnabled: true,
  environment: "sandbox",
};

describe("QuickBooks runtime release identity", () => {
  const releaseSha = "a".repeat(40);

  it("uses only valid explicit or provider-injected commit identities", () => {
    assert.equal(resolveRuntimeReleaseSha({ RAILWAY_GIT_COMMIT_SHA: releaseSha.toUpperCase() }), releaseSha);
    assert.equal(resolveRuntimeReleaseSha({ RENDER_GIT_COMMIT: releaseSha }), releaseSha);
    assert.equal(resolveRuntimeReleaseSha({ QUOTEFLY_RELEASE_SHA: "not-a-sha", RAILWAY_GIT_COMMIT_SHA: releaseSha }), releaseSha);
    assert.equal(resolveRuntimeReleaseSha({ QUOTEFLY_RELEASE_SHA: releaseSha }), releaseSha);
    assert.equal(resolveRuntimeReleaseSha({ QUOTEFLY_RELEASE_SHA: releaseSha, RAILWAY_GIT_COMMIT_SHA: releaseSha }), releaseSha);
    assert.throws(
      () => resolveRuntimeReleaseSha({
        QUOTEFLY_RELEASE_SHA: releaseSha,
        RAILWAY_GIT_COMMIT_SHA: "b".repeat(40),
      }),
      /runtime release identities conflict/,
    );
    assert.throws(
      () => resolveRuntimeReleaseSha({
        RAILWAY_GIT_COMMIT_SHA: releaseSha,
        RENDER_GIT_COMMIT: "b".repeat(40),
      }),
      /runtime release identities are configured/,
    );
    assert.throws(
      () => resolveRuntimeReleaseSha({
        QUOTEFLY_RELEASE_SHA: releaseSha,
        RAILWAY_GIT_COMMIT_SHA: "not-a-provider-sha",
      }),
      /provider runtime release identity is malformed/,
    );
    assert.equal(resolveRuntimeReleaseSha({ GITHUB_SHA: releaseSha }), null);
  });

  it("compares the API and worker heartbeat without trusting malformed metrics", () => {
    assert.equal(releaseShaFromMetrics({ releaseSha }), releaseSha);
    assert.equal(releaseShaFromMetrics({ releaseSha: "short" }), null);
    assert.equal(releaseShaFromMetrics([releaseSha]), null);
    assert.equal(compareRuntimeReleaseShas(releaseSha, releaseSha), true);
    assert.equal(compareRuntimeReleaseShas(releaseSha, "b".repeat(40)), false);
    assert.equal(compareRuntimeReleaseShas(releaseSha, null), null);
  });
});

function connection(overrides: Partial<QuickBooksSetupConnectionState> = {}): QuickBooksSetupConnectionState {
  return {
    status: "CONNECTED",
    environment: "sandbox",
    scopes: [QUICKBOOKS_ACCOUNTING_SCOPE],
    accessTokenEncrypted: "encrypted-access",
    refreshTokenEncrypted: "encrypted-refresh",
    accessTokenExpiresAtUtc: new Date(Date.now() + 60_000),
    setupConfirmedAtUtc: null,
    setupConfirmedByTenantUserId: null,
    setupChecklistVersion: null,
    realmBinding: { active: true },
    cdcCursor: { id: "cdc" },
    ...overrides,
  };
}

describe("QuickBooks setup readiness", () => {
  it("moves through every authoritative setup phase", () => {
    assert.equal(deriveQuickBooksSetupReadiness({ ...runtime, providerConfigured: false }, null).phase, "UNAVAILABLE");
    assert.equal(deriveQuickBooksSetupReadiness(runtime, null).phase, "NOT_CONNECTED");
    assert.equal(deriveQuickBooksSetupReadiness(runtime, connection({ realmBinding: null })).phase, "ACTION_REQUIRED");
    assert.equal(deriveQuickBooksSetupReadiness(runtime, connection()).phase, "READY_FOR_CONFIRMATION");

    const confirmed = deriveQuickBooksSetupReadiness(runtime, connection({
      setupConfirmedAtUtc: new Date(),
      setupConfirmedByTenantUserId: "membership",
      setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
    }));
    assert.equal(confirmed.phase, "CONFIRMED");
    assert.equal(confirmed.ready, true);
    assert.deepEqual(confirmed.operations, {
      coreConnectionReady: true,
      hostedPaymentsReady: true,
      reconciliationReady: true,
      cdcRecoveryReady: true,
      allAccountingWorkflowsReady: true,
    });
  });

  it("keeps core confirmation separate from optional payment and recovery operations", () => {
    const confirmedConnection = connection({
      setupConfirmedAtUtc: new Date(),
      setupConfirmedByTenantUserId: "membership",
      setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
    });
    const coreOnly = deriveQuickBooksSetupReadiness({
      ...runtime,
      webhookConfigured: false,
      hostedPaymentsEnabled: false,
      reconciliationWorkerEnabled: false,
      cdcWorkerEnabled: false,
    }, confirmedConnection);
    assert.equal(coreOnly.phase, "CONFIRMED");
    assert.equal(coreOnly.ready, true);
    assert.deepEqual(coreOnly.operations, {
      coreConnectionReady: true,
      hostedPaymentsReady: false,
      reconciliationReady: false,
      cdcRecoveryReady: false,
      allAccountingWorkflowsReady: false,
    });

    const reconciliationOnly = deriveQuickBooksSetupReadiness({
      ...runtime,
      hostedPaymentsEnabled: false,
      cdcWorkerEnabled: false,
    }, confirmedConnection);
    assert.equal(reconciliationOnly.operations.reconciliationReady, true);
    assert.equal(reconciliationOnly.operations.hostedPaymentsReady, false);
    assert.equal(reconciliationOnly.operations.cdcRecoveryReady, false);
  });

  it("does not report reconciliation or hosted payments ready when the worker heartbeat is stale", () => {
    const result = deriveQuickBooksSetupReadiness({
      ...runtime,
      reconciliationWorkerHealthy: false,
    }, connection({
      setupConfirmedAtUtc: new Date(),
      setupConfirmedByTenantUserId: "membership",
      setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
    }));

    assert.equal(result.ready, true);
    assert.equal(result.operations.reconciliationReady, false);
    assert.equal(result.operations.hostedPaymentsReady, false);
    assert.equal(result.operations.cdcRecoveryReady, false);
    assert.equal(
      result.checks.find((check) => check.key === "RECONCILIATION_WORKER_HEALTHY")?.passed,
      false,
    );
  });

  it("invalidates confirmation when the checklist version changes", () => {
    const result = deriveQuickBooksSetupReadiness(runtime, connection({
      setupConfirmedAtUtc: new Date(),
      setupConfirmedByTenantUserId: "membership",
      setupChecklistVersion: "obsolete",
    }));
    assert.equal(result.phase, "READY_FOR_CONFIRMATION");
    assert.equal(result.confirmed, false);
  });

  it("allows OAuth connection proof without exposing accounting operations", () => {
    const result = deriveQuickBooksSetupReadiness({
      ...runtime,
      oauthOnlyMode: true,
      webhookConfigured: false,
      hostedPaymentsEnabled: false,
      reconciliationWorkerEnabled: false,
      reconciliationWorkerHealthy: false,
      cdcWorkerEnabled: false,
    }, connection());

    assert.equal(result.phase, "CONNECTION_VERIFIED");
    assert.equal(result.capabilities.canConnect, false);
    assert.equal(result.capabilities.canReconnect, true);
    assert.equal(result.capabilities.canConfirm, false);
    assert.equal(result.operations.coreConnectionReady, false);
    assert.equal(result.operations.allAccountingWorkflowsReady, false);
    assert.equal(
      result.checks.find((check) => check.key === "ACCOUNTING_WORKFLOWS_ENABLED")?.passed,
      false,
    );
  });

  it("only exposes lifecycle actions that the connection state can safely perform", () => {
    const cases: Array<[QuickBooksSetupConnectionState["status"], boolean, boolean, boolean]> = [
      ["CONNECTED", false, true, true],
      ["NEEDS_REAUTH", false, true, true],
      ["REVOCATION_PENDING", false, false, true],
      ["ERROR", false, false, false],
      ["DISCONNECTED", true, false, false],
    ];

    for (const [status, canConnect, canReconnect, canDisconnect] of cases) {
      assert.deepEqual(deriveQuickBooksSetupReadiness(runtime, connection({ status })).capabilities, {
        canConnect,
        canReconnect,
        canConfirm: status === "CONNECTED",
        canDisconnect,
      });
    }
  });

  it("presents a previously confirmed connection as connection-only when accounting workflows are paused", () => {
    const result = deriveQuickBooksSetupReadiness({
      ...runtime,
      oauthOnlyMode: true,
    }, connection({
      setupConfirmedAtUtc: new Date(),
      setupConfirmedByTenantUserId: "membership",
      setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
    }));

    assert.equal(result.phase, "CONNECTION_VERIFIED");
    assert.equal(result.confirmed, false);
    assert.equal(result.ready, false);
    assert.equal(result.capabilities.canConfirm, false);
  });
});

describe("QuickBooks authorization URL trust boundary", () => {
  it("only accepts the exact Intuit HTTPS authorization endpoint", () => {
    assert.equal(isTrustedQuickBooksAuthorizationUrl("https://appcenter.intuit.com/connect/oauth2?client_id=qf&state=signed"), true);
    assert.equal(isTrustedQuickBooksAuthorizationUrl("http://appcenter.intuit.com/connect/oauth2"), false);
    assert.equal(isTrustedQuickBooksAuthorizationUrl("https://appcenter.intuit.com.evil.test/connect/oauth2"), false);
    assert.equal(isTrustedQuickBooksAuthorizationUrl("https://user@appcenter.intuit.com/connect/oauth2"), false);
    assert.equal(isTrustedQuickBooksAuthorizationUrl("https://appcenter.intuit.com/connect/oauth2#redirect"), false);
    assert.equal(isTrustedQuickBooksAuthorizationUrl("not-a-url"), false);
  });
});

describe("QuickBooks Settings status normalization", () => {
  function statusPayload(
    runtimeOverrides: Partial<QuickBooksSetupRuntime> = {},
    connectionOverrides: Partial<QuickBooksSetupConnectionState> | null = {},
  ) {
    const configuredRuntime = {
      ...runtime,
      ...runtimeOverrides,
      ...(runtimeOverrides.oauthOnlyMode === true
        ? {
            hostedPaymentsEnabled: runtimeOverrides.hostedPaymentsEnabled ?? false,
            reconciliationWorkerEnabled: runtimeOverrides.reconciliationWorkerEnabled ?? false,
            reconciliationWorkerHealthy: runtimeOverrides.reconciliationWorkerHealthy ?? false,
            cdcWorkerEnabled: runtimeOverrides.cdcWorkerEnabled ?? false,
          }
        : {}),
    };
    const configuredConnection = connectionOverrides === null ? null : connection(connectionOverrides);
    const setup = deriveQuickBooksSetupReadiness(configuredRuntime, configuredConnection);
    return {
      enabled: configuredRuntime.providerConfigured && configuredRuntime.providerWorkflowsEnabled,
      configured: configuredRuntime.providerConfigured,
      providerWorkflowsEnabled: configuredRuntime.providerWorkflowsEnabled,
      oauthOnlyMode: configuredRuntime.oauthOnlyMode ?? false,
      webhookConfigured: configuredRuntime.webhookConfigured,
      canManage: true,
      environment: configuredRuntime.environment,
      reconciliationWorker: configuredRuntime.reconciliationWorkerHealthy === true
        ? { status: "RUNNING" as const, fresh: true, heartbeatAtUtc: "2026-09-04T12:00:00.000Z" }
        : null,
      releaseMatches: null,
      setup: {
        ...setup,
        confirmedAtUtc: setup.confirmedAtUtc?.toISOString() ?? null,
      },
      connection: configuredConnection === null ? null : {
        environment: configuredConnection.environment,
        companyName: "QuoteFly Sandbox",
        status: configuredConnection.status as "CONNECTED",
        connectedAtUtc: "2026-09-04T12:00:00.000Z",
        disconnectedAtUtc: null,
        lastTokenRefreshAtUtc: null,
        lastSyncAtUtc: null,
        lastWebhookAtUtc: null,
        counts: { customerMaps: 0, itemMaps: 0, invoiceSyncs: 0 },
      },
    };
  }

  it("accepts every canonical setup phase, including degraded and OAuth-only states", () => {
    const confirmedConnection = {
      setupConfirmedAtUtc: new Date("2026-09-04T12:00:00.000Z"),
      setupConfirmedByTenantUserId: "membership",
      setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
    };
    const cases = [
      ["UNAVAILABLE", statusPayload({
        providerConfigured: false,
        providerWorkflowsEnabled: false,
        webhookConfigured: false,
        hostedPaymentsEnabled: false,
        reconciliationWorkerEnabled: false,
        reconciliationWorkerHealthy: false,
        cdcWorkerEnabled: false,
      }, null)],
      ["NOT_CONNECTED", statusPayload({}, null)],
      ["ACTION_REQUIRED", statusPayload({}, { realmBinding: null })],
      ["CONNECTION_VERIFIED", statusPayload({ oauthOnlyMode: true })],
      ["READY_FOR_CONFIRMATION", statusPayload()],
      ["CONFIRMED", statusPayload({}, confirmedConnection)],
    ] as const;

    for (const [phase, payload] of cases) {
      assert.equal(payload.setup.phase, phase);
      assert.deepEqual(normalizeQuickBooksStatusPayload(payload), payload);
    }
  });

  it("rejects every status contradiction that could overstate readiness", () => {
    const ready = statusPayload();
    const confirmed = statusPayload({}, {
      setupConfirmedAtUtc: new Date("2026-09-04T12:00:00.000Z"),
      setupConfirmedByTenantUserId: "membership",
      setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
    });
    const oauthOnly = statusPayload({ oauthOnlyMode: true });
    const noHosted = statusPayload({ hostedPaymentsEnabled: false }, {
      setupConfirmedAtUtc: new Date("2026-09-04T12:00:00.000Z"),
      setupConfirmedByTenantUserId: "membership",
      setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
    });
    const noReconciliation = statusPayload({ webhookConfigured: false }, {
      setupConfirmedAtUtc: new Date("2026-09-04T12:00:00.000Z"),
      setupConfirmedByTenantUserId: "membership",
      setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
    });
    const unhealthyWorker = statusPayload({ reconciliationWorkerHealthy: false }, {
      setupConfirmedAtUtc: new Date("2026-09-04T12:00:00.000Z"),
      setupConfirmedByTenantUserId: "membership",
      setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
    });
    const notConnected = statusPayload({}, null);
    const confirmedNeedsReauth = {
      ...confirmed,
      connection: { ...confirmed.connection!, status: "NEEDS_REAUTH" },
      setup: {
        ...confirmed.setup,
        checks: confirmed.setup.checks.map((check) => check.key === "CONNECTION_ACTIVE" ? { ...check, passed: false } : check),
      },
    };
    const invalidPayloads: unknown[] = [
      { ...ready, setup: undefined },
      { ...ready, setup: { ...ready.setup, checks: ready.setup.checks.slice(1) } },
      { ...ready, setup: { ...ready.setup, checks: [...ready.setup.checks, ready.setup.checks[0]] } },
      { ...ready, setup: { ...ready.setup, checks: [...ready.setup.checks].reverse() } },
      { ...ready, setup: { ...ready.setup, checklistVersion: "obsolete" } },
      { ...ready, connection: null },
      { ...confirmed, connection: { ...confirmed.connection!, status: "NEEDS_REAUTH" } },
      confirmedNeedsReauth,
      { ...confirmed, setup: { ...confirmed.setup, ready: false } },
      { ...confirmed, setup: { ...confirmed.setup, operations: { ...confirmed.setup.operations, coreConnectionReady: false } } },
      {
        ...confirmed,
        setup: {
          ...confirmed.setup,
          checks: confirmed.setup.checks.map((check) => check.key === "SETUP_CONFIRMED" ? { ...check, passed: false } : check),
        },
      },
      { ...ready, setup: { ...ready.setup, capabilities: { ...ready.setup.capabilities, canConnect: true } } },
      { ...oauthOnly, setup: { ...oauthOnly.setup, operations: { ...oauthOnly.setup.operations, coreConnectionReady: true } } },
      {
        ...oauthOnly,
        setup: {
          ...oauthOnly.setup,
          checks: oauthOnly.setup.checks.map((check) => check.key === "SETUP_CONFIRMED" ? { ...check, passed: true } : check),
        },
      },
      { ...noReconciliation, setup: { ...noReconciliation.setup, operations: { ...noReconciliation.setup.operations, reconciliationReady: true } } },
      { ...noReconciliation, setup: { ...noReconciliation.setup, operations: { ...noReconciliation.setup.operations, hostedPaymentsReady: true } } },
      { ...noReconciliation, setup: { ...noReconciliation.setup, operations: { ...noReconciliation.setup.operations, cdcRecoveryReady: true } } },
      { ...noHosted, setup: { ...noHosted.setup, operations: { ...noHosted.setup.operations, allAccountingWorkflowsReady: true } } },
      { ...ready, oauthOnlyMode: "false" },
      { ...ready, canManage: false },
      { ...ready, reconciliationWorker: null },
      { ...ready, reconciliationWorker: { ...ready.reconciliationWorker!, fresh: false } },
      { ...ready, reconciliationWorker: { ...ready.reconciliationWorker!, status: "STOPPING" } },
      { ...ready, reconciliationWorker: { ...ready.reconciliationWorker!, heartbeatAtUtc: "not-a-timestamp" } },
      { ...ready, reconciliationWorker: { ...ready.reconciliationWorker!, status: "UNKNOWN" } },
      { ...ready, reconciliationWorker: { ...ready.reconciliationWorker!, fresh: "true" } },
      { ...ready, reconciliationWorker: { ...ready.reconciliationWorker!, extra: true } },
      { ...ready, releaseMatches: false },
      { ...ready, releaseMatches: undefined },
      { ...ready, connection: { ...ready.connection!, companyName: undefined } },
      { ...ready, connection: { ...ready.connection!, connectedAtUtc: "2026-09-04" } },
      { ...ready, connection: { ...ready.connection!, lastSyncAtUtc: "not-a-timestamp" } },
      { ...ready, connection: { ...ready.connection!, lastWebhookAtUtc: undefined } },
      { ...ready, connection: { ...ready.connection!, counts: { ...ready.connection!.counts, customerMaps: Number.MAX_SAFE_INTEGER + 1 } } },
      {
        ...notConnected,
        setup: {
          ...notConnected.setup,
          checks: notConnected.setup.checks.map((check) => check.key === "ACCOUNTING_SCOPE_GRANTED" ? { ...check, passed: true } : check),
        },
      },
      statusPayload({ providerConfigured: false }),
      statusPayload({ providerWorkflowsEnabled: false }),
      statusPayload({ reconciliationWorkerEnabled: false, reconciliationWorkerHealthy: false }),
      statusPayload({ reconciliationWorkerEnabled: false, reconciliationWorkerHealthy: false, cdcWorkerEnabled: false, hostedPaymentsEnabled: true }),
      {
        ...oauthOnly,
        setup: {
          ...oauthOnly.setup,
          checks: oauthOnly.setup.checks.map((check) => check.key === "HOSTED_PAYMENTS_ENABLED" ? { ...check, passed: true } : check),
        },
      },
      { ...unhealthyWorker, releaseMatches: true },
      {
        ...unhealthyWorker,
        reconciliationWorker: { status: "RUNNING", fresh: false, heartbeatAtUtc: "2026-09-04T12:00:00.000Z" },
        releaseMatches: true,
      },
      { ...unhealthyWorker, reconciliationWorker: { status: "RUNNING", fresh: true, heartbeatAtUtc: "2026-09-04T12:00:00.000Z" } },
    ];

    for (const payload of invalidPayloads) {
      assert.equal(normalizeQuickBooksStatusPayload(payload), null);
    }

    const healthyReleaseMatch = { ...ready, releaseMatches: true };
    assert.deepEqual(normalizeQuickBooksStatusPayload(healthyReleaseMatch), healthyReleaseMatch);
    const stoppingFleet = {
      ...unhealthyWorker,
      reconciliationWorker: { status: "STOPPING", fresh: false, heartbeatAtUtc: "2026-09-04T12:00:00.000Z" },
      releaseMatches: true,
    };
    assert.deepEqual(normalizeQuickBooksStatusPayload(stoppingFleet), stoppingFleet);
    const terminalFleet = {
      ...unhealthyWorker,
      reconciliationWorker: { status: "STOPPED", fresh: false, heartbeatAtUtc: "2026-09-04T12:00:00.000Z" },
      releaseMatches: true,
    };
    assert.equal(normalizeQuickBooksStatusPayload(terminalFleet), null);
  });
});
