import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  addSessionCookie,
  apiBaseUrl,
  createCustomerViaApi,
  escapeRegExp,
  signUpViaApi,
  type E2eAccount,
} from "./helpers";

const DRAFT_PREFIX = "qf:quote-draft:v1:";

function visibleField(row: Locator, accessibleName: string) {
  return row.locator(`[aria-label="${accessibleName}"]:visible`);
}

async function persistentBrowserDraftKeys(page: Page) {
  return page.evaluate(() =>
    [...Object.keys(window.localStorage), ...Object.keys(window.sessionStorage)].filter(
      (key) => key.startsWith("qf:quote-draft:") || key.startsWith("qf:quote-builder-draft:"),
    ),
  );
}

async function getServerDraft(request: APIRequestContext, account: E2eAccount) {
  const response = await request.get(`${apiBaseUrl}/v1/quote-drafts/new`, {
    headers: { cookie: account.cookieHeader },
  });
  expect(response.status()).toBe(200);
  return (await response.json() as { draft: null | { payload: { quote?: { title?: string } } } }).draft;
}

async function selectCustomer(page: Page, customerName: string) {
  await page.getByRole("textbox", { name: /find customer by name/i }).fill(customerName);
  await page.getByRole("button", { name: new RegExp(`${escapeRegExp(customerName)}[\\s\\S]*Use`, "i") }).click();
}

