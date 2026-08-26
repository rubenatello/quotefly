import OpenAI from "openai";
import { env } from "../config/env";
import {
  AI_USAGE_ERROR_CODES,
  AiUsageLedgerError,
  finalizeAiProviderCall,
  markAiProviderCallStarted,
  reserveAiProviderCall,
} from "./ai-usage-ledger";

let openaiClient: OpenAI | undefined;
const OPENAI_PRICING_VERSION = "openai-approved-2026-08-v1";

type AiProviderGatewayTestHooks = Readonly<{
  chatCompletion?: (
    request: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ) => Promise<OpenAI.Chat.Completions.ChatCompletion>;
  embeddings?: (
    request: OpenAI.Embeddings.EmbeddingCreateParams,
  ) => Promise<OpenAI.Embeddings.CreateEmbeddingResponse>;
}>;

let testHooks: AiProviderGatewayTestHooks | null = null;

export function setAiProviderGatewayTestHooks(hooks: AiProviderGatewayTestHooks | null) {
  if (env.NODE_ENV !== "test") {
    throw new Error("AI provider test hooks are available only in the test environment.");
  }
  testHooks = hooks;
}

function getOpenAI() {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
      maxRetries: 0,
      timeout: 90_000,
    });
  }
  return openaiClient;
}

type ModelPricing = Readonly<{
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}>;

function pricingForModel(model: string, kind: "CHAT" | "EMBEDDING"): ModelPricing {
  const normalized = model.trim();
  const expectedModels = kind === "CHAT"
    ? new Set([env.OPENAI_MODEL.trim(), (env.OPENAI_ASSISTANT_MODEL || env.OPENAI_MODEL).trim()])
    : new Set([env.OPENAI_EMBEDDING_MODEL.trim()]);
  const pricing = kind === "CHAT"
    ? {
        inputUsdPerMillion: env.OPENAI_COST_INPUT_PER_1M_USD,
        outputUsdPerMillion: env.OPENAI_COST_OUTPUT_PER_1M_USD,
      }
    : {
        inputUsdPerMillion: env.OPENAI_EMBEDDING_COST_PER_1M_USD,
        outputUsdPerMillion: 0,
      };
  if (
    !normalized
    || !expectedModels.has(normalized)
    || !Number.isFinite(pricing.inputUsdPerMillion)
    || pricing.inputUsdPerMillion <= 0
    || !Number.isFinite(pricing.outputUsdPerMillion)
    || pricing.outputUsdPerMillion < 0
    || (kind === "CHAT" && pricing.outputUsdPerMillion <= 0)
  ) {
    throw new AiUsageLedgerError(
      AI_USAGE_ERROR_CODES.ACCOUNTING_UNAVAILABLE,
      503,
      "AI usage accounting is temporarily unavailable.",
    );
  }
  return pricing;
}

function serializedBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function ceilingMicros(inputBytes: number, maxOutputTokens: number, pricing: ModelPricing) {
  // A UTF-8 byte is a conservative upper bound for an input token. USD per
  // million tokens is numerically equal to micro-USD per token.
  return BigInt(Math.ceil(
    inputBytes * pricing.inputUsdPerMillion
    + maxOutputTokens * pricing.outputUsdPerMillion,
  ));
}

function actualMicros(inputTokens: number, outputTokens: number, pricing: ModelPricing) {
  return BigInt(Math.ceil(
    inputTokens * pricing.inputUsdPerMillion
    + outputTokens * pricing.outputUsdPerMillion,
  ));
}

function validUsageTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertTextOnlyChatRequest(
  request: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
) {
  if (request.n !== undefined && request.n !== 1) {
    throw new AiUsageLedgerError(
      AI_USAGE_ERROR_CODES.ACCOUNTING_UNAVAILABLE,
      503,
      "AI usage accounting is temporarily unavailable.",
    );
  }
  const textOnly = request.messages.every((message) => {
    if (typeof message.content === "string" || message.content === null) return true;
    return Array.isArray(message.content)
      && message.content.every((part) => (
        typeof part === "object"
        && part !== null
        && "type" in part
        && part.type === "text"
        && "text" in part
        && typeof part.text === "string"
      ));
  });
  if (!textOnly) {
    // The current byte-based ceiling is deliberately limited to text. Image,
    // audio, and file inputs require provider-specific token accounting before
    // they can be safely enabled.
    throw new AiUsageLedgerError(
      AI_USAGE_ERROR_CODES.ACCOUNTING_UNAVAILABLE,
      503,
      "AI usage accounting is temporarily unavailable.",
    );
  }
}

