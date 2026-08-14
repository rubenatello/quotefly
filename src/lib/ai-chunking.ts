import { getEncoding } from "js-tiktoken";
import type { AiRetrievableField } from "./data-classification";

export const AI_CHUNKER_VERSION = "nfkc-tiktoken-cl100k-300-overlap36-v1";
export const AI_CHUNK_MAX_TOKENS = 300;
export const AI_CHUNK_OVERLAP_TOKENS = 36;

const MAX_SOURCE_CHARS = 2_000;
const MAX_CHUNKS_PER_FIELD = 8;
const encoder = getEncoding("cl100k_base");

const NARRATIVE_FIELDS = new Set<AiRetrievableField>([
  "Customer.notes",
  "Quote.scopeText",
  "QuoteLineItem.description",
  "CustomerActivityEvent.detail",
  "WorkPreset.description",
]);

export function normalizeAiSourceText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SOURCE_CHARS);
}

export function countAiTokens(value: string) {
  const normalized = normalizeAiSourceText(value);
  return normalized ? encoder.encode(normalized).length : 0;
}

export function splitAiFieldIntoChunks(
  field: AiRetrievableField,
  value: string,
): string[] {
  const normalized = normalizeAiSourceText(value);
  if (!normalized) return [];

  const tokens = encoder.encode(normalized);
  if (tokens.length <= AI_CHUNK_MAX_TOKENS) return [normalized];

  const overlap = NARRATIVE_FIELDS.has(field) ? AI_CHUNK_OVERLAP_TOKENS : 0;
  const chunks: string[] = [];
  let start = 0;
  while (start < tokens.length && chunks.length < MAX_CHUNKS_PER_FIELD) {
    const end = Math.min(start + AI_CHUNK_MAX_TOKENS, tokens.length);
    const decoded = encoder.decode(tokens.slice(start, end)).replace(/\s+/g, " ");
    // Preserve a continuation window's leading boundary token. Trimming it
    // changes the BPE token identity and silently weakens the promised overlap.
    const content = start === 0 ? decoded.trim() : decoded.trimEnd();
    if (content.trim()) chunks.push(content);
    if (end >= tokens.length) break;
    start = Math.max(start + 1, end - overlap);
  }

  return chunks;
}
