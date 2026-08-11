import { type FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  isTransactionalEmailConfigured,
  sendFeatureRequestEmail,
} from "../services/transactional-email";

const FeatureRequestSchema = z.object({
  requestId: z.string().uuid(),
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(254),
  company: z.string().trim().max(120).optional(),
  category: z.enum(["QUOTING", "CUSTOMERS", "MOBILE", "REPORTING", "INTEGRATIONS", "OTHER"]),
  priority: z.enum(["NICE_TO_HAVE", "IMPORTANT", "BLOCKING"]),
  title: z.string().trim().min(5).max(120),
  details: z.string().trim().min(10).max(2500),
  source: z.enum(["PUBLIC", "WORKSPACE"]),
  website: z.string().max(200).optional().default(""),
}).strict();

const FEATURE_REQUEST_ACCEPTED_MESSAGE =
  "Thanks for helping shape QuoteFly. Your feature request was sent to the product team.";

export const feedbackRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/feedback/feature-requests",
    {
      bodyLimit: 12_000,
      config: {
        rateLimit: {
          max: 4,
          timeWindow: "15 minutes",
        },
      },
    },
    async (request, reply) => {
      const input = FeatureRequestSchema.parse(request.body);

      // A filled hidden field is treated as automated submission. Return the
      // same response as a real request without consuming email-provider quota.
      if (input.website.trim()) {
        return reply.code(202).send({ message: FEATURE_REQUEST_ACCEPTED_MESSAGE });
      }

      if (!isTransactionalEmailConfigured(app.env)) {
        return reply.code(503).send({
          error: "Feature requests are temporarily unavailable. Please email support@quotefly.us.",
        });
      }

      try {
        await sendFeatureRequestEmail(app.env, input);
      } catch (error) {
        request.log.error(
          { err: error, requestId: input.requestId },
          "Feature request delivery failed.",
        );
        return reply.code(503).send({
          error: "Feature request could not be sent right now. Please email support@quotefly.us.",
        });
      }

      return reply.code(202).send({ message: FEATURE_REQUEST_ACCEPTED_MESSAGE });
    },
  );
};
