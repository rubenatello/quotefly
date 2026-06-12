import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildServer } from "../../src/app";
import { prisma } from "../../src/lib/prisma";

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
});
