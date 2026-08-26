import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { withTenantRlsContext } from "../../src/lib/tenant-rls";
import { runAiRetentionForTenant } from "../../src/services/ai-retention";

const NOW = new Date("2026-08-25T12:00:00.000Z");

function daysBefore(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1_000);
}

async function createFixture(label: string) {
  return prisma.$transaction(async (transaction) => {
    const tenant = await transaction.tenant.create({
      data: { name: `${label} Services`, slug: `${label.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2)}` },
    });
    const user = await transaction.user.create({
      data: { email: `${label}-${Math.random().toString(36).slice(2)}@example.com`, fullName: `${label} Owner`, passwordHash: "fixture" },
    });
    await transaction.tenantUser.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" } });
    return { tenant, user };
  });
}

async function createRetentionRows(fixture: Awaited<ReturnType<typeof createFixture>>, label: string) {
  const expiredUsage = await prisma.aiUsageEvent.create({
    data: {
      tenantId: fixture.tenant.id,
      actorUserId: fixture.user.id,
      actorEmail: fixture.user.email,
      actorName: fixture.user.fullName,
      eventType: "BUSINESS_INSIGHT",
      purpose: "BUSINESS_INSIGHT",
      classification: "C2_CUSTOMER_CONFIDENTIAL",
      promptText: `${label} expired raw prompt`,
      promptRedacted: `${label} expired redacted prompt`,
      insightSummary: `${label} summary`,
      insightReasons: [`${label} reason`],
      insightSourceLabels: [`${label} source`],
      riskNote: `${label} risk note`,
      retentionExpiresAtUtc: daysBefore(1),
      createdAt: daysBefore(100),
    },
  });
  const historicalRawUsage = await prisma.aiUsageEvent.create({
    data: {
      tenantId: fixture.tenant.id,
      actorUserId: fixture.user.id,
      eventType: "DRAFT",
      promptText: `${label} historical raw prompt`,
      promptRedacted: `${label} governed redacted trace`,
      retentionExpiresAtUtc: new Date(NOW.getTime() + 24 * 60 * 60 * 1_000),
      createdAt: daysBefore(10),
      deletedAtUtc: daysBefore(2),
    },
  });
  const currentUsage = await prisma.aiUsageEvent.create({
    data: {
      tenantId: fixture.tenant.id,
      actorUserId: fixture.user.id,
      eventType: "BUSINESS_INSIGHT",
      promptText: null,
      promptRedacted: `${label} current governed trace`,
      retentionExpiresAtUtc: new Date(NOW.getTime() + 24 * 60 * 60 * 1_000),
      createdAt: daysBefore(10),
    },
  });
  const feedback = await prisma.aiAssistantFeedback.create({
    data: {
      tenantId: fixture.tenant.id,
      aiUsageEventId: expiredUsage.id,
      actorUserId: fixture.user.id,
      rating: "DOWN",
      note: `${label} private feedback note`,
      createdAt: daysBefore(181),
      deletedAtUtc: daysBefore(1),
    },
  });
  const retrievalAudit = await withTenantRlsContext(prisma, fixture.tenant.id, (transaction) => (
    transaction.aiRetrievalAuditEvent.create({
      data: {
        tenantId: fixture.tenant.id,
        actorUserId: fixture.user.id,
        requestId: `${label}-retention-request`,
        purpose: "BUSINESS_INSIGHT",
        maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
        sourceTypes: ["Customer"],
        sourceRefs: [{ sourceType: "Customer", sourceId: "private-reference" }],
        resultCount: 1,
        queryHash: "a".repeat(64),
        policyVersion: "2026-08-25",
        filterSummary: { privateFilter: true },
        rankingSummary: { privateRanking: true },
        retentionExpiresAtUtc: daysBefore(1),
        createdAt: daysBefore(100),
      },
    })
  ));
  return { expiredUsage, historicalRawUsage, currentUsage, feedback, retrievalAudit };
}

