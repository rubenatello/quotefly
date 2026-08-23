import { Prisma } from "@prisma/client";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { env } from "../../src/config/env";
import { getDataClassificationCatalog } from "../../src/lib/data-governance-catalog";
import {
  claimAiIndexJob,
  enqueueAiIndexJob,
  processClaimedAiIndexJob,
} from "../../src/lib/ai-index-jobs";
import { prisma } from "../../src/lib/prisma";
import { withTenantRlsContext } from "../../src/lib/tenant-rls";
import {
  AI_USAGE_ERROR_CODES,
  AiUsageLedgerError,
  finalizeAiProviderCall,
  hashAiUsageRequest,
  loadAiUsageLedgerTotals,
  reserveAiProviderCall,
  reserveAiUsageOperation,
  runWithAiUsageOperation,
} from "../../src/services/ai-usage-ledger";
import {
  createOpenAiChatCompletion,
  setAiProviderGatewayTestHooks,
} from "../../src/services/ai-provider-gateway";
import { reconcileAuthoritativeAiUsagePeriod } from "../../src/services/ai-usage-period-reconciliation";

const JULY = new Date("2026-07-31T23:59:00.000Z");
const AUGUST = new Date("2026-08-01T00:05:00.000Z");
const ACTIVE_UNTIL = new Date("2027-01-01T00:00:00.000Z");
const ORIGINAL_OPENAI_API_KEY = env.OPENAI_API_KEY;

async function createActiveTenant(label: string, plan = "enterprise") {
  const unique = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return prisma.tenant.create({
    data: {
      name: unique,
      slug: unique.toLowerCase(),
      primaryTrade: "ROOFING",
      subscriptionStatus: "active",
      subscriptionPlanCode: plan,
      stripeCustomerId: `cus_${unique}`,
      stripeSubscriptionId: `sub_${unique}`,
      subscriptionCurrentPeriodStartUtc: new Date("2026-08-01T00:00:00.000Z"),
      subscriptionCurrentPeriodEndUtc: ACTIVE_UNTIL,
    },
  });
}

function requestHash(label: string) {
  return hashAiUsageRequest({ label });
}

function providerReservation(ceilingCostMicros = 1n) {
  return reserveAiProviderCall({
    model: "gpt-4o-mini",
    pricingVersion: "test-approved-v1",
    inputRateMicrosPerM: 150_000n,
    outputRateMicrosPerM: 600_000n,
    serializedInputBytes: 1,
    maxOutputTokens: 1,
    ceilingCostMicros,
  });
}

async function expectLedgerError(
  promise: Promise<unknown>,
  code: string,
  statusCode: number,
) {
  try {
    await promise;
    throw new Error("Expected an AI usage ledger error.");
  } catch (error) {
    expect(error).toBeInstanceOf(AiUsageLedgerError);
    expect(error).toMatchObject({ code, statusCode });
  }
}

