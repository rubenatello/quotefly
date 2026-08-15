export const BASIC_PLAN = {
  code: "starter",
  name: "Basic",
  monthlyPriceUsd: 29,
  trialDays: 20,
  firstPaidMonthDiscountPercent: 50,
  firstPaidMonthPriceUsd: 14.5,
  quotesPerMonth: 600,
  estimatedAiPromptsPerMonth: 770,
  teamMembers: 7,
  quoteHistoryDays: 30,
} as const;

export function basicMonthlyPriceLabel(): string {
  return `$${BASIC_PLAN.monthlyPriceUsd}/mo`;
}

export function basicFirstPaidMonthPriceLabel(): string {
  return `$${BASIC_PLAN.firstPaidMonthPriceUsd.toFixed(2)}`;
}

export function basicIntroOfferLabel(): string {
  return `${BASIC_PLAN.trialDays}-day free trial, then ${basicFirstPaidMonthPriceLabel()} for your first paid month`;
}
