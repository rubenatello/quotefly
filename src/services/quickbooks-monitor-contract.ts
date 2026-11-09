import { createHash } from "node:crypto";
import { z } from "zod";
import type { QuickBooksMonitorEnv } from "../config/quickbooks-monitor-env";
import type { QuickBooksOperationalAggregate } from "./quickbooks-operational-health";
import type { WorkerHeartbeatSnapshot } from "./worker-heartbeats";

// QuickBooks CDC persists providerCursor minus a two-minute overlap for replay safety.
// Alert on elapsed recovery age, not that intentional overlap; keep raw control-plane metrics unchanged.
const CDC_CURSOR_OVERLAP_MS = 2 * 60 * 1000;
export const QUICKBOOKS_MONITOR_KEY = "quickbooks-operational-monitor";
export const ALERT_CODES = ["WORKER_HEARTBEAT", "WEBHOOK_BACKLOG", "WEBHOOK_DEAD", "RECONCILIATION_REQUIRED", "TOKEN_FAILURE", "CDC_RECOVERY", "REVOCATION_PENDING", "REVOCATION_DEAD"] as const;
export type AlertCode = typeof ALERT_CODES[number];
export type Severity = "HEALTHY" | "WARNING" | "CRITICAL";
export const alertMessageSchema = z.object({
  alertCode: z.enum(ALERT_CODES),
  transition: z.enum(["OPEN", "ESCALATE", "REMINDER", "RECOVER"]),
  severity: z.enum(["HEALTHY", "WARNING", "CRITICAL"]),
  incidentGeneration: z.number().int().positive().max(2_147_483_647),
  observedAtUtc: z.date(),
  metrics: z.object({ count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), ageMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable() }).strict(),
}).strict();
export type AlertMessage = z.infer<typeof alertMessageSchema>;
export type AlertObservation = Pick<AlertMessage, "alertCode" | "severity" | "metrics">;
export function monitorConfigurationHash(env: Pick<QuickBooksMonitorEnv, "QUICKBOOKS_ALERT_EMAIL" | "PASSWORD_RESET_EMAIL_FROM" | "QUICKBOOKS_MONITOR_ENVIRONMENT_LABEL">) {
  return createHash("sha256").update(JSON.stringify([env.QUICKBOOKS_ALERT_EMAIL, env.PASSWORD_RESET_EMAIL_FROM, env.QUICKBOOKS_MONITOR_ENVIRONMENT_LABEL])).digest("hex");
}
export const quickBooksAlertAgeSeverity = (count: number, age: number | null): Severity => count > 0 && age !== null
  ? age > 900_000 ? "CRITICAL" : age > 300_000 ? "WARNING" : "HEALTHY" : "HEALTHY";
export function observeQuickBooksHealth(
  health: QuickBooksOperationalAggregate,
  heartbeat: WorkerHeartbeatSnapshot | null,
  expected: Pick<QuickBooksMonitorEnv, "QUICKBOOKS_MONITOR_EXPECT_RECONCILIATION" | "QUICKBOOKS_MONITOR_EXPECT_CDC">,
  now: Date,
): AlertObservation[] {
  const observation = (alertCode: AlertCode, severity: Severity, count: number, ageMs: number | null): AlertObservation => ({ alertCode, severity, metrics: { count, ageMs } });
  const heartbeatAge = heartbeat ? Math.max(0, now.getTime() - heartbeat.heartbeatAtUtc.getTime()) : null;
  const revocationAge = Math.max(health.oldestConnectionRevocationPendingAgeMs ?? 0, health.oldestOrphanRevocationPendingAgeMs ?? 0);
  const revocationCount = health.connectionRevocationPendingCount + health.orphanRevocationPendingCount;
  const cdcRecoveryAgeMs = health.maximumCdcLagMs === null ? null : Math.max(0, health.maximumCdcLagMs - CDC_CURSOR_OVERLAP_MS);
  return [
    observation("WORKER_HEARTBEAT", expected.QUICKBOOKS_MONITOR_EXPECT_RECONCILIATION && (!heartbeat || heartbeat.status !== "RUNNING" || heartbeatAge! > 180_000) ? "CRITICAL" : "HEALTHY", heartbeat ? 1 : 0, heartbeatAge),
    observation("WEBHOOK_BACKLOG", quickBooksAlertAgeSeverity(health.webhookOutstandingCount, health.oldestWebhookOutstandingAgeMs), health.webhookOutstandingCount, health.oldestWebhookOutstandingAgeMs),
    observation("WEBHOOK_DEAD", health.webhookDeadCount > 0 ? "CRITICAL" : "HEALTHY", health.webhookDeadCount, null),
    observation("RECONCILIATION_REQUIRED", quickBooksAlertAgeSeverity(health.reconciliationRequiredCount, health.oldestReconciliationRequiredAgeMs), health.reconciliationRequiredCount, health.oldestReconciliationRequiredAgeMs),
    observation("TOKEN_FAILURE", quickBooksAlertAgeSeverity(health.tokenFailureCount + health.tokenReauthCount, health.oldestTokenFailureAgeMs), health.tokenFailureCount + health.tokenReauthCount, health.oldestTokenFailureAgeMs),
    observation("CDC_RECOVERY", health.cdcTerminalCount > 0 ? "CRITICAL" : expected.QUICKBOOKS_MONITOR_EXPECT_CDC ? quickBooksAlertAgeSeverity(health.cdcCursorCount, cdcRecoveryAgeMs) : "HEALTHY", health.cdcTerminalCount || health.cdcCursorCount, cdcRecoveryAgeMs),
    observation("REVOCATION_PENDING", quickBooksAlertAgeSeverity(revocationCount, revocationAge), revocationCount, revocationAge),
    observation("REVOCATION_DEAD", health.connectionRevocationDeadCount + health.orphanRevocationDeadCount > 0 ? "CRITICAL" : "HEALTHY", health.connectionRevocationDeadCount + health.orphanRevocationDeadCount, null),
  ];
}
