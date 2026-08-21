export const AI_RETRIEVAL_RANKING_MODE = "postgres_rrf_hybrid_rerank_v2";
export const AI_RETRIEVAL_RRF_K = 60;
export const AI_RETRIEVAL_SEMANTIC_WEIGHT = 0.65;
export const AI_RETRIEVAL_KEYWORD_WEIGHT = 0.35;

const MAX_REWRITE_QUERY_CHARS = 2_000;
const MAX_PRIOR_QUERY_CHARS = 500;
const MAX_PRIOR_QUERY_COUNT = 4;
const MAX_RERANK_CANDIDATES = 20;
const MAX_PRIMARY_CHUNKS_PER_SOURCE = 2;

const VAGUE_FOLLOW_UP_PATTERN =
  /^[¿¡]?(?:and\b|also\b|what\s+about\b|how\s+about\b|now\b|same\b|show\s+me\s+more\b|which\s+(?:one|ones)\b|break\s+(?:that|it)\s+down\b|compare\s+(?:that|it|them|those)\b|how\s+do\s+i\s+(?:fix|change|update)\s+(?:it|that|this)\b|y\b|ademas\b|ahora\b|que\s+tal\b|lo\s+mismo\b|muestrame\s+mas\b|cual(?:es)?\b|explica(?:me)?\s+eso\b|compara\s+(?:eso|esto|esos|esas)\b|como\s+(?:lo|la)\s+(?:arreglo|cambio|actualizo)\b)/i;
const UNSAFE_CONTEXT_PATTERN =
  /\b(?:ignore|disregard|override|forget|bypass|jailbreak|system\s+prompt|developer\s+message|hidden\s+prompt|api\s+key|secret\s+token|cross[-\s]*tenant|another\s+tenant|other\s+tenant|ignora|omite|anula|olvida|prompt\s+del\s+sistema|mensaje\s+del\s+desarrollador|prompt\s+oculto|clave\s+(?:de\s+)?api|token\s+secreto|otro\s+(?:tenant|inquilino|espacio\s+de\s+trabajo)|otra\s+(?:cuenta|empresa))\b/i;

const RETRIEVAL_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "their",
  "them",
  "this",
  "those",
  "to",
  "what",
  "which",
  "with",
  "you",
  "al",
  "como",
  "cómo",
  "con",
  "cual",
  "cuales",
  "cuál",
  "cuáles",
  "de",
  "del",
  "el",
  "ella",
  "en",
  "eso",
  "esta",
  "este",
  "la",
  "las",
  "lo",
  "los",
  "me",
  "mi",
  "mis",
  "nos",
  "nuestro",
  "para",
  "por",
  "que",
  "qué",
  "se",
  "sin",
  "su",
  "sus",
  "un",
  "una",
  "y",
  "yo",
]);

function normalizeQuery(value: string, maxLength = MAX_REWRITE_QUERY_CHARS) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function aiRetrievalLexicalTokens(value: string, maxTokens = 32) {
  return Array.from(new Set(
    normalizeQuery(value)
      .toLocaleLowerCase("und")
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((token) => token.length >= 2 && !RETRIEVAL_STOP_WORDS.has(token))
      .slice(0, Math.max(1, Math.min(Math.trunc(maxTokens), 512))) ?? [],
  ));
}

export type AiRetrievalQueryRewrite = Readonly<{
  originalQuery: string;
  effectiveQuery: string;
  mode: "none" | "same_task_context_v1";
  contextTurnCount: number;
}>;

/**
 * Expands only clearly vague follow-ups and only from caller-approved prior
 * user turns. It never consumes assistant output or makes another model call.
 */
export function resolveAiRetrievalQuery(params: {
  query: string;
  priorUserQueries?: readonly string[];
}): AiRetrievalQueryRewrite {
  const originalQuery = normalizeQuery(params.query);
  if (!originalQuery || !VAGUE_FOLLOW_UP_PATTERN.test(originalQuery)) {
    return { originalQuery, effectiveQuery: originalQuery, mode: "none", contextTurnCount: 0 };
  }

  const priorQueries = (params.priorUserQueries ?? [])
    .slice(-MAX_PRIOR_QUERY_COUNT)
    .map((query) => normalizeQuery(query, MAX_PRIOR_QUERY_CHARS))
    .filter((query) => query.length >= 3 && !UNSAFE_CONTEXT_PATTERN.test(query));
  const priorQuery = priorQueries.at(-1);
  if (!priorQuery) {
    return { originalQuery, effectiveQuery: originalQuery, mode: "none", contextTurnCount: 0 };
  }

  return {
    originalQuery,
    effectiveQuery: normalizeQuery(`${priorQuery}. Follow-up: ${originalQuery}`),
    mode: "same_task_context_v1",
    contextTurnCount: 1,
  };
}

