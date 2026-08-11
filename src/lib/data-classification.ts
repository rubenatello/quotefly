export const DATA_CLASSIFICATIONS = [
  "C0_PUBLIC",
  "C1_BUSINESS_INTERNAL",
  "C2_CUSTOMER_CONFIDENTIAL",
  "C3_FINANCIAL_CONFIDENTIAL",
  "C4_RESTRICTED",
] as const;

export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];

export const AI_PURPOSES = [
  "QUOTE_DRAFT",
  "QUOTE_REVISION",
  "BUSINESS_INSIGHT",
] as const;

export type AiPurpose = (typeof AI_PURPOSES)[number];

export const AI_DATA_POLICY_VERSION = "2026-08-11";

export type AiRetrievableField =
  | "Customer.fullName"
  | "Customer.email"
  | "Customer.phone"
  | "Customer.notes"
  | "Quote.serviceType"
  | "Quote.status"
  | "Quote.jobStatus"
  | "Quote.title"
  | "Quote.scopeText"
  | "Quote.customerPriceSubtotal"
  | "Quote.internalCostSubtotal"
  | "QuoteLineItem.description"
  | "QuoteLineItem.unitPrice"
  | "QuoteLineItem.unitCost"
  | "CustomerActivityEvent.title"
  | "CustomerActivityEvent.detail"
  | "WorkPreset.name"
  | "WorkPreset.description"
  | "WorkPreset.unitPrice"
  | "WorkPreset.unitCost"
  | "AiUsageEvent.promptRedacted"
  | "AiUsageEvent.estimatedCostUsd";

export type AiFieldPolicy = Readonly<{
  classification: DataClassification;
  allowedPurposes: readonly AiPurpose[];
  vectorEligible: boolean;
}>;

const QUOTE_PURPOSES = ["QUOTE_DRAFT", "QUOTE_REVISION"] as const satisfies readonly AiPurpose[];
const ALL_PURPOSES = [...QUOTE_PURPOSES, "BUSINESS_INSIGHT"] as const satisfies readonly AiPurpose[];

/**
 * Exhaustive registry for fields eligible for structured insights or future
 * retrieval. Restricted credentials and raw provider payloads are intentionally
 * absent because they are never AI-retrievable.
 */
export const AI_RETRIEVABLE_FIELD_POLICY = {
  "Customer.fullName": { classification: "C2_CUSTOMER_CONFIDENTIAL", allowedPurposes: ALL_PURPOSES, vectorEligible: false },
  "Customer.email": { classification: "C2_CUSTOMER_CONFIDENTIAL", allowedPurposes: QUOTE_PURPOSES, vectorEligible: false },
  "Customer.phone": { classification: "C2_CUSTOMER_CONFIDENTIAL", allowedPurposes: QUOTE_PURPOSES, vectorEligible: false },
  "Customer.notes": { classification: "C2_CUSTOMER_CONFIDENTIAL", allowedPurposes: ALL_PURPOSES, vectorEligible: true },
  "Quote.serviceType": { classification: "C1_BUSINESS_INTERNAL", allowedPurposes: ALL_PURPOSES, vectorEligible: false },
  "Quote.status": { classification: "C1_BUSINESS_INTERNAL", allowedPurposes: ALL_PURPOSES, vectorEligible: false },
  "Quote.jobStatus": { classification: "C1_BUSINESS_INTERNAL", allowedPurposes: ALL_PURPOSES, vectorEligible: false },
  "Quote.title": { classification: "C2_CUSTOMER_CONFIDENTIAL", allowedPurposes: ALL_PURPOSES, vectorEligible: true },
  "Quote.scopeText": { classification: "C2_CUSTOMER_CONFIDENTIAL", allowedPurposes: ALL_PURPOSES, vectorEligible: true },
  "Quote.customerPriceSubtotal": { classification: "C2_CUSTOMER_CONFIDENTIAL", allowedPurposes: ALL_PURPOSES, vectorEligible: false },
  "Quote.internalCostSubtotal": { classification: "C3_FINANCIAL_CONFIDENTIAL", allowedPurposes: ALL_PURPOSES, vectorEligible: false },
  "QuoteLineItem.description": { classification: "C2_CUSTOMER_CONFIDENTIAL", allowedPurposes: ALL_PURPOSES, vectorEligible: true },
  "QuoteLineItem.unitPrice": { classification: "C2_CUSTOMER_CONFIDENTIAL", allowedPurposes: ALL_PURPOSES, vectorEligible: false },
  "QuoteLineItem.unitCost": { classification: "C3_FINANCIAL_CONFIDENTIAL", allowedPurposes: ALL_PURPOSES, vectorEligible: false },
  "CustomerActivityEvent.title": { classification: "C2_CUSTOMER_CONFIDENTIAL", allowedPurposes: ALL_PURPOSES, vectorEligible: true },
  "CustomerActivityEvent.detail": { classification: "C2_CUSTOMER_CONFIDENTIAL", allowedPurposes: ALL_PURPOSES, vectorEligible: true },
  "WorkPreset.name": { classification: "C1_BUSINESS_INTERNAL", allowedPurposes: ALL_PURPOSES, vectorEligible: true },
  "WorkPreset.description": { classification: "C1_BUSINESS_INTERNAL", allowedPurposes: ALL_PURPOSES, vectorEligible: true },
  "WorkPreset.unitPrice": { classification: "C2_CUSTOMER_CONFIDENTIAL", allowedPurposes: ALL_PURPOSES, vectorEligible: false },
  "WorkPreset.unitCost": { classification: "C3_FINANCIAL_CONFIDENTIAL", allowedPurposes: ALL_PURPOSES, vectorEligible: false },
  "AiUsageEvent.promptRedacted": { classification: "C2_CUSTOMER_CONFIDENTIAL", allowedPurposes: QUOTE_PURPOSES, vectorEligible: false },
  "AiUsageEvent.estimatedCostUsd": { classification: "C3_FINANCIAL_CONFIDENTIAL", allowedPurposes: ["BUSINESS_INSIGHT"], vectorEligible: false },
} as const satisfies Record<AiRetrievableField, AiFieldPolicy>;
