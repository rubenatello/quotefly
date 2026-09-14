import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { parseQuickBooksMonitorEnv } from "../config/quickbooks-monitor-env";
import { assertAiRetrievalRlsReady } from "../lib/tenant-rls";
import { loadQuickBooksOperationalHealth } from "../services/quickbooks-operational-health";
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
      try {
        const health = await loadQuickBooksOperationalHealth(prisma, cycleStartedAtUtc);
        const heartbeat = await loadWorkerHeartbeat(prisma, QUICKBOOKS_RECONCILIATION_WORKER_KEY, cycleStartedAtUtc);
        const queued = await evaluateQuickBooksAlerts(prisma, observeQuickBooksHealth(health, heartbeat, env, cycleStartedAtUtc), cycleStartedAtUtc, monitorConfigurationHash(env));
        for (let index = 0; index < 16 && !stopping; index += 1) {
          if (await deliverQuickBooksAlert(prisma, env) === "idle") break;
        }
        const terminalCount = await prisma.quickBooksOperationalAlertDelivery.count({ where: { status: "TERMINAL" } });
        await recordWorkerHeartbeat(prisma, { workerKey: QUICKBOOKS_MONITOR_KEY, instanceRefHash, status: "RUNNING", startedAtUtc, cycleStartedAtUtc,
          lastCycleDurationMs: Date.now() - cycleStartedAtUtc.getTime(), metrics: { tenantCount: health.tenantCount, queued, terminalDeliveryCount: terminalCount } });
        process.stdout.write(JSON.stringify({ event: "quickbooks_monitor_sample_completed", tenantCount: health.tenantCount, queued, terminalDeliveryCount: terminalCount }) + "\n");
      } catch {
        // Expose only a fixed event; DB URLs and provider payloads cannot enter operational logs.
        process.stderr.write('{"event":"quickbooks_monitor_cycle_failed"}\n');
        await recordWorkerHeartbeat(prisma, { workerKey: QUICKBOOKS_MONITOR_KEY, instanceRefHash, status: "FAILED", startedAtUtc, cycleStartedAtUtc }).catch(() => undefined);
      }
      const nextAt = cycleStartedAtUtc.getTime() + 60_000;
      while (!stopping && Date.now() < nextAt) await new Promise((resolve) => setTimeout(resolve, Math.min(1000, nextAt - Date.now())));
    }
    await recordWorkerHeartbeat(prisma, { workerKey: QUICKBOOKS_MONITOR_KEY, instanceRefHash, status: "STOPPED", startedAtUtc, cycleStartedAtUtc: new Date() });
  } finally { await prisma.$disconnect(); }
}
run().catch(() => { process.stderr.write('{"event":"quickbooks_monitor_start_or_shutdown_failed"}\n'); process.exitCode = 1; });
