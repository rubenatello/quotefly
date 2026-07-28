import type { FastifyInstance } from "fastify";
import { createHmac } from "crypto";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { buildServer } from "../../src/app";
import { env } from "../../src/config/env";
import { prisma } from "../../src/lib/prisma";
import { createSignedQuickBooksState } from "../../src/services/quickbooks";

const quickBooksProviderMocks = vi.hoisted(() => ({
  exchangeAuthorizationCode: vi.fn(),
  fetchCompanyInfo: vi.fn(),
}));

vi.mock("../../src/services/quickbooks", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/quickbooks")>(
    "../../src/services/quickbooks",
  );
  return {
    ...actual,
    exchangeQuickBooksAuthorizationCode: quickBooksProviderMocks.exchangeAuthorizationCode,
    fetchQuickBooksCompanyInfo: quickBooksProviderMocks.fetchCompanyInfo,
  };
});

type AuthSession = {
  cookie: string;
  user: {
    id: string;
    email: string;
    fullName: string;
  };
  tenant: {
    id: string;
    name: string;
    slug: string;
  };
};

type CustomerResponse = {
  customer: {
    id: string;
    fullName: string;
    email: string | null;
    phone: string;
    tenantId: string;
  };
};

type QuoteResponse = {
  quote: {
    id: string;
    tenantId: string;
    customerId: string;
    serviceType: string;
    title: string;
    totalAmount: string | number;
    lineItems?: Array<{ id: string; description: string }>;
  };
};

type StripeWebhookTestHelper = {
  webhooks: {
    generateTestHeaderString: (params: { payload: string; secret: string }) => string;
  };
};

let app: FastifyInstance;

function parseJson<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

function authHeaders(token: string) {
  return { cookie: token };
}

function extractSessionCookie(response: { headers: Record<string, number | string | string[] | undefined> }): string {
  const rawCookie = response.headers["set-cookie"];
  const firstCookie = Array.isArray(rawCookie) ? rawCookie[0] : rawCookie;
  if (!firstCookie) {
    throw new Error("Expected auth response to set a session cookie.");
  }
  return String(firstCookie).split(";")[0] ?? String(firstCookie);
}

async function cleanDatabase() {
  await prisma.quickBooksWebhookEvent.deleteMany();
  await prisma.billingWebhookEvent.deleteMany();
  await prisma.tenant.deleteMany();
  await prisma.user.deleteMany();
}

async function signUp(label: string): Promise<AuthSession> {
  const unique = `${Date.now()}-${label}`;
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      email: `${label}-${unique}@example.com`,
      password: "TestPassword123!",
      fullName: `${label} Owner`,
      companyName: `${label} QuoteFly Services ${unique}`,
      primaryTrade: "ROOFING",
      generateLogoIfMissing: false,
    },
  });

  expect(response.statusCode).toBe(201);
  return {
    ...parseJson<Omit<AuthSession, "cookie">>(response),
    cookie: extractSessionCookie(response),
  };
}

