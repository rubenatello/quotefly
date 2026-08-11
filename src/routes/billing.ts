import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { FastifyPluginAsync, FastifyRequest } from "fastify";
import Stripe from "stripe";
import { z } from "zod";
import { getJwtClaims } from "../lib/auth";
import { resolveSubscriptionItemBilling } from "../lib/subscription";

const PlanCodeSchema = z.enum(["starter", "professional", "enterprise"]);
const SELLABLE_PLAN_CODES = new Set<PlanCode>(["starter"]);
const BLOCKING_SUBSCRIPTION_STATUSES = new Set([
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "incomplete",
  "paused",
]);
const CHECKOUT_ELIGIBLE_SUBSCRIPTION_WHERE: Prisma.TenantWhereInput = {
  OR: [
    { subscriptionStatus: { notIn: [...BLOCKING_SUBSCRIPTION_STATUSES] } },
    // QuoteFly's signup trial is tracked locally until a Stripe subscription
    // exists. Those tenants must remain able to start checkout.
    { subscriptionStatus: "trialing", stripeSubscriptionId: null },
  ],
};
const STRIPE_CHECKOUT_EXPIRATION_MS = 60 * 60 * 1000;
const STRIPE_CHECKOUT_MINIMUM_REMAINING_MS = 30 * 60 * 1000;
const STRIPE_MINIMUM_TRIAL_LEAD_MS = 48 * 60 * 60 * 1000 + 5 * 60 * 1000;
const WEBHOOK_PROCESSING_LEASE_MS = 5 * 60 * 1000;

const CreateCheckoutSessionSchema = z.object({
  planCode: PlanCodeSchema,
});

type PlanCode = z.infer<typeof PlanCodeSchema>;
type App = Parameters<FastifyPluginAsync>[0];
type BillingEventMarker = {
  eventCreatedAtUtc: Date;
  eventId: string;
};
type SubscriptionSyncResult = { tenantId: string | null; applied: boolean };
type WebhookReservation =
  | { state: "PROCESS"; leaseToken: string }
  | { state: "DUPLICATE" }
  | { state: "BUSY" };
type BillingDb = Pick<Prisma.TransactionClient, "tenant" | "billingWebhookEvent">;
type PreparedStripeEvent =
  | { kind: "NOOP"; tenantId: string | null }
  | { kind: "CHECKOUT_EXPIRED"; tenantId: string; checkoutSessionId: string }
  | {
      kind: "SYNC_SUBSCRIPTION";
      subscription: Stripe.Subscription;
      tenantHintId?: string;
      completedCheckoutSessionId?: string;
    };

class WebhookLeaseLostError extends Error {
  constructor() {
    super("Stripe webhook processing lease was reclaimed.");
    this.name = "WebhookLeaseLostError";
  }
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

function createStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey, { apiVersion: "2026-06-24.dahlia" });
}

function getPriceIdForPlan(app: App, planCode: PlanCode): string {
  if (planCode === "starter") return app.env.STRIPE_PRICE_ID_STARTER;
  if (planCode === "professional") return app.env.STRIPE_PRICE_ID_PROFESSIONAL;
  return app.env.STRIPE_PRICE_ID_ENTERPRISE;
}

function configuredPricePlans(app: App): ReadonlyMap<string, PlanCode> {
  return new Map(
    (["starter", "professional", "enterprise"] as const)
      .map((planCode) => [getPriceIdForPlan(app, planCode), planCode] as const)
      .filter(([priceId]) => Boolean(priceId)),
  );
}

function unixToDate(value: number | null | undefined): Date | null {
  if (!value) return null;
  return new Date(value * 1000);
}

