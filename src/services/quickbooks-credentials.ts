import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
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
import {
  retryQuickBooksOrphanCredentialRevocation,
  revokeOrEnqueueQuickBooksOrphanCredential,
} from "./quickbooks-orphan-revocations";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "./quickbooks-setup";
import {
  currentQuickBooksConnectionGeneration,
  latestQuickBooksDisconnectEventContext,
  recordQuickBooksConnectionEvent,
  type QuickBooksConnectionEventContext,
} from "./quickbooks-connection-events";
import {
  emitQuickBooksTokenRefreshSignal,
  type QuickBooksSignalWriter,
} from "./quickbooks-observability";

type RuntimeEnv = typeof env;

export type QuickBooksTokenConnection = Readonly<{
  id: string;
  tenantId: string;
  realmId: string;
}>;

export type QuickBooksDisconnectResult = "disconnected" | "pending" | "support_required";

const QUICKBOOKS_CREDENTIAL_CLAIM_MINIMUM_MS = 120_000;
export const QUICKBOOKS_CONNECTION_REVOCATION_MAX_ATTEMPTS = 8;
const QUICKBOOKS_CONNECTION_REVOCATION_DEAD = "QUICKBOOKS_TOKEN_REVOCATION_DEAD";

export function isQuickBooksReauthorizationError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "QUICKBOOKS_REAUTH_REQUIRED";
}

function isQuickBooksResourceUnauthorizedError(error: unknown): boolean {
  return error instanceof QuickBooksProviderError
    && error.statusCode === 401
    && !isQuickBooksReauthorizationError(error);
}

export function assertQuickBooksConnectionEnvironment(
  runtimeEnv: Pick<RuntimeEnv, "QUICKBOOKS_ENVIRONMENT">,
  connection: { environment: string },
): void {
  if (connection.environment === runtimeEnv.QUICKBOOKS_ENVIRONMENT) return;
  throw new QuickBooksProviderError("QUICKBOOKS_CONNECTION_ENVIRONMENT_MISMATCH", false, 409);
}

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

export async function invalidateQuickBooksHostedPaymentLinks(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  connectionId: string,
  now = new Date(),
) {
  const invalidated = await transaction.quickBooksInvoiceOperation.updateMany({
    where: {
      tenantId,
      quickBooksConnectionId: connectionId,
      archivedAtUtc: null,
      providerInvoiceId: { not: null },
    },
    data: {
      status: "RECONCILIATION_REQUIRED",
      claimTokenHash: null,
      claimExpiresAtUtc: null,
      providerInvoiceLink: null,
      invoiceLinkFetchedAtUtc: null,
      providerSyncToken: null,
      providerInvoiceStatus: null,
      providerBalance: null,
      providerUpdatedAtUtc: null,
      lastReconciledAtUtc: null,
      succeededAtUtc: null,
      failedAtUtc: now,
      lastFailureCode: "QUICKBOOKS_CONNECTION_REAUTH_RECONCILIATION_REQUIRED",
    },
  });
  const unpublished = await transaction.quickBooksInvoiceOperation.updateMany({
    where: {
      tenantId,
      quickBooksConnectionId: connectionId,
      archivedAtUtc: null,
      providerInvoiceId: null,
    },
    data: {
      providerInvoiceLink: null,
      invoiceLinkFetchedAtUtc: null,
      providerSyncToken: null,
      providerInvoiceStatus: null,
      providerBalance: null,
      providerUpdatedAtUtc: null,
      lastReconciledAtUtc: null,
    },
  });
  return invalidated.count + unpublished.count;
}

