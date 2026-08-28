import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { env } from "../config/env";
import { withTenantRlsContext } from "../lib/tenant-rls";
import {
  decryptQuickBooksSecret,
  encryptQuickBooksSecret,
  QuickBooksProviderError,
  revokeQuickBooksToken,
} from "./quickbooks";

type RuntimeEnv = typeof env;

export const QUICKBOOKS_ORPHAN_REVOCATION_MAX_ATTEMPTS = 8;
const QUICKBOOKS_ORPHAN_REVOCATION_CLAIM_MINIMUM_MS = 120_000;
const QUICKBOOKS_ORPHAN_REVOCATION_ERROR_CODE = "QUICKBOOKS_ORPHAN_TOKEN_REVOCATION_FAILED";

export type QuickBooksOrphanRevocationOutcome =
  | "idle"
  | "queued"
  | "revoked"
  | "retry"
  | "dead"
  | "stale";

export class QuickBooksOrphanCredentialPersistenceError extends Error {
  readonly code = "QUICKBOOKS_ORPHAN_REVOCATION_PERSIST_FAILED";

  constructor() {
    super("QuickBooks orphan credential cleanup could not be persisted.");
    this.name = "QuickBooksOrphanCredentialPersistenceError";
  }
}

function orphanCredentialDedupeKey(runtimeEnv: RuntimeEnv, refreshToken: string) {
  return createHmac("sha256", runtimeEnv.QUICKBOOKS_TOKEN_ENCRYPTION_KEY)
    .update(refreshToken, "utf8")
    .digest("hex");
}

function orphanClaimExpiresAt(runtimeEnv: RuntimeEnv, now: Date) {
  return new Date(now.getTime() + Math.max(
    QUICKBOOKS_ORPHAN_REVOCATION_CLAIM_MINIMUM_MS,
    runtimeEnv.QUICKBOOKS_PROVIDER_TIMEOUT_MS * 3 + 30_000,
  ));
}

function orphanNextAttemptAt(now: Date, attemptCount: number) {
  return new Date(now.getTime() + Math.min(
    24 * 60 * 60 * 1_000,
    60_000 * (2 ** Math.min(10, attemptCount)),
  ));
}

