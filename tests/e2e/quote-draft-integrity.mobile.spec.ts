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
  await firstRow.getByLabel("Existing line 1 description").fill("Mobile saved description");
  await secondRow.getByLabel("Existing line 2 description").fill("Mobile unsaved description");
  await secondRow.getByLabel("Existing line 2 quantity").fill("4");

  const saveButton = firstRow.getByRole("button", { name: "Save" });
  expect((await saveButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await saveButton.click();

  await expect(secondRow.getByLabel("Existing line 2 description")).toHaveValue("Mobile unsaved description");
  await expect(secondRow.getByLabel("Existing line 2 quantity")).toHaveValue("4");
  await expect(page).toHaveURL(new RegExp(`/app/quotes/${quote.id}$`));
});
