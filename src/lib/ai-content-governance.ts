import { normalizeAiSourceText } from "./ai-chunking";

/**
 * Applied to RAG source material before it is chunked, hashed, persisted, or
 * sent to an embedding provider. This is intentionally separate from prompt
 * redaction: indexed workspace text has a much longer lifetime, so material
 * that looks like a credential fails closed instead of being retained as a
 * redacted excerpt.
 */
export const AI_RETRIEVAL_CONTENT_GOVERNANCE_VERSION = "rag-content-governance-v1";

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const PHONE_PATTERN = /(?<!\d)(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/gu;

// A URI with userinfo is a credential even when it is a deliberately fake
// value in a test or support note. Do not attempt to retain an excerpt of it.
const CREDENTIAL_URI_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s/]+/iu;
const BEARER_CREDENTIAL_PATTERN = /\bbearer\s+[a-z0-9._~+/=-]{8,}\b/iu;
const BASIC_CREDENTIAL_PATTERN = /\bauthorization\s*:\s*basic\s+[a-z0-9+/=]{8,}\b/iu;
const LABELED_CREDENTIAL_PATTERN = /\b(?:password|passcode|secret|token|api[\s_-]?key|access[\s_-]?token|refresh[\s_-]?token|webhook[\s_-]?secret)\b\s*[:=]\s*(?:["']?)[^\s,;"']{6,}/iu;
const PROVIDER_CREDENTIAL_PATTERN = /\b(?:sk|rk|pk)[_-](?:live|test|proj)[_-][a-z0-9_-]{8,}\b|\b(?:whsec|ghp|github_pat|xox[a-z]?)[_-][a-z0-9_-]{8,}\b/iu;
const SECRET_QUERY_PARAMETER_PATTERN = /[?&](?:token|key|secret|signature|code|password)=([^&#\s]{6,})/iu;

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

function containsRestrictedCredential(value: string) {
  return CREDENTIAL_URI_PATTERN.test(value)
    || BEARER_CREDENTIAL_PATTERN.test(value)
    || BASIC_CREDENTIAL_PATTERN.test(value)
    || LABELED_CREDENTIAL_PATTERN.test(value)
    || PROVIDER_CREDENTIAL_PATTERN.test(value)
    || SECRET_QUERY_PARAMETER_PATTERN.test(value);
}

/**
 * Normalizes durable RAG text and removes contact details. Credential-like
 * content is rejected rather than stored as a redaction marker, preventing a
 * future change from accidentally treating it as retrievable source text.
 */
export function governAiRetrievalContent(value: string): GovernedAiRetrievalContent {
  const normalized = normalizeAiSourceText(value);
  if (!normalized) return { content: "", redactionCount: 0 };
  if (containsRestrictedCredential(normalized)) {
    throw new AiRetrievalContentQuarantinedError();
  }

  let redactionCount = 0;
  const content = normalized
    .replace(EMAIL_PATTERN, () => {
      redactionCount += 1;
      return "[CONTACT_EMAIL_REDACTED]";
    })
    .replace(PHONE_PATTERN, () => {
      redactionCount += 1;
      return "[CONTACT_PHONE_REDACTED]";
    });
  return { content, redactionCount };
}

/**
 * RAG document/chunk metadata is deliberately content-free. Typed filter
 * columns carry the approved IDs, enums, and dates needed for retrieval, so
 * arbitrary JSON is neither useful nor safe to persist beside embeddings.
 */
export function contentFreeAiRetrievalMetadata() {
  return null;
}
