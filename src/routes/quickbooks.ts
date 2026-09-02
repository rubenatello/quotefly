import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import { FastifyPluginAsync } from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { buildAccessContext } from "../lib/access-policy";
import { getJwtClaims } from "../lib/auth";
import { buildTenantEntitlements } from "../lib/subscription";
import { withTenantRlsContext } from "../lib/tenant-rls";
import {
  buildQuickBooksAdminRedirect,
  buildQuickBooksAuthorizationUrl,
  createQuickBooksInvoice,
  createSignedQuickBooksState,
  decryptQuickBooksHostedPaymentLink,
  encryptQuickBooksSecret,
  exchangeQuickBooksAuthorizationCode,
  fetchQuickBooksInvoice,
  fetchQuickBooksCompanyInfo,
  fetchQuickBooksCustomer,
  fetchQuickBooksItem,
  findQuickBooksInvoicesByDocNumber,
  isQuickBooksConfigured,
  isQuickBooksWebhookConfigured,
  normalizeQuickBooksName,
  classifyQuickBooksProviderFailure,
  quickBooksInvoiceFingerprint,
  QuickBooksProviderError,
  searchQuickBooksCustomers,
  searchQuickBooksItems,
  validateQuickBooksInvoiceLink,
  verifyQuickBooksWebhookSignature,
  verifySignedQuickBooksState,
} from "../services/quickbooks";
import {
  disconnectQuickBooksConnection,
  getSerializedQuickBooksAccessToken,
  invalidateQuickBooksHostedPaymentLinks,
  isQuickBooksReauthorizationError,
  runQuickBooksProviderRequestWithRefresh,
} from "../services/quickbooks-credentials";
import {
  QuickBooksOrphanCredentialPersistenceError,
  revokeOrEnqueueQuickBooksOrphanCredential,
} from "../services/quickbooks-orphan-revocations";
import {
  bindQuickBooksInvoiceReconciliationIdentity,
  claimQuickBooksInvoicePublish,
  claimQuickBooksInvoiceReconciliation,
  completeQuickBooksInvoicePublish,
  failQuickBooksInvoicePublish,
  getQuickBooksInvoiceSyncPreview,
  markQuickBooksInitialReconciliationRequired,
  quickBooksInvoiceLinkAvailable,
  quickBooksInvoiceReconciliationAvailable,
  QuickBooksInvoiceOperationError,
  QuickBooksInvoiceOperationPublicSelect,
  retainCreatedQuickBooksInvoiceForReconciliation,
  retainQuickBooksInvoiceReconciliation,
  type QuickBooksInvoiceOperationPublic,
  type QuickBooksInvoiceSyncPreview,
} from "../services/quickbooks-invoices";
import {
  QuickBooksMappingError,
  reviewQuickBooksCustomerMapping,
  reviewQuickBooksItemMapping,
} from "../services/quickbooks-mappings";
import {
  reconcileQuickBooksInvoice,
  QuickBooksReconciliationError,
} from "../services/quickbooks-reconciliation";
import {
  adoptQuickBooksWebhookQuarantine,
  persistQuickBooksWebhookNotifications,
  resolveQuickBooksWebhookRealm,
  type QuickBooksWebhookEntityNotification,
} from "../services/quickbooks-webhook-inbox";
import {
  deriveQuickBooksSetupReadiness,
  QUICKBOOKS_SETUP_CHECKLIST_VERSION,
} from "../services/quickbooks-setup";
import {
  currentQuickBooksConnectionGeneration,
  nextQuickBooksConnectionGeneration,
  recordQuickBooksConnectionEvent,
} from "../services/quickbooks-connection-events";
import {
  loadWorkerHeartbeat,
  QUICKBOOKS_RECONCILIATION_WORKER_KEY,
  serializeWorkerHeartbeat,
} from "../services/worker-heartbeats";

const QuickBooksCallbackQuerySchema = z.object({
  state: z.string().min(1).optional(),
  code: z.string().min(1).optional(),
  realmId: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  error_description: z.string().min(1).optional(),
});

const QuickBooksQuotePreviewParamsSchema = z.object({
  quoteId: z.string().min(1),
});

const QuickBooksInvoiceParamsSchema = z.object({
  invoiceId: z.string().trim().min(1).max(191),
}).strict();

const QuickBooksBillingEmailReviewSchema = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? null : value,
  z.string().trim().email().max(320).nullable().optional(),
);

const QuickBooksInvoicePublishBodySchema = z.object({
  invoiceVersion: z.number().int().min(1),
  reviewBinding: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  billingEmail: QuickBooksBillingEmailReviewSchema,
  allowOnlineAchPayment: z.boolean().optional().default(false),
  allowOnlineCardPayment: z.boolean().optional().default(false),
}).strict();

const QuickBooksInvoicePreviewBodySchema = z.object({
  billingEmail: QuickBooksBillingEmailReviewSchema,
  allowOnlineAchPayment: z.boolean().optional(),
  allowOnlineCardPayment: z.boolean().optional(),
}).strict();

const QuickBooksCustomerMappingReviewBodySchema = z.object({
  customerId: z.string().trim().min(1).max(191),
  quickBooksCustomerId: z.string().trim().min(1).max(191),
}).strict();

const QuickBooksItemMappingReviewBodySchema = z.object({
  itemKey: z.string().trim().min(1).max(120),
  quickBooksItemId: z.string().trim().min(1).max(191),
  workPresetId: z.string().trim().min(1).max(191).nullable().optional(),
}).strict();

const QuickBooksMappingSearchBodySchema = z.object({
  query: z.string().trim().min(2).max(80),
  limit: z.number().int().min(1).max(25).optional().default(10),
}).strict();

const QuickBooksSetupConfirmationBodySchema = z.object({
  checklistVersion: z.literal(QUICKBOOKS_SETUP_CHECKLIST_VERSION),
  companyConfirmed: z.literal(true),
  reviewResponsibilityConfirmed: z.literal(true),
}).strict();

const QuickBooksIdempotencyKeySchema = z.string()
  .trim()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

const QuickBooksWebhookEntitySchema = z.object({
  name: z.enum(["Invoice", "Payment", "RefundReceipt"]),
  id: z.string().trim().min(1).max(191),
  operation: z.string().trim().min(1).max(64),
  lastUpdated: z.string().datetime({ offset: true }),
}).strict();

const QuickBooksLegacyWebhookBodySchema = z.object({
  eventNotifications: z.array(z.object({
    realmId: z.string().trim().min(1).max(191),
    dataChangeEvent: z.object({
      entities: z.array(QuickBooksWebhookEntitySchema).min(1).max(100),
    }).strict(),
  }).strict()).min(1).max(25),
}).strict().superRefine((payload, context) => {
  const entityCount = payload.eventNotifications.reduce(
    (count, notification) => count + notification.dataChangeEvent.entities.length,
    0,
  );
  if (entityCount > 500) {
    context.addIssue({
      code: "custom",
      path: ["eventNotifications"],
      message: "QuickBooks webhook payloads may contain at most 500 entity notifications.",
    });
  }
});

const QuickBooksCloudEventSchema = z.object({
  specversion: z.literal("1.0"),
  id: z.string().trim().min(1).max(191),
  source: z.string().trim().min(1).max(1_024),
  type: z.string().trim().regex(
    /^qbo\.(invoice|payment|refundreceipt)\.([a-z][a-z0-9-]{0,63})\.v1$/i,
  ),
  time: z.string().datetime({ offset: true }),
  intuitentityid: z.string().trim().min(1).max(191),
  intuitaccountid: z.string().trim().min(1).max(191),
  datacontenttype: z.string().trim().max(191).optional(),
  data: z.unknown().optional(),
}).passthrough();

const QuickBooksCloudEventsBodySchema = z.array(QuickBooksCloudEventSchema).min(1).max(500);
const QuickBooksWebhookBodySchema = z.union([
  QuickBooksLegacyWebhookBodySchema,
  QuickBooksCloudEventsBodySchema,
]);

const QUICKBOOKS_SUPPORTED_WEBHOOK_OPERATIONS: Readonly<Record<string, "Create" | "Update" | "Void">> = {
  create: "Create",
  created: "Create",
  update: "Update",
  updated: "Update",
  void: "Void",
  voided: "Void",
};

function normalizeQuickBooksWebhookOperation(
  entityName: "Invoice" | "Payment" | "RefundReceipt",
  operation: string,
): {
  operation: string;
  supported: boolean;
} {
  const key = operation.trim().toLowerCase();
  if (entityName === "Payment" && (key === "delete" || key === "deleted")) {
    return { operation: "Delete", supported: true };
  }
  const normalized = QUICKBOOKS_SUPPORTED_WEBHOOK_OPERATIONS[key];
  return normalized
    ? { operation: normalized, supported: true }
    : {
        operation: key ? `${key.charAt(0).toUpperCase()}${key.slice(1)}` : "Unknown",
        supported: false,
      };
}

function normalizeQuickBooksWebhookNotifications(
  payload: z.infer<typeof QuickBooksWebhookBodySchema>,
): QuickBooksWebhookEntityNotification[] {
  if (!Array.isArray(payload)) {
    return payload.eventNotifications.flatMap(
      (notification) => notification.dataChangeEvent.entities.map((entity) => {
        const normalizedOperation = normalizeQuickBooksWebhookOperation(entity.name, entity.operation);
        return {
          realmId: notification.realmId,
          name: entity.name,
          id: entity.id,
          ...normalizedOperation,
          lastUpdated: entity.lastUpdated,
        };
      }),
    );
  }

  const entityNames = {
    invoice: "Invoice",
    payment: "Payment",
    refundreceipt: "RefundReceipt",
  } as const;
  return payload.map((event) => {
    const match = /^qbo\.(invoice|payment|refundreceipt)\.([a-z][a-z0-9-]{0,63})\.v1$/i.exec(event.type);
    if (!match) throw new Error("QuickBooks CloudEvent type passed validation without a supported entity.");
    const entityKey = match[1].toLowerCase() as keyof typeof entityNames;
    const entityName = entityNames[entityKey];
    const normalizedOperation = normalizeQuickBooksWebhookOperation(entityName, match[2]);
    return {
      providerEventId: event.id,
      providerEventSource: event.source,
      realmId: event.intuitaccountid,
      name: entityName,
      id: event.intuitentityid,
      ...normalizedOperation,
      lastUpdated: event.time,
    };
  });
}

const QUICKBOOKS_WEBHOOK_BODY_LIMIT_BYTES = 256 * 1024;

function canManageQuickBooks(role: string): boolean {
  const normalized = role.trim().toLowerCase();
  return normalized === "owner" || normalized === "admin";
}

const QUICKBOOKS_PROVIDER_WORKFLOWS_UNAVAILABLE = "QUICKBOOKS_PROVIDER_WORKFLOWS_UNAVAILABLE";
const QUICKBOOKS_TAX_SYNC_UNSUPPORTED = "QUICKBOOKS_TAX_SYNC_UNSUPPORTED";

