import { normalizeAiSourceText } from "./ai-chunking";
import { containsRestrictedAiCredential, redactAiContactDetails } from "./ai-data-governance";

/**
 * Applied to RAG source material before it is chunked, hashed, persisted, or
 * sent to an embedding provider. This is intentionally separate from prompt
 * redaction: indexed workspace text has a much longer lifetime, so material
 * that looks like a credential fails closed instead of being retained as a
 * redacted excerpt.
 */
export const AI_RETRIEVAL_CONTENT_GOVERNANCE_VERSION = "rag-content-governance-v2";

export class AiRetrievalContentQuarantinedError extends Error {
  readonly code = "AI_RETRIEVAL_CONTENT_QUARANTINED";

  constructor() {
    super("AI retrieval source contains restricted credential-like content and was quarantined.");
    this.name = "AiRetrievalContentQuarantinedError";
  }
}

export type GovernedAiRetrievalContent = Readonly<{
  content: string;
  redactionCount: number;
}>;

/**
 * Normalizes durable RAG text and removes contact details. Credential-like
 * content is rejected rather than stored as a redaction marker, preventing a
 * future change from accidentally treating it as retrievable source text.
 */
export function governAiRetrievalContent(value: string): GovernedAiRetrievalContent {
  const normalized = normalizeAiSourceText(value);
  if (!normalized) return { content: "", redactionCount: 0 };
  if (containsRestrictedAiCredential(normalized)) {
    throw new AiRetrievalContentQuarantinedError();
  }

  const governed = redactAiContactDetails(normalized, {
    email: "[CONTACT_EMAIL_REDACTED]",
    phone: "[CONTACT_PHONE_REDACTED]",
  });
  return { content: governed.redacted, redactionCount: governed.redactionCount };
}

/**
 * RAG document/chunk metadata is deliberately content-free. Typed filter
 * columns carry the approved IDs, enums, and dates needed for retrieval, so
 * arbitrary JSON is neither useful nor safe to persist beside embeddings.
 */
export function contentFreeAiRetrievalMetadata() {
  return null;
}
