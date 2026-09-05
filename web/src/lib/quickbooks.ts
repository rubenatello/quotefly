import type {
  QuickBooksConnectionStatus,
  QuickBooksSetupCheckKey,
  QuickBooksSetupPhase,
  QuickBooksStatusPayload,
} from "./api";

const QUICKBOOKS_AUTHORIZATION_HOST = "appcenter.intuit.com";
const QUICKBOOKS_AUTHORIZATION_PATH = "/connect/oauth2";
const QUICKBOOKS_SETUP_CHECKLIST_VERSION = "2026-08-28.v2";

const QUICKBOOKS_SETUP_PHASES = new Set<QuickBooksSetupPhase>([
  "UNAVAILABLE",
  "NOT_CONNECTED",
  "ACTION_REQUIRED",
  "CONNECTION_VERIFIED",
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

const QUICKBOOKS_RECONCILIATION_WORKER_STATUSES = new Set([
  "STARTING",
  "RUNNING",
  "STOPPING",
  "STOPPED",
  "FAILED",
]);

const QUICKBOOKS_RECONCILIATION_WORKER_CAPACITY_STATUSES = new Set([
  "STARTING",
  "RUNNING",
]);

const QUICKBOOKS_SETUP_CHECK_ORDER = [
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
] as const satisfies readonly QuickBooksSetupCheckKey[];

const QUICKBOOKS_MANAGED_BY: Readonly<Record<QuickBooksSetupCheckKey, "QUOTEFLY" | "WORKSPACE">> = {
  PROVIDER_CONFIGURED: "QUOTEFLY",
  PROVIDER_WORKFLOWS_ENABLED: "QUOTEFLY",
  ACCOUNTING_WORKFLOWS_ENABLED: "QUOTEFLY",
  WEBHOOK_CONFIGURED: "QUOTEFLY",
  HOSTED_PAYMENTS_ENABLED: "QUOTEFLY",
  RECONCILIATION_WORKER_ENABLED: "QUOTEFLY",
  RECONCILIATION_WORKER_HEALTHY: "QUOTEFLY",
  CDC_WORKER_ENABLED: "QUOTEFLY",
  CONNECTION_ACTIVE: "WORKSPACE",
  ENVIRONMENT_MATCHES: "QUOTEFLY",
  ACCOUNTING_SCOPE_GRANTED: "WORKSPACE",
  CREDENTIALS_AVAILABLE: "QUOTEFLY",
  REALM_BINDING_ACTIVE: "QUOTEFLY",
  CDC_CURSOR_INITIALIZED: "QUOTEFLY",
  SETUP_CONFIRMED: "WORKSPACE",
};

const QUICKBOOKS_OPTIONAL_OPERATION_CHECK_KEYS = new Set<QuickBooksSetupCheckKey>([
  "WEBHOOK_CONFIGURED",
  "ACCOUNTING_WORKFLOWS_ENABLED",
  "HOSTED_PAYMENTS_ENABLED",
  "RECONCILIATION_WORKER_ENABLED",
  "RECONCILIATION_WORKER_HEALTHY",
  "CDC_WORKER_ENABLED",
  "SETUP_CONFIRMED",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isNullableString(value: unknown): boolean {
  return typeof value === "string" || value === null;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function isNullableIsoTimestamp(value: unknown): boolean {
  return value === null || isIsoTimestamp(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isReconciliationWorkerHeartbeat(value: unknown): value is {
  status: "STARTING" | "RUNNING" | "STOPPING" | "STOPPED" | "FAILED";
  fresh: boolean;
  heartbeatAtUtc: string;
} {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 3
    && keys.every((key) => key === "status" || key === "fresh" || key === "heartbeatAtUtc")
    && typeof value.status === "string"
    && QUICKBOOKS_RECONCILIATION_WORKER_STATUSES.has(value.status)
    && isBoolean(value.fresh)
    && isIsoTimestamp(value.heartbeatAtUtc);
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
    !isBoolean(value.oauthOnlyMode) ||
    !isBoolean(value.webhookConfigured) ||
    !isBoolean(value.canManage) ||
    (value.environment !== "sandbox" && value.environment !== "production") ||
    !isRecord(value.setup)
  ) {
    return null;
  }

  const setup = value.setup;
  const capabilities = setup.capabilities;
  const operations = setup.operations;
  if (
    typeof setup.phase !== "string" ||
    !QUICKBOOKS_SETUP_PHASES.has(setup.phase as QuickBooksSetupPhase) ||
    !isBoolean(setup.ready) ||
    !isBoolean(setup.confirmed) ||
    setup.checklistVersion !== QUICKBOOKS_SETUP_CHECKLIST_VERSION ||
    !hasOwn(setup, "confirmedAtUtc") ||
    !isNullableIsoTimestamp(setup.confirmedAtUtc) ||
    !Array.isArray(setup.checks) ||
    !isRecord(capabilities) ||
    !isBoolean(capabilities.canConnect) ||
    !isBoolean(capabilities.canReconnect) ||
    !isBoolean(capabilities.canConfirm) ||
    !isBoolean(capabilities.canDisconnect) ||
    !isRecord(operations) ||
    !isBoolean(operations.coreConnectionReady) ||
    !isBoolean(operations.hostedPaymentsReady) ||
    !isBoolean(operations.reconciliationReady) ||
    !isBoolean(operations.cdcRecoveryReady) ||
    !isBoolean(operations.allAccountingWorkflowsReady)
  ) {
    return null;
  }

  const checks = new Map<QuickBooksSetupCheckKey, boolean>();
  const validChecks = setup.checks.length === QUICKBOOKS_SETUP_CHECK_ORDER.length && setup.checks.every((check, index) => {
    if (
      !isRecord(check)
      || typeof check.key !== "string"
      || !QUICKBOOKS_SETUP_CHECK_KEYS.has(check.key as QuickBooksSetupCheckKey)
      || !isBoolean(check.passed)
      || (check.managedBy !== "QUOTEFLY" && check.managedBy !== "WORKSPACE")
    ) {
      return false;
    }
    const key = check.key as QuickBooksSetupCheckKey;
    if (key !== QUICKBOOKS_SETUP_CHECK_ORDER[index] || checks.has(key) || check.managedBy !== QUICKBOOKS_MANAGED_BY[key]) return false;
    checks.set(key, check.passed);
    return true;
  });
  if (!validChecks || QUICKBOOKS_SETUP_CHECK_ORDER.some((key) => !checks.has(key))) return null;

  const reconciliationWorker = value.reconciliationWorker;
  if (reconciliationWorker !== null && !isReconciliationWorkerHeartbeat(reconciliationWorker)) return null;
  if (value.releaseMatches !== null && !isBoolean(value.releaseMatches)) return null;

  const connection = value.connection;
  if (connection !== null) {
    if (!isRecord(connection)
      || !hasOwn(connection, "companyName")
      || !hasOwn(connection, "disconnectedAtUtc")
      || !hasOwn(connection, "lastTokenRefreshAtUtc")
      || !hasOwn(connection, "lastSyncAtUtc")
      || !hasOwn(connection, "lastWebhookAtUtc")
      || (connection.environment !== "sandbox" && connection.environment !== "production")
      || !isNullableString(connection.companyName)
      || typeof connection.status !== "string"
      || !QUICKBOOKS_CONNECTION_STATUSES.has(connection.status as QuickBooksConnectionStatus)
      || !isIsoTimestamp(connection.connectedAtUtc)
      || !isNullableIsoTimestamp(connection.disconnectedAtUtc)
      || !isNullableIsoTimestamp(connection.lastTokenRefreshAtUtc)
      || !isNullableIsoTimestamp(connection.lastSyncAtUtc)
      || !isNullableIsoTimestamp(connection.lastWebhookAtUtc)
    ) return null;

    const counts = connection.counts;
    if (!isRecord(counts)
      || typeof counts.customerMaps !== "number"
      || !Number.isSafeInteger(counts.customerMaps)
      || counts.customerMaps < 0
      || typeof counts.itemMaps !== "number"
      || !Number.isSafeInteger(counts.itemMaps)
      || counts.itemMaps < 0
      || typeof counts.invoiceSyncs !== "number"
      || !Number.isSafeInteger(counts.invoiceSyncs)
      || counts.invoiceSyncs < 0
    ) return null;
  }

  const connected = connection !== null && connection.status === "CONNECTED";
  const environmentMatches = Boolean(connection && connection.environment === value.environment);
  const oauthOnlyMode = value.oauthOnlyMode === true;
  const configured = checks.get("PROVIDER_CONFIGURED") === true;
  const providerWorkflowsEnabled = checks.get("PROVIDER_WORKFLOWS_ENABLED") === true;
  const accountingWorkflowsEnabled = checks.get("ACCOUNTING_WORKFLOWS_ENABLED") === true;
  const reconciliationWorkerHealthy = checks.get("RECONCILIATION_WORKER_HEALTHY") === true;
  const reconciliationWorkerHasCapacity = reconciliationWorker !== null
    && reconciliationWorker.fresh
    && QUICKBOOKS_RECONCILIATION_WORKER_CAPACITY_STATUSES.has(reconciliationWorker.status);
  const setupConfirmed = checks.get("SETUP_CONFIRMED") === true;
  const hostedPaymentsEnabled = checks.get("HOSTED_PAYMENTS_ENABLED") === true;
  const reconciliationWorkerEnabled = checks.get("RECONCILIATION_WORKER_ENABLED") === true;
  const cdcWorkerEnabled = checks.get("CDC_WORKER_ENABLED") === true;
  const connectionIntegrityChecksPass = checks.get("ACCOUNTING_SCOPE_GRANTED") === true
    || checks.get("CREDENTIALS_AVAILABLE") === true
    || checks.get("REALM_BINDING_ACTIVE") === true
    || checks.get("CDC_CURSOR_INITIALIZED") === true;
  const requiredChecksPassed = QUICKBOOKS_SETUP_CHECK_ORDER
    .filter((key) => !QUICKBOOKS_OPTIONAL_OPERATION_CHECK_KEYS.has(key))
    .every((key) => checks.get(key) === true);
  const platformAvailable = configured && providerWorkflowsEnabled;
  const confirmed = setupConfirmed;
  const expectedPhase: QuickBooksSetupPhase = !platformAvailable
    ? "UNAVAILABLE"
    : !connection || connection.status === "DISCONNECTED"
      ? "NOT_CONNECTED"
      : !requiredChecksPassed
        ? "ACTION_REQUIRED"
        : oauthOnlyMode
          ? "CONNECTION_VERIFIED"
          : confirmed
            ? "CONFIRMED"
            : "READY_FOR_CONFIRMATION";
  const expectedReady = requiredChecksPassed && confirmed && accountingWorkflowsEnabled;
  const expectedCapabilities = {
    canConnect: platformAvailable && (!connection || connection.status === "DISCONNECTED"),
    canReconnect: platformAvailable && Boolean(
      connection && (connection.status === "CONNECTED" || connection.status === "NEEDS_REAUTH"),
    ),
    canConfirm: requiredChecksPassed && accountingWorkflowsEnabled,
    canDisconnect: Boolean(
      connection && (
        connection.status === "CONNECTED"
        || connection.status === "NEEDS_REAUTH"
        || connection.status === "REVOCATION_PENDING"
      ),
    ),
  };
  const coreConnectionReady = requiredChecksPassed && confirmed && accountingWorkflowsEnabled;
  const reconciliationReady = coreConnectionReady
    && checks.get("WEBHOOK_CONFIGURED") === true
    && checks.get("RECONCILIATION_WORKER_ENABLED") === true
    && checks.get("RECONCILIATION_WORKER_HEALTHY") === true;
  const expectedOperations = {
    coreConnectionReady,
    hostedPaymentsReady: reconciliationReady && checks.get("HOSTED_PAYMENTS_ENABLED") === true,
    reconciliationReady,
    cdcRecoveryReady: reconciliationReady && checks.get("CDC_WORKER_ENABLED") === true,
    allAccountingWorkflowsReady: reconciliationReady
      && checks.get("HOSTED_PAYMENTS_ENABLED") === true
      && checks.get("CDC_WORKER_ENABLED") === true,
  };

  if (
    value.enabled !== (value.configured && value.providerWorkflowsEnabled)
    || value.configured !== configured
    || value.providerWorkflowsEnabled !== providerWorkflowsEnabled
    || (value.providerWorkflowsEnabled && !value.configured)
    || value.webhookConfigured !== (checks.get("WEBHOOK_CONFIGURED") === true)
    || value.canManage !== true
    || (oauthOnlyMode && (
      value.environment !== "sandbox"
      || !value.providerWorkflowsEnabled
      || hostedPaymentsEnabled
      || reconciliationWorkerEnabled
      || cdcWorkerEnabled
    ))
    || (hostedPaymentsEnabled && !reconciliationWorkerEnabled)
    || (cdcWorkerEnabled && !reconciliationWorkerEnabled)
    || (reconciliationWorkerEnabled && !value.providerWorkflowsEnabled)
    || ((hostedPaymentsEnabled || reconciliationWorkerEnabled) && value.webhookConfigured !== true)
    || accountingWorkflowsEnabled !== !oauthOnlyMode
    || checks.get("CONNECTION_ACTIVE") !== connected
    || checks.get("ENVIRONMENT_MATCHES") !== environmentMatches
    || (connection === null && connectionIntegrityChecksPass)
    || (reconciliationWorkerHealthy && (!reconciliationWorkerHasCapacity || value.releaseMatches === false))
    || (!reconciliationWorkerHealthy && reconciliationWorker?.fresh === true)
    || (value.releaseMatches === true && (
      reconciliationWorker === null
      || reconciliationWorker.status === "STOPPED"
      || reconciliationWorker.status === "FAILED"
      || (QUICKBOOKS_RECONCILIATION_WORKER_CAPACITY_STATUSES.has(reconciliationWorker.status) && !reconciliationWorker.fresh)
    ))
    || (confirmed && connection?.status !== "CONNECTED")
    || setup.confirmed !== confirmed
    || (oauthOnlyMode && confirmed)
    || setup.ready !== expectedReady
    || setup.phase !== expectedPhase
    || (confirmed ? !isIsoTimestamp(setup.confirmedAtUtc) : setup.confirmedAtUtc !== null)
    || Object.entries(expectedCapabilities).some(([key, expected]) => capabilities[key as keyof typeof expectedCapabilities] !== expected)
    || Object.entries(expectedOperations).some(([key, expected]) => operations[key as keyof typeof expectedOperations] !== expected)
  ) return null;

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
