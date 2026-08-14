import assert from "node:assert/strict";
import test from "node:test";
import { getEncoding } from "js-tiktoken";
import {
  AI_CHUNK_MAX_TOKENS,
  AI_CHUNK_OVERLAP_TOKENS,
  AI_CHUNKER_VERSION,
  countAiTokens,
  normalizeAiSourceText,
  splitAiFieldIntoChunks,
} from "../../src/lib/ai-chunking";

const encoder = getEncoding("cl100k_base");

function matchingBoundaryTokens(left: string, right: string) {
  const leftTokens = encoder.encode(left);
  const rightTokens = encoder.encode(right);
  const limit = Math.min(AI_CHUNK_OVERLAP_TOKENS, leftTokens.length, rightTokens.length);
  for (let size = limit; size > 0; size -= 1) {
    if (leftTokens.slice(-size).every((token, index) => token === rightTokens[index])) {
      return size;
    }
  }
  return 0;
}

function longTokenSequence() {
  return Array.from({ length: 900 }, (_, index) => `item${index}`).join(" ");
}

test("narrative RAG fields use bounded token windows with selective overlap", () => {
  const chunks = splitAiFieldIntoChunks("Customer.notes", longTokenSequence());

  assert.ok(chunks.length > 1);
  assert.ok(chunks.length <= 8);
  assert.ok(chunks.every((chunk) => countAiTokens(chunk) <= AI_CHUNK_MAX_TOKENS));
  assert.ok(matchingBoundaryTokens(chunks[0] ?? "", chunks[1] ?? "") >= AI_CHUNK_OVERLAP_TOKENS - 2);
});

test("short and structured fields do not duplicate content", () => {
  assert.deepEqual(splitAiFieldIntoChunks("Quote.title", "Garden cleanup proposal"), [
    "Garden cleanup proposal",
  ]);

  const chunks = splitAiFieldIntoChunks("Quote.title", longTokenSequence());
  assert.ok(chunks.length > 1);
  assert.equal(matchingBoundaryTokens(chunks[0] ?? "", chunks[1] ?? ""), 0);
});

test("normalization and chunking are deterministic for Unicode and whitespace", () => {
  const composed = normalizeAiSourceText("  Ｑuote\n\tFly   café  ");
  assert.equal(composed, "Quote Fly café");
  assert.deepEqual(
    splitAiFieldIntoChunks("WorkPreset.description", composed),
    splitAiFieldIntoChunks("WorkPreset.description", "Quote Fly café"),
  );
  assert.match(AI_CHUNKER_VERSION, /nfkc.*300.*overlap36/);
});
