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
import {
  AiRetrievalContentQuarantinedError,
  governAiRetrievalContent,
} from "../../src/lib/ai-content-governance";

process.env.NODE_ENV ||= "test";
process.env.DATABASE_URL ||= [
  "postgresql",
  "://",
  "quotefly",
  ":",
  "quotefly",
  "@localhost:5432/quotefly_unit_test",
].join("");
process.env.JWT_SECRET ||= "test-jwt-secret-for-quotefly-unit-suite-min-32";
process.env.APP_URL ||= "http://localhost:5173";
process.env.API_URL ||= "http://localhost:4000";

async function loadAiRetrieval() {
  return import("../../src/lib/ai-retrieval");
}

async function loadAiIndexJobs() {
  return import("../../src/lib/ai-index-jobs");
}

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

test("durable RAG content redacts contact details without treating ordinary quote scope as a secret", () => {
  const governed = governAiRetrievalContent(
    "Replace the 24-inch gate latch. Call alex.contractor@example.com or (619) 555-1212 before arrival.",
  );

  assert.match(governed.content, /Replace the 24-inch gate latch/);
  assert.match(governed.content, /CONTACT_EMAIL_REDACTED/);
  assert.match(governed.content, /CONTACT_PHONE_REDACTED/);
  assert.doesNotMatch(governed.content, /alex\.contractor@example\.com|619\) 555-1212/);
  assert.equal(governed.redactionCount, 2);
  assert.doesNotThrow(() => governAiRetrievalContent(
    "Authorization: approved by the homeowner to replace the damaged gate latch.",
  ));
});

function fakeRetrievalPersistence() {
  const writes: unknown[] = [];
  const client = {
    $queryRaw: async () => [],
    aiRetrievalDocument: {
      upsert: async (args: unknown) => {
        writes.push(args);
        return { id: "retrieval-document-1" };
      },
    },
    aiRetrievalChunk: {
      upsert: async (args: unknown) => {
        writes.push(args);
        return { id: "retrieval-chunk-1" };
      },
      updateMany: async (args: unknown) => {
        writes.push(args);
        return { count: 0 };
      },
    },
    aiIndexJob: {},
    quoteLineItem: {},
    customerActivityEvent: {},
    quote: {},
  };
  return { client, writes };
}

test("RAG ingestion never sends or persists raw contact details or arbitrary metadata", async () => {
  const { deterministicEmbedding, upsertAiRetrievalSource } = await loadAiRetrieval();
  const { client, writes } = fakeRetrievalPersistence();
  const providerInputs: string[] = [];
  const email = "maria.garcia@example.com";
  const phone = "+1 619-555-1212";

  await upsertAiRetrievalSource(client as never, {
    tenantId: "tenant-governance-test",
    sourceType: "Customer",
    sourceId: "customer-governance-test",
    citationLabel: "Customer notes",
    metadata: { untrustedEmail: email, rawToken: "never-persist-this" },
    fields: [{
      field: "Customer.notes",
      content: `Install drought tolerant plants. Contact ${email} at ${phone}.`,
      metadata: { copiedContact: email },
    }],
  }, {
    embedText: async (text) => {
      providerInputs.push(text);
      return deterministicEmbedding(text);
    },
  });

  const providerPayload = providerInputs.join("\n");
  const persistedPayload = JSON.stringify(writes);
  assert.match(providerPayload, /CONTACT_EMAIL_REDACTED|CONTACT_PHONE_REDACTED/);
  assert.doesNotMatch(providerPayload, /maria\.garcia@example\.com|619-555-1212/);
  assert.doesNotMatch(persistedPayload, /maria\.garcia@example\.com|619-555-1212|never-persist-this/);
});

test("credential-like source text is quarantined before an embedding or persistence call", async () => {
  const { deterministicEmbedding, upsertAiRetrievalSource } = await loadAiRetrieval();
  const { client, writes } = fakeRetrievalPersistence();
  let providerCalls = 0;
  const credentialLikeText = [
    "Database: ",
    "postgresql",
    "://",
    "demo",
    ":",
    "fake-password",
    "@db.example.com/quotefly",
  ].join("");

  await assert.rejects(
    () => upsertAiRetrievalSource(client as never, {
      tenantId: "tenant-governance-test",
      sourceType: "Customer",
      sourceId: "customer-secret-test",
      citationLabel: "Customer notes",
      fields: [{
        field: "Customer.notes",
        content: credentialLikeText,
      }],
    }, {
      embedText: async (text) => {
        providerCalls += 1;
        return deterministicEmbedding(text);
      },
    }),
    (error) => error instanceof AiRetrievalContentQuarantinedError && error.code === "AI_RETRIEVAL_CONTENT_QUARANTINED",
  );

  assert.equal(providerCalls, 0);
  assert.equal(writes.length, 0);
});

