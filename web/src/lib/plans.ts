export const BASIC_PLAN = {
  code: "starter",
  name: "Basic",
  monthlyPriceUsd: 19,
  trialDays: 14,
  quotesPerMonth: 600,
  estimatedAiPromptsPerMonth: 370,
  teamMembers: 7,
  quoteHistoryDays: 30,
} as const;

export function basicMonthlyPriceLabel(): string {
  return `$${BASIC_PLAN.monthlyPriceUsd}/mo`;
}
