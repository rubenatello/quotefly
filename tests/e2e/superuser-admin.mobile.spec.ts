import { expect, test } from "@playwright/test";
import { addSessionCookie, signUpViaApi } from "./helpers";

test("superuser data-governance console is usable at a mobile app viewport", async ({ context, page, request }) => {
  const account = await signUpViaApi(
    request,
    "superuser-mobile",
    "superuser-e2e@example.com",
  );
  await addSessionCookie(context, account);

  await page.goto("/app/internal/admin");
  await expect(page.getByRole("heading", { level: 1, name: "QuoteFly operator console" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/read-only governance mode/i)).toBeVisible();
  await expect(page.getByText("Schema matches reviewed baseline", { exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1);

  const sectionNav = page.getByRole("navigation", { name: "Operator console sections" });
  for (const label of ["Overview", "Tenants", "Data explorer", "Permissions", "Validation", "Audit"]) {
    const tab = sectionNav.getByRole("button", { name: label, exact: true });
    await expect(tab).toBeVisible();
    expect((await tab.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }

  await sectionNav.getByRole("button", { name: "Data explorer", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Data classification explorer" })).toBeVisible();
  await expect(page.getByText("Customer.notes", { exact: true })).toBeVisible();
  await expect(page.getByText("RAG Eligible", { exact: true }).first()).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1);

  await sectionNav.getByRole("button", { name: "Permissions", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Workspace role policy" })).toBeVisible();
  await expect(page.getByText("viewRawTenantRows", { exact: true })).toBeVisible();
  await expect(page.getByText("Disabled", { exact: true }).first()).toBeVisible();

  await sectionNav.getByRole("button", { name: "Validation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Schema validation" })).toBeVisible();
  await page.getByRole("button", { name: "Run validation", exact: true }).click();
  await expect(page.getByText(/validation passed for 28 models and 376 fields/i)).toBeVisible();
  await expect(page.getByText("PASSED", { exact: true }).first()).toBeVisible();
});