class QuickBooksRealmChangeBlockedError extends Error {}
class QuickBooksOAuthStateReplayError extends Error {}
class QuickBooksCredentialLifecycleBlockedError extends Error {}

type QuickBooksRealmSwitchCandidate = Readonly<{
  realmId: string;
  status: string;
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  disconnectedAtUtc: Date | null;
  disconnectRequestedAtUtc: Date | null;
  tokenRefreshClaimHash: string | null;
  setupConfirmedAtUtc: Date | null;
  setupConfirmedByTenantUserId: string | null;
  lastSyncAtUtc: Date | null;
  lastWebhookAtUtc: Date | null;
  deletedAtUtc: Date | null;
  realmBinding: Readonly<{ active: boolean }> | null;
  _count: Readonly<{
    customerMaps: number;
    itemMaps: number;
    invoiceSyncs: number;
    invoiceOperations: number;
    webhookEvents: number;
  }>;
}>;

function canReplaceUnusedDisconnectedQuickBooksRealm(
  connection: QuickBooksRealmSwitchCandidate,
): boolean {
  return connection.status === "DISCONNECTED"
    && connection.accessTokenEncrypted === null
    && connection.refreshTokenEncrypted === null
    && connection.disconnectedAtUtc !== null
    && connection.disconnectRequestedAtUtc === null
    && connection.tokenRefreshClaimHash === null
    && connection.setupConfirmedAtUtc === null
    && connection.setupConfirmedByTenantUserId === null
    && connection.lastSyncAtUtc === null
    && connection.lastWebhookAtUtc === null
    && connection.deletedAtUtc === null
    && connection.realmBinding?.active === false
    && Object.values(connection._count).every((count) => count === 0);
}

const QuickBooksSetupConnectionSelect = Prisma.validator<Prisma.QuickBooksConnectionSelect>()({
  id: true,
  environment: true,
  companyName: true,
  status: true,
  scopes: true,
  accessTokenEncrypted: true,
  refreshTokenEncrypted: true,
  accessTokenExpiresAtUtc: true,
  connectedAtUtc: true,
  disconnectedAtUtc: true,
  lastTokenRefreshAtUtc: true,
  lastSyncAtUtc: true,
  lastWebhookAtUtc: true,
  setupConfirmedAtUtc: true,
  setupConfirmedByTenantUserId: true,
  setupChecklistVersion: true,
  realmBinding: { select: { active: true } },
  cdcCursor: { select: { id: true } },
  _count: {
    select: {
      customerMaps: { where: { deletedAtUtc: null } },
      itemMaps: { where: { deletedAtUtc: null } },
      invoiceSyncs: { where: { deletedAtUtc: null } },
    },
  },
});

function quickBooksDocNumber(quoteId: string): string {
  return `QF-${quoteId.slice(-8).toUpperCase()}`;
}

function normalizeItemKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
}

function getRawBody(request: FastifyRequest): string | null {
  const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody;
  return typeof rawBody === "string" ? rawBody : null;
}

function getQuickBooksWebhookSignature(request: FastifyRequest): string | null {
  const signature = request.headers["intuit-signature"];
  if (typeof signature === "string" && signature.trim()) return signature.trim();
  if (Array.isArray(signature) && typeof signature[0] === "string" && signature[0].trim()) return signature[0].trim();
  return null;
}

function quickBooksIdempotencyKey(request: FastifyRequest): string {
  const raw = request.headers["idempotency-key"];
  return QuickBooksIdempotencyKeySchema.parse(Array.isArray(raw) ? raw[0] : raw);
}

function serializeQuickBooksInvoiceOperation(operation: QuickBooksInvoiceOperationPublic) {
  return {
    status: operation.status,
    providerDocNumber: operation.providerDocNumber,
    providerInvoiceStatus: operation.providerInvoiceStatus,
    providerBalance: operation.providerBalance === null ? null : Number(operation.providerBalance),
    paymentMethods: {
      ach: operation.allowOnlineAchPayment,
      card: operation.allowOnlineCardPayment,
    },
    paymentLinkAvailable: quickBooksInvoiceLinkAvailable(operation),
    reconciliationAvailable: quickBooksInvoiceReconciliationAvailable(operation),
  };
}

function serializeQuickBooksReconciliation(
  reconciliation: Awaited<ReturnType<typeof reconcileQuickBooksInvoice>>,
) {
  return {
    invoiceStatus: reconciliation.invoiceStatus,
    paymentStatus: reconciliation.paymentStatus,
    amountPaid: reconciliation.amountPaid,
    balanceDue: reconciliation.balanceDue,
    hostedPaymentUrlAvailable: reconciliation.hostedPaymentUrlAvailable,
  };
}

function serializeQuickBooksInvoicePreview(preview: QuickBooksInvoiceSyncPreview) {
  return {
    ...preview,
    invoice: {
      ...preview.invoice,
      dueAtUtc: preview.invoice.dueAtUtc?.toISOString() ?? null,
    },
    operation: preview.operation
      ? serializeQuickBooksInvoiceOperation(preview.operation)
      : null,
  };
}

function sendQuickBooksInvoiceOperationError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof QuickBooksInvoiceOperationError)) throw error;
  return reply.code(error.statusCode).send({
    error: error.message,
    code: error.code,
    ...(error.details ?? {}),
  });
}

