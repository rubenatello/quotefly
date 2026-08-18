import type { AiAssistantContext, AiAssistantRequestedTool } from "../../lib/api";

export type KodyOpenDetail = {
  prompt: string;
  tool?: AiAssistantRequestedTool;
  context?: AiAssistantContext;
};

export const KODY_OPEN_EVENT = "quotefly:kody-open";
export const KODY_OUTCOME_EVENT = "quotefly:kody-outcome";

export type KodyOutcomeDetail =
  | { type: "CUSTOMER_CREATED"; customerName: string }
  | { type: "QUOTE_CREATED"; quoteTitle: string; customerName?: string }
  | { type: "QUOTE_MARKED_SENT"; quoteTitle: string; customerName: string };

export function openKody(detail: KodyOpenDetail) {
  window.dispatchEvent(new CustomEvent<KodyOpenDetail>(KODY_OPEN_EVENT, { detail }));
}

export function publishKodyOutcome(detail: KodyOutcomeDetail) {
  window.dispatchEvent(new CustomEvent<KodyOutcomeDetail>(KODY_OUTCOME_EVENT, { detail }));
}
