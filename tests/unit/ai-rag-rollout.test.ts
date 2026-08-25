import assert from "node:assert/strict";
import test from "node:test";
import {
  isAiRagEnabledForTenant,
  isAiRagExposedForTenant,
  parseAiRagTenantAllowlist,
  summarizeAiRagRollout,
} from "../../src/lib/ai-rag-rollout";

test("RAG rollout defaults can disable every tenant without exposing allowlist values", () => {
  const config = { AI_RAG_ROLLOUT_MODE: "off" as const, AI_RAG_TENANT_ALLOWLIST: "tenant-a" };
  assert.equal(isAiRagEnabledForTenant(config, "tenant-a"), false);
  assert.equal(isAiRagExposedForTenant(config, "tenant-a"), false);
  assert.deepEqual(summarizeAiRagRollout(config, ["tenant-a", "tenant-b"]), {
    mode: "off",
    configuredAllowlistSize: 1,
    enabledActiveTenantCount: 0,
    exposedActiveTenantCount: 0,
  });
});

test("shadow allowlist indexes and retrieves only approved tenants without model exposure", () => {
  const config = {
    AI_RAG_ROLLOUT_MODE: "shadow_allowlist" as const,
    AI_RAG_TENANT_ALLOWLIST: " tenant-a,tenant-a, tenant-b ",
  };
  assert.deepEqual(parseAiRagTenantAllowlist(config.AI_RAG_TENANT_ALLOWLIST), {
    tenantIds: ["tenant-a", "tenant-b"],
    invalidTenantIds: [],
  });
  assert.equal(isAiRagEnabledForTenant(config, "tenant-a"), true);
  assert.equal(isAiRagExposedForTenant(config, "tenant-a"), false);
  assert.equal(isAiRagEnabledForTenant(config, "tenant-c"), false);
});

test("allowlist and all modes expose only their intended active tenants", () => {
  const allowlist = { AI_RAG_ROLLOUT_MODE: "allowlist" as const, AI_RAG_TENANT_ALLOWLIST: "tenant-a" };
  const all = { AI_RAG_ROLLOUT_MODE: "all" as const, AI_RAG_TENANT_ALLOWLIST: "" };
  assert.equal(isAiRagExposedForTenant(allowlist, "tenant-a"), true);
  assert.equal(isAiRagExposedForTenant(allowlist, "tenant-b"), false);
  assert.equal(isAiRagExposedForTenant(all, "tenant-b"), true);
});
