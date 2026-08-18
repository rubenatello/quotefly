const MAX_LEXICAL_QUERY_CHARS = 2_000;
const MAX_EMBEDDING_QUERY_CHARS = 800;

import { redactAiPrompt } from "./ai-data-governance";

const REDACTION_MARKER_PATTERN = /\[(?:REDACTED(?:_[A-Z]+)?|TRUNCATED)\]/gu;
const REDACTION_LABEL_PATTERN = /\b(?:bearer|password|passcode|secret|authorization|token|api[\s_-]?key|access[\s_-]?token|refresh[\s_-]?token)\b\s*[:=]?/giu;
const SCHEME_URI_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/giu;

export type AiEmbeddingQueryPreparation = Readonly<{
  /** Bounded original query, retained only for in-database lexical ranking. */
  lexicalQuery: string;
  /** Sanitized semantic query. Null means skip the external embedding provider. */
  embeddingQuery: string | null;
  redactionCount: number;
}>;

function normalizeQuery(value: string, maxLength: number) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/**
 * Keeps the original bounded query inside PostgreSQL for exact workspace
 * lookups, while ensuring an embedding provider receives only a minimized
 * query with governed credentials and direct contact details removed. Customer
 * names and non-credential address terms remain eligible C2 provider input for
 * explicit quote/retrieval purposes; structured customer tools do not use this
 * path.
 */
export function prepareAiEmbeddingQuery(value: string): AiEmbeddingQueryPreparation {
  const lexicalQuery = normalizeQuery(value, MAX_LEXICAL_QUERY_CHARS);
  if (!lexicalQuery) return { lexicalQuery, embeddingQuery: null, redactionCount: 0 };

  try {
    // Remove complete scheme URIs before general PII redaction can replace
    // embedded userinfo and split the URI into separately visible fragments.
    const schemeUriCount = Array.from(lexicalQuery.matchAll(SCHEME_URI_PATTERN)).length;
    const withoutSchemeUris = lexicalQuery.replace(SCHEME_URI_PATTERN, " ");
    const governed = redactAiPrompt(withoutSchemeUris);
    const governedRedactionCount = Array.from(governed.matchAll(REDACTION_MARKER_PATTERN)).length;
    const providerSafe = governed
      .replace(REDACTION_MARKER_PATTERN, " ")
      .replace(REDACTION_LABEL_PATTERN, " ")
      .replace(/[?&](?:token|key|secret|signature|code)=/giu, " ");
    const embeddingQuery = normalizeQuery(providerSafe, MAX_EMBEDDING_QUERY_CHARS);
    return {
      lexicalQuery,
      embeddingQuery: embeddingQuery || null,
      redactionCount: governedRedactionCount + schemeUriCount,
    };
  } catch {
    // A sanitization failure must never result in raw input reaching a provider.
    return { lexicalQuery, embeddingQuery: null, redactionCount: 0 };
  }
}
