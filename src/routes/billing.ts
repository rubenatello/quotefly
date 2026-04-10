import { Prisma } from "@prisma/client";
import { FastifyPluginAsync, FastifyRequest } from "fastify";
import Stripe from "stripe";
import { z } from "zod";
import { getJwtClaims } from "../lib/auth";

const PlanCodeSchema = z.enum(["starter", "professional", "enterprise"]);

const CreateCheckoutSessionSchema = z.object({
  planCode: PlanCodeSchema,
});

type PlanCode = z.infer<typeof PlanCodeSchema>;
type StripeClient = any;

interface StripeCheckoutSessionLike {
  id: string;
  url: string | null;
  customer?: string | { id: string } | null;
  subscription?: string | { id: string } | null;
  metadata?: Record<string, string> | null;
  client_reference_id?: string | null;
}

interface StripeSubscriptionLike {
  id: string;
  customer: string | { id: string };
  status: string;
  metadata?: Record<string, string>;
  trial_start?: number | null;
  trial_end?: number | null;
  current_period_end?: number | null;
  items: {
    data: Array<{
      price?: {
        id?: string;
      };
    }>;
  };
}

interface StripeInvoiceLike {
  customer?: string | { id: string } | null;
  subscription?: string | { id: string } | null;
}

interface StripeEventLike {
  id: string;
  type: string;
  data: {
    object: unknown;
  };
}

const SUPPORTED_EVENTS = new Set<string>([
  "checkout.session.completed",
  "checkout.session.expired",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
]);

function createStripeClient(secretKey: string): StripeClient {
  const StripeConstructor = Stripe as unknown as {
    new (key: string, config?: Record<string, unknown>): StripeClient;
  };

  return new StripeConstructor(secretKey, {
    apiVersion: "2026-03-25.dahlia",
  });
}

function getPriceIdForPlan(app: Parameters<FastifyPluginAsync>[0], planCode: PlanCode): string {
  if (planCode === "starter") return app.env.STRIPE_PRICE_ID_STARTER;
  if (planCode === "professional") return app.env.STRIPE_PRICE_ID_PROFESSIONAL;
  return app.env.STRIPE_PRICE_ID_ENTERPRISE;
}

function planCodeFromPriceId(app: Parameters<FastifyPluginAsync>[0], priceId: string | null): PlanCode | null {
  if (!priceId) return null;
  if (priceId === app.env.STRIPE_PRICE_ID_STARTER) return "starter";
  if (priceId === app.env.STRIPE_PRICE_ID_PROFESSIONAL) return "professional";
  if (priceId === app.env.STRIPE_PRICE_ID_ENTERPRISE) return "enterprise";
  return null;
}

function unixToDate(value: number | null | undefined): Date | null {
  if (!value) return null;
  return new Date(value * 1000);
}

function asStripeCustomerId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

function asStripeSubscriptionId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

async function findTenantByCustomerId(app: Parameters<FastifyPluginAsync>[0], stripeCustomerId: string) {
  return app.prisma.tenant.findFirst({
    where: {
      stripeCustomerId,
      deletedAtUtc: null,
    },
    select: { id: true },
  });
}

async function syncTenantFromSubscription(
  app: Parameters<FastifyPluginAsync>[0],
  subscription: StripeSubscriptionLike,
  tenantHintId?: string,
) {
  const stripeCustomerId = asStripeCustomerId(subscription.customer);
  if (!stripeCustomerId) return null;

  const tenant = tenantHintId
    ? await app.prisma.tenant.findFirst({
        where: { id: tenantHintId, deletedAtUtc: null },
        select: { id: true },
      })
    : await findTenantByCustomerId(app, stripeCustomerId);

  if (!tenant) {
    return null;
  }

  const primaryPriceId = subscription.items.data[0]?.price?.id ?? null;
  const planCode = planCodeFromPriceId(app, primaryPriceId);

  await app.prisma.tenant.update({
    where: { id: tenant.id },
    data: {
      stripeCustomerId,
      stripeSubscriptionId: subscription.id,
      subscriptionStatus: subscription.status,
      subscriptionPlanCode: planCode,
      trialStartsAtUtc: unixToDate(subscription.trial_start),
      trialEndsAtUtc: unixToDate(subscription.trial_end),
      subscriptionCurrentPeriodEndUtc: unixToDate(subscription.current_period_end),
    },
  });

  return tenant.id;
}

