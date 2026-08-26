import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { assertAiRetrievalRlsReady } from "../src/lib/tenant-rls";
import {
  AI_RETENTION_MAX_ROWS_PER_TENANT,
  DEFAULT_AI_FEEDBACK_RETENTION_DAYS,
  runAiRetentionForTenant,
  validateAiRetentionApplyAuthorization,
} from "../src/services/ai-retention";

function optionValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function validateArguments() {
  const known = ["--apply", "--confirm=", "--tenant-id=", "--max-rows="];
  const unknown = process.argv.slice(2).find((argument) => !known.some((prefix) => (
    prefix.endsWith("=") ? argument.startsWith(prefix) : argument === prefix
  )));
  if (unknown) throw new Error(`Unknown AI retention argument: ${unknown}`);

  const apply = process.argv.includes("--apply");
  validateAiRetentionApplyAuthorization(apply, optionValue("confirm"));
  const rawMaxRows = optionValue("max-rows");
  const maxRows = rawMaxRows === undefined ? AI_RETENTION_MAX_ROWS_PER_TENANT : Number(rawMaxRows);
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > AI_RETENTION_MAX_ROWS_PER_TENANT) {
    throw new Error(`--max-rows must be an integer from 1 to ${AI_RETENTION_MAX_ROWS_PER_TENANT}.`);
  }
  const tenantId = optionValue("tenant-id")?.trim();
  if (tenantId !== undefined && (!tenantId || tenantId.length > 191)) {
    throw new Error("--tenant-id must be a non-empty tenant identifier no longer than 191 characters.");
  }
  return { apply, maxRows, tenantId };
}

async function run() {
  const options = validateArguments();
  await assertAiRetrievalRlsReady(prisma, {
    requireRuntimeRole: process.env.NODE_ENV === "production",
  });

  let cursor: string | undefined;
  let tenantCount = 0;
  let failedTenantCount = 0;
  let skippedTenantCount = 0;
  let hasMoreTenantCount = 0;
  const totals = {
    eligibleExpiredUsageTraceCount: 0,
    eligibleHistoricalRawPromptCount: 0,
    eligibleExpiredRetrievalAuditCount: 0,
    eligibleExpiredFeedbackCount: 0,
    minimizedExpiredUsageTraceCount: 0,
    minimizedHistoricalRawPromptCount: 0,
    archivedExpiredRetrievalAuditCount: 0,
    archivedExpiredFeedbackCount: 0,
  };

  do {
    const tenants = await prisma.tenant.findMany({
      where: {
        deletedAtUtc: null,
        ...(options.tenantId ? { id: options.tenantId } : {}),
      },
      orderBy: { id: "asc" },
      take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true },
    });
    for (const tenant of tenants) {
      tenantCount += 1;
      try {
        const result = await runAiRetentionForTenant(prisma, {
          tenantId: tenant.id,
          now: new Date(),
          apply: options.apply,
          maxRows: options.maxRows,
        });
        if (result.lockSkipped) skippedTenantCount += 1;
        if (result.hasMore) hasMoreTenantCount += 1;
        for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += result[key];
      } catch (error: unknown) {
        failedTenantCount += 1;
        console.error({ errorName: error instanceof Error ? error.name : "UnknownError" }, "AI retention tenant run failed");
      }
    }
    cursor = options.tenantId ? undefined : tenants.length === 100 ? tenants.at(-1)?.id : undefined;
  } while (cursor);

  if (options.tenantId && tenantCount === 0) throw new Error("Requested tenant was not found or is deleted.");
  console.log(JSON.stringify({
    mode: options.apply ? "apply" : "dry-run",
    tenantCount,
    failedTenantCount,
    skippedTenantCount,
    hasMoreTenantCount,
    feedbackRetentionDays: DEFAULT_AI_FEEDBACK_RETENTION_DAYS,
    maxRowsPerTenant: options.maxRows,
    ...totals,
  }));
  if (failedTenantCount > 0 || (options.apply && (skippedTenantCount > 0 || hasMoreTenantCount > 0))) {
    process.exitCode = 1;
  }
}

run()
  .catch((error: unknown) => {
    console.error({ errorName: error instanceof Error ? error.name : "UnknownError" }, "AI retention run stopped");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
