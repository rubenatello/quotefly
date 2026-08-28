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
    },
    connection: null,
  };

  it("accepts a complete status and rejects a legacy response without setup readiness", () => {
    assert.deepEqual(normalizeQuickBooksStatusPayload(validStatus), validStatus);
    assert.equal(normalizeQuickBooksStatusPayload({ ...validStatus, setup: undefined }), null);
    assert.equal(normalizeQuickBooksStatusPayload({ ...validStatus, setup: { ...validStatus.setup, checks: [{}] } }), null);
  });
});
