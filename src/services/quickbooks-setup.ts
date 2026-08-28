export const QUICKBOOKS_SETUP_CHECKLIST_VERSION = "2026-08-27.v1";
export const QUICKBOOKS_ACCOUNTING_SCOPE = "com.intuit.quickbooks.accounting";

export type QuickBooksSetupPhase =
  | "UNAVAILABLE"
  | "NOT_CONNECTED"
  | "ACTION_REQUIRED"
  | "READY_FOR_CONFIRMATION"
  | "CONFIRMED";

export type QuickBooksSetupCheckKey =
  | "PROVIDER_CONFIGURED"
  | "PROVIDER_WORKFLOWS_ENABLED"
  | "WEBHOOK_CONFIGURED"
  | "CONNECTION_ACTIVE"
  | "ENVIRONMENT_MATCHES"
  | "ACCOUNTING_SCOPE_GRANTED"
  | "CREDENTIALS_AVAILABLE"
  | "REALM_BINDING_ACTIVE"
  | "CDC_CURSOR_INITIALIZED"
  | "SETUP_CONFIRMED";

export type QuickBooksSetupConnectionState = Readonly<{
  status: string;
  environment: string;
  scopes: readonly string[];
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  accessTokenExpiresAtUtc: Date | null;
  setupConfirmedAtUtc: Date | null;
  setupConfirmedByTenantUserId: string | null;
  setupChecklistVersion: string | null;
  realmBinding: Readonly<{ active: boolean }> | null;
  cdcCursor: Readonly<{ id: string }> | null;
  accountingScopeGranted?: boolean;
  credentialsAvailable?: boolean;
  realmBindingActive?: boolean;
  cdcCursorInitialized?: boolean;
}>;

export type QuickBooksSetupRuntime = Readonly<{
  providerConfigured: boolean;
  providerWorkflowsEnabled: boolean;
  webhookConfigured: boolean;
  environment: "sandbox" | "production";
}>;

export type QuickBooksSetupReadiness = Readonly<{
  phase: QuickBooksSetupPhase;
  ready: boolean;
  confirmed: boolean;
  checklistVersion: string;
  confirmedAtUtc: Date | null;
  checks: readonly Readonly<{
    key: QuickBooksSetupCheckKey;
    passed: boolean;
    managedBy: "QUOTEFLY" | "WORKSPACE";
  }>[];
  capabilities: Readonly<{
    canConnect: boolean;
    canReconnect: boolean;
    canConfirm: boolean;
    canDisconnect: boolean;
  }>;
}>;

/**
 * Canonical, side-effect-free QuickBooks setup state. This deliberately uses
 * credential presence only; it never decrypts tokens or contacts Intuit.
 */
export function deriveQuickBooksSetupReadiness(
  runtime: QuickBooksSetupRuntime,
  connection: QuickBooksSetupConnectionState | null,
): QuickBooksSetupReadiness {
  const providerConfigured = runtime.providerConfigured;
  const providerWorkflowsEnabled = runtime.providerWorkflowsEnabled;
  const webhookConfigured = runtime.webhookConfigured;
  const connectionActive = connection?.status === "CONNECTED";
  const environmentMatches = Boolean(connection && connection.environment === runtime.environment);
  const accountingScopeGranted = connection?.accountingScopeGranted
    ?? Boolean(connection?.scopes.includes(QUICKBOOKS_ACCOUNTING_SCOPE));
  const credentialsAvailable = connection?.credentialsAvailable
    ?? Boolean(connection?.accessTokenEncrypted && connection.refreshTokenEncrypted && connection.accessTokenExpiresAtUtc);
  const realmBindingActive = connection?.realmBindingActive ?? Boolean(connection?.realmBinding?.active);
  const cdcCursorInitialized = connection?.cdcCursorInitialized ?? Boolean(connection?.cdcCursor?.id);
  const confirmed = Boolean(
    connectionActive
      && connection?.setupConfirmedAtUtc
      && connection.setupConfirmedByTenantUserId
      && connection.setupChecklistVersion === QUICKBOOKS_SETUP_CHECKLIST_VERSION,
  );

  const checks = [
    { key: "PROVIDER_CONFIGURED", passed: providerConfigured, managedBy: "QUOTEFLY" },
    { key: "PROVIDER_WORKFLOWS_ENABLED", passed: providerWorkflowsEnabled, managedBy: "QUOTEFLY" },
    { key: "WEBHOOK_CONFIGURED", passed: webhookConfigured, managedBy: "QUOTEFLY" },
    { key: "CONNECTION_ACTIVE", passed: connectionActive, managedBy: "WORKSPACE" },
    { key: "ENVIRONMENT_MATCHES", passed: environmentMatches, managedBy: "QUOTEFLY" },
    { key: "ACCOUNTING_SCOPE_GRANTED", passed: accountingScopeGranted, managedBy: "WORKSPACE" },
    { key: "CREDENTIALS_AVAILABLE", passed: credentialsAvailable, managedBy: "QUOTEFLY" },
    { key: "REALM_BINDING_ACTIVE", passed: realmBindingActive, managedBy: "QUOTEFLY" },
    { key: "CDC_CURSOR_INITIALIZED", passed: cdcCursorInitialized, managedBy: "QUOTEFLY" },
    { key: "SETUP_CONFIRMED", passed: confirmed, managedBy: "WORKSPACE" },
  ] as const satisfies readonly {
    key: QuickBooksSetupCheckKey;
    passed: boolean;
    managedBy: "QUOTEFLY" | "WORKSPACE";
  }[];

  const requiredChecksPassed = checks
    .filter((check) => check.key !== "SETUP_CONFIRMED")
    .every((check) => check.passed);
  const platformAvailable = providerConfigured && providerWorkflowsEnabled;
  const phase: QuickBooksSetupPhase = !platformAvailable
    ? "UNAVAILABLE"
    : !connection || connection.status === "DISCONNECTED"
      ? "NOT_CONNECTED"
      : !requiredChecksPassed
        ? "ACTION_REQUIRED"
        : confirmed
          ? "CONFIRMED"
          : "READY_FOR_CONFIRMATION";

  return {
    phase,
    ready: requiredChecksPassed && confirmed,
    confirmed,
    checklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
    confirmedAtUtc: confirmed ? connection?.setupConfirmedAtUtc ?? null : null,
    checks,
    capabilities: {
      canConnect: platformAvailable && (!connection || connection.status === "DISCONNECTED"),
      canReconnect: platformAvailable && Boolean(connection && connection.status !== "DISCONNECTED"),
      canConfirm: requiredChecksPassed,
      canDisconnect: Boolean(connection && connection.status !== "DISCONNECTED"),
    },
  };
}