function safeOrphanFailureCode(error: unknown) {
  if (error instanceof QuickBooksProviderError) return error.code.slice(0, 191);
  return QUICKBOOKS_ORPHAN_REVOCATION_ERROR_CODE;
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

function recordOrphanRevocationOutcome(input: {
  outcome: Exclude<QuickBooksOrphanRevocationOutcome, "idle" | "queued">;
  attemptCount: number;
  failureCode?: string;
}) {
  const context = {
    eventCode: `QUICKBOOKS_ORPHAN_REVOCATION_${input.outcome.toUpperCase()}`,
    attemptCount: input.attemptCount,
    ...(input.failureCode ? { failureCode: input.failureCode } : {}),
  };
  if (input.outcome === "dead") {
    console.error(context, "QuickBooks orphan credential revocation requires operator escalation");
  } else if (input.outcome === "retry" || input.outcome === "stale") {
    console.warn(context, "QuickBooks orphan credential revocation was not finalized");
  } else {
    console.info(context, "QuickBooks orphan credential revocation completed");
  }
}

async function persistFailedImmediateRevocation(params: {
  prisma: PrismaClient;
  runtimeEnv: RuntimeEnv;
  tenantId: string;
  refreshToken: string;
  failureCode: string;
  now: Date;
}): Promise<"queued" | "revoked" | "dead"> {
  const dedupeKeyHash = orphanCredentialDedupeKey(params.runtimeEnv, params.refreshToken);
  const refreshTokenEncrypted = encryptQuickBooksSecret(params.runtimeEnv, params.refreshToken);

  try {
    return await withTenantRlsContext(params.prisma, params.tenantId, async (transaction) => {
      const existing = await transaction.quickBooksOrphanCredentialRevocation.findUnique({
        where: {
          tenantId_dedupeKeyHash: {
            tenantId: params.tenantId,
            dedupeKeyHash,
          },
        },
        select: { status: true },
      });
      if (existing) {
        if (existing.status === "REVOKED") return "revoked" as const;
        if (existing.status === "DEAD") return "dead" as const;
        return "queued" as const;
      }

      await transaction.quickBooksOrphanCredentialRevocation.create({
        data: {
          tenantId: params.tenantId,
          dedupeKeyHash,
          refreshTokenEncrypted,
          status: "PENDING",
          attemptCount: 1,
          lastAttemptAtUtc: params.now,
          nextAttemptAtUtc: orphanNextAttemptAt(params.now, 1),
          lastErrorCode: params.failureCode,
        },
      });
      return "queued" as const;
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const existing = await withTenantRlsContext(params.prisma, params.tenantId, (transaction) =>
        transaction.quickBooksOrphanCredentialRevocation.findUnique({
          where: {
            tenantId_dedupeKeyHash: {
              tenantId: params.tenantId,
              dedupeKeyHash,
            },
          },
          select: { status: true },
        }),
      ).catch(() => null);
      if (existing?.status === "REVOKED") return "revoked";
      if (existing?.status === "DEAD") return "dead";
      if (existing) return "queued";
    }
    throw new QuickBooksOrphanCredentialPersistenceError();
  }
}

/**
 * Cleans up a refresh credential that Intuit issued but QuoteFly refused to
 * attach to a connection. A failed or unknown provider outcome is durably
 * encrypted in a separate outbox; this path never writes QuickBooksConnection.
 */
export async function revokeOrEnqueueQuickBooksOrphanCredential(params: {
  prisma: PrismaClient;
  runtimeEnv: RuntimeEnv;
  tenantId: string;
  refreshToken: string;
  now?: Date;
}): Promise<"revoked" | "queued" | "dead"> {
  try {
    await revokeQuickBooksToken(params.runtimeEnv, params.refreshToken);
    return "revoked";
  } catch (error) {
    return persistFailedImmediateRevocation({
      prisma: params.prisma,
      runtimeEnv: params.runtimeEnv,
      tenantId: params.tenantId,
      refreshToken: params.refreshToken,
      failureCode: safeOrphanFailureCode(error),
      now: params.now ?? new Date(),
    });
  }
}

/**
 * Claims one due orphan revocation for a tenant. Claim ownership is fenced by
 * the row generation (attemptCount), encrypted token snapshot, and claim hash.
 */
export async function retryQuickBooksOrphanCredentialRevocation(params: {
  prisma: PrismaClient;
  runtimeEnv: RuntimeEnv;
  tenantId: string;
  now?: Date;
}): Promise<QuickBooksOrphanRevocationOutcome> {
  const now = params.now ?? new Date();
  const claimTokenHash = createHash("sha256").update(randomUUID()).digest("hex");
  const candidate = await withTenantRlsContext(params.prisma, params.tenantId, async (transaction) => {
    const row = await transaction.quickBooksOrphanCredentialRevocation.findFirst({
      where: {
        tenantId: params.tenantId,
        attemptCount: { lt: QUICKBOOKS_ORPHAN_REVOCATION_MAX_ATTEMPTS },
        OR: [
          { status: "PENDING", nextAttemptAtUtc: { lte: now } },
          { status: "PROCESSING", claimExpiresAtUtc: { lte: now } },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        status: true,
        refreshTokenEncrypted: true,
        attemptCount: true,
        claimTokenHash: true,
        claimExpiresAtUtc: true,
      },
    });
    if (!row?.refreshTokenEncrypted) return null;

    const nextAttemptCount = row.attemptCount + 1;
    const claimExpiresAtUtc = orphanClaimExpiresAt(params.runtimeEnv, now);
    const claimed = await transaction.quickBooksOrphanCredentialRevocation.updateMany({
      where: {
        id: row.id,
        tenantId: params.tenantId,
        status: row.status,
        refreshTokenEncrypted: row.refreshTokenEncrypted,
        attemptCount: row.attemptCount,
        claimTokenHash: row.claimTokenHash,
        claimExpiresAtUtc: row.claimExpiresAtUtc,
      },
      data: {
        status: "PROCESSING",
        attemptCount: nextAttemptCount,
        lastAttemptAtUtc: now,
        nextAttemptAtUtc: claimExpiresAtUtc,
        claimTokenHash,
        claimExpiresAtUtc,
      },
    });
    return claimed.count === 1
      ? {
          id: row.id,
          refreshTokenEncrypted: row.refreshTokenEncrypted,
          attemptCount: nextAttemptCount,
        }
      : null;
  });
  if (!candidate) return "idle";

  try {
    await revokeQuickBooksToken(
      params.runtimeEnv,
      decryptQuickBooksSecret(params.runtimeEnv, candidate.refreshTokenEncrypted),
    );
    const finalized = await withTenantRlsContext(params.prisma, params.tenantId, (transaction) =>
      transaction.quickBooksOrphanCredentialRevocation.updateMany({
        where: {
          id: candidate.id,
          tenantId: params.tenantId,
          status: "PROCESSING",
          refreshTokenEncrypted: candidate.refreshTokenEncrypted,
          attemptCount: candidate.attemptCount,
          claimTokenHash,
        },
        data: {
          status: "REVOKED",
          refreshTokenEncrypted: null,
          nextAttemptAtUtc: null,
          claimTokenHash: null,
          claimExpiresAtUtc: null,
          lastErrorCode: null,
          revokedAtUtc: new Date(),
        },
      }),
    );
    const outcome = finalized.count === 1 ? "revoked" as const : "stale" as const;
    recordOrphanRevocationOutcome({ outcome, attemptCount: candidate.attemptCount });
    return outcome;
  } catch (error) {
    const failureCode = safeOrphanFailureCode(error);
    const terminal = candidate.attemptCount >= QUICKBOOKS_ORPHAN_REVOCATION_MAX_ATTEMPTS;
    const failedAtUtc = new Date();
    const finalized = await withTenantRlsContext(params.prisma, params.tenantId, (transaction) =>
      transaction.quickBooksOrphanCredentialRevocation.updateMany({
        where: {
          id: candidate.id,
          tenantId: params.tenantId,
          status: "PROCESSING",
          refreshTokenEncrypted: candidate.refreshTokenEncrypted,
          attemptCount: candidate.attemptCount,
          claimTokenHash,
        },
        data: terminal
          ? {
              status: "DEAD",
              nextAttemptAtUtc: null,
              claimTokenHash: null,
              claimExpiresAtUtc: null,
              lastErrorCode: failureCode,
              deadAtUtc: failedAtUtc,
            }
          : {
              status: "PENDING",
              nextAttemptAtUtc: orphanNextAttemptAt(failedAtUtc, candidate.attemptCount),
              claimTokenHash: null,
              claimExpiresAtUtc: null,
              lastErrorCode: failureCode,
            },
      }),
    );
    if (finalized.count !== 1) {
      recordOrphanRevocationOutcome({ outcome: "stale", attemptCount: candidate.attemptCount });
      return "stale";
    }
    const outcome = terminal ? "dead" as const : "retry" as const;
    recordOrphanRevocationOutcome({ outcome, attemptCount: candidate.attemptCount, failureCode });
    return outcome;
  }
}
