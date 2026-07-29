import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  addSessionCookie,
  createCustomerViaApi,
  escapeRegExp,
  signUpViaApi,
} from "./helpers";

const DRAFT_PREFIX = "qf:quote-builder-draft:v2:";

function visibleField(row: Locator, accessibleName: string) {
  return row.locator(`[aria-label="${accessibleName}"]:visible`);
}

async function builderDraftKeys(page: Page) {
  return page.evaluate((prefix) => Object.keys(window.sessionStorage).filter((key) => key.startsWith(prefix)), DRAFT_PREFIX);
}

async function persistentBuilderDraftKeys(page: Page) {
  return page.evaluate(() => Object.keys(window.localStorage).filter((key) => key.startsWith("qf:quote-builder-draft:")));
}

async function selectCustomer(page: Page, customerName: string) {
  await page.getByRole("textbox", { name: /find customer by name/i }).fill(customerName);
  await page.getByRole("button", { name: new RegExp(`${escapeRegExp(customerName)}[\\s\\S]*Use`, "i") }).click();
}

test.describe("quote builder local draft recovery", () => {
  test("refresh restores selected customer, quote metadata, and lines", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "builder-draft-refresh");
    const customer = await createCustomerViaApi(request, account, { fullName: "Draft Restore Customer" });
    await addSessionCookie(context, account);
    await page.goto("/app/build");
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 15_000 });

    await selectCustomer(page, customer.fullName);
    await page.getByLabel("Quote title").fill("Refresh-safe quote draft");
    await page.getByLabel("Quote overview").fill("Restore this scope after a browser refresh.");
    const firstRow = page.getByTestId("quote-line-row-1");
    await visibleField(firstRow, "Line 1 title").fill("Refresh-safe line");
    await visibleField(firstRow, "Line 1 description").fill("Restore quantity and price too");
    await visibleField(firstRow, "Line 1 quantity").fill("3");
    await visibleField(firstRow, "Line 1 cost").fill("25");
    await visibleField(firstRow, "Line 1 price").fill("80");
    await expect(page.getByTestId("quote-builder-draft-status")).toContainText("Draft autosaved");
    await expect.poll(async () => (await builderDraftKeys(page)).length).toBe(1);
    const [draftKey] = await builderDraftKeys(page);
    expect(draftKey).toContain(encodeURIComponent(account.tenant.id));
    expect(draftKey).toContain(encodeURIComponent(account.user.id));
    expect(draftKey).not.toContain(account.email);
    expect(draftKey).not.toContain(encodeURIComponent(account.email));

    await page.reload();
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 15_000 });
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
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 15_000 });

    await selectCustomer(page, customer.fullName);
    await page.getByLabel("Quote title").fill("Draft clears after creation");
    const firstRow = page.getByTestId("quote-line-row-1");
    await visibleField(firstRow, "Line 1 title").fill("Created line");
    await visibleField(firstRow, "Line 1 price").fill("500");
    await expect.poll(async () => (await builderDraftKeys(page)).length).toBe(1);

    await page.getByRole("button", { name: "Create Quote" }).first().click();
    await expect(page).toHaveURL(/\/app\/quotes\/[^/]+$/);
    await expect(page.getByTestId("quote-desk")).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await builderDraftKeys(page)).length).toBe(0);
  });

  test("another signed-in account cannot restore the prior account draft", async ({ context, page, request }) => {
    const accountA = await signUpViaApi(request, "builder-draft-account-a");
    const accountB = await signUpViaApi(request, "builder-draft-account-b");
    await addSessionCookie(context, accountA);
    await page.goto("/app/build");
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 15_000 });
    await page.getByLabel("Quote title").fill("Account A private local draft");
    await expect.poll(async () => (await builderDraftKeys(page)).length).toBe(1);

    await context.clearCookies();
    await addSessionCookie(context, accountB);
    await page.reload();
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel("Quote title")).toHaveValue("");
    await expect(page.getByText("Account A private local draft")).toHaveCount(0);
    await expect(page.getByTestId("quote-builder-draft-status")).toHaveCount(0);
    await expect.poll(async () => (await builderDraftKeys(page)).length).toBe(0);
  });

  test("a new tab does not inherit a quote draft from another tab", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "builder-draft-tab-close");
    await addSessionCookie(context, account);
    await page.goto("/app/build");
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 15_000 });
    await page.getByLabel("Quote title").fill("Only available in the original tab");
    await expect.poll(async () => (await builderDraftKeys(page)).length).toBe(1);

    const freshTab = await context.newPage();
    await freshTab.goto("/app/build");
    await expect(freshTab.getByTestId("quote-builder")).toBeVisible({ timeout: 15_000 });
    await expect(freshTab.getByLabel("Quote title")).toHaveValue("");
    await expect.poll(async () => (await builderDraftKeys(freshTab)).length).toBe(0);
    await page.close();
    await expect.poll(async () => (await builderDraftKeys(freshTab)).length).toBe(0);
  });

  test("explicit sign out purges the draft without unmount recreating it", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "builder-draft-logout");
    await addSessionCookie(context, account);
    await page.goto("/app/build");
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 15_000 });
    await page.getByLabel("Quote title").fill("Must disappear on sign out");
    await expect.poll(async () => (await builderDraftKeys(page)).length).toBe(1);

    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect.poll(async () => (await builderDraftKeys(page)).length).toBe(0);
  });

  test("a definitive session 401 purges all builder drafts", async ({ page }) => {
    await page.addInitScript((prefix) => {
      sessionStorage.setItem(`${prefix}stale-tenant:stale-user`, JSON.stringify({ privateDraft: true }));
      localStorage.setItem("qf:quote-builder-draft:v1:legacy-tenant:legacy-email", JSON.stringify({ privateDraft: true }));
    }, DRAFT_PREFIX);
    await page.route("**/v1/auth/me", (route) =>
      route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Unauthorized" }) }),
    );

    await page.goto("/app/build");
    await expect(page).toHaveURL(/\/$/);
    await expect.poll(async () => (await builderDraftKeys(page)).length).toBe(0);
    await expect.poll(async () => (await persistentBuilderDraftKeys(page)).length).toBe(0);
  });

  test("corrupted scoped storage is cleared without populating the builder", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "builder-draft-corrupt");
    await addSessionCookie(context, account);
    await page.goto("/app/build");
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 15_000 });
    await page.getByLabel("Quote title").fill("Draft that will be corrupted");
    await expect.poll(async () => builderDraftKeys(page)).toHaveLength(1);
    const keys = await builderDraftKeys(page);
    const draftKey = keys[0];
    expect(draftKey).toBeTruthy();
    await page.evaluate((key) => window.sessionStorage.setItem(key, "{not-valid-json"), draftKey!);

    await page.reload();
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/saved draft could not be read and was cleared safely/i)).toBeVisible();
    await expect(page.getByLabel("Quote title")).toHaveValue("");
    await expect.poll(async () => (await builderDraftKeys(page)).length).toBe(0);
  });
});