async function refreshQuickBooksAccessTokenAfterResourceUnauthorized(params: {
  prisma: PrismaClient;
  runtimeEnv: RuntimeEnv;
  connection: QuickBooksTokenConnection;
  rejectedAccessToken: string;
  signalWriter?: QuickBooksSignalWriter;
}): Promise<string> {
  const liveConnection = await withTenantRlsContext(params.prisma, params.connection.tenantId, (transaction) =>
    transaction.quickBooksConnection.findFirst({
      where: {
        id: params.connection.id,
        tenantId: params.connection.tenantId,
        realmId: params.connection.realmId,
        status: "CONNECTED",
        disconnectRequestedAtUtc: null,
        deletedAtUtc: null,
        setupConfirmedAtUtc: { not: null },
        setupConfirmedByTenantUserId: { not: null },
        setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
      },
      select: {
        accessTokenEncrypted: true,
        refreshTokenEncrypted: true,
      },
    }),
  );
  if (!liveConnection?.accessTokenEncrypted || !liveConnection.refreshTokenEncrypted) {
    return getSerializedQuickBooksAccessToken(params);
  }

  const currentAccessToken = decryptQuickBooksSecret(params.runtimeEnv, liveConnection.accessTokenEncrypted);
  const rejectedDigest = createHash("sha256").update(params.rejectedAccessToken, "utf8").digest();
  const currentDigest = createHash("sha256").update(currentAccessToken, "utf8").digest();
  if (!timingSafeEqual(rejectedDigest, currentDigest)) {
    // Another request or reconnect already installed a newer credential. The
    // stale 401 must not alter that generation.
    return getSerializedQuickBooksAccessToken(params);
  }

  await withTenantRlsContext(params.prisma, params.connection.tenantId, (transaction) =>
    transaction.quickBooksConnection.updateMany({
      where: {
        id: params.connection.id,
        tenantId: params.connection.tenantId,
        realmId: params.connection.realmId,
        status: "CONNECTED",
        disconnectRequestedAtUtc: null,
        deletedAtUtc: null,
        accessTokenEncrypted: liveConnection.accessTokenEncrypted,
        refreshTokenEncrypted: liveConnection.refreshTokenEncrypted,
      },
      data: {
        accessTokenExpiresAtUtc: new Date(0),
        lastError: "QUICKBOOKS_ACCESS_TOKEN_REJECTED",
      },
    }),
  );

  return getSerializedQuickBooksAccessToken(params);
}

export async function runQuickBooksProviderRequestWithRefresh<T>(params: {
  prisma: PrismaClient;
  runtimeEnv: RuntimeEnv;
  connection: QuickBooksTokenConnection;
  operation: (accessToken: string) => Promise<T>;
  getAccessToken?: (connection: QuickBooksTokenConnection) => Promise<string>;
  signalWriter?: QuickBooksSignalWriter;
}): Promise<T> {
  const accessToken = await (params.getAccessToken
    ? params.getAccessToken(params.connection)
    : getSerializedQuickBooksAccessToken(params));
  try {
    return await params.operation(accessToken);
  } catch (error) {
    if (!isQuickBooksResourceUnauthorizedError(error)) throw error;
  }

  const refreshedAccessToken = await refreshQuickBooksAccessTokenAfterResourceUnauthorized({
    prisma: params.prisma,
    runtimeEnv: params.runtimeEnv,
    connection: params.connection,
    rejectedAccessToken: accessToken,
    signalWriter: params.signalWriter,
  });
  try {
    return await params.operation(refreshedAccessToken);
  } catch (error) {
    if (!isQuickBooksResourceUnauthorizedError(error)) throw error;
    throw new QuickBooksProviderError("QUICKBOOKS_ACCESS_UNAUTHORIZED_AFTER_REFRESH", false, 503);
  }
}