async function updateTenantFromInvoice(
  app: Parameters<FastifyPluginAsync>[0],
  invoice: StripeInvoiceLike,
  status: "active" | "past_due",
) {
  const stripeCustomerId = asStripeCustomerId(invoice.customer);
  if (!stripeCustomerId) return null;

  const tenant = await findTenantByCustomerId(app, stripeCustomerId);
  if (!tenant) return null;

  await app.prisma.tenant.update({
    where: { id: tenant.id },
    data: {
      subscriptionStatus: status,
      stripeCustomerId,
    },
  });

  return tenant.id;
}

async function handleStripeEvent(app: Parameters<FastifyPluginAsync>[0], stripe: StripeClient, event: StripeEventLike) {
  if (!SUPPORTED_EVENTS.has(event.type)) {
    return null;
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as StripeCheckoutSessionLike;
    const tenantHintId = session.metadata?.tenantId ?? session.client_reference_id ?? undefined;

    const stripeCustomerId = asStripeCustomerId(session.customer);

    if (tenantHintId && stripeCustomerId) {
      await app.prisma.tenant.update({
        where: { id: tenantHintId },
        data: { stripeCustomerId },
      });
    }

    const stripeSubscriptionId = asStripeSubscriptionId(session.subscription);

    if (stripeSubscriptionId) {
      const subscription = (await stripe.subscriptions.retrieve(
        stripeSubscriptionId,
      )) as StripeSubscriptionLike;
      return syncTenantFromSubscription(app, subscription, tenantHintId);
    }

    return tenantHintId ?? null;
  }

  if (event.type === "checkout.session.expired") {
    const session = event.data.object as StripeCheckoutSessionLike;
    const tenantHintId = session.metadata?.tenantId ?? session.client_reference_id ?? undefined;
    if (!tenantHintId) return null;

    await app.prisma.tenant.update({
      where: { id: tenantHintId },
      data: { subscriptionStatus: "checkout_expired" },
    });
    return tenantHintId;
  }

  if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    const subscription = event.data.object as StripeSubscriptionLike;
    const tenantHintId = subscription.metadata?.tenantId;
    return syncTenantFromSubscription(app, subscription, tenantHintId);
  }

  if (event.type === "invoice.paid") {
    const invoice = event.data.object as StripeInvoiceLike;

    const stripeSubscriptionId = asStripeSubscriptionId(invoice.subscription);

    if (stripeSubscriptionId) {
      const subscription = (await stripe.subscriptions.retrieve(
        stripeSubscriptionId,
      )) as StripeSubscriptionLike;
      return syncTenantFromSubscription(app, subscription);
    }

    return updateTenantFromInvoice(app, invoice, "active");
  }

  if (event.type === "invoice.payment_failed") {
    const invoice = event.data.object as StripeInvoiceLike;

    const stripeSubscriptionId = asStripeSubscriptionId(invoice.subscription);

    if (stripeSubscriptionId) {
      const subscription = (await stripe.subscriptions.retrieve(
        stripeSubscriptionId,
      )) as StripeSubscriptionLike;
      const tenantId = await syncTenantFromSubscription(app, subscription);
      if (tenantId) {
        await app.prisma.tenant.update({
          where: { id: tenantId },
          data: { subscriptionStatus: "past_due" },
        });
      }
      return tenantId;
    }

    return updateTenantFromInvoice(app, invoice, "past_due");
  }

  return null;
}

function getStripeSignature(request: FastifyRequest): string | null {
  const raw = request.headers["stripe-signature"];
  if (!raw) return null;
  return Array.isArray(raw) ? raw[0] : raw;
}

function getRawBody(request: FastifyRequest): string | null {
  const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody;
  return typeof rawBody === "string" ? rawBody : null;
}

function buildAppUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\//, ""), normalizedBase).toString();
}

