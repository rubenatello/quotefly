import type {
  QuickBooksConnectionStatus,
  QuickBooksSetupCheckKey,
  QuickBooksSetupPhase,
  QuickBooksStatusPayload,
} from "./api";

const QUICKBOOKS_AUTHORIZATION_HOST = "appcenter.intuit.com";
const QUICKBOOKS_AUTHORIZATION_PATH = "/connect/oauth2";

const QUICKBOOKS_SETUP_PHASES = new Set<QuickBooksSetupPhase>([
  "UNAVAILABLE",
  "NOT_CONNECTED",
  "ACTION_REQUIRED",
  "READY_FOR_CONFIRMATION",
  "CONFIRMED",
]);

const QUICKBOOKS_CONNECTION_STATUSES = new Set<QuickBooksConnectionStatus>([
  "CONNECTED",
  "NEEDS_REAUTH",
  "REVOCATION_PENDING",
  "ERROR",
  "DISCONNECTED",
]);

const QUICKBOOKS_SETUP_CHECK_KEYS = new Set<QuickBooksSetupCheckKey>([
  "PROVIDER_CONFIGURED",
  "PROVIDER_WORKFLOWS_ENABLED",
  "ACCOUNTING_WORKFLOWS_ENABLED",
  "WEBHOOK_CONFIGURED",
  "HOSTED_PAYMENTS_ENABLED",
  "RECONCILIATION_WORKER_ENABLED",
  "RECONCILIATION_WORKER_HEALTHY",
  "CDC_WORKER_ENABLED",
  "CONNECTION_ACTIVE",
  "ENVIRONMENT_MATCHES",
  "ACCOUNTING_SCOPE_GRANTED",
  "CREDENTIALS_AVAILABLE",
  "REALM_BINDING_ACTIVE",
  "CDC_CURSOR_INITIALIZED",
  "SETUP_CONFIRMED",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isNullableString(value: unknown): boolean {
  return typeof value === "string" || value === null || value === undefined;
}

/**
 * Keeps the Settings route fail-closed when an older API deploy or malformed
 * intermediary returns a partial QuickBooks status. The setup panel relies on
 * every validated field below, so partial data must not reach the renderer.
 */
export function normalizeQuickBooksStatusPayload(value: unknown): QuickBooksStatusPayload | null {
  if (!isRecord(value)) return null;
  if (
    !isBoolean(value.enabled) ||
    !isBoolean(value.configured) ||
    !isBoolean(value.providerWorkflowsEnabled) ||
    !isBoolean(value.webhookConfigured) ||
    !isBoolean(value.canManage) ||
    (value.environment !== "sandbox" && value.environment !== "production") ||
    !isRecord(value.setup)
  ) {
    return null;
  }

  const setup = value.setup;
  if (
    typeof setup.phase !== "string" ||
    !QUICKBOOKS_SETUP_PHASES.has(setup.phase as QuickBooksSetupPhase) ||
    !isBoolean(setup.ready) ||
    !isBoolean(setup.confirmed) ||
    typeof setup.checklistVersion !== "string" ||
    setup.checklistVersion.trim() === "" ||
    !isNullableString(setup.confirmedAtUtc) ||
    !Array.isArray(setup.checks) ||
    !isRecord(setup.capabilities) ||
    !isBoolean(setup.capabilities.canConnect) ||
    !isBoolean(setup.capabilities.canReconnect) ||
    !isBoolean(setup.capabilities.canConfirm) ||
    !isBoolean(setup.capabilities.canDisconnect) ||
    !isRecord(setup.operations) ||
    !isBoolean(setup.operations.coreConnectionReady) ||
    !isBoolean(setup.operations.hostedPaymentsReady) ||
    !isBoolean(setup.operations.reconciliationReady) ||
    !isBoolean(setup.operations.cdcRecoveryReady) ||
    !isBoolean(setup.operations.allAccountingWorkflowsReady)
  ) {
    return null;
  }

  const validChecks = setup.checks.every((check) => (
    isRecord(check) &&
    typeof check.key === "string" &&
    QUICKBOOKS_SETUP_CHECK_KEYS.has(check.key as QuickBooksSetupCheckKey) &&
    isBoolean(check.passed) &&
    (check.managedBy === "QUOTEFLY" || check.managedBy === "WORKSPACE")
  ));
  if (!validChecks) return null;

  if (value.connection === null) return value as QuickBooksStatusPayload;
  if (!isRecord(value.connection)) return null;
  const connection = value.connection;
  if (
    typeof connection.environment !== "string" ||
    !isNullableString(connection.companyName) ||
    typeof connection.status !== "string" ||
    !QUICKBOOKS_CONNECTION_STATUSES.has(connection.status as QuickBooksConnectionStatus) ||
    typeof connection.connectedAtUtc !== "string" ||
    !isNullableString(connection.disconnectedAtUtc) ||
    !isNullableString(connection.lastTokenRefreshAtUtc) ||
    !isNullableString(connection.lastSyncAtUtc) ||
    !isNullableString(connection.lastWebhookAtUtc) ||
    !isRecord(connection.counts) ||
    !Number.isFinite(connection.counts.customerMaps) ||
    !Number.isFinite(connection.counts.itemMaps) ||
    !Number.isFinite(connection.counts.invoiceSyncs)
  ) {
    return null;
  }

  return value as QuickBooksStatusPayload;
}

export function isTrustedQuickBooksAuthorizationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === QUICKBOOKS_AUTHORIZATION_HOST &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === QUICKBOOKS_AUTHORIZATION_PATH &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}
