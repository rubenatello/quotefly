import { createHash } from "node:crypto";
import type { AiPurpose, DataClassification } from "./data-classification";

export const RAW_AI_PROMPT_RETENTION_DAYS = 30;
export const REDACTED_AI_TRACE_RETENTION_DAYS = 90;
export const MAX_REDACTED_PROMPT_LENGTH = 2_000;

const LONG_TOKEN_PATTERN = /\b(?:[a-f0-9]{40,}|[A-Za-z0-9_-]{48,})\b/gi;
const SCHEME_URI_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/giu;

const restrictedCredentialPatterns = () => [
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s/]+/giu,
  /\bbearer\s+[a-z0-9._~+/=-]{8,}\b/giu,
  /\bauthorization\s*:\s*basic\s+[a-z0-9+/=]{8,}\b/giu,
  /\b(?:password|passcode|secret|token|api[\s_-]?key|access[\s_-]?token|refresh[\s_-]?token|account[\s_-]?key|private[\s_-]?key|contrase(?:ñ|n)a|clave|secreto|autorizaci(?:ó|o)n|clave[\s_-]?(?:de[\s_-]?)?api|token[\s_-]?(?:de[\s_-]?)?acceso)\b\s*[:=]\s*(?:["']?)[^\s,;"']{6,}/giu,
  /\b(?:sk|rk|pk)[_-](?:live|test|proj)[_-][a-z0-9_-]{8,}\b|\b(?:whsec|ghp|github_pat|xox[a-z]?|re)[_-][a-z0-9_-]{8,}\b/giu,
  /[?&](?:token|key|secret|signature|code|password|clave|secreto|firma|codigo)=[^&#\s]{6,}/giu,
  /-----BEGIN\s+(?:(?:RSA|EC|DSA|OPENSSH)\s+)?PRIVATE KEY-----/giu,
  /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/giu,
  /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/gu,
  /\bAIza[0-9A-Za-z_-]{35}\b/gu,
  /\bSG\.[0-9A-Za-z_-]{16,}\.[0-9A-Za-z_-]{16,}\b/gu,
  /\bssh-(?:rsa|ed25519)\s+[A-Za-z0-9+/]{32,}={0,3}/giu,
];

const OPAQUE_TOKEN_PATTERN = /\b[A-Za-z0-9_+/=-]{48,256}\b/gu;

function tokenEntropy(value: string) {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  return Array.from(counts.values()).reduce((entropy, count) => {
    const probability = count / value.length;
    return entropy - probability * Math.log2(probability);
  }, 0);
}

function looksLikeOpaqueCredential(value: string) {
  const token = value.replace(/=+$/u, "");
  if (/^(?=.*[a-f])(?=.*\d)[a-f\d]{40,}$/iu.test(token)) return true;
  const characterClasses = [/[a-z]/u, /[A-Z]/u, /\d/u, /[_+/=-]/u]
    .filter((pattern) => pattern.test(token)).length;
  return characterClasses >= 3 && tokenEntropy(token) >= 4;
}

export function redactRestrictedAiCredentials(value: string, replacement = "[REDACTED_SECRET]") {
  let redactionCount = 0;
  let redacted = value;
  for (const pattern of restrictedCredentialPatterns()) {
    redacted = redacted.replace(pattern, () => {
      redactionCount += 1;
      return replacement;
    });
  }
  redacted = redacted.replace(OPAQUE_TOKEN_PATTERN, (candidate) => {
    if (!looksLikeOpaqueCredential(candidate)) return candidate;
    redactionCount += 1;
    return replacement;
  });
  return { redacted, redactionCount };
}

export function containsRestrictedAiCredential(value: string) {
  return redactRestrictedAiCredentials(value).redactionCount > 0;
}

export function redactAiContactDetails(
  value: string,
  replacements: { email: string; phone: string },
) {
  let redactionCount = 0;
  const redacted = value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, () => {
      redactionCount += 1;
      return replacements.email;
    })
    .replace(/(?<!\d)(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/gu, () => {
      redactionCount += 1;
      return replacements.phone;
    })
    .replace(/(?<![\d\w])\+[1-9](?:[\s().-]*\d){7,14}(?!\d)/gu, () => {
      redactionCount += 1;
      return replacements.phone;
    });
  return { redacted, redactionCount };
}

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

  // Remove complete URIs before email or labeled-secret rules can split
  // credential-bearing userinfo and leave host, port, or path fragments.
  redacted = redacted.replace(SCHEME_URI_PATTERN, "[REDACTED_URI]");

  for (const knownValue of options?.knownSensitiveValues ?? []) {
    const value = knownValue.trim();
    if (value.length < 3) continue;
    redacted = redacted.replace(new RegExp(escapeRegExp(value), "gi"), "[REDACTED]");
  }

  redacted = redactRestrictedAiCredentials(redacted).redacted;
  redacted = redactAiContactDetails(redacted, {
    email: "[REDACTED_EMAIL]",
    phone: "[REDACTED_PHONE]",
  }).redacted
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
