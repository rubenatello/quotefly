export const AI_ASSISTANT_RESOLVED_TOOLS = [
  "NAVIGATE_WORKSPACE",
  "FOLLOW_UP_QUEUE",
  "CUSTOMERS_WITHOUT_QUOTES",
  "PIPELINE_SCENARIO",
  "SEARCH_CUSTOMERS",
  "SUMMARIZE_PIPELINE",
  "RANK_PROFITABLE_JOBS",
  "DRAFT_QUOTE",
] as const;

export const AI_ASSISTANT_TOOLS = ["AUTO", ...AI_ASSISTANT_RESOLVED_TOOLS] as const;

export type AiAssistantRequestedTool = (typeof AI_ASSISTANT_TOOLS)[number];
export type AiAssistantTool = (typeof AI_ASSISTANT_RESOLVED_TOOLS)[number];

export type AiAssistantConversationTurn = Readonly<{
  message: string;
  resolvedTool: AiAssistantTool;
}>;
