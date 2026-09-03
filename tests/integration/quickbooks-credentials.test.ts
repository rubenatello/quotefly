import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { env } from "../../src/config/env";
import { prisma } from "../../src/lib/prisma";
import { withTenantRlsContext } from "../../src/lib/tenant-rls";
import {
  QUICKBOOKS_CONNECTION_REVOCATION_MAX_ATTEMPTS,
  disconnectQuickBooksConnection,
  getSerializedQuickBooksAccessToken,
  retryQuickBooksRevocation,
  runQuickBooksProviderRequestWithRefresh,
} from "../../src/services/quickbooks-credentials";
import {
  decryptQuickBooksSecret,
  encryptQuickBooksSecret,
  QuickBooksProviderError,
} from "../../src/services/quickbooks";
import {
  QUICKBOOKS_ORPHAN_REVOCATION_MAX_ATTEMPTS,
  retryQuickBooksOrphanCredentialRevocation,
  revokeOrEnqueueQuickBooksOrphanCredential,
} from "../../src/services/quickbooks-orphan-revocations";
import { QUICKBOOKS_SETUP_CHECKLIST_VERSION } from "../../src/services/quickbooks-setup";

const providerMocks = vi.hoisted(() => ({
  refreshToken: vi.fn(),
  revokeToken: vi.fn(),
}));