async function chargeAmbiguous(
  reservation: Awaited<ReturnType<typeof reserveAiProviderCall>>,
  incidentCode: string,
) {
  await finalizeAiProviderCall(reservation, { outcome: "AMBIGUOUS", incidentCode });
}

async function runTestHookWithTimeout<T>(operation: Promise<T>, timeoutMs?: number): Promise<T> {
  if (!timeoutMs) return operation;
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("AI provider call timed out.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function createOpenAiChatCompletion(
  request: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  options: { timeoutMs?: number } = {},
) {
  assertTextOnlyChatRequest(request);
  const model = request.model.trim();
  const maxOutputTokens = request.max_tokens;
  if (!Number.isSafeInteger(maxOutputTokens) || (maxOutputTokens ?? 0) <= 0) {
    throw new AiUsageLedgerError(
      AI_USAGE_ERROR_CODES.ACCOUNTING_UNAVAILABLE,
      503,
      "AI usage accounting is temporarily unavailable.",
    );
  }
  const pricing = pricingForModel(model, "CHAT");
  const inputBytes = serializedBytes(request);
  const reservation = await reserveAiProviderCall({
    model,
    pricingVersion: OPENAI_PRICING_VERSION,
    inputRateMicrosPerM: BigInt(Math.round(pricing.inputUsdPerMillion * 1_000_000)),
    outputRateMicrosPerM: BigInt(Math.round(pricing.outputUsdPerMillion * 1_000_000)),
    serializedInputBytes: inputBytes,
    maxOutputTokens: maxOutputTokens!,
    ceilingCostMicros: ceilingMicros(inputBytes, maxOutputTokens!, pricing),
  });
  await markAiProviderCallStarted(reservation);
  let completion: OpenAI.Chat.Completions.ChatCompletion;
  try {
    completion = testHooks?.chatCompletion
      ? await runTestHookWithTimeout(testHooks.chatCompletion(request), options.timeoutMs)
      : await getOpenAI().chat.completions.create(request, {
          maxRetries: 0,
          ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
        });
  } catch (error) {
    await chargeAmbiguous(reservation, "PROVIDER_CALL_FAILED_AFTER_START");
    throw error;
  }
  const promptTokens = completion.usage?.prompt_tokens;
  const completionTokens = completion.usage?.completion_tokens;
  if (!validUsageTokenCount(promptTokens) || !validUsageTokenCount(completionTokens)) {
    await chargeAmbiguous(reservation, "PROVIDER_USAGE_MISSING");
    throw new AiUsageLedgerError(
      AI_USAGE_ERROR_CODES.ACCOUNTING_UNAVAILABLE,
      503,
      "AI usage accounting is temporarily unavailable.",
    );
  }
  await finalizeAiProviderCall(reservation, {
    outcome: "SUCCESS",
    actualCostMicros: actualMicros(promptTokens, completionTokens, pricing),
  });
  return completion;
}

export async function createOpenAiEmbeddings(
  request: OpenAI.Embeddings.EmbeddingCreateParams,
  options: { timeoutMs?: number } = {},
) {
  const model = request.model.trim();
  const pricing = pricingForModel(model, "EMBEDDING");
  const inputBytes = serializedBytes(request);
  const reservation = await reserveAiProviderCall({
    model,
    pricingVersion: OPENAI_PRICING_VERSION,
    inputRateMicrosPerM: BigInt(Math.round(pricing.inputUsdPerMillion * 1_000_000)),
    outputRateMicrosPerM: 0n,
    serializedInputBytes: inputBytes,
    maxOutputTokens: 0,
    ceilingCostMicros: ceilingMicros(inputBytes, 0, pricing),
  });
  await markAiProviderCallStarted(reservation);
  let response: OpenAI.Embeddings.CreateEmbeddingResponse;
  try {
    response = testHooks?.embeddings
      ? await runTestHookWithTimeout(testHooks.embeddings(request), options.timeoutMs)
      : await getOpenAI().embeddings.create(request, {
          maxRetries: 0,
          ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
        });
  } catch (error) {
    await chargeAmbiguous(reservation, "PROVIDER_CALL_FAILED_AFTER_START");
    throw error;
  }
  const promptTokens = response.usage?.prompt_tokens;
  if (!validUsageTokenCount(promptTokens)) {
    await chargeAmbiguous(reservation, "PROVIDER_USAGE_MISSING");
    throw new AiUsageLedgerError(
      AI_USAGE_ERROR_CODES.ACCOUNTING_UNAVAILABLE,
      503,
      "AI usage accounting is temporarily unavailable.",
    );
  }
  await finalizeAiProviderCall(reservation, {
    outcome: "SUCCESS",
    actualCostMicros: actualMicros(promptTokens, 0, pricing),
  });
  return response;
}
