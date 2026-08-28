export const AI_ASSISTANT_RESOLVED_TOOLS = [
  "ASSISTANT_HELP",
  "OUT_OF_SCOPE",
  "NAVIGATE_WORKSPACE",
  "LIST_MY_ACTIVITIES",
  "PRIORITIZE_MY_DAY",
  "LIST_SCHEDULE",
  "FOLLOW_UP_QUEUE",
  "CUSTOMERS_WITHOUT_QUOTES",
  "PIPELINE_SCENARIO",
  "SEARCH_CUSTOMERS",
  "SEARCH_PRODUCTS",
  "SEARCH_JOBS",
  "GET_JOB_STATUS",
  "LIST_INVOICES",
  "GET_INVOICE_STATUS",
  "GET_QUICKBOOKS_SETUP_STATUS",
  "SUMMARIZE_PIPELINE",
  "RANK_PROFITABLE_JOBS",
  "DRAFT_CUSTOMER",
  "DRAFT_PRODUCT",
  "PREPARE_ACTIVITY",
  "PREPARE_BOOKING",
  "PREPARE_DISPATCH",
  "DRAFT_QUOTE",
  "PREPARE_QUOTE_SEND",
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