export const billingRoutes: FastifyPluginAsync = async (app) => {
  app.post("/billing/checkout-session", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!app.env.STRIPE_SECRET_KEY) {
      return reply.code(503).send({ error: "Stripe is not configured." });
    }

    const claims = getJwtClaims(request);
    const payload = CreateCheckoutSessionSchema.parse(request.body);

    const tenant = await app.prisma.tenant.findFirst({
      where: {
        id: claims.tenantId,
        deletedAtUtc: null,
        users: { some: { userId: claims.userId } },
      },
      select: {
        id: true,
        name: true,
        stripeCustomerId: true,
      },
    });

    if (!tenant) {
      return reply.code(404).send({ error: "Tenant not found for account." });
    }

    const priceId = getPriceIdForPlan(app, payload.planCode);
    if (!priceId || !priceId.startsWith("price_")) {
      return reply.code(400).send({ error: `Stripe price id is not configured for plan '${payload.planCode}'.` });
    }

    const stripe = createStripeClient(app.env.STRIPE_SECRET_KEY);

    let stripeCustomerId = tenant.stripeCustomerId;
    if (!stripeCustomerId) {
      const customer = (await stripe.customers.create({
        name: tenant.name,
        email: claims.email,
        metadata: { tenantId: tenant.id },
      })) as { id: string };
      stripeCustomerId = customer.id;

      await app.prisma.tenant.update({
        where: { id: tenant.id },
        data: { stripeCustomerId },
      });
    }

    const checkoutSession = (await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: tenant.id,
      success_url: buildAppUrl(app.env.APP_URL, "/app/admin?billing=success"),
      cancel_url: buildAppUrl(app.env.APP_URL, "/app/admin?billing=cancel"),
      allow_promotion_codes: true,
      metadata: {
        tenantId: tenant.id,
        planCode: payload.planCode,
      },
      subscription_data: {
        metadata: {
          tenantId: tenant.id,
          planCode: payload.planCode,
        },
      },
    })) as StripeCheckoutSessionLike;

    return {
      sessionId: checkoutSession.id,
      checkoutUrl: checkoutSession.url,
    };
  });

  app.post("/billing/portal-session", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!app.env.STRIPE_SECRET_KEY) {
      return reply.code(503).send({ error: "Stripe is not configured." });
    }

    const claims = getJwtClaims(request);

    const tenant = await app.prisma.tenant.findFirst({
      where: {
        id: claims.tenantId,
        deletedAtUtc: null,
        users: { some: { userId: claims.userId } },
      },
      select: {
        id: true,
        stripeCustomerId: true,
      },
    });

    if (!tenant) {
      return reply.code(404).send({ error: "Tenant not found for account." });
    }

    if (!tenant.stripeCustomerId) {
      return reply.code(400).send({ error: "No Stripe customer exists for tenant yet." });
    }

    const stripe = createStripeClient(app.env.STRIPE_SECRET_KEY);
    const portalSession = (await stripe.billingPortal.sessions.create({
      customer: tenant.stripeCustomerId,
      return_url: buildAppUrl(app.env.APP_URL, "/app/admin?billing=portal"),
    })) as { url: string };

    return { url: portalSession.url };
  });

  app.post(
    "/billing/webhook",
    { config: { rawBody: true } },
    async (request, reply) => {
      if (!app.env.STRIPE_SECRET_KEY || !app.env.STRIPE_WEBHOOK_SECRET) {
        return reply.code(503).send({ error: "Stripe webhook is not configured." });
      }

      const signature = getStripeSignature(request);
      if (!signature) {
        return reply.code(400).send({ error: "Missing Stripe signature." });
      }

      const rawBody = getRawBody(request);
      if (!rawBody) {
        return reply.code(400).send({ error: "Missing raw webhook body." });
      }

      const stripe = createStripeClient(app.env.STRIPE_SECRET_KEY);

      let event: StripeEventLike;
      try {
        event = stripe.webhooks.constructEvent(rawBody, signature, app.env.STRIPE_WEBHOOK_SECRET) as StripeEventLike;
      } catch {
        return reply.code(400).send({ error: "Invalid webhook signature." });
      }

      const existingEvent = await app.prisma.billingWebhookEvent.findUnique({
        where: { stripeEventId: event.id },
        select: { id: true },
      });

      if (existingEvent) {
        return { received: true, duplicate: true };
      }

      const tenantId = await handleStripeEvent(app, stripe, event);

      await app.prisma.billingWebhookEvent.create({
        data: {
          stripeEventId: event.id,
          eventType: event.type,
          tenantId,
          payload: event as unknown as Prisma.InputJsonValue,
        },
      });

      return { received: true };
    },
  );
};
