import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getJwtClaims } from "../lib/auth";
import {
  buildQuickBooksAdminRedirect,
  buildQuickBooksAuthorizationUrl,
  createSignedQuickBooksState,
  encryptQuickBooksSecret,
  exchangeQuickBooksAuthorizationCode,
  fetchQuickBooksCompanyInfo,
  getQuickBooksRedirectUri,
  isQuickBooksConfigured,
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

export const quickBooksRoutes: FastifyPluginAsync = async (app) => {
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
        canManage: canManageQuickBooks(claims.role),
        environment: app.env.QUICKBOOKS_ENVIRONMENT,
        redirectUri: getQuickBooksRedirectUri(app.env),
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

      const connection = await app.prisma.quickBooksConnection.findFirst({
        where: {
          tenantId: claims.tenantId,
          deletedAtUtc: null,
          status: "CONNECTED",
        },
        select: {
          id: true,
          realmId: true,
          companyName: true,
        },
      });

      if (!connection) {
        return reply.code(409).send({ error: "QuickBooks is not connected for this tenant." });
      }

      const quote = await app.prisma.quote.findFirst({
        where: {
          id: quoteId,
          tenantId: claims.tenantId,
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
        return reply.code(404).send({ error: "Quote not found." });
      }

      const customerMap = await app.prisma.quickBooksCustomerMap.findFirst({
        where: {
          tenantId: claims.tenantId,
          quickBooksConnectionId: connection.id,
          customerId: quote.customerId,
          deletedAtUtc: null,
        },
        select: {
          quickBooksCustomerId: true,
          quickBooksDisplayName: true,
        },
      });

      const itemMaps = await app.prisma.quickBooksItemMap.findMany({
        where: {
          tenantId: claims.tenantId,
          quickBooksConnectionId: connection.id,
          deletedAtUtc: null,
        },
        select: {
          itemKey: true,
          quickBooksItemId: true,
          quickBooksItemName: true,
        },
      });

      const itemMapByKey = new Map(itemMaps.map((item) => [item.itemKey, item]));
      const invoiceDate = new Date().toISOString().slice(0, 10);
      const dueDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const lineItems = (quote.lineItems.length > 0
        ? quote.lineItems
        : [
            {
              id: `fallback-${quote.id}`,
              description: quote.title,
              quantity: 1,
              unitPrice: quote.customerPriceSubtotal,
            },
          ]).map((lineItem) => {
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
      ];

      return {
        connection: {
          realmId: connection.realmId,
          companyName: connection.companyName,
        },
        customer: {
          quoteFlyCustomerId: quote.customer.id,
          fullName: quote.customer.fullName,
          email: quote.customer.email,
          phone: quote.customer.phone,
          quickBooksCustomerId: customerMap?.quickBooksCustomerId ?? null,
          quickBooksDisplayName: customerMap?.quickBooksDisplayName ?? null,
          createPayload: {
            DisplayName: quote.customer.fullName,
            PrimaryEmailAddr: quote.customer.email ? { Address: quote.customer.email } : undefined,
            PrimaryPhone: quote.customer.phone ? { FreeFormNumber: quote.customer.phone } : undefined,
          },
        },
        invoice: {
          quoteId: quote.id,
          quoteTitle: quote.title,
          docNumber: quickBooksDocNumber(quote.id),
          invoiceDate,
          dueDate,
          totalAmount: Number(quote.totalAmount),
          payload: {
            DocNumber: quickBooksDocNumber(quote.id),
            TxnDate: invoiceDate,
            DueDate: dueDate,
            PrivateNote: `QuoteFly quote ${quote.id}`,
            CustomerRef: customerMap
              ? {
                  value: customerMap.quickBooksCustomerId,
                  name: customerMap.quickBooksDisplayName ?? quote.customer.fullName,
                }
              : null,
            Line: lineItems.map((lineItem) => lineItem.payload),
          },
        },
        lineItems,
        warnings,
      };
    },
  );
};
