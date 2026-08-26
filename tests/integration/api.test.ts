import type { FastifyInstance } from "fastify";
import { createHmac } from "crypto";
import { readFile } from "node:fs/promises";
import Stripe from "stripe";
import twilio from "twilio";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { buildServer } from "../../src/app";
import { env } from "../../src/config/env";
import { prisma } from "../../src/lib/prisma";
import { withTenantRlsContext } from "../../src/lib/tenant-rls";
import {
  buildTenantEntitlements,
  resolveReconciledSubscriptionBillingPeriod,
  resolveReconciledSubscriptionPeriod,
  resolveSubscriptionItemBilling,
} from "../../src/lib/subscription";
import { createSignedQuickBooksState } from "../../src/services/quickbooks";
import {
  getStandardWorkPresetCatalog,
  standardWorkPresetContentHash,
} from "../../src/services/work-preset-catalog";
import { ServiceCategory } from "@prisma/client";

const quickBooksProviderMocks = vi.hoisted(() => ({
  exchangeAuthorizationCode: vi.fn(),
  fetchCompanyInfo: vi.fn(),
  ensureAccessToken: vi.fn(),
  findCustomer: vi.fn(),
  createCustomer: vi.fn(),
  findItem: vi.fn(),
  resolveIncomeAccount: vi.fn(),
  createServiceItem: vi.fn(),
  createInvoice: vi.fn(),
  fetchInvoice: vi.fn(),
  findInvoiceByDocNumber: vi.fn(),
}));

const stripeProviderMocks = vi.hoisted(() => ({
  retrieveSubscription: vi.fn(),
  retrieveCheckoutSession: vi.fn(),
  retrievePrice: vi.fn(),
  retrieveCoupon: vi.fn(),
  createCustomer: vi.fn(),
  createCheckoutSession: vi.fn(),
}));

const transactionalEmailMocks = vi.hoisted(() => ({
  isConfigured: vi.fn(),
  sendPasswordReset: vi.fn(),
  sendPasswordChanged: vi.fn(),
}));

vi.mock("stripe", async () => {
  const actual = await vi.importActual<typeof import("stripe")>("stripe");
  class TestStripe extends actual.default {
    constructor(...args: ConstructorParameters<typeof actual.default>) {
      super(...args);
      this.subscriptions.retrieve = stripeProviderMocks.retrieveSubscription as typeof this.subscriptions.retrieve;
      this.checkout.sessions.retrieve = stripeProviderMocks.retrieveCheckoutSession as typeof this.checkout.sessions.retrieve;
      this.prices.retrieve = stripeProviderMocks.retrievePrice as typeof this.prices.retrieve;
      this.coupons.retrieve = stripeProviderMocks.retrieveCoupon as typeof this.coupons.retrieve;
      this.customers.create = stripeProviderMocks.createCustomer as typeof this.customers.create;
      this.checkout.sessions.create = stripeProviderMocks.createCheckoutSession as typeof this.checkout.sessions.create;
    }
  }
  return { ...actual, default: TestStripe };
});

vi.mock("../../src/services/quickbooks", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/quickbooks")>(
    "../../src/services/quickbooks",
  );
  return {
    ...actual,
    exchangeQuickBooksAuthorizationCode: quickBooksProviderMocks.exchangeAuthorizationCode,
    fetchQuickBooksCompanyInfo: quickBooksProviderMocks.fetchCompanyInfo,
    ensureQuickBooksAccessToken: quickBooksProviderMocks.ensureAccessToken,
    findQuickBooksCustomerByDisplayName: quickBooksProviderMocks.findCustomer,
    createQuickBooksCustomer: quickBooksProviderMocks.createCustomer,
    findQuickBooksItemByName: quickBooksProviderMocks.findItem,
    resolveQuickBooksIncomeAccount: quickBooksProviderMocks.resolveIncomeAccount,
    createQuickBooksServiceItem: quickBooksProviderMocks.createServiceItem,
    createQuickBooksInvoice: quickBooksProviderMocks.createInvoice,
    fetchQuickBooksInvoice: quickBooksProviderMocks.fetchInvoice,
    findQuickBooksInvoicesByDocNumber: quickBooksProviderMocks.findInvoiceByDocNumber,
  };
});

vi.mock("../../src/services/transactional-email", () => ({
  isTransactionalEmailConfigured: transactionalEmailMocks.isConfigured,
  sendPasswordResetEmail: transactionalEmailMocks.sendPasswordReset,
  sendPasswordChangedEmail: transactionalEmailMocks.sendPasswordChanged,
}));

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
      acceptedLegalTerms: true,
      termsVersion: "2026-07-30",
      privacyPolicyVersion: "2026-08-10",
    },
  });

  expect(response.statusCode).toBe(201);
  return {
    ...parseJson<Omit<AuthSession, "cookie">>(response),
    cookie: extractSessionCookie(response),
  };
}

