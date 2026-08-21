import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ROOT = new URL("../src/", import.meta.url);
const OWNED_SCREENS = [
  "pages/CustomersPage.tsx",
  "components/customers/QuickCustomerModal.tsx",
  "pages/QuotesPage.tsx",
  "pages/ProductsPage.tsx",
  "pages/SetupPage.tsx",
];

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, ROOT), "utf8");
}

test("core CRM screens subscribe to locale changes", () => {
  for (const relativePath of OWNED_SCREENS) {
    const contents = source(relativePath);
    assert.match(contents, /useTranslation\(\)/, `${relativePath} must rerender when the active language changes`);
  }
});

test("core CRM screens use centralized domain labels instead of exposing backend enums", () => {
  for (const relativePath of ["pages/CustomersPage.tsx", "pages/QuotesPage.tsx", "pages/ProductsPage.tsx", "pages/SetupPage.tsx"]) {
    const contents = source(relativePath);
    assert.doesNotMatch(contents, /replaceAll\("_",\s*" "\)/, `${relativePath} must not humanize raw backend enums`);
  }

  assert.match(source("pages/CustomersPage.tsx"), /domain\.customerStage/);
  assert.match(source("pages/QuotesPage.tsx"), /domain\.quoteStage/);
  assert.match(source("pages/ProductsPage.tsx"), /domain\.category/);
  assert.match(source("pages/SetupPage.tsx"), /domain\.unit/);
});

test("core CRM locale-sensitive money and customer dates do not force English", () => {
  assert.doesNotMatch(source("pages/ProductsPage.tsx"), /Intl\.NumberFormat\("en-US"/);
  assert.match(source("pages/CustomersPage.tsx"), /timeZone:\s*session\.timezone/);
  assert.match(source("pages/QuotesPage.tsx"), /money\(awaitingAmount, locale\)/);
});

test("high-value CRM UI copy is translated rather than embedded in JSX props", () => {
  const forbidden = /(?:title|subtitle|description|label|placeholder|aria-label|confirmLabel|ariaLabel)="(?:Customers|Quotes|Products|Workspace setup|Add customer|Add product|Search|Archive|Delete|Save|Loading)/;
  for (const relativePath of OWNED_SCREENS) {
    assert.doesNotMatch(source(relativePath), forbidden, `${relativePath} contains untranslated product copy`);
  }
});

test("customer activity uses stable event codes without translating tenant-authored notes", () => {
  const customers = source("pages/CustomersPage.tsx");
  assert.match(customers, /function activityDisplay/);
  assert.match(customers, /item\.eventType === "NOTES_ADDED"/);
  assert.match(customers, /item\.detail \|\| t\("customers\.activity\.recorded"\)/);
  assert.doesNotMatch(customers, />\{item\.title\}</);
  assert.doesNotMatch(customers, />\{item\.detail/);
});