function asStripeId(value: string | { id?: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id ?? null;
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  if (invoice.parent?.type !== "subscription_details") return null;
  return asStripeId(invoice.parent.subscription_details?.subscription);
}

function markerForEvent(event: Stripe.Event): BillingEventMarker {
  return { eventCreatedAtUtc: new Date(event.created * 1000), eventId: event.id };
}

function eventMarkerCanApplyWhere(marker: BillingEventMarker, canonicalSubscriptionId: string): Prisma.TenantWhereInput {
  return {
    OR: [
      { billingStateEventCreatedAtUtc: null },
      { billingStateEventCreatedAtUtc: { lt: marker.eventCreatedAtUtc } },
      {
        billingStateEventCreatedAtUtc: marker.eventCreatedAtUtc,
        OR: [
          { billingStateEventId: marker.eventId },
          { stripeSubscriptionId: null },
          { stripeSubscriptionId: canonicalSubscriptionId },
        ],
      },
    ],
  };
}

function webhookAuditEnvelope(event: Stripe.Event): Prisma.InputJsonObject {
  const object = event.data.object as {
    id?: string;
    object?: string;
    customer?: string | { id?: string } | null;
    subscription?: string | { id?: string } | null;
    client_reference_id?: string | null;
    metadata?: Record<string, string> | null;
    parent?: { subscription_details?: { subscription?: string | { id?: string } | null } | null } | null;
  };
  const envelope: Record<string, Prisma.InputJsonValue> = {
    version: 1,
    eventId: event.id,
    eventType: event.type,
  };
  if (Number.isFinite(event.created)) envelope.created = event.created;
  if (object.id) envelope.objectId = object.id;
  if (object.object) envelope.objectType = object.object;
  const tenantHintId = object.metadata?.tenantId ?? object.client_reference_id ?? null;
  if (tenantHintId) envelope.tenantHintId = tenantHintId;
  const customerId = asStripeId(object.customer);
  if (customerId) envelope.customerId = customerId;
  const subscriptionId =
    asStripeId(object.subscription) ?? asStripeId(object.parent?.subscription_details?.subscription);
  if (subscriptionId) envelope.subscriptionId = subscriptionId;
  return envelope;
}

async function findTenantByCustomerId(db: BillingDb, stripeCustomerId: string) {
  return db.tenant.findUnique({
    where: { stripeCustomerId, deletedAtUtc: null },
    select: { id: true },
  });
}

async function syncTenantFromSubscription(
  app: App,
  db: BillingDb,
  subscription: Stripe.Subscription,
  marker: BillingEventMarker,
  tenantHintId?: string,
  completedCheckoutSessionId?: string,
): Promise<SubscriptionSyncResult> {
  const stripeCustomerId = asStripeId(subscription.customer);
  if (!stripeCustomerId) return { tenantId: null, applied: false };

  const tenant = tenantHintId
    ? await db.tenant.findFirst({
        where: {
          id: tenantHintId,
          deletedAtUtc: null,
          OR: [{ stripeCustomerId: null }, { stripeCustomerId }],
        },
        select: { id: true },
      })
    : await findTenantByCustomerId(db, stripeCustomerId);
  if (!tenant) return { tenantId: null, applied: false };

  const billing = resolveSubscriptionItemBilling(subscription, configuredPricePlans(app));
  const incomingCanReplaceInactiveSubscription =
    subscription.status === "active" || subscription.status === "trialing";
  const subscriptionBindingWhere: Prisma.TenantWhereInput = {
    OR: [
      { stripeSubscriptionId: null },
      { stripeSubscriptionId: subscription.id },
      ...(incomingCanReplaceInactiveSubscription
        ? [{ subscriptionStatus: { notIn: ["active", "trialing"] } }]
        : []),
    ],
  };
  const updated = await db.tenant.updateMany({
    where: {
      id: tenant.id,
      deletedAtUtc: null,
      OR: [{ stripeCustomerId: null }, { stripeCustomerId }],
      AND: [eventMarkerCanApplyWhere(marker, subscription.id), subscriptionBindingWhere],
    },
    data: {
      stripeCustomerId,
      stripeSubscriptionId: subscription.id,
      subscriptionStatus: subscription.status,
      subscriptionPlanCode: billing.planCode,
      trialStartsAtUtc: unixToDate(subscription.trial_start),
      trialEndsAtUtc: unixToDate(subscription.trial_end),
      subscriptionCurrentPeriodEndUtc: billing.currentPeriodEndUtc,
      billingStateEventCreatedAtUtc: marker.eventCreatedAtUtc,
      billingStateEventId: marker.eventId,
    },
  });
  if (completedCheckoutSessionId && updated.count === 1) {
    await db.tenant.updateMany({
      where: { id: tenant.id, stripeCheckoutSessionId: completedCheckoutSessionId },
      data: {
        stripeCheckoutSessionId: null,
        stripeCheckoutSessionExpiresAtUtc: null,
        stripeCheckoutAttemptId: null,
        stripeCheckoutAttemptExpiresAtUtc: null,
      },
    });
  }
  return { tenantId: tenant.id, applied: updated.count === 1 };
}

async function prepareStripeEvent(app: App, stripe: Stripe, event: Stripe.Event): Promise<PreparedStripeEvent> {
  if (!SUPPORTED_EVENTS.has(event.type)) return { kind: "NOOP", tenantId: null };

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const tenantHintId = session.metadata?.tenantId ?? session.client_reference_id ?? undefined;
    const subscriptionId = asStripeId(session.subscription);
    if (!subscriptionId) return { kind: "NOOP", tenantId: tenantHintId ?? null };

    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    return {
      kind: "SYNC_SUBSCRIPTION",
      subscription,
      tenantHintId,
      completedCheckoutSessionId: session.id,
    };
  }

  if (event.type === "checkout.session.expired") {
    const session = event.data.object as Stripe.Checkout.Session;
    const tenantHintId = session.metadata?.tenantId ?? session.client_reference_id ?? undefined;
    if (!tenantHintId) return { kind: "NOOP", tenantId: null };
    return { kind: "CHECKOUT_EXPIRED", tenantId: tenantHintId, checkoutSessionId: session.id };
  }

  if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    const eventSubscription = event.data.object as Stripe.Subscription;
    const subscription = await stripe.subscriptions.retrieve(eventSubscription.id);
    return {
      kind: "SYNC_SUBSCRIPTION",
      subscription,
      tenantHintId: subscription.metadata.tenantId ?? eventSubscription.metadata.tenantId,
    };
  }

  const invoice = event.data.object as Stripe.Invoice;
  const stripeCustomerId = asStripeId(invoice.customer);
  if (!stripeCustomerId) return { kind: "NOOP", tenantId: null };
  const tenant = await app.prisma.tenant.findUnique({
    where: { stripeCustomerId, deletedAtUtc: null },
    select: { id: true, stripeSubscriptionId: true },
  });
  if (!tenant) return { kind: "NOOP", tenantId: null };
  const canonicalSubscriptionId = tenant.stripeSubscriptionId ?? invoiceSubscriptionId(invoice);
  if (!canonicalSubscriptionId) return { kind: "NOOP", tenantId: tenant.id };

  const subscription = await stripe.subscriptions.retrieve(canonicalSubscriptionId);
  return { kind: "SYNC_SUBSCRIPTION", subscription, tenantHintId: tenant.id };
}

