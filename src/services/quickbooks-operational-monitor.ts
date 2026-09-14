import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type QuickBooksOperationalAlertDelivery } from "@prisma/client";
import type { QuickBooksMonitorEnv } from "../config/quickbooks-monitor-env";
import { ALERT_CODES, quickBooksAlertAgeSeverity, alertMessageSchema, monitorConfigurationHash, type AlertObservation, type AlertMessage } from "./quickbooks-monitor-contract";
import { sendQuickBooksOperationalAlert } from "./transactional-email";

const DAY_MS = 86_400_000;
export const ALERT_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
export const ALERT_LEASE_MS = 30_000;
export const ALERT_MAX_ATTEMPTS = 12;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** One atomic decision for every fixed alert code. Older/concurrent samples cannot advance hysteresis. */
export async function evaluateQuickBooksAlerts(prisma: PrismaClient, observations: readonly AlertObservation[], sampledAtUtc: Date, configurationHash: string) {
  if (observations.length !== ALERT_CODES.length || new Set(observations.map((value) => value.alertCode)).size !== ALERT_CODES.length
      || !/^[0-9a-f]{64}$/.test(configurationHash)) throw new Error("QUICKBOOKS_ALERT_INVALID_OBSERVATIONS");
  for (const observation of observations) {
    if (!alertMessageSchema.safeParse({ ...observation, transition: "OPEN", incidentGeneration: 1, observedAtUtc: sampledAtUtc }).success) {
      throw new Error("QUICKBOOKS_ALERT_INVALID_OBSERVATIONS");
    }
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(7412, 619)::text`;
    let queued = 0;
    for (const sample of observations) {
      let observation = sample;
      const prior = await tx.quickBooksOperationalAlertState.findUnique({ where: { alertCode: observation.alertCode } });
      if (prior && sampledAtUtc.getTime() - prior.lastObservedAtUtc.getTime() < 30_000) continue;
      // Refresh attempts update the connection's updatedAt. Preserve first observed failure
      // independently so a provider retry cannot postpone this operational alert forever.
      const tokenPresent = observation.alertCode === "TOKEN_FAILURE" && observation.metrics.count > 0;
      const conditionSinceUtc = tokenPresent ? prior?.conditionSinceUtc ?? sampledAtUtc : prior?.conditionSinceUtc ?? null;
      if (tokenPresent) {
        const ageMs = Math.max(observation.metrics.ageMs ?? 0, sampledAtUtc.getTime() - conditionSinceUtc!.getTime());
        observation = { ...observation, severity: quickBooksAlertAgeSeverity(observation.metrics.count, ageMs), metrics: { ...observation.metrics, ageMs } };
      }
      const failing = observation.severity !== "HEALTHY";
      const failureStreak = failing ? Math.min(2, (prior?.failureStreak ?? 0) + 1) : 0;
      const healthyStreak = failing ? 0 : Math.min(2, (prior?.healthyStreak ?? 0) + 1);
      let active = prior?.active ?? false;
      let generation = prior?.incidentGeneration ?? 0;
      let severity = observation.severity;
      let transition: AlertMessage["transition"] | undefined;
      if (!active && failing && (severity === "CRITICAL" || failureStreak >= 2)) {
        active = true;
        generation += 1;
        transition = "OPEN";
      } else if (active && !failing && healthyStreak >= 2) {
        active = false;
        transition = "RECOVER";
      } else if (active && failing && severity === "CRITICAL" && prior?.severity !== "CRITICAL") {
        transition = "ESCALATE";
      } else if (active && failing && prior?.lastReminderAtUtc && sampledAtUtc.getTime() - prior.lastReminderAtUtc.getTime() >= DAY_MS) {
        transition = "REMINDER";
      }
      // Preserve an active incident's severity until two healthy observations close it.
      if (active && (!failing || prior?.severity === "CRITICAL")) severity = prior?.severity === "CRITICAL" ? "CRITICAL" : "WARNING";
      const state = {
        severity, active, incidentGeneration: generation,
        firstObservedAtUtc: failing && (!prior || (!prior.active && prior.failureStreak === 0)) ? sampledAtUtc : prior?.firstObservedAtUtc ?? sampledAtUtc,
        lastObservedAtUtc: sampledAtUtc, failureStreak, healthyStreak,
        conditionSinceUtc: !tokenPresent && healthyStreak >= 2 ? null : conditionSinceUtc,
        lastReminderAtUtc: transition ? sampledAtUtc : prior?.lastReminderAtUtc ?? null,
      };
      await tx.quickBooksOperationalAlertState.upsert({ where: { alertCode: observation.alertCode }, create: { alertCode: observation.alertCode, ...state }, update: state });
      if (transition) {
        await tx.quickBooksOperationalAlertDelivery.create({ data: {
          dedupeKeyHash: hash([observation.alertCode, generation, transition, transition === "REMINDER" ? sampledAtUtc.toISOString() : null]),
          alertCode: observation.alertCode, incidentGeneration: generation, transition, severity: transition === "RECOVER" ? "HEALTHY" : severity,
          metrics: observation.metrics, configurationHash, observedAtUtc: sampledAtUtc, nextAttemptAtUtc: sampledAtUtc,
        } });
        queued += 1;
      }
    }
    return queued;
  });
}

export async function claimQuickBooksAlertDelivery(prisma: PrismaClient, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    // Bound cleanup while allowing a later eligible alert past exhausted queue heads.
    for (let inspected = 0; inspected < 16; inspected += 1) {
      const rows = await tx.$queryRaw<QuickBooksOperationalAlertDelivery[]>(Prisma.sql`
        SELECT * FROM "QuickBooksOperationalAlertDelivery"
        WHERE ("status" = 'PENDING' AND "nextAttemptAtUtc" <= ${now})
          OR ("status" = 'PROCESSING' AND "claimExpiresAtUtc" <= ${now})
        ORDER BY "observedAtUtc", "id" FOR UPDATE SKIP LOCKED LIMIT 1
      `);
      const row = rows[0];
      if (!row) return null;
      if (row.attemptCount >= ALERT_MAX_ATTEMPTS || (row.firstAttemptAtUtc && now.getTime() - row.firstAttemptAtUtc.getTime() >= ALERT_RETRY_WINDOW_MS)) {
        await tx.quickBooksOperationalAlertDelivery.update({ where: { id: row.id }, data: { status: "TERMINAL", lastErrorCode: "DELIVERY_UNCONFIRMED", claimToken: null, claimExpiresAtUtc: null } });
        continue;
      }
      return tx.quickBooksOperationalAlertDelivery.update({ where: { id: row.id }, data: {
        status: "PROCESSING", claimToken: randomUUID(), claimExpiresAtUtc: new Date(now.getTime() + ALERT_LEASE_MS),
        firstAttemptAtUtc: row.firstAttemptAtUtc ?? now, attemptCount: { increment: 1 },
      } });
    }
    return null;
  });
}

/** No provider operation occurs in a database transaction. Every retry uses the immutable payload and key. */
export async function deliverQuickBooksAlert(
  prisma: PrismaClient,
  env: QuickBooksMonitorEnv,
  now = new Date(),
  send: typeof sendQuickBooksOperationalAlert = sendQuickBooksOperationalAlert,
): Promise<"idle" | "sent" | "retry" | "terminal"> {
  const row = await claimQuickBooksAlertDelivery(prisma, now);
  if (!row) return "idle";
  const claimWhere = { id: row.id, status: "PROCESSING", claimToken: row.claimToken };
  const parsed = alertMessageSchema.safeParse({ alertCode: row.alertCode, transition: row.transition, severity: row.severity,
    incidentGeneration: row.incidentGeneration, observedAtUtc: row.observedAtUtc, metrics: row.metrics });
  if (row.configurationHash !== monitorConfigurationHash(env) || !parsed.success) {
    await prisma.quickBooksOperationalAlertDelivery.updateMany({ where: claimWhere, data: {
      status: "TERMINAL", lastErrorCode: parsed.success ? "CONFIGURATION_CHANGED" : "INVALID_PAYLOAD", claimToken: null, claimExpiresAtUtc: null,
    } });
    return "terminal";
  }
  try {
    await send(env, parsed.data, row.dedupeKeyHash);
    await prisma.quickBooksOperationalAlertDelivery.updateMany({ where: claimWhere, data: {
      status: "SENT", sentAtUtc: now, lastErrorCode: null, claimToken: null, claimExpiresAtUtc: null,
    } });
    return "sent";
  } catch {
    // Intentionally discard exception text/provider bodies. Delivery ambiguity is retried only within Resend's 24h key retention.
    const terminal = row.attemptCount >= ALERT_MAX_ATTEMPTS;
    await prisma.quickBooksOperationalAlertDelivery.updateMany({ where: claimWhere, data: {
      status: terminal ? "TERMINAL" : "PENDING", lastErrorCode: terminal ? "DELIVERY_UNCONFIRMED" : "DELIVERY_RETRY_PENDING",
      nextAttemptAtUtc: new Date(now.getTime() + Math.min(3_600_000, 60_000 * 2 ** Math.min(row.attemptCount - 1, 6))),
      claimToken: null, claimExpiresAtUtc: null,
    } });
    return terminal ? "terminal" : "retry";
  }
}
