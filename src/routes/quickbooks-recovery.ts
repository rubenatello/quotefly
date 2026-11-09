import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { getJwtClaims } from "../lib/auth";
import { listQuickBooksDeadLetters, replayQuickBooksDeadLetter, QuickBooksReplayError, QUICKBOOKS_REPLAY_REASONS } from "../services/quickbooks-webhook-replay";

const Query = z.object({ limit: z.coerce.number().int().min(1).max(50).default(25), cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).optional() }).strict();
const Params = z.object({ eventId: z.string().trim().min(1).max(191) }).strict();
const Body = z.object({ reason: z.enum(QUICKBOOKS_REPLAY_REASONS) }).strict();
const Key = z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/);
function handleError(error: unknown, reply: FastifyReply) {
  if (error instanceof QuickBooksReplayError) return reply.code(error.status).send({ error: error.message, code: error.code });
  if (error instanceof z.ZodError && error.issues.some((issue) => issue.path[0] === "cursor")) {
    return reply.code(400).send({ error: "Refresh recovery events to continue.", code: "QUICKBOOKS_RECOVERY_CURSOR_INVALID" });
  }
  if (error instanceof z.ZodError) return reply.code(400).send({ error: "Invalid QuickBooks recovery request." });
  throw error;
}
export const quickBooksRecoveryRoutes: FastifyPluginAsync = async (app) => {
  app.get("/integrations/quickbooks/recovery/events", { preHandler: [app.authenticate] }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    try {
      const { limit, cursor } = Query.parse(request.query);
      return await listQuickBooksDeadLetters(app.prisma, getJwtClaims(request), app.env, limit, cursor);
    } catch (error) { return handleError(error, reply); }
  });
  app.post("/integrations/quickbooks/recovery/events/:eventId/replay", {
    preHandler: [app.authenticate], config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    try {
      const input = { ...Params.parse(request.params), ...Body.parse(request.body), idempotencyKey: Key.parse(request.headers["idempotency-key"]) };
      return await replayQuickBooksDeadLetter(app.prisma, getJwtClaims(request), app.env, input);
    } catch (error) { return handleError(error, reply); }
  });
};
