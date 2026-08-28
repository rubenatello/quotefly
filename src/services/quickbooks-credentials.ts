import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { env } from "../config/env";
import { withTenantRlsContext } from "../lib/tenant-rls";
import {
  decryptQuickBooksSecret,
  encryptQuickBooksSecret,
  QuickBooksProviderError,
  refreshQuickBooksAccessToken,
  revokeQuickBooksToken,
} from "./quickbooks";
import { retryQuickBooksOrphanCredentialRevocation } from "./quickbooks-orphan-revocations";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "./quickbooks-setup";
import {
  currentQuickBooksConnectionGeneration,
  latestQuickBooksDisconnectEventContext,
  recordQuickBooksConnectionEvent,
  type QuickBooksConnectionEventContext,
} from "./quickbooks-connection-events";

type RuntimeEnv = typeof env;

export type QuickBooksTokenConnection = Readonly<{
  id: string;
  tenantId: string;
  realmId: string;
}>;

export type QuickBooksDisconnectResult = "disconnected" | "pending";

const QUICKBOOKS_CREDENTIAL_CLAIM_MINIMUM_MS = 120_000;

function credentialClaimExpiresAt(runtimeEnv: RuntimeEnv, now: Date) {
  // Refresh and revoke each make one provider mutation with an AbortSignal
  // timeout. The larger lease is a fencing margin for event-loop and database
  // latency; an expired lease is only reclaimed with a compare-and-swap.
  return new Date(now.getTime() + Math.max(
    QUICKBOOKS_CREDENTIAL_CLAIM_MINIMUM_MS,
    runtimeEnv.QUICKBOOKS_PROVIDER_TIMEOUT_MS * 3 + 30_000,
  ));
}

function newCredentialClaimHash() {
  return createHash("sha256").update(randomUUID()).digest("hex");
}

function nextRevocationAttemptAt(attemptCount: number) {
  return new Date(Date.now() + Math.min(
    24 * 60 * 60 * 1_000,
    60_000 * (2 ** Math.min(10, attemptCount)),
  ));
}

async function deactivateRealmBinding(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  connectionId: string,
) {
  await transaction.quickBooksRealmBinding.updateMany({
    where: { tenantId, quickBooksConnectionId: connectionId },
    data: { active: false },
  });
}

