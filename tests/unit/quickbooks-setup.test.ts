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

    assert.equal(result.phase, "READY_FOR_CONFIRMATION");
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
  const validStatus = {
    enabled: true,
    configured: true,
    providerWorkflowsEnabled: true,
    webhookConfigured: true,
    canManage: true,
    environment: "sandbox",
    setup: {
      phase: "READY_FOR_CONFIRMATION",
      ready: false,
      confirmed: false,
      checklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
      confirmedAtUtc: null,
      checks: [{ key: "PROVIDER_CONFIGURED", passed: true, managedBy: "QUOTEFLY" }],
      capabilities: { canConnect: false, canReconnect: false, canConfirm: true, canDisconnect: true },
      operations: {
        coreConnectionReady: false,
        hostedPaymentsReady: false,
        reconciliationReady: false,
        cdcRecoveryReady: false,
        allAccountingWorkflowsReady: false,
      },
    },
    connection: null,
  };

  it("accepts a complete status and rejects a legacy response without setup readiness", () => {
    assert.deepEqual(normalizeQuickBooksStatusPayload(validStatus), validStatus);
    assert.equal(normalizeQuickBooksStatusPayload({ ...validStatus, setup: undefined }), null);
    assert.equal(normalizeQuickBooksStatusPayload({ ...validStatus, setup: { ...validStatus.setup, checks: [{}] } }), null);
  });
});
