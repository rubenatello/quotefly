import { expect, test } from "@playwright/test";
import { addSessionCookie, createCustomerViaApi, escapeRegExp, signUpViaApi } from "./helpers";

test("Pixel builder autosaves across bottom navigation and restores quick-customer fields after refresh", async ({
  context,
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const account = await signUpViaApi(request, "mobile-builder-draft");
  const customer = await createCustomerViaApi(request, account, { fullName: "Mobile Draft Customer" });
  await addSessionCookie(context, account);
  await page.goto("/app/build");
  await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });

  await page.getByRole("textbox", { name: /find customer by name/i }).fill(customer.fullName);
  await page
    .getByRole("button", { name: new RegExp(`${escapeRegExp(customer.fullName)}[\\s\\S]*Use`, "i") })
    .click();

  await page.getByLabel("Quote title").fill("Mobile navigation-safe draft");
  await page.getByRole("button", { name: "Show details" }).click();
  await page.getByLabel("Quote overview").fill("Keep this mobile scope across navigation and refresh.");
  const firstRow = page.getByTestId("quote-line-row-1");
  await firstRow.locator('[aria-label="Line 1 title"]:visible').fill("Mobile saved line");
  await firstRow.locator('[aria-label="Line 1 quantity"]:visible').fill("2");
  await firstRow.locator('[aria-label="Line 1 price"]:visible').fill("325");
  await page.getByRole("button", { name: "Review quote", exact: true }).click();
  const backToEdit = page.getByRole("button", { name: "Back", exact: true });
  await expect(backToEdit).toBeVisible();
  await backToEdit.click();

  await page.getByRole("button", { name: "Add Customer" }).first().click();
  const customerDialog = page.getByRole("dialog", { name: /add customer fast/i });
  await customerDialog.getByLabel("Full name").fill("Unsubmitted Mobile Customer");
  await customerDialog.getByLabel("Phone").fill("555-010-9876");
  await customerDialog.getByLabel("Email").fill("mobile-draft@example.com");
  await customerDialog.getByLabel("Customer notes").fill("Gate code survives refresh.");
  await expect(page.getByTestId("quote-builder-draft-status")).toContainText("Draft autosaved");

  await page.reload();
  await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
  const restoredDialog = page.getByRole("dialog", { name: /add customer fast/i });
  await expect(restoredDialog).toBeVisible();
  await expect(restoredDialog.getByLabel("Full name")).toHaveValue("Unsubmitted Mobile Customer");
  await expect(restoredDialog.getByLabel("Phone")).toHaveValue("(555) 010-9876");
  await expect(restoredDialog.getByLabel("Email")).toHaveValue("mobile-draft@example.com");
  await expect(restoredDialog.getByLabel("Customer notes")).toHaveValue("Gate code survives refresh.");
  page.once("dialog", (dialog) => dialog.accept());
  await restoredDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(restoredDialog).toBeHidden();
  const backAfterReload = page.getByRole("button", { name: "Back", exact: true });
  if (await backAfterReload.isVisible()) await backAfterReload.click();

  await page.getByRole("navigation", { name: "Mobile workspace" }).getByRole("button", { name: "Customers", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/customers/);
  await page.getByTestId("mobile-quick-quote").click();
  await expect(page).toHaveURL(/\/app\/build$/);
  await expect(page.getByTestId("quote-builder-draft-status")).toContainText("Draft restored");
  const restoredBackToEdit = page.getByRole("button", { name: "Back", exact: true });
  if (await restoredBackToEdit.isVisible()) await restoredBackToEdit.click();
  await expect(page.getByLabel("Quote title")).toHaveValue("Mobile navigation-safe draft");
  await expect(page.getByLabel("Quote overview")).toHaveValue("Keep this mobile scope across navigation and refresh.");
  const restoredFirstRow = page.getByTestId("quote-line-row-1");
  await restoredFirstRow.getByRole("button").first().click();
  await expect(restoredFirstRow.locator('[aria-label="Line 1 title"]:visible')).toHaveValue("Mobile saved line");
  await expect(restoredFirstRow.locator('[aria-label="Line 1 quantity"]:visible')).toHaveValue("2");

  const startOver = page.getByRole("button", { name: "Discard saved quote draft and start over" });
  expect((await startOver.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await startOver.click();
  const discardGroup = page.getByRole("group", { name: "Confirm discard saved quote draft" });
  const keepDraft = discardGroup.getByRole("button", { name: "Keep Draft" });
  await expect(keepDraft).toBeFocused();
  await expect(discardGroup.getByRole("button", { name: "Discard Draft" })).toBeVisible();
});