export type AiHybridRankCandidate<T> = Readonly<{
  candidate: T;
  id: string;
  sourceType: string;
  sourceId: string;
  sourceField: string;
  citationLabel: string;
  content: string;
  contentHash: string;
  semanticRank: number | null;
  semanticScore: number | null;
  keywordRank: number | null;
  keywordScore: number | null;
  preferred: boolean;
}>;

export type AiHybridRankedCandidate<T> = AiHybridRankCandidate<T> & Readonly<{
  fusedScore: number;
  lexicalCoverage: number;
  exactPhrase: boolean;
  rerankScore: number;
}>;

function candidateSearchText(candidate: AiHybridRankCandidate<unknown>) {
  return normalizeQuery(`${candidate.citationLabel} ${candidate.content}`).toLocaleLowerCase("und");
}

/**
 * Reranks at most 20 fused candidates using deterministic lexical evidence,
 * then makes a diversity-first pass so overlapping chunks from one record do
 * not crowd out other relevant sources. A fill pass preserves recall when the
 * index contains fewer distinct sources.
 */
export function rerankAiRetrievalCandidates<T>(params: {
  query: string;
  candidates: readonly AiHybridRankCandidate<T>[];
  limit: number;
}): AiHybridRankedCandidate<T>[] {
  const query = normalizeQuery(params.query).toLocaleLowerCase("und");
  const queryTokens = aiRetrievalLexicalTokens(query);
  const limit = Math.max(1, Math.min(Math.trunc(params.limit), 20));
  const scored = params.candidates
    .map((entry) => {
      const text = candidateSearchText(entry);
      const candidateTokens = new Set(aiRetrievalLexicalTokens(text, 512));
      const matchedTokenCount = queryTokens.filter((token) => candidateTokens.has(token)).length;
      const lexicalCoverage = queryTokens.length ? matchedTokenCount / queryTokens.length : 0;
      const exactPhrase = query.length >= 4 && text.includes(query);
      const fusedScore =
        (entry.semanticRank ? AI_RETRIEVAL_SEMANTIC_WEIGHT / (AI_RETRIEVAL_RRF_K + entry.semanticRank) : 0) +
        (entry.keywordRank ? AI_RETRIEVAL_KEYWORD_WEIGHT / (AI_RETRIEVAL_RRF_K + entry.keywordRank) : 0) +
        (entry.preferred ? 0.01 : 0);
      const rerankScore = fusedScore + lexicalCoverage * 0.012 + (exactPhrase ? 0.006 : 0);
      return { ...entry, fusedScore, lexicalCoverage, exactPhrase, rerankScore };
    })
    .sort((left, right) => right.rerankScore - left.rerankScore || left.id.localeCompare(right.id))
    .slice(0, MAX_RERANK_CANDIDATES);

  const selected: AiHybridRankedCandidate<T>[] = [];
  const selectedIds = new Set<string>();
  const selectedContentHashes = new Set<string>();
  const sourceCounts = new Map<string, number>();
  for (const entry of scored) {
    const sourceKey = `${entry.sourceType}:${entry.sourceId}`;
    if ((sourceCounts.get(sourceKey) ?? 0) >= MAX_PRIMARY_CHUNKS_PER_SOURCE) continue;
    if (selectedContentHashes.has(entry.contentHash)) continue;
    selected.push(entry);
    selectedIds.add(entry.id);
    selectedContentHashes.add(entry.contentHash);
    sourceCounts.set(sourceKey, (sourceCounts.get(sourceKey) ?? 0) + 1);
    if (selected.length >= limit) return selected;
  }

  for (const entry of scored) {
    if (selectedIds.has(entry.id)) continue;
    selected.push(entry);
    selectedIds.add(entry.id);
    if (selected.length >= limit) break;
  }
  return selected;
}