test("RAG ingestion rejects fields that do not belong to the source adapter", async () => {
  const { upsertAiRetrievalSource } = await loadAiRetrieval();
  const { client } = fakeRetrievalPersistence();
  await assert.rejects(
    () => upsertAiRetrievalSource(client as never, {
      tenantId: "tenant-governance-test",
      sourceType: "Customer",
      sourceId: "customer-mismatch-test",
      citationLabel: "Customer source",
      fields: [{ field: "Quote.scopeText", content: "Replace damaged fascia board." }],
    }),
    /not an approved RAG field for Customer/,
  );
});

test("governance version invalidates legacy index compatibility", async () => {
  const { AI_RETRIEVAL_GOVERNED_CHUNKER_VERSION } = await loadAiRetrieval();
  assert.match(AI_RETRIEVAL_GOVERNED_CHUNKER_VERSION, /rag-content-governance-v1$/);
  assert.notEqual(AI_RETRIEVAL_GOVERNED_CHUNKER_VERSION, AI_CHUNKER_VERSION);
  assert.ok(AI_RETRIEVAL_GOVERNED_CHUNKER_VERSION.length <= 64);
});

test("a quarantined source is purged without blocking safe sibling indexing", async () => {
  const { deterministicEmbedding, refreshQuoteAiRetrievalIndex } = await loadAiRetrieval();
  const writes: unknown[] = [];
  const providerInputs: string[] = [];
  const credentialLikeText = [
    "Database ",
    "postgresql",
    "://",
    "demo",
    ":",
    "fake-password",
    "@db.example.com/quotefly",
  ].join("");
  const client = {
    $queryRaw: async () => [],
    customer: {
      findFirst: async () => ({
        id: "customer-secret",
        fullName: "Secret customer",
        notes: credentialLikeText,
        followUpStatus: "NEEDS_FOLLOW_UP",
        assignedTenantUserId: "tenant-user-1",
        createdAt: new Date("2026-08-20T00:00:00.000Z"),
        updatedAt: new Date("2026-08-20T00:00:00.000Z"),
      }),
    },
    customerActivityEvent: { findMany: async () => [] },
    quote: { findMany: async () => [] },
    quoteLineItem: {},
    workPreset: {
      findMany: async () => [{
        id: "preset-safe",
        name: "Garden cleanup",
        description: "Prune shrubs and haul away green waste.",
        serviceType: "GARDENING",
        category: "LANDSCAPING",
        createdAt: new Date("2026-08-20T00:00:00.000Z"),
        updatedAt: new Date("2026-08-20T00:00:00.000Z"),
      }],
    },
    aiRetrievalDocument: {
      upsert: async (args: unknown) => {
        writes.push(args);
        return { id: "safe-document" };
      },
      updateMany: async (args: unknown) => {
        writes.push(args);
        return { count: 1 };
      },
    },
    aiRetrievalChunk: {
      upsert: async (args: unknown) => {
        writes.push(args);
        return { id: "safe-chunk" };
      },
      deleteMany: async (args: unknown) => {
        writes.push(args);
        return { count: 1 };
      },
      updateMany: async (args: unknown) => {
        writes.push(args);
        return { count: 1 };
      },
    },
    aiIndexJob: {},
  };

  const result = await refreshQuoteAiRetrievalIndex(client as never, {
    access: {
      tenantId: "tenant-governance-test",
      tenantUserId: "tenant-user-1",
      userId: "user-1",
      role: "owner",
      capabilities: new Set(),
      requestId: "request-governance-test",
    },
    serviceType: "GARDENING",
    customerId: "customer-secret",
    embedText: async (text) => {
      providerInputs.push(text);
      return deterministicEmbedding(text);
    },
  });

  assert.equal(result.quarantinedSourceCount, 1);
  assert.equal(result.indexedSourceCount, 1);
  assert.match(providerInputs.join("\n"), /Garden cleanup|Prune shrubs/);
  assert.doesNotMatch(providerInputs.join("\n"), /fake-password|postgresql:/);
  assert.doesNotMatch(JSON.stringify(writes), /fake-password|postgresql:/);
});

test("new workers reconcile stale governed documents without requeueing in-flight work", async () => {
  const { reconcileAiRetrievalGovernanceJobs } = await loadAiIndexJobs();
  let queryCount = 0;
  const client = {
    $queryRaw: async () => {
      queryCount += 1;
      // RLS context setup performs two raw calls for each tenant transaction.
      if (queryCount === 1 || queryCount === 4) return [{ tenantId: null }];
      if (queryCount === 3) return [{
        sourceType: "WorkPreset",
        sourceId: "preset-stale",
        sourceUpdatedAtUtc: new Date("2026-08-20T00:00:00.000Z"),
      }];
      if (queryCount === 6) return [{ id: "requeued-job" }];
      return [];
    },
  };

  const result = await reconcileAiRetrievalGovernanceJobs(client as never, {
    tenantId: "tenant-governance-test",
    limit: 1,
  });

  assert.deepEqual(result, { reconciledJobCount: 1 });
  assert.equal(queryCount, 6);
});
