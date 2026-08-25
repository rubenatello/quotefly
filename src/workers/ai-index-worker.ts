import "dotenv/config";
import { prisma } from "../lib/prisma";
import {
  processNextAiIndexJob,
  reconcileAiRetrievalGovernanceJobs,
} from "../lib/ai-index-jobs";
import { assertAiRetrievalRlsReady } from "../lib/tenant-rls";
import { env } from "../config/env";
import { isAiRagEnabledForTenant } from "../lib/ai-rag-rollout";

const workerId = `ai-index-${process.pid}`;
const GOVERNANCE_RECONCILIATION_BATCH_SIZE = 100;
const GOVERNANCE_RECONCILIATION_ACTIVE_INTERVAL_MS = 10_000;
const GOVERNANCE_RECONCILIATION_IDLE_INTERVAL_MS = 15 * 60_000;
let stopping = false;
const nextGovernanceReconciliationAtByTenant = new Map<string, number>();

process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

async function pause(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function run() {
  if (!env.ENABLE_AI_INDEX_WORKER) {
    throw new Error("AI index worker is rollout-gated. Set ENABLE_AI_INDEX_WORKER=true only after mutation coverage and staging race tests pass.");
  }
  if (env.AI_RAG_ROLLOUT_MODE === "off") {
    throw new Error("AI index worker cannot start while AI_RAG_ROLLOUT_MODE=off.");
  }
  await assertAiRetrievalRlsReady(prisma, {
    requireRuntimeRole: process.env.NODE_ENV === "production",
  });
  while (!stopping) {
    let processed = 0;
    let cursor: string | undefined;
    do {
      const tenants = await prisma.tenant.findMany({
        where: { deletedAtUtc: null },
        orderBy: { id: "asc" },
        take: 100,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true },
      });
      for (const tenant of tenants) {
        if (stopping) break;
        if (!isAiRagEnabledForTenant(env, tenant.id)) continue;
        const nowMs = Date.now();
        const nextReconciliationAtMs = nextGovernanceReconciliationAtByTenant.get(tenant.id) ?? 0;
        if (nowMs >= nextReconciliationAtMs) {
          const reconciliation = await reconcileAiRetrievalGovernanceJobs(prisma, {
            tenantId: tenant.id,
            limit: GOVERNANCE_RECONCILIATION_BATCH_SIZE,
          });
          nextGovernanceReconciliationAtByTenant.set(
            tenant.id,
            nowMs + (
              reconciliation.reconciledJobCount === GOVERNANCE_RECONCILIATION_BATCH_SIZE
                ? GOVERNANCE_RECONCILIATION_ACTIVE_INTERVAL_MS
                : GOVERNANCE_RECONCILIATION_IDLE_INTERVAL_MS
            ),
          );
        }
        const result = await processNextAiIndexJob(prisma, {
          tenantId: tenant.id,
          workerId,
        });
        if (result.outcome !== "idle") processed += 1;
      }
      cursor = tenants.length === 100 ? tenants[tenants.length - 1]?.id : undefined;
    } while (cursor && !stopping);
    if (processed === 0) await pause(1_000);
  }
}

run()
  .catch((error: unknown) => {
    console.error({ err: error instanceof Error ? error.name : "UnknownError" }, "AI index worker stopped");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