export async function getSerializedQuickBooksAccessToken(params: {
  prisma: PrismaClient;
  runtimeEnv: RuntimeEnv;
  connection: QuickBooksTokenConnection;
}): Promise<string> {
  const { prisma, runtimeEnv, connection } = params;
  const liveConnection = await withTenantRlsContext(prisma, connection.tenantId, (transaction) =>
    transaction.quickBooksConnection.findFirst({
      where: {
        id: connection.id,
        tenantId: connection.tenantId,
        realmId: connection.realmId,
        status: "CONNECTED",
        deletedAtUtc: null,
        setupConfirmedAtUtc: { not: null },
        setupConfirmedByTenantUserId: { not: null },
        setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
      },
      select: {
        id: true,
        accessTokenEncrypted: true,
        refreshTokenEncrypted: true,
        accessTokenExpiresAtUtc: true,
        disconnectRequestedAtUtc: true,
      },
    }),
  );
  if (!liveConnection || liveConnection.disconnectRequestedAtUtc) {
    throw new QuickBooksProviderError("QUICKBOOKS_CONNECTION_NOT_CONNECTED", false);
  }
  const expiresAt = liveConnection.accessTokenExpiresAtUtc?.getTime() ?? 0;
  if (liveConnection.accessTokenEncrypted && expiresAt > Date.now() + 60_000) {
    return decryptQuickBooksSecret(runtimeEnv, liveConnection.accessTokenEncrypted);
  }
  if (!liveConnection.refreshTokenEncrypted) {
    throw new QuickBooksProviderError("QUICKBOOKS_REFRESH_TOKEN_MISSING", false);
  }

  // Invariant: refresh, disconnect, and retry-revocation all acquire this same
  // durable claim before calling Intuit. The encrypted refresh token remains in
  // the row until either a rotated token is saved or revocation is confirmed.
  const claimTokenHash = newCredentialClaimHash();
  const now = new Date();
  const claimed = await withTenantRlsContext(prisma, connection.tenantId, (transaction) =>
    transaction.quickBooksConnection.updateMany({
      where: {
        id: liveConnection.id,
        tenantId: connection.tenantId,
        realmId: connection.realmId,
        status: "CONNECTED",
        setupConfirmedAtUtc: { not: null },
        setupConfirmedByTenantUserId: { not: null },
        setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
        disconnectRequestedAtUtc: null,
        refreshTokenEncrypted: liveConnection.refreshTokenEncrypted,
        OR: [
          { tokenRefreshClaimHash: null },
          { tokenRefreshClaimExpiresAtUtc: { lte: now } },
        ],
      },
      data: {
        tokenRefreshClaimHash: claimTokenHash,
        tokenRefreshClaimExpiresAtUtc: credentialClaimExpiresAt(runtimeEnv, now),
      },
    }),
  );
  if (claimed.count !== 1) {
    throw new QuickBooksProviderError("QUICKBOOKS_TOKEN_REFRESH_BUSY", false, 503);
  }

  try {
    const refreshed = await refreshQuickBooksAccessToken(
      runtimeEnv,
      decryptQuickBooksSecret(runtimeEnv, liveConnection.refreshTokenEncrypted),
    );
    const refreshedAtUtc = new Date();
    const rotatedAccessTokenEncrypted = encryptQuickBooksSecret(runtimeEnv, refreshed.access_token);
    const rotatedRefreshTokenEncrypted = encryptQuickBooksSecret(runtimeEnv, refreshed.refresh_token);
    const rotatedAccessTokenExpiresAtUtc = new Date(refreshedAtUtc.getTime() + refreshed.expires_in * 1_000);

    const finalization = await withTenantRlsContext(prisma, connection.tenantId, async (transaction) => {
      const savedConnected = await transaction.quickBooksConnection.updateMany({
        where: {
          id: liveConnection.id,
          tenantId: connection.tenantId,
          status: "CONNECTED",
          setupConfirmedAtUtc: { not: null },
          setupConfirmedByTenantUserId: { not: null },
          setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
          disconnectRequestedAtUtc: null,
          refreshTokenEncrypted: liveConnection.refreshTokenEncrypted,
          tokenRefreshClaimHash: claimTokenHash,
        },
        data: {
          accessTokenEncrypted: rotatedAccessTokenEncrypted,
          refreshTokenEncrypted: rotatedRefreshTokenEncrypted,
          accessTokenExpiresAtUtc: rotatedAccessTokenExpiresAtUtc,
          lastTokenRefreshAtUtc: refreshedAtUtc,
          refreshTokenRotatedAtUtc: refreshedAtUtc,
          tokenRefreshClaimHash: null,
          tokenRefreshClaimExpiresAtUtc: null,
          lastError: null,
        },
      });
      if (savedConnected.count === 1) return "connected" as const;

      // Disconnect intent may arrive while Intuit rotates the token. Persist
      // the rotated token before releasing the claim, then hand it to the
      // revocation worker. It must never become active but unavailable.
      const savedForRevocation = await transaction.quickBooksConnection.updateMany({
        where: {
          id: liveConnection.id,
          tenantId: connection.tenantId,
          status: "CONNECTED",
          disconnectRequestedAtUtc: { not: null },
          refreshTokenEncrypted: liveConnection.refreshTokenEncrypted,
          tokenRefreshClaimHash: claimTokenHash,
        },
        data: {
          status: "REVOCATION_PENDING",
          accessTokenEncrypted: rotatedAccessTokenEncrypted,
          refreshTokenEncrypted: rotatedRefreshTokenEncrypted,
          accessTokenExpiresAtUtc: rotatedAccessTokenExpiresAtUtc,
          lastTokenRefreshAtUtc: refreshedAtUtc,
          refreshTokenRotatedAtUtc: refreshedAtUtc,
          revocationPendingAtUtc: refreshedAtUtc,
          revocationNextAttemptAtUtc: refreshedAtUtc,
          tokenRefreshClaimHash: null,
          tokenRefreshClaimExpiresAtUtc: null,
          lastError: "QUICKBOOKS_TOKEN_REVOCATION_PENDING",
        },
      });
      return savedForRevocation.count === 1 ? "revocation_pending" as const : "stale" as const;
    });

    if (finalization === "connected") return refreshed.access_token;
    if (finalization === "revocation_pending") {
      throw new QuickBooksProviderError("QUICKBOOKS_CONNECTION_NOT_CONNECTED", false);
    }

    // This is unreachable while the provider respects its timeout and the
    // claim lease remains fenced. Best-effort revocation prevents a rotated
    // token from remaining active if an operator changed the row manually.
    await revokeQuickBooksToken(runtimeEnv, refreshed.refresh_token).catch(() => undefined);
    throw new QuickBooksProviderError("QUICKBOOKS_TOKEN_REFRESH_STALE", false);
  } catch (error) {
    await withTenantRlsContext(prisma, connection.tenantId, async (transaction) => {
      const retainedForRevocation = await transaction.quickBooksConnection.updateMany({
        where: {
          id: liveConnection.id,
          tenantId: connection.tenantId,
          status: "CONNECTED",
          disconnectRequestedAtUtc: { not: null },
          tokenRefreshClaimHash: claimTokenHash,
        },
        data: {
          status: "REVOCATION_PENDING",
          revocationPendingAtUtc: new Date(),
          revocationNextAttemptAtUtc: new Date(),
          tokenRefreshClaimHash: null,
          tokenRefreshClaimExpiresAtUtc: null,
          lastError: "QUICKBOOKS_TOKEN_REVOCATION_PENDING",
        },
      });
      if (retainedForRevocation.count === 0) {
        await transaction.quickBooksConnection.updateMany({
          where: {
            id: liveConnection.id,
            tenantId: connection.tenantId,
            tokenRefreshClaimHash: claimTokenHash,
          },
          data: {
            tokenRefreshClaimHash: null,
            tokenRefreshClaimExpiresAtUtc: null,
            lastError: "QUICKBOOKS_TOKEN_REFRESH_FAILED",
          },
        });
      }
    }).catch(() => undefined);
    throw error;
  }
}

