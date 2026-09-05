import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { env } from "../../src/config/env";
import { prisma } from "../../src/lib/prisma";
import {
  buildQuickBooksCdcWorkItems,
  claimQuickBooksCdcCursor,
  completeQuickBooksCdcClaimFailure,
  completeQuickBooksCdcClaimSuccess,
  QUICKBOOKS_CDC_MAX_ATTEMPTS,
} from "../../src/services/quickbooks-cdc";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "../../src/services/quickbooks-setup";

async function createCdcFixture(label: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tenant = await prisma.tenant.create({
    data: {
      name: `${label} Services`,
      slug: `${label.toLowerCase()}-${stamp}`,
      subscriptionStatus: "trialing",
      trialStartsAtUtc: new Date("2026-01-01T00:00:00.000Z"),
      trialEndsAtUtc: new Date("2099-01-01T00:00:00.000Z"),
    },
  });
  const user = await prisma.user.create({
    data: {
      email: `${label.toLowerCase()}-${stamp}@example.com`,
      fullName: `${label} Owner`,
      passwordHash: "synthetic-test-hash",
    },
  });
  const membership = await prisma.tenantUser.create({
    data: { tenantId: tenant.id, userId: user.id, role: "owner" },
  });
  const connection = await prisma.quickBooksConnection.create({
    data: {
      tenantId: tenant.id,
      realmId: `realm-${label}-${stamp}`,
      environment: "sandbox",
      status: "CONNECTED",
      setupConfirmedAtUtc: new Date(),
      setupConfirmedByTenantUserId: membership.id,
      setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
    },
  });
  const cursor = await prisma.quickBooksCdcCursor.create({
    data: {
      tenantId: tenant.id,
      quickBooksConnectionId: connection.id,
      changedSinceUtc: new Date("2026-08-27T20:00:00.000Z"),
    },
  });
  return { tenant, connection, cursor };
}

