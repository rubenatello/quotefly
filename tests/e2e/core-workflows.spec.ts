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
    test.setTimeout(90_000);
    const account = await signUpViaApi(request, "core");
    await addSessionCookie(context, account);
    await page.goto("/app/customers");

    await expect(page.getByRole("heading", { level: 1, name: "Customers", exact: true })).toBeVisible({ timeout: 15_000 });
    await expectNoFrontendJwtStorage(page);

    const customerLabel = uniqueRunLabel("field");
    const customerName = `Field Beta ${customerLabel}`;
    const updatedCustomerName = `${customerName} Updated`;
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

    await page.getByText(customerName).filter({ visible: true }).first().click();
    const customerWorkspaceDialog = page.getByRole("dialog", { name: "Customer activity history" });
    await expect(customerWorkspaceDialog.getByText("Customer details", { exact: true })).toBeVisible();
    await expect(customerWorkspaceDialog.getByRole("button", { name: "Save details" })).toBeDisabled();

    await customerWorkspaceDialog.getByLabel("Email").fill("not-an-email");
    await customerWorkspaceDialog.getByRole("button", { name: "Save details" }).click();
    await expect(customerWorkspaceDialog.getByRole("alert")).toContainText(/email|invalid/i);

    await customerWorkspaceDialog.getByLabel("Name").fill(updatedCustomerName);
    await customerWorkspaceDialog.getByLabel("Email").fill(customerEmail);
    await customerWorkspaceDialog.getByRole("button", { name: "Save details" }).click();
    await expect(customerWorkspaceDialog.getByText("Customer details saved.", { exact: true })).toBeVisible();
    await customerWorkspaceDialog.getByRole("button", { name: "Close" }).last().click();

    await expect(page.getByText(updatedCustomerName).filter({ visible: true })).toBeVisible();
    await page.getByText(updatedCustomerName).filter({ visible: true }).first().click();
    await expect(customerWorkspaceDialog.getByLabel("Name")).toHaveValue(updatedCustomerName);
    await customerWorkspaceDialog.getByRole("button", { name: "Close" }).last().click();

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
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 20_000 });
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

    await page.getByRole("button", { name: "Send", exact: true }).click();
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

  test("tablet boards do not clip and invalid analytics ranges suppress metrics", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "tablet-range");
    const customer = await createCustomerViaApi(request, account);
    const quote = await createQuoteViaApi(request, account, customer.id);
    const rejectedResponse = await request.patch(`${apiBaseUrl}/v1/quotes/${quote.id}`, {
      headers: { Cookie: account.cookieHeader },
      data: { status: "REJECTED" },
    });
    expect(rejectedResponse.ok()).toBeTruthy();

    await addSessionCookie(context, account);
    await page.setViewportSize({ width: 1024, height: 768 });

    for (const route of ["/app/customers", "/app/quotes"]) {
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
        .toBe(true);
      if (route === "/app/customers") {
        await expect(page.getByText("Lost", { exact: true }).filter({ visible: true }).first()).toBeVisible();
      }
    }

    await page.goto("/app/analytics");
    await expect(page.getByRole("heading", { level: 1, name: "Analytics" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Custom", exact: true }).click();
    await page.getByLabel("Start date").fill("");
    await expect(page.getByRole("alert")).toContainText(/analytics are hidden/i);
    await expect(page.getByText("Quotes in range", { exact: true })).toHaveCount(0);

    await page.getByLabel("Start date").fill("2026-07-30");
    await page.getByLabel("End date").fill("2026-07-29");
    await expect(page.getByRole("alert")).toContainText(/end date must be on or after/i);
    await expect(page.getByText("Quotes in range", { exact: true })).toHaveCount(0);

    await page.getByLabel("End date").fill("2026-07-30");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByText("Quotes in range", { exact: true })).toBeVisible();
  });
});
