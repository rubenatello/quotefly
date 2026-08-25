import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { FastifyPluginAsync } from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { buildAccessContext } from "../lib/access-policy";
import { getJwtClaims } from "../lib/auth";
import { withTenantRlsContext } from "../lib/tenant-rls";
import {
  buildQuickBooksAdminRedirect,
  buildQuickBooksAuthorizationUrl,
  createQuickBooksCustomer,
  createQuickBooksInvoice,
  createQuickBooksServiceItem,
  createSignedQuickBooksState,
  ensureQuickBooksAccessToken,
  encryptQuickBooksSecret,
  exchangeQuickBooksAuthorizationCode,
  fetchQuickBooksInvoice,
  fetchQuickBooksCompanyInfo,
  findQuickBooksInvoicesByDocNumber,
  findQuickBooksCustomerByDisplayName,
  findQuickBooksItemByName,
  getQuickBooksRedirectUri,
  isQuickBooksConfigured,
  isQuickBooksWebhookConfigured,
  normalizeQuickBooksName,
  resolveQuickBooksIncomeAccount,
  summarizeQuickBooksInvoice,
  classifyQuickBooksProviderFailure,
  quickBooksInvoiceFingerprint,
  QuickBooksProviderError,
  verifyQuickBooksWebhookSignature,
  verifySignedQuickBooksState,
} from "../services/quickbooks";
import {
  claimQuickBooksInvoicePublish,
  claimQuickBooksInvoiceReconciliation,
  completeQuickBooksInvoicePublish,
  completeQuickBooksInvoiceReconciliation,
  failQuickBooksInvoicePublish,
  getQuickBooksInvoiceSyncPreview,
  quickBooksInvoiceReconciliationAvailable,
  QuickBooksInvoiceOperationError,
  retainQuickBooksInvoiceReconciliation,
  type QuickBooksInvoiceOperationPublic,
  type QuickBooksInvoiceSyncPreview,
} from "../services/quickbooks-invoices";

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