export async function disconnectQuickBooksConnection(params: {
  prisma: PrismaClient;
  runtimeEnv: RuntimeEnv;
  tenantId: string;
  actorTenantUserId?: string;
  requestId?: string;
}): Promise<QuickBooksDisconnectResult> {
  const now = new Date();
  const claimTokenHash = newCredentialClaimHash();
  const claimedConnection = await withTenantRlsContext(params.prisma, params.tenantId, async (transaction) => {
    const connection = await transaction.quickBooksConnection.findFirst({
      where: { tenantId: params.tenantId, deletedAtUtc: null },
      select: {
        id: true,
        status: true,
        refreshTokenEncrypted: true,
        revocationAttemptCount: true,
        disconnectRequestedAtUtc: true,
      },
    });
    if (!connection || connection.status === "DISCONNECTED") return { result: "disconnected" as const };

    const connectionGeneration = await currentQuickBooksConnectionGeneration(transaction, params.tenantId);
    const existingDisconnectEvent = await latestQuickBooksDisconnectEventContext(
      transaction,
      params.tenantId,
      connection.id,
      connectionGeneration,
    );
    const lifecycleContext: QuickBooksConnectionEventContext = existingDisconnectEvent ?? {
      actorTenantUserId: params.actorTenantUserId ?? null,
      requestId: params.requestId?.trim().slice(0, 128) || `system:quickbooks-disconnect:${connection.id}`.slice(0, 128),
      connectionGeneration,
    };

    if (!connection.refreshTokenEncrypted) {
      const finalized = await transaction.quickBooksConnection.updateMany({
        where: {
          id: connection.id,
          tenantId: params.tenantId,
          refreshTokenEncrypted: null,
          tokenRefreshClaimHash: null,
        },
        data: {
          status: "DISCONNECTED",
          accessTokenEncrypted: null,
          accessTokenExpiresAtUtc: null,
          disconnectRequestedAtUtc: null,
          disconnectedAtUtc: now,
          revocationPendingAtUtc: null,
          revocationAttemptCount: 0,
          revocationNextAttemptAtUtc: null,
          lastError: null,
        },
      });
      if (finalized.count === 1) {
        if (!existingDisconnectEvent) {
          await recordQuickBooksConnectionEvent(transaction, {
            tenantId: params.tenantId,
            quickBooksConnectionId: connection.id,
            ...lifecycleContext,
            action: "DISCONNECT_REQUESTED",
            outcome: "PENDING",
          });
        }
        await recordQuickBooksConnectionEvent(transaction, {
          tenantId: params.tenantId,
          quickBooksConnectionId: connection.id,
          ...lifecycleContext,
          action: "DISCONNECTED",
          outcome: "SUCCEEDED",
        });
        await deactivateRealmBinding(transaction, params.tenantId, connection.id);
        return { result: "disconnected" as const };
      }
      return { result: "pending" as const };
    }

    // Persist intent before attempting the shared CAS. If refresh currently
    // owns the claim, its finalizer will retain the newly rotated token and
    // transition it to REVOCATION_PENDING for the retry worker.
    const persistedIntent = await transaction.quickBooksConnection.updateMany({
      where: {
        id: connection.id,
        tenantId: params.tenantId,
        status: { in: ["CONNECTED", "REVOCATION_PENDING"] },
        disconnectRequestedAtUtc: null,
      },
      data: { disconnectRequestedAtUtc: now },
    });
    if (!existingDisconnectEvent && (persistedIntent.count === 1 || connection.disconnectRequestedAtUtc)) {
      await recordQuickBooksConnectionEvent(transaction, {
        tenantId: params.tenantId,
        quickBooksConnectionId: connection.id,
        ...lifecycleContext,
        action: "DISCONNECT_REQUESTED",
        outcome: "PENDING",
      });
    }

    const claimExpiresAtUtc = credentialClaimExpiresAt(params.runtimeEnv, now);
    const claimed = await transaction.quickBooksConnection.updateMany({
      where: {
        id: connection.id,
        tenantId: params.tenantId,
        status: { in: ["CONNECTED", "REVOCATION_PENDING"] },
        refreshTokenEncrypted: connection.refreshTokenEncrypted,
        OR: [
          { tokenRefreshClaimHash: null },
          { tokenRefreshClaimExpiresAtUtc: { lte: now } },
        ],
      },
      data: {
        status: "REVOCATION_PENDING",
        revocationPendingAtUtc: now,
        revocationAttemptCount: { increment: 1 },
        revocationNextAttemptAtUtc: claimExpiresAtUtc,
        tokenRefreshClaimHash: claimTokenHash,
        tokenRefreshClaimExpiresAtUtc: claimExpiresAtUtc,
        lastError: "QUICKBOOKS_TOKEN_REVOCATION_PENDING",
      },
    });
    return claimed.count === 1
      ? {
          result: "claimed" as const,
          id: connection.id,
          refreshTokenEncrypted: connection.refreshTokenEncrypted,
          revocationAttemptCount: connection.revocationAttemptCount + 1,
          lifecycleContext,
        }
      : { result: "pending" as const };
  });

  if (claimedConnection.result !== "claimed") return claimedConnection.result;

  try {
    await revokeQuickBooksToken(
      params.runtimeEnv,
      decryptQuickBooksSecret(params.runtimeEnv, claimedConnection.refreshTokenEncrypted),
    );
    const finalized = await withTenantRlsContext(params.prisma, params.tenantId, async (transaction) => {
      const updated = await transaction.quickBooksConnection.updateMany({
        where: {
          id: claimedConnection.id,
          tenantId: params.tenantId,
          status: "REVOCATION_PENDING",
          refreshTokenEncrypted: claimedConnection.refreshTokenEncrypted,
          tokenRefreshClaimHash: claimTokenHash,
        },
        data: {
          status: "DISCONNECTED",
          accessTokenEncrypted: null,
          refreshTokenEncrypted: null,
          accessTokenExpiresAtUtc: null,
          disconnectRequestedAtUtc: null,
          disconnectedAtUtc: new Date(),
          revocationPendingAtUtc: null,
          revocationAttemptCount: 0,
          revocationNextAttemptAtUtc: null,
          tokenRefreshClaimHash: null,
          tokenRefreshClaimExpiresAtUtc: null,
          lastError: null,
        },
      });
      if (updated.count === 1) {
        await recordQuickBooksConnectionEvent(transaction, {
          tenantId: params.tenantId,
          quickBooksConnectionId: claimedConnection.id,
          ...claimedConnection.lifecycleContext,
          action: "DISCONNECTED",
          outcome: "SUCCEEDED",
        });
        await deactivateRealmBinding(transaction, params.tenantId, claimedConnection.id);
      }
      return updated.count;
    });
    return finalized === 1 ? "disconnected" : "pending";
  } catch {
    await withTenantRlsContext(params.prisma, params.tenantId, (transaction) =>
      transaction.quickBooksConnection.updateMany({
        where: {
          id: claimedConnection.id,
          tenantId: params.tenantId,
          status: "REVOCATION_PENDING",
          refreshTokenEncrypted: claimedConnection.refreshTokenEncrypted,
          tokenRefreshClaimHash: claimTokenHash,
        },
        data: {
          tokenRefreshClaimHash: null,
          tokenRefreshClaimExpiresAtUtc: null,
          revocationNextAttemptAtUtc: nextRevocationAttemptAt(claimedConnection.revocationAttemptCount),
          lastError: "QUICKBOOKS_TOKEN_REVOCATION_PENDING",
        },
      }),
    ).catch(() => undefined);
    return "pending";
  }
}

