import { expect, test, type Locator } from "@playwright/test";
import {
  addSessionCookie,
  createCustomerViaApi,
  createQuoteViaApi,
  getQuoteViaApi,
  signUpViaApi,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("qf_locale", "en-US"));
});

async function expectScreenReaderOnlyText(
  locator: Locator,
) {
  await expect(locator).toHaveClass(/sr-only/);
  await expect(locator).toHaveCSS("position", "absolute");
  await expect(locator).toHaveCSS("width", "1px");
  await expect(locator).toHaveCSS("height", "1px");
}

test.describe("mobile launch smoke", () => {
  test("confirmation and action notifications stay usable on a phone", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "mobile-confirmation");
    const customer = await createCustomerViaApi(request, account, {
      fullName: "Mobile Confirmation Customer",
      phone: "555-014-1100",
      email: "mobile-confirmation@example.com",
    });

    await addSessionCookie(context, account);
    await page.goto("/app/customers");
    const openCustomerDetails = page.getByRole("button", { name: `Open ${customer.fullName} details`, exact: true });
    await expect(openCustomerDetails).toBeVisible({ timeout: 20_000 });
    await openCustomerDetails.click();

    const customerDialog = page.getByRole("dialog", { name: "Customer details", exact: true });
    await customerDialog.getByRole("button", { name: "Archive", exact: true }).click();

    const confirmation = page.getByRole("dialog", { name: "Archive customer?" });
    const confirmButton = confirmation.getByRole("button", { name: "Archive customer" });
    const cancelButton = confirmation.getByRole("button", { name: "Cancel" });
    await expect(confirmation).toBeVisible();
    const confirmationBox = await confirmation.boundingBox();
    const mobileViewport = page.viewportSize();
    expect(confirmationBox?.width).toBeGreaterThanOrEqual((mobileViewport?.width ?? 0) - 1);
    expect((confirmationBox?.y ?? 0) + (confirmationBox?.height ?? 0)).toBeGreaterThanOrEqual((mobileViewport?.height ?? 0) - 1);
    expect((await confirmButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    expect((await cancelButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await expect(confirmButton).toHaveCSS("width", await cancelButton.evaluate((button) => getComputedStyle(button).width));

    await cancelButton.click();
    await expect(confirmation).toBeHidden();
    await expect(customerDialog).toBeVisible();

    await customerDialog.getByRole("button", { name: "Archive", exact: true }).click();
    await page.route(`**/v1/customers/${customer.id}/archive`, async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Archive is temporarily unavailable." }),
      });
    });
    await confirmButton.click();

    const failedToast = page.locator('[data-sonner-toast][data-type="error"]');
    await expect(
      failedToast.getByText("That customer status change could not be completed.", { exact: true }),
    ).toBeVisible();
    await expect(failedToast).toContainText("QuoteFly could not complete this action right now. Try again in a moment.");
    await expect(confirmation).toBeVisible();
    expect((await failedToast.getByRole("button", { name: "Dismiss notification" }).boundingBox())?.height).toBeGreaterThanOrEqual(43.5);

    await page.unroute(`**/v1/customers/${customer.id}/archive`);
    await confirmButton.click();

    const successToast = page.locator('[data-sonner-toast][data-type="success"]');
    await expect(successToast.getByText("Customer archived.", { exact: true })).toBeVisible();
    await expect(successToast).toContainText("This customer will leave the active workspace but remain retained in the database and audit history.");
    await expect(confirmation).toBeHidden();

    await page.getByRole("button", { name: "Add customer" }).first().click();
    const quickCustomerDialog = page.getByRole("dialog", { name: "Add customer fast" });
    const saveCustomerButton = quickCustomerDialog.getByRole("button", { name: "Save customer", exact: true });
    const buildQuoteButton = quickCustomerDialog.getByRole("button", { name: "Save + build quote", exact: true });
    await expect(saveCustomerButton).toHaveCSS("width", await buildQuoteButton.evaluate((button) => getComputedStyle(button).width));
    expect((await saveCustomerButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await quickCustomerDialog.getByLabel("Full name").fill("Unsaved mobile customer");
    await quickCustomerDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    const discardConfirmation = page.getByRole("dialog", { name: "Discard unsaved customer?" });
    await expect(discardConfirmation).toBeVisible();
    await discardConfirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(quickCustomerDialog).toBeVisible();
    await quickCustomerDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await discardConfirmation.getByRole("button", { name: "Discard changes" }).click();
    await expect(quickCustomerDialog).toBeHidden();

    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
      .toBeLessThanOrEqual(1);
  });

  test("customer and quote surfaces render on mobile viewport", async ({ context, page, request }) => {
    test.setTimeout(90_000);
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
    const trialBanner = page.getByRole("region", { name: "Trial and billing" });
    await expect(trialBanner).toContainText(/days? left/i);
    expect((await trialBanner.boundingBox())?.height).toBeLessThan(190);
    await expect(page.getByRole("button", { name: /choose basic/i })).toBeVisible();
    await expect(page.getByText("Mobile Beta Customer").filter({ visible: true })).toBeVisible();

    const mobileMenu = page.getByRole("button", { name: "Open navigation" });
    await mobileMenu.click();
    const mobileDrawer = page.getByRole("dialog", { name: "Workspace navigation" });
    const closeMobileMenu = mobileDrawer.getByRole("button", { name: "Close navigation" });
    await expect(closeMobileMenu).toBeFocused();
    const firstDrawerAction = mobileDrawer.getByRole("button", { name: "Go to workspace home" });
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
    const mobileWorkspace = page.getByRole("navigation", { name: "Mobile workspace" });
    await expect(quickQuote).toBeVisible();
    await expect(quickQuote).toHaveAttribute("aria-label", "New quote");
    await expectScreenReaderOnlyText(quickQuote.getByText("New quote", { exact: true }));
    for (const label of ["Home", "Customers", "Quotes", "Activity"]) {
      const tab = mobileWorkspace.getByRole("button", { name: label, exact: true });
      await expect(tab).toHaveAttribute("title", label);
      await expectScreenReaderOnlyText(tab.getByText(label, { exact: true }));
      expect((await tab.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }
    await expect(page.getByTestId("mobile-tab-customers")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("mobile-tab-customers-icon")).toHaveClass(/bg-\[var\(--qf-selected\)\]/);

    await mobileWorkspace.getByRole("button", { name: "Quotes", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Quotes", exact: true })).toBeVisible();
    await expect(page.getByTestId("mobile-tab-quotes")).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("button", { name: /^Ready to send\b/ })).toBeVisible();
    await expect(page.getByText("Waiting on response", { exact: true }).filter({ visible: true }).first()).toBeVisible();

    await quickQuote.click();
    await expect(page).toHaveURL(/\/app\/build$/);
    await expect(page.getByTestId("quote-builder")).toBeVisible();
    await page.getByRole("button", { name: "Draft quote with Kody" }).click();
    const builderKodyPanel = page.getByTestId("kody-chat-panel");
    await expect(builderKodyPanel).toHaveClass(/qf-kody-chat-panel--with-dock/);
    await builderKodyPanel.getByRole("button", { name: "Close Kody" }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
      .toBeLessThanOrEqual(1);
    const quickQuoteHeadingBox = await page.getByRole("heading", { level: 1, name: "Quick quote", exact: true }).boundingBox();
    expect(quickQuoteHeadingBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    await expect(page.locator("button button, [role=button] button")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Quick quote" })).toBeVisible();
    await page.getByRole("textbox", { name: "Find a customer", exact: true }).fill("Mobile Beta Customer");
    await expect(page.getByText("Mobile Beta Customer").filter({ visible: true })).toBeVisible();

    const addCustomerTrigger = page.getByRole("button", { name: "Add customer", exact: true }).first();
    await addCustomerTrigger.click();
    const quickCustomerDialog = page.getByRole("dialog", { name: /add customer fast/i });
    await expect(quickCustomerDialog.getByRole("button", { name: "Save + build quote", exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(quickCustomerDialog).toBeHidden();
    await expect(addCustomerTrigger).toBeVisible();

    await page.goto(`/app/quotes/${quote.id}`);
    await expect(page.getByTestId("quote-desk")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "Mobile Roof Leak Smoke" })).toBeVisible();
    const firstLineEditor = page.getByTestId("existing-quote-line-row-1");
    const firstLineToggle = firstLineEditor.getByRole("button").first();
    await expect(firstLineToggle).toHaveAttribute("aria-expanded", "false");
    expect((await firstLineToggle.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await firstLineToggle.click();
    await expect(firstLineToggle).toHaveAttribute("aria-expanded", "true");
    await expect(firstLineEditor.getByLabel("Existing line 1 title").filter({ visible: true })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
      .toBeLessThanOrEqual(1);
    await expect(page.getByRole("button", { name: "Preview" }).first()).toBeVisible();
    await page.getByRole("button", { name: "Preview" }).first().click();
    await expect(page.getByText("Internal subtotal", { exact: true }).filter({ visible: true })).toHaveCount(0);
    await expect(page.getByText("Est. profit", { exact: true }).filter({ visible: true })).toHaveCount(0);
    await expect(page.getByText("Margin", { exact: true }).filter({ visible: true })).toHaveCount(0);

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

    await page.getByRole("navigation", { name: "Mobile workspace" }).getByRole("button", { name: "Activity", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Activity", exact: true })).toBeVisible();
    await expect(page.locator("main").getByRole("button", { name: "New quote", exact: true, includeHidden: true })).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
      .toBeLessThanOrEqual(1);
    await page.getByRole("group", { name: "Activity views" }).getByRole("button", { name: "Lead queue", exact: true }).click();
    const queueTabs = page.getByTestId("follow-up-queue-tabs");
    await expect(queueTabs).toBeVisible();
    await expect
      .poll(() => queueTabs.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
    await page.getByRole("button", { name: /Quoted/ }).click();
    const quotedLeadRow = page.getByTestId("follow-up-queue-row").filter({ hasText: "Mobile Beta Customer" });
    await quotedLeadRow.getByText("Details and status", { exact: true }).click();
    const followUpSelect = quotedLeadRow.getByLabel("Update follow-up for Mobile Beta Customer").filter({ visible: true });
    const openFollowUpQuote = quotedLeadRow.getByRole("button", { name: "Open quote", exact: true }).filter({ visible: true });
    await expect(openFollowUpQuote).toBeVisible();
    const [rowBox, followUpBox, openQuoteBox] = await Promise.all([
      quotedLeadRow.boundingBox(),
      followUpSelect.boundingBox(),
      openFollowUpQuote.boundingBox(),
    ]);
    // The status control deliberately has its own full-width detail row, while
    // the quote action shares its row with call and email shortcuts. Assert the
    // actual mobile contract instead of forcing unrelated controls to match.
    expect(followUpBox?.height).toBeGreaterThanOrEqual(44);
    expect(openQuoteBox?.height).toBeGreaterThanOrEqual(44);
    expect(followUpBox?.x ?? -1).toBeGreaterThanOrEqual(rowBox?.x ?? 0);
    expect((followUpBox?.x ?? 0) + (followUpBox?.width ?? 0)).toBeLessThanOrEqual((rowBox?.x ?? 0) + (rowBox?.width ?? 0) + 1);
    expect(openQuoteBox?.x ?? -1).toBeGreaterThanOrEqual(rowBox?.x ?? 0);
    expect((openQuoteBox?.x ?? 0) + (openQuoteBox?.width ?? 0)).toBeLessThanOrEqual((rowBox?.x ?? 0) + (rowBox?.width ?? 0) + 1);
    await followUpSelect.selectOption("FOLLOWED_UP");
    await expect(page.getByRole("status").getByText("Activity updated.", { exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole("group", { name: "Activity views" }).getByRole("button", { name: "Lead queue", exact: true }).click();
    await page.getByRole("button", { name: /Quoted/ }).click();
    await quotedLeadRow.getByText("Details and status", { exact: true }).click();
    await expect(page.getByLabel("Update follow-up for Mobile Beta Customer").filter({ visible: true })).toHaveValue("FOLLOWED_UP");

    await page.goto("/app/settings");
    await expect(page.getByRole("heading", { level: 2, name: "Appearance & language", exact: true })).toBeVisible();
    await expect(page.getByTestId("theme-option-system")).toBeVisible();
    await page.getByTestId("theme-option-dark").click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.getByTestId("theme-option-dark")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem("qf_theme_preference"))).toBe("dark");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
      .toBeLessThanOrEqual(1);

    await page.reload();
    await expect(page.getByTestId("theme-option-dark")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByTestId("theme-option-light").click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
});