export async function getSerializedQuickBooksAccessToken(params: {
  prisma: PrismaClient;
  runtimeEnv: RuntimeEnv;
  connection: QuickBooksTokenConnection;
  signalWriter?: QuickBooksSignalWriter;
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
        environment: true,
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
  assertQuickBooksConnectionEnvironment(runtimeEnv, liveConnection);
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
        accessTokenEncrypted: liveConnection.accessTokenEncrypted,
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

  let issuedRotatedRefreshToken: string | null = null;
  let rotatedAccessTokenEncrypted: string | null = null;
  let rotatedRefreshTokenEncrypted: string | null = null;
  try {
    const refreshed = await refreshQuickBooksAccessToken(
      runtimeEnv,
      decryptQuickBooksSecret(runtimeEnv, liveConnection.refreshTokenEncrypted),
    );
    issuedRotatedRefreshToken = refreshed.refresh_token;
    const refreshedAtUtc = new Date();
    rotatedAccessTokenEncrypted = encryptQuickBooksSecret(runtimeEnv, refreshed.access_token);
    rotatedRefreshTokenEncrypted = encryptQuickBooksSecret(runtimeEnv, refreshed.refresh_token);
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
          accessTokenEncrypted: liveConnection.accessTokenEncrypted,
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
          tokenRefreshFailureStartedAtUtc: null,
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
          accessTokenEncrypted: liveConnection.accessTokenEncrypted,
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
          tokenRefreshFailureStartedAtUtc: null,
          lastError: "QUICKBOOKS_TOKEN_REVOCATION_PENDING",
        },
      });
      return savedForRevocation.count === 1 ? "revocation_pending" as const : "stale" as const;
    });

    if (finalization === "connected") {
      issuedRotatedRefreshToken = null;
      return refreshed.access_token;
    }
    if (finalization === "revocation_pending") {
      // The rotated credential is already durably retained on the connection
      // for the revocation worker. Do not also enqueue it as an orphan.
      issuedRotatedRefreshToken = null;
      throw new QuickBooksProviderError("QUICKBOOKS_CONNECTION_NOT_CONNECTED", false);
    }

    throw new QuickBooksProviderError("QUICKBOOKS_TOKEN_REFRESH_STALE", false);
  } catch (error) {
    let issuedCredentialCleanupDurable = false;
    let issuedCredentialCleanupError: unknown = null;
    if (issuedRotatedRefreshToken) {
      try {
        await revokeOrEnqueueQuickBooksOrphanCredential({
          prisma,
          runtimeEnv,
          tenantId: connection.tenantId,
          refreshToken: issuedRotatedRefreshToken,
        });
        issuedCredentialCleanupDurable = true;
      } catch (cleanupError) {
        // If both immediate revocation and durable outbox persistence fail,
        // preserve the stored credential snapshot and surface that stronger
        // lifecycle failure after releasing the stale claim best-effort.
        issuedCredentialCleanupError = cleanupError;
      }
    }

    let failurePersistenceOutcome: "reauth_required" | "transient_failure" | "lifecycle_changed" | "stale";
    try {
      failurePersistenceOutcome = await withTenantRlsContext(prisma, connection.tenantId, async (transaction) => {
      const retainedForRevocation = await transaction.quickBooksConnection.updateMany({
        where: {
          id: liveConnection.id,
          tenantId: connection.tenantId,
          status: "CONNECTED",
          disconnectRequestedAtUtc: { not: null },
          accessTokenEncrypted: liveConnection.accessTokenEncrypted,
          refreshTokenEncrypted: liveConnection.refreshTokenEncrypted,
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
      if (retainedForRevocation.count === 1) return "lifecycle_changed" as const;
      if (retainedForRevocation.count === 0) {
        if (issuedCredentialCleanupDurable) {
          // Revoking (or durably scheduling revocation of) the rotated token
          // invalidates the grant. Fail closed if the row still contains
          // either the pre-refresh snapshot or a commit whose outcome was
          // unknown to this process. Ciphertext fencing protects a newer
          // reconnect from being overwritten.
          const credentialSnapshots: Prisma.QuickBooksConnectionWhereInput[] = [{
            accessTokenEncrypted: liveConnection.accessTokenEncrypted,
            refreshTokenEncrypted: liveConnection.refreshTokenEncrypted,
            tokenRefreshClaimHash: claimTokenHash,
          }, {
            accessTokenEncrypted: liveConnection.accessTokenEncrypted,
            refreshTokenEncrypted: liveConnection.refreshTokenEncrypted,
            tokenRefreshClaimHash: null,
          }];
          if (rotatedAccessTokenEncrypted && rotatedRefreshTokenEncrypted) {
            credentialSnapshots.push({
              accessTokenEncrypted: rotatedAccessTokenEncrypted,
              refreshTokenEncrypted: rotatedRefreshTokenEncrypted,
              tokenRefreshClaimHash: null,
            });
          }
          const refreshFailureStartedAtUtc = new Date();
          await transaction.quickBooksConnection.updateMany({
            where: {
              id: liveConnection.id,
              tenantId: connection.tenantId,
              status: "CONNECTED",
              disconnectRequestedAtUtc: null,
              tokenRefreshFailureStartedAtUtc: null,
              OR: credentialSnapshots,
            },
            data: { tokenRefreshFailureStartedAtUtc: refreshFailureStartedAtUtc },
          });
          const transitioned = await transaction.quickBooksConnection.updateMany({
            where: {
              id: liveConnection.id,
              tenantId: connection.tenantId,
              status: "CONNECTED",
              disconnectRequestedAtUtc: null,
              OR: credentialSnapshots,
            },
            data: {
              status: "NEEDS_REAUTH",
              accessTokenEncrypted: null,
              refreshTokenEncrypted: null,
              accessTokenExpiresAtUtc: null,
              setupConfirmedAtUtc: null,
              setupConfirmedByTenantUserId: null,
              setupChecklistVersion: null,
              tokenRefreshClaimHash: null,
              tokenRefreshClaimExpiresAtUtc: null,
              lastError: "QUICKBOOKS_REAUTH_REQUIRED",
            },
          });
          if (transitioned.count === 1) {
            const reauthAtUtc = new Date();
            await invalidateQuickBooksHostedPaymentLinks(
              transaction,
              connection.tenantId,
              liveConnection.id,
              reauthAtUtc,
            );
            await recordQuickBooksConnectionEvent(transaction, {
              tenantId: connection.tenantId,
              quickBooksConnectionId: liveConnection.id,
              actorTenantUserId: null,
              requestId: `system:quickbooks-refresh-cleanup:${liveConnection.id}`,
              action: "REAUTH_REQUIRED",
              outcome: "SUCCEEDED",
              connectionGeneration: await currentQuickBooksConnectionGeneration(transaction, connection.tenantId),
            });
            return "reauth_required" as const;
          }
        } else if (isQuickBooksReauthorizationError(error)) {
          const refreshFailureStartedAtUtc = new Date();
          await transaction.quickBooksConnection.updateMany({
            where: {
              id: liveConnection.id,
              tenantId: connection.tenantId,
              status: "CONNECTED",
              disconnectRequestedAtUtc: null,
              accessTokenEncrypted: liveConnection.accessTokenEncrypted,
              refreshTokenEncrypted: liveConnection.refreshTokenEncrypted,
              tokenRefreshClaimHash: claimTokenHash,
              tokenRefreshFailureStartedAtUtc: null,
            },
            data: { tokenRefreshFailureStartedAtUtc: refreshFailureStartedAtUtc },
          });
          const transitioned = await transaction.quickBooksConnection.updateMany({
            where: {
              id: liveConnection.id,
              tenantId: connection.tenantId,
              status: "CONNECTED",
              disconnectRequestedAtUtc: null,
              accessTokenEncrypted: liveConnection.accessTokenEncrypted,
              refreshTokenEncrypted: liveConnection.refreshTokenEncrypted,
              tokenRefreshClaimHash: claimTokenHash,
            },
            data: {
              status: "NEEDS_REAUTH",
              accessTokenEncrypted: null,
              refreshTokenEncrypted: null,
              accessTokenExpiresAtUtc: null,
              setupConfirmedAtUtc: null,
              setupConfirmedByTenantUserId: null,
              setupChecklistVersion: null,
              tokenRefreshClaimHash: null,
              tokenRefreshClaimExpiresAtUtc: null,
              lastError: "QUICKBOOKS_REAUTH_REQUIRED",
            },
          });
          if (transitioned.count === 1) {
            const reauthAtUtc = new Date();
            await invalidateQuickBooksHostedPaymentLinks(
              transaction,
              connection.tenantId,
              liveConnection.id,
              reauthAtUtc,
            );
            await recordQuickBooksConnectionEvent(transaction, {
              tenantId: connection.tenantId,
              quickBooksConnectionId: liveConnection.id,
              actorTenantUserId: null,
              requestId: `system:quickbooks-reauth:${liveConnection.id}`,
              action: "REAUTH_REQUIRED",
              outcome: "SUCCEEDED",
              connectionGeneration: await currentQuickBooksConnectionGeneration(transaction, connection.tenantId),
            });
            return "reauth_required" as const;
          }
        } else {
          const refreshFailureStartedAtUtc = new Date();
          await transaction.quickBooksConnection.updateMany({
            where: {
              id: liveConnection.id,
              tenantId: connection.tenantId,
              status: "CONNECTED",
              disconnectRequestedAtUtc: null,
              accessTokenEncrypted: liveConnection.accessTokenEncrypted,
              refreshTokenEncrypted: liveConnection.refreshTokenEncrypted,
              tokenRefreshClaimHash: claimTokenHash,
              tokenRefreshFailureStartedAtUtc: null,
            },
            data: { tokenRefreshFailureStartedAtUtc: refreshFailureStartedAtUtc },
          });
          const retainedFailure = await transaction.quickBooksConnection.updateMany({
            where: {
              id: liveConnection.id,
              tenantId: connection.tenantId,
              status: "CONNECTED",
              disconnectRequestedAtUtc: null,
              accessTokenEncrypted: liveConnection.accessTokenEncrypted,
              refreshTokenEncrypted: liveConnection.refreshTokenEncrypted,
              tokenRefreshClaimHash: claimTokenHash,
            },
            data: {
              tokenRefreshClaimHash: null,
              tokenRefreshClaimExpiresAtUtc: null,
              lastError: "QUICKBOOKS_TOKEN_REFRESH_FAILED",
            },
          });
          if (retainedFailure.count === 1) return "transient_failure" as const;
        }
      }
      return "stale" as const;
      });
    } catch {
      emitQuickBooksTokenRefreshSignal(params.signalWriter, {
        eventCode: "QUICKBOOKS_TOKEN_REFRESH_PERSISTENCE_FAILED",
        refreshStage: "FAILURE_PERSISTENCE",
        outcome: "FAILED",
      });
      throw issuedCredentialCleanupError ?? error;
    }
    if (failurePersistenceOutcome === "reauth_required") {
      emitQuickBooksTokenRefreshSignal(params.signalWriter, {
        eventCode: "QUICKBOOKS_TOKEN_REFRESH_REAUTH_REQUIRED",
        refreshStage: "TOKEN_REFRESH",
        outcome: "REAUTH_REQUIRED",
      });
      throw new QuickBooksProviderError("QUICKBOOKS_REAUTH_REQUIRED", false, 401);
    } else if (failurePersistenceOutcome === "transient_failure") {
      emitQuickBooksTokenRefreshSignal(params.signalWriter, {
        eventCode: "QUICKBOOKS_TOKEN_REFRESH_TRANSIENT_FAILURE",
        refreshStage: "TOKEN_REFRESH",
        outcome: "FAILED",
      });
    }
    throw issuedCredentialCleanupError ?? error;
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
    // Disconnect is a new tenant-wide OAuth generation. Serialize it with
    // connect/callback finalization and invalidate every outstanding state so
    // a callback whose provider exchange is already in flight cannot install
    // fresh credentials after this disconnect commits.
    await transaction.$queryRaw<Array<{ locked: number }>>`
      SELECT 1::int AS "locked"
      FROM (
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`quickbooks-oauth-init:${params.tenantId}`}, 0)
        )
      ) acquired
    `;
    const connection = await transaction.quickBooksConnection.findFirst({
      where: { tenantId: params.tenantId, deletedAtUtc: null },
      select: {
        id: true,
        environment: true,
        status: true,
        refreshTokenEncrypted: true,
        revocationAttemptCount: true,
        disconnectRequestedAtUtc: true,
      },
    });
    if (!connection) {
      await transaction.quickBooksOAuthState.deleteMany({
        where: { tenantId: params.tenantId },
      });
      return { result: "disconnected" as const };
    }
    if (connection.status === "ERROR") return { result: "support_required" as const };
    await transaction.quickBooksOAuthState.deleteMany({
      where: { tenantId: params.tenantId },
    });
    await invalidateQuickBooksHostedPaymentLinks(
      transaction,
      params.tenantId,
      connection.id,
      now,
    );
    if (connection.status === "DISCONNECTED") return { result: "disconnected" as const };
    assertQuickBooksConnectionEnvironment(params.runtimeEnv, connection);

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
          tokenRefreshFailureStartedAtUtc: null,
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
          tokenRefreshFailureStartedAtUtc: null,
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
    await withTenantRlsContext(params.prisma, params.tenantId, async (transaction) => {
      if (claimedConnection.revocationAttemptCount >= QUICKBOOKS_CONNECTION_REVOCATION_MAX_ATTEMPTS) {
        const terminal = await transaction.quickBooksConnection.updateMany({
          where: {
            id: claimedConnection.id,
            tenantId: params.tenantId,
            status: "REVOCATION_PENDING",
            refreshTokenEncrypted: claimedConnection.refreshTokenEncrypted,
            tokenRefreshClaimHash: claimTokenHash,
          },
          data: {
            status: "ERROR",
            tokenRefreshClaimHash: null,
            tokenRefreshClaimExpiresAtUtc: null,
            revocationNextAttemptAtUtc: null,
            lastError: QUICKBOOKS_CONNECTION_REVOCATION_DEAD,
          },
        });
        if (terminal.count === 1) {
          await deactivateRealmBinding(transaction, params.tenantId, claimedConnection.id);
          await recordQuickBooksConnectionEvent(transaction, {
            tenantId: params.tenantId,
            quickBooksConnectionId: claimedConnection.id,
            ...claimedConnection.lifecycleContext,
            action: "DISCONNECTED",
            outcome: "FAILED",
          });
        }
        return;
      }
      await transaction.quickBooksConnection.updateMany({
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
      });
    }).catch(() => undefined);
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
        environment: params.runtimeEnv.QUICKBOOKS_ENVIRONMENT,
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
        environment: true,
        refreshTokenEncrypted: true,
        revocationAttemptCount: true,
      },
    });
    if (!candidate?.refreshTokenEncrypted) return { result: "idle" as const };
    assertQuickBooksConnectionEnvironment(params.runtimeEnv, candidate);
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
    if (candidate.revocationAttemptCount >= QUICKBOOKS_CONNECTION_REVOCATION_MAX_ATTEMPTS) {
      const terminal = await transaction.quickBooksConnection.updateMany({
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
          status: "ERROR",
          revocationNextAttemptAtUtc: null,
          tokenRefreshClaimHash: null,
          tokenRefreshClaimExpiresAtUtc: null,
          lastError: QUICKBOOKS_CONNECTION_REVOCATION_DEAD,
        },
      });
      if (terminal.count === 1) {
        await deactivateRealmBinding(transaction, params.tenantId, candidate.id);
        await recordQuickBooksConnectionEvent(transaction, {
          tenantId: params.tenantId,
          quickBooksConnectionId: candidate.id,
          ...lifecycleContext,
          action: "DISCONNECTED",
          outcome: "FAILED",
        });
        return { result: "dead" as const };
      }
      return { result: "idle" as const };
    }
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
    if (claimed.count !== 1) return { result: "idle" as const };
    return {
      result: "claimed" as const,
      ...candidate,
      revocationAttemptCount: candidate.revocationAttemptCount + 1,
      lifecycleContext,
    };
  });
  if (connection.result === "dead") return "dead";
  if (connection.result !== "claimed" || !connection.refreshTokenEncrypted) return orphanResult;

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
          tokenRefreshFailureStartedAtUtc: null,
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
    const directResult = await withTenantRlsContext(params.prisma, params.tenantId, async (transaction) => {
      if (connection.revocationAttemptCount >= QUICKBOOKS_CONNECTION_REVOCATION_MAX_ATTEMPTS) {
        const terminal = await transaction.quickBooksConnection.updateMany({
          where: {
            id: connection.id,
            tenantId: params.tenantId,
            status: "REVOCATION_PENDING",
            refreshTokenEncrypted: connection.refreshTokenEncrypted,
            tokenRefreshClaimHash: claimTokenHash,
          },
          data: {
            status: "ERROR",
            tokenRefreshClaimHash: null,
            tokenRefreshClaimExpiresAtUtc: null,
            revocationNextAttemptAtUtc: null,
            lastError: QUICKBOOKS_CONNECTION_REVOCATION_DEAD,
          },
        });
        if (terminal.count === 1) {
          await deactivateRealmBinding(transaction, params.tenantId, connection.id);
          await recordQuickBooksConnectionEvent(transaction, {
            tenantId: params.tenantId,
            quickBooksConnectionId: connection.id,
            ...connection.lifecycleContext,
            action: "DISCONNECTED",
            outcome: "FAILED",
          });
          return "dead" as const;
        }
        return "retry" as const;
      }
      await transaction.quickBooksConnection.updateMany({
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
      });
      return "retry" as const;
    }).catch(() => "retry" as const);
    return directResult;
  }
}
