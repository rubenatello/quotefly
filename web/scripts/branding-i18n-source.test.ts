import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { enUS } from "../src/i18n/locales/en-US";
import { esUS } from "../src/i18n/locales/es-US";

const pagePath = new URL("../src/pages/BrandingPage.tsx", import.meta.url);
const quickSetupPath = new URL("../src/components/branding/BrandQuickSetup.tsx", import.meta.url);

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return prefix ? [prefix] : [];
  return Object.entries(value).flatMap(([key, nested]) => flattenKeys(nested, prefix ? `${prefix}.${key}` : key));
}

test("branding English and Spanish resources have exact key parity", () => {
  assert.deepEqual(flattenKeys(enUS.branding).sort(), flattenKeys(esUS.branding).sort());
});

test("branding page and quick setup use locale-backed product copy", async () => {
  const [page, quickSetup] = await Promise.all([
    readFile(pagePath, "utf8"),
    readFile(quickSetupPath, "utf8"),
  ]);

  assert.match(page, /useTranslation\(\)/);
  assert.match(quickSetup, /useTranslation\(\)/);
  assert.match(page, /t\("branding\.business\.defaultLanguage"\)/);
  assert.match(quickSetup, /t\("branding\.quick\.templateTitle"\)/);
  assert.doesNotMatch(page, />Quote Branding<|>Business Info<|>Choose Logo<|>Save Branding</);
  assert.doesNotMatch(quickSetup, />Start here<|>Add your logo<|>Choose your brand color<|>View Full Preview</);
});

test("branding preserves tenant-authored values and permission rules", async () => {
  const page = await readFile(pagePath, "utf8");

  assert.match(page, /value=\{companyName\}/);
  assert.match(page, /value=\{businessProfile\.quoteMessageTemplate \?\? ""\}/);
  assert.match(page, /businessName=\{companyName\}/);
  assert.match(page, /disabled=\{!canEditBusinessName\}/);
  assert.match(page, /\.\.\.\(canEditBusinessName \? \{ businessName: companyName\.trim\(\) \} : \{\}\)/);
});

test("branding preview honors document locale, tenant timezone, and mobile controls", async () => {
  const [page, quickSetup] = await Promise.all([
    readFile(pagePath, "utf8"),
    readFile(quickSetupPath, "utf8"),
  ]);

  assert.match(page, /new Intl\.DateTimeFormat\(locale/);
  assert.match(page, /timeZone \}\)\.format\(date\)/);
  assert.match(page, /documentLocale=\{defaultCustomerLocale\}/);
  assert.match(page, /i18n\.getFixedT\(defaultCustomerLocale\)/);
  assert.match(page, /<WorkflowActionDock/);
  assert.match(page, /min-h-11/);
  assert.match(quickSetup, /min-h-11/);
});

test("branding errors are localized before they reach the interface", async () => {
  const page = await readFile(pagePath, "utf8");

  assert.match(page, /setLoadErrorMessage\(t\("branding\.loadFallback"\)\)/);
  assert.match(page, /setSaveErrorMessage\(t\("branding\.saveFallback"\)\)/);
  assert.match(page, /setSaveErrorMessage\(t\("branding\.logoSection\.processFailed"\)\)/);
  assert.doesNotMatch(page, /set(?:Load|Save)ErrorMessage\([^\n]*\.message/);
});
