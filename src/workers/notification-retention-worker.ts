import "dotenv/config";
import { env } from "../config/env";
import { prisma } from "../lib/prisma";
import { assertAiRetrievalRlsReady } from "../lib/tenant-rls";
import {
  runNotificationRetentionForTenant,
  validateNotificationRetentionPolicy,
} from "../services/notification-retention";

async function run() {
  const apply = process.argv.includes("--apply");
  if (apply && !env.ENABLE_NOTIFICATION_RETENTION_WORKER) {
    throw new Error("Notification retention apply is rollout-gated. Set ENABLE_NOTIFICATION_RETENTION_WORKER=true for the scheduled run-once worker.");
  }
  const policy = validateNotificationRetentionPolicy({
    readDays: env.NOTIFICATION_RETENTION_READ_DAYS,
    unreadDays: env.NOTIFICATION_RETENTION_UNREAD_DAYS,
  });
  await assertAiRetrievalRlsReady(prisma, {
    requireRuntimeRole: process.env.NODE_ENV === "production",
  });

  let cursor: string | undefined;
  let tenantCount = 0;
  let failedTenantCount = 0;
  let skippedTenantCount = 0;
  let archivedReadCount = 0;
  let archivedUnreadCount = 0;
  let eligibleReadCount = 0;
  let eligibleUnreadCount = 0;
  let hasMoreTenantCount = 0;
  do {
    const tenants = await prisma.tenant.findMany({
      where: { deletedAtUtc: null },
      orderBy: { id: "asc" },
      take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true },
    });
    for (const tenant of tenants) {
      tenantCount += 1;
      try {
        const result = await runNotificationRetentionForTenant(prisma, {
          tenantId: tenant.id,
          now: new Date(),
          apply,
          policy,
        });
        if (result.lockSkipped) skippedTenantCount += 1;
        archivedReadCount += result.archivedReadCount;
        archivedUnreadCount += result.archivedUnreadCount;
        eligibleReadCount += result.eligibleReadCount;
        eligibleUnreadCount += result.eligibleUnreadCount;
        if (result.hasMore) hasMoreTenantCount += 1;
      } catch (error: unknown) {
        failedTenantCount += 1;
        console.error({ errorName: error instanceof Error ? error.name : "UnknownError" }, "Notification retention tenant run failed");
      }
    }
    cursor = tenants.length === 100 ? tenants[tenants.length - 1]?.id : undefined;
  } while (cursor);

  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    tenantCount,
    failedTenantCount,
    skippedTenantCount,
    archivedReadCount,
    archivedUnreadCount,
    eligibleReadCount,
    eligibleUnreadCount,
    hasMoreTenantCount,
    readRetentionDays: policy.readDays,
    unreadRetentionDays: policy.unreadDays,
  }));
  if (failedTenantCount > 0 || (apply && (skippedTenantCount > 0 || hasMoreTenantCount > 0))) process.exitCode = 1;
}

run()
  .catch((error: unknown) => {
    console.error({ errorName: error instanceof Error ? error.name : "UnknownError" }, "Notification retention worker stopped");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
