import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildServer } from "../../src/app";
import { env } from "../../src/config/env";
import { prisma } from "../../src/lib/prisma";
import { QUICKBOOKS_RECONCILIATION_WORKER_KEY } from "../../src/services/worker-heartbeats";

type Session = Readonly<{
  cookie: string;
  tenant: { id: string };
  user: { id: string };
}>;

const HEALTH_URL = "/v1/internal/control-plane/quickbooks-health";
const PRIVATE_REALM = "realm-must-not-appear-in-integration-health";
const PRIVATE_ACCESS_TOKEN = "encrypted-access-must-not-appear-in-integration-health";
const PRIVATE_REFRESH_TOKEN = "encrypted-refresh-must-not-appear-in-integration-health";

let app: FastifyInstance;
let originalRuntime: {
  providerWorkflowsEnabled: boolean;
  oauthOnlyMode: boolean;
  reconciliationWorkerEnabled: boolean;
  cdcWorkerEnabled: boolean;
};

function cookieFrom(response: { headers: Record<string, number | string | string[] | undefined> }) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error("Expected a session cookie.");
  return String(value).split(";")[0] ?? String(value);
}

async function signUp(email: string, label: string): Promise<Session> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      email,
      password: "IntegrationHealthPassword123!",
      fullName: `${label} Owner`,
      companyName: `${label} Services ${unique}`,
      primaryTrade: "ROOFING",
      acceptedLegalTerms: true,
      termsVersion: "2026-07-30",
      privacyPolicyVersion: "2026-08-10",
    },
  });
  expect(response.statusCode).toBe(201);
  return { ...(response.json() as Omit<Session, "cookie">), cookie: cookieFrom(response) };
}

function useOauthOnlyPhase() {
  Object.assign(app.env, {
    QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: true,
    QUICKBOOKS_OAUTH_ONLY_MODE: true,
    QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: false,
    QUICKBOOKS_CDC_WORKER_ENABLED: false,
  });
}

describe("QuickBooks superuser integration health", () => {
  beforeAll(async () => {
    originalRuntime = {
      providerWorkflowsEnabled: env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED,
      oauthOnlyMode: env.QUICKBOOKS_OAUTH_ONLY_MODE,
      reconciliationWorkerEnabled: env.QUICKBOOKS_RECONCILIATION_WORKER_ENABLED,
      cdcWorkerEnabled: env.QUICKBOOKS_CDC_WORKER_ENABLED,
    };
    app = buildServer();
    await app.ready();
  });

  beforeEach(async () => {
    useOauthOnlyPhase();
    await prisma.superuserAuditEvent.deleteMany();
    await prisma.workerHeartbeatInstance.deleteMany({
      where: { workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY },
    });
    await prisma.workerHeartbeat.deleteMany({
      where: { workerKey: QUICKBOOKS_RECONCILIATION_WORKER_KEY },
    });
    await prisma.tenant.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    Object.assign(env, {
      QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: originalRuntime.providerWorkflowsEnabled,
      QUICKBOOKS_OAUTH_ONLY_MODE: originalRuntime.oauthOnlyMode,
      QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: originalRuntime.reconciliationWorkerEnabled,
      QUICKBOOKS_CDC_WORKER_ENABLED: originalRuntime.cdcWorkerEnabled,
    });
    await app.close();
    await prisma.$disconnect();
  });

  test("requires an authenticated live superuser and rejects query parameters", async () => {
    const anonymous = await app.inject({ method: "GET", url: HEALTH_URL });
    expect(anonymous.statusCode).toBe(401);

    const ordinary = await signUp("ordinary-integration-health@example.com", "Ordinary Health");
    const forbidden = await app.inject({
      method: "GET",
      url: HEALTH_URL,
      headers: { cookie: ordinary.cookie },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: "SUPERUSER_REQUIRED" });

    const superuser = await signUp("superuser-integration@example.com", "Superuser Health");
    const invalidQuery = await app.inject({
      method: "GET",
      url: `${HEALTH_URL}?tenantId=must-not-be-accepted`,
      headers: { cookie: superuser.cookie },
    });
    expect(invalidQuery.statusCode).toBe(400);
    expect(invalidQuery.body).not.toContain("must-not-be-accepted");
  });

  test("returns only the closed health DTO and records a content-free audit", async () => {
    const superuser = await signUp("superuser-integration@example.com", "Superuser Health");
    await prisma.quickBooksConnection.create({
      data: {
        tenantId: superuser.tenant.id,
        realmId: PRIVATE_REALM,
        environment: "sandbox",
        status: "CONNECTED",
        scopes: ["com.intuit.quickbooks.accounting"],
        accessTokenEncrypted: PRIVATE_ACCESS_TOKEN,
        refreshTokenEncrypted: PRIVATE_REFRESH_TOKEN,
        accessTokenExpiresAtUtc: new Date(Date.now() + 3_600_000),
      },
    });

    const response = await app.inject({
      method: "GET",
      url: HEALTH_URL,
      headers: { cookie: superuser.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toMatchObject({
      schema: "quotefly.integration-health/v1",
      environment: "sandbox",
      mode: "oauth_only",
      state: "healthy",
      automation: {
        providerActionsEnabled: false,
        hostedPaymentsEnabled: false,
        reconciliationEnabled: false,
        cdcEnabled: false,
      },
      monitors: { deliveryVerified: false },
      worker: {
        required: false,
        status: "not_required",
        ready: false,
        lastObservedAtUtc: null,
        releaseMatches: null,
      },
    });
    expect(new Date((response.json() as { observedAtUtc: string }).observedAtUtc).toISOString()).toBe(
      (response.json() as { observedAtUtc: string }).observedAtUtc,
    );
    for (const sensitive of [PRIVATE_REALM, PRIVATE_ACCESS_TOKEN, PRIVATE_REFRESH_TOKEN]) {
      expect(response.body).not.toContain(sensitive);
    }

    const audit = await prisma.superuserAuditEvent.findFirstOrThrow({
      where: {
        actorUserId: superuser.user.id,
        action: "QUICKBOOKS_INTEGRATION_HEALTH_VIEWED",
      },
    });
    expect(audit.metadata).toMatchObject({
      schema: "quotefly.integration-health/v1",
      environment: "sandbox",
      mode: "oauth_only",
      state: "healthy",
    });
    const auditText = JSON.stringify(audit);
    for (const sensitive of [PRIVATE_REALM, PRIVATE_ACCESS_TOKEN, PRIVATE_REFRESH_TOKEN]) {
      expect(auditText).not.toContain(sensitive);
    }
  });

  test("fails with a sanitized 503 when runtime evaluation is invalid", async () => {
    const superuser = await signUp("superuser-integration@example.com", "Superuser Health");
    Object.assign(app.env, {
      QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: true,
      QUICKBOOKS_OAUTH_ONLY_MODE: true,
      QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: true,
      QUICKBOOKS_CDC_WORKER_ENABLED: false,
    });

    const response = await app.inject({
      method: "GET",
      url: HEALTH_URL,
      headers: { cookie: superuser.cookie },
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual({
      code: "QUICKBOOKS_INTEGRATION_HEALTH_UNAVAILABLE",
      error: "QuickBooks integration health is temporarily unavailable.",
    });
    expect(response.body).not.toContain("operational phase is invalid");
  });
});
