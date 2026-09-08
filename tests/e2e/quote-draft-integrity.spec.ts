import { expect, test, type Locator } from "@playwright/test";
import {
  addSessionCookie,
  createCustomerViaApi,
  createQuoteViaApi,
  getQuoteViaApi,
  signUpViaApi,
} from "./helpers";

type PersistedLine = {
  description: string;
  quantity: number | string;
  unitCost: number | string;
  unitPrice: number | string;
};

function visibleLineField(row: Locator, accessibleName: string) {
  return row.locator(`[aria-label="${accessibleName}"]:visible`);
}

test("individual save and line insertion preserve other drafts through Save Quote and reload", async ({
  context,
  page,
  request,
}) => {
  // This workflow intentionally covers setup, two line mutations, an atomic
  // sheet save, API persistence polling, reload, and final UI verification.
  // Keep the assertions individually bounded while allowing the complete cold
  // Node/Docker path to finish instead of exhausting the global 45s budget.
  test.setTimeout(90_000);
  const account = await signUpViaApi(request, "quote-draft-integrity");
  const customer = await createCustomerViaApi(request, account);
  const quote = await createQuoteViaApi(request, account, customer.id, {
    title: "Draft Integrity Quote",
  });
  await addSessionCookie(context, account);

  await page.goto(`/app/quotes/${quote.id}`);
  await expect(page.getByTestId("quote-desk")).toBeVisible({ timeout: 30_000 });

  await page.getByLabel("Quote title").fill("Draft-safe revised title");
  await page.getByLabel("Quote overview").fill("Draft-safe revised customer scope");
  await page.getByLabel("Quote status").selectOption("READY_FOR_REVIEW");
  await page.getByLabel("Tax").fill("245");

  const firstRow = page.getByTestId("existing-quote-line-row-1");
  const secondRow = page.getByTestId("existing-quote-line-row-2");
  await visibleLineField(firstRow, "Existing line 1 description").fill("Saved first-row description");
  await visibleLineField(firstRow, "Existing line 1 quantity").fill("2");
  await visibleLineField(firstRow, "Existing line 1 price").fill("1275");
  await visibleLineField(secondRow, "Existing line 2 description").fill("Unsaved second-row description");
  await visibleLineField(secondRow, "Existing line 2 quantity").fill("3");
  await visibleLineField(secondRow, "Existing line 2 cost").fill("225");
  await visibleLineField(secondRow, "Existing line 2 price").fill("375");

  await firstRow.getByRole("button", { name: "Save line" }).click();
  await expect(firstRow.getByText("Unsaved")).toHaveCount(0);
  await expect(visibleLineField(secondRow, "Existing line 2 description")).toHaveValue("Unsaved second-row description");
  await expect(visibleLineField(secondRow, "Existing line 2 quantity")).toHaveValue("3");
  await expect(visibleLineField(secondRow, "Existing line 2 cost")).toHaveValue("225");
  await expect(visibleLineField(secondRow, "Existing line 2 price")).toHaveValue("375");
  await expect(page.getByLabel("Quote title")).toHaveValue("Draft-safe revised title");
  await expect(page.getByLabel("Quote overview")).toHaveValue("Draft-safe revised customer scope");
  await expect(page.getByLabel("Quote status")).toHaveValue("READY_FOR_REVIEW");
  await expect(page.getByLabel("Tax")).toHaveValue("245");

  const newRow = page.getByTestId("new-quote-line-row");
  await newRow.getByLabel("New line title").fill("Permit and haul-away");
  await newRow.getByLabel("New line description").fill("Permit coordination and final disposal");
  await newRow.getByLabel("New line quantity").fill("1");
  await newRow.getByLabel("New line cost").fill("90");
  await newRow.getByLabel("New line price").fill("180");
  await newRow.getByRole("button", { name: "Add line" }).click();
  await expect(page.getByTestId("existing-quote-line-row-3")).toBeVisible();
  await expect(visibleLineField(secondRow, "Existing line 2 description")).toHaveValue("Unsaved second-row description");
  await expect(visibleLineField(secondRow, "Existing line 2 quantity")).toHaveValue("3");
  await expect(visibleLineField(secondRow, "Existing line 2 cost")).toHaveValue("225");
  await expect(visibleLineField(secondRow, "Existing line 2 price")).toHaveValue("375");
  await expect(page.getByLabel("Quote title")).toHaveValue("Draft-safe revised title");
  await expect(page.getByLabel("Quote overview")).toHaveValue("Draft-safe revised customer scope");
  await expect(page.getByLabel("Quote status")).toHaveValue("READY_FOR_REVIEW");
  await expect(page.getByLabel("Tax")).toHaveValue("245");

  const presetDialog = page.getByRole("dialog", { name: "Save line as reusable work" });
  await presetDialog.getByRole("button", { name: "Not now", exact: true }).click();
  await page.getByRole("button", { name: "Save quote sheet", exact: true }).click();

  await expect
    .poll(async () => {
      const detail = (await getQuoteViaApi(request, account, quote.id)) as unknown as {
        title: string;
        scopeText: string;
        status: string;
        taxAmount: number | string;
        lineItems: PersistedLine[];
      };
      return {
        title: detail.title,
        scopeText: detail.scopeText,
        status: detail.status,
        taxAmount: Number(detail.taxAmount),
        lines: detail.lineItems.map((line) => ({
          description: line.description,
          quantity: Number(line.quantity),
          unitCost: Number(line.unitCost),
          unitPrice: Number(line.unitPrice),
        })),
      };
    })
    .toEqual({
      title: "Draft-safe revised title",
      scopeText: "Draft-safe revised customer scope",
      status: "READY_FOR_REVIEW",
      taxAmount: 245,
      lines: [
        {
          description: "Leak repair and flashing reset\nSaved first-row description",
          quantity: 2,
          unitCost: 520,
          unitPrice: 1275,
        },
        {
          description: "Cleanup and disposal\nUnsaved second-row description",
          quantity: 3,
          unitCost: 225,
          unitPrice: 375,
        },
        {
          description: "Permit and haul-away\nPermit coordination and final disposal",
          quantity: 1,
          unitCost: 90,
          unitPrice: 180,
        },
      ],
    });

  await page.reload();
  await expect(page.getByTestId("quote-desk")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Quote title")).toHaveValue("Draft-safe revised title");
  await expect(page.getByLabel("Quote overview")).toHaveValue("Draft-safe revised customer scope");
  await expect(page.getByLabel("Quote status")).toHaveValue("READY_FOR_REVIEW");
  await expect(page.getByLabel("Tax")).toHaveValue("245");
  await expect(visibleLineField(page.getByTestId("existing-quote-line-row-1"), "Existing line 1 description")).toHaveValue(
    "Saved first-row description",
  );
  await expect(visibleLineField(page.getByTestId("existing-quote-line-row-2"), "Existing line 2 description")).toHaveValue(
    "Unsaved second-row description",
  );
  await expect(visibleLineField(page.getByTestId("existing-quote-line-row-2"), "Existing line 2 quantity")).toHaveValue("3");
  await expect(visibleLineField(page.getByTestId("existing-quote-line-row-3"), "Existing line 3 title")).toHaveValue(
    "Permit and haul-away",
  );
  await expect(page).toHaveURL(new RegExp(`/app/quotes/${quote.id}$`));
});

test("failed line creation keeps every new-line field and does not offer to save a preset", async ({
  context,
  page,
  request,
}) => {
  const account = await signUpViaApi(request, "quote-line-create-failure");
  const customer = await createCustomerViaApi(request, account);
  const quote = await createQuoteViaApi(request, account, customer.id, { title: "Line Create Failure Quote" });
  await addSessionCookie(context, account);
  await page.goto(`/app/quotes/${quote.id}`);
  await expect(page.getByTestId("quote-desk")).toBeVisible({ timeout: 15_000 });

  let createRequests = 0;
  let submittedLine: Record<string, unknown> | null = null;
  await page.route("**/v1/quotes/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (route.request().method() === "POST" && requestUrl.pathname === `/v1/quotes/${quote.id}/line-items`) {
      createRequests += 1;
      submittedLine = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "The line could not be added right now. Your draft is still here." }),
      });
      return;
    }
    await route.continue();
  });

  const newRow = page.getByTestId("new-quote-line-row");
  await newRow.getByLabel("New line title").fill("Alternate premium material");
  await newRow.getByLabel("New line description").fill("Premium color and extended material warranty");
  await newRow.getByLabel("New line quantity").fill("7");
  await newRow.getByLabel("New line cost").fill("42.5");
  await newRow.getByLabel("New line price").fill("79.25");
  await newRow.getByLabel("Line type").selectOption("ALTERNATE");
  await newRow.getByLabel("Option label").fill("Premium option");
  await newRow.getByRole("button", { name: "Add line" }).click();

  await expect.poll(() => createRequests).toBe(1);
  expect(submittedLine).toMatchObject({
    description: "Alternate premium material\nPremium color and extended material warranty",
    sectionType: "ALTERNATE",
    sectionLabel: "Premium option",
    quantity: 7,
    unitCost: 42.5,
    unitPrice: 79.25,
  });
  await expect(page.getByRole("alert")).toContainText("QuoteFly could not complete this action right now. Try again in a moment.");
  await expect(newRow.getByLabel("New line title")).toHaveValue("Alternate premium material");
  await expect(newRow.getByLabel("New line description")).toHaveValue("Premium color and extended material warranty");
  await expect(newRow.getByLabel("New line quantity")).toHaveValue("7");
  await expect(newRow.getByLabel("New line cost")).toHaveValue("42.5");
  await expect(newRow.getByLabel("New line price")).toHaveValue("79.25");
  await expect(newRow.getByLabel("Line type")).toHaveValue("ALTERNATE");
  await expect(newRow.getByLabel("Option label")).toHaveValue("Premium option");
  await expect(page.getByRole("dialog", { name: "Save line as reusable work" })).toHaveCount(0);
});