const QuickBooksInvoicePublishBodySchema = z.object({
  invoiceVersion: z.number().int().min(1),
  reviewBinding: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

const QuickBooksIdempotencyKeySchema = z.string()
  .trim()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

const QuickBooksPushInvoiceBodySchema = z.object({
  createCustomerIfMissing: z.boolean().optional().default(true),
  createItemsIfMissing: z.boolean().optional().default(true),
  dueInDays: z.coerce.number().int().min(1).max(90).optional().default(14),
}).strict();

const QuickBooksWebhookNotificationSchema = z.object({
  specversion: z.string().optional(),
  id: z.string().min(1),
  source: z.string().optional(),
  type: z.string().min(1),
  datacontenttype: z.string().optional(),
  time: z.string().optional(),
  intuitentityid: z.string().optional(),
  intuitaccountid: z.string().min(1),
  data: z.record(z.string(), z.unknown()).optional().default({}),
});

const QuickBooksWebhookBodySchema = z.array(QuickBooksWebhookNotificationSchema);

function canManageQuickBooks(role: string): boolean {
  const normalized = role.trim().toLowerCase();
  return normalized === "owner" || normalized === "admin";
}

const QUICKBOOKS_PROVIDER_WORKFLOWS_UNAVAILABLE = "QUICKBOOKS_PROVIDER_WORKFLOWS_UNAVAILABLE";
const QUICKBOOKS_TAX_SYNC_UNSUPPORTED = "QUICKBOOKS_TAX_SYNC_UNSUPPORTED";

class QuickBooksRealmChangeBlockedError extends Error {}

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
    reconciliationAvailable: quickBooksInvoiceReconciliationAvailable(operation),
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

  async function loadQuickBooksSyncContext(tenantId: string, quoteId: string, dueInDays = 14) {
    const connection = await app.prisma.quickBooksConnection.findFirst({
      where: {
        tenantId,
        deletedAtUtc: null,
        status: "CONNECTED",
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

    const quote = await app.prisma.quote.findFirst({
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
      app.prisma.quickBooksCustomerMap.findFirst({
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
      app.prisma.quickBooksItemMap.findMany({
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
      app.prisma.quickBooksInvoiceSync.findFirst({
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
  }

  async function getAccessToken(connection: {
    id: string;
    tenantId: string;
    realmId: string;
  }) {
    const liveConnection = await app.prisma.quickBooksConnection.findFirst({
      where: {
        id: connection.id,
        tenantId: connection.tenantId,
        realmId: connection.realmId,
        status: "CONNECTED",
        deletedAtUtc: null,
      },
      select: {
        id: true,
        tenantId: true,
        realmId: true,
        accessTokenEncrypted: true,
        refreshTokenEncrypted: true,
        accessTokenExpiresAtUtc: true,
      },
    });
    if (!liveConnection) {
      throw new QuickBooksProviderError("QUICKBOOKS_CONNECTION_NOT_CONNECTED", false);
    }

    return ensureQuickBooksAccessToken(app.env, liveConnection, async (input) => {
      const saved = await app.prisma.quickBooksConnection.updateMany({
        where: {
          id: liveConnection.id,
          tenantId: liveConnection.tenantId,
          realmId: liveConnection.realmId,
          status: "CONNECTED",
          deletedAtUtc: null,
          refreshTokenEncrypted: liveConnection.refreshTokenEncrypted,
        },
        data: {
          ...input,
          lastError: null,
        },
      });
      if (saved.count !== 1) {
        throw new QuickBooksProviderError("QUICKBOOKS_CONNECTION_NOT_CONNECTED", false);
      }
    });
  }

  async function recordQuickBooksConnectionError(connectionId: string, message: string) {
    const lowerMessage = message.toLowerCase();
    await app.prisma.quickBooksConnection.update({
      where: { id: connectionId },
      data: {
        status:
          lowerMessage.includes("refresh token") || lowerMessage.includes("reconnect") || lowerMessage.includes("401")
            ? "NEEDS_REAUTH"
            : "ERROR",
        lastError: message.slice(0, 1000),
      },
    });
  }

  async function processQuickBooksWebhookNotifications(
    notifications: z.infer<typeof QuickBooksWebhookBodySchema>,
  ) {
    // This defense-in-depth guard keeps future callers from turning a verified
    // webhook into a token refresh/provider fetch while the kill switch is off.
    if (!app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED) return;

    for (const notification of notifications) {
      try {
        const realmId = notification.intuitaccountid;
        const entityId = notification.intuitentityid ?? null;
        const now = new Date();

        const connection = await app.prisma.quickBooksConnection.findFirst({
          where: {
            realmId,
            deletedAtUtc: null,
          },
          select: {
            id: true,
            tenantId: true,
            realmId: true,
            accessTokenEncrypted: true,
            refreshTokenEncrypted: true,
            accessTokenExpiresAtUtc: true,
          },
        });

        const eventRecord = await app.prisma.quickBooksWebhookEvent.upsert({
          where: {
            webhookEventId_realmId: {
              webhookEventId: notification.id,
              realmId,
            },
          },
          create: {
            tenantId: connection?.tenantId ?? null,
            quickBooksConnectionId: connection?.id ?? null,
            webhookEventId: notification.id,
            realmId,
            eventType: notification.type,
            entityId,
            payload: notification as unknown as Prisma.InputJsonValue,
            receivedAtUtc: notification.time ? new Date(notification.time) : now,
          },
          update: {
            tenantId: connection?.tenantId ?? null,
            quickBooksConnectionId: connection?.id ?? null,
            eventType: notification.type,
            entityId,
            payload: notification as unknown as Prisma.InputJsonValue,
            lastError: null,
          },
        });

        if (eventRecord.processedAtUtc) {
          continue;
        }

        if (!connection) {
          await app.prisma.quickBooksWebhookEvent.update({
            where: { id: eventRecord.id },
            data: {
              processedAtUtc: now,
            },
          });
          continue;
        }

        await app.prisma.quickBooksConnection.update({
          where: { id: connection.id },
          data: {
            lastWebhookAtUtc: now,
            status: "CONNECTED",
            lastError: null,
          },
        });

        if (!notification.type.toLowerCase().includes(".invoice.") || !entityId) {
          await app.prisma.quickBooksWebhookEvent.update({
            where: { id: eventRecord.id },
            data: {
              processedAtUtc: now,
            },
          });
          continue;
        }

        const existingSync = await app.prisma.quickBooksInvoiceSync.findFirst({
          where: {
            quickBooksConnectionId: connection.id,
            quickBooksInvoiceId: entityId,
            deletedAtUtc: null,
          },
          select: {
            id: true,
            syncedAtUtc: true,
          },
        });

        if (!existingSync) {
          await app.prisma.quickBooksWebhookEvent.update({
            where: { id: eventRecord.id },
            data: {
              processedAtUtc: now,
            },
          });
          continue;
        }

        const accessToken = await getAccessToken(connection);
        const invoice = await fetchQuickBooksInvoice(app.env, realmId, accessToken, entityId);
        const invoiceStatus = summarizeQuickBooksInvoice(invoice);

        await Promise.all([
          app.prisma.quickBooksInvoiceSync.update({
            where: { id: existingSync.id },
            data: {
              status: "SYNCED",
              lastError: null,
              lastAttemptedAtUtc: now,
              syncedAtUtc: existingSync.syncedAtUtc ?? now,
              payloadSnapshot: {
                webhookEventType: notification.type,
                webhookReceivedAtUtc: notification.time ?? now.toISOString(),
                invoice: invoiceStatus,
              } as unknown as Prisma.InputJsonValue,
            },
          }),
          app.prisma.quickBooksWebhookEvent.update({
            where: { id: eventRecord.id },
            data: {
              processedAtUtc: now,
              lastError: null,
            },
          }),
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message : "QuickBooks webhook processing failed.";
        app.log.error(error);

        await app.prisma.quickBooksWebhookEvent.upsert({
          where: {
            webhookEventId_realmId: {
              webhookEventId: notification.id,
              realmId: notification.intuitaccountid,
            },
          },
          create: {
            tenantId: null,
            quickBooksConnectionId: null,
            webhookEventId: notification.id,
            realmId: notification.intuitaccountid,
            eventType: notification.type,
            entityId: notification.intuitentityid ?? null,
            payload: notification as unknown as Prisma.InputJsonValue,
            lastError: message.slice(0, 4000),
          },
          update: {
            lastError: message.slice(0, 4000),
          },
        });
      }
    }
  }

  app.post(
    "/integrations/quickbooks/webhook",
    { config: { rawBody: true } },
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

      let notifications: z.infer<typeof QuickBooksWebhookBodySchema>;
      try {
        notifications = QuickBooksWebhookBodySchema.parse(JSON.parse(rawBody));
      } catch {
        return reply.code(400).send({ error: "Invalid QuickBooks webhook payload." });
      }

      // Validate ingress even while paused, then deliberately return a
      // retryable error instead of acknowledging and discarding a provider
      // change that may need a later refresh after workflows are re-enabled.
      if (!app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED) return providerWorkflowsUnavailable(reply);

      void processQuickBooksWebhookNotifications(notifications).catch((error) => {
        app.log.error({ err: error }, "QuickBooks webhook batch processing failed");
      });
      return { received: true, count: notifications.length };
    },
  );

  app.get(
    "/integrations/quickbooks/status",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const claims = getJwtClaims(request);

      if (!(await requireLiveQuickBooksManagerAccess(claims, reply))) return;

      const connection = await app.prisma.quickBooksConnection.findFirst({
        where: {
          tenantId: claims.tenantId,
          deletedAtUtc: null,
        },
        select: {
          id: true,
          realmId: true,
          environment: true,
          companyName: true,
          status: true,
          scopes: true,
          connectedAtUtc: true,
          disconnectedAtUtc: true,
          lastTokenRefreshAtUtc: true,
          lastSyncAtUtc: true,
          lastWebhookAtUtc: true,
          lastError: true,
          _count: {
            select: {
              customerMaps: { where: { deletedAtUtc: null } },
              itemMaps: { where: { deletedAtUtc: null } },
              invoiceSyncs: { where: { deletedAtUtc: null } },
            },
          },
        },
      });

      return {
        enabled: isQuickBooksConfigured(app.env) && app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED,
        configured: isQuickBooksConfigured(app.env),
        providerWorkflowsEnabled: app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED,
        webhookConfigured: isQuickBooksWebhookConfigured(app.env),
        canManage: true,
        environment: app.env.QUICKBOOKS_ENVIRONMENT,
        redirectUri: getQuickBooksRedirectUri(app.env),
        webhookUrl: `${app.env.API_URL.replace(/\/$/, "")}/v1/integrations/quickbooks/webhook`,
        connection: connection
          ? {
              id: connection.id,
              realmId: connection.realmId,
              environment: connection.environment,
              companyName: connection.companyName,
              status: connection.status,
              scopes: connection.scopes,
              connectedAtUtc: connection.connectedAtUtc,
              disconnectedAtUtc: connection.disconnectedAtUtc,
              lastTokenRefreshAtUtc: connection.lastTokenRefreshAtUtc,
              lastSyncAtUtc: connection.lastSyncAtUtc,
              lastWebhookAtUtc: connection.lastWebhookAtUtc,
              lastError: connection.lastError,
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
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const claims = getJwtClaims(request);
      if (!(await requireLiveQuickBooksManagerAccess(claims, reply))) return;

      if (!app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED) return providerWorkflowsUnavailable(reply);

      if (!isQuickBooksConfigured(app.env)) {
        return reply.code(503).send({ error: "QuickBooks integration is not configured yet." });
      }

      const state = createSignedQuickBooksState(app.env, {
        tenantId: claims.tenantId,
        userId: claims.userId,
        role: claims.role,
      });

      return {
        authorizationUrl: buildQuickBooksAuthorizationUrl(app.env, state),
      };
    },
  );

  app.get("/integrations/quickbooks/callback", async (request, reply) => {
    const query = QuickBooksCallbackQuerySchema.parse(request.query);
    const failureRedirect = (state: string) => reply.redirect(buildQuickBooksAdminRedirect(app.env, state));

    if (query.error) {
      return failureRedirect("quickbooks_denied");
    }

    if (!query.state || !query.code || !query.realmId) {
      return failureRedirect("quickbooks_error");
    }
    const callbackRealmId = query.realmId;

    const verifiedState = verifySignedQuickBooksState(app.env, query.state);
    if (!verifiedState) {
      return failureRedirect("quickbooks_invalid_state");
    }

    if (!app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED) {
      return reply.code(503).send({ error: QUICKBOOKS_PROVIDER_WORKFLOWS_UNAVAILABLE });
    }

    if (!isQuickBooksConfigured(app.env)) {
      return failureRedirect("quickbooks_not_configured");
    }

    try {
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

      const existingRealmConnection = await app.prisma.quickBooksConnection.findFirst({
        where: {
          realmId: callbackRealmId,
          deletedAtUtc: null,
          tenantId: { not: verifiedState.tenantId },
        },
        select: { id: true },
      });

      if (existingRealmConnection) {
        return failureRedirect("quickbooks_realm_in_use");
      }

      // A tenant connection is one immutable QuickBooks company generation in
      // this bounded release. Never exchange a code for another realm and then
      // mutate existing mappings or uncertain operations onto that company.
      const existingTenantConnection = await app.prisma.quickBooksConnection.findUnique({
        where: { tenantId: verifiedState.tenantId },
        select: { realmId: true },
      });
      if (existingTenantConnection && existingTenantConnection.realmId !== callbackRealmId) {
        return failureRedirect("quickbooks_realm_change_blocked");
      }

      const tokenResponse = await exchangeQuickBooksAuthorizationCode(app.env, query.code);
      const companyInfo = await fetchQuickBooksCompanyInfo(app.env, callbackRealmId, tokenResponse.access_token);

      // Provider calls intentionally stay outside database transactions. Check
      // authorization again so a revocation during the exchange cannot persist
      // newly issued credentials.
      const stillHasManagerAccess = await hasLiveQuickBooksManagerAccess(
        verifiedState.tenantId,
        verifiedState.userId,
      );
      if (!stillHasManagerAccess) {
        return failureRedirect("quickbooks_error");
      }

      const now = new Date();
      const accessTokenExpiresAtUtc = new Date(now.getTime() + tokenResponse.expires_in * 1000);

      await app.prisma.$transaction(async (transaction) => {
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
          select: { realmId: true },
        });
        if (currentConnection && currentConnection.realmId !== callbackRealmId) {
          throw new QuickBooksRealmChangeBlockedError();
        }
        await transaction.quickBooksConnection.upsert({
          where: { tenantId: verifiedState.tenantId },
          create: {
            tenantId: verifiedState.tenantId,
            realmId: callbackRealmId,
            environment: app.env.QUICKBOOKS_ENVIRONMENT,
            companyName: companyInfo.companyName,
            status: "CONNECTED",
            scopes: ["com.intuit.quickbooks.accounting"],
            accessTokenEncrypted: encryptQuickBooksSecret(app.env, tokenResponse.access_token),
            refreshTokenEncrypted: encryptQuickBooksSecret(app.env, tokenResponse.refresh_token),
            accessTokenExpiresAtUtc,
            refreshTokenRotatedAtUtc: now,
            connectedAtUtc: now,
            disconnectedAtUtc: null,
            lastError: null,
            deletedAtUtc: null,
          },
          update: {
            environment: app.env.QUICKBOOKS_ENVIRONMENT,
            companyName: companyInfo.companyName,
            status: "CONNECTED",
            scopes: ["com.intuit.quickbooks.accounting"],
            accessTokenEncrypted: encryptQuickBooksSecret(app.env, tokenResponse.access_token),
            refreshTokenEncrypted: encryptQuickBooksSecret(app.env, tokenResponse.refresh_token),
            accessTokenExpiresAtUtc,
            refreshTokenRotatedAtUtc: now,
            connectedAtUtc: now,
            disconnectedAtUtc: null,
            lastError: null,
            deletedAtUtc: null,
          },
        });
      });

      return failureRedirect("quickbooks_connected");
    } catch (error) {
      if (error instanceof QuickBooksRealmChangeBlockedError) {
        return failureRedirect("quickbooks_realm_change_blocked");
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

      const connection = await app.prisma.quickBooksConnection.findFirst({
        where: {
          tenantId: claims.tenantId,
          deletedAtUtc: null,
        },
        select: { id: true },
      });

      if (!connection) {
        return { disconnected: true };
      }

      await app.prisma.quickBooksConnection.update({
        where: { id: connection.id },
        data: {
          status: "DISCONNECTED",
          accessTokenEncrypted: null,
          refreshTokenEncrypted: null,
          accessTokenExpiresAtUtc: null,
          disconnectedAtUtc: new Date(),
          lastError: null,
        },
      });

      return { disconnected: true };
    },
  );

  app.get(
    "/integrations/quickbooks/quotes/:quoteId/sync-preview",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const claims = getJwtClaims(request);

      if (!(await requireLiveQuickBooksManagerAccess(claims, reply))) return;
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

  app.get(
    "/integrations/quickbooks/invoices/:invoiceId/sync-preview",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const access = buildAccessContext(request);
      const { invoiceId } = QuickBooksInvoiceParamsSchema.parse(request.params);
      try {
        const preview = await withTenantRlsContext(
          app.prisma,
          access.tenantId,
          (transaction) => getQuickBooksInvoiceSyncPreview(
            transaction,
            access,
            invoiceId,
            app.env.JWT_SECRET,
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
      if (!app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED) return providerWorkflowsUnavailable(reply);
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
          reconciliationRequired: false,
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

      let createdInvoice: Awaited<ReturnType<typeof createQuickBooksInvoice>>;
      try {
        const accessToken = await getAccessToken({
          ...claim.connection,
          realmId: claim.operation.providerRealmId,
        });
        createdInvoice = await createQuickBooksInvoice(
          app.env,
          claim.operation.providerRealmId,
          accessToken,
          claim.providerPayload,
          claim.providerRequestId,
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

      try {
        const operation = await withTenantRlsContext(
          app.prisma,
          access.tenantId,
          (transaction) => completeQuickBooksInvoicePublish(transaction, access, {
            invoiceId,
            claimToken: claim.claimToken as string,
            providerInvoiceId: createdInvoice.Id,
          }),
          { maxWait: 5_000, timeout: 15_000 },
        );
        reply.header("Cache-Control", "private, no-store");
        return reply.code(201).send({
          duplicate: false,
          reconciliationRequired: false,
          operation: serializeQuickBooksInvoiceOperation(operation),
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
      if (!app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED) return providerWorkflowsUnavailable(reply);
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

      try {
        const accessToken = await getAccessToken({
          ...claim.connection,
          realmId: claim.providerRealmId,
        });
        const providerInvoices = claim.providerInvoiceId
          ? [await fetchQuickBooksInvoice(
              app.env,
              claim.providerRealmId,
              accessToken,
              claim.providerInvoiceId,
            )]
          : await findQuickBooksInvoicesByDocNumber(
              app.env,
              claim.providerRealmId,
              accessToken,
              claim.providerDocNumber,
            );
        const providerInvoice = providerInvoices.length === 1
          && quickBooksInvoiceFingerprint(providerInvoices[0] as NonNullable<typeof providerInvoices[0]>) === claim.payloadHash
          ? providerInvoices[0]
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
            operation: serializeQuickBooksInvoiceOperation(operation),
          };
        }

        const operation = await withTenantRlsContext(
          app.prisma,
          access.tenantId,
          (transaction) => completeQuickBooksInvoiceReconciliation(transaction, access, {
            invoiceId,
            claimToken: claim.claimToken as string,
            providerInvoiceId: providerInvoice.Id,
          }),
        );
        return {
          found: true,
          operation: serializeQuickBooksInvoiceOperation(operation),
        };
      } catch (error) {
        const failure = classifyQuickBooksProviderFailure(error);
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
          "QuickBooks invoice reconciliation could not confirm provider state",
        );
        return reply.code(503).send({
          error: "QuickBooks invoice reconciliation could not confirm the provider state.",
          code: "QUICKBOOKS_RECONCILIATION_UNAVAILABLE",
          operation: serializeQuickBooksInvoiceOperation(operation),
        });
      }
    },
  );

  app.post(
    "/integrations/quickbooks/quotes/:quoteId/push-invoice",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const claims = getJwtClaims(request);

      if (!(await requireLiveQuickBooksManagerAccess(claims, reply))) return;
      if (!app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED) return providerWorkflowsUnavailable(reply);
      if (app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED) {
        return reply.code(410).send({
          error: "Create and reconcile QuickBooks invoices from the QuoteFly Invoice record.",
          code: "QUICKBOOKS_LEGACY_QUOTE_PUSH_RETIRED",
        });
      }
      const { quoteId } = QuickBooksQuotePreviewParamsSchema.parse(request.params);
      const body = QuickBooksPushInvoiceBodySchema.parse(request.body ?? {});

      let context: Awaited<ReturnType<typeof loadQuickBooksSyncContext>>;
      try {
        context = await loadQuickBooksSyncContext(claims.tenantId, quoteId, body.dueInDays);
      } catch (error) {
        const message = error instanceof Error ? error.message : "QuickBooks sync failed.";
        return reply.code(message === "Quote not found." ? 404 : 409).send({ error: message });
      }

      if (context.quote.status !== "ACCEPTED") {
        return reply
          .code(409)
          .send({ error: "Only won/accepted quotes can be pushed into QuickBooks invoices." });
      }

      if (Number(context.quote.taxAmount) > 0) {
        return reply.code(422).send({ error: QUICKBOOKS_TAX_SYNC_UNSUPPORTED });
      }

      if (context.existingSync?.quickBooksInvoiceId) {
        return reply.code(409).send({
          error: "This quote already has a synced QuickBooks invoice. Refresh its status instead of pushing a duplicate.",
          sync: context.existingSync,
        });
      }

      const requestId = randomUUID();
      const pendingSnapshot = {
        quoteId: context.quote.id,
        docNumber: quickBooksDocNumber(context.quote.id),
        dueInDays: body.dueInDays,
        warnings: context.warnings,
      };

      try {
        const accessToken = await getAccessToken(context.connection);

        let quickBooksCustomerId = context.customerMap?.quickBooksCustomerId ?? null;
        let quickBooksCustomerName =
          context.customerMap?.quickBooksDisplayName ?? normalizeQuickBooksName(context.quote.customer.fullName);
        let customerCreated = false;

        if (!quickBooksCustomerId) {
          const existingCustomer = await findQuickBooksCustomerByDisplayName(
            app.env,
            context.connection.realmId,
            accessToken,
            context.quote.customer.fullName,
          );

          if (existingCustomer?.Id) {
            quickBooksCustomerId = existingCustomer.Id;
            quickBooksCustomerName = existingCustomer.DisplayName ?? quickBooksCustomerName;
          } else {
            if (!body.createCustomerIfMissing) {
              return reply.code(409).send({
                error: "Customer is not mapped in QuickBooks yet. Enable automatic customer creation or create the customer first.",
              });
            }

            const createdCustomer = await createQuickBooksCustomer(app.env, context.connection.realmId, accessToken, {
              displayName: context.quote.customer.fullName,
              email: context.quote.customer.email,
              phone: context.quote.customer.phone,
            });
            quickBooksCustomerId = createdCustomer.Id;
            quickBooksCustomerName = createdCustomer.DisplayName ?? quickBooksCustomerName;
            customerCreated = true;
          }

          await app.prisma.quickBooksCustomerMap.upsert({
            where: {
              quickBooksConnectionId_customerId: {
                quickBooksConnectionId: context.connection.id,
                customerId: context.quote.customerId,
              },
            },
            create: {
              tenantId: claims.tenantId,
              quickBooksConnectionId: context.connection.id,
              customerId: context.quote.customerId,
              quickBooksCustomerId,
              quickBooksDisplayName: quickBooksCustomerName,
            },
            update: {
              quickBooksCustomerId,
              quickBooksDisplayName: quickBooksCustomerName,
              deletedAtUtc: null,
            },
          });
        }

        let incomeAccountRef:
          | {
              value: string;
              name?: string | null;
            }
          | null = null;
        let createdItems = 0;

        const resolvedLineItems = [];
        for (const lineItem of context.lineItems) {
          let quickBooksItemId = lineItem.quickBooksItemId;
          let quickBooksItemName = lineItem.quickBooksItemName ?? normalizeQuickBooksName(lineItem.description);

          if (!quickBooksItemId) {
            const existingItem = await findQuickBooksItemByName(
              app.env,
              context.connection.realmId,
              accessToken,
              lineItem.description,
            );

            if (existingItem?.Id) {
              quickBooksItemId = existingItem.Id;
              quickBooksItemName = existingItem.Name ?? quickBooksItemName;
            } else {
              if (!body.createItemsIfMissing) {
                return reply.code(409).send({
                  error: `Line item "${lineItem.description}" is not mapped in QuickBooks yet. Enable automatic item creation or create the service item first.`,
                });
              }

              if (!incomeAccountRef) {
                incomeAccountRef = await resolveQuickBooksIncomeAccount(
                  app.env,
                  context.connection.realmId,
                  accessToken,
                );
              }

              const createdItem = await createQuickBooksServiceItem(
                app.env,
                context.connection.realmId,
                accessToken,
                {
                  name: lineItem.description,
                  description: lineItem.description,
                  unitPrice: lineItem.unitPrice,
                  incomeAccountRef,
                },
              );
              quickBooksItemId = createdItem.Id;
              quickBooksItemName = createdItem.Name ?? quickBooksItemName;
              createdItems += 1;
            }

            await app.prisma.quickBooksItemMap.upsert({
              where: {
                quickBooksConnectionId_itemKey: {
                  quickBooksConnectionId: context.connection.id,
                  itemKey: lineItem.itemKey,
                },
              },
              create: {
                tenantId: claims.tenantId,
                quickBooksConnectionId: context.connection.id,
                itemKey: lineItem.itemKey,
                quickBooksItemId,
                quickBooksItemName,
              },
              update: {
                quickBooksItemId,
                quickBooksItemName,
                deletedAtUtc: null,
              },
            });
          }

          resolvedLineItems.push({
            Description: lineItem.description,
            Amount: lineItem.amount,
            DetailType: "SalesItemLineDetail",
            SalesItemLineDetail: {
              Qty: lineItem.quantity,
              UnitPrice: lineItem.unitPrice,
              ItemRef: {
                value: quickBooksItemId,
                name: quickBooksItemName,
              },
            },
          });
        }

        const invoicePayload = {
          DocNumber: quickBooksDocNumber(context.quote.id),
          TxnDate: context.invoiceDate,
          DueDate: context.dueDate,
          PrivateNote:
            Number(context.quote.taxAmount) > 0
              ? `QuoteFly quote ${context.quote.id}. Quoted tax ${Number(context.quote.taxAmount).toFixed(2)} should be reviewed in QuickBooks.`
              : `QuoteFly quote ${context.quote.id}`,
          CustomerRef: {
            value: quickBooksCustomerId,
            name: quickBooksCustomerName,
          },
          ...(context.quote.scopeText.trim()
            ? {
                CustomerMemo: {
                  value: context.quote.scopeText.trim().slice(0, 1000),
                },
              }
            : {}),
          Line: resolvedLineItems,
        };

        const createdInvoice = await createQuickBooksInvoice(
          app.env,
          context.connection.realmId,
          accessToken,
          invoicePayload,
        );
        const invoiceStatus = summarizeQuickBooksInvoice(createdInvoice);
        const now = new Date();

        const sync = await app.prisma.quickBooksInvoiceSync.upsert({
          where: {
            quickBooksConnectionId_quoteId: {
              quickBooksConnectionId: context.connection.id,
              quoteId: context.quote.id,
            },
          },
          create: {
            tenantId: claims.tenantId,
            quickBooksConnectionId: context.connection.id,
            quoteId: context.quote.id,
            quickBooksInvoiceId: invoiceStatus.invoiceId,
            quickBooksDocNumber: invoiceStatus.docNumber,
            requestId,
            status: "SYNCED",
            payloadSnapshot: {
              invoicePayload,
              warnings: context.warnings,
            },
            lastError: null,
            lastAttemptedAtUtc: now,
            syncedAtUtc: now,
          },
          update: {
            quickBooksInvoiceId: invoiceStatus.invoiceId,
            quickBooksDocNumber: invoiceStatus.docNumber,
            requestId,
            status: "SYNCED",
            payloadSnapshot: {
              invoicePayload,
              warnings: context.warnings,
            },
            lastError: null,
            lastAttemptedAtUtc: now,
            syncedAtUtc: now,
            deletedAtUtc: null,
          },
        });

        await app.prisma.quickBooksConnection.update({
          where: { id: context.connection.id },
          data: {
            lastSyncAtUtc: now,
            lastError: null,
            status: "CONNECTED",
          },
        });

        return {
          sync,
          invoice: invoiceStatus,
          warnings: context.warnings,
          customer: {
            quickBooksCustomerId,
            quickBooksDisplayName: quickBooksCustomerName,
            created: customerCreated,
          },
          createdItems,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "QuickBooks invoice push failed.";
        const now = new Date();

        await app.prisma.quickBooksInvoiceSync.upsert({
          where: {
            quickBooksConnectionId_quoteId: {
              quickBooksConnectionId: context.connection.id,
              quoteId: context.quote.id,
            },
          },
          create: {
            tenantId: claims.tenantId,
            quickBooksConnectionId: context.connection.id,
            quoteId: context.quote.id,
            requestId,
            status: "FAILED",
            payloadSnapshot: pendingSnapshot,
            lastError: message.slice(0, 4000),
            lastAttemptedAtUtc: now,
          },
          update: {
            requestId,
            status: "FAILED",
            payloadSnapshot: pendingSnapshot,
            lastError: message.slice(0, 4000),
            lastAttemptedAtUtc: now,
          },
        });

        await recordQuickBooksConnectionError(context.connection.id, message);
        request.log.error(error);
        return reply.code(500).send({ error: message });
      }
    },
  );

  app.get(
    "/integrations/quickbooks/quotes/:quoteId/invoice-status",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const claims = getJwtClaims(request);

      if (!(await requireLiveQuickBooksManagerAccess(claims, reply))) return;
      if (!app.env.QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED) return providerWorkflowsUnavailable(reply);
      const { quoteId } = QuickBooksQuotePreviewParamsSchema.parse(request.params);

      let context: Awaited<ReturnType<typeof loadQuickBooksSyncContext>>;
      try {
        context = await loadQuickBooksSyncContext(claims.tenantId, quoteId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "QuickBooks invoice status failed.";
        return reply.code(message === "Quote not found." ? 404 : 409).send({ error: message });
      }

      if (!context.existingSync?.quickBooksInvoiceId) {
        return reply.code(404).send({ error: "This quote has not been pushed to QuickBooks yet." });
      }

      try {
        const accessToken = await getAccessToken(context.connection);
        const invoice = await fetchQuickBooksInvoice(
          app.env,
          context.connection.realmId,
          accessToken,
          context.existingSync.quickBooksInvoiceId,
        );
        const invoiceStatus = summarizeQuickBooksInvoice(invoice);
        const now = new Date();

        await Promise.all([
          app.prisma.quickBooksConnection.update({
            where: { id: context.connection.id },
            data: {
              lastSyncAtUtc: now,
              lastError: null,
              status: "CONNECTED",
            },
          }),
          app.prisma.quickBooksInvoiceSync.update({
            where: { id: context.existingSync.id },
            data: {
              status: "SYNCED",
              lastError: null,
              lastAttemptedAtUtc: now,
              syncedAtUtc: context.existingSync.syncedAtUtc ?? now,
            },
          }),
        ]);

        return {
          sync: {
            ...context.existingSync,
            status: "SYNCED",
            lastError: null,
            lastAttemptedAtUtc: now,
            syncedAtUtc: context.existingSync.syncedAtUtc ?? now,
          },
          invoice: invoiceStatus,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "QuickBooks invoice status refresh failed.";
        const now = new Date();

        await app.prisma.quickBooksInvoiceSync.update({
          where: { id: context.existingSync.id },
          data: {
            status: "FAILED",
            lastError: message.slice(0, 4000),
            lastAttemptedAtUtc: now,
          },
        });
        await recordQuickBooksConnectionError(context.connection.id, message);
        request.log.error(error);
        return reply.code(500).send({ error: message });
      }
    },
  );
};