describe("AI privacy retention", () => {
  beforeEach(async () => {
    await prisma.tenant.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test("dry-runs first, minimizes expired content, remains idempotent, and does not cross tenants", async () => {
    const first = await createFixture("AiRetentionFirst");
    const second = await createFixture("AiRetentionSecond");
    const firstRows = await createRetentionRows(first, "first");
    const secondRows = await createRetentionRows(second, "second");

    const dryRun = await runAiRetentionForTenant(prisma, { tenantId: first.tenant.id, now: NOW, apply: false });
    expect(dryRun).toMatchObject({
      lockSkipped: false,
      hasMore: false,
      eligibleExpiredUsageTraceCount: 1,
      eligibleHistoricalRawPromptCount: 1,
      eligibleExpiredRetrievalAuditCount: 1,
      eligibleExpiredFeedbackCount: 1,
      minimizedExpiredUsageTraceCount: 0,
      archivedExpiredFeedbackCount: 0,
    });
    expect((await prisma.aiUsageEvent.findUniqueOrThrow({ where: { id: firstRows.expiredUsage.id } })).promptText).not.toBeNull();

    const applied = await runAiRetentionForTenant(prisma, { tenantId: first.tenant.id, now: NOW, apply: true });
    expect(applied).toMatchObject({
      lockSkipped: false,
      hasMore: false,
      minimizedExpiredUsageTraceCount: 1,
      minimizedHistoricalRawPromptCount: 1,
      archivedExpiredRetrievalAuditCount: 1,
      archivedExpiredFeedbackCount: 1,
    });
    const expiredUsage = await prisma.aiUsageEvent.findUniqueOrThrow({ where: { id: firstRows.expiredUsage.id } });
    expect(expiredUsage).toMatchObject({
      promptText: null,
      promptRedacted: null,
      actorEmail: null,
      actorName: null,
      insightSummary: null,
      insightReasons: [],
      insightSourceLabels: [],
      riskNote: null,
    });
    expect((await prisma.aiUsageEvent.findUniqueOrThrow({ where: { id: firstRows.historicalRawUsage.id } })).promptText).toBeNull();
    expect((await prisma.aiUsageEvent.findUniqueOrThrow({ where: { id: firstRows.currentUsage.id } })).promptRedacted).not.toBeNull();
    expect(await prisma.aiAssistantFeedback.findUniqueOrThrow({
      where: { tenantId_aiUsageEventId_actorUserId: {
        tenantId: first.tenant.id,
        aiUsageEventId: firstRows.expiredUsage.id,
        actorUserId: first.user.id,
      } },
    })).toMatchObject({ note: null, deletedAtUtc: expect.any(Date) });
    expect(await prisma.aiRetrievalAuditEvent.findUniqueOrThrow({ where: { id: firstRows.retrievalAudit.id } })).toMatchObject({
      actorUserId: null,
      sourceTypes: [],
      sourceRefs: null,
      filterSummary: null,
      rankingSummary: null,
      deletedAtUtc: expect.any(Date),
    });

    expect((await prisma.aiUsageEvent.findUniqueOrThrow({ where: { id: secondRows.expiredUsage.id } })).promptText).not.toBeNull();
    expect(await prisma.aiAssistantFeedback.findUniqueOrThrow({
      where: { tenantId_aiUsageEventId_actorUserId: {
        tenantId: second.tenant.id,
        aiUsageEventId: secondRows.expiredUsage.id,
        actorUserId: second.user.id,
      } },
    })).toMatchObject({
      note: "second private feedback note",
      deletedAtUtc: secondRows.feedback.deletedAtUtc,
    });

    const repeated = await runAiRetentionForTenant(prisma, { tenantId: first.tenant.id, now: NOW, apply: true });
    expect(repeated).toMatchObject({
      minimizedExpiredUsageTraceCount: 0,
      minimizedHistoricalRawPromptCount: 0,
      archivedExpiredRetrievalAuditCount: 0,
      archivedExpiredFeedbackCount: 0,
      hasMore: false,
    });
  });
});