test.describe("quote builder secure server draft recovery", () => {
  test("refresh restores selected customer, quote metadata, and lines", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "builder-draft-refresh");
    const customer = await createCustomerViaApi(request, account, { fullName: "Draft Restore Customer" });
    await addSessionCookie(context, account);
    await page.goto("/app/build");
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });

    await selectCustomer(page, customer.fullName);
    await page.getByLabel("Quote title").fill("Refresh-safe quote draft");
    await page.getByLabel("Quote overview").fill("Restore this scope after a browser refresh.");
    const firstRow = page.getByTestId("quote-line-row-1");
    await visibleField(firstRow, "Line 1 title").fill("Refresh-safe line");
    await visibleField(firstRow, "Line 1 description").fill("Restore quantity and price too");
    await visibleField(firstRow, "Line 1 quantity").fill("3");
    await visibleField(firstRow, "Line 1 cost").fill("25");
    await visibleField(firstRow, "Line 1 price").fill("80");
    await expect.poll(async () => (await getServerDraft(request, account))?.payload.quote?.title).toBe("Refresh-safe quote draft");
    await expect(page.getByTestId("quote-builder-draft-status")).toContainText("Draft autosaved");
    await expect(page.getByTestId("quote-builder-draft-status")).toContainText("Saved securely to your workspace");
    await expect.poll(async () => persistentBrowserDraftKeys(page)).toHaveLength(0);

    await page.reload();
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("quote-builder-draft-status")).toContainText("Draft restored");
    await expect(page.getByText("Draft Restore Customer").filter({ visible: true })).toBeVisible();
    await expect(page.getByLabel("Quote title")).toHaveValue("Refresh-safe quote draft");
    await expect(page.getByLabel("Quote overview")).toHaveValue("Restore this scope after a browser refresh.");
    await expect(visibleField(page.getByTestId("quote-line-row-1"), "Line 1 title")).toHaveValue("Refresh-safe line");
    await expect(visibleField(page.getByTestId("quote-line-row-1"), "Line 1 quantity")).toHaveValue("3");
    await expect(visibleField(page.getByTestId("quote-line-row-1"), "Line 1 price")).toHaveValue("80");
  });

  test("successful quote creation clears the scoped stored draft", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "builder-draft-clear");
    const customer = await createCustomerViaApi(request, account, { fullName: "Draft Clear Customer" });
    await addSessionCookie(context, account);
    await page.goto("/app/build");
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });

    await selectCustomer(page, customer.fullName);
    await page.getByLabel("Quote title").fill("Draft clears after creation");
    const firstRow = page.getByTestId("quote-line-row-1");
    await visibleField(firstRow, "Line 1 title").fill("Created line");
    await visibleField(firstRow, "Line 1 price").fill("500");
    await expect.poll(async () => (await getServerDraft(request, account))?.payload.quote?.title).toBe("Draft clears after creation");
    await expect.poll(async () => persistentBrowserDraftKeys(page)).toHaveLength(0);

    await page.getByRole("button", { name: "Create Quote" }).first().click();
    await expect(page).toHaveURL(/\/app\/quotes\/[^/]+$/);
    await expect(page.getByTestId("quote-desk")).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => getServerDraft(request, account)).toBeNull();
    await expect.poll(async () => persistentBrowserDraftKeys(page)).toHaveLength(0);
  });

  test("another signed-in account cannot restore the prior account draft", async ({ context, page, request }) => {
    const accountA = await signUpViaApi(request, "builder-draft-account-a");
    const accountB = await signUpViaApi(request, "builder-draft-account-b");
    await addSessionCookie(context, accountA);
    await page.goto("/app/build");
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
    await page.getByLabel("Quote title").fill("Account A private recovery draft");
    await expect.poll(async () => (await getServerDraft(request, accountA))?.payload.quote?.title).toBe("Account A private recovery draft");

    await context.clearCookies();
    await addSessionCookie(context, accountB);
    await page.reload();
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel("Quote title")).toHaveValue("");
    await expect(page.getByText("Account A private recovery draft")).toHaveCount(0);
    await expect(page.getByTestId("quote-builder-draft-status")).toHaveCount(0);
    await expect.poll(async () => persistentBrowserDraftKeys(page)).toHaveLength(0);
    await expect.poll(async () => (await getServerDraft(request, accountA))?.payload.quote?.title).toBe("Account A private recovery draft");
    await expect.poll(async () => getServerDraft(request, accountB)).toBeNull();
  });

  test("a new tab restores the same fresh device draft", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "builder-draft-tab-close");
    await addSessionCookie(context, account);
    await page.goto("/app/build");
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
    await page.getByLabel("Quote title").fill("Available securely across tabs");
    await expect.poll(async () => (await getServerDraft(request, account))?.payload.quote?.title).toBe("Available securely across tabs");

    const freshTab = await context.newPage();
    await freshTab.goto("/app/build");
    await expect(freshTab.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
    await expect(freshTab.getByLabel("Quote title")).toHaveValue("Available securely across tabs");
    await expect(freshTab.getByTestId("quote-builder-draft-status")).toContainText("Draft restored");
    await expect.poll(async () => persistentBrowserDraftKeys(freshTab)).toHaveLength(0);
    await page.close();
    await expect.poll(async () => persistentBrowserDraftKeys(freshTab)).toHaveLength(0);
  });

  test("explicit sign out leaves no plaintext draft in browser storage", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "builder-draft-logout");
    await addSessionCookie(context, account);
    await page.goto("/app/build");
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
    await page.getByLabel("Quote title").fill("Must disappear on sign out");
    await expect.poll(async () => (await getServerDraft(request, account))?.payload.quote?.title).toBe("Must disappear on sign out");

    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect.poll(async () => persistentBrowserDraftKeys(page)).toHaveLength(0);
  });

  test("a definitive session 401 purges all builder drafts", async ({ page }) => {
    await page.addInitScript((prefix) => {
      localStorage.setItem(`${prefix}stale-tenant:stale-user:new`, JSON.stringify({ privateDraft: true }));
      localStorage.setItem("qf:quote-builder-draft:v1:legacy-tenant:legacy-email", JSON.stringify({ privateDraft: true }));
    }, DRAFT_PREFIX);
    await page.route("**/v1/auth/me", (route) =>
      route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Unauthorized" }) }),
    );

    await page.goto("/app/build");
    await expect(page).toHaveURL(/\/$/);
    await expect.poll(async () => persistentBrowserDraftKeys(page)).toHaveLength(0);
  });

  test("an incompatible server recovery payload is cleared without populating the builder", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "builder-draft-corrupt");
    await addSessionCookie(context, account);
    await page.goto("/app/build");
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
    await page.getByLabel("Quote title").fill("Draft that will be corrupted");
    await expect.poll(async () => (await getServerDraft(request, account))?.payload.quote?.title).toBe("Draft that will be corrupted");
    await page.route("**/v1/quote-drafts/new", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          draft: {
            payload: { version: 1, savedAtUtc: new Date().toISOString(), quote: "not-an-object" },
            savedAtUtc: new Date().toISOString(),
            expiresAtUtc: new Date(Date.now() + 60_000).toISOString(),
          },
        }),
      });
    });

    await page.reload();
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel("Quote title")).toHaveValue("");
    await expect.poll(async () => getServerDraft(request, account)).toBeNull();
    await expect.poll(async () => persistentBrowserDraftKeys(page)).toHaveLength(0);
  });
});
