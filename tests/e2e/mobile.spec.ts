import { expect, test } from "@playwright/test";
import {
  addSessionCookie,
  createCustomerViaApi,
  createQuoteViaApi,
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
    await expect(page.getByRole("heading", { name: /customers/i })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Mobile Beta Customer")).toBeVisible();

    await page.goto(`/app/quotes/${quote.id}`);
    await expect(page.getByTestId("quote-desk")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "Mobile Roof Leak Smoke" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Preview" }).first()).toBeVisible();

    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Download PDF" })).toBeVisible();
  });
});

