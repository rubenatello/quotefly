export const AI_ASSISTANT_RESOLVED_TOOLS = [
  "NAVIGATE_WORKSPACE",
  "FOLLOW_UP_QUEUE",
  "CUSTOMERS_WITHOUT_QUOTES",
  "PIPELINE_SCENARIO",
  "SEARCH_CUSTOMERS",
  "SUMMARIZE_PIPELINE",
  "RANK_PROFITABLE_JOBS",
  "DRAFT_PRODUCT",
  "DRAFT_QUOTE",
] as const;

export const AI_ASSISTANT_TOOLS = ["AUTO", ...AI_ASSISTANT_RESOLVED_TOOLS] as const;

export type AiAssistantRequestedTool = (typeof AI_ASSISTANT_TOOLS)[number];
export type AiAssistantTool = (typeof AI_ASSISTANT_RESOLVED_TOOLS)[number];

export type AiAssistantConversationTurn = Readonly<{
  message: string;
  resolvedTool: AiAssistantTool;
}>;

export type AiAssistantConversationMode = "NEW" | "CONTINUING" | "SHIFTED";

export type AiAssistantConversationState = Readonly<{
  mode: AiAssistantConversationMode;
  acknowledgement: string | null;
  previousTool: AiAssistantTool | null;
  currentTool: AiAssistantTool;
}>;
