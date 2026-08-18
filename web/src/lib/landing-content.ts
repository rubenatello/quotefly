import { BASIC_PLAN, basicFirstPaidMonthPriceLabel } from "./plans";

export const LANDING_FAQS = [
  {
    q: "Will Kody decide my prices or send a quote without me?",
    a: "No. Kody can organize a starting draft using the information available in your workspace, but you review the scope, quantities, prices, and customer-facing message before anything is created or sent.",
  },
  {
    q: "Can crew members see internal costs?",
    a: "Owners and admins can manage products and internal costs. Members can work with assigned customers and quotes without receiving access to protected cost and margin information.",
  },
  {
    q: "How is my workspace data separated?",
    a: "QuoteFly scopes customer, quote, retrieval, and AI activity to the signed-in tenant. Kody only receives the authorized workspace context required for the request.",
  },
  {
    q: "Can I use QuoteFly from my phone?",
    a: "Yes. Customer intake, quote building, branded PDF review, sharing, and follow-up are designed for mobile and desktop use.",
  },
  {
    q: "Can I use my logo and colors?",
    a: "Yes. Choose a quote template, upload your logo, set your brand color, and preview how the customer-facing PDF will look.",
  },
  {
    q: "What happens after the free trial?",
    a: `The trial lasts ${BASIC_PLAN.trialDays} days. If you choose Basic, the first paid month is ${basicFirstPaidMonthPriceLabel()}, then $${BASIC_PLAN.monthlyPriceUsd} per month. You stay in control of whether to continue.`,
  },
] as const;
