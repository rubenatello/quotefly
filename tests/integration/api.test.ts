import type { FastifyInstance } from "fastify";
import { createHmac } from "crypto";
import Stripe from "stripe";
import twilio from "twilio";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { buildServer } from "../../src/app";
import { env } from "../../src/config/env";
import { prisma } from "../../src/lib/prisma";
import {
  buildTenantEntitlements,
  resolveReconciledSubscriptionPeriod,
  resolveSubscriptionItemBilling,
} from "../../src/lib/subscription";
import { createSignedQuickBooksState } from "../../src/services/quickbooks";

const quickBooksProviderMocks = vi.hoisted(() => ({
  exchangeAuthorizationCode: vi.fn(),
  fetchCompanyInfo: vi.fn(),
}));

const stripeProviderMocks = vi.hoisted(() => ({
  retrieveSubscription: vi.fn(),
  createCustomer: vi.fn(),
  createCheckoutSession: vi.fn(),
}));

vi.mock("stripe", async () => {
  const actual = await vi.importActual<typeof import("stripe")>("stripe");
  class TestStripe extends actual.default {
    constructor(...args: ConstructorParameters<typeof actual.default>) {
      super(...args);
      this.subscriptions.retrieve = stripeProviderMocks.retrieveSubscription as typeof this.subscriptions.retrieve;
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

function stripeSubscriptionFixture(input: {
  id: string;
  customerId: string;
  tenantId: string;
  status: Stripe.Subscription.Status;
  periodEnd?: number;
}): Stripe.Subscription {
  return {
    id: input.id,
    object: "subscription",
    customer: input.customerId,
    status: input.status,
    metadata: { tenantId: input.tenantId },
    trial_start: null,
    trial_end: null,
    items: {
      data: [
        {
          id: `si_${input.id}`,
          object: "subscription_item",
          price: { id: process.env.STRIPE_PRICE_ID_STARTER! },
          current_period_end: input.periodEnd ?? Math.floor(Date.now() / 1000) + 86_400,
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
    stripeProviderMocks.createCustomer.mockReset();
    stripeProviderMocks.createCheckoutSession.mockReset();
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
    const periodEnd = Math.floor(Date.now() / 1000) + 86_400;
    const resolved = resolveSubscriptionItemBilling(
      {
        items: {
          data: [
            { price: { id: "price_unrelated" }, current_period_end: periodEnd + 500 },
            { price: { id: "price_starter" }, current_period_end: periodEnd },
          ],
        },
      } as Stripe.Subscription,
      new Map([["price_starter", "starter"]]),
    );
    expect(resolved.planCode).toBe("starter");
    expect(resolved.currentPeriodEndUtc?.getTime()).toBe(periodEnd * 1000);

    const missingPeriod = resolveSubscriptionItemBilling(
      { items: { data: [{ price: { id: "price_starter" } }] } } as Stripe.Subscription,
      new Map([["price_starter", "starter"]]),
    );
    expect(missingPeriod).toEqual({ planCode: "starter", currentPeriodEndUtc: null });

    const entitlements = buildTenantEntitlements({
      subscriptionStatus: "active",
      subscriptionPlanCode: "starter",
      trialStartsAtUtc: null,
      trialEndsAtUtc: null,
      subscriptionCurrentPeriodEndUtc: null,
    });
    expect(entitlements.hasWorkspaceAccess).toBe(false);
    expect(entitlements.billingRequired).toBe(true);
  });

  test("rejects reconciliation when Stripe customer or tenant metadata bindings mismatch", () => {
    const periodEnd = Math.floor(Date.now() / 1000) + 86_400;
    const subscription = stripeSubscriptionFixture({
      id: "sub_reconciliation_binding",
      customerId: "cus_expected",
      tenantId: "tenant_expected",
      status: "active",
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

  test("refuses duplicate checkout for active subscriptions and live checkout sessions", async () => {
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
    const pendingResponse = await app.inject({
      method: "POST",
      url: "/v1/billing/checkout-session",
      headers: authHeaders(pending.cookie),
      payload: { planCode: "starter" },
    });
    expect(pendingResponse.statusCode).toBe(409);
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
