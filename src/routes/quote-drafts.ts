import type { FastifyPluginAsync } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { buildAccessContext } from "../lib/access-policy";
import { tenantActiveQuoteScope } from "../lib/query-scope";
import { withTenantRlsContext } from "../lib/tenant-rls";
import { assignedRecordScope } from "../lib/workspace-assignment";

const QUOTE_DRAFT_TTL_MS = 12 * 60 * 60 * 1_000;
const QUOTE_DRAFT_MAX_BYTES = 128 * 1_024;
const QUOTE_DRAFT_MAX_SCOPES_PER_MEMBER = 25;

const QuoteDraftParamsSchema = z.object({
  scope: z.string().trim().regex(/^(?:new|quote:[A-Za-z0-9_-]{1,120})$/),
}).strict();

const QuoteDraftPayloadSchema = z.object({
  version: z.literal(1),
  savedAtUtc: z.string().datetime({ offset: true }),
  recoveryIdentity: z.object({
    tenantId: z.string().min(1),
    userId: z.string().min(1),
  }).strict().optional(),
}).passthrough().refine(
  (payload) => Buffer.byteLength(JSON.stringify(payload), "utf8") <= QUOTE_DRAFT_MAX_BYTES,
  { message: "Quote draft is too large for recovery." },
);

const QuoteDraftBodySchema = z.object({
  payload: QuoteDraftPayloadSchema,
}).strict();

function quoteIdFromScope(scope: string) {
  return scope.startsWith("quote:") ? scope.slice("quote:".length) : null;
}

export const quoteDraftRoutes: FastifyPluginAsync = async (app) => {
  const rateLimit = {
    config: {
      rateLimit: {
        max: app.env.NODE_ENV === "test" ? 10_000 : 300,
        timeWindow: "15 minutes",
      },
    },
    bodyLimit: QUOTE_DRAFT_MAX_BYTES + 4_096,
    preHandler: [app.authenticate],
  };

  async function canAccessScope(scope: string, request: Parameters<typeof buildAccessContext>[0]) {
    const quoteId = quoteIdFromScope(scope);
    if (!quoteId) return true;
    const access = buildAccessContext(request);
    const quote = await app.prisma.quote.findFirst({
      where: {
        id: quoteId,
        ...tenantActiveQuoteScope(access.tenantId),
        ...assignedRecordScope(access),
      },
      select: { id: true },
    });
    return Boolean(quote);
  }

  app.get("/quote-drafts/:scope", rateLimit, async (request, reply) => {
    const access = buildAccessContext(request);
    const { scope } = QuoteDraftParamsSchema.parse(request.params);
    if (!(await canAccessScope(scope, request))) {
      return reply.code(404).send({ error: "Quote draft not found." });
    }

    const now = new Date();
    const draft = await withTenantRlsContext(app.prisma, access.tenantId, async (tx) => {
      await tx.quoteDraftRecovery.deleteMany({
        where: {
          tenantId: access.tenantId,
          tenantUserId: access.tenantUserId,
          expiresAtUtc: { lte: now },
        },
      });
      return tx.quoteDraftRecovery.findUnique({
        where: {
          tenantId_tenantUserId_scope: {
            tenantId: access.tenantId,
            tenantUserId: access.tenantUserId,
            scope,
          },
        },
        select: {
          payload: true,
          savedAtUtc: true,
          expiresAtUtc: true,
        },
      });
    });

    return { draft };
  });

  app.put("/quote-drafts/:scope", rateLimit, async (request, reply) => {
    const access = buildAccessContext(request);
    const { scope } = QuoteDraftParamsSchema.parse(request.params);
    const { payload } = QuoteDraftBodySchema.parse(request.body);
    const quoteId = quoteIdFromScope(scope);
    if (!(await canAccessScope(scope, request))) {
      return reply.code(404).send({ error: "Quote draft not found." });
    }
    if (quoteId && payload.quoteId !== quoteId) {
      return reply.code(400).send({ error: "Quote draft scope does not match its quote." });
    }
    if (
      payload.recoveryIdentity
      && (
        payload.recoveryIdentity.tenantId !== access.tenantId
        || payload.recoveryIdentity.userId !== access.userId
      )
    ) {
      return reply.code(403).send({ error: "Quote draft identity no longer matches this session." });
    }

    const savedAtUtc = new Date();
    const expiresAtUtc = new Date(savedAtUtc.getTime() + QUOTE_DRAFT_TTL_MS);
    const storedPayload = {
      ...payload,
      savedAtUtc: savedAtUtc.toISOString(),
    } as Prisma.InputJsonObject;

    const draft = await withTenantRlsContext(app.prisma, access.tenantId, async (tx) => {
      await tx.quoteDraftRecovery.deleteMany({
        where: {
          tenantId: access.tenantId,
          tenantUserId: access.tenantUserId,
          expiresAtUtc: { lte: savedAtUtc },
        },
      });

      const existing = await tx.quoteDraftRecovery.findUnique({
        where: {
          tenantId_tenantUserId_scope: {
            tenantId: access.tenantId,
            tenantUserId: access.tenantUserId,
            scope,
          },
        },
        select: { id: true },
      });
      if (!existing) {
        const oldest = await tx.quoteDraftRecovery.findMany({
          where: {
            tenantId: access.tenantId,
            tenantUserId: access.tenantUserId,
          },
          orderBy: { updatedAt: "asc" },
          select: { id: true },
          skip: QUOTE_DRAFT_MAX_SCOPES_PER_MEMBER - 1,
        });
        if (oldest.length) {
          await tx.quoteDraftRecovery.deleteMany({
            where: {
              tenantId: access.tenantId,
              id: { in: oldest.map((entry) => entry.id) },
            },
          });
        }
      }

      return tx.quoteDraftRecovery.upsert({
        where: {
          tenantId_tenantUserId_scope: {
            tenantId: access.tenantId,
            tenantUserId: access.tenantUserId,
            scope,
          },
        },
        create: {
          tenantId: access.tenantId,
          tenantUserId: access.tenantUserId,
          scope,
          payload: storedPayload,
          savedAtUtc,
          expiresAtUtc,
        },
        update: {
          payload: storedPayload,
          savedAtUtc,
          expiresAtUtc,
        },
        select: {
          savedAtUtc: true,
          expiresAtUtc: true,
        },
      });
    });

    return { draft };
  });

  app.delete("/quote-drafts/:scope", rateLimit, async (request, reply) => {
    const access = buildAccessContext(request);
    const { scope } = QuoteDraftParamsSchema.parse(request.params);
    if (!(await canAccessScope(scope, request))) {
      return reply.code(404).send({ error: "Quote draft not found." });
    }

    await withTenantRlsContext(app.prisma, access.tenantId, async (tx) => {
      await tx.quoteDraftRecovery.deleteMany({
        where: {
          tenantId: access.tenantId,
          tenantUserId: access.tenantUserId,
          scope,
        },
      });
    });
    return reply.code(204).send();
  });
};