describe("atomic AI usage ledger", () => {
  beforeEach(async () => {
    setAiProviderGatewayTestHooks(null);
    await prisma.quickBooksWebhookEvent.deleteMany();
    await prisma.billingWebhookEvent.deleteMany();
    await prisma.tenant.deleteMany();
    await prisma.user.deleteMany();
  });

  afterEach(() => {
    env.OPENAI_API_KEY = ORIGINAL_OPENAI_API_KEY;
    setAiProviderGatewayTestHooks(null);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test("global idempotency remains stable for active, terminal, mismatch, and UTC rollover replays", async () => {
    const tenant = await createActiveTenant("idempotency");
    const key = "ledger-rollover-key-0001";
    const hash = requestHash("same");
    const rollover = await Promise.allSettled([
      reserveAiUsageOperation(prisma, {
        tenantId: tenant.id,
        operation: "TEST_OPERATION",
        userEmail: "superuser-integration@example.com",
        idempotencyKey: key,
        requestHash: hash,
        now: new Date("2026-07-31T23:59:59.000Z"),
      }),
      reserveAiUsageOperation(prisma, {
        tenantId: tenant.id,
        operation: "TEST_OPERATION",
        userEmail: "superuser-integration@example.com",
        idempotencyKey: key,
        requestHash: hash,
        now: new Date("2026-08-01T00:00:01.000Z"),
      }),
    ]);
    const fulfilled = rollover.filter((result) => result.status === "fulfilled");
    const rejected = rollover.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: AI_USAGE_ERROR_CODES.IN_PROGRESS,
      statusCode: 409,
    });
    const root = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof reserveAiUsageOperation>>>).value;
    await expectLedgerError(
      reserveAiUsageOperation(prisma, {
        tenantId: tenant.id,
        operation: "TEST_OPERATION",
        userEmail: "superuser-integration@example.com",
        idempotencyKey: key,
        requestHash: requestHash("different"),
        now: new Date("2026-08-01T00:00:01.000Z"),
      }),
      AI_USAGE_ERROR_CODES.ALREADY_PROCESSED,
      409,
    );

    await withTenantRlsContext(prisma, tenant.id, (tx) => tx.aiUsageReservation.update({
      where: { id: root.id },
      data: { state: "SETTLED", actualCredits: 1, actualCostMicros: 0n, finalizedAtUtc: AUGUST },
    }));
    await expectLedgerError(
      reserveAiUsageOperation(prisma, {
        tenantId: tenant.id,
        operation: "TEST_OPERATION",
        userEmail: "superuser-integration@example.com",
        idempotencyKey: key,
        requestHash: hash,
        now: AUGUST,
      }),
      AI_USAGE_ERROR_CODES.ALREADY_PROCESSED,
      409,
    );
    expect(await prisma.aiUsageReservation.count({ where: { tenantId: tenant.id, kind: "OPERATION" } })).toBe(1);
  });

  test("parallel near-cap provider reservations authorize one request and isolate tenant capacity", async () => {
    const tenant = await createActiveTenant("parallel-cap", "starter");
    const otherTenant = await createActiveTenant("parallel-other", "starter");
    const totals = await loadAiUsageLedgerTotals(prisma, tenant.id);
    await withTenantRlsContext(prisma, tenant.id, (tx) => tx.aiUsagePeriod.update({
      where: { id: totals.periodId },
      data: { completedCostMicros: 1_249_999n },
    }));

    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let authorizations = 0;
    let rejections = 0;
    const attempts = Array.from({ length: 8 }, (_, index) => runWithAiUsageOperation(prisma, {
      tenantId: tenant.id,
      operation: "PARALLEL_CAP",
      idempotencyKey: `parallel-cap-request-${String(index).padStart(4, "0")}`,
      requestHash: requestHash(`parallel-${index}`),
    }, async () => {
      const child = await providerReservation(1n);
      authorizations += 1;
      if (authorizations > 1) release();
      await hold;
      await finalizeAiProviderCall(child, { outcome: "VOID" });
      return "authorized";
    }).catch((error) => {
      rejections += 1;
      if (rejections === 7) release();
      throw error;
    }));
    const safetyTimer = setTimeout(release, 5_000);
    const results = await Promise.allSettled(attempts);
    clearTimeout(safetyTimer);

    expect(authorizations).toBe(1);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(7);
    await expect(runWithAiUsageOperation(prisma, {
      tenantId: otherTenant.id,
      operation: "OTHER_TENANT",
      idempotencyKey: "other-tenant-request-0001",
      requestHash: requestHash("other-tenant"),
    }, async () => {
      const child = await providerReservation(1n);
      await finalizeAiProviderCall(child, { outcome: "VOID" });
      return true;
    })).resolves.toBe(true);
  });

  test("uses exact paid and trial cycle bounds and never derives a missing paid start from its end", async () => {
    const paid = await prisma.tenant.create({
      data: {
        name: "Exact paid period",
        slug: `exact-paid-${Date.now()}`,
        subscriptionStatus: "active",
        subscriptionPlanCode: "starter",
        stripeCustomerId: `cus_exact_paid_${Date.now()}`,
        stripeSubscriptionId: `sub_exact_paid_${Date.now()}`,
        subscriptionCurrentPeriodStartUtc: new Date("2026-08-13T17:25:00.000Z"),
        subscriptionCurrentPeriodEndUtc: new Date("2026-09-13T17:25:00.000Z"),
      },
    });
    const trial = await prisma.tenant.create({
      data: {
        name: "Exact trial period",
        slug: `exact-trial-${Date.now()}`,
        subscriptionStatus: "trialing",
        trialStartsAtUtc: new Date("2026-08-10T09:15:00.000Z"),
        trialEndsAtUtc: new Date("2026-08-30T09:15:00.000Z"),
      },
    });
    const legacy = await prisma.tenant.create({
      data: {
        name: "Legacy paid period",
        slug: `legacy-paid-${Date.now()}`,
        subscriptionStatus: "active",
        subscriptionPlanCode: "starter",
        stripeCustomerId: `cus_legacy_paid_${Date.now()}`,
        stripeSubscriptionId: `sub_legacy_paid_${Date.now()}`,
        subscriptionCurrentPeriodEndUtc: new Date("2026-09-13T17:25:00.000Z"),
      },
    });
    const now = new Date("2026-08-23T12:00:00.000Z");

    const paidRoot = await reserveAiUsageOperation(prisma, {
      tenantId: paid.id,
      operation: "PAID_PERIOD",
      idempotencyKey: "paid-period-request-0001",
      requestHash: requestHash("paid-period"),
      now,
    });
    const trialRoot = await reserveAiUsageOperation(prisma, {
      tenantId: trial.id,
      operation: "TRIAL_PERIOD",
      idempotencyKey: "trial-period-request-0001",
      requestHash: requestHash("trial-period"),
      now,
    });
    const [paidPeriod, trialPeriod, legacySnapshot] = await Promise.all([
      prisma.aiUsagePeriod.findUniqueOrThrow({ where: { id: paidRoot.periodId } }),
      prisma.aiUsagePeriod.findUniqueOrThrow({ where: { id: trialRoot.periodId } }),
      loadAiUsageLedgerTotals(prisma, legacy.id, now),
    ]);
    expect(paidPeriod).toMatchObject({
      periodStartUtc: new Date("2026-08-13T17:25:00.000Z"),
      periodEndUtc: new Date("2026-09-13T17:25:00.000Z"),
    });
    expect(trialPeriod).toMatchObject({
      periodStartUtc: new Date("2026-08-10T09:15:00.000Z"),
      periodEndUtc: new Date("2026-08-30T09:15:00.000Z"),
    });
    expect(legacySnapshot.periodSource).toBe("UTC_CALENDAR_LEGACY");
    expect(legacySnapshot.periodStartUtc.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    await expectLedgerError(reserveAiUsageOperation(prisma, {
      tenantId: legacy.id,
      operation: "LEGACY_PERIOD",
      idempotencyKey: "legacy-period-request-0001",
      requestHash: requestHash("legacy-period"),
      now,
    }), AI_USAGE_ERROR_CODES.ACCOUNTING_UNAVAILABLE, 503);
    expect(await prisma.aiUsageReservation.count({ where: { tenantId: legacy.id } })).toBe(0);
  });

  test("reconciles proration totals exactly once and serializes both billing/root commit orders", async () => {
    const tenant = await prisma.tenant.create({
      data: {
        name: "Proration tenant",
        slug: `proration-${Date.now()}`,
        subscriptionStatus: "active",
        subscriptionPlanCode: "starter",
        stripeCustomerId: `cus_proration_${Date.now()}`,
        stripeSubscriptionId: `sub_proration_${Date.now()}`,
        subscriptionCurrentPeriodStartUtc: new Date("2026-08-01T00:00:00.000Z"),
        subscriptionCurrentPeriodEndUtc: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    const other = await createActiveTenant("proration-other", "starter");
    const now = new Date("2026-08-23T12:00:00.000Z");
    const newStart = new Date("2026-08-20T12:00:00.000Z");
    const newEnd = new Date("2026-09-20T12:00:00.000Z");
    await prisma.aiUsageEvent.create({
      data: {
        tenantId: tenant.id,
        eventType: "BUSINESS_INSIGHT",
        creditsConsumed: 4,
        requestCount: 1,
        estimatedCostUsd: "0.004321",
        createdAt: new Date("2026-08-22T12:00:00.000Z"),
      },
    });
    await prisma.aiUsageEvent.create({
      data: {
        tenantId: other.id,
        eventType: "BUSINESS_INSIGHT",
        creditsConsumed: 99,
        requestCount: 1,
        estimatedCostUsd: "0.999999",
        createdAt: new Date("2026-08-22T12:00:00.000Z"),
      },
    });

    // Root-first: an active reservation remains immutably old-period work and
    // cannot delay a renewal or be imported into the new period.
    const oldRoot = await reserveAiUsageOperation(prisma, {
      tenantId: tenant.id,
      operation: "ROOT_FIRST",
      idempotencyKey: "root-first-proration-0001",
      requestHash: requestHash("root-first"),
      now,
    });
    await prisma.$transaction(async (tx) => {
      await tx.tenant.update({
        where: { id: tenant.id },
        data: {
          subscriptionCurrentPeriodStartUtc: newStart,
          subscriptionCurrentPeriodEndUtc: newEnd,
        },
      });
      await reconcileAuthoritativeAiUsagePeriod(tx, {
        tenantId: tenant.id,
        periodStartUtc: newStart,
        periodEndUtc: newEnd,
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).subscriptionCurrentPeriodStartUtc)
      .toEqual(newStart);
    const rootFirstNewPeriod = await prisma.aiUsagePeriod.findUniqueOrThrow({
      where: { tenantId_periodStartUtc: { tenantId: tenant.id, periodStartUtc: newStart } },
    });
    expect(rootFirstNewPeriod.completedCredits).toBe(4);
    expect(oldRoot.periodId).not.toBe(rootFirstNewPeriod.id);

    await withTenantRlsContext(prisma, tenant.id, (tx) => tx.aiUsageReservation.update({
      where: { id: oldRoot.id },
      data: { state: "VOIDED", finalizedAtUtc: now },
    }));

    // Webhook-first: the authoritative bounds and backfilled totals commit,
    // then the next root reads the new bounds under the shared Tenant lock.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await prisma.$transaction(async (tx) => {
        await tx.tenant.update({
          where: { id: tenant.id },
          data: {
            subscriptionCurrentPeriodStartUtc: newStart,
            subscriptionCurrentPeriodEndUtc: newEnd,
          },
        });
        await reconcileAuthoritativeAiUsagePeriod(tx, {
          tenantId: tenant.id,
          periodStartUtc: newStart,
          periodEndUtc: newEnd,
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    }
    const newPeriod = await prisma.aiUsagePeriod.findUniqueOrThrow({
      where: { tenantId_periodStartUtc: { tenantId: tenant.id, periodStartUtc: newStart } },
    });
    expect(newPeriod.completedCredits).toBe(4);
    expect(newPeriod.completedCostMicros).toBe(4_321n);

    const newRoot = await reserveAiUsageOperation(prisma, {
      tenantId: tenant.id,
      operation: "WEBHOOK_FIRST",
      idempotencyKey: "webhook-first-proration-0001",
      requestHash: requestHash("webhook-first"),
      now,
    });
    expect(newRoot.periodId).toBe(newPeriod.id);
    expect(await prisma.aiUsagePeriod.count({ where: { tenantId: other.id, periodStartUtc: newStart } })).toBe(0);

    // Same-period reconciliation must also wait: a provider child may already
    // have charged cost while its active root has not persisted the audit yet.
    await withTenantRlsContext(prisma, tenant.id, async (tx) => {
      await tx.aiUsageReservation.update({ where: { id: newRoot.id }, data: { state: "STARTED" } });
      await tx.aiUsageReservation.create({
        data: {
          tenantId: tenant.id,
          periodId: newPeriod.id,
          parentReservationId: newRoot.id,
          kind: "PROVIDER_CALL",
          state: "SETTLED",
          operation: "WEBHOOK_FIRST",
          model: "gpt-4o-mini",
          pricingVersion: "test-approved-v1",
          inputRateMicrosPerM: 150_000n,
          outputRateMicrosPerM: 600_000n,
          idempotencyKeyHash: requestHash("same-period-child-key"),
          requestHash: requestHash("same-period-child-request"),
          reservedCredits: 0,
          actualCredits: 0,
          ceilingCostMicros: 17n,
          actualCostMicros: 17n,
          serializedInputBytes: 1,
          maxOutputTokens: 1,
          providerStartedAtUtc: now,
          expiresAtUtc: new Date(now.getTime() + 60_000),
          finalizedAtUtc: now,
        },
      });
      await tx.aiUsagePeriod.update({ where: { id: newPeriod.id }, data: { completedCostMicros: { increment: 17n } } });
    });
    await expect(prisma.$transaction((tx) => reconcileAuthoritativeAiUsagePeriod(tx, {
      tenantId: tenant.id,
      periodStartUtc: newStart,
      periodEndUtc: newEnd,
    }))).rejects.toThrow("AI_USAGE_PERIOD_RECONCILIATION_ACTIVE_RESERVATION");
    expect((await prisma.aiUsagePeriod.findUniqueOrThrow({ where: { id: newPeriod.id } })).completedCostMicros)
      .toBe(4_338n);
  });

  test("reconciliation attributes a boundary-crossing linked audit to its reserved root period", async () => {
    const tenant = await createActiveTenant("boundary-attribution", "starter");
    const oldStart = new Date("2026-08-01T00:00:00.000Z");
    const oldEnd = new Date("2026-09-01T00:00:00.000Z");
    const newStart = oldEnd;
    const newEnd = new Date("2026-10-01T00:00:00.000Z");
    const oldPeriod = await withTenantRlsContext(prisma, tenant.id, (tx) => tx.aiUsagePeriod.upsert({
      where: { tenantId_periodStartUtc: { tenantId: tenant.id, periodStartUtc: oldStart } },
      create: { tenantId: tenant.id, periodStartUtc: oldStart, periodEndUtc: oldEnd },
      update: { periodEndUtc: oldEnd },
    }));
    const root = await withTenantRlsContext(prisma, tenant.id, (tx) => tx.aiUsageReservation.create({
      data: {
        tenantId: tenant.id,
        periodId: oldPeriod.id,
        kind: "OPERATION",
        state: "SETTLED",
        operation: "BOUNDARY_CROSSING",
        idempotencyKeyHash: requestHash("boundary-key"),
        requestHash: requestHash("boundary-request"),
        reservedCredits: 1,
        actualCredits: 1,
        ceilingCostMicros: 0n,
        actualCostMicros: 0n,
        expiresAtUtc: new Date("2026-09-01T00:10:00.000Z"),
        finalizedAtUtc: new Date("2026-09-01T00:01:00.000Z"),
        createdAt: new Date("2026-08-31T23:59:00.000Z"),
      },
    }));
    await withTenantRlsContext(prisma, tenant.id, (tx) => tx.aiUsageEvent.create({
      data: {
        tenantId: tenant.id,
        rootReservationId: root.id,
        ledgerAccountedAtUtc: new Date("2026-09-01T00:01:00.000Z"),
        eventType: "ACCOUNTING",
        creditsConsumed: 1,
        requestCount: 1,
        estimatedCostUsd: "0.000055",
        createdAt: new Date("2026-09-01T00:01:00.000Z"),
      },
    }));

    for (const bounds of [
      { periodStartUtc: newStart, periodEndUtc: newEnd },
      { periodStartUtc: oldStart, periodEndUtc: oldEnd },
      { periodStartUtc: newStart, periodEndUtc: newEnd },
    ]) {
      await prisma.$transaction((tx) => reconcileAuthoritativeAiUsagePeriod(tx, {
        tenantId: tenant.id,
        ...bounds,
      }));
    }
    const [oldTotals, newTotals] = await Promise.all([
      prisma.aiUsagePeriod.findUniqueOrThrow({
        where: { tenantId_periodStartUtc: { tenantId: tenant.id, periodStartUtc: oldStart } },
      }),
      prisma.aiUsagePeriod.findUniqueOrThrow({
        where: { tenantId_periodStartUtc: { tenantId: tenant.id, periodStartUtc: newStart } },
      }),
    ]);
    expect(oldTotals).toMatchObject({ completedCredits: 1, completedCostMicros: 55n });
    expect(newTotals).toMatchObject({ completedCredits: 0, completedCostMicros: 0n });
  });

  test("snapshot reaps prior-period work, releases unstarted holds, and aggregates started children once", async () => {
    const tenant = await createActiveTenant("expiry");
    const unstarted = await reserveAiUsageOperation(prisma, {
      tenantId: tenant.id,
      operation: "UNSTARTED",
      userEmail: "superuser-integration@example.com",
      idempotencyKey: "expired-unstarted-root-0001",
      requestHash: requestHash("unstarted"),
      now: JULY,
      ttlMs: 1,
    });
    const started = await reserveAiUsageOperation(prisma, {
      tenantId: tenant.id,
      operation: "STARTED",
      userEmail: "superuser-integration@example.com",
      idempotencyKey: "expired-started-root-0001",
      requestHash: requestHash("started"),
      now: JULY,
      ttlMs: 1,
    });
    await withTenantRlsContext(prisma, tenant.id, async (tx) => {
      await tx.aiUsageReservation.update({ where: { id: started.id }, data: { state: "STARTED" } });
      for (const [index, ceiling] of [11n, 19n].entries()) {
        await tx.aiUsageReservation.create({
          data: {
            tenantId: tenant.id,
            periodId: started.periodId,
            parentReservationId: started.id,
            kind: "PROVIDER_CALL",
            state: "STARTED",
            operation: "STARTED",
            model: "gpt-4o-mini",
            pricingVersion: "test-approved-v1",
            inputRateMicrosPerM: 150_000n,
            outputRateMicrosPerM: 600_000n,
            idempotencyKeyHash: requestHash(`child-key-${index}`),
            requestHash: requestHash(`child-request-${index}`),
            reservedCredits: 0,
            ceilingCostMicros: ceiling,
            serializedInputBytes: 1,
            maxOutputTokens: 1,
            providerStartedAtUtc: JULY,
            expiresAtUtc: new Date(JULY.getTime() + 1),
          },
        });
      }
    });

    const current = await loadAiUsageLedgerTotals(prisma, tenant.id, AUGUST);
    expect(current.periodStartUtc.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(current.completedCredits).toBe(0);
    expect(current.completedCostMicros).toBe(0n);
    expect(current.activeReservationCount).toBe(0);

    const [released, charged, prior, audits] = await Promise.all([
      prisma.aiUsageReservation.findUniqueOrThrow({ where: { id: unstarted.id } }),
      prisma.aiUsageReservation.findUniqueOrThrow({ where: { id: started.id } }),
      prisma.aiUsagePeriod.findUniqueOrThrow({ where: { id: started.periodId } }),
      prisma.aiUsageEvent.findMany({ where: { tenantId: tenant.id, rootReservationId: started.id } }),
    ]);
    expect(released.state).toBe("VOIDED");
    expect(charged).toMatchObject({ state: "EXPIRED_CHARGED", actualCredits: 1 });
    expect(prior.completedCredits).toBe(1);
    expect(prior.completedCostMicros).toBe(30n);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ eventType: "ACCOUNTING", creditsConsumed: 1, requestCount: 2 });
    expect(audits[0]?.promptText).toBeNull();
  });

  test("the fifteen-minute root TTL is not reaped during the bounded multi-call window", async () => {
    const tenant = await createActiveTenant("ttl");
    const start = new Date("2026-08-22T12:00:00.000Z");
    const root = await reserveAiUsageOperation(prisma, {
      tenantId: tenant.id,
      operation: "LONG_QUOTE",
      idempotencyKey: "long-quote-root-key-0001",
      requestHash: requestHash("long-quote"),
      now: start,
    });
    expect(root.expiresAtUtc.getTime() - start.getTime()).toBe(15 * 60_000);
    const active = await loadAiUsageLedgerTotals(prisma, tenant.id, new Date(start.getTime() + 10 * 60_000));
    expect(active.activeReservationCount).toBe(1);
    const released = await loadAiUsageLedgerTotals(prisma, tenant.id, new Date(start.getTime() + 16 * 60_000));
    expect(released.activeReservationCount).toBe(0);
    expect((await prisma.aiUsageReservation.findUniqueOrThrow({ where: { id: root.id } })).state).toBe("VOIDED");
  });

  test("legacy bridge is UTC-stable and linked events never double count", async () => {
    const tenant = await createActiveTenant("legacy-bridge");
    const createdAt = new Date("2026-07-31T23:30:00.000Z");
    const legacy = await withTenantRlsContext(prisma, tenant.id, async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Pacific/Auckland'");
      return tx.aiUsageEvent.create({
        data: {
          tenantId: tenant.id,
          eventType: "BUSINESS_INSIGHT",
          creditsConsumed: 2,
          requestCount: 1,
          estimatedCostUsd: "0.000123",
          createdAt,
        },
      });
    });
    const legacyStored = await prisma.aiUsageEvent.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(legacyStored.ledgerAccountedAtUtc).not.toBeNull();
    const july = await prisma.aiUsagePeriod.findUniqueOrThrow({
      where: { tenantId_periodStartUtc: { tenantId: tenant.id, periodStartUtc: new Date("2026-07-01T00:00:00.000Z") } },
    });
    expect(july.completedCredits).toBe(2);
    expect(july.completedCostMicros).toBe(123n);

    const root = await reserveAiUsageOperation(prisma, {
      tenantId: tenant.id,
      operation: "LINKED",
      userEmail: "superuser-integration@example.com",
      idempotencyKey: "linked-audit-root-key-0001",
      requestHash: requestHash("linked"),
      now: createdAt,
    });
    await withTenantRlsContext(prisma, tenant.id, (tx) => tx.aiUsageEvent.create({
      data: {
        tenantId: tenant.id,
        rootReservationId: root.id,
        ledgerAccountedAtUtc: createdAt,
        eventType: "ACCOUNTING",
        creditsConsumed: 9,
        requestCount: 1,
        estimatedCostUsd: "9.0",
      },
    }));
    const unchanged = await prisma.aiUsagePeriod.findUniqueOrThrow({ where: { id: july.id } });
    expect(unchanged.completedCredits).toBe(2);
    expect(unchanged.completedCostMicros).toBe(123n);
    await expect(withTenantRlsContext(prisma, tenant.id, (tx) => tx.aiUsageEvent.create({
      data: {
        tenantId: tenant.id,
        rootReservationId: root.id,
        ledgerAccountedAtUtc: createdAt,
        eventType: "ACCOUNTING",
        creditsConsumed: 0,
        requestCount: 1,
      },
    }))).rejects.toMatchObject({ code: "P2002" });
  });

  test("legacy runtime inserts safely self-bind forced RLS and reject a mismatched tenant context", async () => {
    const tenant = await createActiveTenant("legacy-runtime");
    const otherTenant = await createActiveTenant("legacy-runtime-other");
    const eventId = `legacy-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const createdAt = new Date("2026-08-22T14:30:00.000Z");

    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      const before = await tx.$queryRaw<Array<{ tenantId: string | null }>>(Prisma.sql`
        SELECT NULLIF(current_setting('app.tenant_id', true), '') AS "tenantId"
      `);
      expect(before[0]?.tenantId ?? null).toBeNull();
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "AiUsageEvent" (
          "id", "tenantId", "eventType", "creditsConsumed", "requestCount",
          "estimatedCostUsd", "createdAt"
        ) VALUES (
          ${eventId}, ${tenant.id}, ${"BUSINESS_INSIGHT"}::"AiUsageEventType", 3, 1,
          0.000321, ${createdAt}
        )
      `);
    });

    const [stored, period] = await Promise.all([
      prisma.aiUsageEvent.findUniqueOrThrow({ where: { id: eventId } }),
      prisma.aiUsagePeriod.findUniqueOrThrow({
        where: {
          tenantId_periodStartUtc: {
            tenantId: tenant.id,
            periodStartUtc: new Date("2026-08-01T00:00:00.000Z"),
          },
        },
      }),
    ]);
    expect(stored.ledgerAccountedAtUtc).not.toBeNull();
    expect(period.completedCredits).toBe(3);
    expect(period.completedCostMicros).toBe(321n);

    const mismatchedEventId = `${eventId}-mismatch`;
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$queryRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${otherTenant.id}, true)`);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "AiUsageEvent" (
          "id", "tenantId", "eventType", "creditsConsumed", "requestCount", "createdAt"
        ) VALUES (
          ${mismatchedEventId}, ${tenant.id}, ${"BUSINESS_INSIGHT"}::"AiUsageEventType", 1, 1, ${createdAt}
        )
      `);
    })).rejects.toBeTruthy();
    expect(await prisma.aiUsageEvent.findUnique({ where: { id: mismatchedEventId } })).toBeNull();
  });

  test("missing provider usage fails closed and preserves one content-free charged audit", async () => {
    const tenant = await createActiveTenant("provider-failure");
    let providerCalls = 0;
    setAiProviderGatewayTestHooks({
      chatCompletion: async () => {
        providerCalls += 1;
        return {
          id: "completion-without-usage",
          object: "chat.completion",
          created: 0,
          model: "gpt-4o-mini",
          choices: [{ index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", content: "must-not-escape", refusal: null } }],
        };
      },
    });
    await expectLedgerError(runWithAiUsageOperation(prisma, {
      tenantId: tenant.id,
      operation: "PROVIDER_FAILURE",
      idempotencyKey: "provider-failure-root-0001",
      requestHash: requestHash("provider-failure"),
    }, () => createOpenAiChatCompletion({
      model: "gpt-4o-mini",
      max_tokens: 32,
      messages: [{ role: "user", content: "test" }],
    })), AI_USAGE_ERROR_CODES.ACCOUNTING_UNAVAILABLE, 503);

    expect(providerCalls).toBe(1);
    const [root, child, audits] = await Promise.all([
      prisma.aiUsageReservation.findFirstOrThrow({ where: { tenantId: tenant.id, kind: "OPERATION" } }),
      prisma.aiUsageReservation.findFirstOrThrow({ where: { tenantId: tenant.id, kind: "PROVIDER_CALL" } }),
      prisma.aiUsageEvent.findMany({ where: { tenantId: tenant.id, eventType: "ACCOUNTING" } }),
    ]);
    expect(root.state).toBe("AMBIGUOUS_CHARGED");
    expect(child.state).toBe("AMBIGUOUS_CHARGED");
    expect(child.actualCostMicros).toBe(child.ceilingCostMicros);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ rootReservationId: root.id, creditsConsumed: 1, requestCount: 1 });
    expect(audits[0]?.promptText).toBeNull();
    expect(JSON.stringify(audits[0])).not.toContain("must-not-escape");
  });

  test("provider cost above its reserved ceiling records an incident and suppresses output", async () => {
    const tenant = await createActiveTenant("provider-overrun");
    setAiProviderGatewayTestHooks({
      chatCompletion: async () => ({
        id: "completion-over-ceiling",
        object: "chat.completion",
        created: 0,
        model: "gpt-4o-mini",
        choices: [{ index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", content: "must-not-escape", refusal: null } }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 1, total_tokens: 1_000_001 },
      }),
    });
    await expectLedgerError(runWithAiUsageOperation(prisma, {
      tenantId: tenant.id,
      operation: "PROVIDER_OVERRUN",
      idempotencyKey: "provider-overrun-root-0001",
      requestHash: requestHash("provider-overrun"),
    }, () => createOpenAiChatCompletion({
      model: "gpt-4o-mini",
      max_tokens: 1,
      messages: [{ role: "user", content: "short" }],
    })), AI_USAGE_ERROR_CODES.ACCOUNTING_UNAVAILABLE, 503);
    const [root, child, audits] = await Promise.all([
      prisma.aiUsageReservation.findFirstOrThrow({ where: { tenantId: tenant.id, kind: "OPERATION" } }),
      prisma.aiUsageReservation.findFirstOrThrow({ where: { tenantId: tenant.id, kind: "PROVIDER_CALL" } }),
      prisma.aiUsageEvent.findMany({ where: { tenantId: tenant.id, eventType: "ACCOUNTING" } }),
    ]);
    expect(root.state).toBe("AMBIGUOUS_CHARGED");
    expect(child.state).toBe("ACCOUNTING_INCIDENT");
    expect(child.actualCostMicros).toBeGreaterThan(child.ceilingCostMicros);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.rootReservationId).toBe(root.id);
    expect(JSON.stringify(audits[0])).not.toContain("must-not-escape");
  });

  test("multimodal provider input fails before reservation because the byte ceiling is text-only", async () => {
    const tenant = await createActiveTenant("multimodal-denial");
    let providerCalls = 0;
    setAiProviderGatewayTestHooks({
      chatCompletion: async () => {
        providerCalls += 1;
        throw new Error("provider must not be reached");
      },
    });
    await expectLedgerError(runWithAiUsageOperation(prisma, {
      tenantId: tenant.id,
      operation: "MULTIMODAL_DENIAL",
      idempotencyKey: "multimodal-denial-root-0001",
      requestHash: requestHash("multimodal"),
    }, () => createOpenAiChatCompletion({
      model: "gpt-4o-mini",
      max_tokens: 16,
      messages: [{
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.invalid/image.png" } }],
      }],
    })), AI_USAGE_ERROR_CODES.ACCOUNTING_UNAVAILABLE, 503);
    expect(providerCalls).toBe(0);
    expect(await prisma.aiUsageReservation.count({ where: { tenantId: tenant.id, kind: "PROVIDER_CALL" } })).toBe(0);
    expect(await prisma.aiUsageReservation.findFirst({ where: { tenantId: tenant.id, state: "VOIDED" } })).not.toBeNull();
  });

  test("a post-result settlement failure suppresses output behind the stable accounting 503", async () => {
    const tenant = await createActiveTenant("settlement-failure");
    const originalTransaction = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
    let failNextTransaction = false;
    vi.spyOn(prisma, "$transaction").mockImplementation((...args: unknown[]) => {
      if (failNextTransaction) {
        failNextTransaction = false;
        return Promise.reject(new Error("injected settlement persistence failure"));
      }
      return originalTransaction(...args);
    });

    await expectLedgerError(runWithAiUsageOperation(prisma, {
      tenantId: tenant.id,
      operation: "SETTLEMENT_FAILURE",
      idempotencyKey: "settlement-failure-root-0001",
      requestHash: requestHash("settlement-failure"),
    }, async () => {
      failNextTransaction = true;
      return "must-not-be-returned";
    }), AI_USAGE_ERROR_CODES.ACCOUNTING_UNAVAILABLE, 503);
    const root = await prisma.aiUsageReservation.findFirstOrThrow({ where: { tenantId: tenant.id, kind: "OPERATION" } });
    expect(root.state).toBe("VOIDED");
    expect(root.actualCredits).toBe(0);
  });

  test("index provider ambiguity never auto-replays the same generation", async () => {
    env.OPENAI_API_KEY = "test-provider-enabled";
    const tenant = await createActiveTenant("index-no-replay");
    const customer = await prisma.customer.create({
      data: {
        tenantId: tenant.id,
        fullName: "Index Timeout Customer",
        phone: "555-0101",
        phoneDigits: "5550101",
        notes: "Replace damaged roof flashing and seal the vent curb.",
      },
    });
    await enqueueAiIndexJob(prisma, {
      tenantId: tenant.id,
      sourceType: "Customer",
      sourceId: customer.id,
      operation: "UPSERT",
      expectedSourceUpdatedAtUtc: customer.updatedAt,
    });
    let providerCalls = 0;
    setAiProviderGatewayTestHooks({
      embeddings: async () => {
        providerCalls += 1;
        throw new Error("injected provider timeout");
      },
    });
    const firstClaim = await claimAiIndexJob(prisma, { tenantId: tenant.id, workerId: "timeout-worker" });
    expect((await processClaimedAiIndexJob(prisma, firstClaim!)).outcome).toBe("retry");
    await withTenantRlsContext(prisma, tenant.id, (tx) => tx.aiIndexJob.update({
      where: { id: firstClaim!.id },
      data: { availableAtUtc: new Date(0) },
    }));
    const secondClaim = await claimAiIndexJob(prisma, { tenantId: tenant.id, workerId: "timeout-worker" });
    expect((await processClaimedAiIndexJob(prisma, secondClaim!)).outcome).toBe("dead");
    expect(providerCalls).toBe(1);
    const [job, roots, children, audits] = await Promise.all([
      prisma.aiIndexJob.findUniqueOrThrow({ where: { id: firstClaim!.id } }),
      prisma.aiUsageReservation.findMany({ where: { tenantId: tenant.id, kind: "OPERATION" } }),
      prisma.aiUsageReservation.findMany({ where: { tenantId: tenant.id, kind: "PROVIDER_CALL" } }),
      prisma.aiUsageEvent.findMany({ where: { tenantId: tenant.id, eventType: "ACCOUNTING" } }),
    ]);
    expect(job).toMatchObject({ status: "DEAD", lastErrorCode: "AI_ACCOUNTING_RECONCILIATION_REQUIRED" });
    expect(roots).toHaveLength(1);
    expect(children).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  test("index budget deferral safely reuses only a pre-provider voided root", async () => {
    env.OPENAI_API_KEY = "test-provider-enabled";
    const tenant = await createActiveTenant("index-safe-replay", "starter");
    const totals = await loadAiUsageLedgerTotals(prisma, tenant.id);
    await withTenantRlsContext(prisma, tenant.id, (tx) => tx.aiUsagePeriod.update({
      where: { id: totals.periodId },
      data: { completedCostMicros: 1_249_999n },
    }));
    const customer = await prisma.customer.create({
      data: {
        tenantId: tenant.id,
        fullName: "Index Budget Customer",
        phone: "555-0102",
        phoneDigits: "5550102",
        notes: "Install a compact mini-split and a new disconnect.",
      },
    });
    await enqueueAiIndexJob(prisma, {
      tenantId: tenant.id,
      sourceType: "Customer",
      sourceId: customer.id,
      operation: "UPSERT",
      expectedSourceUpdatedAtUtc: customer.updatedAt,
    });
    let providerCalls = 0;
    setAiProviderGatewayTestHooks({
      embeddings: async (request) => {
        providerCalls += 1;
        const count = Array.isArray(request.input) ? request.input.length : 1;
        return {
          object: "list",
          model: "text-embedding-3-small",
          data: Array.from({ length: count }, (_, index) => ({ object: "embedding", index, embedding: Array(1536).fill(0.01) })),
          usage: { prompt_tokens: count * 10, total_tokens: count * 10 },
        };
      },
    });
    const firstClaim = await claimAiIndexJob(prisma, { tenantId: tenant.id, workerId: "budget-worker" });
    expect((await processClaimedAiIndexJob(prisma, firstClaim!)).outcome).toBe("budget_deferred");
    expect(providerCalls).toBe(0);
    const voidedRoot = await prisma.aiUsageReservation.findFirstOrThrow({ where: { tenantId: tenant.id, kind: "OPERATION" } });
    expect(voidedRoot.state).toBe("VOIDED");
    expect(await prisma.aiUsageReservation.count({ where: { tenantId: tenant.id, kind: "PROVIDER_CALL" } })).toBe(0);

    await withTenantRlsContext(prisma, tenant.id, async (tx) => {
      await tx.aiUsagePeriod.update({ where: { id: totals.periodId }, data: { completedCostMicros: 0n } });
      await tx.aiIndexJob.update({ where: { id: firstClaim!.id }, data: { availableAtUtc: new Date(0) } });
    });
    const secondClaim = await claimAiIndexJob(prisma, { tenantId: tenant.id, workerId: "budget-worker" });
    expect((await processClaimedAiIndexJob(prisma, secondClaim!)).outcome).toBe("succeeded");
    expect(providerCalls).toBe(1);
    const roots = await prisma.aiUsageReservation.findMany({ where: { tenantId: tenant.id, kind: "OPERATION" } });
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ id: voidedRoot.id, state: "SETTLED" });
  });

  test("database constraints, forced RLS, runtime grants, and governance exclusion fail closed", async () => {
    const alpha = await createActiveTenant("rls-alpha");
    const beta = await createActiveTenant("rls-beta");
    const alphaTotals = await loadAiUsageLedgerTotals(prisma, alpha.id);
    await loadAiUsageLedgerTotals(prisma, beta.id);
    await expect(withTenantRlsContext(prisma, alpha.id, (tx) => tx.$executeRaw(Prisma.sql`
      INSERT INTO "AiUsageReservation" (
        "id", "tenantId", "periodId", "kind", "state", "operation",
        "idempotencyKeyHash", "requestHash", "reservedCredits", "actualCredits",
        "ceilingCostMicros", "expiresAtUtc", "createdAt", "updatedAt", "finalizedAtUtc"
      ) VALUES (
        'malformed-operation', ${alpha.id}, ${alphaTotals.periodId}, 'OPERATION', 'SETTLED', 'MALFORMED',
        ${requestHash("malformed-key")}, ${requestHash("malformed-request")}, 1, 2,
        0, ${ACTIVE_UNTIL}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `))).rejects.toBeTruthy();

    const visible = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$queryRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${alpha.id}, true)`);
      return tx.$queryRaw<Array<{ tenantId: string }>>(Prisma.sql`
        SELECT "tenantId" FROM "AiUsagePeriod" ORDER BY "tenantId"
      `);
    });
    expect(visible.map((row) => row.tenantId)).toEqual([alpha.id]);
    const privileges = await prisma.$queryRaw<Array<{
      tableName: string;
      canSelect: boolean;
      canInsert: boolean;
      canUpdate: boolean;
      canDelete: boolean;
      canTruncate: boolean;
    }>>(Prisma.sql`
      SELECT
        table_name AS "tableName",
        has_table_privilege('quotefly_runtime', quote_ident(table_name), 'SELECT') AS "canSelect",
        has_table_privilege('quotefly_runtime', quote_ident(table_name), 'INSERT') AS "canInsert",
        has_table_privilege('quotefly_runtime', quote_ident(table_name), 'UPDATE') AS "canUpdate",
        has_table_privilege('quotefly_runtime', quote_ident(table_name), 'DELETE') AS "canDelete",
        has_table_privilege('quotefly_runtime', quote_ident(table_name), 'TRUNCATE') AS "canTruncate"
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN ('AiUsagePeriod', 'AiUsageReservation')
      ORDER BY table_name
    `);
    expect(privileges).toEqual([
      { tableName: "AiUsagePeriod", canSelect: true, canInsert: true, canUpdate: true, canDelete: false, canTruncate: false },
      { tableName: "AiUsageReservation", canSelect: true, canInsert: true, canUpdate: true, canDelete: false, canTruncate: false },
    ]);
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$queryRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${alpha.id}, true)`);
      await tx.$executeRaw(Prisma.sql`DELETE FROM "AiUsagePeriod" WHERE "tenantId" = ${alpha.id}`);
    })).rejects.toBeTruthy();
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE quotefly_runtime");
      await tx.$executeRawUnsafe('TRUNCATE TABLE "AiUsageReservation"');
    })).rejects.toBeTruthy();

    const rls = await prisma.$queryRaw<Array<{ relname: string; enabled: boolean; forced: boolean }>>(Prisma.sql`
      SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
      FROM pg_class
      WHERE relname IN ('AiUsagePeriod', 'AiUsageReservation')
      ORDER BY relname
    `);
    expect(rls).toEqual([
      { relname: "AiUsagePeriod", enabled: true, forced: true },
      { relname: "AiUsageReservation", enabled: true, forced: true },
    ]);

    const catalog = getDataClassificationCatalog();
    for (const modelName of ["AiUsagePeriod", "AiUsageReservation"]) {
      const model = catalog.models.find((entry) => entry.model === modelName);
      expect(model?.defaultClassification).toBe("C3_FINANCIAL_CONFIDENTIAL");
      expect(model?.fields.every((field) => field.ragStatus === "EXCLUDED")).toBe(true);
    }
  });

  test("migration source preserves UTC backfill and the linked-event no-double bridge invariant", () => {
    const sql = readFileSync(
      "prisma/migrations/20260823010000_add_atomic_ai_usage_ledger/migration.sql",
      "utf8",
    );
    expect(sql).toContain(`date_trunc('month', event."createdAt", 'UTC')`);
    expect(sql).toContain(`WHERE event."deletedAtUtc" IS NULL`);
    expect(sql).toMatch(/UPDATE "AiUsageEvent"[\s\S]+SET "ledgerAccountedAtUtc"/);
    expect(sql).toContain(`NEW."rootReservationId" IS NOT NULL`);
    expect(sql).toContain(`NEW."ledgerAccountedAtUtc" IS NOT NULL`);
    expect(sql).toContain("SECURITY INVOKER");
    expect(sql).toContain("SET search_path = pg_catalog, public");
    expect(sql).toContain(`NULLIF(current_setting('app.tenant_id', true), '')`);
    expect(sql).toContain(`set_config('app.tenant_id', NEW."tenantId", true)`);
  });
});