async function applyPreparedStripeEvent(
  app: App,
  db: BillingDb,
  event: Stripe.Event,
  prepared: PreparedStripeEvent,
): Promise<string | null> {
  if (prepared.kind === "NOOP") return prepared.tenantId;

  if (prepared.kind === "CHECKOUT_EXPIRED") {
    const result = await db.tenant.updateMany({
      where: {
        id: prepared.tenantId,
        deletedAtUtc: null,
        stripeCheckoutSessionId: prepared.checkoutSessionId,
        stripeSubscriptionId: null,
      },
      data: {
        stripeCheckoutSessionId: null,
        stripeCheckoutSessionExpiresAtUtc: null,
        stripeCheckoutAttemptId: null,
        stripeCheckoutAttemptExpiresAtUtc: null,
      },
    });
    return result.count > 0 ? prepared.tenantId : null;
  }

  const synced = await syncTenantFromSubscription(
    app,
    db,
    prepared.subscription,
    markerForEvent(event),
    prepared.tenantHintId,
    prepared.completedCheckoutSessionId,
  );
  return synced.tenantId;
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

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function hasBlockingStripeSubscription(subscriptionStatus: string, stripeSubscriptionId: string | null): boolean {
  if (subscriptionStatus.toLowerCase() === "trialing" && !stripeSubscriptionId) return false;
  return BLOCKING_SUBSCRIPTION_STATUSES.has(subscriptionStatus.toLowerCase());
}

function safeWebhookError(error: unknown): string {
  if (error instanceof Error) return error.name.slice(0, 200) || "WebhookProcessingError";
  return "WebhookProcessingError";
}

async function reserveWebhookEvent(app: App, event: Stripe.Event): Promise<WebhookReservation> {
  const now = new Date();
  const leaseToken = randomUUID();
  try {
    await app.prisma.billingWebhookEvent.create({
      data: {
        stripeEventId: event.id,
        eventType: event.type,
        payload: webhookAuditEnvelope(event),
        status: "PROCESSING",
        attemptCount: 1,
        processingLeaseToken: leaseToken,
        stripeCreatedAtUtc: unixToDate(event.created),
        lastAttemptAtUtc: now,
      },
    });
    return { state: "PROCESS", leaseToken };
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
  }

  const existing = await app.prisma.billingWebhookEvent.findUniqueOrThrow({
    where: { stripeEventId: event.id },
    select: { status: true, lastAttemptAtUtc: true },
  });
  if (existing.status === "SUCCEEDED") return { state: "DUPLICATE" };

  const leaseCutoff = new Date(now.getTime() - WEBHOOK_PROCESSING_LEASE_MS);
  if (existing.status === "PROCESSING" && existing.lastAttemptAtUtc && existing.lastAttemptAtUtc > leaseCutoff) {
    return { state: "BUSY" };
  }

  const reclaimed = await app.prisma.billingWebhookEvent.updateMany({
    where: {
      stripeEventId: event.id,
      OR: [
        { status: "FAILED" },
        { status: "PROCESSING", OR: [{ lastAttemptAtUtc: null }, { lastAttemptAtUtc: { lte: leaseCutoff } }] },
      ],
    },
    data: {
      status: "PROCESSING",
      attemptCount: { increment: 1 },
      processingLeaseToken: leaseToken,
      lastAttemptAtUtc: now,
      failedAtUtc: null,
      lastError: null,
    },
  });
  return reclaimed.count === 1 ? { state: "PROCESS", leaseToken } : { state: "BUSY" };
}

export const billingRoutes: FastifyPluginAsync = async (app) => {
  app.post("/billing/checkout-session", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!app.env.STRIPE_SECRET_KEY) return reply.code(503).send({ error: "Stripe is not configured." });

    const claims = getJwtClaims(request);
    const payload = CreateCheckoutSessionSchema.parse(request.body);
    if (!SELLABLE_PLAN_CODES.has(payload.planCode)) {
      return reply.code(409).send({
        error: "Basic is the only plan available for launch. Professional and Enterprise are coming soon.",
      });
    }

    const tenant = await app.prisma.tenant.findFirst({
      where: {
        id: claims.tenantId,
        deletedAtUtc: null,
        users: { some: { userId: claims.userId, role: "owner", deletedAtUtc: null, user: { deletedAtUtc: null } } },
      },
      select: {
        id: true,
        name: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        subscriptionStatus: true,
        stripeCheckoutSessionId: true,
        stripeCheckoutSessionExpiresAtUtc: true,
        stripeCheckoutAttemptId: true,
        stripeCheckoutAttemptExpiresAtUtc: true,
        trialEndsAtUtc: true,
      },
    });
    if (!tenant) return reply.code(403).send({ error: "Only an active workspace owner can manage billing." });

    const priceId = getPriceIdForPlan(app, payload.planCode);
    if (!priceId || !priceId.startsWith("price_")) {
      return reply.code(400).send({ error: `Stripe price id is not configured for plan '${payload.planCode}'.` });
    }

    const now = new Date();
    const stripe = createStripeClient(app.env.STRIPE_SECRET_KEY);
    if (hasBlockingStripeSubscription(tenant.subscriptionStatus, tenant.stripeSubscriptionId)) {
      return reply.code(409).send({ error: "A subscription already exists. Use billing management to change it." });
    }
    if (tenant.stripeCheckoutSessionId && tenant.stripeCheckoutSessionExpiresAtUtc && tenant.stripeCheckoutSessionExpiresAtUtc > now) {
      try {
        const existingCheckout = await stripe.checkout.sessions.retrieve(tenant.stripeCheckoutSessionId);
        if (existingCheckout.status === "open" && existingCheckout.url) {
          return { sessionId: existingCheckout.id, checkoutUrl: existingCheckout.url, reused: true };
        }
        if (existingCheckout.status === "complete") {
          return reply.code(409).send({ error: "Checkout completed. Refresh billing status to continue." });
        }

        await app.prisma.tenant.updateMany({
          where: {
            id: tenant.id,
            stripeCheckoutSessionId: tenant.stripeCheckoutSessionId,
            stripeSubscriptionId: null,
          },
          data: {
            stripeCheckoutSessionId: null,
            stripeCheckoutSessionExpiresAtUtc: null,
          },
        });
      } catch (error) {
        request.log.warn(
          {
            errorType: safeWebhookError(error),
            tenantId: tenant.id,
            checkoutSessionId: tenant.stripeCheckoutSessionId,
          },
          "Unable to resume Stripe checkout session.",
        );
        return reply.code(503).send({ error: "Billing checkout could not be resumed. Please try again shortly." });
      }
    }

    let attemptId =
      tenant.stripeCheckoutAttemptId &&
      tenant.stripeCheckoutAttemptExpiresAtUtc &&
      tenant.stripeCheckoutAttemptExpiresAtUtc > now
        ? tenant.stripeCheckoutAttemptId
        : null;
    let attemptExpiresAt = attemptId ? tenant.stripeCheckoutAttemptExpiresAtUtc : null;
    if (!attemptId) {
      const candidate = randomUUID();
      const candidateExpiresAt = new Date(
        Math.floor((now.getTime() + STRIPE_CHECKOUT_EXPIRATION_MS) / 1000) * 1000,
      );
      const reserved = await app.prisma.tenant.updateMany({
        where: {
          id: tenant.id,
          AND: [
            CHECKOUT_ELIGIBLE_SUBSCRIPTION_WHERE,
            { OR: [{ stripeCheckoutSessionId: null }, { stripeCheckoutSessionExpiresAtUtc: { lte: now } }] },
            { OR: [{ stripeCheckoutAttemptId: null }, { stripeCheckoutAttemptExpiresAtUtc: { lte: now } }] },
          ],
        },
        data: {
          stripeCheckoutSessionId: null,
          stripeCheckoutSessionExpiresAtUtc: null,
          stripeCheckoutAttemptId: candidate,
          stripeCheckoutAttemptExpiresAtUtc: candidateExpiresAt,
        },
      });
      if (reserved.count === 1) {
        attemptId = candidate;
        attemptExpiresAt = candidateExpiresAt;
      } else {
        const current = await app.prisma.tenant.findUniqueOrThrow({
          where: { id: tenant.id },
          select: {
            stripeSubscriptionId: true,
            subscriptionStatus: true,
            stripeCheckoutSessionId: true,
            stripeCheckoutSessionExpiresAtUtc: true,
            stripeCheckoutAttemptId: true,
            stripeCheckoutAttemptExpiresAtUtc: true,
          },
        });
        if (hasBlockingStripeSubscription(current.subscriptionStatus, current.stripeSubscriptionId)) {
          return reply.code(409).send({ error: "A subscription already exists. Use billing management to change it." });
        }
        if (current.stripeCheckoutSessionId && current.stripeCheckoutSessionExpiresAtUtc && current.stripeCheckoutSessionExpiresAtUtc > now) {
          return reply.code(409).send({ error: "A checkout is already in progress." });
        }
        attemptId = current.stripeCheckoutAttemptId;
        attemptExpiresAt = current.stripeCheckoutAttemptExpiresAtUtc;
      }
    }
    if (!attemptId || !attemptExpiresAt) {
      return reply.code(409).send({ error: "Billing checkout is already being prepared. Please retry." });
    }
    if (attemptExpiresAt.getTime() - Date.now() < STRIPE_CHECKOUT_MINIMUM_REMAINING_MS) {
      return reply.code(409).send({ error: "Billing checkout is expiring. Please retry shortly." });
    }

    let stripeCustomerId = tenant.stripeCustomerId;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create(
        { name: tenant.name, email: claims.email, metadata: { tenantId: tenant.id } },
        { idempotencyKey: `quotefly:tenant:${tenant.id}:customer:v1` },
      );
      await app.prisma.tenant.updateMany({
        where: { id: tenant.id, stripeCustomerId: null },
        data: { stripeCustomerId: customer.id },
      });
      const current = await app.prisma.tenant.findUniqueOrThrow({
        where: { id: tenant.id },
        select: { stripeCustomerId: true },
      });
      stripeCustomerId = current.stripeCustomerId;
    }
    if (!stripeCustomerId) throw new Error("Stripe customer reservation failed.");

    const remainingInternalTrialEnd =
      tenant.subscriptionStatus.toLowerCase() === "trialing" &&
      !tenant.stripeSubscriptionId &&
      tenant.trialEndsAtUtc &&
      tenant.trialEndsAtUtc > now
        ? Math.ceil(
            Math.max(
              tenant.trialEndsAtUtc.getTime(),
              now.getTime() + STRIPE_MINIMUM_TRIAL_LEAD_MS,
            ) / 1000,
          )
        : undefined;
    const checkoutSession = await stripe.checkout.sessions.create(
      {
        mode: "subscription",
        customer: stripeCustomerId,
        line_items: [{ price: priceId, quantity: 1 }],
        client_reference_id: tenant.id,
        success_url: buildAppUrl(
          app.env.APP_URL,
          "/app/settings?billing=success&session_id={CHECKOUT_SESSION_ID}",
        ),
        cancel_url: buildAppUrl(app.env.APP_URL, "/app/settings?billing=cancel"),
        allow_promotion_codes: true,
        expires_at: Math.floor(attemptExpiresAt.getTime() / 1000),
        metadata: { tenantId: tenant.id, planCode: payload.planCode },
        subscription_data: {
          metadata: { tenantId: tenant.id, planCode: payload.planCode },
          ...(remainingInternalTrialEnd ? { trial_end: remainingInternalTrialEnd } : {}),
        },
      },
      { idempotencyKey: `quotefly:tenant:${tenant.id}:checkout:${attemptId}` },
    );

    const persistedSession = await app.prisma.tenant.updateMany({
      where: {
        id: tenant.id,
        stripeCheckoutAttemptId: attemptId,
        AND: [CHECKOUT_ELIGIBLE_SUBSCRIPTION_WHERE],
      },
      data: {
        stripeCheckoutSessionId: checkoutSession.id,
        stripeCheckoutSessionExpiresAtUtc: unixToDate(checkoutSession.expires_at),
        stripeCheckoutAttemptId: null,
        stripeCheckoutAttemptExpiresAtUtc: null,
      },
    });
    if (persistedSession.count !== 1) {
      const canonical = await app.prisma.tenant.findUniqueOrThrow({
        where: { id: tenant.id },
        select: {
          subscriptionStatus: true,
          stripeCheckoutSessionId: true,
          stripeCheckoutSessionExpiresAtUtc: true,
        },
      });
      if (
        canonical.stripeCheckoutSessionId !== checkoutSession.id ||
        !canonical.stripeCheckoutSessionExpiresAtUtc ||
        canonical.stripeCheckoutSessionExpiresAtUtc <= new Date()
      ) {
        return reply.code(409).send({ error: "Billing state changed while checkout was prepared. Please retry." });
      }
    }
    return { sessionId: checkoutSession.id, checkoutUrl: checkoutSession.url };
  });

  app.post("/billing/portal-session", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!app.env.STRIPE_SECRET_KEY) return reply.code(503).send({ error: "Stripe is not configured." });
    const claims = getJwtClaims(request);
    const tenant = await app.prisma.tenant.findFirst({
      where: {
        id: claims.tenantId,
        deletedAtUtc: null,
        users: { some: { userId: claims.userId, role: "owner", deletedAtUtc: null, user: { deletedAtUtc: null } } },
      },
      select: { id: true, stripeCustomerId: true },
    });
    if (!tenant) return reply.code(403).send({ error: "Only an active workspace owner can manage billing." });
    if (!tenant.stripeCustomerId) return reply.code(400).send({ error: "No Stripe customer exists for tenant yet." });

    const stripe = createStripeClient(app.env.STRIPE_SECRET_KEY);
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: tenant.stripeCustomerId,
      return_url: buildAppUrl(app.env.APP_URL, "/app/settings?billing=portal"),
    });
    return { url: portalSession.url };
  });

  app.post("/billing/webhook", { config: { rawBody: true } }, async (request, reply) => {
    if (!app.env.STRIPE_SECRET_KEY || !app.env.STRIPE_WEBHOOK_SECRET) {
      return reply.code(503).send({ error: "Stripe webhook is not configured." });
    }
    const signature = getStripeSignature(request);
    if (!signature) return reply.code(400).send({ error: "Missing Stripe signature." });
    const rawBody = getRawBody(request);
    if (!rawBody) return reply.code(400).send({ error: "Missing raw webhook body." });

    const stripe = createStripeClient(app.env.STRIPE_SECRET_KEY);
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, app.env.STRIPE_WEBHOOK_SECRET);
    } catch {
      return reply.code(400).send({ error: "Invalid webhook signature." });
    }

    const reservation = await reserveWebhookEvent(app, event);
    if (reservation.state === "DUPLICATE") return { received: true, duplicate: true };
    if (reservation.state === "BUSY") {
      return reply.code(503).send({ error: "Webhook processing is already in progress. Retry later." });
    }

    try {
      const prepared = await prepareStripeEvent(app, stripe, event);
      await app.prisma.$transaction(async (tx) => {
        const leaseRenewed = await tx.billingWebhookEvent.updateMany({
          where: {
            stripeEventId: event.id,
            status: "PROCESSING",
            processingLeaseToken: reservation.leaseToken,
          },
          data: { lastAttemptAtUtc: new Date() },
        });
        if (leaseRenewed.count !== 1) throw new WebhookLeaseLostError();

        const tenantId = await applyPreparedStripeEvent(app, tx, event, prepared);
        const completedAt = new Date();
        const completed = await tx.billingWebhookEvent.updateMany({
          where: {
            stripeEventId: event.id,
            status: "PROCESSING",
            processingLeaseToken: reservation.leaseToken,
          },
          data: {
            tenantId,
            status: "SUCCEEDED",
            processedAtUtc: completedAt,
            succeededAtUtc: completedAt,
            failedAtUtc: null,
            lastError: null,
          },
        });
        if (completed.count !== 1) throw new WebhookLeaseLostError();
      });
      return { received: true };
    } catch (error) {
      if (error instanceof WebhookLeaseLostError) {
        request.log.warn({ stripeEventId: event.id }, "Stripe webhook processing lease was reclaimed before reduction");
        return reply.code(503).send({ error: "Webhook processing lease was reclaimed. Retry later." });
      }
      request.log.error({ err: error, stripeEventId: event.id }, "Stripe webhook processing failed");
      await app.prisma.billingWebhookEvent.updateMany({
        where: {
          stripeEventId: event.id,
          status: "PROCESSING",
          processingLeaseToken: reservation.leaseToken,
        },
        data: { status: "FAILED", failedAtUtc: new Date(), lastError: safeWebhookError(error) },
      });
      throw error;
    }
  });
};