function stripeSubscriptionFixture(input: {
  id: string;
  customerId: string;
  tenantId: string;
  status: Stripe.Subscription.Status;
  periodStart?: number;
  periodEnd?: number;
  trialStart?: number | null;
  trialEnd?: number | null;
}): Stripe.Subscription {
  const periodEnd = input.periodEnd ?? Math.floor(Date.now() / 1000) + 86_400;
  const periodStart = input.periodStart ?? periodEnd - 30 * 86_400;
  return {
    id: input.id,
    object: "subscription",
    customer: input.customerId,
    status: input.status,
    metadata: { tenantId: input.tenantId },
    trial_start: input.trialStart ?? null,
    trial_end: input.trialEnd ?? null,
    items: {
      data: [
        {
          id: `si_${input.id}`,
          object: "subscription_item",
          price: { id: process.env.STRIPE_PRICE_ID_STARTER! },
          current_period_start: periodStart,
          current_period_end: periodEnd,
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

async function injectSignedStripeEvent(event: Record<string, unknown>) {
  const eventPayload = JSON.stringify(event);
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-06-24.dahlia" });
  const stripeSignature = stripe.webhooks.generateTestHeaderString({
    payload: eventPayload,
    secret: process.env.STRIPE_WEBHOOK_SECRET!,
  });
  return app.inject({
    method: "POST",
    url: "/v1/billing/webhook",
    headers: { "content-type": "application/json", "stripe-signature": stripeSignature },
    payload: eventPayload,
  });
}

describe("QuoteFly API integration", () => {
  beforeEach(() => {
    stripeProviderMocks.retrieveSubscription.mockReset();
    stripeProviderMocks.retrieveCheckoutSession.mockReset();
    stripeProviderMocks.retrievePrice.mockReset().mockResolvedValue({
      id: process.env.STRIPE_PRICE_ID_STARTER,
      object: "price",
      active: true,
      currency: "usd",
      type: "recurring",
      unit_amount: 2900,
      recurring: { interval: "month", interval_count: 1 },
    } as Stripe.Price);
    stripeProviderMocks.retrieveCoupon.mockReset().mockResolvedValue({
      id: process.env.STRIPE_COUPON_ID_BASIC_FIRST_MONTH_HALF_OFF,
      object: "coupon",
      valid: true,
      duration: "once",
      percent_off: 50,
      amount_off: null,
    } as Stripe.Coupon);
    stripeProviderMocks.createCustomer.mockReset();
    stripeProviderMocks.createCheckoutSession.mockReset();
    transactionalEmailMocks.isConfigured.mockReset().mockReturnValue(true);
    transactionalEmailMocks.sendPasswordReset.mockReset().mockResolvedValue(undefined);
    transactionalEmailMocks.sendPasswordChanged.mockReset().mockResolvedValue(undefined);
  });

  beforeAll(async () => {
    await cleanDatabase();
    app = buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await cleanDatabase();
    await app.close();
  });

  test("rejects oversized auth passwords before bcrypt work", async () => {
    const oversizedPassword = "x".repeat(121);
    const signUpResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: {
        email: "oversized-signup@example.com",
        password: oversizedPassword,
        fullName: "Oversized Signup",
        companyName: "Oversized Password Test",
        primaryTrade: "ROOFING",
        generateLogoIfMissing: false,
      },
    });
    expect(signUpResponse.statusCode).toBe(400);

    const signInResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/signin",
      payload: { email: "missing@example.com", password: oversizedPassword },
    });
    expect(signInResponse.statusCode).toBe(400);
  });

  test("returns a stable unauthorized response for invalid credentials", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/signin",
      payload: {
        email: `missing-${Date.now()}@example.com`,
        password: "TestPassword123!",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid email or password." });
  });

  test("creates new workspaces with an exact 20-day internal trial", async () => {
    const beforeSignup = Date.now();
    const session = await signUp("twenty-day-trial");
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: session.tenant.id },
      select: { trialStartsAtUtc: true, trialEndsAtUtc: true, subscriptionStatus: true },
    });

    expect(tenant.subscriptionStatus).toBe("trialing");
    expect(tenant.trialStartsAtUtc).not.toBeNull();
    expect(tenant.trialEndsAtUtc).not.toBeNull();
    expect(tenant.trialStartsAtUtc!.getTime()).toBeGreaterThanOrEqual(beforeSignup);
    expect(tenant.trialEndsAtUtc!.getTime() - tenant.trialStartsAtUtc!.getTime()).toBe(
      20 * 24 * 60 * 60 * 1000,
    );
  });

  test("resets a password with a single-use token and revokes existing sessions", async () => {
    const account = await signUp("password-recovery");
    let resetUrl = "";
    transactionalEmailMocks.sendPasswordReset.mockImplementation(async (_runtimeEnv, input) => {
      resetUrl = (input as { resetUrl: string }).resetUrl;
    });

    const requestReset = await app.inject({
      method: "POST",
      url: "/v1/auth/forgot-password",
      payload: { email: account.user.email.toUpperCase() },
    });
    expect(requestReset.statusCode).toBe(202);
    expect(requestReset.json()).toEqual({
      message: "If an active QuoteFly account exists for that email, a password reset link is on its way.",
    });
    expect(transactionalEmailMocks.sendPasswordReset).toHaveBeenCalledTimes(1);

    const missingAccountReset = await app.inject({
      method: "POST",
      url: "/v1/auth/forgot-password",
      payload: { email: `missing-password-recovery-${Date.now()}@example.com` },
    });
    expect(missingAccountReset.statusCode).toBe(202);
    expect(missingAccountReset.json()).toEqual(requestReset.json());
    expect(transactionalEmailMocks.sendPasswordReset).toHaveBeenCalledTimes(1);

    const resetToken = new URLSearchParams(new URL(resetUrl).hash.replace(/^#/, "")).get("token");
    expect(resetToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    if (!resetToken) throw new Error("Expected password reset email to include a token.");

    const invalidReset = await app.inject({
      method: "POST",
      url: "/v1/auth/reset-password",
      payload: { token: "A".repeat(43), password: "UpdatedPassword456!" },
    });
    expect(invalidReset.statusCode).toBe(400);

    const reset = await app.inject({
      method: "POST",
      url: "/v1/auth/reset-password",
      payload: { token: resetToken, password: "UpdatedPassword456!" },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ message: "Password updated. You can now sign in." });
    expect(transactionalEmailMocks.sendPasswordChanged).toHaveBeenCalledWith(
      expect.anything(),
      account.user.email,
    );

    const reusedReset = await app.inject({
      method: "POST",
      url: "/v1/auth/reset-password",
      payload: { token: resetToken, password: "AnotherPassword789!" },
    });
    expect(reusedReset.statusCode).toBe(400);

    const priorSession = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: authHeaders(account.cookie),
    });
    expect(priorSession.statusCode).toBe(401);

    const priorPassword = await app.inject({
      method: "POST",
      url: "/v1/auth/signin",
      payload: { email: account.user.email, password: "TestPassword123!" },
    });
    expect(priorPassword.statusCode).toBe(401);

    const updatedPassword = await app.inject({
      method: "POST",
      url: "/v1/auth/signin",
      payload: { email: account.user.email, password: "UpdatedPassword456!" },
    });
    expect(updatedPassword.statusCode).toBe(200);
  });

  test("serializes concurrent password reset requests per account", async () => {
    const account = await signUp("password-recovery-race");
    let resetUrl = "";
    let releaseDelivery!: () => void;
    let deliveryStarted!: () => void;
    const deliveryGate = new Promise<void>((resolve) => { releaseDelivery = resolve; });
    const deliveryStartedGate = new Promise<void>((resolve) => { deliveryStarted = resolve; });

    transactionalEmailMocks.sendPasswordReset.mockImplementationOnce(async (_runtimeEnv, input) => {
      resetUrl = (input as { resetUrl: string }).resetUrl;
      deliveryStarted();
      await deliveryGate;
    });

    const firstRequest = app.inject({
      method: "POST",
      url: "/v1/auth/forgot-password",
      payload: { email: account.user.email },
    });
    await deliveryStartedGate;

    const secondRequest = await app.inject({
      method: "POST",
      url: "/v1/auth/forgot-password",
      payload: { email: account.user.email },
    });
    releaseDelivery();
    const firstResponse = await firstRequest;

    expect(firstResponse.statusCode).toBe(202);
    expect(secondRequest.statusCode).toBe(202);
    expect(transactionalEmailMocks.sendPasswordReset).toHaveBeenCalledTimes(1);

    const activeTokens = await prisma.passwordResetToken.findMany({
      where: { userId: account.user.id, usedAtUtc: null, expiresAtUtc: { gt: new Date() } },
      select: { id: true },
    });
    expect(activeTokens).toHaveLength(1);

    const resetToken = new URLSearchParams(new URL(resetUrl).hash.replace(/^#/, "")).get("token");
    expect(resetToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    if (!resetToken) throw new Error("Expected the delivered reset URL to contain a token.");

    const reset = await app.inject({
      method: "POST",
      url: "/v1/auth/reset-password",
      payload: { token: resetToken, password: "ConcurrentReset456!" },
    });
    expect(reset.statusCode).toBe(200);
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

  test("derives quote totals from included lines and replays concurrent create commands exactly once", async () => {
    const owner = await signUp("quote-create-idempotency");
    const customerResponse = await app.inject({
      method: "POST",
      url: "/v1/customers",
      headers: authHeaders(owner.cookie),
      payload: {
        fullName: "Idempotent Quote Customer",
        phone: "555-010-4411",
      },
    });
    expect(customerResponse.statusCode).toBe(201);
    const { customer } = parseJson<CustomerResponse>(customerResponse);
    const sourcePreset = await prisma.workPreset.findFirstOrThrow({
      where: {
        tenantId: owner.tenant.id,
        serviceType: "ROOFING",
        deletedAtUtc: null,
      },
      orderBy: [{ catalogKey: "asc" }, { id: "asc" }],
    });
    const idempotencyKey = "quote-create-concurrent-command-0001";
    const payload = {
      customerId: customer.id,
      serviceType: "ROOFING",
      title: "Server-derived quote totals",
      scopeText: "Use included work for quote totals and keep alternates outside the total.",
      internalCostSubtotal: 888,
      customerPriceSubtotal: 999,
      taxAmount: 0.67,
      lineItems: [
        {
          description: "Included fractional work",
          sectionType: "INCLUDED",
          quantity: 0.3333,
          unitCost: 4.006,
          unitPrice: 10.006,
          sourcePresetId: sourcePreset.id,
        },
        {
          description: "Optional premium upgrade",
          sectionType: "ALTERNATE",
          quantity: 2,
          unitCost: 400,
          unitPrice: 900,
        },
      ],
    };

    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/quotes",
        headers: { ...authHeaders(owner.cookie), "idempotency-key": idempotencyKey },
        payload,
      }),
      app.inject({
        method: "POST",
        url: "/v1/quotes",
        headers: { ...authHeaders(owner.cookie), "idempotency-key": idempotencyKey },
        payload,
      }),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 201]);
    const responseBodies = responses.map((response) => response.json() as {
      quote: Record<string, unknown> & { id: string };
      duplicate: boolean;
    });
    expect(new Set(responseBodies.map((body) => body.quote.id)).size).toBe(1);
    expect(responseBodies.map((body) => body.duplicate).sort()).toEqual([false, true]);
    for (const body of responseBodies) {
      expect(body.quote).not.toHaveProperty("createIdempotencyKeyHash");
      expect(body.quote).not.toHaveProperty("createRequestHash");
    }

    const quoteId = responseBodies[0]!.quote.id;
    const storedQuote = await prisma.quote.findUniqueOrThrow({
      where: { id: quoteId },
      include: { lineItems: { orderBy: { position: "asc" } }, revisions: true },
    });
    expect(Number(storedQuote.internalCostSubtotal)).toBe(1.32);
    expect(Number(storedQuote.customerPriceSubtotal)).toBe(3.3);
    expect(Number(storedQuote.taxAmount)).toBe(0.67);
    expect(Number(storedQuote.totalAmount)).toBe(3.97);
    expect(storedQuote.lineItems).toHaveLength(2);
    expect(storedQuote.lineItems.map((lineItem) => ({
      quantity: Number(lineItem.quantity),
      unitCost: Number(lineItem.unitCost),
      unitPrice: Number(lineItem.unitPrice),
      priceProvenance: lineItem.priceProvenance,
    }))).toEqual([
      { quantity: 0.33, unitCost: 4.01, unitPrice: 10.01, priceProvenance: "TENANT_PRESET" },
      { quantity: 2, unitCost: 400, unitPrice: 900, priceProvenance: "MANUAL" },
    ]);
    expect(storedQuote.lineItems[0]).toMatchObject({
      sourcePresetIdSnapshot: sourcePreset.id,
      sourcePresetNameSnapshot: sourcePreset.name,
      sourcePresetCatalogKeySnapshot: sourcePreset.catalogKey,
      sourcePresetCatalogVersionSnapshot: sourcePreset.catalogVersion,
    });
    expect(storedQuote.lineItems[0]?.sourcePresetUpdatedAtUtcSnapshot?.toISOString()).toBe(
      sourcePreset.updatedAt.toISOString(),
    );
    expect(storedQuote.revisions).toHaveLength(1);
    expect(storedQuote.revisions[0]?.eventType).toBe("CREATED");
    await expect(
      prisma.quote.count({
        where: { tenantId: owner.tenant.id, customerId: customer.id, title: payload.title },
      }),
    ).resolves.toBe(1);

    const mismatch = await app.inject({
      method: "POST",
      url: "/v1/quotes",
      headers: { ...authHeaders(owner.cookie), "idempotency-key": idempotencyKey },
      payload: { ...payload, title: "Different quote under reused key" },
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toEqual({
      code: "IDEMPOTENCY_KEY_REUSED",
      error: "This Idempotency-Key was already used with a different quote request.",
    });

    await expect(
      prisma.quote.update({
        where: { id: quoteId },
        data: { createRequestHash: null },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.quote.findUniqueOrThrow({
        where: { id: quoteId },
        select: { createIdempotencyKeyHash: true, createRequestHash: true },
      }),
    ).resolves.toMatchObject({
      createIdempotencyKeyHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      createRequestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  test("creates or reuses the reviewed customer atomically with an idempotent quote", async () => {
    const owner = await signUp("atomic-customer-quote");
    const baseQuote = {
      serviceType: "PLUMBING" as const,
      title: "Reviewed water heater inspection",
      scopeText: "Inspect the water heater, document damage, and complete approved repair work.",
      internalCostSubtotal: 80,
      customerPriceSubtotal: 320,
      taxAmount: 0,
      lineItems: [{
        description: "Water heater inspection and repair labor",
        quantity: 4,
        unitCost: 20,
        unitPrice: 80,
      }],
    };
    const customerDraft = {
      fullName: "Atomic Quote Customer",
      phone: "555-010-7788",
      email: "atomic.quote@example.com",
      notes: "Kody-prepared customer details reviewed by the user.",
    };
    const createPayload = { ...baseQuote, customerDraft };
    const idempotencyKey = "atomic-customer-quote-command-0001";

    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/quotes",
        headers: { ...authHeaders(owner.cookie), "idempotency-key": idempotencyKey },
        payload: createPayload,
      }),
      app.inject({
        method: "POST",
        url: "/v1/quotes",
        headers: { ...authHeaders(owner.cookie), "idempotency-key": idempotencyKey },
        payload: createPayload,
      }),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 201]);
    const responseBodies = responses.map((response) => response.json() as {
      quote: { id: string; customerId: string };
      duplicate: boolean;
      customerCreated?: boolean;
    });
    expect(new Set(responseBodies.map((body) => body.quote.id)).size).toBe(1);
    expect(new Set(responseBodies.map((body) => body.quote.customerId)).size).toBe(1);
    expect(responseBodies.find((body) => !body.duplicate)?.customerCreated).toBe(true);

    const createdCustomerId = responseBodies[0]!.quote.customerId;
    await expect(prisma.customer.count({
      where: { tenantId: owner.tenant.id, phone: "(555) 010-7788" },
    })).resolves.toBe(1);
    await expect(prisma.customerActivityEvent.count({
      where: { tenantId: owner.tenant.id, customerId: createdCustomerId },
    })).resolves.toBe(2);
    await expect(prisma.aiIndexJob.count({
      where: { tenantId: owner.tenant.id, sourceType: "Customer", sourceId: createdCustomerId },
    })).resolves.toBe(1);

    const invalidCustomerDraft = {
      fullName: "Rolled Back Quote Customer",
      phone: "555-010-7799",
      email: "rollback.quote@example.com",
    };
    const rejected = await app.inject({
      method: "POST",
      url: "/v1/quotes",
      headers: {
        ...authHeaders(owner.cookie),
        "idempotency-key": "atomic-customer-quote-command-rollback-0002",
      },
      payload: {
        ...baseQuote,
        customerDraft: invalidCustomerDraft,
        lineItems: [{
          ...baseQuote.lineItems[0],
          sourcePresetId: "missing-source-preset",
        }],
      },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toMatchObject({ code: "SOURCE_PRESET_INVALID" });
    await expect(prisma.customer.count({
      where: { tenantId: owner.tenant.id, email: invalidCustomerDraft.email },
    })).resolves.toBe(0);

    const duplicatePrompt = await app.inject({
      method: "POST",
      url: "/v1/quotes",
      headers: {
        ...authHeaders(owner.cookie),
        "idempotency-key": "atomic-customer-quote-command-duplicate-0003",
      },
      payload: { ...baseQuote, title: "Duplicate review required", customerDraft },
    });
    expect(duplicatePrompt.statusCode).toBe(409);
    const duplicateBody = duplicatePrompt.json() as {
      code: string;
      matches: Array<{ id: string; matchReasons: string[] }>;
    };
    expect(duplicateBody.code).toBe("DUPLICATE_CANDIDATE");
    expect(duplicateBody.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: createdCustomerId, matchReasons: expect.arrayContaining(["phone", "email"]) }),
    ]));

    const reused = await app.inject({
      method: "POST",
      url: "/v1/quotes",
      headers: {
        ...authHeaders(owner.cookie),
        "idempotency-key": "atomic-customer-quote-command-reuse-0004",
      },
      payload: {
        ...baseQuote,
        title: "Explicitly reused customer",
        customerDraft: {
          ...customerDraft,
          duplicateAction: "use_existing",
          duplicateCustomerId: createdCustomerId,
        },
      },
    });
    expect(reused.statusCode).toBe(201);
    expect(reused.json()).toMatchObject({
      quote: { customerId: createdCustomerId },
      customerCreated: false,
      customerReused: true,
    });

    await prisma.customer.update({
      where: { id_tenantId: { id: createdCustomerId, tenantId: owner.tenant.id } },
      data: { archivedAtUtc: new Date() },
    });
    const beforeRollback = await prisma.customer.findUniqueOrThrow({
      where: { id: createdCustomerId },
      select: {
        fullName: true,
        phone: true,
        phoneDigits: true,
        email: true,
        notes: true,
        archivedAtUtc: true,
        deletedAtUtc: true,
        assignedTenantUserId: true,
      },
    });
    const [activityCountBeforeRollback, indexCountBeforeRollback] = await Promise.all([
      prisma.customerActivityEvent.count({
        where: { tenantId: owner.tenant.id, customerId: createdCustomerId },
      }),
      prisma.aiIndexJob.count({
        where: { tenantId: owner.tenant.id, sourceType: "Customer", sourceId: createdCustomerId },
      }),
    ]);
    const rolledBackRestore = await app.inject({
      method: "POST",
      url: "/v1/quotes",
      headers: {
        ...authHeaders(owner.cookie),
        "idempotency-key": "atomic-customer-quote-command-restore-rollback-0005",
      },
      payload: {
        ...baseQuote,
        title: "Restored customer quote must roll back",
        customerDraft: {
          ...customerDraft,
          fullName: "Uncommitted restored customer name",
          notes: "This merge must disappear with the failed quote.",
          duplicateAction: "merge",
          duplicateCustomerId: createdCustomerId,
        },
        lineItems: [{
          ...baseQuote.lineItems[0],
          sourcePresetId: "missing-restore-source-preset",
        }],
      },
    });
    expect(rolledBackRestore.statusCode).toBe(422);
    expect(rolledBackRestore.json()).toMatchObject({ code: "SOURCE_PRESET_INVALID" });
    await expect(prisma.customer.findUniqueOrThrow({
      where: { id: createdCustomerId },
      select: {
        fullName: true,
        phone: true,
        phoneDigits: true,
        email: true,
        notes: true,
        archivedAtUtc: true,
        deletedAtUtc: true,
        assignedTenantUserId: true,
      },
    })).resolves.toEqual(beforeRollback);
    await expect(prisma.customerActivityEvent.count({
      where: { tenantId: owner.tenant.id, customerId: createdCustomerId },
    })).resolves.toBe(activityCountBeforeRollback);
    await expect(prisma.aiIndexJob.count({
      where: { tenantId: owner.tenant.id, sourceType: "Customer", sourceId: createdCustomerId },
    })).resolves.toBe(indexCountBeforeRollback);
    await expect(prisma.quote.count({
      where: { tenantId: owner.tenant.id, title: "Restored customer quote must roll back" },
    })).resolves.toBe(0);

    const restored = await app.inject({
      method: "POST",
      url: "/v1/quotes",
      headers: {
        ...authHeaders(owner.cookie),
        "idempotency-key": "atomic-customer-quote-command-restore-0005",
      },
      payload: {
        ...baseQuote,
        title: "Restored customer quote",
        customerDraft: {
          ...customerDraft,
          notes: "Restored through the reviewed quote command.",
          duplicateAction: "merge",
          duplicateCustomerId: createdCustomerId,
        },
      },
    });
    expect(restored.statusCode).toBe(201);
    expect(restored.json()).toMatchObject({
      quote: { customerId: createdCustomerId },
      customerMerged: true,
      customerRestored: true,
    });
    await expect(prisma.customer.findUniqueOrThrow({
      where: { id: createdCustomerId },
      select: { archivedAtUtc: true, deletedAtUtc: true, notes: true },
    })).resolves.toEqual({
      archivedAtUtc: null,
      deletedAtUtc: null,
      notes: "Restored through the reviewed quote command.",
    });
    await expect(prisma.customerActivityEvent.count({
      where: { tenantId: owner.tenant.id, customerId: createdCustomerId },
    })).resolves.toBe(activityCountBeforeRollback + 2);
    await expect(prisma.customerActivityEvent.findMany({
      where: { tenantId: owner.tenant.id, customerId: createdCustomerId },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: { eventType: true, detail: true },
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "RESTORED" }),
      expect.objectContaining({
        eventType: "NOTES_UPDATED",
        detail: "Restored through the reviewed quote command.",
      }),
    ]));
  });

  test("keeps customerDraft duplicate resolution inside tenant and member assignment boundaries", async () => {
    const owner = await signUp("atomic-customer-boundary-owner");
    const outsider = await signUp("atomic-customer-boundary-outsider");
    const createMember = async (label: string) => {
      const email = `${label.toLowerCase().replaceAll(" ", "-")}-${Date.now()}@example.com`;
      const password = "MemberPassword123!";
      const created = await app.inject({
        method: "POST",
        url: "/v1/org/users",
        headers: authHeaders(owner.cookie),
        payload: { email, fullName: label, password, role: "member" },
      });
      expect(created.statusCode).toBe(201);
      const signedIn = await app.inject({
        method: "POST",
        url: "/v1/auth/signin",
        payload: { email, password },
      });
      expect(signedIn.statusCode).toBe(200);
      const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
      const tenantUser = await prisma.tenantUser.findUniqueOrThrow({
        where: { tenantId_userId: { tenantId: owner.tenant.id, userId: user.id } },
        select: { id: true },
      });
      return { cookie: extractSessionCookie(signedIn), tenantUserId: tenantUser.id };
    };
    const memberA = await createMember("Atomic Assignment Member A");
    const memberB = await createMember("Atomic Assignment Member B");
    const baseQuote = {
      serviceType: "PLUMBING",
      title: "Assignment-safe atomic quote",
      scopeText: "Create a reviewed quote without exposing records outside the live assignment.",
      internalCostSubtotal: 25,
      customerPriceSubtotal: 100,
      taxAmount: 0,
      lineItems: [{ description: "Boundary-safe labor", quantity: 1, unitCost: 25, unitPrice: 100 }],
    };

    const hiddenAssignedCustomer = await prisma.customer.create({
      data: {
        tenantId: owner.tenant.id,
        fullName: "Member A Private Customer",
        phone: "(555) 010-7791",
        phoneDigits: "5550107791",
        email: "member-a-private@example.com",
        assignedTenantUserId: memberA.tenantUserId,
      },
    });
    const hiddenBefore = await prisma.customer.findUniqueOrThrow({ where: { id: hiddenAssignedCustomer.id } });

    const hiddenDuplicate = await app.inject({
      method: "POST",
      url: "/v1/quotes",
      headers: {
        ...authHeaders(memberB.cookie),
        "idempotency-key": "atomic-hidden-assignment-duplicate-0001",
      },
      payload: {
        ...baseQuote,
        customerDraft: {
          fullName: "Attempted hidden duplicate",
          phone: hiddenAssignedCustomer.phone,
          email: hiddenAssignedCustomer.email,
        },
      },
    });
    expect(hiddenDuplicate.statusCode).toBe(409);
    expect(hiddenDuplicate.json()).toEqual({
      code: "PHONE_CONFLICT",
      error: "This phone number is already in use. Search for the existing customer and try again.",
    });
    expect(hiddenDuplicate.body).not.toContain(hiddenAssignedCustomer.id);
    expect(hiddenDuplicate.body).not.toContain(hiddenAssignedCustomer.fullName);
    expect(hiddenDuplicate.body).not.toContain(hiddenAssignedCustomer.email!);

    const hiddenSelection = await app.inject({
      method: "POST",
      url: "/v1/quotes",
      headers: {
        ...authHeaders(memberB.cookie),
        "idempotency-key": "atomic-hidden-assignment-selection-0002",
      },
      payload: {
        ...baseQuote,
        title: "Hidden assignment selection rejected",
        customerDraft: {
          fullName: "Attempted hidden selection",
          phone: hiddenAssignedCustomer.phone,
          email: hiddenAssignedCustomer.email,
          duplicateAction: "merge",
          duplicateCustomerId: hiddenAssignedCustomer.id,
        },
      },
    });
    expect(hiddenSelection.statusCode).toBe(409);
    expect(hiddenSelection.json()).toEqual({
      code: "STALE_DUPLICATE_TARGET",
      error: "The selected customer changed and no longer matches. Review the latest results.",
      matches: [],
    });
    await expect(prisma.customer.findUniqueOrThrow({ where: { id: hiddenAssignedCustomer.id } })).resolves.toEqual(hiddenBefore);

    const outsiderCustomerResponse = await app.inject({
      method: "POST",
      url: "/v1/customers",
      headers: authHeaders(outsider.cookie),
      payload: {
        fullName: "Other Tenant Private Customer",
        phone: "555-010-7792",
        email: "other-tenant-private@example.com",
        notes: "Must not be visible or mutable outside this tenant.",
      },
    });
    expect(outsiderCustomerResponse.statusCode).toBe(201);
    const outsiderCustomer = parseJson<CustomerResponse>(outsiderCustomerResponse).customer;
    const outsiderBefore = await prisma.customer.findUniqueOrThrow({ where: { id: outsiderCustomer.id } });

    const localCreate = await app.inject({
      method: "POST",
      url: "/v1/quotes",
      headers: {
        ...authHeaders(memberB.cookie),
        "idempotency-key": "atomic-cross-tenant-local-create-0003",
      },
      payload: {
        ...baseQuote,
        title: "Same contact remains tenant local",
        customerDraft: {
          fullName: "Member B Local Customer",
          phone: outsiderCustomer.phone,
          email: outsiderCustomer.email,
        },
      },
    });
    expect(localCreate.statusCode).toBe(201);
    const localBody = localCreate.json() as { quote: { id: string; customerId: string } };
    expect(localBody.quote.customerId).not.toBe(outsiderCustomer.id);
    expect(localCreate.body).not.toContain(outsiderCustomer.id);
    const [localCustomer, localQuote] = await Promise.all([
      prisma.customer.findUniqueOrThrow({ where: { id: localBody.quote.customerId } }),
      prisma.quote.findUniqueOrThrow({ where: { id: localBody.quote.id } }),
    ]);
    expect(localCustomer).toMatchObject({
      tenantId: owner.tenant.id,
      assignedTenantUserId: memberB.tenantUserId,
      phone: outsiderCustomer.phone,
      email: outsiderCustomer.email,
    });
    expect(localQuote).toMatchObject({
      tenantId: owner.tenant.id,
      customerId: localCustomer.id,
      assignedTenantUserId: memberB.tenantUserId,
    });

    const foreignSelection = await app.inject({
      method: "POST",
      url: "/v1/quotes",
      headers: {
        ...authHeaders(memberB.cookie),
        "idempotency-key": "atomic-cross-tenant-selection-0004",
      },
      payload: {
        ...baseQuote,
        title: "Cross-tenant duplicate selection rejected",
        customerDraft: {
          fullName: "Cross-tenant selection attempt",
          phone: outsiderCustomer.phone,
          email: outsiderCustomer.email,
          duplicateAction: "merge",
          duplicateCustomerId: outsiderCustomer.id,
        },
      },
    });
    expect(foreignSelection.statusCode).toBe(409);
    const foreignSelectionBody = foreignSelection.json() as {
      code: string;
      matches: Array<{ id: string; fullName: string; email: string | null }>;
    };
    expect(foreignSelectionBody.code).toBe("STALE_DUPLICATE_TARGET");
    expect(foreignSelectionBody.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: localCustomer.id, fullName: localCustomer.fullName }),
    ]));
    expect(foreignSelection.body).not.toContain(outsiderCustomer.id);
    expect(foreignSelection.body).not.toContain(outsiderCustomer.fullName);
    await expect(prisma.customer.findUniqueOrThrow({ where: { id: outsiderCustomer.id } })).resolves.toEqual(outsiderBefore);
  });

  test("returns refreshed matches when a reviewed duplicate changes while merge waits on its row lock", async () => {
    const owner = await signUp("atomic-customer-stale-lock");
    const customerResponse = await app.inject({
      method: "POST",
      url: "/v1/customers",
      headers: authHeaders(owner.cookie),
      payload: {
        fullName: "Initially Matching Customer",
        phone: "555-010-7793",
        email: "initial-match@example.com",
      },
    });
    expect(customerResponse.statusCode).toBe(201);
    const customer = parseJson<CustomerResponse>(customerResponse).customer;

    let releaseRowLock!: () => void;
    let rowLockReady!: () => void;
    const rowLockHeld = new Promise<void>((resolve) => { rowLockReady = resolve; });
    const releaseRowLockPromise = new Promise<void>((resolve) => { releaseRowLock = resolve; });
    const lockingTransaction = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT customer.id
        FROM "Customer" customer
        WHERE customer.id = ${customer.id}
        FOR UPDATE OF customer
      `;
      await transaction.customer.update({
        where: { id: customer.id },
        data: {
          phone: "(555) 010-7794",
          phoneDigits: "5550107794",
          email: "changed-after-review@example.com",
        },
      });
      rowLockReady();
      await releaseRowLockPromise;
    });
    await rowLockHeld;

    const pendingMerge = app.inject({
      method: "POST",
      url: "/v1/quotes",
      headers: {
        ...authHeaders(owner.cookie),
        "idempotency-key": "atomic-stale-row-lock-0001",
      },
      payload: {
        serviceType: "PLUMBING",
        title: "Stale reviewed merge",
        scopeText: "The selected customer changes after review and before the merge lock is acquired.",
        internalCostSubtotal: 20,
        customerPriceSubtotal: 80,
        taxAmount: 0,
        customerDraft: {
          fullName: "Reviewed Customer Name",
          phone: customer.phone,
          email: customer.email,
          duplicateAction: "merge",
          duplicateCustomerId: customer.id,
        },
        lineItems: [{ description: "Lock-safe work", quantity: 1, unitCost: 20, unitPrice: 80 }],
      },
    });

    let observedBlockedMerge = false;
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [blocked] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT EXISTS (
            SELECT 1
            FROM pg_stat_activity
            WHERE pid <> pg_backend_pid()
              AND datname = current_database()
              AND "wait_event_type" = 'Lock'
              AND query ILIKE '%FOR UPDATE OF customer%'
          ) AS blocked
        `;
        if (blocked?.blocked) {
          observedBlockedMerge = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      releaseRowLock();
    }
    expect(observedBlockedMerge).toBe(true);
    await lockingTransaction;
    const response = await pendingMerge;
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: "STALE_DUPLICATE_TARGET",
      error: "The selected customer changed and no longer matches. Review the latest results.",
      matches: [],
    });
    await expect(prisma.quote.count({
      where: { tenantId: owner.tenant.id, title: "Stale reviewed merge" },
    })).resolves.toBe(0);
    await expect(prisma.customer.findUniqueOrThrow({
      where: { id: customer.id },
      select: { phone: true, email: true },
    })).resolves.toEqual({
      phone: "(555) 010-7794",
      email: "changed-after-review@example.com",
    });
  });

  test("signup copies immutable catalog definitions into independent tenant-owned products", async () => {
    const definitions = getStandardWorkPresetCatalog(ServiceCategory.ROOFING);
    const alpha = await signUp("starter-copy-alpha");
    const beta = await signUp("starter-copy-beta");

    const [alphaProducts, betaProducts] = await Promise.all([
      prisma.workPreset.findMany({
        where: { tenantId: alpha.tenant.id, serviceType: "ROOFING", catalogKey: { not: null } },
      }),
      prisma.workPreset.findMany({
        where: { tenantId: beta.tenant.id, serviceType: "ROOFING", catalogKey: { not: null } },
      }),
    ]);
    expect(alphaProducts).toHaveLength(definitions.length);
    expect(betaProducts).toHaveLength(definitions.length);
    const betaProductIds = new Set(betaProducts.map((product) => product.id));
    expect(alphaProducts.every((product) => !betaProductIds.has(product.id))).toBe(true);

    for (const definition of definitions) {
      const product = alphaProducts.find((candidate) => candidate.catalogKey === definition.catalogKey);
      expect(product).toMatchObject({
        catalogVersion: definition.catalogVersion,
        catalogCustomizedAtUtc: null,
        deletedAtUtc: null,
      });
      expect(product?.catalogContentHash).toBe(standardWorkPresetContentHash(ServiceCategory.ROOFING, definition));
    }

    const alphaDiagnostic = alphaProducts.find((product) => product.catalogKey === "roof_leak_diagnostic")!;
    const betaDiagnostic = betaProducts.find((product) => product.catalogKey === "roof_leak_diagnostic")!;
    const update = await app.inject({
      method: "PATCH",
      url: `/v1/products/${alphaDiagnostic.id}`,
      headers: authHeaders(alpha.cookie),
      payload: { unitPrice: 432.1 },
    });
    expect(update.statusCode).toBe(200);
    expect(parseJson<{ product: Record<string, unknown> }>(update).product).not.toHaveProperty("catalogContentHash");

    const gamma = await signUp("starter-copy-gamma");
    const [storedAlpha, storedBeta, storedGamma] = await Promise.all([
      prisma.workPreset.findUniqueOrThrow({ where: { id: alphaDiagnostic.id } }),
      prisma.workPreset.findUniqueOrThrow({ where: { id: betaDiagnostic.id } }),
      prisma.workPreset.findFirstOrThrow({
        where: { tenantId: gamma.tenant.id, serviceType: "ROOFING", catalogKey: "roof_leak_diagnostic" },
      }),
    ]);
    const sourceDefinition = definitions.find((definition) => definition.catalogKey === "roof_leak_diagnostic")!;
    expect(Number(storedAlpha.unitPrice)).toBe(432.1);
    expect(storedAlpha.catalogCustomizedAtUtc).toBeInstanceOf(Date);
    expect(Number(storedBeta.unitPrice)).toBe(sourceDefinition.unitPrice);
    expect(storedBeta.catalogCustomizedAtUtc).toBeNull();
    expect(Number(storedGamma.unitPrice)).toBe(sourceDefinition.unitPrice);
    expect(storedGamma.catalogCustomizedAtUtc).toBeNull();

    const restoreDefaults = await app.inject({
      method: "PATCH",
      url: `/v1/products/${alphaDiagnostic.id}`,
      headers: authHeaders(alpha.cookie),
      payload: {
        description: sourceDefinition.description,
        defaultQuantity: sourceDefinition.defaultQuantity,
        unitCost: sourceDefinition.unitCost,
        unitPrice: sourceDefinition.unitPrice,
        isDefault: sourceDefinition.isDefault ?? true,
      },
    });
    expect(restoreDefaults.statusCode).toBe(200);
    expect(parseJson<{ product: { catalogCustomizedAtUtc: string | null } }>(restoreDefaults).product.catalogCustomizedAtUtc)
      .toBeNull();
  });

  test("manages products with tenant isolation and soft archive semantics", async () => {
    const alpha = await signUp("product-alpha");
    const beta = await signUp("product-beta");

    const unauthenticatedProducts = await app.inject({
      method: "GET",
      url: "/v1/products",
    });
    expect(unauthenticatedProducts.statusCode).toBe(401);

    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/products",
      headers: authHeaders(alpha.cookie),
      payload: {
        serviceType: "ROOFING",
        name: "Seasonal gutter tune-up",
        description: "Clear debris, flush downspouts, and confirm drainage.",
        category: "SERVICE",
        unitType: "FLAT",
        defaultQuantity: 1,
        unitCost: 85,
        unitPrice: 225,
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const createdProduct = parseJson<{
      product: { id: string; tenantId: string; name: string; unitPrice: number | string };
    }>(createResponse).product;
    expect(createdProduct.tenantId).toBe(alpha.tenant.id);
    expect(Number(createdProduct.unitPrice)).toBe(225);

    const duplicateResponse = await app.inject({
      method: "POST",
      url: "/v1/products",
      headers: authHeaders(alpha.cookie),
      payload: {
        serviceType: "ROOFING",
        name: "seasonal gutter tune-up",
        category: "SERVICE",
        unitType: "FLAT",
        defaultQuantity: 1,
        unitCost: 90,
        unitPrice: 240,
      },
    });
    expect(duplicateResponse.statusCode).toBe(409);

    const alphaProducts = await app.inject({
      method: "GET",
      url: "/v1/products?serviceType=ROOFING",
      headers: authHeaders(alpha.cookie),
    });
    expect(alphaProducts.statusCode).toBe(200);
    expect(
      parseJson<{ products: Array<{ id: string }> }>(alphaProducts).products.some(
        (product) => product.id === createdProduct.id,
      ),
    ).toBe(true);

    const betaProducts = await app.inject({
      method: "GET",
      url: "/v1/products?serviceType=ROOFING",
      headers: authHeaders(beta.cookie),
    });
    expect(betaProducts.statusCode).toBe(200);
    expect(
      parseJson<{ products: Array<{ id: string }> }>(betaProducts).products.some(
        (product) => product.id === createdProduct.id,
      ),
    ).toBe(false);

    const betaCannotUpdate = await app.inject({
      method: "PATCH",
      url: `/v1/products/${createdProduct.id}`,
      headers: authHeaders(beta.cookie),
      payload: { unitPrice: 1 },
    });
    expect(betaCannotUpdate.statusCode).toBe(404);

    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/v1/products/${createdProduct.id}`,
      headers: authHeaders(alpha.cookie),
      payload: {
        name: "Seasonal gutter service",
        unitCost: 95,
        unitPrice: 250,
      },
    });
    expect(updateResponse.statusCode).toBe(200);
    const updatedProduct = parseJson<{
      product: { name: string; unitCost: number | string; unitPrice: number | string };
    }>(updateResponse).product;
    expect(updatedProduct.name).toBe("Seasonal gutter service");
    expect(Number(updatedProduct.unitCost)).toBe(95);
    expect(Number(updatedProduct.unitPrice)).toBe(250);

    const betaCannotArchive = await app.inject({
      method: "DELETE",
      url: `/v1/products/${createdProduct.id}`,
      headers: authHeaders(beta.cookie),
    });
    expect(betaCannotArchive.statusCode).toBe(404);

    const archiveResponse = await app.inject({
      method: "DELETE",
      url: `/v1/products/${createdProduct.id}`,
      headers: authHeaders(alpha.cookie),
    });
    expect(archiveResponse.statusCode).toBe(200);

    const archivedProduct = await prisma.workPreset.findFirst({
      where: { id: createdProduct.id, tenantId: alpha.tenant.id },
      select: { deletedAtUtc: true },
    });
    expect(archivedProduct?.deletedAtUtc).toBeInstanceOf(Date);

    const alphaProductsAfterArchive = await app.inject({
      method: "GET",
      url: "/v1/products?serviceType=ROOFING",
      headers: authHeaders(alpha.cookie),
    });
    expect(
      parseJson<{ products: Array<{ id: string }> }>(alphaProductsAfterArchive).products.some(
        (product) => product.id === createdProduct.id,
      ),
    ).toBe(false);

    const standardProduct = await prisma.workPreset.findFirstOrThrow({
      where: {
        tenantId: alpha.tenant.id,
        catalogKey: { not: null },
        deletedAtUtc: null,
      },
      select: { id: true },
    });
    const standardArchiveResponse = await app.inject({
      method: "DELETE",
      url: `/v1/products/${standardProduct.id}`,
      headers: authHeaders(alpha.cookie),
    });
    expect(standardArchiveResponse.statusCode).toBe(400);
    expect(parseJson<{ code: string }>(standardArchiveResponse).code).toBe(
      "STANDARD_PRODUCT_ARCHIVE_FORBIDDEN",
    );
    await expect(
      prisma.workPreset.findFirstOrThrow({
        where: { id: standardProduct.id, tenantId: alpha.tenant.id },
        select: { deletedAtUtc: true },
      }),
    ).resolves.toEqual({ deletedAtUtc: null });
  });

  test("adds missing starter products idempotently without resetting tenant copies", async () => {
    const session = await signUp("starter-catalog");
    const selection = ["drywall_install_finish", "permit_allowance"];

    const firstImport = await app.inject({
      method: "POST",
      url: "/v1/products/starter-catalog/add-missing",
      headers: authHeaders(session.cookie),
      payload: { serviceType: "CONSTRUCTION", catalogKeys: selection },
    });
    expect(firstImport.statusCode).toBe(200);
    const firstBody = parseJson<{
      createdCount: number;
      skippedCount: number;
    }>(firstImport);
    expect(firstBody.createdCount).toBe(2);
    expect(firstBody.skippedCount).toBe(0);
    const importedProducts = await prisma.workPreset.findMany({
      where: {
        tenantId: session.tenant.id,
        serviceType: "CONSTRUCTION",
        catalogKey: { in: selection },
      },
      select: {
        id: true,
        catalogKey: true,
        catalogVersion: true,
        catalogContentHash: true,
        catalogCustomizedAtUtc: true,
      },
    });
    expect(importedProducts.map((product) => product.catalogKey).sort()).toEqual(selection.sort());
    expect(importedProducts.every((product) => product.catalogVersion === 1)).toBe(true);
    expect(importedProducts.every((product) => /^[a-f0-9]{64}$/.test(product.catalogContentHash ?? ""))).toBe(true);
    expect(importedProducts.every((product) => product.catalogCustomizedAtUtc === null)).toBe(true);

    const drywall = importedProducts.find((product) => product.catalogKey === "drywall_install_finish")!;
    const customize = await app.inject({
      method: "PATCH",
      url: `/v1/products/${drywall.id}`,
      headers: authHeaders(session.cookie),
      payload: { description: "Tenant-specific level-five finish.", unitPrice: 4.75 },
    });
    expect(customize.statusCode).toBe(200);
    expect(parseJson<{ product: { catalogCustomizedAtUtc: string | null } }>(customize).product.catalogCustomizedAtUtc)
      .not.toBeNull();

    const secondImport = await app.inject({
      method: "POST",
      url: "/v1/products/starter-catalog/add-missing",
      headers: authHeaders(session.cookie),
      payload: { serviceType: "CONSTRUCTION", catalogKeys: selection },
    });
    expect(secondImport.statusCode).toBe(200);
    expect(parseJson<{ createdCount: number; skippedCount: number }>(secondImport)).toMatchObject({
      createdCount: 0,
      skippedCount: 2,
    });
    await expect(prisma.workPreset.findUniqueOrThrow({ where: { id: drywall.id } })).resolves.toMatchObject({
      description: "Tenant-specific level-five finish.",
      deletedAtUtc: null,
    });
    const storedDrywall = await prisma.workPreset.findUniqueOrThrow({ where: { id: drywall.id } });
    expect(Number(storedDrywall.unitPrice)).toBe(4.75);

    await prisma.workPreset.update({
      where: { id: drywall.id },
      data: { deletedAtUtc: new Date() },
    });
    const archivedImport = await app.inject({
      method: "POST",
      url: "/v1/products/starter-catalog/add-missing",
      headers: authHeaders(session.cookie),
      payload: { serviceType: "CONSTRUCTION", catalogKeys: ["drywall_install_finish"] },
    });
    expect(archivedImport.statusCode).toBe(200);
    expect(parseJson<{ createdCount: number; skippedCount: number }>(archivedImport)).toMatchObject({
      createdCount: 0,
      skippedCount: 1,
    });
    await expect(prisma.workPreset.findUniqueOrThrow({ where: { id: drywall.id }, select: { deletedAtUtc: true } }))
      .resolves.toMatchObject({ deletedAtUtc: expect.any(Date) });

    const invalidImport = await app.inject({
      method: "POST",
      url: "/v1/products/starter-catalog/add-missing",
      headers: authHeaders(session.cookie),
      payload: { serviceType: "CONSTRUCTION", catalogKeys: ["not_a_real_template"] },
    });
    expect(invalidImport.statusCode).toBe(400);
    expect(parseJson<{ code: string }>(invalidImport).code).toBe("STARTER_CATALOG_INVALID_SELECTION");

    const concurrentImports = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/products/starter-catalog/add-missing",
        headers: authHeaders(session.cookie),
        payload: { serviceType: "CONSTRUCTION", catalogKeys: ["rough_carpentry_labor"] },
      }),
      app.inject({
        method: "POST",
        url: "/v1/products/starter-catalog/add-missing",
        headers: authHeaders(session.cookie),
        payload: { serviceType: "CONSTRUCTION", catalogKeys: ["rough_carpentry_labor"] },
      }),
    ]);
    expect(concurrentImports.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(concurrentImports
      .map((response) => parseJson<{ createdCount: number }>(response).createdCount)
      .sort()).toEqual([0, 1]);
    await expect(prisma.workPreset.count({
      where: {
        tenantId: session.tenant.id,
        serviceType: "CONSTRUCTION",
        catalogKey: "rough_carpentry_labor",
      },
    })).resolves.toBe(1);
  });

  test("active and archived tenant products reserve normalized starter names without catalog mutation", async () => {
    const session = await signUp("starter-name-reservation");
    const archivedAtUtc = new Date("2026-08-20T12:00:00.000Z");
    const [activeCustom, archivedCustom] = await Promise.all([
      prisma.workPreset.create({
        data: {
          tenantId: session.tenant.id,
          serviceType: "CONSTRUCTION",
          catalogKey: null,
          name: "  GENERAL   labor ",
          category: "LABOR",
          unitType: "HOUR",
          defaultQuantity: 1,
          unitCost: 77,
          unitPrice: 155,
          isDefault: true,
        },
      }),
      prisma.workPreset.create({
        data: {
          tenantId: session.tenant.id,
          serviceType: "CONSTRUCTION",
          catalogKey: null,
          name: "site PREP",
          category: "SERVICE",
          unitType: "FLAT",
          defaultQuantity: 1,
          unitCost: 210,
          unitPrice: 475,
          isDefault: true,
          deletedAtUtc: archivedAtUtc,
        },
      }),
    ]);

    const imports = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/products/starter-catalog/add-missing",
        headers: authHeaders(session.cookie),
        payload: {
          serviceType: "CONSTRUCTION",
          catalogKeys: ["general_labor", "site_prep"],
        },
      }),
      app.inject({
        method: "POST",
        url: "/v1/products/starter-catalog/add-missing",
        headers: authHeaders(session.cookie),
        payload: {
          serviceType: "CONSTRUCTION",
          catalogKeys: ["general_labor", "site_prep"],
        },
      }),
    ]);
    expect(imports.map((response) => response.statusCode)).toEqual([200, 200]);
    for (const response of imports) {
      expect(parseJson<{ createdCount: number; skippedCount: number }>(response)).toMatchObject({
        createdCount: 0,
        skippedCount: 2,
      });
    }

    const [storedActive, storedArchived, managedDuplicates] = await Promise.all([
      prisma.workPreset.findUniqueOrThrow({ where: { id: activeCustom.id } }),
      prisma.workPreset.findUniqueOrThrow({ where: { id: archivedCustom.id } }),
      prisma.workPreset.count({
        where: {
          tenantId: session.tenant.id,
          serviceType: "CONSTRUCTION",
          catalogKey: { in: ["general_labor", "site_prep"] },
        },
      }),
    ]);
    expect(storedActive).toMatchObject({ catalogKey: null, deletedAtUtc: null });
    expect(Number(storedActive.unitCost)).toBe(77);
    expect(storedArchived.catalogKey).toBeNull();
    expect(storedArchived.deletedAtUtc?.toISOString()).toBe(archivedAtUtc.toISOString());
    expect(Number(storedArchived.unitPrice)).toBe(475);
    expect(managedDuplicates).toBe(0);
  });

  test("product create and rename reject active starter names case-insensitively", async () => {
    const session = await signUp("starter-name-owner");
    const starter = await prisma.workPreset.findFirstOrThrow({
      where: {
        tenantId: session.tenant.id,
        serviceType: "ROOFING",
        catalogKey: { not: null },
        deletedAtUtc: null,
      },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    });
    const collidingCreate = await app.inject({
      method: "POST",
      url: "/v1/products",
      headers: authHeaders(session.cookie),
      payload: {
        serviceType: "ROOFING",
        name: starter.name.toUpperCase().replaceAll(" ", "   "),
        category: "SERVICE",
        unitType: "FLAT",
        defaultQuantity: 1,
        unitCost: 10,
        unitPrice: 20,
        isDefault: true,
      },
    });
    expect(collidingCreate.statusCode).toBe(409);
    expect(parseJson<{ code: string; productId: string }>(collidingCreate)).toMatchObject({
      code: "PRODUCT_NAME_CONFLICT",
      productId: starter.id,
    });

    const customCreate = await app.inject({
      method: "POST",
      url: "/v1/products",
      headers: authHeaders(session.cookie),
      payload: {
        serviceType: "ROOFING",
        name: "Temporary rename target",
        category: "SERVICE",
        unitType: "FLAT",
        defaultQuantity: 1,
        unitCost: 10,
        unitPrice: 20,
        isDefault: true,
      },
    });
    expect(customCreate.statusCode).toBe(201);
    const customId = parseJson<{ product: { id: string } }>(customCreate).product.id;
    const collidingRename = await app.inject({
      method: "PATCH",
      url: `/v1/products/${customId}`,
      headers: authHeaders(session.cookie),
      payload: { name: starter.name.toLowerCase().replaceAll(" ", "   ") },
    });
    expect(collidingRename.statusCode).toBe(409);
    expect(parseJson<{ code: string; productId: string }>(collidingRename)).toMatchObject({
      code: "PRODUCT_NAME_CONFLICT",
      productId: starter.id,
    });
    await expect(prisma.workPreset.findUniqueOrThrow({ where: { id: customId }, select: { name: true } }))
      .resolves.toEqual({ name: "Temporary rename target" });
  });

  test("starter catalog import preserves the 200 active-product limit", async () => {
    const session = await signUp("starter-capacity");
    const activeCount = await prisma.workPreset.count({
      where: { tenantId: session.tenant.id, deletedAtUtc: null },
    });
    await prisma.workPreset.createMany({
      data: Array.from({ length: 199 - activeCount }, (_, index) => ({
        tenantId: session.tenant.id,
        serviceType: "ROOFING" as const,
        category: "SERVICE" as const,
        unitType: "FLAT" as const,
        name: `Starter capacity filler ${index}`,
        defaultQuantity: 1,
        unitCost: 1,
        unitPrice: 2,
        isDefault: true,
      })),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/products/starter-catalog/add-missing",
      headers: authHeaders(session.cookie),
      payload: {
        serviceType: "CONSTRUCTION",
        catalogKeys: ["drywall_install_finish", "permit_allowance"],
      },
    });
    expect(response.statusCode).toBe(409);
    expect(parseJson<{ code: string; activeProductCount: number }>(response)).toMatchObject({
      code: "PRODUCT_CATALOG_LIMIT",
      activeProductCount: 199,
    });
    await expect(prisma.workPreset.count({ where: { tenantId: session.tenant.id, deletedAtUtc: null } }))
      .resolves.toBe(199);
  });

  test("database rejects a QuickBooks item map linked to another tenant's product", async () => {
    const alpha = await signUp("quickbooks-preset-alpha");
    const beta = await signUp("quickbooks-preset-beta");
    const alphaProduct = await prisma.workPreset.findFirstOrThrow({
      where: { tenantId: alpha.tenant.id, catalogKey: { not: null }, deletedAtUtc: null },
      select: { id: true },
    });
    const betaConnection = await prisma.quickBooksConnection.create({
      data: {
        tenantId: beta.tenant.id,
        realmId: `starter-catalog-${Date.now()}`,
        environment: "sandbox",
      },
    });

    await expect(prisma.quickBooksItemMap.create({
      data: {
        tenantId: beta.tenant.id,
        quickBooksConnectionId: betaConnection.id,
        itemKey: "cross-tenant-starter-product",
        quickBooksItemId: "qb-item-cross-tenant",
        quickBooksItemName: "Cross tenant starter product",
        workPresetId: alphaProduct.id,
      },
    })).rejects.toMatchObject({ code: "P2003" });
  });

  test("database rejects a QuickBooks item map linked to another tenant's connection", async () => {
    const alpha = await signUp("quickbooks-connection-alpha");
    const beta = await signUp("quickbooks-connection-beta");
    const alphaConnection = await prisma.quickBooksConnection.create({
      data: {
        tenantId: alpha.tenant.id,
        realmId: `starter-connection-${Date.now()}`,
        environment: "sandbox",
      },
    });

    await expect(prisma.quickBooksItemMap.create({
      data: {
        tenantId: beta.tenant.id,
        quickBooksConnectionId: alphaConnection.id,
        itemKey: "cross-tenant-quickbooks-connection",
        quickBooksItemId: "qb-item-cross-tenant-connection",
        quickBooksItemName: "Cross tenant QuickBooks connection",
      },
    })).rejects.toMatchObject({ code: "P2003" });
  });

  test("blocks product mutations when workspace billing access is unavailable", async () => {
    const session = await signUp("product-billing-lock");
    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/products",
      headers: authHeaders(session.cookie),
      payload: {
        serviceType: "ROOFING",
        name: "Billing lock fixture",
        category: "SERVICE",
        unitType: "FLAT",
        defaultQuantity: 1,
        unitCost: 40,
        unitPrice: 100,
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const productId = parseJson<{ product: { id: string } }>(createResponse).product.id;

    await prisma.tenant.update({
      where: { id: session.tenant.id },
      data: {
        subscriptionStatus: "inactive",
        subscriptionPlanCode: null,
        subscriptionCurrentPeriodEndUtc: null,
        trialStartsAtUtc: null,
        trialEndsAtUtc: null,
      },
    });

    const productBefore = await prisma.workPreset.findFirstOrThrow({
      where: { id: productId, tenantId: session.tenant.id },
      select: { name: true, unitPrice: true, deletedAtUtc: true },
    });
    const productCountBefore = await prisma.workPreset.count({
      where: { tenantId: session.tenant.id, deletedAtUtc: null },
    });

    const blockedCreate = await app.inject({
      method: "POST",
      url: "/v1/products",
      headers: authHeaders(session.cookie),
      payload: {
        serviceType: "ROOFING",
        name: "Blocked billing product",
        category: "SERVICE",
        unitType: "FLAT",
        defaultQuantity: 1,
        unitCost: 1,
        unitPrice: 2,
      },
    });
    const blockedUpdate = await app.inject({
      method: "PATCH",
      url: `/v1/products/${productId}`,
      headers: authHeaders(session.cookie),
      payload: { unitPrice: 1 },
    });
    const blockedArchive = await app.inject({
      method: "DELETE",
      url: `/v1/products/${productId}`,
      headers: authHeaders(session.cookie),
    });

    for (const response of [blockedCreate, blockedUpdate, blockedArchive]) {
      expect(response.statusCode).toBe(402);
      expect(parseJson<{ code: string }>(response).code).toBe("BILLING_REQUIRED");
    }

    await expect(
      prisma.workPreset.count({ where: { tenantId: session.tenant.id, deletedAtUtc: null } }),
    ).resolves.toBe(productCountBefore);
    await expect(
      prisma.workPreset.findFirstOrThrow({
        where: { id: productId, tenantId: session.tenant.id },
        select: { name: true, unitPrice: true, deletedAtUtc: true },
      }),
    ).resolves.toEqual(productBefore);
  });

  test("serializes concurrent product name and catalog-limit decisions", async () => {
    const session = await signUp("product-concurrency");
    const duplicatePayload = {
      serviceType: "ROOFING",
      name: "Concurrent roof tune-up",
      category: "SERVICE",
      unitType: "FLAT",
      defaultQuantity: 1,
      unitCost: 50,
      unitPrice: 125,
    };

    const duplicateResponses = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/products",
        headers: authHeaders(session.cookie),
        payload: duplicatePayload,
      }),
      app.inject({
        method: "POST",
        url: "/v1/products",
        headers: authHeaders(session.cookie),
        payload: duplicatePayload,
      }),
    ]);
    expect(duplicateResponses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    await expect(
      prisma.workPreset.count({
        where: {
          tenantId: session.tenant.id,
          serviceType: "ROOFING",
          deletedAtUtc: null,
          name: { equals: duplicatePayload.name, mode: "insensitive" },
        },
      }),
    ).resolves.toBe(1);

    const currentProductCount = await prisma.workPreset.count({
      where: { tenantId: session.tenant.id, deletedAtUtc: null },
    });
    const fillerCount = Math.max(0, 199 - currentProductCount);
    if (fillerCount > 0) {
      await prisma.workPreset.createMany({
        data: Array.from({ length: fillerCount }, (_, index) => ({
          tenantId: session.tenant.id,
          serviceType: "ROOFING",
          category: "SERVICE",
          unitType: "FLAT",
          name: `Catalog limit filler ${index}`,
          defaultQuantity: 1,
          unitCost: 1,
          unitPrice: 2,
          isDefault: true,
        })),
      });
    }

    const limitResponses = await Promise.all(
      ["Catalog limit final A", "Catalog limit final B"].map((name) =>
        app.inject({
          method: "POST",
          url: "/v1/products",
          headers: authHeaders(session.cookie),
          payload: { ...duplicatePayload, name },
        }),
      ),
    );
    expect(limitResponses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    await expect(
      prisma.workPreset.count({ where: { tenantId: session.tenant.id, deletedAtUtc: null } }),
    ).resolves.toBe(200);

    const productsToRestore = await prisma.workPreset.findMany({
      where: {
        tenantId: session.tenant.id,
        catalogKey: null,
        deletedAtUtc: null,
      },
      orderBy: { createdAt: "asc" },
      take: 2,
    });
    expect(productsToRestore).toHaveLength(2);
    await prisma.workPreset.updateMany({
      where: {
        tenantId: session.tenant.id,
        id: { in: productsToRestore.map((product) => product.id) },
      },
      data: { deletedAtUtc: new Date() },
    });

    const refillResponse = await app.inject({
      method: "POST",
      url: "/v1/products",
      headers: authHeaders(session.cookie),
      payload: { ...duplicatePayload, name: "Restoration capacity filler" },
    });
    expect(refillResponse.statusCode).toBe(201);

    const restoreResponses = await Promise.all(
      productsToRestore.map((product) =>
        app.inject({
          method: "POST",
          url: "/v1/products",
          headers: authHeaders(session.cookie),
          payload: {
            serviceType: product.serviceType,
            name: product.name,
            description: product.description,
            category: product.category,
            unitType: product.unitType,
            defaultQuantity: Number(product.defaultQuantity),
            unitCost: Number(product.unitCost),
            unitPrice: Number(product.unitPrice),
            isDefault: product.isDefault,
          },
        }),
      ),
    );
    expect(restoreResponses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    await expect(
      prisma.workPreset.count({ where: { tenantId: session.tenant.id, deletedAtUtc: null } }),
    ).resolves.toBe(200);
    await expect(
      prisma.workPreset.count({
        where: {
          tenantId: session.tenant.id,
          id: { in: productsToRestore.map((product) => product.id) },
          deletedAtUtc: null,
        },
      }),
    ).resolves.toBe(1);
  });

  test("rolls back atomic quote-sheet saves at every later write stage", async () => {
    const alpha = await signUp("atomic-sheet-alpha");
    const beta = await signUp("atomic-sheet-beta");

    const createCustomer = async (session: AuthSession, label: string) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/customers",
        headers: authHeaders(session.cookie),
        payload: {
          fullName: `${label} Customer`,
          phone: `555-019-${label === "Alpha" ? "4100" : "4200"}`,
          email: `${label.toLowerCase()}-atomic-sheet@example.com`,
        },
      });
      expect(response.statusCode).toBe(201);
      return parseJson<CustomerResponse>(response).customer;
    };

    const createQuote = async (session: AuthSession, customerId: string, title: string) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/quotes",
        headers: authHeaders(session.cookie),
        payload: {
          customerId,
          serviceType: "ROOFING",
          title,
          scopeText: "Original atomic quote scope.",
          internalCostSubtotal: 130,
          customerPriceSubtotal: 300,
          taxAmount: 20,
          lineItems: [
            { description: "Original line one", quantity: 1, unitCost: 50, unitPrice: 120 },
            { description: "Original line two", quantity: 1, unitCost: 80, unitPrice: 180 },
          ],
        },
      });
      expect(response.statusCode).toBe(201);
      return parseJson<QuoteResponse>(response).quote;
    };

    const alphaCustomer = await createCustomer(alpha, "Alpha");
    const betaCustomer = await createCustomer(beta, "Beta");
    const alphaQuote = await createQuote(alpha, alphaCustomer.id, "Atomic Sheet Original");
    const betaQuote = await createQuote(beta, betaCustomer.id, "Foreign Tenant Quote");
    const alphaLines = await prisma.quoteLineItem.findMany({
      where: { tenantId: alpha.tenant.id, quoteId: alphaQuote.id, deletedAtUtc: null },
      orderBy: { createdAt: "asc" },
    });
    const betaLine = await prisma.quoteLineItem.findFirstOrThrow({
      where: { tenantId: beta.tenant.id, quoteId: betaQuote.id, deletedAtUtc: null },
    });
    const baselineRevisionCount = await prisma.quoteRevision.count({
      where: { tenantId: alpha.tenant.id, quoteId: alphaQuote.id },
    });

    const quotePayload = (title: string) => ({
      serviceType: "ROOFING",
      status: "READY_FOR_REVIEW",
      jobStatus: "NOT_STARTED",
      afterSaleFollowUpStatus: "NOT_READY",
      title,
      scopeText: `${title} scope`,
      taxAmount: 45,
    });
    const linePayload = (id: string, description: string) => ({
      id,
      description,
      sectionType: "INCLUDED",
      sectionLabel: null,
      quantity: 2,
      unitCost: 60,
      unitPrice: 150,
    });
    const assertBaseline = async () => {
      const stored = await prisma.quote.findFirstOrThrow({
        where: { id: alphaQuote.id, tenantId: alpha.tenant.id },
        include: { lineItems: { where: { tenantId: alpha.tenant.id, deletedAtUtc: null }, orderBy: { createdAt: "asc" } } },
      });
      expect(stored.title).toBe("Atomic Sheet Original");
      expect(stored.scopeText).toBe("Original atomic quote scope.");
      expect(Number(stored.taxAmount)).toBe(20);
      expect(stored.lineItems.map((line) => line.description)).toEqual([
        "Original line one",
        "Original line two",
      ]);
      await expect(
        prisma.quoteRevision.count({ where: { tenantId: alpha.tenant.id, quoteId: alphaQuote.id } }),
      ).resolves.toBe(baselineRevisionCount);
      await expect(
        prisma.quoteOutboundEvent.count({ where: { tenantId: alpha.tenant.id, quoteId: alphaQuote.id } }),
      ).resolves.toBe(0);
    };

    const afterMetadataFailure = await app.inject({
      method: "PATCH",
      url: `/v1/quotes/${alphaQuote.id}/sheet`,
      headers: authHeaders(alpha.cookie),
      payload: {
        quote: quotePayload("Must Roll Back After Metadata"),
        lineItems: [linePayload(betaLine.id, "Cross-tenant first line")],
        newLineItems: [],
      },
    });
    expect(afterMetadataFailure.statusCode).toBe(404);
    await assertBaseline();

    const betweenExistingLinesFailure = await app.inject({
      method: "PATCH",
      url: `/v1/quotes/${alphaQuote.id}/sheet`,
      headers: authHeaders(alpha.cookie),
      payload: {
        quote: quotePayload("Must Roll Back Between Lines"),
        lineItems: [
          linePayload(alphaLines[0]!.id, "First line must roll back"),
          linePayload(betaLine.id, "Foreign second line"),
        ],
        newLineItems: [],
      },
    });
    expect(betweenExistingLinesFailure.statusCode).toBe(404);
    await assertBaseline();

    const newLineInsertionFailure = await app.inject({
      method: "PATCH",
      url: `/v1/quotes/${alphaQuote.id}/sheet`,
      headers: authHeaders(alpha.cookie),
      payload: {
        quote: quotePayload("Must Roll Back New Line Insert"),
        lineItems: [linePayload(alphaLines[0]!.id, "Existing line before failed insert")],
        newLineItems: [
          {
            description: "Valid new line in rejected batch",
            sectionType: "INCLUDED",
            sectionLabel: null,
            quantity: 1,
            unitCost: 10,
            unitPrice: 20,
          },
          {
            description: "Database decimal overflow forces insertion failure",
            sectionType: "INCLUDED",
            sectionLabel: null,
            quantity: 1,
            unitCost: 10,
            unitPrice: 100_000_000,
          },
        ],
      },
    });
    expect(newLineInsertionFailure.statusCode).toBe(500);
    await assertBaseline();

    const foreignLineAfterFailures = await prisma.quoteLineItem.findUniqueOrThrow({
      where: { id: betaLine.id },
    });
    expect(foreignLineAfterFailures.description).toBe(betaLine.description);
  });

  test("confirms a customer send atomically and deduplicates retries", async () => {
    const session = await signUp("confirm-send");
    const logoData = await readFile("web/public/favicon.png");
    const logoUrl = `data:image/png;base64,${logoData.toString("base64")}`;
    await prisma.tenantBranding.upsert({
      where: { tenantId: session.tenant.id },
      create: {
        tenantId: session.tenant.id,
        primaryColor: "#1D4ED8",
        businessEmail: "original-brand@example.com",
        hideQuoteFlyAttribution: true,
        logoUrl,
      },
      update: {
        primaryColor: "#1D4ED8",
        businessEmail: "original-brand@example.com",
        hideQuoteFlyAttribution: true,
        logoUrl,
      },
    });
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

    const sentRevision = await prisma.quoteRevision.findFirstOrThrow({
      where: {
        tenantId: session.tenant.id,
        quoteId: quote.id,
        status: "SENT_TO_CUSTOMER",
        changedFields: { has: "documentSnapshot" },
      },
      select: { id: true, snapshot: true },
    });
    const sentSnapshot = sentRevision.snapshot as {
      document?: {
        branding?: {
          primaryColor?: string;
          businessEmail?: string | null;
          showQuoteFlyAttribution?: boolean;
          logoUrl?: string | null;
          logoAsset?: { id: string; sha256: string };
        };
      };
    };
    expect(sentSnapshot.document?.branding).toMatchObject({
      primaryColor: "#1D4ED8",
      businessEmail: "original-brand@example.com",
      showQuoteFlyAttribution: false,
    });
    expect(sentSnapshot.document?.branding?.logoUrl).toBeUndefined();
    expect(sentSnapshot.document?.branding?.logoAsset).toMatchObject({
      id: expect.any(String),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    const returnToDraft = await app.inject({
      method: "PATCH",
      url: `/v1/quotes/${quote.id}`,
      headers: authHeaders(session.cookie),
      payload: { status: "DRAFT" },
    });
    expect(returnToDraft.statusCode).toBe(200);

    const secondConfirmation = await app.inject({
      method: "POST",
      url: `/v1/quotes/${quote.id}/confirm-send`,
      headers: authHeaders(session.cookie),
      payload: {
        ...payload,
        idempotencyKey: `${idempotencyKey}-second`,
      },
    });
    expect(secondConfirmation.statusCode).toBe(200);

    const sentRevisions = await prisma.quoteRevision.findMany({
      where: {
        tenantId: session.tenant.id,
        quoteId: quote.id,
        status: "SENT_TO_CUSTOMER",
        changedFields: { has: "documentSnapshot" },
      },
      orderBy: { version: "asc" },
      select: { snapshot: true },
    });
    expect(sentRevisions).toHaveLength(2);
    const sentLogoReferences = sentRevisions.map((revision) => {
      const snapshot = revision.snapshot as {
        document?: { branding?: { logoUrl?: string | null; logoAsset?: { id: string; sha256: string } } };
      };
      expect(snapshot.document?.branding?.logoUrl).toBeUndefined();
      return snapshot.document?.branding?.logoAsset;
    });
    expect(sentLogoReferences[0]).toEqual(sentLogoReferences[1]);
    await expect(
      prisma.tenantBrandAsset.count({ where: { tenantId: session.tenant.id } }),
    ).resolves.toBe(1);

    const [workspaceHistoryResponse, quoteHistoryResponse] = await Promise.all([
      app.inject({
        method: "GET",
        url: `/v1/quotes/history?quoteId=${quote.id}`,
        headers: authHeaders(session.cookie),
      }),
      app.inject({
        method: "GET",
        url: `/v1/quotes/${quote.id}/history`,
        headers: authHeaders(session.cookie),
      }),
    ]);
    expect(workspaceHistoryResponse.statusCode).toBe(200);
    expect(quoteHistoryResponse.statusCode).toBe(200);
    for (const response of [workspaceHistoryResponse, quoteHistoryResponse]) {
      const history = parseJson<{ revisions: Array<Record<string, unknown>> }>(response);
      expect(history.revisions.length).toBeGreaterThan(0);
      for (const revision of history.revisions) {
        expect(revision).not.toHaveProperty("snapshot");
      }
    }

    const originalPdfResponse = await app.inject({
      method: "GET",
      url: `/v1/quotes/${quote.id}/pdf?download=false`,
      headers: authHeaders(session.cookie),
    });
    expect(originalPdfResponse.statusCode).toBe(200);

    await prisma.tenantBranding.update({
      where: { tenantId: session.tenant.id },
      data: {
        primaryColor: "#B91C1C",
        businessEmail: "replacement-brand@example.com",
        logoUrl: null,
      },
    });

    const pdfResponse = await app.inject({
      method: "GET",
      url: `/v1/quotes/${quote.id}/pdf?download=false`,
      headers: authHeaders(session.cookie),
    });
    expect(pdfResponse.statusCode).toBe(200);
    expect(pdfResponse.headers["content-type"]).toContain("application/pdf");
    expect(pdfResponse.rawPayload).toEqual(originalPdfResponse.rawPayload);

    const preservedRevision = await prisma.quoteRevision.findUniqueOrThrow({
      where: { id: sentRevision.id },
      select: { snapshot: true },
    });
    expect(preservedRevision.snapshot).toEqual(sentRevision.snapshot);
  });

  test("verifies and deduplicates Stripe billing webhooks", async () => {
    const session = await signUp("billing");
    await prisma.tenant.update({
      where: { id: session.tenant.id },
      data: {
        stripeCheckoutSessionId: "cs_test_expired",
        stripeCheckoutSessionExpiresAtUtc: new Date(Date.now() + 60_000),
      },
    });
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
      apiVersion: "2026-06-24.dahlia",
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
      select: {
        subscriptionStatus: true,
        stripeCheckoutSessionId: true,
        stripeCheckoutSessionExpiresAtUtc: true,
      },
    });
    expect(tenantAfterWebhook).toMatchObject({
      subscriptionStatus: "trialing",
      stripeCheckoutSessionId: null,
      stripeCheckoutSessionExpiresAtUtc: null,
    });

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

    const storedWebhook = await prisma.billingWebhookEvent.findUniqueOrThrow({
      where: { stripeEventId: "evt_quotefly_integration_checkout_expired" },
      select: { status: true, attemptCount: true, succeededAtUtc: true, failedAtUtc: true, payload: true },
    });
    expect(storedWebhook).toMatchObject({ status: "SUCCEEDED", attemptCount: 1, failedAtUtc: null });
    expect(storedWebhook.succeededAtUtc).not.toBeNull();
    expect(storedWebhook.payload).toEqual({
      version: 1,
      eventId: "evt_quotefly_integration_checkout_expired",
      eventType: "checkout.session.expired",
      objectId: "cs_test_expired",
      objectType: "checkout.session",
      tenantHintId: session.tenant.id,
    });

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

  test("does not let a stale checkout expiration overwrite a newer subscription", async () => {
    const session = await signUp("billing-stale-expiration");
    await prisma.tenant.update({
      where: { id: session.tenant.id },
      data: {
        stripeCustomerId: `cus_stale_${Date.now()}`,
        stripeSubscriptionId: `sub_current_${Date.now()}`,
        subscriptionStatus: "active",
        subscriptionPlanCode: "starter",
        subscriptionCurrentPeriodEndUtc: new Date(Date.now() + 86_400_000),
        stripeCheckoutSessionId: `cs_test_newer_${Date.now()}`,
        stripeCheckoutSessionExpiresAtUtc: new Date(Date.now() + 60_000),
      },
    });

    const eventPayload = JSON.stringify({
      id: `evt_stale_expired_${Date.now()}`,
      type: "checkout.session.expired",
      created: Math.floor(Date.now() / 1000) - 3600,
      data: {
        object: {
          id: "cs_test_old",
          object: "checkout.session",
          client_reference_id: session.tenant.id,
          metadata: { tenantId: session.tenant.id },
        },
      },
    });
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-06-24.dahlia" });
    const signature = stripe.webhooks.generateTestHeaderString({
      payload: eventPayload,
      secret: process.env.STRIPE_WEBHOOK_SECRET!,
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/billing/webhook",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload: eventPayload,
    });
    expect(response.statusCode).toBe(200);

    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: session.tenant.id },
      select: { subscriptionStatus: true, stripeSubscriptionId: true, stripeCheckoutSessionId: true },
    });
    expect(tenant.subscriptionStatus).toBe("active");
    expect(tenant.stripeSubscriptionId).toMatch(/^sub_current_/);
    expect(tenant.stripeCheckoutSessionId).toMatch(/^cs_test_newer_/);
  });

  test("keeps the newest canonical Stripe subscription state across reverse-order events", async () => {
    const session = await signUp("billing-event-order");
    const customerId = `cus_order_${Date.now()}`;
    const currentSubscriptionId = `sub_current_${Date.now()}`;
    const oldSubscriptionId = `sub_old_${Date.now()}`;
    const newestCreated = Math.floor(Date.now() / 1000);
    const currentSubscription = stripeSubscriptionFixture({
      id: currentSubscriptionId,
      customerId,
      tenantId: session.tenant.id,
      status: "active",
    });
    const oldSubscription = stripeSubscriptionFixture({
      id: oldSubscriptionId,
      customerId,
      tenantId: session.tenant.id,
      status: "canceled",
    });
    stripeProviderMocks.retrieveSubscription.mockImplementation(async (subscriptionId: string) => {
      return subscriptionId === currentSubscriptionId ? currentSubscription : oldSubscription;
    });
    await prisma.tenant.update({
      where: { id: session.tenant.id },
      data: {
        stripeCustomerId: customerId,
        stripeSubscriptionId: oldSubscriptionId,
        subscriptionStatus: "canceled",
        subscriptionPlanCode: "starter",
        subscriptionCurrentPeriodEndUtc: null,
        billingStateEventCreatedAtUtc: null,
        billingStateEventId: null,
      },
    });

    const activeResponse = await injectSignedStripeEvent({
      id: `evt_new_active_${Date.now()}`,
      type: "customer.subscription.updated",
      created: newestCreated,
      data: { object: currentSubscription },
    });
    expect(activeResponse.statusCode).toBe(200);

    const failedInvoiceResponse = await injectSignedStripeEvent({
      id: `evt_old_payment_failed_${Date.now()}`,
      type: "invoice.payment_failed",
      created: newestCreated - 10,
      data: {
        object: {
          id: `in_old_${Date.now()}`,
          object: "invoice",
          customer: customerId,
          parent: {
            type: "subscription_details",
            subscription_details: { subscription: oldSubscriptionId, metadata: null },
          },
        },
      },
    });
    expect(failedInvoiceResponse.statusCode).toBe(200);

    const sameSecondCanceledResponse = await injectSignedStripeEvent({
      // Stripe event IDs are opaque. A different subscription emitted in the
      // same second must not replace the already-canonical subscription.
      id: `evt_zz_same_second_old_canceled_${Date.now()}`,
      type: "customer.subscription.deleted",
      created: newestCreated,
      data: { object: oldSubscription },
    });
    expect(sameSecondCanceledResponse.statusCode).toBe(200);

    const laterCanceledResponse = await injectSignedStripeEvent({
      // A later cancellation for an old subscription must not replace the
      // tenant's already-canonical active subscription.
      id: `evt_later_old_canceled_${Date.now()}`,
      type: "customer.subscription.deleted",
      created: newestCreated + 10,
      data: { object: oldSubscription },
    });
    expect(laterCanceledResponse.statusCode).toBe(200);

    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: session.tenant.id },
      select: {
        stripeSubscriptionId: true,
        subscriptionStatus: true,
        subscriptionCurrentPeriodEndUtc: true,
        billingStateEventCreatedAtUtc: true,
      },
    });
    expect(tenant.stripeSubscriptionId).toBe(currentSubscriptionId);
    expect(tenant.subscriptionStatus).toBe("active");
    expect(tenant.subscriptionCurrentPeriodEndUtc).not.toBeNull();
    expect(tenant.billingStateEventCreatedAtUtc?.getTime()).toBe(newestCreated * 1000);
  });

  test("reserves a concurrent Stripe webhook only once", async () => {
    const session = await signUp("billing-concurrent-webhook");
    const checkoutSessionId = `cs_concurrent_${Date.now()}`;
    const stripeEventId = `evt_concurrent_${Date.now()}`;
    await prisma.tenant.update({
      where: { id: session.tenant.id },
      data: {
        stripeCheckoutSessionId: checkoutSessionId,
        stripeCheckoutSessionExpiresAtUtc: new Date(Date.now() + 60_000),
      },
    });
    const eventPayload = JSON.stringify({
      id: stripeEventId,
      type: "checkout.session.expired",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: checkoutSessionId,
          object: "checkout.session",
          client_reference_id: session.tenant.id,
          metadata: { tenantId: session.tenant.id },
        },
      },
    });
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-06-24.dahlia" });
    const signature = stripe.webhooks.generateTestHeaderString({
      payload: eventPayload,
      secret: process.env.STRIPE_WEBHOOK_SECRET!,
    });
    const request = () =>
      app.inject({
        method: "POST",
        url: "/v1/billing/webhook",
        headers: { "content-type": "application/json", "stripe-signature": signature },
        payload: eventPayload,
      });
    const responses = await Promise.all([request(), request()]);
    expect(responses.every((response) => response.statusCode === 200 || response.statusCode === 503)).toBe(true);
    expect(responses.some((response) => response.statusCode === 200)).toBe(true);
    await expect(prisma.billingWebhookEvent.count({ where: { stripeEventId } })).resolves.toBe(1);
    const event = await prisma.billingWebhookEvent.findUniqueOrThrow({ where: { stripeEventId } });
    expect(event.status).toBe("SUCCEEDED");
    expect(event.attemptCount).toBe(1);
  });

  test("retries a failed Stripe webhook reservation without duplicating its inbox row", async () => {
    const session = await signUp("billing-webhook-retry");
    const checkoutSessionId = `cs_retry_${Date.now()}`;
    const stripeEventId = `evt_retry_${Date.now()}`;
    await prisma.tenant.update({
      where: { id: session.tenant.id },
      data: {
        stripeCheckoutSessionId: checkoutSessionId,
        stripeCheckoutSessionExpiresAtUtc: new Date(Date.now() + 60_000),
      },
    });
    await prisma.billingWebhookEvent.create({
      data: {
        stripeEventId,
        eventType: "checkout.session.expired",
        payload: {},
        status: "FAILED",
        attemptCount: 1,
        lastAttemptAtUtc: new Date(Date.now() - 60_000),
        failedAtUtc: new Date(Date.now() - 60_000),
        lastError: "Error",
      },
    });
    const eventPayload = JSON.stringify({
      id: stripeEventId,
      type: "checkout.session.expired",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: checkoutSessionId,
          object: "checkout.session",
          client_reference_id: session.tenant.id,
          metadata: { tenantId: session.tenant.id },
        },
      },
    });
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-06-24.dahlia" });
    const signature = stripe.webhooks.generateTestHeaderString({
      payload: eventPayload,
      secret: process.env.STRIPE_WEBHOOK_SECRET!,
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/billing/webhook",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload: eventPayload,
    });
    expect(response.statusCode).toBe(200);

    const stored = await prisma.billingWebhookEvent.findUniqueOrThrow({ where: { stripeEventId } });
    expect(stored.status).toBe("SUCCEEDED");
    expect(stored.attemptCount).toBe(2);
    expect(stored.failedAtUtc).toBeNull();
    expect(stored.lastError).toBeNull();
  });

  test("does not let an expired webhook worker complete a reclaimed attempt", async () => {
    const session = await signUp("billing-webhook-stale-completion");
    const customerId = `cus_stale_completion_${Date.now()}`;
    const subscriptionId = `sub_stale_completion_${Date.now()}`;
    const stripeEventId = `evt_stale_completion_${Date.now()}`;
    const checkoutSessionId = `cs_stale_completion_${Date.now()}`;
    await prisma.tenant.update({
      where: { id: session.tenant.id },
      data: {
        subscriptionStatus: "inactive",
        subscriptionPlanCode: null,
        trialStartsAtUtc: null,
        trialEndsAtUtc: null,
        subscriptionCurrentPeriodEndUtc: null,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        stripeCheckoutSessionId: checkoutSessionId,
        stripeCheckoutSessionExpiresAtUtc: new Date(Date.now() + 60_000),
        billingStateEventCreatedAtUtc: null,
        billingStateEventId: null,
      },
    });
    const subscription = stripeSubscriptionFixture({
      id: subscriptionId,
      customerId,
      tenantId: session.tenant.id,
      status: "active",
    });
    const event = {
      id: stripeEventId,
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: checkoutSessionId,
          object: "checkout.session",
          customer: customerId,
          subscription: subscriptionId,
          client_reference_id: session.tenant.id,
          metadata: { tenantId: session.tenant.id },
        },
      },
    };

    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let retrieveCalls = 0;
    stripeProviderMocks.retrieveSubscription.mockImplementation(async () => {
      retrieveCalls += 1;
      if (retrieveCalls === 1) {
        markFirstStarted();
        await firstGate;
        return subscription;
      }
      throw new Error("Reclaimed worker failed before applying the event.");
    });

    const firstResponsePromise = injectSignedStripeEvent(event);
    await firstStarted;
    const firstLease = await prisma.billingWebhookEvent.findUniqueOrThrow({
      where: { stripeEventId },
      select: { processingLeaseToken: true },
    });
    expect(firstLease.processingLeaseToken).not.toBeNull();
    await prisma.billingWebhookEvent.update({
      where: { stripeEventId },
      data: { lastAttemptAtUtc: new Date(Date.now() - 6 * 60 * 1000) },
    });

    const reclaimedResponse = await injectSignedStripeEvent(event);
    const reclaimedFailure = await prisma.billingWebhookEvent.findUniqueOrThrow({
      where: { stripeEventId },
      select: {
        status: true,
        attemptCount: true,
        processingLeaseToken: true,
        succeededAtUtc: true,
        failedAtUtc: true,
        lastError: true,
      },
    });
    const tenantBeforeStaleResume = await prisma.tenant.findUniqueOrThrow({
      where: { id: session.tenant.id },
      select: {
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        subscriptionStatus: true,
        subscriptionPlanCode: true,
        subscriptionCurrentPeriodEndUtc: true,
        billingStateEventCreatedAtUtc: true,
        billingStateEventId: true,
        stripeCheckoutSessionId: true,
        stripeCheckoutSessionExpiresAtUtc: true,
      },
    });

    releaseFirst();
    const staleResponse = await firstResponsePromise;
    const finalEvent = await prisma.billingWebhookEvent.findUniqueOrThrow({
      where: { stripeEventId },
      select: {
        status: true,
        attemptCount: true,
        processingLeaseToken: true,
        succeededAtUtc: true,
        failedAtUtc: true,
        lastError: true,
      },
    });
    const tenantAfterStaleResume = await prisma.tenant.findUniqueOrThrow({
      where: { id: session.tenant.id },
      select: {
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        subscriptionStatus: true,
        subscriptionPlanCode: true,
        subscriptionCurrentPeriodEndUtc: true,
        billingStateEventCreatedAtUtc: true,
        billingStateEventId: true,
        stripeCheckoutSessionId: true,
        stripeCheckoutSessionExpiresAtUtc: true,
      },
    });

    expect(reclaimedResponse.statusCode).toBe(500);
    expect(reclaimedFailure.status).toBe("FAILED");
    expect(reclaimedFailure.attemptCount).toBe(2);
    expect(reclaimedFailure.processingLeaseToken).not.toBe(firstLease.processingLeaseToken);
    expect(reclaimedFailure.succeededAtUtc).toBeNull();
    expect(reclaimedFailure.failedAtUtc).not.toBeNull();
    expect(tenantBeforeStaleResume).toMatchObject({
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      subscriptionStatus: "inactive",
      subscriptionPlanCode: null,
      subscriptionCurrentPeriodEndUtc: null,
      billingStateEventCreatedAtUtc: null,
      billingStateEventId: null,
      stripeCheckoutSessionId: checkoutSessionId,
    });
    expect(staleResponse.statusCode).toBe(503);
    expect(finalEvent).toEqual(reclaimedFailure);
    expect(tenantAfterStaleResume).toEqual(tenantBeforeStaleResume);
  });

  test("does not let an expired webhook worker fail a reclaimed attempt", async () => {
    const session = await signUp("billing-webhook-stale-failure");
    const customerId = `cus_stale_failure_${Date.now()}`;
    const subscriptionId = `sub_stale_failure_${Date.now()}`;
    const stripeEventId = `evt_stale_failure_${Date.now()}`;
    const checkoutSessionId = `cs_stale_failure_${Date.now()}`;
    await prisma.tenant.update({
      where: { id: session.tenant.id },
      data: {
        subscriptionStatus: "inactive",
        subscriptionPlanCode: null,
        trialStartsAtUtc: null,
        trialEndsAtUtc: null,
        subscriptionCurrentPeriodEndUtc: null,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        stripeCheckoutSessionId: checkoutSessionId,
        stripeCheckoutSessionExpiresAtUtc: new Date(Date.now() + 60_000),
        billingStateEventCreatedAtUtc: null,
        billingStateEventId: null,
      },
    });
    const subscription = stripeSubscriptionFixture({
      id: subscriptionId,
      customerId,
      tenantId: session.tenant.id,
      status: "active",
    });
    const event = {
      id: stripeEventId,
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: checkoutSessionId,
          object: "checkout.session",
          customer: customerId,
          subscription: subscriptionId,
          client_reference_id: session.tenant.id,
          metadata: { tenantId: session.tenant.id },
        },
      },
    };

    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let retrieveCalls = 0;
    stripeProviderMocks.retrieveSubscription.mockImplementation(async () => {
      retrieveCalls += 1;
      if (retrieveCalls === 1) {
        markFirstStarted();
        await firstGate;
        throw new Error("Expired original worker failed late.");
      }
      return subscription;
    });

    const firstResponsePromise = injectSignedStripeEvent(event);
    await firstStarted;
    const firstLease = await prisma.billingWebhookEvent.findUniqueOrThrow({
      where: { stripeEventId },
      select: { processingLeaseToken: true },
    });
    expect(firstLease.processingLeaseToken).not.toBeNull();
    await prisma.billingWebhookEvent.update({
      where: { stripeEventId },
      data: { lastAttemptAtUtc: new Date(Date.now() - 6 * 60 * 1000) },
    });

    const reclaimedResponse = await injectSignedStripeEvent(event);
    const reclaimedSuccess = await prisma.billingWebhookEvent.findUniqueOrThrow({
      where: { stripeEventId },
      select: {
        status: true,
        attemptCount: true,
        processingLeaseToken: true,
        succeededAtUtc: true,
        failedAtUtc: true,
        lastError: true,
      },
    });
    const tenantBeforeStaleResume = await prisma.tenant.findUniqueOrThrow({
      where: { id: session.tenant.id },
      select: {
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        subscriptionStatus: true,
        subscriptionPlanCode: true,
        subscriptionCurrentPeriodEndUtc: true,
        billingStateEventCreatedAtUtc: true,
        billingStateEventId: true,
        stripeCheckoutSessionId: true,
        stripeCheckoutSessionExpiresAtUtc: true,
      },
    });

    releaseFirst();
    const staleResponse = await firstResponsePromise;
    const finalEvent = await prisma.billingWebhookEvent.findUniqueOrThrow({
      where: { stripeEventId },
      select: {
        status: true,
        attemptCount: true,
        processingLeaseToken: true,
        succeededAtUtc: true,
        failedAtUtc: true,
        lastError: true,
      },
    });
    const tenantAfterStaleResume = await prisma.tenant.findUniqueOrThrow({
      where: { id: session.tenant.id },
      select: {
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        subscriptionStatus: true,
        subscriptionPlanCode: true,
        subscriptionCurrentPeriodEndUtc: true,
        billingStateEventCreatedAtUtc: true,
        billingStateEventId: true,
        stripeCheckoutSessionId: true,
        stripeCheckoutSessionExpiresAtUtc: true,
      },
    });

    expect(reclaimedResponse.statusCode).toBe(200);
    expect(reclaimedSuccess.status).toBe("SUCCEEDED");
    expect(reclaimedSuccess.attemptCount).toBe(2);
    expect(reclaimedSuccess.processingLeaseToken).not.toBe(firstLease.processingLeaseToken);
    expect(reclaimedSuccess.succeededAtUtc).not.toBeNull();
    expect(reclaimedSuccess.failedAtUtc).toBeNull();
    expect(reclaimedSuccess.lastError).toBeNull();
    expect(tenantBeforeStaleResume).toMatchObject({
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      subscriptionStatus: "active",
      subscriptionPlanCode: "starter",
      billingStateEventId: stripeEventId,
      stripeCheckoutSessionId: null,
      stripeCheckoutSessionExpiresAtUtc: null,
    });
    expect(tenantBeforeStaleResume.billingStateEventCreatedAtUtc?.getTime()).toBe(event.created * 1000);
    expect(staleResponse.statusCode).toBe(500);
    expect(finalEvent).toEqual(reclaimedSuccess);
    expect(tenantAfterStaleResume).toEqual(tenantBeforeStaleResume);
  });

  test("uses the configured subscription item period and fails closed when it is absent", () => {
    const periodStart = Math.floor(Date.now() / 1000) - 86_400;
    const periodEnd = Math.floor(Date.now() / 1000) + 86_400;
    const resolved = resolveSubscriptionItemBilling(
      {
        items: {
          data: [
            { price: { id: "price_unrelated" }, current_period_start: periodStart, current_period_end: periodEnd + 500 },
            { price: { id: "price_starter" }, current_period_start: periodStart, current_period_end: periodEnd },
          ],
        },
      } as Stripe.Subscription,
      new Map([["price_starter", "starter"]]),
    );
    expect(resolved.planCode).toBe("starter");
    expect(resolved.currentPeriodStartUtc?.getTime()).toBe(periodStart * 1000);
    expect(resolved.currentPeriodEndUtc?.getTime()).toBe(periodEnd * 1000);

    const missingPeriod = resolveSubscriptionItemBilling(
      { items: { data: [{ price: { id: "price_starter" } }] } } as Stripe.Subscription,
      new Map([["price_starter", "starter"]]),
    );
    expect(missingPeriod).toEqual({
      planCode: "starter",
      currentPeriodStartUtc: null,
      currentPeriodEndUtc: null,
    });

    const entitlements = buildTenantEntitlements({
      subscriptionStatus: "active",
      subscriptionPlanCode: "starter",
      trialStartsAtUtc: null,
      trialEndsAtUtc: null,
      subscriptionCurrentPeriodEndUtc: null,
    });
    expect(entitlements.hasWorkspaceAccess).toBe(false);
    expect(entitlements.billingRequired).toBe(true);

    const activeBasicEntitlements = buildTenantEntitlements({
      subscriptionStatus: "active",
      subscriptionPlanCode: "starter",
      trialStartsAtUtc: null,
      trialEndsAtUtc: null,
      subscriptionCurrentPeriodEndUtc: new Date(Date.now() + 86_400_000),
    });
    expect(activeBasicEntitlements.features.quoteVersionHistory).toBe(true);
    expect(activeBasicEntitlements.limits.quoteHistoryDays).toBe(30);
  });

  test("Stripe sync persists both cycle bounds and idempotently reconciles tenant-scoped usage totals", async () => {
    const session = await signUp("billing-cycle-reconcile");
    const other = await signUp("billing-cycle-reconcile-other");
    const nowSeconds = Math.floor(Date.now() / 1000);
    const periodStart = nowSeconds - 5 * 86_400;
    const periodEnd = nowSeconds + 25 * 86_400;
    const customerId = `cus_cycle_${Date.now()}`;
    const subscriptionId = `sub_cycle_${Date.now()}`;
    await prisma.tenant.update({
      where: { id: session.tenant.id },
      data: {
        subscriptionStatus: "inactive",
        subscriptionPlanCode: null,
        trialStartsAtUtc: null,
        trialEndsAtUtc: null,
        stripeCustomerId: customerId,
        stripeSubscriptionId: null,
        subscriptionCurrentPeriodStartUtc: null,
        subscriptionCurrentPeriodEndUtc: null,
      },
    });
    const usageCreatedAt = new Date((periodStart + 60) * 1000);
    await prisma.aiUsageEvent.create({
      data: {
        tenantId: session.tenant.id,
        eventType: "BUSINESS_INSIGHT",
        creditsConsumed: 3,
        requestCount: 1,
        estimatedCostUsd: "0.000321",
        createdAt: usageCreatedAt,
      },
    });
    await prisma.aiUsageEvent.create({
      data: {
        tenantId: other.tenant.id,
        eventType: "BUSINESS_INSIGHT",
        creditsConsumed: 99,
        requestCount: 1,
        estimatedCostUsd: "0.999999",
        createdAt: usageCreatedAt,
      },
    });
    const subscription = stripeSubscriptionFixture({
      id: subscriptionId,
      customerId,
      tenantId: session.tenant.id,
      status: "active",
      periodStart,
      periodEnd,
    });
    stripeProviderMocks.retrieveSubscription.mockResolvedValue(subscription);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await injectSignedStripeEvent({
        id: `evt_cycle_reconcile_${attempt}_${Date.now()}`,
        type: "customer.subscription.updated",
        created: nowSeconds + attempt,
        data: { object: subscription },
      });
      expect(response.statusCode).toBe(200);
    }

    const [tenant, period] = await Promise.all([
      prisma.tenant.findUniqueOrThrow({ where: { id: session.tenant.id } }),
      prisma.aiUsagePeriod.findUniqueOrThrow({
        where: {
          tenantId_periodStartUtc: {
            tenantId: session.tenant.id,
            periodStartUtc: new Date(periodStart * 1000),
          },
        },
      }),
    ]);
    expect(tenant.subscriptionCurrentPeriodStartUtc).toEqual(new Date(periodStart * 1000));
    expect(tenant.subscriptionCurrentPeriodEndUtc).toEqual(new Date(periodEnd * 1000));
    expect(period).toMatchObject({
      periodEndUtc: new Date(periodEnd * 1000),
      completedCredits: 3,
      completedCostMicros: 321n,
    });
    expect(await prisma.aiUsagePeriod.count({
      where: { tenantId: other.tenant.id, periodStartUtc: new Date(periodStart * 1000) },
    })).toBe(0);
  });

  test("Stripe trial sync reconciles exact trial bounds rather than subscription-item bounds", async () => {
    const session = await signUp("billing-stripe-trial-cycle");
    const nowSeconds = Math.floor(Date.now() / 1000);
    const billingStart = nowSeconds - 7 * 86_400;
    const billingEnd = nowSeconds + 23 * 86_400;
    const trialStart = nowSeconds - 2 * 86_400;
    const trialEnd = nowSeconds + 12 * 86_400;
    const customerId = `cus_trial_cycle_${Date.now()}`;
    const subscriptionId = `sub_trial_cycle_${Date.now()}`;
    await prisma.tenant.update({
      where: { id: session.tenant.id },
      data: {
        stripeCustomerId: customerId,
        stripeSubscriptionId: null,
        subscriptionStatus: "inactive",
        subscriptionPlanCode: null,
        trialStartsAtUtc: null,
        trialEndsAtUtc: null,
      },
    });
    const subscription = stripeSubscriptionFixture({
      id: subscriptionId,
      customerId,
      tenantId: session.tenant.id,
      status: "trialing",
      periodStart: billingStart,
      periodEnd: billingEnd,
      trialStart,
      trialEnd,
    });
    stripeProviderMocks.retrieveSubscription.mockResolvedValue(subscription);
    expect((await injectSignedStripeEvent({
      id: `evt_trial_cycle_${Date.now()}`,
      type: "customer.subscription.updated",
      created: nowSeconds,
      data: { object: subscription },
    })).statusCode).toBe(200);

    expect(await prisma.tenant.findUniqueOrThrow({ where: { id: session.tenant.id } })).toMatchObject({
      subscriptionStatus: "trialing",
      subscriptionPlanCode: "starter",
      subscriptionCurrentPeriodStartUtc: new Date(billingStart * 1000),
      subscriptionCurrentPeriodEndUtc: new Date(billingEnd * 1000),
      trialStartsAtUtc: new Date(trialStart * 1000),
      trialEndsAtUtc: new Date(trialEnd * 1000),
    });
    expect(await prisma.aiUsagePeriod.findUniqueOrThrow({
      where: {
        tenantId_periodStartUtc: {
          tenantId: session.tenant.id,
          periodStartUtc: new Date(trialStart * 1000),
        },
      },
    })).toMatchObject({ periodEndUtc: new Date(trialEnd * 1000) });
    expect(await prisma.aiUsagePeriod.findUnique({
      where: {
        tenantId_periodStartUtc: {
          tenantId: session.tenant.id,
          periodStartUtc: new Date(billingStart * 1000),
        },
      },
    })).toBeNull();
  });

  test("a delayed renewal commits while an active request remains attributed to its old period", async () => {
    const session = await signUp("billing-cycle-active-hold");
    const nowSeconds = Math.floor(Date.now() / 1000);
    const oldStart = new Date((nowSeconds - 10 * 86_400) * 1000);
    const oldEnd = new Date((nowSeconds + 20 * 86_400) * 1000);
    const newStartSeconds = nowSeconds - 5 * 86_400;
    const newEndSeconds = nowSeconds + 25 * 86_400;
    const customerId = `cus_cycle_hold_${Date.now()}`;
    const subscriptionId = `sub_cycle_hold_${Date.now()}`;
    await prisma.tenant.update({
      where: { id: session.tenant.id },
      data: {
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        subscriptionStatus: "active",
        subscriptionPlanCode: "starter",
        trialStartsAtUtc: null,
        trialEndsAtUtc: null,
        subscriptionCurrentPeriodStartUtc: oldStart,
        subscriptionCurrentPeriodEndUtc: oldEnd,
      },
    });
    const root = await withTenantRlsContext(prisma, session.tenant.id, async (tx) => {
      const period = await tx.aiUsagePeriod.create({
        data: { tenantId: session.tenant.id, periodStartUtc: oldStart, periodEndUtc: oldEnd },
      });
      return tx.aiUsageReservation.create({
        data: {
          tenantId: session.tenant.id,
          periodId: period.id,
          kind: "OPERATION",
          state: "RESERVED",
          operation: "WEBHOOK_HOLD",
          idempotencyKeyHash: "1".repeat(64),
          requestHash: "2".repeat(64),
          reservedCredits: 1,
          ceilingCostMicros: 0n,
          expiresAtUtc: new Date(Date.now() + 15 * 60_000),
        },
      });
    });
    const subscription = stripeSubscriptionFixture({
      id: subscriptionId,
      customerId,
      tenantId: session.tenant.id,
      status: "active",
      periodStart: newStartSeconds,
      periodEnd: newEndSeconds,
    });
    stripeProviderMocks.retrieveSubscription.mockResolvedValue(subscription);
    const renewedEventId = `evt_cycle_hold_renewed_${Date.now()}`;
    const renewed = await injectSignedStripeEvent({
      id: renewedEventId,
      type: "customer.subscription.updated",
      created: nowSeconds,
      data: { object: subscription },
    });
    expect(renewed.statusCode).toBe(200);
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: session.tenant.id } })).subscriptionCurrentPeriodStartUtc)
      .toEqual(new Date(newStartSeconds * 1000));
    expect(await prisma.aiUsagePeriod.findUniqueOrThrow({
      where: {
        tenantId_periodStartUtc: {
          tenantId: session.tenant.id,
          periodStartUtc: new Date(newStartSeconds * 1000),
        },
      },
    })).toMatchObject({ completedCredits: 0, completedCostMicros: 0n });
    expect((await prisma.aiUsageReservation.findUniqueOrThrow({ where: { id: root.id } })).periodId)
      .not.toBe((await prisma.aiUsagePeriod.findUniqueOrThrow({
        where: {
          tenantId_periodStartUtc: {
            tenantId: session.tenant.id,
            periodStartUtc: new Date(newStartSeconds * 1000),
          },
        },
      })).id);
    expect(await prisma.billingWebhookEvent.findUniqueOrThrow({ where: { stripeEventId: renewedEventId } }))
      .toMatchObject({ status: "SUCCEEDED", lastError: null });

    await withTenantRlsContext(prisma, session.tenant.id, (tx) => tx.aiUsageReservation.update({
      where: { id: root.id },
      data: { state: "VOIDED", finalizedAtUtc: new Date() },
    }));
    expect((await prisma.aiUsageReservation.findUniqueOrThrow({ where: { id: root.id } })).state)
      .toBe("VOIDED");

    const currentPeriod = await prisma.aiUsagePeriod.findUniqueOrThrow({
      where: {
        tenantId_periodStartUtc: {
          tenantId: session.tenant.id,
          periodStartUtc: new Date(newStartSeconds * 1000),
        },
      },
    });
    const currentRoot = await withTenantRlsContext(prisma, session.tenant.id, (tx) => (
      tx.aiUsageReservation.create({
        data: {
          tenantId: session.tenant.id,
          periodId: currentPeriod.id,
          kind: "OPERATION",
          state: "RESERVED",
          operation: "SAME_PERIOD_HOLD",
          idempotencyKeyHash: "5".repeat(64),
          requestHash: "6".repeat(64),
          reservedCredits: 1,
          ceilingCostMicros: 0n,
          expiresAtUtc: new Date(Date.now() + 15 * 60_000),
        },
      })
    ));
    const extendedEndSeconds = newEndSeconds + 86_400;
    const extended = stripeSubscriptionFixture({
      id: subscriptionId,
      customerId,
      tenantId: session.tenant.id,
      status: "active",
      periodStart: newStartSeconds,
      periodEnd: extendedEndSeconds,
    });
    stripeProviderMocks.retrieveSubscription.mockResolvedValue(extended);
    expect((await injectSignedStripeEvent({
      id: `evt_cycle_hold_extended_${Date.now()}`,
      type: "customer.subscription.updated",
      created: nowSeconds + 1,
      data: { object: extended },
    })).statusCode).toBe(200);
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: session.tenant.id } })).subscriptionCurrentPeriodEndUtc)
      .toEqual(new Date(extendedEndSeconds * 1000));
    expect(await prisma.aiUsagePeriod.findUniqueOrThrow({ where: { id: currentPeriod.id } }))
      .toMatchObject({ periodEndUtc: new Date(extendedEndSeconds * 1000), completedCredits: 0 });
    await withTenantRlsContext(prisma, session.tenant.id, (tx) => tx.aiUsageReservation.update({
      where: { id: currentRoot.id },
      data: { state: "VOIDED", finalizedAtUtc: new Date() },
    }));
  });

  test("subscription cancellation revokes access immediately even with active AI work", async () => {
    const session = await signUp("billing-cancel-active-ai");
    const nowSeconds = Math.floor(Date.now() / 1000);
    const periodStart = new Date((nowSeconds - 5 * 86_400) * 1000);
    const periodEnd = new Date((nowSeconds + 25 * 86_400) * 1000);
    const customerId = `cus_cancel_ai_${Date.now()}`;
    const subscriptionId = `sub_cancel_ai_${Date.now()}`;
    await prisma.tenant.update({
      where: { id: session.tenant.id },
      data: {
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        subscriptionStatus: "active",
        subscriptionPlanCode: "starter",
        trialStartsAtUtc: null,
        trialEndsAtUtc: null,
        subscriptionCurrentPeriodStartUtc: periodStart,
        subscriptionCurrentPeriodEndUtc: periodEnd,
      },
    });
    const root = await withTenantRlsContext(prisma, session.tenant.id, async (tx) => {
      const period = await tx.aiUsagePeriod.create({
        data: { tenantId: session.tenant.id, periodStartUtc: periodStart, periodEndUtc: periodEnd },
      });
      return tx.aiUsageReservation.create({
        data: {
          tenantId: session.tenant.id,
          periodId: period.id,
          kind: "OPERATION",
          state: "STARTED",
          operation: "CANCEL_IN_FLIGHT",
          idempotencyKeyHash: "3".repeat(64),
          requestHash: "4".repeat(64),
          reservedCredits: 1,
          ceilingCostMicros: 0n,
          expiresAtUtc: new Date(Date.now() + 15 * 60_000),
        },
      });
    });
    const canceledSubscription = stripeSubscriptionFixture({
      id: subscriptionId,
      customerId,
      tenantId: session.tenant.id,
      status: "canceled",
      periodStart: Math.floor(periodStart.getTime() / 1000),
      periodEnd: Math.floor(periodEnd.getTime() / 1000),
    });
    stripeProviderMocks.retrieveSubscription.mockResolvedValue(canceledSubscription);
    const event = {
      id: `evt_cancel_active_ai_${Date.now()}`,
      type: "customer.subscription.deleted",
      created: nowSeconds,
      data: { object: canceledSubscription },
    };
    const canceled = await injectSignedStripeEvent(event);
    expect(canceled.statusCode).toBe(200);
    expect(await injectSignedStripeEvent(event)).toMatchObject({ statusCode: 200 });
    expect(await prisma.tenant.findUniqueOrThrow({ where: { id: session.tenant.id } }))
      .toMatchObject({ subscriptionStatus: "canceled" });
    expect((await prisma.aiUsageReservation.findUniqueOrThrow({ where: { id: root.id } })).state)
      .toBe("STARTED");

    const workspace = await app.inject({
      method: "POST",
      url: "/v1/customers",
      headers: authHeaders(session.cookie),
      payload: { fullName: "Blocked After Cancellation", phone: "555-010-2200" },
    });
    expect(workspace.statusCode).toBe(402);
    expect(parseJson<{ code: string }>(workspace).code).toBe("BILLING_REQUIRED");
    await withTenantRlsContext(prisma, session.tenant.id, (tx) => tx.aiUsageReservation.update({
      where: { id: root.id },
      data: { state: "AMBIGUOUS_CHARGED", actualCredits: 1, finalizedAtUtc: new Date() },
    }));
  });

  test("rejects reconciliation when Stripe customer or tenant metadata bindings mismatch", () => {
    const periodStart = Math.floor(Date.now() / 1000) - 86_400;
    const periodEnd = Math.floor(Date.now() / 1000) + 86_400;
    const subscription = stripeSubscriptionFixture({
      id: "sub_reconciliation_binding",
      customerId: "cus_expected",
      tenantId: "tenant_expected",
      status: "active",
      periodStart,
      periodEnd,
    });
    const baseInput = {
      subscription,
      expectedTenantId: "tenant_expected",
      expectedCustomerId: "cus_expected",
      expectedSubscriptionId: subscription.id,
      expectedPlanCode: "starter",
      pricePlans: new Map([[process.env.STRIPE_PRICE_ID_STARTER!, "starter" as const]]),
    };

    expect(resolveReconciledSubscriptionPeriod(baseInput)?.getTime()).toBe(periodEnd * 1000);
    expect(resolveReconciledSubscriptionBillingPeriod(baseInput)).toEqual({
      currentPeriodStartUtc: new Date(periodStart * 1000),
      currentPeriodEndUtc: new Date(periodEnd * 1000),
    });
    expect(
      resolveReconciledSubscriptionPeriod({ ...baseInput, expectedCustomerId: "cus_different" }),
    ).toBeNull();
    expect(
      resolveReconciledSubscriptionPeriod({ ...baseInput, expectedTenantId: "tenant_different" }),
    ).toBeNull();
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

  test("lets active and expired internal trials start checkout without duplicating a Stripe subscription", async () => {
    const activeTrial = await signUp("billing-active-internal-trial");
    const activeTrialTenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: activeTrial.tenant.id },
      select: { trialEndsAtUtc: true },
    });
    stripeProviderMocks.createCustomer.mockResolvedValueOnce({ id: `cus_internal_active_${Date.now()}` });
    stripeProviderMocks.createCheckoutSession.mockImplementationOnce(async (params: Stripe.Checkout.SessionCreateParams) => ({
      id: `cs_internal_active_${Date.now()}`,
      url: "https://checkout.stripe.test/internal-active",
      expires_at: params.expires_at,
    }));

    const activeResponse = await app.inject({
      method: "POST",
      url: "/v1/billing/checkout-session",
      headers: authHeaders(activeTrial.cookie),
      payload: { planCode: "starter" },
    });
    expect(activeResponse.statusCode).toBe(200);
    const activeParams = stripeProviderMocks.createCheckoutSession.mock.calls[0]?.[0] as Stripe.Checkout.SessionCreateParams;
    expect(activeParams.success_url).toContain("/app/settings?billing=success&session_id={CHECKOUT_SESSION_ID}");
    expect(activeParams.cancel_url).toContain("/app/settings?billing=cancel");
    expect(activeParams.payment_method_collection).toBe("always");
    expect(activeParams.discounts).toEqual([
      { coupon: process.env.STRIPE_COUPON_ID_BASIC_FIRST_MONTH_HALF_OFF },
    ]);
    expect(activeParams.allow_promotion_codes).toBeUndefined();
    expect(activeParams.metadata?.introOffer).toBe("basic_first_paid_month_half_off");
    expect(activeParams.subscription_data?.metadata?.introOffer).toBe(
      "basic_first_paid_month_half_off",
    );
    expect(activeParams.subscription_data?.trial_end).toBeGreaterThanOrEqual(
      Math.ceil(activeTrialTenant.trialEndsAtUtc!.getTime() / 1000),
    );
    expect(activeParams.subscription_data?.trial_end).toBeGreaterThan(
      Math.floor(Date.now() / 1000) + 48 * 60 * 60,
    );
    const activeAfterAbandon = await prisma.tenant.findUniqueOrThrow({
      where: { id: activeTrial.tenant.id },
      select: { stripeCustomerId: true, stripeSubscriptionId: true },
    });
    expect(activeAfterAbandon.stripeCustomerId).toMatch(/^cus_internal_active_/);
    expect(activeAfterAbandon.stripeSubscriptionId).toBeNull();
    expect((await app.inject({
      method: "GET",
      url: "/v1/customers",
      headers: authHeaders(activeTrial.cookie),
    })).statusCode).toBe(200);

    stripeProviderMocks.createCustomer.mockReset();
    stripeProviderMocks.createCheckoutSession.mockReset();
    const expiredTrial = await signUp("billing-expired-internal-trial");
    await prisma.tenant.update({
      where: { id: expiredTrial.tenant.id },
      data: { trialEndsAtUtc: new Date(Date.now() - 60_000) },
    });
    stripeProviderMocks.createCustomer.mockResolvedValueOnce({ id: `cus_internal_expired_${Date.now()}` });
    stripeProviderMocks.createCheckoutSession.mockImplementationOnce(async (params: Stripe.Checkout.SessionCreateParams) => ({
      id: `cs_internal_expired_${Date.now()}`,
      url: "https://checkout.stripe.test/internal-expired",
      expires_at: params.expires_at,
    }));

    const expiredResponse = await app.inject({
      method: "POST",
      url: "/v1/billing/checkout-session",
      headers: authHeaders(expiredTrial.cookie),
      payload: { planCode: "starter" },
    });
    expect(expiredResponse.statusCode).toBe(200);
    const expiredParams = stripeProviderMocks.createCheckoutSession.mock.calls[0]?.[0] as Stripe.Checkout.SessionCreateParams;
    expect(expiredParams.subscription_data?.trial_end).toBeUndefined();
    expect(expiredParams.discounts).toEqual([
      { coupon: process.env.STRIPE_COUPON_ID_BASIC_FIRST_MONTH_HALF_OFF },
    ]);

    const stripeTrial = await signUp("billing-real-stripe-trial");
    await prisma.tenant.update({
      where: { id: stripeTrial.tenant.id },
      data: {
        stripeCustomerId: `cus_real_trial_${Date.now()}`,
        stripeSubscriptionId: `sub_real_trial_${Date.now()}`,
        subscriptionStatus: "trialing",
      },
    });
    const stripeTrialResponse = await app.inject({
      method: "POST",
      url: "/v1/billing/checkout-session",
      headers: authHeaders(stripeTrial.cookie),
      payload: { planCode: "starter" },
    });
    expect(stripeTrialResponse.statusCode).toBe(409);
  });

  test("does not repeat the introductory discount after a prior Stripe subscription", async () => {
    const session = await signUp("billing-returning-subscriber");
    await prisma.tenant.update({
      where: { id: session.tenant.id },
      data: {
        stripeCustomerId: `cus_returning_${Date.now()}`,
        stripeSubscriptionId: `sub_canceled_${Date.now()}`,
        subscriptionStatus: "canceled",
        trialEndsAtUtc: new Date(Date.now() - 60_000),
      },
    });
    stripeProviderMocks.createCheckoutSession.mockImplementationOnce(
      async (params: Stripe.Checkout.SessionCreateParams) => ({
        id: `cs_returning_${Date.now()}`,
        url: "https://checkout.stripe.test/returning",
        expires_at: params.expires_at,
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/billing/checkout-session",
      headers: authHeaders(session.cookie),
      payload: { planCode: "starter" },
    });

    expect(response.statusCode).toBe(200);
    const params = stripeProviderMocks.createCheckoutSession.mock.calls[0]?.[0] as Stripe.Checkout.SessionCreateParams;
    expect(params.discounts).toBeUndefined();
    expect(params.allow_promotion_codes).toBeUndefined();
    expect(params.metadata?.introOffer).toBe("none");
    expect(params.subscription_data?.metadata?.introOffer).toBe("none");
    expect(stripeProviderMocks.retrieveCoupon).not.toHaveBeenCalled();
  });

  test("fails checkout closed when Stripe Basic pricing does not match the published offer", async () => {
    const session = await signUp("billing-price-mismatch");
    stripeProviderMocks.retrievePrice.mockResolvedValueOnce({
      id: process.env.STRIPE_PRICE_ID_STARTER,
      object: "price",
      active: true,
      currency: "usd",
      type: "recurring",
      unit_amount: 1900,
      recurring: { interval: "month", interval_count: 1 },
    } as Stripe.Price);

    const response = await app.inject({
      method: "POST",
      url: "/v1/billing/checkout-session",
      headers: authHeaders(session.cookie),
      payload: { planCode: "starter" },
    });

    expect(response.statusCode).toBe(503);
    expect(parseJson<{ error: string }>(response)).toEqual({
      error: "Billing checkout is temporarily unavailable.",
    });
    expect(stripeProviderMocks.createCustomer).not.toHaveBeenCalled();
    expect(stripeProviderMocks.createCheckoutSession).not.toHaveBeenCalled();
    await expect(
      prisma.tenant.findUniqueOrThrow({
        where: { id: session.tenant.id },
        select: { stripeCheckoutAttemptId: true },
      }),
    ).resolves.toMatchObject({ stripeCheckoutAttemptId: null });
  });

  test("refuses duplicate paid subscriptions and resumes the canonical open checkout", async () => {
    const active = await signUp("billing-active-checkout");
    await prisma.tenant.update({
      where: { id: active.tenant.id },
      data: {
        subscriptionStatus: "active",
        stripeSubscriptionId: `sub_active_${Date.now()}`,
      },
    });
    const activeResponse = await app.inject({
      method: "POST",
      url: "/v1/billing/checkout-session",
      headers: authHeaders(active.cookie),
      payload: { planCode: "starter" },
    });
    expect(activeResponse.statusCode).toBe(409);

    const pending = await signUp("billing-pending-checkout");
    await prisma.tenant.update({
      where: { id: pending.tenant.id },
      data: {
        stripeCheckoutSessionId: `cs_pending_${Date.now()}`,
        stripeCheckoutSessionExpiresAtUtc: new Date(Date.now() + 60_000),
      },
    });
    stripeProviderMocks.retrieveCheckoutSession.mockResolvedValueOnce({
      id: (await prisma.tenant.findUniqueOrThrow({
        where: { id: pending.tenant.id },
        select: { stripeCheckoutSessionId: true },
      })).stripeCheckoutSessionId,
      status: "open",
      url: "https://checkout.stripe.test/resume",
    });
    const pendingResponse = await app.inject({
      method: "POST",
      url: "/v1/billing/checkout-session",
      headers: authHeaders(pending.cookie),
      payload: { planCode: "starter" },
    });
    expect(pendingResponse.statusCode).toBe(200);
    expect(parseJson<{ checkoutUrl: string; reused: boolean }>(pendingResponse)).toMatchObject({
      checkoutUrl: "https://checkout.stripe.test/resume",
      reused: true,
    });
    expect(stripeProviderMocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  test("resumes the canonical checkout when a reservation conflict finds one", async () => {
    const session = await signUp("billing-conflict-resume");

    const originalUpdateMany = prisma.tenant.updateMany.bind(prisma.tenant);
    const checkoutSessionId = `cs_conflict_resume_${Date.now()}`;
    const updateManySpy = vi.spyOn(prisma.tenant, "updateMany").mockImplementation(async (args) => {
      const attemptsToReserveCheckout =
        typeof (args.data as { stripeCheckoutAttemptId?: unknown }).stripeCheckoutAttemptId === "string" &&
        (args.data as { stripeCheckoutSessionId?: unknown }).stripeCheckoutSessionId === null &&
        "AND" in (args.where as Record<string, unknown>);
      if (attemptsToReserveCheckout) {
        await originalUpdateMany({
          where: { id: session.tenant.id },
          data: {
            stripeCheckoutSessionId: checkoutSessionId,
            stripeCheckoutSessionExpiresAtUtc: new Date(Date.now() + 50 * 60 * 1000),
            stripeCheckoutAttemptId: null,
            stripeCheckoutAttemptExpiresAtUtc: null,
          },
        });
        return { count: 0 };
      }
      return originalUpdateMany(args);
    });
    stripeProviderMocks.retrieveCheckoutSession.mockResolvedValueOnce({
      id: checkoutSessionId,
      status: "open",
      url: "https://checkout.stripe.test/conflict-resume",
    });
    stripeProviderMocks.createCustomer.mockResolvedValueOnce({ id: `cus_conflict_resume_${Date.now()}` });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/billing/checkout-session",
        headers: authHeaders(session.cookie),
        payload: { planCode: "starter" },
      });

      expect(response.statusCode).toBe(200);
      expect(parseJson<{ checkoutUrl: string; reused: boolean }>(response)).toMatchObject({
        checkoutUrl: "https://checkout.stripe.test/conflict-resume",
        reused: true,
      });
      expect(stripeProviderMocks.createCheckoutSession).not.toHaveBeenCalled();
    } finally {
      updateManySpy.mockRestore();
    }
  });

  test("reuses the durable checkout generation after a post-provider persistence failure", async () => {
    const session = await signUp("billing-checkout-crash");
    await prisma.tenant.update({
      where: { id: session.tenant.id },
      data: {
        subscriptionStatus: "inactive",
        subscriptionPlanCode: null,
        trialStartsAtUtc: null,
        trialEndsAtUtc: null,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
      },
    });
    const customerId = `cus_checkout_crash_${Date.now()}`;
    const sessionByIdempotencyKey = new Map<string, { id: string; url: string; expires_at: number }>();
    const idempotencyKeys: string[] = [];
    stripeProviderMocks.createCustomer.mockResolvedValue({ id: customerId });
    stripeProviderMocks.createCheckoutSession.mockImplementation(
      async (params: { expires_at?: number }, options: { idempotencyKey?: string }) => {
        const key = options.idempotencyKey!;
        idempotencyKeys.push(key);
        const existing = sessionByIdempotencyKey.get(key);
        if (existing) return existing;
        const created = {
          id: `cs_durable_${Date.now()}`,
          url: "https://checkout.stripe.test/durable",
          expires_at: params.expires_at!,
        };
        sessionByIdempotencyKey.set(key, created);
        return created;
      },
    );

    const realUpdateMany = prisma.tenant.updateMany.bind(prisma.tenant);
    let injectFailure = true;
    const updateSpy = vi.spyOn(prisma.tenant, "updateMany").mockImplementation(async (args) => {
      const sessionId = (args.data as { stripeCheckoutSessionId?: unknown }).stripeCheckoutSessionId;
      if (injectFailure && typeof sessionId === "string") {
        injectFailure = false;
        throw new Error("Injected crash after Stripe checkout creation.");
      }
      return realUpdateMany(args);
    });

    const first = await app.inject({
      method: "POST",
      url: "/v1/billing/checkout-session",
      headers: authHeaders(session.cookie),
      payload: { planCode: "starter" },
    });
    updateSpy.mockRestore();
    expect(first.statusCode).toBe(500);

    const afterCrash = await prisma.tenant.findUniqueOrThrow({
      where: { id: session.tenant.id },
      select: { stripeCheckoutAttemptId: true, stripeCheckoutAttemptExpiresAtUtc: true, stripeCheckoutSessionId: true },
    });
    expect(afterCrash.stripeCheckoutAttemptId).not.toBeNull();
    expect(afterCrash.stripeCheckoutSessionId).toBeNull();
    expect(afterCrash.stripeCheckoutAttemptExpiresAtUtc!.getTime() - Date.now()).toBeGreaterThan(30 * 60 * 1000);
    const providerSession = [...sessionByIdempotencyKey.values()][0];
    expect(providerSession.expires_at * 1000).toBe(afterCrash.stripeCheckoutAttemptExpiresAtUtc!.getTime());

    const retry = await app.inject({
      method: "POST",
      url: "/v1/billing/checkout-session",
      headers: authHeaders(session.cookie),
      payload: { planCode: "starter" },
    });
    expect(retry.statusCode).toBe(200);
    expect(idempotencyKeys).toHaveLength(2);
    expect(new Set(idempotencyKeys).size).toBe(1);
    expect(sessionByIdempotencyKey.size).toBe(1);

    const canonical = await prisma.tenant.findUniqueOrThrow({
      where: { id: session.tenant.id },
      select: { stripeCheckoutSessionId: true, stripeCheckoutAttemptId: true },
    });
    expect(canonical.stripeCheckoutSessionId).toBe(parseJson<{ sessionId: string }>(retry).sessionId);
    expect(canonical.stripeCheckoutAttemptId).toBeNull();
  });

  test("uses an exact credentialed CORS allowlist", async () => {
    const blocked = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { origin: "https://attacker.example" },
    });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.headers["access-control-allow-origin"]).toBeUndefined();

    const allowedOrigin = new URL(env.APP_URL).origin;
    const allowed = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { origin: allowedOrigin },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers["access-control-allow-origin"]).toBe(allowedOrigin);
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");
  });

  test("prevents admin owner escalation and cross-tenant user-profile mutation", async () => {
    const owner = await signUp("org-owner-boundary");
    const victim = await signUp("org-profile-victim");
    const adminEmail = `org-admin-${Date.now()}@example.com`;
    const adminPassword = "AdminPassword123!";
    const createAdmin = await app.inject({
      method: "POST",
      url: "/v1/org/users",
      headers: authHeaders(owner.cookie),
      payload: {
        email: adminEmail,
        fullName: "Organization Admin",
        password: adminPassword,
        role: "admin",
      },
    });
    expect(createAdmin.statusCode).toBe(201);

    const adminSignIn = await app.inject({
      method: "POST",
      url: "/v1/auth/signin",
      payload: { email: adminEmail, password: adminPassword },
    });
    expect(adminSignIn.statusCode).toBe(200);
    const adminCookie = extractSessionCookie(adminSignIn);
    const escalatedEmail = `org-escalated-owner-${Date.now()}@example.com`;
    const ownerEscalation = await app.inject({
      method: "POST",
      url: "/v1/org/users",
      headers: authHeaders(adminCookie),
      payload: {
        email: escalatedEmail,
        fullName: "Escalated Owner",
        password: "OwnerPassword123!",
        role: "owner",
      },
    });
    expect(ownerEscalation.statusCode).toBe(403);
    await expect(prisma.user.count({ where: { email: escalatedEmail } })).resolves.toBe(0);

    const memberEmail = `quickbooks-member-${Date.now()}@example.com`;
    const memberPassword = "MemberPassword123!";
    const createMember = await app.inject({
      method: "POST",
      url: "/v1/org/users",
      headers: authHeaders(owner.cookie),
      payload: {
        email: memberEmail,
        fullName: "QuickBooks Member",
        password: memberPassword,
        role: "member",
      },
    });
    expect(createMember.statusCode).toBe(201);
    const memberSignIn = await app.inject({
      method: "POST",
      url: "/v1/auth/signin",
      payload: { email: memberEmail, password: memberPassword },
    });
    expect(memberSignIn.statusCode).toBe(200);
    const memberPush = await app.inject({
      method: "POST",
      url: "/v1/integrations/quickbooks/quotes/not-a-quote/push-invoice",
      headers: authHeaders(extractSessionCookie(memberSignIn)),
      payload: {},
    });
    expect(memberPush.statusCode).toBe(403);

    const victimOriginalName = victim.user.fullName;
    const addExistingUser = await app.inject({
      method: "POST",
      url: "/v1/org/users",
      headers: authHeaders(owner.cookie),
      payload: {
        email: victim.user.email,
        fullName: "Cross Tenant Overwrite",
        password: "IgnoredPassword123!",
        role: "member",
      },
    });
    expect(addExistingUser.statusCode).toBe(201);
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: victim.user.id }, select: { fullName: true } }),
    ).resolves.toEqual({ fullName: victimOriginalName });
  });

  test("rejects malformed Twilio signatures and deduplicates signed SMS retries before effects", async () => {
    const session = await signUp("twilio-replay-boundary");
    const destination = `+1555${String(Date.now()).slice(-7)}`;
    const sender = "+15550101999";
    const smsSid = `SM${Date.now()}quotefly`;
    await prisma.tenantPhoneNumber.create({
      data: { tenantId: session.tenant.id, e164Number: destination },
    });
    const form = {
      From: sender,
      To: destination,
      Body: "Roof replacement for Jane Doe at 1200 square feet",
      SmsSid: smsSid,
    };
    const webhookUrl = new URL("/v1/sms/webhook", env.API_URL).toString();
    const payload = new URLSearchParams(form).toString();

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/sms/webhook",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "invalid",
      },
      payload,
    });
    expect(invalid.statusCode).toBe(401);
    await expect(prisma.quote.count({ where: { tenantId: session.tenant.id } })).resolves.toBe(0);

    const signature = twilio.getExpectedTwilioSignature(
      env.TWILIO_WEBHOOK_AUTH_TOKEN,
      webhookUrl,
      form,
    );
    const send = () =>
      app.inject({
        method: "POST",
        url: "/v1/sms/webhook",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": signature,
        },
        payload,
      });
    const first = await send();
    expect(first.statusCode).toBe(200);
    expect(parseJson<{ acknowledged: boolean }>(first)).toEqual({ acknowledged: true });

    const duplicate = await send();
    expect(duplicate.statusCode).toBe(200);
    expect(parseJson<{ acknowledged: boolean; duplicate: boolean }>(duplicate)).toEqual({
      acknowledged: true,
      duplicate: true,
    });
    await expect(prisma.quote.count({ where: { tenantId: session.tenant.id } })).resolves.toBe(1);
    await expect(prisma.smsMessage.count({ where: { externalSid: smsSid } })).resolves.toBe(1);
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

  test("contains QuickBooks provider workflows by default without calling Intuit", async () => {
    const session = await signUp("quickbooks-provider-paused");
    const customerResponse = await app.inject({
      method: "POST",
      url: "/v1/customers",
      headers: authHeaders(session.cookie),
      payload: { fullName: "Paused Provider Customer", phone: "555-010-1213" },
    });
    expect(customerResponse.statusCode).toBe(201);
    const customer = parseJson<CustomerResponse>(customerResponse).customer;
    const quoteResponse = await app.inject({
      method: "POST",
      url: "/v1/quotes",
      headers: authHeaders(session.cookie),
      payload: {
        customerId: customer.id,
        serviceType: "ROOFING",
        title: "Paused Provider Quote",
        scopeText: "A provider-capable quote used only to prove containment.",
        internalCostSubtotal: 100,
        customerPriceSubtotal: 200,
        taxAmount: 0,
      },
    });
    expect(quoteResponse.statusCode).toBe(201);
    const quote = parseJson<QuoteResponse>(quoteResponse).quote;
    await prisma.quote.update({ where: { id: quote.id }, data: { status: "ACCEPTED" } });
    const connection = await prisma.quickBooksConnection.create({
      data: {
        tenantId: session.tenant.id,
        realmId: `realm-paused-${Date.now()}`,
        environment: "sandbox",
        accessTokenEncrypted: "opaque-access-token",
        refreshTokenEncrypted: "opaque-refresh-token",
      },
    });
    await prisma.quickBooksInvoiceSync.create({
      data: {
        tenantId: session.tenant.id,
        quickBooksConnectionId: connection.id,
        quoteId: quote.id,
        quickBooksInvoiceId: "paused-invoice-id",
      },
    });
    const workflowFlag = app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED;
    app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED = false;
    for (const providerMock of Object.values(quickBooksProviderMocks)) providerMock.mockReset();

    try {
      const connect = await app.inject({
        method: "POST",
        url: "/v1/integrations/quickbooks/connect",
        headers: authHeaders(session.cookie),
      });
      expect(connect.statusCode).toBe(503);
      expect(parseJson<{ error: string }>(connect)).toEqual({
        error: "QUICKBOOKS_PROVIDER_WORKFLOWS_UNAVAILABLE",
      });

      const state = createSignedQuickBooksState(env, {
        tenantId: session.tenant.id,
        userId: session.user.id,
        role: "owner",
      });
      const callback = await app.inject({
        method: "GET",
        url: `/v1/integrations/quickbooks/callback?state=${encodeURIComponent(state)}&code=paused-code&realmId=paused-realm`,
      });
      expect(callback.statusCode).toBe(503);
      expect(parseJson<{ error: string }>(callback)).toEqual({
        error: "QUICKBOOKS_PROVIDER_WORKFLOWS_UNAVAILABLE",
      });

      const push = await app.inject({
        method: "POST",
        url: `/v1/integrations/quickbooks/quotes/${quote.id}/push-invoice`,
        headers: authHeaders(session.cookie),
        payload: {},
      });
      expect(push.statusCode).toBe(503);
      expect(parseJson<{ error: string }>(push)).toEqual({
        error: "QUICKBOOKS_PROVIDER_WORKFLOWS_UNAVAILABLE",
      });

      const invoiceStatus = await app.inject({
        method: "GET",
        url: `/v1/integrations/quickbooks/quotes/${quote.id}/invoice-status`,
        headers: authHeaders(session.cookie),
      });
      expect(invoiceStatus.statusCode).toBe(503);
      expect(parseJson<{ error: string }>(invoiceStatus)).toEqual({
        error: "QUICKBOOKS_PROVIDER_WORKFLOWS_UNAVAILABLE",
      });

      const payload = JSON.stringify([{
        id: `paused-webhook-${Date.now()}`,
        type: "com.intuit.quickbooks.accounting.invoice.updated",
        intuitaccountid: connection.realmId,
        intuitentityid: "paused-invoice-id",
        time: new Date().toISOString(),
      }]);
      const signature = createHmac("sha256", process.env.QUICKBOOKS_WEBHOOK_VERIFIER!)
        .update(payload)
        .digest("base64");
      const webhook = await app.inject({
        method: "POST",
        url: "/v1/integrations/quickbooks/webhook",
        headers: { "content-type": "application/json", "intuit-signature": signature },
        payload,
      });
      expect(webhook.statusCode).toBe(503);
      expect(parseJson<{ error: string }>(webhook)).toEqual({
        error: "QUICKBOOKS_PROVIDER_WORKFLOWS_UNAVAILABLE",
      });
      for (const providerMock of Object.values(quickBooksProviderMocks)) {
        expect(providerMock).not.toHaveBeenCalled();
      }
    } finally {
      app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED = workflowFlag;
    }
  });

  test("requires a live owner or admin before returning QuickBooks provider metadata", async () => {
    const owner = await signUp("quickbooks-live-manager");
    await prisma.quickBooksConnection.create({
      data: {
        tenantId: owner.tenant.id,
        realmId: `realm-private-${Date.now()}`,
        environment: "sandbox",
        companyName: "Private Provider Company",
      },
    });

    const ownerStatus = await app.inject({
      method: "GET",
      url: "/v1/integrations/quickbooks/status",
      headers: authHeaders(owner.cookie),
    });
    expect(ownerStatus.statusCode).toBe(200);
    expect(parseJson<{ connection: { realmId: string } | null }>(ownerStatus).connection?.realmId).toMatch(/^realm-private-/);

    const memberEmail = `quickbooks-private-member-${Date.now()}@example.com`;
    const memberPassword = "MemberPassword123!";
    const addMember = await app.inject({
      method: "POST",
      url: "/v1/org/users",
      headers: authHeaders(owner.cookie),
      payload: {
        email: memberEmail,
        fullName: "QuickBooks Private Member",
        password: memberPassword,
        role: "member",
      },
    });
    expect(addMember.statusCode).toBe(201);
    const memberSignIn = await app.inject({
      method: "POST",
      url: "/v1/auth/signin",
      payload: { email: memberEmail, password: memberPassword },
    });
    expect(memberSignIn.statusCode).toBe(200);
    const memberHeaders = authHeaders(extractSessionCookie(memberSignIn));

    for (const request of [
      { method: "GET" as const, url: "/v1/integrations/quickbooks/status" },
      { method: "GET" as const, url: "/v1/integrations/quickbooks/quotes/not-a-quote/sync-preview" },
      { method: "GET" as const, url: "/v1/integrations/quickbooks/quotes/not-a-quote/invoice-status" },
      { method: "POST" as const, url: "/v1/integrations/quickbooks/quotes/not-a-quote/push-invoice" },
    ]) {
      const response = await app.inject({ ...request, headers: memberHeaders, payload: request.method === "POST" ? {} : undefined });
      expect(response.statusCode).toBe(403);
      expect(parseJson<{ error: string }>(response)).toEqual({ error: "Only owners or admins can manage QuickBooks." });
      expect(response.body).not.toContain("realm-private-");
    }
  });

  test("fails closed for taxable QuickBooks invoice pushes before provider activity", async () => {
    const session = await signUp("quickbooks-tax-fail-closed");
    const customerResponse = await app.inject({
      method: "POST",
      url: "/v1/customers",
      headers: authHeaders(session.cookie),
      payload: {
        fullName: "Taxable QuickBooks Customer",
        phone: "555-010-1212",
      },
    });
    expect(customerResponse.statusCode).toBe(201);
    const customer = parseJson<CustomerResponse>(customerResponse).customer;
    const quoteResponse = await app.inject({
      method: "POST",
      url: "/v1/quotes",
      headers: authHeaders(session.cookie),
      payload: {
        customerId: customer.id,
        serviceType: "ROOFING",
        title: "Taxable QuickBooks Quote",
        scopeText: "Tax mapping must be implemented before this can be pushed.",
        internalCostSubtotal: 100,
        customerPriceSubtotal: 200,
        taxAmount: 15,
      },
    });
    expect(quoteResponse.statusCode).toBe(201);
    const quote = parseJson<QuoteResponse>(quoteResponse).quote;
    await prisma.quote.update({ where: { id: quote.id }, data: { status: "ACCEPTED" } });
    await prisma.quickBooksConnection.create({
      data: {
        tenantId: session.tenant.id,
        realmId: `realm-tax-${Date.now()}`,
        environment: "sandbox",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/quotes/${quote.id}/push-invoice`,
      headers: authHeaders(session.cookie),
      payload: { force: true },
    });
    expect(response.statusCode).toBe(410);
    expect(parseJson<{ code: string }>(response)).toMatchObject({
      code: "QUICKBOOKS_LEGACY_QUOTE_PUSH_RETIRED",
    });

    const taxableResponse = await app.inject({
      method: "POST",
      url: `/v1/integrations/quickbooks/quotes/${quote.id}/push-invoice`,
      headers: authHeaders(session.cookie),
      payload: {},
    });
    expect(taxableResponse.statusCode).toBe(410);
    expect(parseJson<{ code: string }>(taxableResponse)).toMatchObject({
      code: "QUICKBOOKS_LEGACY_QUOTE_PUSH_RETIRED",
    });
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