describe("QuoteFly API integration", () => {
  beforeAll(async () => {
    await cleanDatabase();
    app = buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await cleanDatabase();
    await app.close();
  });

  test("protects the core customer and quote flow by tenant", async () => {
    const alpha = await signUp("alpha");
    const beta = await signUp("beta");

    const meResponse = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: authHeaders(alpha.cookie),
    });
    expect(meResponse.statusCode).toBe(200);
    expect(parseJson<{ tenant: { id: string } }>(meResponse).tenant.id).toBe(alpha.tenant.id);

    const unauthenticatedCustomers = await app.inject({
      method: "GET",
      url: "/v1/customers",
    });
    expect(unauthenticatedCustomers.statusCode).toBe(401);

    const customerResponse = await app.inject({
      method: "POST",
      url: "/v1/customers",
      headers: authHeaders(alpha.cookie),
      payload: {
        fullName: "Maria Lopez",
        phone: "555-010-1200",
        email: "maria.lopez@example.com",
        notes: "Roof leak after heavy rain.",
      },
    });
    expect(customerResponse.statusCode).toBe(201);
    const { customer } = parseJson<CustomerResponse>(customerResponse);
    expect(customer.tenantId).toBe(alpha.tenant.id);

    const alphaCustomers = await app.inject({
      method: "GET",
      url: "/v1/customers",
      headers: authHeaders(alpha.cookie),
    });
    expect(alphaCustomers.statusCode).toBe(200);
    expect(parseJson<{ customers: Array<{ id: string }> }>(alphaCustomers).customers).toHaveLength(1);

    const betaCustomers = await app.inject({
      method: "GET",
      url: "/v1/customers",
      headers: authHeaders(beta.cookie),
    });
    expect(betaCustomers.statusCode).toBe(200);
    expect(parseJson<{ customers: Array<{ id: string }> }>(betaCustomers).customers).toHaveLength(0);

    const quoteResponse = await app.inject({
      method: "POST",
      url: "/v1/quotes",
      headers: authHeaders(alpha.cookie),
      payload: {
        customerId: customer.id,
        serviceType: "ROOFING",
        title: "Roof Leak Repair",
        scopeText: "Repair flashing around chimney and seal exposed fasteners.",
        internalCostSubtotal: 150,
        customerPriceSubtotal: 425,
        taxAmount: 35,
        lineItems: [
          {
            description: "Chimney flashing repair",
            quantity: 1,
            unitCost: 150,
            unitPrice: 425,
          },
        ],
      },
    });
    expect(quoteResponse.statusCode).toBe(201);
    const { quote } = parseJson<QuoteResponse>(quoteResponse);
    expect(quote.tenantId).toBe(alpha.tenant.id);
    expect(Number(quote.totalAmount)).toBe(460);

    const alphaQuote = await app.inject({
      method: "GET",
      url: `/v1/quotes/${quote.id}`,
      headers: authHeaders(alpha.cookie),
    });
    expect(alphaQuote.statusCode).toBe(200);
    expect(parseJson<QuoteResponse>(alphaQuote).quote.lineItems).toHaveLength(1);

    const betaCannotReadAlphaQuote = await app.inject({
      method: "GET",
      url: `/v1/quotes/${quote.id}`,
      headers: authHeaders(beta.cookie),
    });
    expect(betaCannotReadAlphaQuote.statusCode).toBe(404);

    const betaCannotUseAlphaCustomer = await app.inject({
      method: "POST",
      url: "/v1/quotes",
      headers: authHeaders(beta.cookie),
      payload: {
        customerId: customer.id,
        serviceType: "ROOFING",
        title: "Cross Tenant Quote",
        scopeText: "This should not be allowed.",
        internalCostSubtotal: 1,
        customerPriceSubtotal: 2,
        taxAmount: 0,
      },
    });
    expect(betaCannotUseAlphaCustomer.statusCode).toBe(404);
  });

  test("confirms a customer send atomically and deduplicates retries", async () => {
    const session = await signUp("confirm-send");
    const customerResponse = await app.inject({
      method: "POST",
      url: "/v1/customers",
      headers: authHeaders(session.cookie),
      payload: {
        fullName: "Mobile Send Customer",
        phone: "555-010-3300",
        email: "mobile-send@example.com",
      },
    });
    expect(customerResponse.statusCode).toBe(201);
    const { customer } = parseJson<CustomerResponse>(customerResponse);

    const quoteResponse = await app.inject({
      method: "POST",
      url: "/v1/quotes",
      headers: authHeaders(session.cookie),
      payload: {
        customerId: customer.id,
        serviceType: "ROOFING",
        title: "Mobile Send Quote",
        scopeText: "Repair roof flashing and verify the seal.",
        internalCostSubtotal: 100,
        customerPriceSubtotal: 300,
        taxAmount: 0,
      },
    });
    expect(quoteResponse.statusCode).toBe(201);
    const { quote } = parseJson<QuoteResponse>(quoteResponse);
    const idempotencyKey = `integration-confirm-send-${Date.now()}`;
    const payload = {
      channel: "SMS_APP",
      idempotencyKey,
      destination: customer.phone,
      subject: "Your QuoteFly quote",
      body: "Your quote is ready.",
    };

    const firstConfirmation = await app.inject({
      method: "POST",
      url: `/v1/quotes/${quote.id}/confirm-send`,
      headers: authHeaders(session.cookie),
      payload,
    });
    expect(firstConfirmation.statusCode).toBe(200);
    expect(parseJson<{ quote: { status: string }; event: { channel: string }; duplicate: boolean }>(firstConfirmation)).toMatchObject({
      quote: { status: "SENT_TO_CUSTOMER" },
      event: { channel: "SMS_APP" },
      duplicate: false,
    });

    const retryConfirmation = await app.inject({
      method: "POST",
      url: `/v1/quotes/${quote.id}/confirm-send`,
      headers: authHeaders(session.cookie),
      payload,
    });
    expect(retryConfirmation.statusCode).toBe(200);
    expect(parseJson<{ duplicate: boolean }>(retryConfirmation).duplicate).toBe(true);

    await expect(
      prisma.quoteOutboundEvent.count({
        where: { tenantId: session.tenant.id, quoteId: quote.id, idempotencyKey },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.quoteRevision.count({
        where: { tenantId: session.tenant.id, quoteId: quote.id, eventType: "DECISION" },
      }),
    ).resolves.toBe(1);

    const storedQuote = await prisma.quote.findFirstOrThrow({
      where: { id: quote.id, tenantId: session.tenant.id },
      select: { status: true, sentAt: true },
    });
    expect(storedQuote.status).toBe("SENT_TO_CUSTOMER");
    expect(storedQuote.sentAt).not.toBeNull();
  });

  test("verifies and deduplicates Stripe billing webhooks", async () => {
    const session = await signUp("billing");
    const eventPayload = JSON.stringify({
      id: "evt_quotefly_integration_checkout_expired",
      type: "checkout.session.expired",
      data: {
        object: {
          id: "cs_test_expired",
          object: "checkout.session",
          client_reference_id: session.tenant.id,
          metadata: {
            tenantId: session.tenant.id,
          },
        },
      },
    });
    const StripeConstructor = Stripe as unknown as {
      new (key: string, config?: Record<string, unknown>): StripeWebhookTestHelper;
    };
    const stripe = new StripeConstructor(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: "2026-03-25.dahlia",
    });
    const stripeSignature = stripe.webhooks.generateTestHeaderString({
      payload: eventPayload,
      secret: process.env.STRIPE_WEBHOOK_SECRET!,
    });

    const firstWebhookResponse = await app.inject({
      method: "POST",
      url: "/v1/billing/webhook",
      headers: {
        "content-type": "application/json",
        "stripe-signature": stripeSignature,
      },
      payload: eventPayload,
    });
    expect(firstWebhookResponse.statusCode).toBe(200);
    expect(parseJson<{ received: boolean }>(firstWebhookResponse)).toEqual({ received: true });

    const tenantAfterWebhook = await prisma.tenant.findUniqueOrThrow({
      where: { id: session.tenant.id },
      select: { subscriptionStatus: true },
    });
    expect(tenantAfterWebhook.subscriptionStatus).toBe("checkout_expired");

    const duplicateWebhookResponse = await app.inject({
      method: "POST",
      url: "/v1/billing/webhook",
      headers: {
        "content-type": "application/json",
        "stripe-signature": stripeSignature,
      },
      payload: eventPayload,
    });
    expect(duplicateWebhookResponse.statusCode).toBe(200);
    expect(parseJson<{ received: boolean; duplicate: boolean }>(duplicateWebhookResponse)).toEqual({
      received: true,
      duplicate: true,
    });

    await expect(
      prisma.billingWebhookEvent.count({
        where: { stripeEventId: "evt_quotefly_integration_checkout_expired" },
      }),
    ).resolves.toBe(1);

    const invalidSignatureResponse = await app.inject({
      method: "POST",
      url: "/v1/billing/webhook",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "invalid",
      },
      payload: eventPayload,
    });
    expect(invalidSignatureResponse.statusCode).toBe(400);
  });

  test("rejects a revoked membership on protected reads and mutations", async () => {
    const session = await signUp("revoked-member");

    await prisma.tenantUser.update({
      where: {
        tenantId_userId: {
          tenantId: session.tenant.id,
          userId: session.user.id,
        },
      },
      data: { deletedAtUtc: new Date() },
    });

    const readResponse = await app.inject({
      method: "GET",
      url: "/v1/customers",
      headers: authHeaders(session.cookie),
    });
    expect(readResponse.statusCode).toBe(401);
    expect(parseJson<{ error: string }>(readResponse).error).toBe("Session is no longer valid.");

    const mutationResponse = await app.inject({
      method: "POST",
      url: "/v1/customers",
      headers: authHeaders(session.cookie),
      payload: {
        fullName: "Revoked Membership Customer",
        phone: "555-010-9911",
      },
    });
    expect(mutationResponse.statusCode).toBe(401);
    await expect(
      prisma.customer.count({ where: { tenantId: session.tenant.id } }),
    ).resolves.toBe(0);
  });

  test("requires a live owner role for Stripe checkout and portal sessions", async () => {
    const session = await signUp("billing-role");

    await prisma.tenantUser.update({
      where: {
        tenantId_userId: {
          tenantId: session.tenant.id,
          userId: session.user.id,
        },
      },
      data: { role: "member" },
    });

    const checkoutResponse = await app.inject({
      method: "POST",
      url: "/v1/billing/checkout-session",
      headers: authHeaders(session.cookie),
      payload: { planCode: "starter" },
    });
    expect(checkoutResponse.statusCode).toBe(403);
    expect(parseJson<{ error: string }>(checkoutResponse).error).toBe(
      "Only an active workspace owner can manage billing.",
    );

    const portalResponse = await app.inject({
      method: "POST",
      url: "/v1/billing/portal-session",
      headers: authHeaders(session.cookie),
    });
    expect(portalResponse.statusCode).toBe(403);
    expect(parseJson<{ error: string }>(portalResponse).error).toBe(
      "Only an active workspace owner can manage billing.",
    );
  });

  test("routes unauthenticated QuickBooks webhooks through signature verification", async () => {
    const payload = "[]";
    const signature = createHmac("sha256", process.env.QUICKBOOKS_WEBHOOK_VERIFIER!)
      .update(payload)
      .digest("base64");

    const validResponse = await app.inject({
      method: "POST",
      url: "/v1/integrations/quickbooks/webhook",
      headers: {
        "content-type": "application/json",
        "intuit-signature": signature,
      },
      payload,
    });
    expect(validResponse.statusCode).toBe(200);
    expect(parseJson<{ received: boolean; count: number }>(validResponse)).toEqual({
      received: true,
      count: 0,
    });

    const invalidResponse = await app.inject({
      method: "POST",
      url: "/v1/integrations/quickbooks/webhook",
      headers: {
        "content-type": "application/json",
        "intuit-signature": "invalid",
      },
      payload,
    });
    expect(invalidResponse.statusCode).toBe(401);

    const missingSignatureResponse = await app.inject({
      method: "POST",
      url: "/v1/integrations/quickbooks/webhook",
      headers: { "content-type": "application/json" },
      payload,
    });
    expect(missingSignatureResponse.statusCode).toBe(400);

    const protectedWorkspaceResponse = await app.inject({
      method: "POST",
      url: "/v1/integrations/quickbooks/disconnect",
    });
    expect(protectedWorkspaceResponse.statusCode).toBe(401);
  });

  test("rejects stale QuickBooks OAuth state before provider exchange or credential writes", async () => {
    const rejectedActors = [
      {
        label: "quickbooks-demoted",
        revoke: async (session: AuthSession) => {
          await prisma.tenantUser.update({
            where: {
              tenantId_userId: {
                tenantId: session.tenant.id,
                userId: session.user.id,
              },
            },
            data: { role: "member" },
          });
        },
      },
      {
        label: "quickbooks-membership-deleted",
        revoke: async (session: AuthSession) => {
          await prisma.tenantUser.update({
            where: {
              tenantId_userId: {
                tenantId: session.tenant.id,
                userId: session.user.id,
              },
            },
            data: { deletedAtUtc: new Date() },
          });
        },
      },
      {
        label: "quickbooks-user-deleted",
        revoke: async (session: AuthSession) => {
          await prisma.user.update({
            where: { id: session.user.id },
            data: { deletedAtUtc: new Date() },
          });
        },
      },
      {
        label: "quickbooks-tenant-deleted",
        revoke: async (session: AuthSession) => {
          await prisma.tenant.update({
            where: { id: session.tenant.id },
            data: { deletedAtUtc: new Date() },
          });
        },
      },
    ];

    for (const [index, rejectedActor] of rejectedActors.entries()) {
      const session = await signUp(rejectedActor.label);
      const state = createSignedQuickBooksState(env, {
        tenantId: session.tenant.id,
        userId: session.user.id,
        role: "owner",
      });
      await rejectedActor.revoke(session);
      quickBooksProviderMocks.exchangeAuthorizationCode.mockClear();
      quickBooksProviderMocks.fetchCompanyInfo.mockClear();

      const response = await app.inject({
        method: "GET",
        url: `/v1/integrations/quickbooks/callback?state=${encodeURIComponent(state)}&code=one-time-code-${index}&realmId=realm-rejected-${index}`,
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toContain("integrations=quickbooks_error");
      expect(response.body).not.toContain("one-time-code");
      expect(quickBooksProviderMocks.exchangeAuthorizationCode).not.toHaveBeenCalled();
      expect(quickBooksProviderMocks.fetchCompanyInfo).not.toHaveBeenCalled();
      await expect(
        prisma.quickBooksConnection.count({ where: { tenantId: session.tenant.id } }),
      ).resolves.toBe(0);
    }
  });

  test.each(["owner", "admin"])(
    "preserves QuickBooks OAuth callback success for an active %s",
    async (role) => {
      const session = await signUp(`quickbooks-active-${role}`);
      if (role !== "owner") {
        await prisma.tenantUser.update({
          where: {
            tenantId_userId: {
              tenantId: session.tenant.id,
              userId: session.user.id,
            },
          },
          data: { role },
        });
      }

      const state = createSignedQuickBooksState(env, {
        tenantId: session.tenant.id,
        userId: session.user.id,
        role,
      });
      const accessToken = `sandbox-access-${role}`;
      const refreshToken = `sandbox-refresh-${role}`;
      quickBooksProviderMocks.exchangeAuthorizationCode.mockReset();
      quickBooksProviderMocks.fetchCompanyInfo.mockReset();
      quickBooksProviderMocks.exchangeAuthorizationCode.mockResolvedValue({
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: "bearer",
        expires_in: 3600,
      });
      quickBooksProviderMocks.fetchCompanyInfo.mockResolvedValue({
        companyName: `Sandbox ${role} Company`,
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/integrations/quickbooks/callback?state=${encodeURIComponent(state)}&code=active-${role}-code&realmId=realm-active-${role}`,
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toContain("integrations=quickbooks_connected");
      expect(quickBooksProviderMocks.exchangeAuthorizationCode).toHaveBeenCalledOnce();
      expect(quickBooksProviderMocks.fetchCompanyInfo).toHaveBeenCalledOnce();

      const connection = await prisma.quickBooksConnection.findUniqueOrThrow({
        where: { tenantId: session.tenant.id },
        select: {
          status: true,
          realmId: true,
          accessTokenEncrypted: true,
          refreshTokenEncrypted: true,
        },
      });
      expect(connection).toMatchObject({
        status: "CONNECTED",
        realmId: `realm-active-${role}`,
      });
      expect(connection.accessTokenEncrypted).not.toBe(accessToken);
      expect(connection.refreshTokenEncrypted).not.toBe(refreshToken);
    },
  );

  test("does not persist QuickBooks credentials when access changes during exchange", async () => {
    const session = await signUp("quickbooks-exchange-revocation");
    const state = createSignedQuickBooksState(env, {
      tenantId: session.tenant.id,
      userId: session.user.id,
      role: "owner",
    });
    quickBooksProviderMocks.exchangeAuthorizationCode.mockReset();
    quickBooksProviderMocks.fetchCompanyInfo.mockReset();
    quickBooksProviderMocks.exchangeAuthorizationCode.mockImplementation(async () => {
      await prisma.tenantUser.update({
        where: {
          tenantId_userId: {
            tenantId: session.tenant.id,
            userId: session.user.id,
          },
        },
        data: { role: "member" },
      });
      return {
        access_token: "revoked-during-exchange-access",
        refresh_token: "revoked-during-exchange-refresh",
        token_type: "bearer",
        expires_in: 3600,
      };
    });
    quickBooksProviderMocks.fetchCompanyInfo.mockResolvedValue({
      companyName: "Revoked During Exchange Company",
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/integrations/quickbooks/callback?state=${encodeURIComponent(state)}&code=revocation-race-code&realmId=realm-revocation-race`,
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("integrations=quickbooks_error");
    expect(quickBooksProviderMocks.exchangeAuthorizationCode).toHaveBeenCalledOnce();
    expect(quickBooksProviderMocks.fetchCompanyInfo).toHaveBeenCalledOnce();
    await expect(
      prisma.quickBooksConnection.count({ where: { tenantId: session.tenant.id } }),
    ).resolves.toBe(0);
  });

  test("keeps QuickBooks provider failures out of the OAuth redirect", async () => {
    const session = await signUp("quickbooks-provider-failure");
    const state = createSignedQuickBooksState(env, {
      tenantId: session.tenant.id,
      userId: session.user.id,
      role: "owner",
    });
    const sensitiveProviderMessage = "provider rejected secret-access-token";
    quickBooksProviderMocks.exchangeAuthorizationCode.mockReset();
    quickBooksProviderMocks.fetchCompanyInfo.mockReset();
    quickBooksProviderMocks.exchangeAuthorizationCode.mockRejectedValue(
      new Error(sensitiveProviderMessage),
    );

    const response = await app.inject({
      method: "GET",
      url: `/v1/integrations/quickbooks/callback?state=${encodeURIComponent(state)}&code=failing-code&realmId=realm-provider-failure`,
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("integrations=quickbooks_error");
    expect(response.headers.location).not.toContain("secret-access-token");
    expect(response.body).not.toContain("secret-access-token");
    expect(quickBooksProviderMocks.fetchCompanyInfo).not.toHaveBeenCalled();
    await expect(
      prisma.quickBooksConnection.count({ where: { tenantId: session.tenant.id } }),
    ).resolves.toBe(0);
  });
});