export const quickBooksRoutes: FastifyPluginAsync = async (app) => {
  const QuickBooksConnectRateLimit = {
    config: {
      rateLimit: {
        max: app.env.NODE_ENV === "test" ? 10_000 : 5,
        timeWindow: "15 minutes",
      },
    },
  } as const;
  const quickBooksSetupRuntime = (reconciliationWorkerHealthy = false) => ({
    providerConfigured: isQuickBooksConfigured(app.env),
    providerWorkflowsEnabled: app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED,
    oauthOnlyMode: app.env.QUICKBOOKS_OAUTH_ONLY_MODE,
    webhookConfigured: isQuickBooksWebhookConfigured(app.env),
    hostedPaymentsEnabled: app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED,
    reconciliationWorkerEnabled: app.env.QUICKBOOKS_RECONCILIATION_WORKER_ENABLED,
    reconciliationWorkerHealthy,
    cdcWorkerEnabled: app.env.QUICKBOOKS_CDC_WORKER_ENABLED,
    environment: app.env.QUICKBOOKS_ENVIRONMENT,
  } as const);

  async function hasLiveQuickBooksManagerAccess(tenantId: string, userId: string): Promise<boolean> {
    const membership = await app.prisma.tenantUser.findFirst({
      where: {
        tenantId,
        userId,
        deletedAtUtc: null,
        user: { deletedAtUtc: null },
        tenant: { deletedAtUtc: null },
      },
      select: { role: true },
    });

    return Boolean(membership && canManageQuickBooks(membership.role));
  }

  async function requireLiveQuickBooksManagerAccess(
    claims: { tenantId: string; userId: string },
    reply: FastifyReply,
  ): Promise<boolean> {
    if (await hasLiveQuickBooksManagerAccess(claims.tenantId, claims.userId)) return true;
    reply.code(403).send({ error: "Only owners or admins can manage QuickBooks." });
    return false;
  }

  function providerWorkflowsUnavailable(reply: FastifyReply) {
    return reply.code(503).send({ error: QUICKBOOKS_PROVIDER_WORKFLOWS_UNAVAILABLE });
  }

  function accountingWorkflowsAvailable(): boolean {
    return app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED && !app.env.QUICKBOOKS_OAUTH_ONLY_MODE;
  }

  function accountingWorkflowsUnavailable(reply: FastifyReply) {
    if (!app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED) {
      return providerWorkflowsUnavailable(reply);
    }
    return reply.code(503).send({
      error: "QuickBooks accounting workflows are paused while connection-only validation is active.",
      code: "QUICKBOOKS_OAUTH_ONLY_MODE",
    });
  }

  function reconciliationRuntimeAvailable(): boolean {
    return accountingWorkflowsAvailable()
      && app.env.QUICKBOOKS_RECONCILIATION_WORKER_ENABLED
      && isQuickBooksWebhookConfigured(app.env);
  }

  function hostedPaymentsRuntimeAvailable(): boolean {
    return reconciliationRuntimeAvailable() && app.env.QUICKBOOKS_HOSTED_PAYMENTS_ENABLED;
  }

  function reconciliationRuntimeUnavailable(reply: FastifyReply) {
    return reply.code(503).send({
      error: "QuickBooks reconciliation is not enabled for this environment.",
      code: "QUICKBOOKS_RECONCILIATION_UNAVAILABLE",
    });
  }

  function hostedPaymentsRuntimeUnavailable(reply: FastifyReply) {
    return reply.code(503).send({
      error: "QuickBooks hosted payments are not enabled for this environment.",
      code: "QUICKBOOKS_HOSTED_PAYMENTS_UNAVAILABLE",
    });
  }

  async function loadQuickBooksSyncContext(tenantId: string, quoteId: string, dueInDays = 14) {
    return withTenantRlsContext(app.prisma, tenantId, async (transaction) => {
    const connection = await transaction.quickBooksConnection.findFirst({
      where: {
        tenantId,
        deletedAtUtc: null,
        status: "CONNECTED",
        setupConfirmedAtUtc: { not: null },
        setupConfirmedByTenantUserId: { not: null },
        setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
      },
      select: {
        id: true,
        tenantId: true,
        realmId: true,
        companyName: true,
        status: true,
        accessTokenEncrypted: true,
        refreshTokenEncrypted: true,
        accessTokenExpiresAtUtc: true,
      },
    });

    if (!connection) {
      throw new Error("QuickBooks is not connected for this tenant.");
    }

    const quote = await transaction.quote.findFirst({
      where: {
        id: quoteId,
        tenantId,
        deletedAtUtc: null,
      },
      include: {
        customer: true,
        lineItems: {
          where: { deletedAtUtc: null },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!quote) {
      throw new Error("Quote not found.");
    }

    const [customerMap, itemMaps, existingSync] = await Promise.all([
      transaction.quickBooksCustomerMap.findFirst({
        where: {
          tenantId,
          quickBooksConnectionId: connection.id,
          customerId: quote.customerId,
          deletedAtUtc: null,
        },
        select: {
          id: true,
          quickBooksCustomerId: true,
          quickBooksDisplayName: true,
        },
      }),
      transaction.quickBooksItemMap.findMany({
        where: {
          tenantId,
          quickBooksConnectionId: connection.id,
          deletedAtUtc: null,
        },
        select: {
          id: true,
          itemKey: true,
          quickBooksItemId: true,
          quickBooksItemName: true,
          workPresetId: true,
        },
      }),
      transaction.quickBooksInvoiceSync.findFirst({
        where: {
          tenantId,
          quickBooksConnectionId: connection.id,
          quoteId,
          deletedAtUtc: null,
        },
        select: {
          id: true,
          quickBooksInvoiceId: true,
          quickBooksDocNumber: true,
          status: true,
          lastError: true,
          lastAttemptedAtUtc: true,
          syncedAtUtc: true,
        },
      }),
    ]);

    const itemMapByKey = new Map(itemMaps.map((item) => [item.itemKey, item]));
    const invoiceDate = new Date().toISOString().slice(0, 10);
    const dueDate = new Date(Date.now() + dueInDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const rawLineItems =
      quote.lineItems.length > 0
        ? quote.lineItems
        : [
            {
              id: `fallback-${quote.id}`,
              description: quote.title,
              quantity: 1,
              unitPrice: quote.customerPriceSubtotal,
            },
          ];

    const lineItems = rawLineItems.map((lineItem) => {
      const itemKey = normalizeItemKey(lineItem.description);
      const mappedItem = itemMapByKey.get(itemKey);
      const quantity = Number(lineItem.quantity ?? 1);
      const unitPrice = Number(lineItem.unitPrice ?? quote.customerPriceSubtotal);
      const amount = Number((quantity * unitPrice).toFixed(2));

      return {
        sourceLineId: lineItem.id,
        description: lineItem.description,
        itemKey,
        quickBooksItemId: mappedItem?.quickBooksItemId ?? null,
        quickBooksItemName: mappedItem?.quickBooksItemName ?? null,
        quantity,
        unitPrice,
        amount,
        payload: {
          Description: lineItem.description,
          Amount: amount,
          DetailType: "SalesItemLineDetail",
          SalesItemLineDetail: {
            Qty: quantity,
            UnitPrice: unitPrice,
            ItemRef: mappedItem
              ? {
                  value: mappedItem.quickBooksItemId,
                  name: mappedItem.quickBooksItemName,
                }
              : null,
          },
        },
      };
    });

    const warnings = [
      ...(customerMap ? [] : ["Customer is not mapped in QuickBooks yet and will need lookup/create before invoice push."]),
      ...lineItems
        .filter((lineItem) => !lineItem.quickBooksItemId)
        .map((lineItem) => `Line item "${lineItem.description}" is not mapped to a QuickBooks Item yet.`),
      ...(Number(quote.taxAmount) > 0
        ? [
            "Quoted tax is not pushed directly yet. Review the invoice tax settings in QuickBooks before sending it to the customer.",
          ]
        : []),
    ];

    return {
      connection,
      quote,
      customerMap,
      itemMaps,
      existingSync,
      invoiceDate,
      dueDate,
      lineItems,
      warnings,
    };
    });
  }

  async function getAccessToken(connection: {
    id: string;
    tenantId: string;
    realmId: string;
  }) {
    return getSerializedQuickBooksAccessToken({
      prisma: app.prisma,
      runtimeEnv: app.env,
      connection,
    });
  }

  async function runQuickBooksProviderRequest<T>(
    connection: { id: string; tenantId: string; realmId: string },
    operation: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    return runQuickBooksProviderRequestWithRefresh({
      prisma: app.prisma,
      runtimeEnv: app.env,
      connection,
      operation,
    });
  }

  function sendQuickBooksReauthRequired(reply: FastifyReply, error: unknown) {
    if (!isQuickBooksReauthorizationError(error)) return false;
    reply.code(409).send({
      error: "QuickBooks authorization needs attention. Reconnect the workspace and try again.",
      code: "QUICKBOOKS_REAUTH_REQUIRED",
    });
    return true;
  }

  async function loadConnectedQuickBooksProvider(tenantId: string) {
    return withTenantRlsContext(app.prisma, tenantId, (transaction) =>
      transaction.quickBooksConnection.findFirst({
        where: {
          tenantId,
          status: "CONNECTED",
          deletedAtUtc: null,
          setupConfirmedAtUtc: { not: null },
          setupConfirmedByTenantUserId: { not: null },
          setupChecklistVersion: QUICKBOOKS_SETUP_CHECKLIST_VERSION,
        },
        select: { id: true, tenantId: true, realmId: true },
      }),
    );
  }

  app.post(
    "/integrations/quickbooks/webhook",
    { bodyLimit: QUICKBOOKS_WEBHOOK_BODY_LIMIT_BYTES, config: { rawBody: true } },
    async (request, reply) => {
      if (!isQuickBooksWebhookConfigured(app.env)) {
        return reply.code(503).send({ error: "QuickBooks webhook verifier is not configured." });
      }

      const signature = getQuickBooksWebhookSignature(request);
      if (!signature) {
        return reply.code(400).send({ error: "Missing QuickBooks webhook signature." });
      }

      const rawBody = getRawBody(request);
      if (!rawBody) {
        return reply.code(400).send({ error: "Missing raw webhook body." });
      }

      if (!verifyQuickBooksWebhookSignature(app.env, rawBody, signature)) {
        return reply.code(401).send({ error: "Invalid QuickBooks webhook signature." });
      }

      let notifications: QuickBooksWebhookEntityNotification[];
      try {
        const webhookBody = QuickBooksWebhookBodySchema.parse(JSON.parse(rawBody));
        notifications = normalizeQuickBooksWebhookNotifications(webhookBody);
      } catch {
        return reply.code(400).send({ error: "Invalid QuickBooks webhook payload." });
      }

      // Validate ingress even while paused, then deliberately return a
      // retryable error instead of acknowledging and discarding a provider
      // change that may need a later refresh after workflows are re-enabled.
      if (!accountingWorkflowsAvailable()) return accountingWorkflowsUnavailable(reply);

      const persisted = await persistQuickBooksWebhookNotifications(app.prisma, notifications);
      request.log.info(
        {
          notificationCount: notifications.length,
          persistedCount: persisted.persisted,
          duplicateCount: persisted.duplicate,
          unknownRealmCount: persisted.unknownRealm,
        },
        "QuickBooks webhook notifications persisted",
      );
      return { received: true, count: notifications.length, persisted: persisted.persisted };
    },
  );

  app.get(
    "/integrations/quickbooks/status",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const claims = getJwtClaims(request);

      if (!(await requireLiveQuickBooksManagerAccess(claims, reply))) return;
      reply.header("Cache-Control", "private, no-store");

      const [connection, workerHeartbeat] = await Promise.all([
        withTenantRlsContext(app.prisma, claims.tenantId, (transaction) =>
          transaction.quickBooksConnection.findFirst({
            where: {
              tenantId: claims.tenantId,
              deletedAtUtc: null,
            },
            select: QuickBooksSetupConnectionSelect,
          }),
        ),
        loadWorkerHeartbeat(app.prisma, QUICKBOOKS_RECONCILIATION_WORKER_KEY),
      ]);
      const setup = deriveQuickBooksSetupReadiness(
        quickBooksSetupRuntime(workerHeartbeat?.fresh ?? false),
        connection,
      );

      return {
        enabled: isQuickBooksConfigured(app.env) && app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED,
        configured: isQuickBooksConfigured(app.env),
        providerWorkflowsEnabled: app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED,
        oauthOnlyMode: app.env.QUICKBOOKS_OAUTH_ONLY_MODE,
        webhookConfigured: isQuickBooksWebhookConfigured(app.env),
        canManage: true,
        environment: app.env.QUICKBOOKS_ENVIRONMENT,
        reconciliationWorker: serializeWorkerHeartbeat(workerHeartbeat),
        setup,
        connection: connection
          ? {
              environment: connection.environment,
              companyName: connection.companyName,
              status: connection.status,
              connectedAtUtc: connection.connectedAtUtc,
              disconnectedAtUtc: connection.disconnectedAtUtc,
              lastTokenRefreshAtUtc: connection.lastTokenRefreshAtUtc,
              lastSyncAtUtc: connection.lastSyncAtUtc,
              lastWebhookAtUtc: connection.lastWebhookAtUtc,
              counts: {
                customerMaps: connection._count.customerMaps,
                itemMaps: connection._count.itemMaps,
                invoiceSyncs: connection._count.invoiceSyncs,
              },
            }
          : null,
      };
    },
  );

  app.post(
    "/integrations/quickbooks/connect",
    { ...QuickBooksConnectRateLimit, preHandler: [app.authenticate] },
    async (request, reply) => {
      // OAuth state and its authorization URL are credential-adjacent. Never
      // allow an intermediary or a shared browser cache to retain this response.
      reply.header("Cache-Control", "private, no-store");
      const claims = getJwtClaims(request);
      if (!(await requireLiveQuickBooksManagerAccess(claims, reply))) return;
      const access = buildAccessContext(request);

      if (!app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED) return providerWorkflowsUnavailable(reply);

      if (!isQuickBooksConfigured(app.env)) {
        return reply.code(503).send({ error: "QuickBooks integration is not configured yet." });
      }

      const state = createSignedQuickBooksState(app.env, {
        tenantId: claims.tenantId,
        userId: claims.userId,
        role: claims.role,
      });
      const stateHash = createHash("sha256").update(state, "utf8").digest("hex");
      const credentialLifecycleBlocked = await withTenantRlsContext(app.prisma, claims.tenantId, async (transaction) => {
        const now = new Date();
        await transaction.$queryRaw(Prisma.sql`
          SELECT 1::int AS "locked"
          FROM (
            SELECT pg_advisory_xact_lock(
              hashtextextended(${`quickbooks-oauth-init:${claims.tenantId}:${claims.userId}`}, 0)
            )
          ) acquired
        `);
        await transaction.quickBooksOAuthState.deleteMany({
          where: {
            tenantId: claims.tenantId,
            OR: [
              { expiresAtUtc: { lte: now } },
              {
                consumedAtUtc: { not: null },
                createdAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
              },
            ],
          },
        });
        await transaction.quickBooksOAuthState.updateMany({
          where: {
            tenantId: claims.tenantId,
            userId: claims.userId,
            consumedAtUtc: null,
          },
          data: { consumedAtUtc: now },
        });
        const connection = await transaction.quickBooksConnection.findFirst({
          where: { tenantId: claims.tenantId, deletedAtUtc: null },
          select: {
            id: true,
            status: true,
            disconnectRequestedAtUtc: true,
            tokenRefreshClaimHash: true,
          },
        });
        if (
          connection?.status === "REVOCATION_PENDING"
          || connection?.status === "ERROR"
          || connection?.disconnectRequestedAtUtc
          || connection?.tokenRefreshClaimHash
        ) return true;
        await transaction.quickBooksOAuthState.create({
          data: {
            tenantId: claims.tenantId,
            quickBooksConnectionId: connection?.id ?? null,
            userId: claims.userId,
            stateHash,
            expiresAtUtc: new Date(now.getTime() + 10 * 60 * 1000),
          },
        });
        await recordQuickBooksConnectionEvent(transaction, {
          tenantId: claims.tenantId,
          quickBooksConnectionId: connection?.id ?? null,
          actorTenantUserId: access.tenantUserId,
          requestId: access.requestId,
          action: "CONNECT_STARTED",
          outcome: "PENDING",
          connectionGeneration: await nextQuickBooksConnectionGeneration(transaction, claims.tenantId),
        });
        return false;
      });
      if (credentialLifecycleBlocked) {
        return reply.code(409).send({
          error: "Finish disconnecting QuickBooks before reconnecting.",
          code: "QUICKBOOKS_CREDENTIAL_LIFECYCLE_BUSY",
        });
      }

      return {
        authorizationUrl: buildQuickBooksAuthorizationUrl(app.env, state),
      };
    },
  );

  app.get("/integrations/quickbooks/callback", async (request, reply) => {
    // OAuth query parameters are credential-adjacent. Set these before query
    // validation so success, denied, invalid-state, and malformed callbacks
    // all avoid cache retention and referrer propagation.
    reply.header("Cache-Control", "private, no-store");
    reply.header("Referrer-Policy", "no-referrer");
    const query = QuickBooksCallbackQuerySchema.parse(request.query);
    const failureRedirect = (state: string) => reply.redirect(buildQuickBooksAdminRedirect(app.env, state));

    if (!query.state) {
      return failureRedirect(query.error ? "quickbooks_denied" : "quickbooks_error");
    }

    const verifiedState = verifySignedQuickBooksState(app.env, query.state);
    if (!verifiedState) {
      return failureRedirect("quickbooks_invalid_state");
    }

    let issuedRefreshToken: string | null = null;
    try {
      const stateHash = createHash("sha256").update(query.state, "utf8").digest("hex");
      const stateExists = await withTenantRlsContext(
        app.prisma,
        verifiedState.tenantId,
        (transaction) => transaction.quickBooksOAuthState.count({
          where: {
            tenantId: verifiedState.tenantId,
            userId: verifiedState.userId,
            stateHash,
            consumedAtUtc: null,
            expiresAtUtc: { gt: new Date() },
          },
        }),
      );
      if (stateExists !== 1) throw new QuickBooksOAuthStateReplayError();

      // A signed state is not sufficient authorization. Bind the callback to
      // the exact initiating HttpOnly browser session before consuming its
      // one-time state so a missing or wrong session cannot burn an owner's
      // legitimate OAuth attempt.
      await app.authenticate(request, reply);
      if (reply.sent) return reply;
      const callbackClaims = getJwtClaims(request);
      if (
        callbackClaims.tenantId !== verifiedState.tenantId
        || callbackClaims.userId !== verifiedState.userId
      ) {
        return failureRedirect("quickbooks_session_mismatch");
      }
      const callbackMembership = request.liveAuthMembership;
      if (!callbackMembership) return failureRedirect("quickbooks_session_mismatch");
      const callbackEntitlements = buildTenantEntitlements(
        callbackMembership.tenant,
        new Date(),
        { userEmail: callbackMembership.user.email },
      );
      if (!callbackEntitlements.hasWorkspaceAccess) {
        return failureRedirect("quickbooks_billing_required");
      }

      // Consume every session-bound callback state exactly once, including
      // denied and malformed terminal callbacks. A canceled authorization
      // must never leave a replayable one-time state behind for its TTL.
      const stateConsumed = await withTenantRlsContext(
        app.prisma,
        verifiedState.tenantId,
        async (transaction) => {
          await transaction.$queryRaw(Prisma.sql`
            SELECT 1::int AS "locked"
            FROM (
              SELECT pg_advisory_xact_lock(hashtextextended(${`quickbooks-oauth-state:${stateHash}`}, 0))
            ) acquired
          `);
          const stateRecord = await transaction.quickBooksOAuthState.findFirst({
            where: {
              tenantId: verifiedState.tenantId,
              userId: verifiedState.userId,
              stateHash,
              consumedAtUtc: null,
              expiresAtUtc: { gt: new Date() },
            },
            select: { id: true, quickBooksConnectionId: true },
          });
          if (!stateRecord) return null;
          const consumed = await transaction.quickBooksOAuthState.updateMany({
            where: { id: stateRecord.id, tenantId: verifiedState.tenantId, consumedAtUtc: null },
            data: { consumedAtUtc: new Date() },
          });
          return consumed.count === 1 ? stateRecord : null;
        },
        { maxWait: 5_000, timeout: 10_000 },
      );
      if (!stateConsumed) throw new QuickBooksOAuthStateReplayError();

      if (query.error) return failureRedirect("quickbooks_denied");
      if (!query.code || !query.realmId) return failureRedirect("quickbooks_error");
      const callbackRealmId = query.realmId;

      if (!app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED) {
        return reply.code(503).send({ error: QUICKBOOKS_PROVIDER_WORKFLOWS_UNAVAILABLE });
      }
      if (!isQuickBooksConfigured(app.env)) {
        return failureRedirect("quickbooks_not_configured");
      }

      // OAuth state proves the callback originated from QuoteFly, but its role
      // claim can be stale for ten minutes. Revalidate the signed actor and
      // tenant before exchanging the one-time code or writing credentials.
      const hasManagerAccess = await hasLiveQuickBooksManagerAccess(
        verifiedState.tenantId,
        verifiedState.userId,
      );
      if (!hasManagerAccess) {
        return failureRedirect("quickbooks_error");
      }

      const existingRealmConnection = await resolveQuickBooksWebhookRealm(app.prisma, callbackRealmId);

      if (existingRealmConnection && existingRealmConnection.tenantId !== verifiedState.tenantId) {
        return failureRedirect("quickbooks_realm_in_use");
      }

      // A used connection remains permanently bound to its original company.
      // The only supported correction is an unused, unconfirmed connection
      // that has completed token revocation and has no accounting history.
      const existingTenantConnection = await withTenantRlsContext(
        app.prisma,
        verifiedState.tenantId,
        (transaction) => transaction.quickBooksConnection.findUnique({
          where: { tenantId: verifiedState.tenantId },
          select: {
            id: true,
            realmId: true,
            status: true,
            accessTokenEncrypted: true,
            refreshTokenEncrypted: true,
            disconnectedAtUtc: true,
            disconnectRequestedAtUtc: true,
            tokenRefreshClaimHash: true,
            setupConfirmedAtUtc: true,
            setupConfirmedByTenantUserId: true,
            lastSyncAtUtc: true,
            lastWebhookAtUtc: true,
            deletedAtUtc: true,
            realmBinding: { select: { active: true } },
            _count: {
              select: {
                customerMaps: true,
                itemMaps: true,
                invoiceSyncs: true,
                invoiceOperations: true,
                webhookEvents: true,
              },
            },
          },
        }),
      );
      if (
        existingTenantConnection
        && existingTenantConnection.realmId !== callbackRealmId
        && !canReplaceUnusedDisconnectedQuickBooksRealm(existingTenantConnection)
      ) {
        return failureRedirect("quickbooks_realm_change_blocked");
      }
      if (
        (stateConsumed.quickBooksConnectionId ?? null) !== (existingTenantConnection?.id ?? null)
        || existingTenantConnection?.status === "REVOCATION_PENDING"
        || existingTenantConnection?.status === "ERROR"
        || existingTenantConnection?.disconnectRequestedAtUtc
        || existingTenantConnection?.tokenRefreshClaimHash
      ) {
        throw new QuickBooksCredentialLifecycleBlockedError();
      }

      const tokenResponse = await exchangeQuickBooksAuthorizationCode(app.env, query.code);
      issuedRefreshToken = tokenResponse.refresh_token;
      const companyInfo = await fetchQuickBooksCompanyInfo(app.env, callbackRealmId, tokenResponse.access_token);
      if (companyInfo.realmId !== callbackRealmId) {
        throw new QuickBooksProviderError("QUICKBOOKS_COMPANY_REALM_MISMATCH", false);
      }

      // Provider calls intentionally stay outside database transactions. Check
      // authorization again so a revocation during the exchange cannot persist
      // newly issued credentials.
      const stillHasManagerAccess = await hasLiveQuickBooksManagerAccess(
        verifiedState.tenantId,
        verifiedState.userId,
      );
      if (!stillHasManagerAccess) {
        throw new QuickBooksCredentialLifecycleBlockedError();
      }

      const now = new Date();
      const accessTokenExpiresAtUtc = new Date(now.getTime() + tokenResponse.expires_in * 1000);

      await withTenantRlsContext(app.prisma, verifiedState.tenantId, async (transaction) => {
        await transaction.$queryRaw(Prisma.sql`
          SELECT 1::int AS "locked"
          FROM (
            SELECT pg_advisory_xact_lock(
              hashtextextended(${`quickbooks-connection:${verifiedState.tenantId}`}, 0)
            )
          ) acquired
        `);
        const currentConnection = await transaction.quickBooksConnection.findUnique({
          where: { tenantId: verifiedState.tenantId },
          select: {
            id: true,
            realmId: true,
            status: true,
            accessTokenEncrypted: true,
            refreshTokenEncrypted: true,
            disconnectedAtUtc: true,
            disconnectRequestedAtUtc: true,
            tokenRefreshClaimHash: true,
            setupConfirmedAtUtc: true,
            setupConfirmedByTenantUserId: true,
            lastSyncAtUtc: true,
            lastWebhookAtUtc: true,
            deletedAtUtc: true,
            realmBinding: { select: { active: true } },
            _count: {
              select: {
                customerMaps: true,
                itemMaps: true,
                invoiceSyncs: true,
                invoiceOperations: true,
                webhookEvents: true,
              },
            },
          },
        });
         // Lock the exact selected-tenant actor, user, and tenant rows before
         // persisting credentials. A concurrent demotion/deletion must either
         // commit first and be observed here, or wait until this authorization
         // decision and credential write have committed atomically.
         const [actor] = await transaction.$queryRaw<Array<{
           id: string;
           role: string;
           email: string;
           authVersion: number;
           subscriptionStatus: string;
           subscriptionPlanCode: string | null;
           stripeCustomerId: string | null;
           stripeSubscriptionId: string | null;
           trialStartsAtUtc: Date | null;
           trialEndsAtUtc: Date | null;
           subscriptionCurrentPeriodStartUtc: Date | null;
           subscriptionCurrentPeriodEndUtc: Date | null;
         }>>(Prisma.sql`
           SELECT
             membership."id",
             membership."role",
             account."email",
             account."authVersion",
             selected_tenant."subscriptionStatus",
             selected_tenant."subscriptionPlanCode",
             selected_tenant."stripeCustomerId",
             selected_tenant."stripeSubscriptionId",
             selected_tenant."trialStartsAtUtc",
             selected_tenant."trialEndsAtUtc",
             selected_tenant."subscriptionCurrentPeriodStartUtc",
             selected_tenant."subscriptionCurrentPeriodEndUtc"
           FROM "TenantUser" membership
           INNER JOIN "User" account ON account."id" = membership."userId"
           INNER JOIN "Tenant" selected_tenant ON selected_tenant."id" = membership."tenantId"
           WHERE membership."tenantId" = ${verifiedState.tenantId}
             AND membership."userId" = ${verifiedState.userId}
             AND membership."deletedAtUtc" IS NULL
             AND account."deletedAtUtc" IS NULL
             AND selected_tenant."deletedAtUtc" IS NULL
           FOR UPDATE OF membership, account, selected_tenant
         `);
         if (
           !actor
           || actor.authVersion !== callbackClaims.authVersion
           || !canManageQuickBooks(actor.role)
           || !buildTenantEntitlements(actor, new Date(), { userEmail: actor.email }).hasWorkspaceAccess
         ) {
           throw new QuickBooksCredentialLifecycleBlockedError();
         }
        const switchingRealm = Boolean(
          currentConnection && currentConnection.realmId !== callbackRealmId,
        );
        if (
          currentConnection
          && switchingRealm
          && !canReplaceUnusedDisconnectedQuickBooksRealm(currentConnection)
        ) {
          throw new QuickBooksRealmChangeBlockedError();
        }
        if (
          (stateConsumed.quickBooksConnectionId ?? null) !== (currentConnection?.id ?? null)
          || currentConnection?.status === "REVOCATION_PENDING"
          || currentConnection?.status === "ERROR"
          || currentConnection?.disconnectRequestedAtUtc
          || currentConnection?.tokenRefreshClaimHash
        ) {
          throw new QuickBooksCredentialLifecycleBlockedError();
        }
        const credentialData = {
           environment: app.env.QUICKBOOKS_ENVIRONMENT,
           companyName: companyInfo.companyName,
           status: "CONNECTED" as const,
           scopes: ["com.intuit.quickbooks.accounting"],
           accessTokenEncrypted: encryptQuickBooksSecret(app.env, tokenResponse.access_token),
           refreshTokenEncrypted: encryptQuickBooksSecret(app.env, tokenResponse.refresh_token),
           accessTokenExpiresAtUtc,
           refreshTokenRotatedAtUtc: now,
           connectedAtUtc: now,
           disconnectedAtUtc: null,
           disconnectRequestedAtUtc: null,
           revocationPendingAtUtc: null,
           revocationAttemptCount: 0,
           revocationNextAttemptAtUtc: null,
           tokenRefreshClaimHash: null,
           tokenRefreshClaimExpiresAtUtc: null,
           setupConfirmedAtUtc: null,
           setupConfirmedByTenantUserId: null,
           setupChecklistVersion: null,
           lastError: null,
           deletedAtUtc: null,
         };
        let savedConnection: { id: string };
        if (!currentConnection) {
          savedConnection = await transaction.quickBooksConnection.create({
            data: {
              tenantId: verifiedState.tenantId,
              realmId: callbackRealmId,
              ...credentialData,
            },
            select: { id: true },
          });
        } else {
          const updated = await transaction.quickBooksConnection.updateMany({
            where: {
              id: currentConnection.id,
              tenantId: verifiedState.tenantId,
              realmId: currentConnection.realmId,
              status: currentConnection.status,
              refreshTokenEncrypted: currentConnection.refreshTokenEncrypted,
              disconnectRequestedAtUtc: null,
              tokenRefreshClaimHash: null,
            },
            data: {
              ...credentialData,
              ...(switchingRealm ? { realmId: callbackRealmId } : {}),
            },
          });
          if (updated.count !== 1) throw new QuickBooksCredentialLifecycleBlockedError();
          savedConnection = { id: currentConnection.id };
        }
        if (currentConnection) {
          await invalidateQuickBooksHostedPaymentLinks(
            transaction,
            verifiedState.tenantId,
            savedConnection.id,
            now,
          );
        }
        await transaction.quickBooksRealmBinding.upsert({
          where: { quickBooksConnectionId: savedConnection.id },
          create: {
            tenantId: verifiedState.tenantId,
            quickBooksConnectionId: savedConnection.id,
            realmId: callbackRealmId,
            active: true,
          },
          update: { realmId: callbackRealmId, active: true },
        });
        await adoptQuickBooksWebhookQuarantine(transaction, {
          tenantId: verifiedState.tenantId,
          quickBooksConnectionId: savedConnection.id,
          realmId: callbackRealmId,
        });
        await transaction.quickBooksCdcCursor.upsert({
          where: { quickBooksConnectionId: savedConnection.id },
          create: {
            tenantId: verifiedState.tenantId,
            quickBooksConnectionId: savedConnection.id,
            changedSinceUtc: new Date(Date.now() - 5 * 60 * 1000),
          },
          update: {
            changedSinceUtc: new Date(now.getTime() - 5 * 60 * 1000),
            lastAttemptAtUtc: null,
            lastSucceededAtUtc: null,
            nextAttemptAtUtc: null,
            attemptCount: 0,
            lastErrorCode: null,
            terminalAtUtc: null,
          },
        });
        await recordQuickBooksConnectionEvent(transaction, {
          tenantId: verifiedState.tenantId,
          quickBooksConnectionId: savedConnection.id,
          actorTenantUserId: actor.id,
          requestId: request.id,
          action: switchingRealm ? "COMPANY_SWITCHED" : currentConnection ? "RECONNECTED" : "CONNECTED",
          outcome: "SUCCEEDED",
          connectionGeneration: await nextQuickBooksConnectionGeneration(transaction, verifiedState.tenantId),
        });
      }, { maxWait: 5_000, timeout: 15_000 });

      return failureRedirect("quickbooks_connected");
    } catch (error) {
      let orphanCleanupFailed = false;
      if (issuedRefreshToken) {
        try {
          const cleanupOutcome = await revokeOrEnqueueQuickBooksOrphanCredential({
            prisma: app.prisma,
            runtimeEnv: app.env,
            tenantId: verifiedState.tenantId,
            refreshToken: issuedRefreshToken,
          });
          if (cleanupOutcome === "queued") {
            request.log.warn(
              { eventCode: "QUICKBOOKS_ORPHAN_REVOCATION_QUEUED" },
              "QuickBooks OAuth cleanup was durably queued.",
            );
          } else if (cleanupOutcome === "dead") {
            orphanCleanupFailed = true;
            request.log.error(
              { eventCode: "QUICKBOOKS_ORPHAN_REVOCATION_DEAD" },
              "QuickBooks OAuth cleanup requires operator escalation.",
            );
          }
        } catch (cleanupError) {
          orphanCleanupFailed = true;
          request.log.error(
            {
              eventCode: "QUICKBOOKS_ORPHAN_REVOCATION_PERSIST_FAILED",
              errorName: cleanupError instanceof QuickBooksOrphanCredentialPersistenceError
                ? cleanupError.name
                : "UnknownError",
            },
            "QuickBooks OAuth cleanup could not be durably persisted.",
          );
        }
      }
      if (orphanCleanupFailed) return failureRedirect("quickbooks_cleanup_failed");
      if (error instanceof QuickBooksOAuthStateReplayError) {
        return failureRedirect("quickbooks_invalid_state");
      }
      if (error instanceof QuickBooksRealmChangeBlockedError) {
        return failureRedirect("quickbooks_realm_change_blocked");
      }
      if (error instanceof QuickBooksCredentialLifecycleBlockedError) {
        return failureRedirect("quickbooks_disconnect_pending");
      }
      request.log.error("QuickBooks OAuth callback failed.");
      return failureRedirect("quickbooks_error");
    }
  });

  app.post(
    "/integrations/quickbooks/disconnect",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const claims = getJwtClaims(request);
      if (!(await requireLiveQuickBooksManagerAccess(claims, reply))) return;
      const access = buildAccessContext(request);

      const result = await disconnectQuickBooksConnection({
        prisma: app.prisma,
        runtimeEnv: app.env,
        tenantId: claims.tenantId,
        actorTenantUserId: access.tenantUserId,
        requestId: access.requestId,
      });
      return result === "disconnected"
        ? { disconnected: true }
        : reply.code(202).send({ disconnected: false, revocationPending: true });
    },
  );

  app.get(
    "/integrations/quickbooks/quotes/:quoteId/sync-preview",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const claims = getJwtClaims(request);

      if (!(await requireLiveQuickBooksManagerAccess(claims, reply))) return;
      if (!accountingWorkflowsAvailable()) return accountingWorkflowsUnavailable(reply);
      const { quoteId } = QuickBooksQuotePreviewParamsSchema.parse(request.params);

      try {
        const context = await loadQuickBooksSyncContext(claims.tenantId, quoteId);

        return {
          connection: {
            realmId: context.connection.realmId,
            companyName: context.connection.companyName,
          },
          customer: {
            quoteFlyCustomerId: context.quote.customer.id,
            fullName: context.quote.customer.fullName,
            email: context.quote.customer.email,
            phone: context.quote.customer.phone,
            quickBooksCustomerId: context.customerMap?.quickBooksCustomerId ?? null,
            quickBooksDisplayName: context.customerMap?.quickBooksDisplayName ?? null,
            createPayload: {
              DisplayName: normalizeQuickBooksName(context.quote.customer.fullName),
              PrimaryEmailAddr: context.quote.customer.email
                ? { Address: context.quote.customer.email }
                : undefined,
              PrimaryPhone: context.quote.customer.phone
                ? { FreeFormNumber: context.quote.customer.phone }
                : undefined,
            },
          },
          invoice: {
            quoteId: context.quote.id,
            quoteTitle: context.quote.title,
            docNumber: quickBooksDocNumber(context.quote.id),
            invoiceDate: context.invoiceDate,
            dueDate: context.dueDate,
            totalAmount: Number(context.quote.totalAmount),
            payload: {
              DocNumber: quickBooksDocNumber(context.quote.id),
              TxnDate: context.invoiceDate,
              DueDate: context.dueDate,
              PrivateNote: `QuoteFly quote ${context.quote.id}`,
              CustomerRef: context.customerMap
                ? {
                    value: context.customerMap.quickBooksCustomerId,
                    name: context.customerMap.quickBooksDisplayName ?? context.quote.customer.fullName,
                  }
                : null,
              Line: context.lineItems.map((lineItem) => lineItem.payload),
            },
          },
          lineItems: context.lineItems,
          warnings: context.warnings,
          sync: context.existingSync,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "QuickBooks sync preview failed.";
        return reply.code(message === "Quote not found." ? 404 : 409).send({ error: message });
      }
    },
  );

  app.post(
    "/integrations/quickbooks/setup-confirmation",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const body = QuickBooksSetupConfirmationBodySchema.parse(request.body);
      const claims = getJwtClaims(request);
      if (!(await requireLiveQuickBooksManagerAccess(claims, reply))) return;
      if (!accountingWorkflowsAvailable()) return accountingWorkflowsUnavailable(reply);
      const access = buildAccessContext(request);
      reply.header("Cache-Control", "private, no-store");

      const result = await withTenantRlsContext(
        app.prisma,
        claims.tenantId,
        async (transaction) => {
          await transaction.$queryRaw(Prisma.sql`
            SELECT 1::int AS "locked"
            FROM (
              SELECT pg_advisory_xact_lock(
                hashtextextended(${`quickbooks-setup:${claims.tenantId}`}, 0)
              )
            ) acquired
          `);

          const connection = await transaction.quickBooksConnection.findFirst({
            where: { tenantId: claims.tenantId, deletedAtUtc: null },
            select: QuickBooksSetupConnectionSelect,
          });
          const currentSetup = deriveQuickBooksSetupReadiness(quickBooksSetupRuntime(), connection);
          if (!connection || !currentSetup.capabilities.canConfirm) {
            return { confirmed: false as const, setup: currentSetup, idempotent: false };
          }
          if (currentSetup.confirmed) {
            return { confirmed: true as const, setup: currentSetup, idempotent: true };
          }

          const updated = await transaction.quickBooksConnection.updateMany({
            where: {
              id: connection.id,
              tenantId: claims.tenantId,
              deletedAtUtc: null,
              status: "CONNECTED",
            },
            data: {
              setupConfirmedAtUtc: new Date(),
              setupConfirmedByTenantUserId: access.tenantUserId,
              setupChecklistVersion: body.checklistVersion,
            },
          });
          if (updated.count !== 1) {
            return { confirmed: false as const, setup: currentSetup, idempotent: false };
          }
          await recordQuickBooksConnectionEvent(transaction, {
            tenantId: claims.tenantId,
            quickBooksConnectionId: connection.id,
            actorTenantUserId: access.tenantUserId,
            requestId: access.requestId,
            action: "SETUP_CONFIRMED",
            outcome: "SUCCEEDED",
            connectionGeneration: await currentQuickBooksConnectionGeneration(transaction, claims.tenantId),
          });
          const savedConnection = await transaction.quickBooksConnection.findFirstOrThrow({
            where: { id: connection.id, tenantId: claims.tenantId, deletedAtUtc: null },
            select: QuickBooksSetupConnectionSelect,
          });
          return {
            confirmed: true as const,
            setup: deriveQuickBooksSetupReadiness(quickBooksSetupRuntime(), savedConnection),
            idempotent: false,
          };
        },
        { maxWait: 5_000, timeout: 10_000 },
      );

      if (!result.confirmed) {
        return reply.code(409).send({
          error: "QuickBooks setup is not ready for confirmation.",
          code: "QUICKBOOKS_SETUP_NOT_READY",
          setup: result.setup,
        });
      }
      return result;
    },
  );

  app.post(
    "/integrations/quickbooks/mappings/customers/search",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const access = buildAccessContext(request);
      const claims = getJwtClaims(request);
      if (!(await requireLiveQuickBooksManagerAccess(claims, reply))) return;
      const query = QuickBooksMappingSearchBodySchema.parse(request.body);
      if (!accountingWorkflowsAvailable()) return accountingWorkflowsUnavailable(reply);
      const connection = await loadConnectedQuickBooksProvider(access.tenantId);
      if (!connection) return reply.code(409).send({ error: "Reconnect QuickBooks before searching customers.", code: "QUICKBOOKS_NOT_CONNECTED" });
      try {
        const candidates = await runQuickBooksProviderRequest(
          connection,
          (accessToken) => searchQuickBooksCustomers(app.env, connection.realmId, accessToken, query.query, query.limit),
        );
        reply.header("Cache-Control", "private, no-store");
        return {
          candidates: candidates.map((customer) => ({
            quickBooksCustomerId: customer.Id,
            displayName: customer.DisplayName ?? "QuickBooks customer",
            email: customer.PrimaryEmailAddr?.Address ?? null,
          })),
        };
      } catch (error) {
        if (sendQuickBooksReauthRequired(reply, error)) return;
        throw error;
      }
    },
  );

  app.post(
    "/integrations/quickbooks/mappings/items/search",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const access = buildAccessContext(request);
      const claims = getJwtClaims(request);
      if (!(await requireLiveQuickBooksManagerAccess(claims, reply))) return;
      const query = QuickBooksMappingSearchBodySchema.parse(request.body);
      if (!accountingWorkflowsAvailable()) return accountingWorkflowsUnavailable(reply);
      const connection = await loadConnectedQuickBooksProvider(access.tenantId);
      if (!connection) return reply.code(409).send({ error: "Reconnect QuickBooks before searching items.", code: "QUICKBOOKS_NOT_CONNECTED" });
      try {
        const candidates = await runQuickBooksProviderRequest(
          connection,
          (accessToken) => searchQuickBooksItems(app.env, connection.realmId, accessToken, query.query, query.limit),
        );
        reply.header("Cache-Control", "private, no-store");
        return {
          candidates: candidates.map((item) => ({
            quickBooksItemId: item.Id,
            name: item.Name ?? "QuickBooks item",
            type: item.Type ?? null,
          })),
        };
      } catch (error) {
        if (sendQuickBooksReauthRequired(reply, error)) return;
        throw error;
      }
    },
  );

  app.post(
    "/integrations/quickbooks/mappings/customer/review",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const access = buildAccessContext(request);
      const claims = getJwtClaims(request);
      if (!(await requireLiveQuickBooksManagerAccess(claims, reply))) return;
      const body = QuickBooksCustomerMappingReviewBodySchema.parse(request.body);
      if (!accountingWorkflowsAvailable()) return accountingWorkflowsUnavailable(reply);
      const connection = await loadConnectedQuickBooksProvider(access.tenantId);
      if (!connection) return reply.code(409).send({ error: "Reconnect QuickBooks before reviewing mappings.", code: "QUICKBOOKS_NOT_CONNECTED" });
      try {
        const customer = await runQuickBooksProviderRequest(
          connection,
          (accessToken) => fetchQuickBooksCustomer(app.env, connection.realmId, accessToken, body.quickBooksCustomerId),
        );
        const mapping = await withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
          reviewQuickBooksCustomerMapping(transaction, access, {
            connectionId: connection.id,
            customerId: body.customerId,
            quickBooksCustomerId: customer.Id,
            quickBooksDisplayName: customer.DisplayName ?? "QuickBooks customer",
          }),
        );
        reply.header("Cache-Control", "private, no-store");
        return { mapping };
      } catch (error) {
        if (error instanceof QuickBooksMappingError) return reply.code(error.statusCode).send({ error: error.message, code: error.code });
        if (sendQuickBooksReauthRequired(reply, error)) return;
        throw error;
      }
    },
  );

  app.post(
    "/integrations/quickbooks/mappings/item/review",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const access = buildAccessContext(request);
      const claims = getJwtClaims(request);
      if (!(await requireLiveQuickBooksManagerAccess(claims, reply))) return;
      const body = QuickBooksItemMappingReviewBodySchema.parse(request.body);
      if (!accountingWorkflowsAvailable()) return accountingWorkflowsUnavailable(reply);
      const connection = await loadConnectedQuickBooksProvider(access.tenantId);
      if (!connection) return reply.code(409).send({ error: "Reconnect QuickBooks before reviewing mappings.", code: "QUICKBOOKS_NOT_CONNECTED" });
      try {
        const item = await runQuickBooksProviderRequest(
          connection,
          (accessToken) => fetchQuickBooksItem(app.env, connection.realmId, accessToken, body.quickBooksItemId),
        );
        const mapping = await withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
          reviewQuickBooksItemMapping(transaction, access, {
            connectionId: connection.id,
            itemKey: body.itemKey,
            quickBooksItemId: item.Id,
            quickBooksItemName: item.Name ?? "QuickBooks item",
            workPresetId: body.workPresetId,
          }),
        );
        reply.header("Cache-Control", "private, no-store");
        return { mapping };
      } catch (error) {
        if (error instanceof QuickBooksMappingError) return reply.code(error.statusCode).send({ error: error.message, code: error.code });
        if (sendQuickBooksReauthRequired(reply, error)) return;
        throw error;
      }
    },
  );

  app.post(
    "/integrations/quickbooks/invoices/:invoiceId/sync-preview",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const access = buildAccessContext(request);
      const { invoiceId } = QuickBooksInvoiceParamsSchema.parse(request.params);
      const paymentReview = QuickBooksInvoicePreviewBodySchema.parse(request.body ?? {});
      if (!accountingWorkflowsAvailable()) return accountingWorkflowsUnavailable(reply);
      if (
        (paymentReview.allowOnlineAchPayment || paymentReview.allowOnlineCardPayment)
        && !hostedPaymentsRuntimeAvailable()
      ) {
        return hostedPaymentsRuntimeUnavailable(reply);
      }
      try {
        const preview = await withTenantRlsContext(
          app.prisma,
          access.tenantId,
          (transaction) => getQuickBooksInvoiceSyncPreview(
            transaction,
            access,
            invoiceId,
            app.env.JWT_SECRET,
            paymentReview,
          ),
          { maxWait: 5_000, timeout: 15_000 },
        );
        reply.header("Cache-Control", "private, no-store");
        return {
          providerWorkflowsEnabled: app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED,
          preview: serializeQuickBooksInvoicePreview(preview),
        };
      } catch (error) {
        return sendQuickBooksInvoiceOperationError(reply, error);
      }
    },
  );

  app.post(
    "/integrations/quickbooks/invoices/:invoiceId/publish",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const access = buildAccessContext(request);
      const claims = getJwtClaims(request);
      const { invoiceId } = QuickBooksInvoiceParamsSchema.parse(request.params);
      const body = QuickBooksInvoicePublishBodySchema.parse(request.body);
      const key = quickBooksIdempotencyKey(request);
      if (!accountingWorkflowsAvailable()) return accountingWorkflowsUnavailable(reply);
      if (!reconciliationRuntimeAvailable()) return reconciliationRuntimeUnavailable(reply);
      if (
        (body.allowOnlineAchPayment || body.allowOnlineCardPayment)
        && !hostedPaymentsRuntimeAvailable()
      ) {
        return hostedPaymentsRuntimeUnavailable(reply);
      }
      if (!isQuickBooksConfigured(app.env)) {
        return reply.code(503).send({
          error: "QuickBooks integration is not configured yet.",
          code: "QUICKBOOKS_NOT_CONFIGURED",
        });
      }

      let claim: Awaited<ReturnType<typeof claimQuickBooksInvoicePublish>>;
      try {
        claim = await withTenantRlsContext(
          app.prisma,
          access.tenantId,
          (transaction) => claimQuickBooksInvoicePublish(transaction, access, {
            invoiceId,
            invoiceVersion: body.invoiceVersion,
            idempotencyKey: key,
            reviewBinding: body.reviewBinding,
            reviewSecret: app.env.JWT_SECRET,
            paymentReview: {
              billingEmail: body.billingEmail,
              allowOnlineAchPayment: body.allowOnlineAchPayment,
              allowOnlineCardPayment: body.allowOnlineCardPayment,
            },
          }),
          {
            maxWait: 5_000,
            timeout: 15_000,
            // The transaction-scoped advisory lock is the serialization primitive.
            // READ COMMITTED lets a waiter observe the winner's durable claim.
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          },
        );
      } catch (error) {
        return sendQuickBooksInvoiceOperationError(reply, error);
      }

      if (claim.duplicate) {
        reply.header("Cache-Control", "private, no-store");
        return {
          duplicate: true,
          reconciliationRequired: claim.requiresReconciliation,
          operation: serializeQuickBooksInvoiceOperation(claim.operation),
        };
      }

      if (claim.requiresReconciliation) {
        return reply.code(409).send({
          error: "The prior QuickBooks result is uncertain. Reconcile it before trying again.",
          code: "QUICKBOOKS_RECONCILIATION_REQUIRED",
          duplicate: false,
          reconciliationRequired: true,
          operation: serializeQuickBooksInvoiceOperation(claim.operation),
        });
      }

      if (!(await hasLiveQuickBooksManagerAccess(claims.tenantId, claims.userId))) {
        const operation = await withTenantRlsContext(
          app.prisma,
          access.tenantId,
          (transaction) => failQuickBooksInvoicePublish(transaction, access, {
            invoiceId,
            claimToken: claim.claimToken as string,
            failureCode: "AUTHORIZATION_CHANGED",
            ambiguous: false,
          }),
        );
        return reply.code(403).send({
          error: "Only owners or admins can manage QuickBooks.",
          code: "QUICKBOOKS_INVOICE_FORBIDDEN",
          operation: serializeQuickBooksInvoiceOperation(operation),
        });
      }

      const providerConnection = {
        ...claim.connection,
        realmId: claim.operation.providerRealmId,
      };
      let createdInvoice: Awaited<ReturnType<typeof createQuickBooksInvoice>>;
      try {
        createdInvoice = await runQuickBooksProviderRequest(
          providerConnection,
          (accessToken) => createQuickBooksInvoice(
            app.env,
            claim.operation.providerRealmId,
            accessToken,
            claim.providerPayload,
            claim.providerRequestId,
          ),
        );
      } catch (error) {
        const failure = classifyQuickBooksProviderFailure(error);
        const operation = await withTenantRlsContext(
          app.prisma,
          access.tenantId,
          (transaction) => failQuickBooksInvoicePublish(transaction, access, {
            invoiceId,
            claimToken: claim.claimToken as string,
            failureCode: failure.code,
            ambiguous: failure.ambiguous,
          }),
        );
        request.log.error(
          { code: failure.code, ambiguous: failure.ambiguous, invoiceId },
          "QuickBooks invoice publish failed",
        );
        if (sendQuickBooksReauthRequired(reply, error)) return;
        return reply.code(failure.ambiguous ? 202 : 502).send({
          error: failure.ambiguous
            ? "The QuickBooks result is uncertain. Reconcile it before trying again."
            : "QuickBooks rejected the invoice publish.",
          code: failure.ambiguous ? "QUICKBOOKS_RESULT_UNCERTAIN" : "QUICKBOOKS_PUBLISH_REJECTED",
          duplicate: false,
          reconciliationRequired: failure.ambiguous,
          operation: serializeQuickBooksInvoiceOperation(operation),
        });
      }

      let authoritativeInvoice: Awaited<ReturnType<typeof fetchQuickBooksInvoice>>;
      try {
        authoritativeInvoice = await runQuickBooksProviderRequest(
          providerConnection,
          (accessToken) => fetchQuickBooksInvoice(
            app.env,
            claim.operation.providerRealmId,
            accessToken,
            createdInvoice.Id,
          ),
        );
        if (authoritativeInvoice.Id !== createdInvoice.Id) {
          throw new QuickBooksProviderError("QUICKBOOKS_INVOICE_ID_MISMATCH", true);
        }
      } catch (error) {
        const failure = classifyQuickBooksProviderFailure(error);
        // A successful provider CREATE is irreversible from QuoteFly's point of
        // view. Persist its identity before returning for every confirmation-read
        // failure, including revoked authorization, so no retry can create a
        // second financial record.
        const operation = await withTenantRlsContext(
          app.prisma,
          access.tenantId,
          (transaction) => retainCreatedQuickBooksInvoiceForReconciliation(transaction, access, {
            invoiceId,
            claimToken: claim.claimToken as string,
            providerInvoiceId: createdInvoice.Id,
            failureCode: failure.code,
          }),
        );
        request.log.warn(
          { code: failure.code, invoiceId },
          "QuickBooks invoice was created but its authoritative snapshot remains pending",
        );
        if (isQuickBooksReauthorizationError(error)) {
          return reply.code(409).send({
            error: "QuickBooks authorization needs attention. Reconnect the workspace and then reconcile this invoice.",
            code: "QUICKBOOKS_REAUTH_REQUIRED",
            duplicate: false,
            reconciliationRequired: true,
            operation: serializeQuickBooksInvoiceOperation(operation),
          });
        }
        return reply.code(202).send({
          error: "QuickBooks created the invoice, but QuoteFly could not confirm its latest provider state. Reconcile before trying again.",
          code: "QUICKBOOKS_RESULT_UNCERTAIN",
          duplicate: false,
          reconciliationRequired: true,
          operation: serializeQuickBooksInvoiceOperation(operation),
        });
      }

      try {
        await withTenantRlsContext(
          app.prisma,
          access.tenantId,
          (transaction) => completeQuickBooksInvoicePublish(transaction, access, {
            invoiceId,
            claimToken: claim.claimToken as string,
            providerInvoiceId: createdInvoice.Id,
            providerSyncToken: authoritativeInvoice.SyncToken ?? null,
            providerInvoiceStatus: authoritativeInvoice.TxnStatus ?? null,
            providerBalance: Number(authoritativeInvoice.Balance ?? authoritativeInvoice.TotalAmt ?? 0),
            providerUpdatedAtUtc: authoritativeInvoice.MetaData?.LastUpdatedTime
              ? new Date(authoritativeInvoice.MetaData.LastUpdatedTime)
              : null,
          }),
          { maxWait: 5_000, timeout: 15_000 },
        );
        reply.header("Cache-Control", "private, no-store");
        let reconciliation: Awaited<ReturnType<typeof reconcileQuickBooksInvoice>> | null = null;
        try {
          reconciliation = await reconcileQuickBooksInvoice({
            prisma: app.prisma,
            runtimeEnv: app.env,
            tenantId: access.tenantId,
            invoiceId,
            trigger: "PUBLISH",
            getAccessToken,
          });
        } catch (reconciliationError) {
          const failureCode = reconciliationError instanceof QuickBooksReconciliationError
            ? reconciliationError.code
            : classifyQuickBooksProviderFailure(reconciliationError).code;
          await withTenantRlsContext(
            app.prisma,
            access.tenantId,
            (transaction) => markQuickBooksInitialReconciliationRequired(transaction, access, {
              invoiceId,
              providerInvoiceId: createdInvoice.Id,
              payloadHash: claim.operation.payloadHash,
              failureCode,
            }),
            { maxWait: 5_000, timeout: 15_000 },
          );
          request.log.warn(
            { invoiceId, code: failureCode },
            "QuickBooks invoice was published but initial reconciliation remains pending",
          );
        }
        const operation = await withTenantRlsContext(
          app.prisma,
          access.tenantId,
          (transaction) => transaction.quickBooksInvoiceOperation.findFirstOrThrow({
            where: { tenantId: access.tenantId, invoiceId, archivedAtUtc: null },
            select: QuickBooksInvoiceOperationPublicSelect,
          }),
        );
        const reconciliationRequired = !reconciliation || operation.status !== "SUCCEEDED";
        return reply.code(201).send({
          duplicate: false,
          reconciliationRequired,
          operation: serializeQuickBooksInvoiceOperation(operation),
          reconciliation: reconciliation ? serializeQuickBooksReconciliation(reconciliation) : null,
        });
      } catch (error) {
        let operation: QuickBooksInvoiceOperationPublic | null = null;
        try {
          operation = await withTenantRlsContext(
            app.prisma,
            access.tenantId,
            (transaction) => failQuickBooksInvoicePublish(transaction, access, {
              invoiceId,
              claimToken: claim.claimToken as string,
              failureCode: "LOCAL_COMMIT_RESULT_UNKNOWN",
              ambiguous: true,
            }),
          );
        } catch {
          // The durable PROCESSING claim will expire into reconciliation-required
          // state; never issue a second provider write from this response path.
        }
        request.log.error(
          { invoiceId, code: "LOCAL_COMMIT_RESULT_UNKNOWN" },
          "QuickBooks provider succeeded but local completion is uncertain",
        );
        return reply.code(202).send({
          error: "QuickBooks may have created the invoice, but QuoteFly could not confirm the local result. Reconcile before trying again.",
          code: "LOCAL_COMMIT_RESULT_UNKNOWN",
          duplicate: false,
          reconciliationRequired: true,
          operation: operation
            ? serializeQuickBooksInvoiceOperation(operation)
            : {
                status: "RECONCILIATION_REQUIRED" as const,
                providerDocNumber: claim.operation.providerDocNumber,
                reconciliationAvailable: true,
              },
        });
      }
    },
  );

  app.post(
    "/integrations/quickbooks/invoices/:invoiceId/reconcile",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const access = buildAccessContext(request);
      const { invoiceId } = QuickBooksInvoiceParamsSchema.parse(request.params);
      if (!accountingWorkflowsAvailable()) return accountingWorkflowsUnavailable(reply);
      if (!isQuickBooksConfigured(app.env)) {
        return reply.code(503).send({
          error: "QuickBooks integration is not configured yet.",
          code: "QUICKBOOKS_NOT_CONFIGURED",
        });
      }

      let claim: Awaited<ReturnType<typeof claimQuickBooksInvoiceReconciliation>>;
      try {
        claim = await withTenantRlsContext(
          app.prisma,
          access.tenantId,
          (transaction) => claimQuickBooksInvoiceReconciliation(transaction, access, invoiceId),
          {
            maxWait: 5_000,
            timeout: 15_000,
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          },
        );
      } catch (error) {
        return sendQuickBooksInvoiceOperationError(reply, error);
      }

      if (claim.duplicate) {
        return {
          found: true,
          operation: serializeQuickBooksInvoiceOperation(claim.operation),
        };
      }

      let providerInvoice: Awaited<ReturnType<typeof fetchQuickBooksInvoice>> | null = null;
      try {
        const providerConnection = {
          ...claim.connection,
          realmId: claim.providerRealmId,
        };
        const providerInvoices = await runQuickBooksProviderRequest(
          providerConnection,
          async (accessToken) => claim.providerInvoiceId
            ? [await fetchQuickBooksInvoice(
                app.env,
                claim.providerRealmId,
                accessToken,
                claim.providerInvoiceId,
              )]
            : findQuickBooksInvoicesByDocNumber(
                app.env,
                claim.providerRealmId,
                accessToken,
                claim.providerDocNumber,
              ),
        );
        providerInvoice = providerInvoices.length === 1
          && quickBooksInvoiceFingerprint(providerInvoices[0] as NonNullable<typeof providerInvoices[0]>) === claim.payloadHash
          ? providerInvoices[0] as NonNullable<typeof providerInvoices[0]>
          : null;

        if (!providerInvoice) {
          const operation = await withTenantRlsContext(
            app.prisma,
            access.tenantId,
            (transaction) => retainQuickBooksInvoiceReconciliation(transaction, access, {
              invoiceId,
              claimToken: claim.claimToken as string,
              failureCode: providerInvoices.length === 0
                ? "QUICKBOOKS_INVOICE_NOT_FOUND"
                : providerInvoices.length > 1
                  ? "QUICKBOOKS_INVOICE_MATCH_AMBIGUOUS"
                  : "QUICKBOOKS_INVOICE_FINGERPRINT_MISMATCH",
            }),
          );
          return {
            found: false,
            reconciliationRequired: true,
            operation: serializeQuickBooksInvoiceOperation(operation),
          };
        }
      } catch (error) {
        const failure = classifyQuickBooksProviderFailure(error);
        if (isQuickBooksReauthorizationError(error)) {
          // The exact-generation NEEDS_REAUTH transition clears the manual
          // claim and leaves provider-bound operations in durable
          // reconciliation. Reload that authoritative state instead of trying
          // to retain an intentionally stale claim.
          const operation = await withTenantRlsContext(
            app.prisma,
            access.tenantId,
            (transaction) => transaction.quickBooksInvoiceOperation.findFirstOrThrow({
              where: { tenantId: access.tenantId, invoiceId, archivedAtUtc: null },
              select: QuickBooksInvoiceOperationPublicSelect,
            }),
          );
          request.log.warn(
            { code: failure.code, invoiceId },
            "QuickBooks invoice identity lookup requires reauthorization",
          );
          return reply.code(409).send({
            error: "QuickBooks authorization needs attention. Reconnect the workspace and try again.",
            code: "QUICKBOOKS_REAUTH_REQUIRED",
            found: Boolean(claim.providerInvoiceId),
            reconciliationRequired: true,
            operation: serializeQuickBooksInvoiceOperation(operation),
          });
        }
        const operation = await withTenantRlsContext(
          app.prisma,
          access.tenantId,
          (transaction) => retainQuickBooksInvoiceReconciliation(transaction, access, {
            invoiceId,
            claimToken: claim.claimToken as string,
            failureCode: failure.code,
          }),
        );
        request.log.warn(
          { code: failure.code, invoiceId },
          "QuickBooks invoice reconciliation could not resolve provider identity",
        );
        return reply.code(503).send({
          error: "QuickBooks invoice reconciliation could not confirm the provider state.",
          code: "QUICKBOOKS_RECONCILIATION_UNAVAILABLE",
          reconciliationRequired: true,
          operation: serializeQuickBooksInvoiceOperation(operation),
        });
      }

      try {
        await withTenantRlsContext(
          app.prisma,
          access.tenantId,
          (transaction) => bindQuickBooksInvoiceReconciliationIdentity(transaction, access, {
            invoiceId,
            claimToken: claim.claimToken as string,
            providerInvoiceId: providerInvoice.Id,
          }),
        );
        const reconciliation = await reconcileQuickBooksInvoice({
          prisma: app.prisma,
          runtimeEnv: app.env,
          tenantId: access.tenantId,
          invoiceId,
          trigger: "MANUAL",
          getAccessToken,
        });
        const operation = await withTenantRlsContext(
          app.prisma,
          access.tenantId,
          (transaction) => transaction.quickBooksInvoiceOperation.findFirstOrThrow({
            where: { tenantId: access.tenantId, invoiceId, archivedAtUtc: null },
            select: QuickBooksInvoiceOperationPublicSelect,
          }),
        );
        reply.header("Cache-Control", "private, no-store");
        return {
          found: true,
          reconciliationRequired: operation.status !== "SUCCEEDED",
          operation: serializeQuickBooksInvoiceOperation(operation),
          reconciliation: serializeQuickBooksReconciliation(reconciliation),
        };
      } catch (error) {
        const failure = error instanceof QuickBooksReconciliationError
          ? { code: error.code, retryable: error.retryable }
          : { ...classifyQuickBooksProviderFailure(error), retryable: true };
        if (isQuickBooksReauthorizationError(error)) {
          // The exact-generation NEEDS_REAUTH transition already invalidates
          // hosted links and moves provider-bound operations back to durable
          // reconciliation. Reload that authoritative state instead of trying
          // to finish the now-stale manual claim.
          const operation = await withTenantRlsContext(
            app.prisma,
            access.tenantId,
            (transaction) => transaction.quickBooksInvoiceOperation.findFirstOrThrow({
              where: { tenantId: access.tenantId, invoiceId, archivedAtUtc: null },
              select: QuickBooksInvoiceOperationPublicSelect,
            }),
          );
          request.log.warn(
            { code: failure.code, invoiceId },
            "QuickBooks invoice reconciliation requires reauthorization",
          );
          return reply.code(409).send({
            error: "QuickBooks authorization needs attention. Reconnect the workspace and try again.",
            code: "QUICKBOOKS_REAUTH_REQUIRED",
            found: true,
            reconciliationRequired: true,
            operation: serializeQuickBooksInvoiceOperation(operation),
          });
        }
        let operation: QuickBooksInvoiceOperationPublic;
        try {
          operation = await withTenantRlsContext(
            app.prisma,
            access.tenantId,
            (transaction) => retainQuickBooksInvoiceReconciliation(transaction, access, {
              invoiceId,
              claimToken: claim.claimToken as string,
              failureCode: failure.code,
            }),
          );
        } catch (retentionError) {
          if (
            !(retentionError instanceof QuickBooksInvoiceOperationError)
            || retentionError.code !== "QUICKBOOKS_OPERATION_STALE"
          ) throw retentionError;
          operation = await withTenantRlsContext(
            app.prisma,
            access.tenantId,
            (transaction) => transaction.quickBooksInvoiceOperation.findFirstOrThrow({
              where: { tenantId: access.tenantId, invoiceId, archivedAtUtc: null },
              select: QuickBooksInvoiceOperationPublicSelect,
            }),
          );
        }
        request.log.warn(
          { code: failure.code, invoiceId },
          "QuickBooks invoice reconciliation could not project authoritative provider state",
        );
        return reply.code(failure.retryable ? 503 : 409).send({
          error: "QuickBooks invoice reconciliation could not confirm the provider state.",
          code: "QUICKBOOKS_RECONCILIATION_UNAVAILABLE",
          found: true,
          reconciliationRequired: true,
          operation: serializeQuickBooksInvoiceOperation(operation),
        });
      }
    },
  );

  app.post(
    "/integrations/quickbooks/invoices/:invoiceId/refresh",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const access = buildAccessContext(request);
      const claims = getJwtClaims(request);
      const { invoiceId } = QuickBooksInvoiceParamsSchema.parse(request.params);
      if (!(await requireLiveQuickBooksManagerAccess(claims, reply))) return;
      if (!accountingWorkflowsAvailable()) return accountingWorkflowsUnavailable(reply);
      try {
        const reconciliation = await reconcileQuickBooksInvoice({
          prisma: app.prisma,
          runtimeEnv: app.env,
          tenantId: access.tenantId,
          invoiceId,
          trigger: "MANUAL",
          getAccessToken,
        });
        const operation = await withTenantRlsContext(app.prisma, access.tenantId, (transaction) =>
          transaction.quickBooksInvoiceOperation.findFirstOrThrow({
            where: { tenantId: access.tenantId, invoiceId, archivedAtUtc: null },
            select: QuickBooksInvoiceOperationPublicSelect,
          }),
        );
        reply.header("Cache-Control", "private, no-store");
        return {
          operation: serializeQuickBooksInvoiceOperation(operation),
          reconciliation: serializeQuickBooksReconciliation(reconciliation),
        };
      } catch (error) {
        if (error instanceof QuickBooksReconciliationError) {
          return reply.code(error.retryable ? 503 : 409).send({ error: error.message, code: error.code });
        }
        if (sendQuickBooksReauthRequired(reply, error)) return;
        throw error;
      }
    },
  );

  app.get(
    "/integrations/quickbooks/invoices/:invoiceId/payment-link",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const access = buildAccessContext(request);
      const claims = getJwtClaims(request);
      const { invoiceId } = QuickBooksInvoiceParamsSchema.parse(request.params);
      if (!(await requireLiveQuickBooksManagerAccess(claims, reply))) return;
      if (
        !hostedPaymentsRuntimeAvailable()
      ) {
        return hostedPaymentsRuntimeUnavailable(reply);
      }
      const record = await withTenantRlsContext(app.prisma, access.tenantId, async (transaction) => {
        const operation = await transaction.quickBooksInvoiceOperation.findFirst({
          where: {
            tenantId: access.tenantId,
            invoiceId,
            archivedAtUtc: null,
            status: "SUCCEEDED",
            providerInvoiceLink: { not: null },
            providerInvoiceId: { not: null },
            invoiceLinkFetchedAtUtc: { not: null },
            lastReconciledAtUtc: { not: null },
            providerSyncToken: { not: null },
            providerUpdatedAtUtc: { not: null },
          },
          select: {
            ...QuickBooksInvoiceOperationPublicSelect,
            connection: {
              select: {
                status: true,
                realmId: true,
                deletedAtUtc: true,
                setupConfirmedAtUtc: true,
                setupConfirmedByTenantUserId: true,
                setupChecklistVersion: true,
              },
            },
          },
        });
        const invoice = await transaction.invoice.findFirst({
          where: {
            id: invoiceId,
            tenantId: access.tenantId,
            deletedAtUtc: null,
            status: "OPEN",
            paymentStatus: { in: ["PENDING", "PARTIALLY_PAID", "REFUNDED", "PARTIALLY_REFUNDED"] },
            balanceDue: { gt: 0 },
            voidedAtUtc: null,
          },
          select: { paymentStatus: true, balanceDue: true },
        });
        if (!operation || !invoice) return null;
        const binding = await transaction.quickBooksRealmBinding.findFirst({
          where: {
            tenantId: access.tenantId,
            quickBooksConnectionId: operation.quickBooksConnectionId,
            realmId: operation.providerRealmId,
            active: true,
          },
          select: { id: true },
        });
        const connectedRealmMatches = operation.connection.status === "CONNECTED"
          && operation.connection.deletedAtUtc === null
          && Boolean(operation.connection.setupConfirmedAtUtc)
          && Boolean(operation.connection.setupConfirmedByTenantUserId)
          && operation.connection.setupChecklistVersion === QUICKBOOKS_SETUP_CHECKLIST_VERSION
          && operation.connection.realmId === operation.providerRealmId;
        return binding && connectedRealmMatches ? { operation, invoice } : null;
      });
      const reviewedOnlinePayments = Boolean(
        record?.operation.allowOnlineAchPayment || record?.operation.allowOnlineCardPayment,
      );
      const hostedPaymentUrl = reviewedOnlinePayments
        && record
        && quickBooksInvoiceLinkAvailable(record.operation)
        ? (() => {
            try {
              return validateQuickBooksInvoiceLink(decryptQuickBooksHostedPaymentLink(
                app.env,
                record.operation.providerInvoiceLink as string,
              ));
            } catch {
              return null;
            }
          })()
        : null;
      if (!record || !hostedPaymentUrl) {
        return reply.code(404).send({ error: "A QuickBooks hosted payment link is not available yet.", code: "QUICKBOOKS_INVOICE_LINK_UNAVAILABLE" });
      }
      reply.header("Cache-Control", "private, no-store");
      reply.header("Referrer-Policy", "no-referrer");
      return {
        invoiceId,
        provider: "QUICKBOOKS" as const,
        hostedPaymentUrl,
        paymentStatus: record.invoice.paymentStatus,
        balanceDue: Number(record.invoice.balanceDue),
      };
    },
  );

};
