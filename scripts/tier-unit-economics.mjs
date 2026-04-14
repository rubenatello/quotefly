/**
 * Tier unit economics calculator.
 *
 * Usage:
 *   node scripts/tier-unit-economics.mjs
 *
 * Edit ASSUMPTIONS + TIERS below to test different scenarios.
 */

const ASSUMPTIONS = {
  stripePercentFee: 0.029,
  stripeFixedFeeUsd: 0.3,
  payingTenants: 25,
  infraMonthlyUsd: 150,
  variableNonAiByTierUsd: {
    starter: 0.5,
    professional: 1.5,
    enterprise: 5,
  },
  targetContributionMarginByTier: {
    starter: 0.58,
    professional: 0.65,
    enterprise: 0.7,
  },
};

const TIERS = [
  { code: "starter", name: "Starter", priceUsd: 19, proposedAiBudgetUsd: 4 },
  { code: "professional", name: "Professional", priceUsd: 59, proposedAiBudgetUsd: 11 },
  { code: "enterprise", name: "Enterprise", priceUsd: 249, proposedAiBudgetUsd: 60 },
];

function round(value, digits = 2) {
  return Number(value.toFixed(digits));
}

function pct(value) {
  return `${round(value * 100, 1)}%`;
}

function buildRow(tier, assumptions) {
  const stripeFeeUsd = tier.priceUsd * assumptions.stripePercentFee + assumptions.stripeFixedFeeUsd;
  const infraPerTenantUsd = assumptions.infraMonthlyUsd / assumptions.payingTenants;
  const nonAiVariableUsd = assumptions.variableNonAiByTierUsd[tier.code] ?? 0;
  const proposedAiBudgetUsd = tier.proposedAiBudgetUsd;

  const totalVariableCostUsd =
    stripeFeeUsd + infraPerTenantUsd + nonAiVariableUsd + proposedAiBudgetUsd;
  const contributionUsd = tier.priceUsd - totalVariableCostUsd;
  const contributionMargin = contributionUsd / tier.priceUsd;

  const targetMargin = assumptions.targetContributionMarginByTier[tier.code] ?? 0;
  const targetContributionUsd = tier.priceUsd * targetMargin;
  const maxAiBudgetForTargetMarginUsd =
    tier.priceUsd - stripeFeeUsd - infraPerTenantUsd - nonAiVariableUsd - targetContributionUsd;

  return {
    Tier: tier.name,
    "Price ($)": round(tier.priceUsd),
    "Stripe ($)": round(stripeFeeUsd),
    "Infra/Tenant ($)": round(infraPerTenantUsd),
    "Non-AI Var ($)": round(nonAiVariableUsd),
    "AI Budget Proposed ($)": round(proposedAiBudgetUsd),
    "Total Variable Cost ($)": round(totalVariableCostUsd),
    "Contribution ($)": round(contributionUsd),
    "Contribution Margin": pct(contributionMargin),
    "Target Margin": pct(targetMargin),
    "AI Budget Max @ Target Margin ($)": round(maxAiBudgetForTargetMarginUsd),
  };
}

function main() {
  const rows = TIERS.map((tier) => buildRow(tier, ASSUMPTIONS));
  const infraPerTenantUsd = ASSUMPTIONS.infraMonthlyUsd / ASSUMPTIONS.payingTenants;

  console.log("=== Unit Economics Inputs ===");
  console.log(
    JSON.stringify(
      {
        stripePercentFee: ASSUMPTIONS.stripePercentFee,
        stripeFixedFeeUsd: ASSUMPTIONS.stripeFixedFeeUsd,
        payingTenants: ASSUMPTIONS.payingTenants,
        infraMonthlyUsd: ASSUMPTIONS.infraMonthlyUsd,
        infraPerTenantUsd: round(infraPerTenantUsd),
        variableNonAiByTierUsd: ASSUMPTIONS.variableNonAiByTierUsd,
        targetContributionMarginByTier: ASSUMPTIONS.targetContributionMarginByTier,
      },
      null,
      2,
    ),
  );

  console.log("\n=== Tier Output ===");
  console.table(rows);
}

main();
