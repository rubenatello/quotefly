import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { env } from "../../src/config/env";
import { prisma } from "../../src/lib/prisma";
import {
  buildQuickBooksCdcWorkItems,
  claimQuickBooksCdcCursor,
  completeQuickBooksCdcClaimFailure,
  completeQuickBooksCdcClaimSuccess,
} from "../../src/services/quickbooks-cdc";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "../../src/services/quickbooks-setup";

async function createCdcFixture(label: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tenant = await prisma.tenant.create({
    data: { name: `${label} Services`, slug: `${label.toLowerCase()}-${stamp}` },
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
});
