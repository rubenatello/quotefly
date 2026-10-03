import type { QuickBooksCredentialRuntimeEnv } from "../config/quickbooks-runtime-types";
import {
  fetchQuickBooksCompanyTaxInfo,
  fetchQuickBooksTaxPreferences,
  QuickBooksProviderError,
  type QuickBooksCompanyTaxInfo,
  type QuickBooksTaxPreferences,
} from "./quickbooks";

export type QuickBooksTaxCapabilityReason =
  | "CAPABILITY_READ_FAILED"
  | "CAPABILITY_RESPONSE_INVALID"
  | "COMPANY_BINDING_MISMATCH"
  | "CAPABILITY_INPUT_INVALID"
  | "US_COMPANY_REQUIRED"
  | "COMPANY_ADDRESS_INCOMPLETE"
  | "SALES_TAX_NOT_ENABLED"
  | "ESTIMATES_NOT_ENABLED"
  | "USD_HOME_CURRENCY_REQUIRED";

export interface QuickBooksTaxCapabilityReport {
  /** Necessary company prerequisites only; never authorization to publish. */
  companyPrerequisitesReady: boolean;
  /** Preferences cannot prove provider tax calculation or calculator entitlement. */
  automatedTaxCalculationProven: false;
  usCompany: boolean;
  /** Structural completeness only; not address or jurisdiction verification. */
  companyAddressComplete: boolean;
  salesTaxEnabled: boolean;
  estimatesEnabled: boolean;
  usdHomeCurrency: boolean;
  progressInvoicingEnabled: boolean | null;
  reasons: QuickBooksTaxCapabilityReason[];
}

function failedReport(reason: QuickBooksTaxCapabilityReason): QuickBooksTaxCapabilityReport {
  return {
    companyPrerequisitesReady: false,
    automatedTaxCalculationProven: false,
    usCompany: false,
    companyAddressComplete: false,
    salesTaxEnabled: false,
    estimatesEnabled: false,
    usdHomeCurrency: false,
    progressInvoicingEnabled: null,
    reasons: [reason],
  };
}

/**
 * Read-only preflight for a caller's already-authorized, tenant-bound connection.
 * Does not obtain credentials, mutate settings, enable flags, or authorize tax
 * publishing. Reports contain only fixed codes/booleans, never provider identity,
 * address, tokens, payloads, or arbitrary error strings. Shipping address, line
 * tax intent, customer/item mappings and actual computed tax need separate proof.
 */
export async function inspectQuickBooksTaxCapabilities(
  runtimeEnv: QuickBooksCredentialRuntimeEnv,
  realmId: string,
  accessToken: string,
): Promise<QuickBooksTaxCapabilityReport> {
  try {
    // Preserve binding validation before using this company's preferences.
    const company = await fetchQuickBooksCompanyTaxInfo(runtimeEnv, realmId, accessToken);
    const preferences = await fetchQuickBooksTaxPreferences(runtimeEnv, realmId, accessToken);
    return evaluateQuickBooksTaxCapabilities(company, preferences);
  } catch (error) {
    if (error instanceof QuickBooksProviderError) {
      if (error.code === "QUICKBOOKS_TAX_COMPANY_REALM_MISMATCH") return failedReport("COMPANY_BINDING_MISMATCH");
      if (error.code === "QUICKBOOKS_TAX_CAPABILITY_INPUT_INVALID") return failedReport("CAPABILITY_INPUT_INVALID");
      if ([
        "QUICKBOOKS_TAX_COMPANY_RESPONSE_INVALID",
        "QUICKBOOKS_TAX_PREFERENCES_RESPONSE_INVALID",
        "QUICKBOOKS_RESPONSE_INVALID",
      ].includes(error.code)) return failedReport("CAPABILITY_RESPONSE_INVALID");
    }
    return failedReport("CAPABILITY_READ_FAILED");
  }
}

/** Pure evaluation of the strict tax-only provider projections. */
export function evaluateQuickBooksTaxCapabilities(company: QuickBooksCompanyTaxInfo, preferences: QuickBooksTaxPreferences): QuickBooksTaxCapabilityReport {
  const usCompany = company.Country?.trim().toUpperCase() === "US";
  const address = company.CompanyAddr;
  const companyAddressComplete = usCompany
    && Boolean(address?.Line1?.trim())
    && Boolean(address?.City?.trim())
    && /^[A-Z]{2}$/.test(address?.CountrySubDivisionCode?.trim().toUpperCase() ?? "")
    && /^\d{5}(?:-\d{4})?$/.test(address?.PostalCode?.trim() ?? "")
    // Intuit may omit the country in a domestic address. Never accept a
    // conflicting explicit country; the CompanyInfo country is mandatory.
    && (address?.Country === undefined || address.Country.trim().toUpperCase() === "US");
  const salesTaxEnabled = preferences.TaxPrefs?.UsingSalesTax === true;
  const estimatesEnabled = preferences.SalesFormsPrefs?.AllowEstimates === true;
  const usdHomeCurrency = preferences.CurrencyPrefs?.HomeCurrency?.value === "USD";
  const reasons: QuickBooksTaxCapabilityReason[] = [];
  if (!usCompany) reasons.push("US_COMPANY_REQUIRED");
  if (!companyAddressComplete) reasons.push("COMPANY_ADDRESS_INCOMPLETE");
  if (!salesTaxEnabled) reasons.push("SALES_TAX_NOT_ENABLED");
  if (!estimatesEnabled) reasons.push("ESTIMATES_NOT_ENABLED");
  if (!usdHomeCurrency) reasons.push("USD_HOME_CURRENCY_REQUIRED");
  return {
    companyPrerequisitesReady: reasons.length === 0,
    automatedTaxCalculationProven: false,
    usCompany,
    companyAddressComplete,
    salesTaxEnabled,
    estimatesEnabled,
    usdHomeCurrency,
    progressInvoicingEnabled: preferences.SalesFormsPrefs?.UsingProgressInvoicing ?? null,
    reasons,
  };
}
