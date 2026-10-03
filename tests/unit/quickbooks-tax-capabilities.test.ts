import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import type { QuickBooksCredentialRuntimeEnv } from "../../src/config/quickbooks-runtime-types";
import { fetchQuickBooksCompanyTaxInfo, fetchQuickBooksTaxPreferences } from "../../src/services/quickbooks";
import { inspectQuickBooksTaxCapabilities } from "../../src/services/quickbooks-tax-capabilities";

const realmId = "123456789012345";
const token = "synthetic-token-never-report";
const runtime: QuickBooksCredentialRuntimeEnv = {
  QUICKBOOKS_ENVIRONMENT: "sandbox",
  QUICKBOOKS_PROVIDER_TIMEOUT_MS: 1000,
  QUICKBOOKS_PROVIDER_READ_RETRIES: 0,
  QUICKBOOKS_CLIENT_ID: "synthetic-client",
  QUICKBOOKS_CLIENT_SECRET: "synthetic-secret",
  QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "synthetic-key",
  QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS: "",
  JWT_SECRET: "synthetic-jwt",
};

function company() {
  return {
    CompanyInfo: {
      Id: realmId,
      Country: "US",
      CompanyName: "Sensitive company name",
      CompanyAddr: {
        Line1: "123 Synthetic Street", City: "Synthetic City",
        CountrySubDivisionCode: "CA", PostalCode: "94105", Country: "US",
      } as Record<string, unknown>,
    } as Record<string, unknown>,
  };
}

function preferences() {
  return {
    Preferences: {
      TaxPrefs: { UsingSalesTax: true },
      SalesFormsPrefs: { AllowEstimates: true, UsingProgressInvoicing: false },
      CurrencyPrefs: { HomeCurrency: { value: "USD" } },
    } as Record<string, unknown>,
  };
}

function mockReads(t: TestContext, companyPayload: unknown = company(), preferencesPayload: unknown = preferences()) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const body = url.endsWith("/preferences") ? preferencesPayload : companyPayload;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return calls;
}