test("failed atomic quote-sheet save retains metadata and line drafts", async ({
  context,
  page,
  request,
}) => {
  const account = await signUpViaApi(request, "quote-metadata-failure");
  const customer = await createCustomerViaApi(request, account);
  const quote = await createQuoteViaApi(request, account, customer.id, { title: "Metadata Failure Quote" });
  await addSessionCookie(context, account);
  await page.goto(`/app/quotes/${quote.id}`);
  await expect(page.getByTestId("quote-desk")).toBeVisible({ timeout: 15_000 });

  let quoteSheetRequests = 0;
  await page.route("**/v1/quotes/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (route.request().method() === "PATCH" && requestUrl.pathname === `/v1/quotes/${quote.id}/sheet`) {
      quoteSheetRequests += 1;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Quote changes were not saved. Your draft is ready to retry." }),
      });
      return;
    }
    await route.continue();
  });

  await page.getByLabel("Quote title").fill("Metadata failure draft title");
  await page.getByLabel("Quote overview").fill("Metadata failure draft overview");
  await page.getByLabel("Tax").fill("333");
  const firstRow = page.getByTestId("existing-quote-line-row-1");
  await visibleLineField(firstRow, "Existing line 1 description").fill("Line draft must not be sent after metadata failure");
  const newRow = page.getByTestId("new-quote-line-row");
  await newRow.getByLabel("New line title").fill("Unsubmitted new-line draft");
  await newRow.getByLabel("New line description").fill("Keep this new-line text too");

  await page.getByRole("button", { name: "Save quote sheet", exact: true }).click();

  await expect.poll(() => quoteSheetRequests).toBe(1);
  await expect(page.getByRole("alert")).toContainText("QuoteFly could not complete this action right now. Try again in a moment.");
  await expect(page.getByText("Quote updated.")).toHaveCount(0);
  await expect(page.getByLabel("Quote title")).toHaveValue("Metadata failure draft title");
  await expect(page.getByLabel("Quote overview")).toHaveValue("Metadata failure draft overview");
  await expect(page.getByLabel("Tax")).toHaveValue("333");
  await expect(visibleLineField(firstRow, "Existing line 1 description")).toHaveValue(
    "Line draft must not be sent after metadata failure",
  );
  await expect(newRow.getByLabel("New line title")).toHaveValue("Unsubmitted new-line draft");
  await expect(newRow.getByLabel("New line description")).toHaveValue("Keep this new-line text too");
});
