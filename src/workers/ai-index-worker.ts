import "dotenv/config";
import { prisma } from "../lib/prisma";
import { processNextAiIndexJob } from "../lib/ai-index-jobs";
import { assertAiRetrievalRlsReady } from "../lib/tenant-rls";
import { env } from "../config/env";

const workerId = `ai-index-${process.pid}`;
let stopping = false;

process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

async function pause(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function run() {
  if (!env.ENABLE_AI_INDEX_WORKER) {
    throw new Error("AI index worker is rollout-gated. Set ENABLE_AI_INDEX_WORKER=true only after mutation coverage and staging race tests pass.");
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
