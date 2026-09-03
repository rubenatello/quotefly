import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { QuickBooksReconciliationError } from "../../src/services/quickbooks-reconciliation";
import {
  claimQuickBooksWebhookEvent,
  completeQuickBooksWebhookEvent,
  failQuickBooksWebhookEvent,
  renewQuickBooksWebhookClaim,
} from "../../src/services/quickbooks-webhook-inbox";
import { classifyQuickBooksWorkerFailure } from "../../src/services/quickbooks-worker-failures";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "../../src/services/quickbooks-setup";

async function createClaim(label: string) {
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
  const event = await prisma.quickBooksWebhookEvent.create({
    data: {
      tenantId: tenant.id,
      quickBooksConnectionId: connection.id,
      webhookEventId: `event-${label}-${stamp}`,
      realmId: connection.realmId,
      eventType: "Invoice",
      entityId: `invoice-${label}`,
      operation: "Update",
      payload: { fixture: true },
    },
  });
  const claim = await claimQuickBooksWebhookEvent(prisma, tenant.id);
  if (!claim) throw new Error("Expected a QuickBooks webhook claim.");
  return { tenant, event, claim };
}

describe("QuickBooks reconciliation dead-letter policy", () => {
  beforeEach(async () => {
    await prisma.quickBooksWebhookEvent.deleteMany();
    await prisma.tenant.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test("quarantines a non-retryable canonical failure immediately with its sanitized code", async () => {
    const { event, claim } = await createClaim("Nonretryable");
    const failure = classifyQuickBooksWorkerFailure(new QuickBooksReconciliationError(
      "QUICKBOOKS_INVOICE_TOTAL_DRIFT",
      "Sensitive provider detail",
      false,
    ));

    await expect(failQuickBooksWebhookEvent(prisma, claim, failure.code, {
      retryable: failure.retryable,
    })).resolves.toBe("DEAD");
    await expect(prisma.quickBooksWebhookEvent.findUniqueOrThrow({ where: { id: event.id } }))
      .resolves.toMatchObject({
        status: "DEAD",
        attemptCount: 1,
        lastError: "QUICKBOOKS_INVOICE_TOTAL_DRIFT",
        nextAttemptAtUtc: null,
      });
  });

  test("keeps a retryable canonical failure inside the bounded backoff queue", async () => {
    const { event, claim } = await createClaim("Retryable");
    const failure = classifyQuickBooksWorkerFailure(new QuickBooksReconciliationError(
      "QUICKBOOKS_NOT_CONNECTED",
      "Sensitive provider detail",
      true,
    ));

    await expect(failQuickBooksWebhookEvent(prisma, claim, failure.code, {
      retryable: failure.retryable,
    })).resolves.toBe("FAILED");
    const failed = await prisma.quickBooksWebhookEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(failed).toMatchObject({
      status: "FAILED",
      attemptCount: 1,
      lastError: "QUICKBOOKS_NOT_CONNECTED",
      deadAtUtc: null,
    });
    expect(failed.nextAttemptAtUtc).not.toBeNull();
  });

  test("renews a long-running claim and fences the original worker after a later reclaim", async () => {
    const { tenant, event, claim } = await createClaim("RenewableLease");
    const claimedAtUtc = new Date("2026-09-03T12:00:00.000Z");
    await prisma.quickBooksWebhookEvent.update({
      where: { id: event.id },
      data: { claimExpiresAtUtc: new Date(claimedAtUtc.getTime() + 120_000) },
    });

    const renewalAtUtc = new Date(claimedAtUtc.getTime() + 90_000);
    await expect(renewQuickBooksWebhookClaim(prisma, claim, renewalAtUtc)).resolves.toBe(true);
    await expect(claimQuickBooksWebhookEvent(
      prisma,
      tenant.id,
      new Date(claimedAtUtc.getTime() + 121_000),
    )).resolves.toBeNull();

    const reclaimed = await claimQuickBooksWebhookEvent(
      prisma,
      tenant.id,
      new Date(renewalAtUtc.getTime() + 120_001),
    );
    expect(reclaimed).not.toBeNull();
    await expect(completeQuickBooksWebhookEvent(prisma, claim)).resolves.toBe(false);
    await expect(completeQuickBooksWebhookEvent(prisma, reclaimed!)).resolves.toBe(true);
    await expect(prisma.quickBooksWebhookEvent.findUniqueOrThrow({ where: { id: event.id } }))
      .resolves.toMatchObject({ status: "PROCESSED", attemptCount: 2 });
  });
});
