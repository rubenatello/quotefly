import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { PrismaClient } from "@prisma/client";
import { parseQuickBooksMonitorEnv } from "../config/quickbooks-monitor-env";
import { assertAiRetrievalRlsReady } from "../lib/tenant-rls";
import { loadQuickBooksOperationalHealth } from "../services/quickbooks-operational-health";
import { quickBooksMonitorCycleFailure, type QuickBooksMonitorPhase } from "../services/quickbooks-monitor-diagnostics";
import { monitorConfigurationHash, observeQuickBooksHealth, QUICKBOOKS_MONITOR_KEY } from "../services/quickbooks-monitor-contract";
import { deliverQuickBooksAlert, evaluateQuickBooksAlerts } from "../services/quickbooks-operational-monitor";
import { loadWorkerHeartbeat, recordWorkerHeartbeat, QUICKBOOKS_RECONCILIATION_WORKER_KEY } from "../services/worker-heartbeats";

// No dotenv or global env import: this process must have only its narrow deployment profile.
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
const startedAtUtc = new Date();
const instanceRefHash = createHash("sha256").update(randomUUID()).digest("hex");
async function run() {
  const env = parseQuickBooksMonitorEnv(process.env);
  if (!env.QUICKBOOKS_MONITOR_ENABLED) throw new Error("QUICKBOOKS_MONITOR_DISABLED");
  const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } }, log: [] });
  try {
    await assertAiRetrievalRlsReady(prisma, { requireRuntimeRole: env.NODE_ENV === "production" });
    while (!stopping) {
      const cycleStartedAtUtc = new Date();
      const cycleStartedMonotonic = performance.now();
      let phase: QuickBooksMonitorPhase = "health_scan";
      try {
        const health = await loadQuickBooksOperationalHealth(prisma, cycleStartedAtUtc);
        phase = "reconciliation_heartbeat_read";
        const heartbeat = await loadWorkerHeartbeat(prisma, QUICKBOOKS_RECONCILIATION_WORKER_KEY, cycleStartedAtUtc);
        phase = "alert_evaluation";
        const queued = await evaluateQuickBooksAlerts(prisma, observeQuickBooksHealth(health, heartbeat, env, cycleStartedAtUtc), cycleStartedAtUtc, monitorConfigurationHash(env));
        phase = "alert_delivery";
        for (let index = 0; index < 16 && !stopping; index += 1) {
          if (await deliverQuickBooksAlert(prisma, env) === "idle") break;
        }
        phase = "terminal_count";
        const terminalCount = await prisma.quickBooksOperationalAlertDelivery.count({ where: { status: "TERMINAL" } });
        phase = "heartbeat_write";
        await recordWorkerHeartbeat(prisma, { workerKey: QUICKBOOKS_MONITOR_KEY, instanceRefHash, status: "RUNNING", startedAtUtc, cycleStartedAtUtc,
          lastCycleDurationMs: Date.now() - cycleStartedAtUtc.getTime(), metrics: { tenantCount: health.tenantCount, queued, terminalDeliveryCount: terminalCount } });
        process.stdout.write(JSON.stringify({ event: "quickbooks_monitor_sample_completed", tenantCount: health.tenantCount, queued, terminalDeliveryCount: terminalCount }) + "\n");
      } catch (error) {
        // Fixed fields only: no DB URLs, provider payloads or exception details.
        process.stderr.write(JSON.stringify(quickBooksMonitorCycleFailure(phase, error, performance.now() - cycleStartedMonotonic)) + "\n");
        await recordWorkerHeartbeat(prisma, { workerKey: QUICKBOOKS_MONITOR_KEY, instanceRefHash, status: "FAILED", startedAtUtc, cycleStartedAtUtc }).catch(() => undefined);
      }
      const nextAt = cycleStartedAtUtc.getTime() + 60_000;
      while (!stopping && Date.now() < nextAt) await new Promise((resolve) => setTimeout(resolve, Math.min(1000, nextAt - Date.now())));
    }
    await recordWorkerHeartbeat(prisma, { workerKey: QUICKBOOKS_MONITOR_KEY, instanceRefHash, status: "STOPPED", startedAtUtc, cycleStartedAtUtc: new Date() });
  } finally { await prisma.$disconnect(); }
}
run().catch(() => { process.stderr.write('{"event":"quickbooks_monitor_start_or_shutdown_failed"}\n'); process.exitCode = 1; });
