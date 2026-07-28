import { expect, test, type Route } from "@playwright/test";
import {
  addSessionCookie,
  createCustomerViaApi,
  createQuoteViaApi,
  getQuoteViaApi,
  signUpViaApi,
} from "./helpers";

function quoteDetailPath(route: Route) {
  return new URL(route.request().url()).pathname;
}

async function seedQuotePair(request: Parameters<typeof signUpViaApi>[0], prefix: string) {
  const account = await signUpViaApi(request, prefix);
  const customer = await createCustomerViaApi(request, account);
  const target = await createQuoteViaApi(request, account, customer.id, { title: `${prefix} Target Quote` });
  const other = await createQuoteViaApi(request, account, customer.id, { title: `${prefix} Other Quote` });
  const targetDetail = await getQuoteViaApi(request, account, target.id);
  const otherDetail = await getQuoteViaApi(request, account, other.id);
  return { account, target, other, targetDetail, otherDetail };
}

test.describe("quote route selection", () => {
  test("direct route remains authoritative when the quote list returns another quote first", async ({ context, page, request }) => {
    const seeded = await seedQuotePair(request, "Direct Route");
    await addSessionCookie(context, seeded.account);
    let otherDetailRequests = 0;

    await page.route("**/v1/quotes?**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          quotes: [seeded.other, seeded.target],
          pagination: { limit: 100, offset: 0, total: 2 },
        }),
      }),
    );
    await page.route("**/v1/quotes/**", async (route) => {
      const path = quoteDetailPath(route);
      if (path === `/v1/quotes/${seeded.other.id}`) {
        otherDetailRequests += 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ quote: seeded.otherDetail }) });
        return;
      }
      if (path === `/v1/quotes/${seeded.target.id}`) {
        await new Promise((resolve) => setTimeout(resolve, 450));
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ quote: seeded.targetDetail }) });
        return;
      }
      await route.continue();
    });

    await page.goto(`/app/quotes/${seeded.target.id}`);
    await expect(page.getByTestId("quote-detail-loading")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/app/quotes/${seeded.target.id}$`));
    await expect(page.getByRole("heading", { name: seeded.target.title })).toBeVisible();
    await expect(page.getByRole("heading", { name: seeded.other.title })).toHaveCount(0);
    expect(otherDetailRequests).toBe(0);
  });

  test("late detail response cannot replace a newer mobile quote route", async ({ context, page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const seeded = await seedQuotePair(request, "Mobile Route");
    await addSessionCookie(context, seeded.account);

    let releaseTarget = () => {};
    let markTargetStarted = () => {};
    const targetGate = new Promise<void>((resolve) => { releaseTarget = resolve; });
    const targetStarted = new Promise<void>((resolve) => { markTargetStarted = resolve; });

    await page.route("**/v1/quotes/**", async (route) => {
      const path = quoteDetailPath(route);
      if (path === `/v1/quotes/${seeded.target.id}`) {
        markTargetStarted();
        await targetGate;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ quote: seeded.targetDetail }) });
        return;
      }
      if (path === `/v1/quotes/${seeded.other.id}`) {
        await new Promise((resolve) => setTimeout(resolve, 75));
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ quote: seeded.otherDetail }) });
        return;
      }
      await route.continue();
    });

    await page.goto(`/app/quotes/${seeded.target.id}`);
    await targetStarted;
    await page.evaluate((nextQuoteId) => {
      window.history.pushState({}, "", `/app/quotes/${nextQuoteId}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, seeded.other.id);

    await expect(page.getByRole("heading", { name: seeded.other.title })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/app/quotes/${seeded.other.id}$`));
    releaseTarget();
    await page.waitForTimeout(250);
    await expect(page.getByRole("heading", { name: seeded.other.title })).toBeVisible();
    await expect(page.getByRole("heading", { name: seeded.target.title })).toHaveCount(0);
  });

  test("missing quote shows an actionable retry state without selecting a list quote", async ({ context, page, request }) => {
    const seeded = await seedQuotePair(request, "Missing Route");
    await addSessionCookie(context, seeded.account);
    const missingQuoteId = "missing-quote-route";
    let attempts = 0;

    await page.route("**/v1/quotes/**", async (route) => {
      if (quoteDetailPath(route) !== `/v1/quotes/${missingQuoteId}`) {
        await route.continue();
        return;
      }
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 250));
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "internal lookup detail" }) });
    });

    await page.goto(`/app/quotes/${missingQuoteId}`);
    await expect(page.getByRole("heading", { name: "Quote unavailable" })).toBeVisible();
    await expect(page.getByTestId("quote-detail-error")).not.toContainText("internal lookup detail");
    await expect(page).toHaveURL(new RegExp(`/app/quotes/${missingQuoteId}$`));
    await expect(page.getByRole("heading", { name: seeded.other.title })).toHaveCount(0);

    const retry = page.getByRole("button", { name: "Retry quote" });
    expect((await retry.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    const attemptsBeforeRetry = attempts;
    await retry.click();
    await expect.poll(() => attempts).toBe(attemptsBeforeRetry + 1);
    await expect(page.getByRole("heading", { name: "Quote unavailable" })).toBeVisible();
  });
});
