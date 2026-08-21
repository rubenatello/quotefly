import { z } from "zod";
import {
  AI_ASSISTANT_RESOLVED_TOOLS,
  AI_ASSISTANT_TOOLS,
  type AiAssistantConversationTurn,
} from "./ai-assistant-contract";
import type { AiAssistantContext } from "./ai-assistant";

const ServiceTypeSchema = z.enum(["HVAC", "PLUMBING", "FLOORING", "ROOFING", "GARDENING", "CONSTRUCTION"]);

export const AssistantContextSchema = z.object({
  currentPage: z.enum(["quotes", "customers", "analytics", "products", "dashboard", "follow-up"]).optional(),
  customerId: z.string().trim().min(1).optional(),
  quoteId: z.string().trim().min(1).optional(),
  search: z.string().trim().min(1).max(120).optional(),
  serviceType: ServiceTypeSchema.optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  limit: z.number().int().min(1).max(20).optional(),
  includeArchived: z.boolean().optional(),
});

export const AssistantRequestSchema = z.object({
  message: z.string().trim().min(3).max(2_000),
  tool: z.enum(AI_ASSISTANT_TOOLS).default("AUTO"),
  context: AssistantContextSchema.optional(),
  conversation: z.array(z.object({
    message: z.string().trim().min(1).max(500),
    resolvedTool: z.enum(AI_ASSISTANT_RESOLVED_TOOLS),
  }).strict()).max(4).optional(),
});

export type AssistantRequestPayload = z.infer<typeof AssistantRequestSchema>;

export function normalizeAssistantContext(
  context: AssistantRequestPayload["context"],
): AiAssistantContext | undefined {
  if (!context) return undefined;
  return {
    currentPage: context.currentPage,
    customerId: context.customerId,
    quoteId: context.quoteId,
    search: context.search,
    serviceType: context.serviceType,
    dateFrom: context.dateFrom ?? null,
    dateTo: context.dateTo ?? null,
    limit: context.limit,
    includeArchived: context.includeArchived,
  };
}

export function normalizeAssistantConversation(
  conversation: AssistantRequestPayload["conversation"],
): readonly AiAssistantConversationTurn[] {
  if (!conversation?.length) return [];
  return conversation.slice(-4).map((turn) => Object.freeze({
    message: turn.message.trim(),
    resolvedTool: turn.resolvedTool,
  }));
}
