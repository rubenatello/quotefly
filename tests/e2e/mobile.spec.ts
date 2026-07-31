import { expect, test } from "@playwright/test";
import {
  addSessionCookie,
  createCustomerViaApi,
  createQuoteViaApi,
  getQuoteViaApi,
  signUpViaApi,
} from "./helpers";

test.describe("mobile launch smoke", () => {
  test("customer and quote surfaces render on mobile viewport", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "mobile");
    const customer = await createCustomerViaApi(request, account, {
      fullName: "Mobile Beta Customer",
      phone: "555-013-9900",
      email: "mobile-beta@example.com",
    });
    const quote = await createQuoteViaApi(request, account, customer.id, {
      title: "Mobile Roof Leak Smoke",
    });

    await addSessionCookie(context, account);

    await page.goto("/app/customers");
    await expect(page.getByRole("heading", { level: 1, name: "Customers", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Mobile Beta Customer").filter({ visible: true })).toBeVisible();

    const mobileMenu = page.getByRole("button", { name: "Open navigation" });
    await mobileMenu.click();
    const mobileDrawer = page.getByRole("dialog", { name: "Workspace navigation" });
    const closeMobileMenu = mobileDrawer.getByRole("button", { name: "Close navigation" });
    await expect(closeMobileMenu).toBeFocused();
    const firstDrawerAction = mobileDrawer.getByRole("button", { name: "Go to customers" });
    await firstDrawerAction.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(mobileDrawer.getByRole("button", { name: "Sign out" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(firstDrawerAction).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(mobileDrawer).toHaveCount(0);
    await expect(mobileMenu).toBeFocused();

    await mobileMenu.click();
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("hidden");
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
    await page.setViewportSize({ width: 390, height: 844 });

    const quickQuote = page.getByTestId("mobile-quick-quote");
    await expect(quickQuote).toBeVisible();
    await expect(quickQuote).toHaveAttribute("aria-label", "New quote");

    await page.getByRole("navigation", { name: "Mobile workspace" }).getByRole("button", { name: "Quotes", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Quotes", exact: true })).toBeVisible();
    await expect(page.getByText("Ready to send", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Waiting on reply", { exact: true })).toBeVisible();

    await quickQuote.click();
    await expect(page).toHaveURL(/\/app\/build$/);
    await expect(page.getByTestId("quote-builder")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Quick Quote" })).toBeVisible();
    await page.getByRole("textbox", { name: /find customer by name/i }).fill("Mobile Beta Customer");
    await expect(page.getByText("Mobile Beta Customer").filter({ visible: true })).toBeVisible();

    await page.getByRole("button", { name: "Add Customer" }).first().click();
    const quickCustomerDialog = page.getByRole("dialog", { name: /add customer fast/i });
    await expect(quickCustomerDialog.getByRole("button", { name: "Save + Build Quote" })).toBeVisible();
    await quickCustomerDialog.getByRole("button", { name: "Cancel" }).click();

    await page.goto(`/app/quotes/${quote.id}`);
    await expect(page.getByTestId("quote-desk")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "Mobile Roof Leak Smoke" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Preview" }).first()).toBeVisible();

    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("button", { name: "Download PDF" })).toBeVisible();

    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(page.url()).origin,
    });
    await page.getByRole("button", { name: "Copy Message" }).click();
    const sendDialog = page.getByRole("dialog", { name: "Send quote confirmation" });
    await sendDialog.getByRole("button", { name: "Copy Message" }).click();
    await expect(sendDialog.getByText(/has not changed the quote status yet/i)).toBeVisible();
    expect((await getQuoteViaApi(request, account, quote.id)).status).not.toBe("SENT_TO_CUSTOMER");

    await sendDialog.getByRole("button", { name: "Yes, Mark Sent" }).click();
    await expect(sendDialog).toBeHidden();
    await expect.poll(async () => (await getQuoteViaApi(request, account, quote.id)).status).toBe("SENT_TO_CUSTOMER");
  });
});
