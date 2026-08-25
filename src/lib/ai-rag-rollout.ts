export const AI_RAG_ROLLOUT_MODES = ["off", "shadow_allowlist", "allowlist", "all"] as const;

export type AiRagRolloutMode = (typeof AI_RAG_ROLLOUT_MODES)[number];

export type AiRagRolloutConfig = Readonly<{
  AI_RAG_ROLLOUT_MODE: AiRagRolloutMode;
  AI_RAG_TENANT_ALLOWLIST: string;
}>;

const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,190}$/;

export function parseAiRagTenantAllowlist(value: string) {
  const values = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const invalidTenantIds = values.filter((tenantId) => !TENANT_ID_PATTERN.test(tenantId));
  return {
    tenantIds: Array.from(new Set(values.filter((tenantId) => TENANT_ID_PATTERN.test(tenantId)))),
    invalidTenantIds: Array.from(new Set(invalidTenantIds)),
  };
}

export function isAiRagEnabledForTenant(config: AiRagRolloutConfig, tenantId: string) {
  if (config.AI_RAG_ROLLOUT_MODE === "off") return false;
  if (config.AI_RAG_ROLLOUT_MODE === "all") return true;
  return parseAiRagTenantAllowlist(config.AI_RAG_TENANT_ALLOWLIST).tenantIds.includes(tenantId);
}

export function isAiRagExposedForTenant(config: AiRagRolloutConfig, tenantId: string) {
  return isAiRagEnabledForTenant(config, tenantId)
    && config.AI_RAG_ROLLOUT_MODE !== "shadow_allowlist";
}

export function summarizeAiRagRollout(config: AiRagRolloutConfig, activeTenantIds: readonly string[]) {
  const configuredAllowlistSize = parseAiRagTenantAllowlist(config.AI_RAG_TENANT_ALLOWLIST).tenantIds.length;
  return {
    mode: config.AI_RAG_ROLLOUT_MODE,
    configuredAllowlistSize,
    enabledActiveTenantCount: activeTenantIds.filter((tenantId) => isAiRagEnabledForTenant(config, tenantId)).length,
    exposedActiveTenantCount: activeTenantIds.filter((tenantId) => isAiRagExposedForTenant(config, tenantId)).length,
  };
}
