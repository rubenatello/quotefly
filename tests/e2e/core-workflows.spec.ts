import { expect, test } from "@playwright/test";
import {
  addSessionCookie,
  apiBaseUrl,
  createCustomerViaApi,
  createQuoteViaApi,
  escapeRegExp,
  getQuoteViaApi,
  expectNoFrontendJwtStorage,
  expectPdfResponseSucceeds,
  signUpViaApi,
  uniqueRunLabel,
} from "./helpers";

test.describe("controlled beta core workflow", () => {
  test("customer intake, duplicate warning, quote creation, PDF, status, and send log work end to end", async ({
    context,
    page,
    request,
  }) => {
    const account = await signUpViaApi(request, "core");
    await addSessionCookie(context, account);
    await page.goto("/app/customers");

    await expect(page.getByRole("heading", { level: 1, name: "Customers", exact: true })).toBeVisible({ timeout: 15_000 });
    await expectNoFrontendJwtStorage(page);

    const customerLabel = uniqueRunLabel("field");
    const customerName = `Field Beta ${customerLabel}`;
    const customerPhone = "555-012-3400";
    const customerEmail = `${customerLabel}@example.com`;

    await page.getByRole("button", { name: "Add Customer" }).first().click();
    const customerDialog = page.getByRole("dialog", { name: /add customer fast/i });
    await customerDialog.getByLabel("Full name").fill(customerName);
    await customerDialog.getByLabel("Phone").fill(customerPhone);
    await customerDialog.getByLabel("Email").fill(customerEmail);
    await customerDialog.getByLabel("Customer notes").fill("Gate code 1204. Prefers text follow-up.");
    await customerDialog.getByRole("button", { name: "Save Customer" }).click();

    await expect(customerDialog).toBeHidden();
    await expect(page.getByText(customerName).filter({ visible: true })).toBeVisible();

    await page.getByPlaceholder(/search customer name/i).fill(customerName);
    await expect(page.getByText(customerEmail).filter({ visible: true })).toBeVisible();

    await page.getByPlaceholder(/search customer name/i).clear();
    await page.getByRole("button", { name: "Add Customer" }).first().click();
    const duplicateDialog = page.getByRole("dialog", { name: /add customer fast/i });
    await duplicateDialog.getByLabel("Full name").fill(`${customerName} Duplicate`);
    await duplicateDialog.getByLabel("Phone").fill(customerPhone);
    await duplicateDialog.getByLabel("Email").fill(`duplicate-${customerEmail}`);
    await duplicateDialog.getByRole("button", { name: "Save Customer" }).click();
    await expect(duplicateDialog.getByText(/exact phone match found/i)).toBeVisible();
    await duplicateDialog.getByRole("button", { name: "Cancel" }).click();

    await page.goto("/app/build");
    await expect(page.getByTestId("quote-builder")).toBeVisible();
    await page.getByRole("textbox", { name: /find customer by name/i }).fill(customerName);
    await page
      .getByRole("button", { name: new RegExp(`${escapeRegExp(customerName)}[\\s\\S]*Use`, "i") })
      .click();

    const quoteTitle = `Beta Condenser Replacement ${uniqueRunLabel("quote")}`;
    await page.getByLabel("Quote title").fill(quoteTitle);
    await page.getByLabel("Quote overview").fill("Replace failed condenser, reconnect refrigerant, test startup, and clean the area.");
    const firstLine = page.getByTestId("quote-line-row-1");
    await firstLine.getByLabel("Line 1 title").last().fill("Condenser replacement");
    await firstLine
      .getByLabel("Line 1 description")
      .last()
      .fill("Install outdoor condenser, reconnect existing lines, and run startup testing.");
    await firstLine.getByLabel("Line 1 quantity").last().fill("1");
    await firstLine.getByLabel("Line 1 cost").last().fill("820");
    await firstLine.getByLabel("Line 1 price").last().fill("1525");

    await page.getByRole("button", { name: "Create Quote" }).first().click();
    await expect(page).toHaveURL(/\/app\/quotes\/[^/]+$/);
    await expect(page.getByTestId("quote-desk")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: quoteTitle })).toBeVisible();

    const quoteId = page.url().match(/\/app\/quotes\/([^/?#]+)/)?.[1];
    expect(quoteId).toBeTruthy();

    await expectPdfResponseSucceeds(request, account, quoteId!);

    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Email App" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Text App" })).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download PDF" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
    await expect(page.getByText(/pdf downloaded/i)).toBeVisible();

    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(page.url()).origin,
    });
    await page.getByRole("button", { name: "Copy Message" }).click();
    const sendDialog = page.getByRole("dialog", { name: "Send quote confirmation" });
    await sendDialog.getByRole("button", { name: "Cancel" }).click();
    expect((await getQuoteViaApi(request, account, quoteId!)).status).not.toBe("SENT_TO_CUSTOMER");

    await page.getByRole("button", { name: "Copy Message" }).click();
    await sendDialog.getByRole("button", { name: "Copy Message" }).click();
    await expect(sendDialog.getByText(/has not changed the quote status yet/i)).toBeVisible();
    expect((await getQuoteViaApi(request, account, quoteId!)).status).not.toBe("SENT_TO_CUSTOMER");

    await sendDialog.getByRole("button", { name: "Yes, Mark Sent" }).click();
    await expect(sendDialog).toBeHidden();
    await expect.poll(async () => (await getQuoteViaApi(request, account, quoteId!)).status).toBe("SENT_TO_CUSTOMER");

    await page.getByRole("button", { name: "Send Log" }).click();
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.getByText("Copy", { exact: true })).toBeVisible();

    const meResponse = await request.get(`${apiBaseUrl}/v1/auth/me`, {
      headers: { Cookie: account.cookieHeader },
    });
    expect(meResponse.status()).toBe(200);
  });

  test("API-seeded quote data opens in the quote desk", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "seeded");
    const customer = await createCustomerViaApi(request, account);
    const quote = await createQuoteViaApi(request, account, customer.id);

    await addSessionCookie(context, account);
    await page.goto(`/app/quotes/${quote.id}`);

    await expect(page.getByTestId("quote-desk")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: quote.title })).toBeVisible();
    await expect(page.getByTestId("existing-quote-line-row-1")).toBeVisible();
  });
});