export async function retryQuickBooksRevocation(params: {
  prisma: PrismaClient;
  runtimeEnv: RuntimeEnv;
  tenantId: string;
}): Promise<"idle" | "revoked" | "retry" | "dead"> {
  // The reconciliation worker already visits tenants fairly for connection
  // revocations. Reuse that bounded scan for one independent orphan outbox
  // claim without coupling the orphan credential to QuickBooksConnection.
  const orphanOutcome = await retryQuickBooksOrphanCredentialRevocation(params);
  const orphanResult = orphanOutcome === "revoked"
    ? "revoked" as const
    : orphanOutcome === "dead"
      ? "dead" as const
      : orphanOutcome === "retry" || orphanOutcome === "stale"
        ? "retry" as const
        : "idle" as const;
  const claimTokenHash = newCredentialClaimHash();
  const connection = await withTenantRlsContext(params.prisma, params.tenantId, async (transaction) => {
    const now = new Date();

    // Recover a disconnect request left behind by a worker that died while a
    // refresh claim was in flight. The original encrypted token is retained.
    await transaction.quickBooksConnection.updateMany({
      where: {
        tenantId: params.tenantId,
        status: "CONNECTED",
        disconnectRequestedAtUtc: { not: null },
        refreshTokenEncrypted: { not: null },
        tokenRefreshClaimExpiresAtUtc: { lte: now },
      },
      data: {
        status: "REVOCATION_PENDING",
        revocationPendingAtUtc: now,
        revocationNextAttemptAtUtc: now,
        tokenRefreshClaimHash: null,
        tokenRefreshClaimExpiresAtUtc: null,
        lastError: "QUICKBOOKS_TOKEN_REVOCATION_PENDING",
      },
    });

    const candidate = await transaction.quickBooksConnection.findFirst({
      where: {
        tenantId: params.tenantId,
        status: "REVOCATION_PENDING",
        deletedAtUtc: null,
        refreshTokenEncrypted: { not: null },
        OR: [{ revocationNextAttemptAtUtc: null }, { revocationNextAttemptAtUtc: { lte: now } }],
      },
      select: {
        id: true,
        refreshTokenEncrypted: true,
        revocationAttemptCount: true,
      },
    });
    if (!candidate?.refreshTokenEncrypted) return null;
    const claimExpiresAtUtc = credentialClaimExpiresAt(params.runtimeEnv, now);
    const claimed = await transaction.quickBooksConnection.updateMany({
      where: {
        id: candidate.id,
        tenantId: params.tenantId,
        status: "REVOCATION_PENDING",
        refreshTokenEncrypted: candidate.refreshTokenEncrypted,
        revocationAttemptCount: candidate.revocationAttemptCount,
        OR: [
          { tokenRefreshClaimHash: null },
          { tokenRefreshClaimExpiresAtUtc: { lte: now } },
        ],
      },
      data: {
        revocationAttemptCount: { increment: 1 },
        revocationNextAttemptAtUtc: claimExpiresAtUtc,
        tokenRefreshClaimHash: claimTokenHash,
        tokenRefreshClaimExpiresAtUtc: claimExpiresAtUtc,
      },
    });
    if (claimed.count !== 1) return null;
    const connectionGeneration = await currentQuickBooksConnectionGeneration(transaction, params.tenantId);
    let lifecycleContext = await latestQuickBooksDisconnectEventContext(
      transaction,
      params.tenantId,
      candidate.id,
      connectionGeneration,
    );
    if (!lifecycleContext) {
      lifecycleContext = {
        actorTenantUserId: null,
        requestId: `system:quickbooks-revocation:${candidate.id}`.slice(0, 128),
        connectionGeneration,
      };
      await recordQuickBooksConnectionEvent(transaction, {
        tenantId: params.tenantId,
        quickBooksConnectionId: candidate.id,
        ...lifecycleContext,
        action: "DISCONNECT_REQUESTED",
        outcome: "PENDING",
      });
    }
    return {
      ...candidate,
      revocationAttemptCount: candidate.revocationAttemptCount + 1,
      lifecycleContext,
    };
  });
  if (!connection?.refreshTokenEncrypted) return orphanResult;

  try {
    await revokeQuickBooksToken(
      params.runtimeEnv,
      decryptQuickBooksSecret(params.runtimeEnv, connection.refreshTokenEncrypted),
    );
    const finalized = await withTenantRlsContext(params.prisma, params.tenantId, async (transaction) => {
      const updated = await transaction.quickBooksConnection.updateMany({
        where: {
          id: connection.id,
          tenantId: params.tenantId,
          status: "REVOCATION_PENDING",
          refreshTokenEncrypted: connection.refreshTokenEncrypted,
          tokenRefreshClaimHash: claimTokenHash,
        },
        data: {
          status: "DISCONNECTED",
          accessTokenEncrypted: null,
          refreshTokenEncrypted: null,
          accessTokenExpiresAtUtc: null,
          disconnectRequestedAtUtc: null,
          disconnectedAtUtc: new Date(),
          revocationPendingAtUtc: null,
          revocationAttemptCount: 0,
          revocationNextAttemptAtUtc: null,
          tokenRefreshClaimHash: null,
          tokenRefreshClaimExpiresAtUtc: null,
          lastError: null,
        },
      });
      if (updated.count === 1) {
        await recordQuickBooksConnectionEvent(transaction, {
          tenantId: params.tenantId,
          quickBooksConnectionId: connection.id,
          ...connection.lifecycleContext,
          action: "DISCONNECTED",
          outcome: "SUCCEEDED",
        });
        await deactivateRealmBinding(transaction, params.tenantId, connection.id);
      }
      return updated.count;
    });
    return finalized === 1 ? "revoked" : "retry";
  } catch {
    await withTenantRlsContext(params.prisma, params.tenantId, (transaction) =>
      transaction.quickBooksConnection.updateMany({
        where: {
          id: connection.id,
          tenantId: params.tenantId,
          status: "REVOCATION_PENDING",
          refreshTokenEncrypted: connection.refreshTokenEncrypted,
          tokenRefreshClaimHash: claimTokenHash,
        },
        data: {
          tokenRefreshClaimHash: null,
          tokenRefreshClaimExpiresAtUtc: null,
          revocationNextAttemptAtUtc: nextRevocationAttemptAt(connection.revocationAttemptCount),
          lastError: "QUICKBOOKS_TOKEN_REVOCATION_PENDING",
        },
      }),
    ).catch(() => undefined);
    return "retry";
  }
}
