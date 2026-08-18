import assert from "node:assert/strict";
import test from "node:test";
import {
  capabilitiesForRole,
  type Capability,
} from "../../src/lib/access-policy";
import {
  governAiPrompt,
  MAX_REDACTED_PROMPT_LENGTH,
  redactAiPrompt,
  sha256Text,
} from "../../src/lib/ai-data-governance";
import {
  AI_RETRIEVABLE_FIELD_POLICY,
  type AiRetrievableField,
} from "../../src/lib/data-classification";

function capabilitySnapshot(role: string): Record<Capability, boolean> {
  const capabilities = capabilitiesForRole(role);
  return {
    viewCustomerPii: capabilities.has("viewCustomerPii"),
    viewTenantQuotes: capabilities.has("viewTenantQuotes"),
    viewInternalCosts: capabilities.has("viewInternalCosts"),
    viewMargins: capabilities.has("viewMargins"),
    viewAiRunSummary: capabilities.has("viewAiRunSummary"),
    viewAiRunAudit: capabilities.has("viewAiRunAudit"),
    viewAiRawPrompt: capabilities.has("viewAiRawPrompt"),
    useAiQuoteDrafting: capabilities.has("useAiQuoteDrafting"),
    useAiBusinessInsights: capabilities.has("useAiBusinessInsights"),
    manageAiSettings: capabilities.has("manageAiSettings"),
    viewBilling: capabilities.has("viewBilling"),
    manageBilling: capabilities.has("manageBilling"),
    manageIntegrations: capabilities.has("manageIntegrations"),
    manageTeam: capabilities.has("manageTeam"),
  };
}

test("role capabilities deny financial and raw-prompt access to members", () => {
  const member = capabilitySnapshot("member");
  assert.equal(member.viewTenantQuotes, true);
  assert.equal(member.useAiQuoteDrafting, true);
  assert.equal(member.viewAiRunSummary, true);
  assert.equal(member.viewInternalCosts, false);
  assert.equal(member.viewMargins, false);
  assert.equal(member.viewAiRunAudit, false);
  assert.equal(member.viewAiRawPrompt, false);
  assert.equal(member.manageBilling, false);

  for (const role of ["owner", "admin"]) {
    const privileged = capabilitySnapshot(role);
    assert.equal(privileged.viewInternalCosts, true);
    assert.equal(privileged.viewMargins, true);
    assert.equal(privileged.viewAiRunAudit, true);
    assert.equal(privileged.viewAiRawPrompt, false);
  }
  assert.equal(capabilitySnapshot("owner").manageBilling, true);
  assert.equal(capabilitySnapshot("admin").manageBilling, false);

  assert.deepEqual(capabilitySnapshot("unexpected-future-role"), member);
});

test("prompt governance removes PII and secret-shaped values while preserving useful scope", () => {
  const prompt = [
    "Prepare a ROOFING quote for Jane Doe at 2,000 sq ft.",
    "Email jane.customer@example.com or call +1 (555) 222-3333.",
    "password=NeverStoreThis",
    "sk_live_1234567890abcdef",
    "whsec_abcdefghijk123456",
    "Bearer abcdefghijklmnopqrstuvwxyz012345",
    "https://example.test/callback?token=secret-value&next=quote",
  ].join(" ");

  const redacted = redactAiPrompt(prompt, { knownSensitiveValues: ["jane doe"] });
  assert.match(redacted, /ROOFING quote/);
  assert.match(redacted, /2,000 sq ft/);
  assert.doesNotMatch(redacted, /Jane Doe/);
  assert.doesNotMatch(redacted, /jane\.customer@example\.com/);
  assert.doesNotMatch(redacted, /555.*222.*3333/);
  assert.doesNotMatch(redacted, /NeverStoreThis/);
  assert.doesNotMatch(redacted, /sk_live_/);
  assert.doesNotMatch(redacted, /whsec_/);
  assert.doesNotMatch(redacted, /abcdefghijklmnopqrstuvwxyz012345/);
  assert.doesNotMatch(redacted, /secret-value/);
});

test("prompt governance removes complete credential-bearing service URIs", () => {
  const redacted = redactAiPrompt(
    "Use mysql://root:s3cret@db.example.com:3306/app and postgresql://owner:password@db.example.com/quotefly for this quote.",
  );

  assert.equal(redacted, "Use [REDACTED_URI] and [REDACTED_URI] for this quote.");
  assert.doesNotMatch(redacted, /root|s3cret|owner|password|example\.com|3306|\/app|quotefly/i);
});

test("governed prompts are hashed deterministically and expire after 90 days", () => {
  const now = new Date("2026-08-11T12:00:00.000Z");
  const first = governAiPrompt("Roof replacement for 20 squares", { now });
  const second = governAiPrompt("Roof replacement for 20 squares", { now });

  assert.equal(first.sha256, second.sha256);
  assert.equal(first.sha256, sha256Text("Roof replacement for 20 squares"));
  assert.match(first.sha256, /^[0-9a-f]{64}$/);
  assert.equal(first.retentionExpiresAtUtc.toISOString(), "2026-11-09T12:00:00.000Z");

  const oversized = redactAiPrompt("scope detail ".repeat(MAX_REDACTED_PROMPT_LENGTH));
  assert.match(oversized, /\[TRUNCATED\]$/);
  assert.ok(oversized.length <= MAX_REDACTED_PROMPT_LENGTH + 20);
});

test("retrievable field registry classifies every declared field and excludes restricted data", () => {
  const fields = Object.keys(AI_RETRIEVABLE_FIELD_POLICY) as AiRetrievableField[];
  assert.ok(fields.length >= 20);
  for (const field of fields) {
    const policy = AI_RETRIEVABLE_FIELD_POLICY[field];
    assert.ok(policy.classification);
    assert.ok(policy.allowedPurposes.length > 0);
  }

  const joined = fields.join(" ");
  assert.doesNotMatch(joined, /passwordHash|PasswordResetToken|accessToken|refreshToken|WebhookEvent\.payload/);
  assert.equal(AI_RETRIEVABLE_FIELD_POLICY["Quote.internalCostSubtotal"].classification, "C3_FINANCIAL_CONFIDENTIAL");
  assert.equal(AI_RETRIEVABLE_FIELD_POLICY["Customer.notes"].classification, "C2_CUSTOMER_CONFIDENTIAL");
  assert.equal(AI_RETRIEVABLE_FIELD_POLICY["Customer.notes"].vectorEligible, true);
  assert.equal(AI_RETRIEVABLE_FIELD_POLICY["AiUsageEvent.promptRedacted"].vectorEligible, false);
});