it("reads only bound CompanyInfo and Preferences with existing authenticated GET transport", async (t) => {
  const calls = mockReads(t);
  const report = await inspectQuickBooksTaxCapabilities(runtime, realmId, token);
  assert.deepEqual(report, {
    companyPrerequisitesReady: true, automatedTaxCalculationProven: false,
    usCompany: true, companyAddressComplete: true, salesTaxEnabled: true,
    estimatesEnabled: true, usdHomeCurrency: true, progressInvoicingEnabled: false, reasons: [],
  });
  assert.deepEqual(calls.map(({ url }) => url), [
    `https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}/companyinfo/${realmId}`,
    `https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}/preferences`,
  ]);
  for (const { init } of calls) {
    assert.equal(init?.method ?? "GET", "GET");
    assert.equal(init?.body, undefined);
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${token}`);
    assert.ok(init?.signal instanceof AbortSignal);
  }
  const serialized = JSON.stringify(report);
  for (const sensitive of [realmId, token, "Sensitive company name", "123 Synthetic Street", "Synthetic City", "94105"]) {
    assert.equal(serialized.includes(sensitive), false);
  }
});

it("treats progress invoicing as a diagnostic whether absent, false or true", async (t) => {
  for (const progress of [undefined, false, true]) {
    const payload = preferences();
    payload.Preferences.SalesFormsPrefs = { AllowEstimates: true, UsingProgressInvoicing: progress };
    mockReads(t, company(), payload);
    const report = await inspectQuickBooksTaxCapabilities(runtime, realmId, token);
    assert.equal(report.companyPrerequisitesReady, true);
    assert.equal(report.progressInvoicingEnabled, progress ?? null);
    t.mock.restoreAll();
  }
});

it("requires explicit true sales tax and estimates with no truthy coercion", async (t) => {
  for (const disabled of [false, undefined]) {
    const payload = preferences();
    payload.Preferences.TaxPrefs = { UsingSalesTax: disabled };
    payload.Preferences.SalesFormsPrefs = { AllowEstimates: disabled };
    mockReads(t, company(), payload);
    const report = await inspectQuickBooksTaxCapabilities(runtime, realmId, token);
    assert.equal(report.companyPrerequisitesReady, false);
    assert.deepEqual(report.reasons, ["SALES_TAX_NOT_ENABLED", "ESTIMATES_NOT_ENABLED"]);
    t.mock.restoreAll();
  }
});

it("fails closed on absent capability sections and company prerequisites", async (t) => {
  mockReads(t, { CompanyInfo: { Id: realmId } }, { Preferences: {} });
  const report = await inspectQuickBooksTaxCapabilities(runtime, realmId, token);
  assert.equal(report.companyPrerequisitesReady, false);
  assert.deepEqual(report.reasons, [
    "US_COMPANY_REQUIRED", "COMPANY_ADDRESS_INCOMPLETE", "SALES_TAX_NOT_ENABLED",
    "ESTIMATES_NOT_ENABLED", "USD_HOME_CURRENCY_REQUIRED",
  ]);
});

it("rejects malformed provider flags, address types, null and absent envelopes", async (t) => {
  const badTax = preferences(); badTax.Preferences.TaxPrefs = { UsingSalesTax: "true" };
  const badEstimates = preferences(); badEstimates.Preferences.SalesFormsPrefs = { AllowEstimates: 1 };
  const badProgress = preferences(); badProgress.Preferences.SalesFormsPrefs = { AllowEstimates: true, UsingProgressInvoicing: "false" };
  const badAddress = company(); badAddress.CompanyInfo.CompanyAddr = { Line1: 123 };
  for (const [companyPayload, preferencesPayload] of [
    [company(), badTax], [company(), badEstimates], [company(), badProgress],
    [badAddress, preferences()], [{}, preferences()], [company(), {}],
    [{ CompanyInfo: null }, preferences()], [company(), { Preferences: null }],
  ]) {
    mockReads(t, companyPayload, preferencesPayload);
    const report = await inspectQuickBooksTaxCapabilities(runtime, realmId, token);
    assert.equal(report.companyPrerequisitesReady, false);
    assert.deepEqual(report.reasons, ["CAPABILITY_RESPONSE_INVALID"]);
    t.mock.restoreAll();
  }
});

it("rejects foreign companies even when tax, estimates and USD are enabled", async (t) => {
  const payload = company(); payload.CompanyInfo.Country = "CA";
  mockReads(t, payload);
  const report = await inspectQuickBooksTaxCapabilities(runtime, realmId, token);
  assert.equal(report.usCompany, false);
  assert.equal(report.companyPrerequisitesReady, false);
  assert.deepEqual(report.reasons, ["US_COMPANY_REQUIRED", "COMPANY_ADDRESS_INCOMPLETE"]);
});

it("requires USD home currency without deriving it from the country", async (t) => {
  for (const currency of [undefined, "CAD", "usd", ""]) {
    const payload = preferences();
    payload.Preferences.CurrencyPrefs = currency === undefined ? {} : { HomeCurrency: { value: currency } };
    mockReads(t, company(), payload);
    const report = await inspectQuickBooksTaxCapabilities(runtime, realmId, token);
    assert.equal(report.companyPrerequisitesReady, false);
    assert.deepEqual(report.reasons, ["USD_HOME_CURRENCY_REQUIRED"]);
    t.mock.restoreAll();
  }
});

it("requires structured nonblank address fields and rejects a conflicting country", async (t) => {
  for (const field of ["Line1", "City", "CountrySubDivisionCode", "PostalCode", "Country"]) {
    const payload = company();
    (payload.CompanyInfo.CompanyAddr as Record<string, unknown>)[field] = " ";
    mockReads(t, payload);
    const report = await inspectQuickBooksTaxCapabilities(runtime, realmId, token);
    assert.equal(report.companyAddressComplete, false);
    assert.deepEqual(report.reasons, ["COMPANY_ADDRESS_INCOMPLETE"]);
    t.mock.restoreAll();
  }
  const payload = company(); (payload.CompanyInfo.CompanyAddr as Record<string, unknown>).Country = "CA";
  mockReads(t, payload);
  assert.equal((await inspectQuickBooksTaxCapabilities(runtime, realmId, token)).companyAddressComplete, false);
});

it("accepts omitted domestic address country and ZIP+4 without claiming verified deliverability", async (t) => {
  const payload = company();
  const address = payload.CompanyInfo.CompanyAddr as Record<string, unknown>;
  delete address.Country; address.PostalCode = "94105-1234";
  mockReads(t, payload);
  const report = await inspectQuickBooksTaxCapabilities(runtime, realmId, token);
  assert.equal(report.companyAddressComplete, true);
  assert.equal(report.automatedTaxCalculationProven, false);
});

it("stops before Preferences when the provider company binding does not match", async (t) => {
  const payload = company(); payload.CompanyInfo.Id = "999999999999999";
  const calls = mockReads(t, payload);
  const report = await inspectQuickBooksTaxCapabilities(runtime, realmId, token);
  assert.deepEqual(report.reasons, ["COMPANY_BINDING_MISMATCH"]);
  assert.equal(calls.length, 1);
});

it("rejects malformed realm and missing credentials before HTTP", async (t) => {
  const calls = mockReads(t);
  for (const [realm, credential] of [["../other", token], [realmId, " "]]) {
    const report = await inspectQuickBooksTaxCapabilities(runtime, realm, credential);
    assert.deepEqual(report.reasons, ["CAPABILITY_INPUT_INVALID"]);
  }
  assert.equal(calls.length, 0);
});

it("does not return arbitrary provider error bodies, network details or JSON parser messages", async (t) => {
  for (const kind of ["http", "network", "json", "body"]) {
    t.mock.method(globalThis, "fetch", async () => {
      if (kind === "network") throw new Error(`${token} ${realmId} arbitrary network detail`);
      if (kind === "body") return { text: async () => { throw new Error(token); } } as Response;
      return new Response(`${token} ${realmId} arbitrary provider detail`, { status: kind === "http" ? 403 : 200 });
    });
    const report = await inspectQuickBooksTaxCapabilities(runtime, realmId, token);
    assert.deepEqual(report.reasons, [kind === "json" ? "CAPABILITY_RESPONSE_INVALID" : "CAPABILITY_READ_FAILED"]);
    assert.equal(JSON.stringify(report).includes(token), false);
    assert.equal(JSON.stringify(report).includes(realmId), false);
    t.mock.restoreAll();
  }
});

it("capability readers strip unneeded PII and unsupported payload fields", async (t) => {
  const payload = preferences(); payload.Preferences.UnrelatedSecret = token;
  mockReads(t, company(), payload);
  const info = await fetchQuickBooksCompanyTaxInfo(runtime, realmId, token);
  const prefs = await fetchQuickBooksTaxPreferences(runtime, realmId, token);
  assert.equal("CompanyName" in info, false);
  assert.equal("UnrelatedSecret" in prefs, false);
});

it("uses the established bounded read retry on transient failures without writes", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls += 1;
    assert.equal(init?.method ?? "GET", "GET");
    if (calls === 1) return new Response("synthetic temporary failure", { status: 503, headers: { "Retry-After": "0" } });
    return new Response(JSON.stringify(url.endsWith("/preferences") ? preferences() : company()), { status: 200 });
  });
  const report = await inspectQuickBooksTaxCapabilities({ ...runtime, QUICKBOOKS_PROVIDER_READ_RETRIES: 1 }, realmId, token);
  assert.equal(report.companyPrerequisitesReady, true);
  assert.equal(calls, 3);
});
