import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test } from "vitest";
import {
  claimAiIndexJob,
  enqueueAiIndexJob,
  processClaimedAiIndexJob,
  processNextAiIndexJob,
} from "../../src/lib/ai-index-jobs";
import { upsertAiRetrievalSource } from "../../src/lib/ai-retrieval";
import { prisma } from "../../src/lib/prisma";
import { withTenantRlsContext } from "../../src/lib/tenant-rls";

async function createTenant(label: string) {
  const unique = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return prisma.tenant.create({
    data: {
      name: unique,
      slug: unique.toLowerCase(),
      primaryTrade: "GARDENING",
      subscriptionStatus: "active",
      subscriptionPlanCode: "enterprise",
      stripeCustomerId: `cus_${unique}`,
      stripeSubscriptionId: `sub_${unique}`,
      subscriptionCurrentPeriodStartUtc: new Date("2026-08-01T00:00:00.000Z"),
      subscriptionCurrentPeriodEndUtc: new Date("2027-01-01T00:00:00.000Z"),
    },
  });
}

describe("AI indexing foundation", () => {
  beforeEach(async () => {
    await prisma.quickBooksWebhookEvent.deleteMany();
    await prisma.billingWebhookEvent.deleteMany();
    await prisma.tenant.deleteMany();
    await prisma.user.deleteMany();
  });

  test("reuses embeddings only for matching active content in the same tenant", async () => {
    const alpha = await createTenant("cache-alpha");
    const beta = await createTenant("cache-beta");
    const content = "Seasonal garden cleanup with pruning and green-waste hauling.";

    const first = await upsertAiRetrievalSource(prisma, {
      tenantId: alpha.id,
      sourceType: "Customer",
      sourceId: "alpha-source-one",
      citationLabel: "Alpha source one",
      fields: [{ field: "Customer.notes", content }],
    });
    const sameTenant = await upsertAiRetrievalSource(prisma, {
      tenantId: alpha.id,
      sourceType: "Customer",
      sourceId: "alpha-source-two",
      citationLabel: "Alpha source two",
      fields: [{ field: "Customer.notes", content }],
    });
    const otherTenant = await upsertAiRetrievalSource(prisma, {
      tenantId: beta.id,
      sourceType: "Customer",
      sourceId: "beta-source-one",
      citationLabel: "Beta source one",
      fields: [{ field: "Customer.notes", content }],
    });

    expect(first.embeddingCacheHitCount).toBe(0);
    expect(sameTenant.embeddingCacheHitCount).toBe(1);
    expect(otherTenant.embeddingCacheHitCount).toBe(0);
  });

  test("coalesces updates without breaking a lease and fences stale persistence", async () => {
    const tenant = await createTenant("queue-fence");
    const customer = await prisma.customer.create({
      data: {
        tenantId: tenant.id,
        fullName: "Garden Customer",
        phone: "555-0100",
        phoneDigits: "5550100",
        notes: "Trim the citrus trees and refresh the mulch.",
      },
    });

    const queued = await enqueueAiIndexJob(prisma, {
      tenantId: tenant.id,
      sourceType: "Customer",
      sourceId: customer.id,
      operation: "UPSERT",
      expectedSourceUpdatedAtUtc: customer.updatedAt,
    });
    expect(queued?.generation).toBe(1);

    const firstClaim = await claimAiIndexJob(prisma, {
      tenantId: tenant.id,
      workerId: "worker-a",
    });
    expect(firstClaim?.status).toBe("PROCESSING");
    expect(firstClaim?.lockedBy).toMatch(/^worker-a:/);

    const coalesced = await enqueueAiIndexJob(prisma, {
      tenantId: tenant.id,
      sourceType: "Customer",
      sourceId: customer.id,
      operation: "DELETE",
      expectedSourceUpdatedAtUtc: new Date(),
    });
    expect(coalesced).toMatchObject({
      generation: 2,
      status: "PROCESSING",
      lockedBy: firstClaim?.lockedBy,
    });

    const stale = await processClaimedAiIndexJob(prisma, firstClaim!);
    expect(stale.outcome).toBe("stale");
    const pending = await withTenantRlsContext(prisma, tenant.id, (tx) => tx.aiIndexJob.findUniqueOrThrow({
      where: { tenantId_sourceType_sourceId: {
        tenantId: tenant.id,
        sourceType: "Customer",
        sourceId: customer.id,
      } },
    }));
    expect(pending).toMatchObject({ generation: 2, status: "PENDING", lockedBy: null });

    // DELETE is only a reconciliation hint. Because the canonical customer is
    // active, the latest worker indexes current content instead of deleting it.
    const latest = await processNextAiIndexJob(prisma, {
      tenantId: tenant.id,
      workerId: "worker-b",
    });
    expect(latest.outcome).toBe("succeeded");
    const document = await withTenantRlsContext(prisma, tenant.id, (tx) => tx.aiRetrievalDocument.findUniqueOrThrow({
      where: { tenantId_sourceType_sourceId: {
        tenantId: tenant.id,
        sourceType: "Customer",
        sourceId: customer.id,
      } },
    }));
    expect(document.status).toBe("ACTIVE");
    expect(document.deletedAtUtc).toBeNull();
  });

  test("claims are tenant-isolated and allow only one active lease per tenant", async () => {
    const alpha = await createTenant("queue-alpha");
    const beta = await createTenant("queue-beta");
    await enqueueAiIndexJob(prisma, {
      tenantId: alpha.id,
      sourceType: "Customer",
      sourceId: "alpha-one",
      operation: "DELETE",
    });
    await enqueueAiIndexJob(prisma, {
      tenantId: alpha.id,
      sourceType: "Customer",
      sourceId: "alpha-two",
      operation: "DELETE",
    });
    await enqueueAiIndexJob(prisma, {
      tenantId: beta.id,
      sourceType: "Customer",
      sourceId: "beta-one",
      operation: "DELETE",
    });

    const alphaClaim = await claimAiIndexJob(prisma, { tenantId: alpha.id, workerId: "shared" });
    const alphaSecond = await claimAiIndexJob(prisma, { tenantId: alpha.id, workerId: "shared" });
    const betaClaim = await claimAiIndexJob(prisma, { tenantId: beta.id, workerId: "shared" });

    expect(alphaClaim?.tenantId).toBe(alpha.id);
    expect(alphaSecond).toBeNull();
    expect(betaClaim?.tenantId).toBe(beta.id);
    expect(betaClaim?.lockedBy).not.toBe(alphaClaim?.lockedBy);
  });

  test("defers indexing until monthly renewal without consuming retry attempts when the AI budget is exhausted", async () => {
    const tenant = await createTenant("queue-budget");
    const periodEnd = new Date(Date.now() + 14 * 86_400_000);
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        subscriptionStatus: "active",
        subscriptionPlanCode: "starter",
        subscriptionCurrentPeriodEndUtc: periodEnd,
      },
    });
    await prisma.aiUsageEvent.create({
      data: {
        tenantId: tenant.id,
        eventType: "BUSINESS_INSIGHT",
        creditsConsumed: 1,
        requestCount: 1,
        estimatedCostUsd: "1.25",
      },
    });
    const customer = await prisma.customer.create({
      data: {
        tenantId: tenant.id,
        fullName: "Budget Customer",
        phone: "555-0199",
        phoneDigits: "5550199",
        notes: "Install a drought-tolerant garden bed.",
      },
    });
    await enqueueAiIndexJob(prisma, {
      tenantId: tenant.id,
      sourceType: "Customer",
      sourceId: customer.id,
      operation: "UPSERT",
      expectedSourceUpdatedAtUtc: customer.updatedAt,
    });

    const outcome = await processNextAiIndexJob(prisma, {
      tenantId: tenant.id,
      workerId: "budget-worker",
    });
    expect(outcome.outcome).toBe("budget_deferred");

    const job = await withTenantRlsContext(prisma, tenant.id, (tx) => tx.aiIndexJob.findFirstOrThrow({
      where: { tenantId: tenant.id, sourceType: "Customer", sourceId: customer.id },
    }));
    expect(job.status).toBe("PENDING");
    expect(job.attempts).toBe(0);
    expect(job.lastErrorCode).toBe("AI_BUDGET_EXHAUSTED");
    expect(job.availableAtUtc.getTime()).toBeGreaterThan(Date.now() + 24 * 60 * 60_000);
  });

  test("v2 governance migration purges legacy derived content and requeues active sources", async () => {
    const tenant = await createTenant("governance-v2-upgrade");
    const restrictedLegacyContent = "Legacy note accidentally stored AWS key AKIAIOSFODNN7EXAMPLE";
    const customer = await prisma.customer.create({
      data: {
        tenantId: tenant.id,
        fullName: "Legacy governance customer",
        phone: "555-0210",
        notes: restrictedLegacyContent,
      },
    });
    const document = await prisma.aiRetrievalDocument.create({
      data: {
        tenantId: tenant.id,
        sourceType: "Customer",
        sourceId: customer.id,
        sourceUpdatedAtUtc: customer.updatedAt,
        maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
        contentHash: "a".repeat(64),
        citationLabel: "Legacy customer notes",
        policyVersion: "2026-08-11",
        chunkerVersion: "nfkc-tiktoken-cl100k-300-overlap36-v1:rag-content-governance-v1",
      },
    });
    await prisma.aiRetrievalChunk.create({
      data: {
        tenantId: tenant.id,
        documentId: document.id,
        sourceType: "Customer",
        sourceId: customer.id,
        sourceField: "Customer.notes",
        chunkIndex: 0,
        content: restrictedLegacyContent,
        contentHash: "b".repeat(64),
        embedding: [1, 0],
        embeddingModel: "legacy-test",
        embeddingDimensions: 2,
        classification: "C2_CUSTOMER_CONFIDENTIAL",
        citationLabel: "Legacy customer notes",
        policyVersion: "2026-08-11",
        chunkerVersion: "nfkc-tiktoken-cl100k-300-overlap36-v1:rag-content-governance-v1",
      },
    });

    const migrationSql = readFileSync(
      new URL("../../prisma/migrations/20260824230000_requeue_ai_retrieval_governance_v2/migration.sql", import.meta.url),
      "utf8",
    );
    const statements = migrationSql.split(/;\s*(?:\r?\n|$)/u).map((statement) => statement.trim()).filter(Boolean);
    for (const statement of statements) await prisma.$executeRawUnsafe(statement);

    expect(await prisma.aiRetrievalDocument.count({
      where: { tenantId: tenant.id, chunkerVersion: { not: "nfkc-tiktoken-cl100k-300-overlap36-v1:rag-content-governance-v2" } },
    })).toBe(0);
    expect(await prisma.aiRetrievalChunk.count({
      where: { tenantId: tenant.id, content: { contains: "AKIAIOSFODNN7EXAMPLE" } },
    })).toBe(0);
    const queued = await prisma.aiIndexJob.findUniqueOrThrow({
      where: { tenantId_sourceType_sourceId: { tenantId: tenant.id, sourceType: "Customer", sourceId: customer.id } },
    });
    expect(queued.status).toBe("PENDING");

    const outcome = await processNextAiIndexJob(prisma, {
      tenantId: tenant.id,
      workerId: "governance-v2-upgrade-worker",
    });
    expect(outcome.outcome).toBe("quarantined");
    const finalJob = await prisma.aiIndexJob.findUniqueOrThrow({
      where: { tenantId_sourceType_sourceId: { tenantId: tenant.id, sourceType: "Customer", sourceId: customer.id } },
    });
    expect(finalJob).toMatchObject({
      status: "SUCCEEDED",
      lastErrorCode: "SOURCE_CONTENT_QUARANTINED",
    });
    expect(await prisma.aiRetrievalChunk.count({ where: { tenantId: tenant.id } })).toBe(0);
  });

  test("quarantines restricted source content as a terminal content-free job outcome", async () => {
    const tenant = await createTenant("queue-quarantine");
    const customer = await prisma.customer.create({
      data: {
        tenantId: tenant.id,
        fullName: "Quarantine Customer",
        phone: "555-0188",
        phoneDigits: "5550188",
        notes: "Replace the damaged garden gate latch.",
      },
    });
    await upsertAiRetrievalSource(prisma, {
      tenantId: tenant.id,
      sourceType: "Customer",
      sourceId: customer.id,
      citationLabel: "Customer notes",
      fields: [{ field: "Customer.notes", content: customer.notes }],
    });
    const usageBefore = await prisma.aiUsageEvent.count({ where: { tenantId: tenant.id } });
    const credentialLikeNote = [
      "Database ",
      "postgresql",
      "://",
      "demo",
      ":",
      "fake-password",
      "@db.example.com/quotefly",
    ].join("");
    const updated = await prisma.customer.update({
      where: { id_tenantId: { id: customer.id, tenantId: tenant.id } },
      data: { notes: credentialLikeNote },
    });
    await enqueueAiIndexJob(prisma, {
      tenantId: tenant.id,
      sourceType: "Customer",
      sourceId: customer.id,
      operation: "UPSERT",
      expectedSourceUpdatedAtUtc: updated.updatedAt,
    });

    const outcome = await processNextAiIndexJob(prisma, {
      tenantId: tenant.id,
      workerId: "quarantine-worker",
    });
    expect(outcome.outcome).toBe("quarantined");

    const state = await withTenantRlsContext(prisma, tenant.id, async (tx) => ({
      job: await tx.aiIndexJob.findFirstOrThrow({
        where: { tenantId: tenant.id, sourceType: "Customer", sourceId: customer.id },
      }),
      document: await tx.aiRetrievalDocument.findUniqueOrThrow({
        where: { tenantId_sourceType_sourceId: {
          tenantId: tenant.id,
          sourceType: "Customer",
          sourceId: customer.id,
        } },
      }),
      chunkCount: await tx.aiRetrievalChunk.count({
        where: { tenantId: tenant.id, sourceType: "Customer", sourceId: customer.id },
      }),
    }));
    expect(state.job).toMatchObject({
      status: "SUCCEEDED",
      lastErrorCode: "SOURCE_CONTENT_QUARANTINED",
      lockedAtUtc: null,
      lockedBy: null,
    });
    expect(state.document).toMatchObject({
      status: "DELETED",
      citationLabel: "Quarantined source",
      metadata: null,
    });
    expect(state.document.deletedAtUtc).not.toBeNull();
    expect(state.chunkCount).toBe(0);
    expect(await prisma.aiUsageEvent.count({ where: { tenantId: tenant.id } })).toBe(usageBefore);
  });
});