vi.mock("../../src/services/quickbooks", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/quickbooks")>(
    "../../src/services/quickbooks",
  );
  return {
    ...actual,
    refreshQuickBooksAccessToken: providerMocks.refreshToken,
    revokeQuickBooksToken: providerMocks.revokeToken,
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function waitFor(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function createConnection(label: string, overrides: Record<string, unknown> = {}) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tenant = await prisma.tenant.create({
    data: {
      name: `${label} Tenant`,
      slug: `${label}-${suffix}`,
      subscriptionStatus: "active",
    },
  });
  const user = await prisma.user.create({
    data: {
      email: `${label}-${suffix}@example.com`,
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
      realmId: `realm-${label}-${suffix}`,
      environment: "sandbox",
      status: "CONNECTED",
      accessTokenEncrypted: encryptQuickBooksSecret(env, `access-${label}`),
      refreshTokenEncrypted: encryptQuickBooksSecret(env, `refresh-${label}`),
      accessTokenExpiresAtUtc: new Date(Date.now() - 60_000),
      setupConfirmedAtUtc: new Date(),
      setupConfirmedByTenantUserId: membership.id,
      setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
      ...overrides,
    },
  });
  await prisma.quickBooksRealmBinding.create({
    data: {
      tenantId: tenant.id,
      quickBooksConnectionId: connection.id,
      realmId: connection.realmId,
      active: true,
    },
  });
  return { tenant, connection, membership };
}

function runtimeDatabaseUrl(password: string) {
  const base = new URL(process.env.DATABASE_URL!);
  base.username = "quotefly_runtime";
  base.password = password;
  base.searchParams.set("connection_limit", "2");
  return base.toString();
}

describe("QuickBooks credential-operation claim", () => {
  beforeEach(async () => {
    providerMocks.refreshToken.mockReset();
    providerMocks.revokeToken.mockReset();
    await prisma.quickBooksWebhookEvent.deleteMany();
    await prisma.tenant.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test("fails closed before token refresh or revocation when the stored provider environment differs", async () => {
    const { tenant, connection } = await createConnection("environment-fence", {
      environment: env.QUICKBOOKS_ENVIRONMENT === "sandbox" ? "production" : "sandbox",
    });

    await expect(getSerializedQuickBooksAccessToken({
      prisma,
      runtimeEnv: env,
      connection: {
        id: connection.id,
        tenantId: tenant.id,
        realmId: connection.realmId,
      },
    })).rejects.toThrow("QUICKBOOKS_CONNECTION_ENVIRONMENT_MISMATCH");

    await expect(disconnectQuickBooksConnection({
      prisma,
      runtimeEnv: env,
      tenantId: tenant.id,
    })).rejects.toThrow("QUICKBOOKS_CONNECTION_ENVIRONMENT_MISMATCH");

    expect(providerMocks.refreshToken).not.toHaveBeenCalled();
    expect(providerMocks.revokeToken).not.toHaveBeenCalled();
    await expect(prisma.quickBooksConnection.findUniqueOrThrow({ where: { id: connection.id } }))
      .resolves.toMatchObject({
        status: "CONNECTED",
        disconnectRequestedAtUtc: null,
        tokenRefreshClaimHash: null,
      });
  });

  test("transitions revoked refresh credentials to NEEDS_REAUTH and removes stale readiness", async () => {
    const { tenant, connection } = await createConnection("refresh-revoked");
    providerMocks.refreshToken.mockRejectedValue(
      new QuickBooksProviderError("QUICKBOOKS_REAUTH_REQUIRED", false, 400),
    );

    await expect(getSerializedQuickBooksAccessToken({
      prisma,
      runtimeEnv: env,
      connection: {
        id: connection.id,
        tenantId: tenant.id,
        realmId: connection.realmId,
      },
    })).rejects.toMatchObject({ code: "QUICKBOOKS_REAUTH_REQUIRED" });

    await expect(prisma.quickBooksConnection.findUniqueOrThrow({ where: { id: connection.id } }))
      .resolves.toMatchObject({
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
      });
    await expect(prisma.quickBooksConnectionEvent.findFirst({
      where: {
        tenantId: tenant.id,
        quickBooksConnectionId: connection.id,
        action: "REAUTH_REQUIRED",
        outcome: "SUCCEEDED",
      },
    })).resolves.toBeTruthy();

    await expect(getSerializedQuickBooksAccessToken({
      prisma,
      runtimeEnv: env,
      connection: {
        id: connection.id,
        tenantId: tenant.id,
        realmId: connection.realmId,
      },
    })).rejects.toMatchObject({ code: "QUICKBOOKS_CONNECTION_NOT_CONNECTED" });
    expect(providerMocks.refreshToken).toHaveBeenCalledTimes(1);
  });

  test("recovers a resource 401 with one serialized refresh and one provider retry", async () => {
    const { tenant, connection } = await createConnection("resource-401-recovery", {
      accessTokenExpiresAtUtc: new Date(Date.now() + 60 * 60 * 1_000),
    });
    providerMocks.refreshToken.mockResolvedValue({
      access_token: "rotated-resource-access",
      refresh_token: "rotated-resource-refresh",
      token_type: "bearer",
      expires_in: 3_600,
    });
    const operation = vi.fn()
      .mockRejectedValueOnce(new QuickBooksProviderError("QUICKBOOKS_HTTP_401", false, 401))
      .mockResolvedValueOnce("provider-result");

    await expect(runQuickBooksProviderRequestWithRefresh({
      prisma,
      runtimeEnv: env,
      connection: { id: connection.id, tenantId: tenant.id, realmId: connection.realmId },
      operation,
    })).resolves.toBe("provider-result");

    expect(providerMocks.refreshToken).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenNthCalledWith(1, "access-resource-401-recovery");
    expect(operation).toHaveBeenNthCalledWith(2, "rotated-resource-access");
    const persisted = await prisma.quickBooksConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(persisted.status).toBe("CONNECTED");
    expect(decryptQuickBooksSecret(env, persisted.accessTokenEncrypted!)).toBe("rotated-resource-access");
  });

  test("serializes concurrent resource 401 recovery to at most one token refresh", async () => {
    const { tenant, connection } = await createConnection("resource-401-concurrent", {
      accessTokenExpiresAtUtc: new Date(Date.now() + 60 * 60 * 1_000),
    });
    const bothInitialAttemptsStarted = deferred<void>();
    const releaseInitialAttempts = deferred<void>();
    const refreshBarrier = deferred<{
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
    }>();
    providerMocks.refreshToken.mockImplementation(() => refreshBarrier.promise);
    let initialAttemptCount = 0;
    const operation = vi.fn(async (accessToken: string) => {
      if (accessToken === "access-resource-401-concurrent") {
        initialAttemptCount += 1;
        if (initialAttemptCount === 2) bothInitialAttemptsStarted.resolve();
        await releaseInitialAttempts.promise;
        throw new QuickBooksProviderError("QUICKBOOKS_HTTP_401", false, 401);
      }
      return accessToken;
    });
    const connectionRef = { id: connection.id, tenantId: tenant.id, realmId: connection.realmId };

    const settled = Promise.allSettled([
      runQuickBooksProviderRequestWithRefresh({
        prisma,
        runtimeEnv: env,
        connection: connectionRef,
        operation,
      }),
      runQuickBooksProviderRequestWithRefresh({
        prisma,
        runtimeEnv: env,
        connection: connectionRef,
        operation,
      }),
    ]);
    await bothInitialAttemptsStarted.promise;
    releaseInitialAttempts.resolve();
    await waitFor(async () => {
      const row = await prisma.quickBooksConnection.findUnique({ where: { id: connection.id } });
      return providerMocks.refreshToken.mock.calls.length === 1 && Boolean(row?.tokenRefreshClaimHash);
    }, "concurrent resource 401 refresh claim");
    refreshBarrier.resolve({
      access_token: "concurrent-rotated-access",
      refresh_token: "concurrent-rotated-refresh",
      token_type: "bearer",
      expires_in: 3_600,
    });

    const results = await settled;
    expect(providerMocks.refreshToken).toHaveBeenCalledTimes(1);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ code: "QUICKBOOKS_TOKEN_REFRESH_BUSY", statusCode: 503 });
      }
    }
    const persisted = await prisma.quickBooksConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(persisted.status).toBe("CONNECTED");
    expect(decryptQuickBooksSecret(env, persisted.accessTokenEncrypted!)).toBe("concurrent-rotated-access");
    expect(decryptQuickBooksSecret(env, persisted.refreshTokenEncrypted!)).toBe("concurrent-rotated-refresh");
  });

  test("a stale resource 401 cannot erase or refresh credentials installed by a reconnect", async () => {
    const { tenant, connection } = await createConnection("resource-401-reconnect-race", {
      accessTokenExpiresAtUtc: new Date(Date.now() + 60 * 60 * 1_000),
    });
    const firstAttemptStarted = deferred<void>();
    const releaseFirstAttempt = deferred<void>();
    const operation = vi.fn(async (accessToken: string) => {
      if (operation.mock.calls.length === 1) {
        firstAttemptStarted.resolve();
        await releaseFirstAttempt.promise;
        throw new QuickBooksProviderError("QUICKBOOKS_HTTP_401", false, 401);
      }
      return accessToken;
    });

    const request = runQuickBooksProviderRequestWithRefresh({
      prisma,
      runtimeEnv: env,
      connection: { id: connection.id, tenantId: tenant.id, realmId: connection.realmId },
      operation,
    });
    await firstAttemptStarted.promise;
    const reconnectedAccessCiphertext = encryptQuickBooksSecret(env, "reconnected-access");
    const reconnectedRefreshCiphertext = encryptQuickBooksSecret(env, "reconnected-refresh");
    await prisma.quickBooksConnection.update({
      where: { id: connection.id },
      data: {
        accessTokenEncrypted: reconnectedAccessCiphertext,
        refreshTokenEncrypted: reconnectedRefreshCiphertext,
        accessTokenExpiresAtUtc: new Date(Date.now() + 60 * 60 * 1_000),
        tokenRefreshClaimHash: null,
        tokenRefreshClaimExpiresAtUtc: null,
      },
    });
    releaseFirstAttempt.resolve();

    await expect(request).resolves.toBe("reconnected-access");
    expect(providerMocks.refreshToken).not.toHaveBeenCalled();
    await expect(prisma.quickBooksConnection.findUniqueOrThrow({ where: { id: connection.id } }))
      .resolves.toMatchObject({
        status: "CONNECTED",
        accessTokenEncrypted: reconnectedAccessCiphertext,
        refreshTokenEncrypted: reconnectedRefreshCiphertext,
      });
  });

  test("a second resource 401 after refresh does not destroy a valid refresh credential", async () => {
    const { tenant, connection } = await createConnection("resource-401-twice", {
      accessTokenExpiresAtUtc: new Date(Date.now() + 60 * 60 * 1_000),
    });
    providerMocks.refreshToken.mockResolvedValue({
      access_token: "twice-rotated-access",
      refresh_token: "twice-rotated-refresh",
      token_type: "bearer",
      expires_in: 3_600,
    });
    const operation = vi.fn().mockRejectedValue(
      new QuickBooksProviderError("QUICKBOOKS_HTTP_401", false, 401),
    );

    await expect(runQuickBooksProviderRequestWithRefresh({
      prisma,
      runtimeEnv: env,
      connection: { id: connection.id, tenantId: tenant.id, realmId: connection.realmId },
      operation,
    })).rejects.toMatchObject({ code: "QUICKBOOKS_ACCESS_UNAUTHORIZED_AFTER_REFRESH", statusCode: 503 });
    expect(providerMocks.refreshToken).toHaveBeenCalledTimes(1);
    await expect(prisma.quickBooksConnection.findUniqueOrThrow({ where: { id: connection.id } }))
      .resolves.toMatchObject({ status: "CONNECTED" });
  });

  test("resource 403 and a bare refresh-endpoint 401 never orphan stored credentials", async () => {
    const forbidden = await createConnection("resource-403", {
      accessTokenExpiresAtUtc: new Date(Date.now() + 60 * 60 * 1_000),
    });
    await expect(runQuickBooksProviderRequestWithRefresh({
      prisma,
      runtimeEnv: env,
      connection: {
        id: forbidden.connection.id,
        tenantId: forbidden.tenant.id,
        realmId: forbidden.connection.realmId,
      },
      operation: async () => {
        throw new QuickBooksProviderError("QUICKBOOKS_HTTP_403", false, 403);
      },
    })).rejects.toMatchObject({ code: "QUICKBOOKS_HTTP_403" });
    expect(providerMocks.refreshToken).not.toHaveBeenCalled();
    await expect(prisma.quickBooksConnection.findUniqueOrThrow({ where: { id: forbidden.connection.id } }))
      .resolves.toMatchObject({ status: "CONNECTED" });

    const refresh401 = await createConnection("refresh-bare-401");
    providerMocks.refreshToken.mockRejectedValue(
      new QuickBooksProviderError("QUICKBOOKS_TOKEN_REFRESH_HTTP_401", false, 401),
    );
    await expect(getSerializedQuickBooksAccessToken({
      prisma,
      runtimeEnv: env,
      connection: {
        id: refresh401.connection.id,
        tenantId: refresh401.tenant.id,
        realmId: refresh401.connection.realmId,
      },
    })).rejects.toMatchObject({ code: "QUICKBOOKS_TOKEN_REFRESH_HTTP_401" });
    await expect(prisma.quickBooksConnection.findUniqueOrThrow({ where: { id: refresh401.connection.id } }))
      .resolves.toMatchObject({
        status: "CONNECTED",
        accessTokenEncrypted: refresh401.connection.accessTokenEncrypted,
        refreshTokenEncrypted: refresh401.connection.refreshTokenEncrypted,
      });
  });

  test("retains a rotated token for revocation when disconnect arrives during refresh", async () => {
    const { tenant, connection } = await createConnection("refresh-disconnect");
    const refreshBarrier = deferred<{
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
    }>();
    providerMocks.refreshToken.mockImplementation(() => refreshBarrier.promise);
    providerMocks.revokeToken.mockResolvedValue(undefined);

    const refresh = getSerializedQuickBooksAccessToken({
      prisma,
      runtimeEnv: env,
      connection: {
        id: connection.id,
        tenantId: tenant.id,
        realmId: connection.realmId,
      },
    });
    await waitFor(async () => {
      const row = await prisma.quickBooksConnection.findUnique({ where: { id: connection.id } });
      return providerMocks.refreshToken.mock.calls.length === 1 && Boolean(row?.tokenRefreshClaimHash);
    }, "refresh claim");

    await expect(disconnectQuickBooksConnection({
      prisma,
      runtimeEnv: env,
      tenantId: tenant.id,
    })).resolves.toBe("pending");
    const whileRefreshing = await prisma.quickBooksConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(whileRefreshing).toMatchObject({
      status: "CONNECTED",
      refreshTokenEncrypted: connection.refreshTokenEncrypted,
    });
    expect(whileRefreshing.disconnectRequestedAtUtc).toBeInstanceOf(Date);

    refreshBarrier.resolve({
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
      token_type: "bearer",
      expires_in: 3_600,
    });
    await expect(refresh).rejects.toThrow("QUICKBOOKS_CONNECTION_NOT_CONNECTED");

    const pending = await prisma.quickBooksConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(pending).toMatchObject({
      status: "REVOCATION_PENDING",
      tokenRefreshClaimHash: null,
      tokenRefreshClaimExpiresAtUtc: null,
      lastError: "QUICKBOOKS_TOKEN_REVOCATION_PENDING",
    });
    expect(decryptQuickBooksSecret(env, pending.refreshTokenEncrypted!)).toBe("rotated-refresh");

    await expect(retryQuickBooksRevocation({
      prisma,
      runtimeEnv: env,
      tenantId: tenant.id,
    })).resolves.toBe("revoked");
    expect(providerMocks.revokeToken).toHaveBeenCalledTimes(1);
    expect(providerMocks.revokeToken).toHaveBeenCalledWith(env, "rotated-refresh");
    await expect(prisma.quickBooksConnection.findUniqueOrThrow({ where: { id: connection.id } }))
      .resolves.toMatchObject({
        status: "DISCONNECTED",
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
      });
  });

  test("durably queues a rotated credential and fails closed when refresh finalization loses its fence", async () => {
    const { tenant, connection } = await createConnection("refresh-finalization-stale");
    const refreshBarrier = deferred<{
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
    }>();
    const rotatedRefreshToken = "rotated-refresh-finalization-stale-secret";
    providerMocks.refreshToken.mockImplementation(() => refreshBarrier.promise);
    providerMocks.revokeToken.mockRejectedValue(new Error(`synthetic revoke outage ${rotatedRefreshToken}`));

    const refresh = getSerializedQuickBooksAccessToken({
      prisma,
      runtimeEnv: env,
      connection: {
        id: connection.id,
        tenantId: tenant.id,
        realmId: connection.realmId,
      },
    });
    await waitFor(async () => {
      const row = await prisma.quickBooksConnection.findUnique({ where: { id: connection.id } });
      return providerMocks.refreshToken.mock.calls.length === 1 && Boolean(row?.tokenRefreshClaimHash);
    }, "refresh claim before stale finalization");

    await prisma.quickBooksConnection.update({
      where: { id: connection.id },
      data: { tokenRefreshClaimHash: null, tokenRefreshClaimExpiresAtUtc: null },
    });
    refreshBarrier.resolve({
      access_token: "rotated-access-finalization-stale",
      refresh_token: rotatedRefreshToken,
      token_type: "bearer",
      expires_in: 3_600,
    });

    await expect(refresh).rejects.toMatchObject({ code: "QUICKBOOKS_TOKEN_REFRESH_STALE" });
    expect(providerMocks.revokeToken).toHaveBeenCalledWith(env, rotatedRefreshToken);

    const orphanRows = await prisma.quickBooksOrphanCredentialRevocation.findMany({
      where: { tenantId: tenant.id },
    });
    expect(orphanRows).toHaveLength(1);
    expect(orphanRows[0]).toMatchObject({ status: "PENDING", attemptCount: 1 });
    expect(orphanRows[0]!.refreshTokenEncrypted).not.toBe(rotatedRefreshToken);
    expect(JSON.stringify(orphanRows)).not.toContain(rotatedRefreshToken);
    await expect(prisma.quickBooksConnection.findUniqueOrThrow({ where: { id: connection.id } }))
      .resolves.toMatchObject({
        status: "NEEDS_REAUTH",
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        setupConfirmedAtUtc: null,
        tokenRefreshClaimHash: null,
      });
  });

  test("does not overwrite a newer refresh claimant while cleaning up an issued rotated credential", async () => {
    const { tenant, connection } = await createConnection("refresh-finalization-new-claim");
    const refreshBarrier = deferred<{
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
    }>();
    const newerClaimHash = "e".repeat(64);
    providerMocks.refreshToken.mockImplementation(() => refreshBarrier.promise);
    providerMocks.revokeToken.mockResolvedValue(undefined);

    const refresh = getSerializedQuickBooksAccessToken({
      prisma,
      runtimeEnv: env,
      connection: {
        id: connection.id,
        tenantId: tenant.id,
        realmId: connection.realmId,
      },
    });
    await waitFor(async () => {
      const row = await prisma.quickBooksConnection.findUnique({ where: { id: connection.id } });
      return providerMocks.refreshToken.mock.calls.length === 1 && Boolean(row?.tokenRefreshClaimHash);
    }, "refresh claim before replacement");
    await prisma.quickBooksConnection.update({
      where: { id: connection.id },
      data: {
        tokenRefreshClaimHash: newerClaimHash,
        tokenRefreshClaimExpiresAtUtc: new Date(Date.now() + 120_000),
      },
    });
    refreshBarrier.resolve({
      access_token: "rotated-access-new-claim",
      refresh_token: "rotated-refresh-new-claim",
      token_type: "bearer",
      expires_in: 3_600,
    });

    await expect(refresh).rejects.toMatchObject({ code: "QUICKBOOKS_TOKEN_REFRESH_STALE" });
    expect(providerMocks.revokeToken).toHaveBeenCalledWith(env, "rotated-refresh-new-claim");
    await expect(prisma.quickBooksConnection.findUniqueOrThrow({ where: { id: connection.id } }))
      .resolves.toMatchObject({
        status: "CONNECTED",
        tokenRefreshClaimHash: newerClaimHash,
        accessTokenEncrypted: connection.accessTokenEncrypted,
        refreshTokenEncrypted: connection.refreshTokenEncrypted,
      });
  });

  test("serializes duplicate disconnects and performs provider revocation once", async () => {
    const { tenant, connection } = await createConnection("duplicate-disconnect");
    const revokeBarrier = deferred<void>();
    providerMocks.revokeToken.mockImplementation(() => revokeBarrier.promise);

    const first = disconnectQuickBooksConnection({ prisma, runtimeEnv: env, tenantId: tenant.id });
    await waitFor(async () => {
      const row = await prisma.quickBooksConnection.findUnique({ where: { id: connection.id } });
      return providerMocks.revokeToken.mock.calls.length === 1 && Boolean(row?.tokenRefreshClaimHash);
    }, "disconnect claim");

    await expect(disconnectQuickBooksConnection({
      prisma,
      runtimeEnv: env,
      tenantId: tenant.id,
    })).resolves.toBe("pending");
    expect(providerMocks.revokeToken).toHaveBeenCalledTimes(1);

    revokeBarrier.resolve();
    await expect(first).resolves.toBe("disconnected");
    await expect(disconnectQuickBooksConnection({
      prisma,
      runtimeEnv: env,
      tenantId: tenant.id,
    })).resolves.toBe("disconnected");
    expect(providerMocks.revokeToken).toHaveBeenCalledTimes(1);
  });

  test("serializes concurrent retry workers with a durable CAS claim", async () => {
    const { tenant, connection } = await createConnection("retry-workers", {
      status: "REVOCATION_PENDING",
      disconnectRequestedAtUtc: new Date(),
      revocationPendingAtUtc: new Date(),
      revocationNextAttemptAtUtc: new Date(Date.now() - 1_000),
    });
    const revokeBarrier = deferred<void>();
    providerMocks.revokeToken.mockImplementation(() => revokeBarrier.promise);

    const first = retryQuickBooksRevocation({ prisma, runtimeEnv: env, tenantId: tenant.id });
    await waitFor(async () => {
      const row = await prisma.quickBooksConnection.findUnique({ where: { id: connection.id } });
      return providerMocks.revokeToken.mock.calls.length === 1 && Boolean(row?.tokenRefreshClaimHash);
    }, "retry claim");

    await expect(retryQuickBooksRevocation({
      prisma,
      runtimeEnv: env,
      tenantId: tenant.id,
    })).resolves.toBe("idle");
    expect(providerMocks.revokeToken).toHaveBeenCalledTimes(1);

    revokeBarrier.resolve();
    await expect(first).resolves.toBe("revoked");
    expect(providerMocks.revokeToken).toHaveBeenCalledTimes(1);
  });

  test("keeps encrypted token material when provider revocation fails", async () => {
    const { tenant, connection } = await createConnection("revocation-failure");
    providerMocks.revokeToken.mockRejectedValue(new Error("synthetic revoke outage"));

    await expect(disconnectQuickBooksConnection({
      prisma,
      runtimeEnv: env,
      tenantId: tenant.id,
    })).resolves.toBe("pending");

    const pending = await prisma.quickBooksConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(pending).toMatchObject({
      status: "REVOCATION_PENDING",
      refreshTokenEncrypted: connection.refreshTokenEncrypted,
      tokenRefreshClaimHash: null,
      tokenRefreshClaimExpiresAtUtc: null,
      lastError: "QUICKBOOKS_TOKEN_REVOCATION_PENDING",
    });
    expect(pending.revocationNextAttemptAtUtc?.getTime()).toBeGreaterThan(Date.now());
  });

  test("dead-letters direct connection revocation after the bounded retry budget", async () => {
    const { tenant, connection } = await createConnection("revocation-dead-letter", {
      status: "REVOCATION_PENDING",
      disconnectRequestedAtUtc: new Date(),
      revocationPendingAtUtc: new Date(),
      revocationAttemptCount: QUICKBOOKS_CONNECTION_REVOCATION_MAX_ATTEMPTS - 1,
      revocationNextAttemptAtUtc: new Date(Date.now() - 1_000),
    });
    providerMocks.revokeToken.mockRejectedValue(new Error("synthetic terminal revoke outage"));

    await expect(retryQuickBooksRevocation({
      prisma,
      runtimeEnv: env,
      tenantId: tenant.id,
    })).resolves.toBe("dead");

    expect(providerMocks.revokeToken).toHaveBeenCalledTimes(1);
    await expect(prisma.quickBooksConnection.findUniqueOrThrow({ where: { id: connection.id } }))
      .resolves.toMatchObject({
        status: "ERROR",
        refreshTokenEncrypted: connection.refreshTokenEncrypted,
        revocationAttemptCount: QUICKBOOKS_CONNECTION_REVOCATION_MAX_ATTEMPTS,
        revocationNextAttemptAtUtc: null,
        tokenRefreshClaimHash: null,
        tokenRefreshClaimExpiresAtUtc: null,
        lastError: "QUICKBOOKS_TOKEN_REVOCATION_DEAD",
      });
    await expect(prisma.quickBooksRealmBinding.findUniqueOrThrow({
      where: { quickBooksConnectionId: connection.id },
    })).resolves.toMatchObject({ active: false });
    await expect(prisma.quickBooksConnectionEvent.findFirst({
      where: {
        tenantId: tenant.id,
        quickBooksConnectionId: connection.id,
        action: "DISCONNECTED",
        outcome: "FAILED",
      },
    })).resolves.toBeTruthy();

    await expect(retryQuickBooksRevocation({
      prisma,
      runtimeEnv: env,
      tenantId: tenant.id,
    })).resolves.toBe("idle");
    expect(providerMocks.revokeToken).toHaveBeenCalledTimes(1);
  });

  test("attributes a post-reconnect disconnect to the current generation and actor", async () => {
    const { tenant, connection, membership: firstActor } = await createConnection("reconnect-disconnect", {
      accessTokenEncrypted: null,
      refreshTokenEncrypted: null,
    });
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const secondUser = await prisma.user.create({
      data: {
        email: `reconnect-disconnect-admin-${suffix}@example.com`,
        fullName: "Reconnect Disconnect Admin",
        passwordHash: "synthetic-test-hash",
      },
    });
    const secondActor = await prisma.tenantUser.create({
      data: { tenantId: tenant.id, userId: secondUser.id, role: "admin" },
    });
    await prisma.quickBooksConnectionEvent.createMany({
      data: [
        {
          tenantId: tenant.id,
          quickBooksConnectionId: connection.id,
          actorTenantUserId: firstActor.id,
          requestId: "generation-1-connect",
          action: "CONNECTED",
          outcome: "SUCCEEDED",
          connectionGeneration: 1,
        },
        {
          tenantId: tenant.id,
          quickBooksConnectionId: connection.id,
          actorTenantUserId: firstActor.id,
          requestId: "generation-1-disconnect",
          action: "DISCONNECT_REQUESTED",
          outcome: "PENDING",
          connectionGeneration: 1,
        },
        {
          tenantId: tenant.id,
          quickBooksConnectionId: connection.id,
          actorTenantUserId: firstActor.id,
          requestId: "generation-1-disconnect",
          action: "DISCONNECTED",
          outcome: "SUCCEEDED",
          connectionGeneration: 1,
        },
        {
          tenantId: tenant.id,
          quickBooksConnectionId: connection.id,
          actorTenantUserId: secondActor.id,
          requestId: "generation-2-reconnect",
          action: "RECONNECTED",
          outcome: "SUCCEEDED",
          connectionGeneration: 2,
        },
      ],
    });

    await expect(disconnectQuickBooksConnection({
      prisma,
      runtimeEnv: env,
      tenantId: tenant.id,
      actorTenantUserId: secondActor.id,
      requestId: "generation-2-disconnect",
    })).resolves.toBe("disconnected");

    const currentDisconnect = await prisma.quickBooksConnectionEvent.findMany({
      where: {
        tenantId: tenant.id,
        quickBooksConnectionId: connection.id,
        connectionGeneration: 2,
        action: { in: ["DISCONNECT_REQUESTED", "DISCONNECTED"] },
      },
      orderBy: { createdAt: "asc" },
      select: {
        actorTenantUserId: true,
        requestId: true,
        action: true,
        connectionGeneration: true,
      },
    });
    expect(currentDisconnect).toEqual([
      {
        actorTenantUserId: secondActor.id,
        requestId: "generation-2-disconnect",
        action: "DISCONNECT_REQUESTED",
        connectionGeneration: 2,
      },
      {
        actorTenantUserId: secondActor.id,
        requestId: "generation-2-disconnect",
        action: "DISCONNECTED",
        connectionGeneration: 2,
      },
    ]);
  });

  test("database constraints reject pending revocation without token material and half-claims", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tenant = await prisma.tenant.create({
      data: { name: "Credential Constraints", slug: `credential-constraints-${suffix}` },
    });

    await expect(prisma.quickBooksConnection.create({
      data: {
        tenantId: tenant.id,
        realmId: `realm-no-token-${suffix}`,
        environment: "sandbox",
        status: "REVOCATION_PENDING",
      },
    })).rejects.toThrow();

    await expect(prisma.quickBooksConnection.create({
      data: {
        tenantId: tenant.id,
        realmId: `realm-half-claim-${suffix}`,
        environment: "sandbox",
        status: "CONNECTED",
        refreshTokenEncrypted: encryptQuickBooksSecret(env, "retained-refresh"),
        tokenRefreshClaimHash: "a".repeat(64),
      },
    })).rejects.toThrow();
  });

  test("durably deduplicates an orphan credential and revokes it through the worker retry path", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tenant = await prisma.tenant.create({
      data: { name: "Orphan Retry Tenant", slug: `orphan-retry-${suffix}` },
    });
    const refreshToken = "orphan-refresh-retry-secret";
    const firstAttemptAt = new Date("2026-08-27T10:00:00.000Z");
    providerMocks.revokeToken.mockRejectedValue(new Error("synthetic provider timeout"));

    await expect(revokeOrEnqueueQuickBooksOrphanCredential({
      prisma,
      runtimeEnv: env,
      tenantId: tenant.id,
      refreshToken,
      now: firstAttemptAt,
    })).resolves.toBe("queued");
    await expect(revokeOrEnqueueQuickBooksOrphanCredential({
      prisma,
      runtimeEnv: env,
      tenantId: tenant.id,
      refreshToken,
      now: firstAttemptAt,
    })).resolves.toBe("queued");

    const pendingRows = await prisma.quickBooksOrphanCredentialRevocation.findMany({
      where: { tenantId: tenant.id },
    });
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0]).toMatchObject({ status: "PENDING", attemptCount: 1 });
    expect(pendingRows[0]!.refreshTokenEncrypted).not.toBe(refreshToken);
    expect(JSON.stringify(pendingRows[0])).not.toContain(refreshToken);

    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    providerMocks.revokeToken.mockReset().mockResolvedValue(undefined);
    await expect(retryQuickBooksOrphanCredentialRevocation({
      prisma,
      runtimeEnv: env,
      tenantId: tenant.id,
      now: new Date("2026-08-27T10:03:00.000Z"),
    })).resolves.toBe("revoked");
    info.mockRestore();

    expect(providerMocks.revokeToken).toHaveBeenCalledWith(env, refreshToken);
    const revoked = await prisma.quickBooksOrphanCredentialRevocation.findFirstOrThrow({
      where: { tenantId: tenant.id },
    });
    expect(revoked).toMatchObject({
      status: "REVOKED",
      refreshTokenEncrypted: null,
      claimTokenHash: null,
      claimExpiresAtUtc: null,
      lastErrorCode: null,
    });
    expect(revoked.revokedAtUtc).toBeInstanceOf(Date);
    expect(JSON.stringify(info.mock.calls)).not.toContain(refreshToken);
  });

  test("fences concurrent orphan revocation workers with an exact durable claim", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tenant = await prisma.tenant.create({
      data: { name: "Orphan Fence Tenant", slug: `orphan-fence-${suffix}` },
    });
    providerMocks.revokeToken.mockRejectedValueOnce(new Error("initial timeout"));
    await revokeOrEnqueueQuickBooksOrphanCredential({
      prisma,
      runtimeEnv: env,
      tenantId: tenant.id,
      refreshToken: "orphan-fence-refresh",
      now: new Date("2026-08-27T11:00:00.000Z"),
    });

    const revokeBarrier = deferred<void>();
    providerMocks.revokeToken.mockReset().mockImplementation(() => revokeBarrier.promise);
    const retryNow = new Date("2026-08-27T11:03:00.000Z");
    const first = retryQuickBooksOrphanCredentialRevocation({
      prisma,
      runtimeEnv: env,
      tenantId: tenant.id,
      now: retryNow,
    });
    await waitFor(async () => {
      const row = await prisma.quickBooksOrphanCredentialRevocation.findFirst({ where: { tenantId: tenant.id } });
      return providerMocks.revokeToken.mock.calls.length === 1 && row?.status === "PROCESSING";
    }, "orphan revocation claim");

    await expect(retryQuickBooksOrphanCredentialRevocation({
      prisma,
      runtimeEnv: env,
      tenantId: tenant.id,
      now: retryNow,
    })).resolves.toBe("idle");
    expect(providerMocks.revokeToken).toHaveBeenCalledTimes(1);

    revokeBarrier.resolve();
    await expect(first).resolves.toBe("revoked");
    expect(providerMocks.revokeToken).toHaveBeenCalledTimes(1);
  });

  test("moves exhausted orphan revocation to a sanitized terminal escalation state", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tenant = await prisma.tenant.create({
      data: { name: "Orphan Dead Tenant", slug: `orphan-dead-${suffix}` },
    });
    const refreshToken = "orphan-terminal-refresh-secret";
    providerMocks.revokeToken.mockRejectedValue(new Error(`outage ${refreshToken}`));
    await revokeOrEnqueueQuickBooksOrphanCredential({
      prisma,
      runtimeEnv: env,
      tenantId: tenant.id,
      refreshToken,
      now: new Date("2026-08-27T12:00:00.000Z"),
    });
    await prisma.quickBooksOrphanCredentialRevocation.updateMany({
      where: { tenantId: tenant.id },
      data: {
        attemptCount: QUICKBOOKS_ORPHAN_REVOCATION_MAX_ATTEMPTS - 1,
        nextAttemptAtUtc: new Date("2026-08-27T12:01:00.000Z"),
      },
    });

    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(retryQuickBooksOrphanCredentialRevocation({
      prisma,
      runtimeEnv: env,
      tenantId: tenant.id,
      now: new Date("2026-08-27T12:02:00.000Z"),
    })).resolves.toBe("dead");
    const logged = JSON.stringify(errorLog.mock.calls);
    errorLog.mockRestore();

    const dead = await prisma.quickBooksOrphanCredentialRevocation.findFirstOrThrow({
      where: { tenantId: tenant.id },
    });
    expect(dead).toMatchObject({
      status: "DEAD",
      attemptCount: QUICKBOOKS_ORPHAN_REVOCATION_MAX_ATTEMPTS,
      nextAttemptAtUtc: null,
      claimTokenHash: null,
      claimExpiresAtUtc: null,
      lastErrorCode: "QUICKBOOKS_ORPHAN_TOKEN_REVOCATION_FAILED",
    });
    expect(dead.deadAtUtc).toBeInstanceOf(Date);
    expect(dead.refreshTokenEncrypted).not.toBe(refreshToken);
    expect(logged).toContain("QUICKBOOKS_ORPHAN_REVOCATION_DEAD");
    expect(logged).not.toContain(refreshToken);
    expect(logged).not.toContain("outage");
  });

  test("enforces orphan revocation tenant isolation for the restricted runtime role", async () => {
    const first = await prisma.tenant.create({
      data: { name: "Orphan RLS First", slug: `orphan-rls-first-${Date.now()}` },
    });
    const second = await prisma.tenant.create({
      data: { name: "Orphan RLS Second", slug: `orphan-rls-second-${Date.now()}` },
    });
    providerMocks.revokeToken.mockRejectedValue(new Error("synthetic timeout"));
    await revokeOrEnqueueQuickBooksOrphanCredential({
      prisma, runtimeEnv: env, tenantId: first.id, refreshToken: "rls-first-refresh",
    });
    await revokeOrEnqueueQuickBooksOrphanCredential({
      prisma, runtimeEnv: env, tenantId: second.id, refreshToken: "rls-second-refresh",
    });

    const password = `quickbooks_orphan_rls_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await prisma.$executeRawUnsafe(`ALTER ROLE quotefly_runtime LOGIN PASSWORD '${password.replaceAll("'", "''")}'`);
    const runtimePrisma = new PrismaClient({ datasources: { db: { url: runtimeDatabaseUrl(password) } } });
    try {
      await runtimePrisma.$connect();
      await expect(runtimePrisma.quickBooksOrphanCredentialRevocation.count()).resolves.toBe(0);
      const visible = await withTenantRlsContext(runtimePrisma, first.id, (transaction) =>
        transaction.quickBooksOrphanCredentialRevocation.findMany({
          select: { tenantId: true },
        }),
      );
      expect(visible).toEqual([{ tenantId: first.id }]);

      await expect(withTenantRlsContext(runtimePrisma, first.id, (transaction) =>
        transaction.quickBooksOrphanCredentialRevocation.create({
          data: {
            tenantId: second.id,
            dedupeKeyHash: "f".repeat(64),
            refreshTokenEncrypted: encryptQuickBooksSecret(env, "cross-tenant-refresh"),
            status: "PENDING",
            attemptCount: 1,
            nextAttemptAtUtc: new Date(),
          },
        }),
      )).rejects.toThrow();
    } finally {
      await runtimePrisma.$disconnect();
      await prisma.$executeRaw`ALTER ROLE quotefly_runtime NOLOGIN`;
    }
  });

  test("keeps QuickBooks lifecycle evidence tenant-scoped and immutable for the runtime role", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tenant = await prisma.tenant.create({
      data: { name: "Lifecycle Audit Tenant", slug: `lifecycle-audit-${suffix}` },
    });
    const user = await prisma.user.create({
      data: {
        email: `lifecycle-audit-${suffix}@example.com`,
        fullName: "Lifecycle Audit Actor",
        passwordHash: "synthetic-test-hash",
      },
    });
    const membership = await prisma.tenantUser.create({
      data: { tenantId: tenant.id, userId: user.id, role: "owner" },
    });
    const connection = await prisma.quickBooksConnection.create({
      data: {
        tenantId: tenant.id,
        realmId: `realm-lifecycle-audit-${suffix}`,
        environment: "sandbox",
      },
    });
    const event = await prisma.quickBooksConnectionEvent.create({
      data: {
        tenantId: tenant.id,
        quickBooksConnectionId: connection.id,
        actorTenantUserId: membership.id,
        requestId: `request-${suffix}`.slice(0, 128),
        action: "CONNECTED",
        outcome: "SUCCEEDED",
        connectionGeneration: 1,
      },
    });

    const password = `quickbooks_lifecycle_rls_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await prisma.$executeRawUnsafe(`ALTER ROLE quotefly_runtime LOGIN PASSWORD '${password.replaceAll("'", "''")}'`);
    const runtimePrisma = new PrismaClient({ datasources: { db: { url: runtimeDatabaseUrl(password) } } });
    try {
      await runtimePrisma.$connect();
      await expect(runtimePrisma.quickBooksConnectionEvent.count()).resolves.toBe(0);
      await expect(withTenantRlsContext(runtimePrisma, tenant.id, (transaction) =>
        transaction.quickBooksConnectionEvent.findMany({
          select: { id: true, tenantId: true, action: true },
        }),
      )).resolves.toEqual([{ id: event.id, tenantId: tenant.id, action: "CONNECTED" }]);
      await expect(withTenantRlsContext(runtimePrisma, tenant.id, (transaction) =>
        transaction.quickBooksConnectionEvent.update({
          where: { id: event.id },
          data: { outcome: "PENDING" },
        }),
      )).rejects.toThrow();
      await expect(withTenantRlsContext(runtimePrisma, tenant.id, (transaction) =>
        transaction.quickBooksConnectionEvent.delete({ where: { id: event.id } }),
      )).rejects.toThrow();
    } finally {
      await runtimePrisma.$disconnect();
      await prisma.$executeRaw`ALTER ROLE quotefly_runtime NOLOGIN`;
    }
  });
});
