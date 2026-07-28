import { expect, test } from "@playwright/test";
import {
  addSessionCookie,
  createCustomerViaApi,
  createQuoteViaApi,
  signUpViaApi,
} from "./helpers";

test("mobile line save keeps a second expanded row draft and field actions remain tappable", async ({
  context,
  page,
  request,
}) => {
  const account = await signUpViaApi(request, "mobile-draft-integrity");
  const customer = await createCustomerViaApi(request, account);
  const quote = await createQuoteViaApi(request, account, customer.id, {
    title: "Mobile Draft Integrity Quote",
  });
  await addSessionCookie(context, account);

  await page.goto(`/app/quotes/${quote.id}`);
  await expect(page.getByTestId("quote-desk")).toBeVisible({ timeout: 15_000 });

  const firstRow = page.getByTestId("existing-quote-line-row-1");
  const secondRow = page.getByTestId("existing-quote-line-row-2");
  await firstRow.getByRole("button").first().click();
  await secondRow.getByRole("button").first().click();
  const firstDescription = firstRow.locator('[aria-label="Existing line 1 description"]:visible');
  const secondDescription = secondRow.locator('[aria-label="Existing line 2 description"]:visible');
  const secondQuantity = secondRow.locator('[aria-label="Existing line 2 quantity"]:visible');
  await firstDescription.fill("Mobile saved description");
  await secondDescription.fill("Mobile unsaved description");
  await secondQuantity.fill("4");

  const saveButton = firstRow.getByRole("button", { name: "Save", exact: true });
  expect((await saveButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await saveButton.click();

  await expect(secondDescription).toHaveValue("Mobile unsaved description");
  await expect(secondQuantity).toHaveValue("4");
  await expect(page).toHaveURL(new RegExp(`/app/quotes/${quote.id}$`));
});