describe("QuickBooks CDC lease fencing", () => {
  beforeEach(async () => {
    await prisma.quickBooksWebhookEvent.deleteMany();
    await prisma.tenant.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test("a reclaimed lease makes both stale success and stale failure terminal writes no-ops", async () => {
    const fixture = await createCdcFixture("cdc-reclaim-fence");
    const firstStartedAtUtc = new Date("2026-08-27T20:05:00.000Z");
    const firstClaim = await claimQuickBooksCdcCursor({
      prisma,
      runtimeEnv: env,
      tenantId: fixture.tenant.id,
      now: firstStartedAtUtc,
    });
    expect(firstClaim).not.toBeNull();

    const secondStartedAtUtc = new Date(firstClaim!.claimLeaseExpiresAtUtc.getTime() + 1);
    const secondClaim = await claimQuickBooksCdcCursor({
      prisma,
      runtimeEnv: env,
      tenantId: fixture.tenant.id,
      now: secondStartedAtUtc,
    });
    expect(secondClaim).not.toBeNull();
    expect(secondClaim!.claimAttemptCount).toBe(firstClaim!.claimAttemptCount + 1);

    const providerUpdatedAtUtc = new Date("2026-08-27T20:06:00.000Z");
    const staleWorkItems = buildQuickBooksCdcWorkItems({
      realmId: fixture.connection.realmId,
      invoices: [{ Id: "stale-provider-invoice", MetaData: { LastUpdatedTime: providerUpdatedAtUtc.toISOString() } }],
      payments: [],
      refundReceipts: [],
      fallbackUpdatedAtUtc: providerUpdatedAtUtc,
    });
    await expect(completeQuickBooksCdcClaimSuccess({
      prisma,
      claim: firstClaim!,
      providerCursor: providerUpdatedAtUtc,
      workItems: staleWorkItems,
      now: providerUpdatedAtUtc,
    })).resolves.toBe(false);
    await expect(completeQuickBooksCdcClaimFailure({
      prisma,
      claim: firstClaim!,
      errorCode: "STALE_WORKER_FAILURE",
      now: new Date(providerUpdatedAtUtc.getTime() + 1_000),
    })).resolves.toBe(false);

    expect(await prisma.quickBooksWebhookEvent.count({
      where: { tenantId: fixture.tenant.id },
    })).toBe(0);
    const stillClaimed = await prisma.quickBooksCdcCursor.findUniqueOrThrow({
      where: { id: fixture.cursor.id },
    });
    expect(stillClaimed).toMatchObject({
      attemptCount: secondClaim!.claimAttemptCount,
      lastAttemptAtUtc: secondClaim!.claimStartedAtUtc,
      nextAttemptAtUtc: secondClaim!.claimLeaseExpiresAtUtc,
      lastErrorCode: null,
    });

    const activeWorkItems = buildQuickBooksCdcWorkItems({
      realmId: fixture.connection.realmId,
      invoices: [{ Id: "active-provider-invoice", MetaData: { LastUpdatedTime: providerUpdatedAtUtc.toISOString() } }],
      payments: [],
      refundReceipts: [],
      fallbackUpdatedAtUtc: providerUpdatedAtUtc,
    });
    await expect(completeQuickBooksCdcClaimSuccess({
      prisma,
      claim: secondClaim!,
      providerCursor: providerUpdatedAtUtc,
      workItems: activeWorkItems,
      now: new Date(providerUpdatedAtUtc.getTime() + 2_000),
    })).resolves.toBe(true);
    await expect(prisma.quickBooksWebhookEvent.findFirst({
      where: { tenantId: fixture.tenant.id, entityId: "active-provider-invoice" },
    })).resolves.toMatchObject({
      quickBooksConnectionId: fixture.connection.id,
      realmId: fixture.connection.realmId,
      status: "RECEIVED",
    });
  });

  test("dead-letters a repeatedly failing CDC cursor instead of retrying forever", async () => {
    const fixture = await createCdcFixture("cdc-terminal-failure");
    await prisma.quickBooksCdcCursor.update({
      where: { id: fixture.cursor.id },
      data: { attemptCount: QUICKBOOKS_CDC_MAX_ATTEMPTS - 1 },
    });
    const failedAtUtc = new Date("2026-08-28T12:00:00.000Z");
    const claim = await claimQuickBooksCdcCursor({
      prisma,
      runtimeEnv: env,
      tenantId: fixture.tenant.id,
      now: new Date(failedAtUtc.getTime() - 1_000),
    });
    expect(claim?.claimAttemptCount).toBe(QUICKBOOKS_CDC_MAX_ATTEMPTS);

    await expect(completeQuickBooksCdcClaimFailure({
      prisma,
      claim: claim!,
      errorCode: "QUICKBOOKS_CDC_PROVIDER_UNAVAILABLE",
      now: failedAtUtc,
    })).resolves.toBe(true);

    await expect(prisma.quickBooksCdcCursor.findUniqueOrThrow({ where: { id: fixture.cursor.id } }))
      .resolves.toMatchObject({
        attemptCount: QUICKBOOKS_CDC_MAX_ATTEMPTS,
        nextAttemptAtUtc: null,
        terminalAtUtc: failedAtUtc,
        lastErrorCode: "QUICKBOOKS_CDC_PROVIDER_UNAVAILABLE",
      });
    await expect(claimQuickBooksCdcCursor({
      prisma,
      runtimeEnv: env,
      tenantId: fixture.tenant.id,
      now: new Date(failedAtUtc.getTime() + 24 * 60 * 60 * 1_000),
    })).resolves.toBeNull();
  });

  test("does not claim CDC provider work after billing access expires", async () => {
    const fixture = await createCdcFixture("cdc-billing-paused");
    const now = new Date("2026-09-04T20:00:00.000Z");
    await prisma.tenant.update({
      where: { id: fixture.tenant.id },
      data: {
        subscriptionStatus: "past_due",
        subscriptionPlanCode: "starter",
        stripeCustomerId: "cus_qbo_paused_cdc",
        stripeSubscriptionId: "sub_qbo_paused_cdc",
        trialStartsAtUtc: new Date(now.getTime() - 3 * 86_400_000),
        trialEndsAtUtc: new Date(now.getTime() - 2 * 86_400_000),
        subscriptionCurrentPeriodStartUtc: new Date(now.getTime() - 2 * 86_400_000),
        subscriptionCurrentPeriodEndUtc: new Date(now.getTime() - 86_400_000),
      },
    });

    await expect(claimQuickBooksCdcCursor({
      prisma,
      runtimeEnv: env,
      tenantId: fixture.tenant.id,
      now,
    })).resolves.toBeNull();
    await expect(prisma.quickBooksCdcCursor.findUniqueOrThrow({ where: { id: fixture.cursor.id } }))
      .resolves.toMatchObject({ attemptCount: 0, lastAttemptAtUtc: null, nextAttemptAtUtc: null });
  });
});
