import { randomUUID } from "crypto";
import type { Prisma } from "@prisma/client";
import { FastifyPluginAsync } from "fastify";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { getJwtClaims } from "../lib/auth";
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
  findQuickBooksCustomerByDisplayName,
  findQuickBooksItemByName,
  getQuickBooksRedirectUri,
  isQuickBooksConfigured,
  isQuickBooksWebhookConfigured,
  normalizeQuickBooksName,
  resolveQuickBooksIncomeAccount,
  summarizeQuickBooksInvoice,
  verifyQuickBooksWebhookSignature,
  verifySignedQuickBooksState,
} from "../services/quickbooks";

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

const QuickBooksPushInvoiceBodySchema = z.object({
  createCustomerIfMissing: z.boolean().optional().default(true),
  createItemsIfMissing: z.boolean().optional().default(true),
  dueInDays: z.coerce.number().int().min(1).max(90).optional().default(14),
  force: z.boolean().optional().default(false),
});

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

export const quickBooksRoutes: FastifyPluginAsync = async (app) => {
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
    accessTokenEncrypted: string | null;
    refreshTokenEncrypted: string | null;
    accessTokenExpiresAtUtc: Date | null;
  }) {
    return ensureQuickBooksAccessToken(app.env, connection, async (input) => {
      await app.prisma.quickBooksConnection.update({
        where: { id: connection.id },
        data: {
          ...input,
          status: "CONNECTED",
          lastError: null,
        },
      });
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

      void processQuickBooksWebhookNotifications(notifications);
      return { received: true, count: notifications.length };
    },
  );

  app.get(
    "/integrations/quickbooks/status",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const claims = getJwtClaims(request);

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
        enabled: isQuickBooksConfigured(app.env),
        webhookConfigured: isQuickBooksWebhookConfigured(app.env),
        canManage: canManageQuickBooks(claims.role),
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
      if (!canManageQuickBooks(claims.role)) {
        return reply.code(403).send({ error: "Only owners or admins can connect QuickBooks." });
      }

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

    const verifiedState = verifySignedQuickBooksState(app.env, query.state);
    if (!verifiedState) {
      return failureRedirect("quickbooks_invalid_state");
    }

    if (!isQuickBooksConfigured(app.env)) {
      return failureRedirect("quickbooks_not_configured");
    }

    try {
      const existingRealmConnection = await app.prisma.quickBooksConnection.findFirst({
        where: {
          realmId: query.realmId,
          deletedAtUtc: null,
          tenantId: { not: verifiedState.tenantId },
        },
        select: { id: true },
      });

      if (existingRealmConnection) {
        return failureRedirect("quickbooks_realm_in_use");
      }

      const tokenResponse = await exchangeQuickBooksAuthorizationCode(app.env, query.code);
      const companyInfo = await fetchQuickBooksCompanyInfo(app.env, query.realmId, tokenResponse.access_token);
      const now = new Date();
      const accessTokenExpiresAtUtc = new Date(now.getTime() + tokenResponse.expires_in * 1000);

      await app.prisma.quickBooksConnection.upsert({
        where: { tenantId: verifiedState.tenantId },
        create: {
          tenantId: verifiedState.tenantId,
          realmId: query.realmId,
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
          realmId: query.realmId,
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

      return failureRedirect("quickbooks_connected");
    } catch (error) {
      request.log.error(error);
      return failureRedirect("quickbooks_error");
    }
  });

  app.post(
    "/integrations/quickbooks/disconnect",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const claims = getJwtClaims(request);
      if (!canManageQuickBooks(claims.role)) {
        return reply.code(403).send({ error: "Only owners or admins can disconnect QuickBooks." });
      }

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
    "/integrations/quickbooks/quotes/:quoteId/push-invoice",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const claims = getJwtClaims(request);
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
