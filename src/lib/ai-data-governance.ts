import { createHash } from "node:crypto";
import type { AiPurpose, DataClassification } from "./data-classification";

export const RAW_AI_PROMPT_RETENTION_DAYS = 30;
export const REDACTED_AI_TRACE_RETENTION_DAYS = 90;
export const MAX_REDACTED_PROMPT_LENGTH = 2_000;

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_PATTERN = /(?<!\d)(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const PROVIDER_SECRET_PATTERN = /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9_-]{8,}\b|\bwhsec_[A-Za-z0-9_-]{8,}\b/gi;
const LABELED_SECRET_PATTERN = /\b(password|passcode|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*([^\s,;]+)/gi;
const LONG_TOKEN_PATTERN = /\b(?:[a-f0-9]{40,}|[A-Za-z0-9_-]{48,})\b/gi;
const URL_SECRET_PATTERN = /([?&](?:token|key|secret|signature|code)=)[^&#\s]+/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type GovernedPrompt = Readonly<{
  redacted: string;
  sha256: string;
  retentionExpiresAtUtc: Date;
}>;

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function addUtcDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

export function redactAiPrompt(
  prompt: string,
  options?: { knownSensitiveValues?: readonly string[] },
): string {
  let redacted = prompt.normalize("NFKC");

  for (const knownValue of options?.knownSensitiveValues ?? []) {
    const value = knownValue.trim();
    if (value.length < 3) continue;
    redacted = redacted.replace(new RegExp(escapeRegExp(value), "gi"), "[REDACTED]");
  }

  redacted = redacted
    .replace(EMAIL_PATTERN, "[REDACTED_EMAIL]")
    .replace(BEARER_PATTERN, "Bearer [REDACTED_TOKEN]")
    .replace(PROVIDER_SECRET_PATTERN, "[REDACTED_SECRET]")
    .replace(LABELED_SECRET_PATTERN, (_match, label: string) => `${label}: [REDACTED_SECRET]`)
    .replace(URL_SECRET_PATTERN, "$1[REDACTED_SECRET]")
    .replace(PHONE_PATTERN, "[REDACTED_PHONE]")
    .replace(LONG_TOKEN_PATTERN, "[REDACTED_TOKEN]")
    .trim();

  if (redacted.length > MAX_REDACTED_PROMPT_LENGTH) {
    redacted = `${redacted.slice(0, MAX_REDACTED_PROMPT_LENGTH)}…[TRUNCATED]`;
  }

  return redacted || "[EMPTY_PROMPT]";
}

export function governAiPrompt(
  prompt: string,
  options?: { now?: Date; knownSensitiveValues?: readonly string[] },
): GovernedPrompt {
  const now = options?.now ?? new Date();
  return {
    redacted: redactAiPrompt(prompt, { knownSensitiveValues: options?.knownSensitiveValues }),
    sha256: sha256Text(prompt),
    retentionExpiresAtUtc: addUtcDays(now, REDACTED_AI_TRACE_RETENTION_DAYS),
  };
}

export function maxClassificationForQuotePurpose(
  purpose: AiPurpose,
): DataClassification {
  return purpose === "BUSINESS_INSIGHT"
    ? "C2_CUSTOMER_CONFIDENTIAL"
    : "C3_FINANCIAL_CONFIDENTIAL";
}

export function hashSourceReference(sourceType: string, sourceId: string): string {
  return sha256Text(`${sourceType}:${sourceId}`);
}
