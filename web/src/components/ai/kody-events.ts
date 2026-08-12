import type { AiAssistantContext, AiAssistantRequestedTool } from "../../lib/api";

export type KodyOpenDetail = {
  prompt: string;
  tool?: AiAssistantRequestedTool;
  context?: AiAssistantContext;
};

export const KODY_OPEN_EVENT = "quotefly:kody-open";

export function openKody(detail: KodyOpenDetail) {
  window.dispatchEvent(new CustomEvent<KodyOpenDetail>(KODY_OPEN_EVENT, { detail }));
}
