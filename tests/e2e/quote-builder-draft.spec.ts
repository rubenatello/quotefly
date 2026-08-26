import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  addSessionCookie,
  apiBaseUrl,
  createCustomerViaApi,
  createQuoteViaApi,
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
  return (await response.json() as {
    draft: null | {
      payload: Record<string, unknown> & { quote?: { customerId?: string; title?: string } };
    };
  }).draft;
}

async function selectCustomer(page: Page, customerName: string) {
  await page.getByRole("combobox", { name: "Find a customer", exact: true }).fill(customerName);
  await page
    .getByRole("option", { name: new RegExp(`${escapeRegExp(customerName)}[\\s\\S]*Use customer`, "i") })
    .click();
}

test.describe("quote builder secure server draft recovery", () => {
  test("GET failures keep builder recovery mutations blocked until an explicit successful start-fresh clear", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "builder-draft-get-failure");
    await addSessionCookie(context, account);
    let getCount = 0;
    let putCount = 0;
    let deleteCount = 0;
    await page.route("**/v1/quote-drafts/new", async (route) => {
      const method = route.request().method();
      if (method === "GET") {
        getCount += 1;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Unavailable" }) });
        return;
      }
      if (method === "PUT") putCount += 1;
      if (method === "DELETE") deleteCount += 1;
      await route.continue();
    });

    await page.goto("/app/build");
    await expect(page.getByTestId("quote-builder-recovery-error")).toBeVisible({ timeout: 30_000 });
    await page.getByLabel("Quote title").fill("Must not overwrite an unseen draft");
    await page.waitForTimeout(900);
    expect(putCount).toBe(0);
    expect(deleteCount).toBe(0);

    await page.getByRole("button", { name: "Retry recovery" }).click();
    await expect.poll(() => getCount).toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId("quote-builder-recovery-error")).toBeVisible();
    expect(putCount).toBe(0);
    expect(deleteCount).toBe(0);

    await page.getByRole("button", { name: "Start fresh", exact: true }).click();
    await expect.poll(() => deleteCount).toBe(1);
    await expect(page.getByTestId("quote-builder-recovery-error")).toHaveCount(0);
    await expect.poll(() => putCount).toBeGreaterThan(0);
  });

  test("GET failures keep quote-desk recovery writes blocked until the saved draft is explicitly cleared", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "desk-draft-get-failure");
    const customer = await createCustomerViaApi(request, account, { fullName: "Desk Recovery Customer" });
    const quote = await createQuoteViaApi(request, account, customer.id, { title: "Desk recovery quote" });
    await addSessionCookie(context, account);
    let putCount = 0;
    let deleteCount = 0;
    await page.route("**/v1/quote-drafts/**", async (route) => {
      const method = route.request().method();
      if (method === "GET") {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Unavailable" }) });
        return;
      }
      if (method === "PUT") putCount += 1;
      if (method === "DELETE") deleteCount += 1;
      await route.continue();
    });

    await page.goto(`/app/quotes/${quote.id}`);
    await expect(page.getByTestId("quote-desk-recovery-error")).toBeVisible({ timeout: 30_000 });
    await page.getByLabel("Quote title").fill("Unsaved desk edit remains local");
    await page.waitForTimeout(900);
    expect(putCount).toBe(0);
    expect(deleteCount).toBe(0);

    await page.getByRole("button", { name: "Start fresh from saved quote" }).click();
    await expect.poll(() => deleteCount).toBe(1);
    await expect(page.getByTestId("quote-desk-recovery-error")).toHaveCount(0);
    await expect(page.getByLabel("Quote title")).toHaveValue("Desk recovery quote");
    await page.waitForTimeout(900);
    expect(putCount).toBe(0);
  });

  test("a successful create with failed draft cleanup reuses its opaque key after reload", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "builder-create-retry-reload");
    const customer = await createCustomerViaApi(request, account, { fullName: "Durable Retry Customer" });
    await addSessionCookie(context, account);
    const quoteCreateKeys: string[] = [];
    const quoteCreateBodies: string[] = [];
    let quotePostCompleted = false;
    let cleanupFailureInjected = false;
    let delayNextPlainAutosave = false;
    let staleAutosaveStarted = false;

    await page.route("**/v1/quotes", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      quoteCreateKeys.push(route.request().headers()["idempotency-key"] ?? "");
      quoteCreateBodies.push(route.request().postData() ?? "");
      const response = await route.fetch();
      quotePostCompleted = true;
      await route.fulfill({ response });
    });
    await page.route("**/v1/quote-drafts/new", async (route) => {
      if (route.request().method() === "PUT" && delayNextPlainAutosave) {
        const body = route.request().postDataJSON() as {
          payload?: { quoteCreateRetryIdentity?: unknown };
        };
        if (!body.payload?.quoteCreateRetryIdentity) {
          delayNextPlainAutosave = false;
          staleAutosaveStarted = true;
          await new Promise((resolve) => setTimeout(resolve, 1_200));
          await route.fallback();
          return;
        }
      }
      if (route.request().method() === "DELETE" && quotePostCompleted && !cleanupFailureInjected) {
        cleanupFailureInjected = true;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Unavailable" }) });
        return;
      }
      await route.fallback();
    });

    await page.goto("/app/build");
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
    await selectCustomer(page, customer.fullName);
    await page.getByLabel("Quote title").fill("One durable retry quote");
    const firstRow = page.getByTestId("quote-line-row-1");
    await visibleField(firstRow, "Existing line 1 title").fill("Retry-safe work");
    await visibleField(firstRow, "Existing line 1 price").fill("750");
    delayNextPlainAutosave = true;
    await visibleField(firstRow, "Existing line 1 price").fill("751");
    await expect.poll(() => staleAutosaveStarted).toBe(true);
    await page.getByRole("button", { name: "Create Quote" }).first().click();
    await expect(
      page.getByRole("alert").filter({ hasText: "The quote was created, but its recovery draft could not be cleared." }).first(),
    ).toBeVisible();
    expect(quoteCreateKeys).toHaveLength(1);
    expect(quoteCreateKeys[0]).toMatch(/^qf-quote-/);
    await expect.poll(async () => persistentBrowserDraftKeys(page)).toHaveLength(0);

    await page.reload();
    await expect(page.getByTestId("quote-builder-draft-status")).toContainText("Draft restored");
    await expect(page.getByLabel("Quote title")).toHaveValue("One durable retry quote");
    await page.getByRole("button", { name: "Create Quote" }).first().click();
    await expect(page).toHaveURL(/\/app\/quotes\/[^/]+$/);
    expect(quoteCreateKeys).toHaveLength(2);
    expect(quoteCreateKeys[1]).toBe(quoteCreateKeys[0]);
    expect(quoteCreateBodies[1]).toBe(quoteCreateBodies[0]);

    const quotesResponse = await request.get(`${apiBaseUrl}/v1/quotes?customerId=${encodeURIComponent(customer.id)}&limit=100`, {
      headers: { cookie: account.cookieHeader },
    });
    expect(quotesResponse.status()).toBe(200);
    const payload = await quotesResponse.json() as { quotes: Array<{ title: string }> };
    expect(payload.quotes.filter((quote) => quote.title === "One durable retry quote")).toHaveLength(1);
  });

  test("a committed create with a lost response reuses its opaque key after reload", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "builder-create-response-loss");
    const customer = await createCustomerViaApi(request, account, { fullName: "Response Loss Customer" });
    await addSessionCookie(context, account);
    const quoteCreateKeys: string[] = [];
    const quoteCreateBodies: string[] = [];
    let loseFirstResponse = true;

    await page.route("**/v1/quotes", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      quoteCreateKeys.push(route.request().headers()["idempotency-key"] ?? "");
      quoteCreateBodies.push(route.request().postData() ?? "");
      const response = await route.fetch();
      if (loseFirstResponse) {
        loseFirstResponse = false;
        await route.abort("failed");
        return;
      }
      await route.fulfill({ response });
    });

    await page.goto("/app/build");
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
    await selectCustomer(page, customer.fullName);
    await page.getByLabel("Quote title").fill("One response-loss quote");
    const firstRow = page.getByTestId("quote-line-row-1");
    await visibleField(firstRow, "Existing line 1 title").fill("Committed work");
    await visibleField(firstRow, "Existing line 1 price").fill("925");
    await page.getByRole("button", { name: "Create Quote" }).first().click();
    await expect.poll(() => quoteCreateKeys.length).toBe(1);
    await expect(page).toHaveURL(/\/app\/build$/);
    expect(quoteCreateKeys[0]).toMatch(/^qf-quote-/);

    await page.reload();
    await expect(page.getByTestId("quote-builder-draft-status")).toContainText("Draft restored");
    await expect(page.getByLabel("Quote title")).toHaveValue("One response-loss quote");
    await visibleField(page.getByTestId("quote-line-row-1"), "Existing line 1 price").fill("926");
    await page.getByRole("button", { name: "Create Quote" }).first().click();
    await expect(
      page.getByRole("alert").filter({ hasText: "This retry is locked to the original quote details" }).first(),
    ).toBeVisible();
    expect(quoteCreateKeys).toHaveLength(1);

    await visibleField(page.getByTestId("quote-line-row-1"), "Existing line 1 price").fill("925");
    await page.getByRole("button", { name: "Create Quote" }).first().click();
    await expect(page).toHaveURL(/\/app\/quotes\/[^/]+$/);
    expect(quoteCreateKeys).toHaveLength(2);
    expect(quoteCreateKeys[1]).toBe(quoteCreateKeys[0]);
    expect(quoteCreateBodies[1]).toBe(quoteCreateBodies[0]);

    const quotesResponse = await request.get(`${apiBaseUrl}/v1/quotes?customerId=${encodeURIComponent(customer.id)}&limit=100`, {
      headers: { cookie: account.cookieHeader },
    });
    expect(quotesResponse.status()).toBe(200);
    const payload = await quotesResponse.json() as { quotes: Array<{ title: string }> };
    expect(payload.quotes.filter((quote) => quote.title === "One response-loss quote")).toHaveLength(1);
  });

  test("successful cleanup is the final draft write after a delayed identity autosave", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "builder-create-cleanup-order");
    const customer = await createCustomerViaApi(request, account, { fullName: "Cleanup Ordering Customer" });
    await addSessionCookie(context, account);
    const draftEvents: string[] = [];
    let identityPutCount = 0;
    let releaseIdentityAutosave: (() => void) | null = null;
    const identityAutosaveStarted = new Promise<void>((resolve) => {
      releaseIdentityAutosave = resolve;
    });

    await page.route("**/v1/quote-drafts/new", async (route) => {
      const method = route.request().method();
      if (method === "PUT") {
        const body = route.request().postDataJSON() as {
          payload?: { quoteCreateRetryIdentity?: unknown };
        };
        if (body.payload?.quoteCreateRetryIdentity) {
          identityPutCount += 1;
          if (identityPutCount === 2) {
            draftEvents.push("identity-autosave-started");
            releaseIdentityAutosave?.();
            await new Promise((resolve) => setTimeout(resolve, 1_200));
            const response = await route.fetch();
            draftEvents.push("identity-autosave-completed");
            await route.fulfill({ response });
            return;
          }
        }
      }
      if (method === "DELETE") draftEvents.push("cleanup-delete");
      await route.fallback();
    });
    await page.route("**/v1/quotes", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const response = await route.fetch();
      await identityAutosaveStarted;
      draftEvents.push("post-response-released");
      await route.fulfill({ response });
    });

    await page.goto("/app/build");
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
    await selectCustomer(page, customer.fullName);
    await page.getByLabel("Quote title").fill("Final cleanup ordering quote");
    const firstRow = page.getByTestId("quote-line-row-1");
    await visibleField(firstRow, "Existing line 1 title").fill("Ordered cleanup work");
    await visibleField(firstRow, "Existing line 1 price").fill("640");
    await page.getByRole("button", { name: "Create Quote" }).first().click();
    await expect(page).toHaveURL(/\/app\/quotes\/[^/]+$/, { timeout: 30_000 });

    expect(identityPutCount).toBeGreaterThanOrEqual(2);
    const identityAutosaveCompletedIndex = draftEvents.indexOf("identity-autosave-completed");
    const finalCleanupDeleteIndex = draftEvents.lastIndexOf("cleanup-delete");
    expect(identityAutosaveCompletedIndex).toBeGreaterThanOrEqual(0);
    expect(finalCleanupDeleteIndex).toBeGreaterThan(identityAutosaveCompletedIndex);
    expect(draftEvents.at(-1)).toBe("cleanup-delete");
    await page.waitForTimeout(1_400);
    expect(await getServerDraft(request, account)).toBeNull();
  });

  test("starting fresh from a customer conflict deletes the fetched draft and leaves recovery ready", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "builder-customer-conflict-clear");
    const storedCustomer = await createCustomerViaApi(request, account, { fullName: "Stored Draft Customer" });
    const selectedCustomer = await createCustomerViaApi(request, account, { fullName: "Selected Current Customer" });
    await addSessionCookie(context, account);

    await page.goto("/app/build");
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
    await selectCustomer(page, selectedCustomer.fullName);
    await page.getByLabel("Quote title").fill("Selected customer quote");
    const firstRow = page.getByTestId("quote-line-row-1");
    await visibleField(firstRow, "Existing line 1 title").fill("Selected customer work");
    await visibleField(firstRow, "Existing line 1 price").fill("515");
    await expect.poll(async () => (await getServerDraft(request, account))?.payload.quote?.title).toBe("Selected customer quote");
    await expect.poll(async () => (await getServerDraft(request, account))?.payload.lines[0]?.title).toBe("Selected customer work");
    await expect.poll(async () => (await getServerDraft(request, account))?.payload.lines[0]?.unitPrice).toBe("515");

    await page.getByRole("button", { name: "Customers", exact: true }).click();
    const leaveDialog = page.getByRole("dialog", { name: "Leave this quote draft?" });
    if (await leaveDialog.isVisible()) {
      await leaveDialog.getByRole("button", { name: "Keep draft and leave" }).click();
    }
    await expect(page.getByRole("heading", { level: 1, name: "Customers", exact: true })).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(500);

    const selectedDraft = await getServerDraft(request, account);
    expect(selectedDraft).not.toBeNull();
    if (!selectedDraft) throw new Error("Expected the selected-customer recovery draft to exist.");
    const conflictingPayload = JSON.parse(JSON.stringify(selectedDraft.payload)) as Record<string, unknown> & {
      quote: Record<string, unknown>;
    };
    conflictingPayload.savedAtUtc = new Date().toISOString();
    conflictingPayload.quote = {
      ...conflictingPayload.quote,
      customerId: storedCustomer.id,
      title: "Stored conflicting quote",
    };
    const seedResponse = await request.put(`${apiBaseUrl}/v1/quote-drafts/new`, {
      headers: { cookie: account.cookieHeader },
      data: { payload: conflictingPayload },
    });
    expect(seedResponse.status()).toBe(200);

    const quickCommands = page.getByRole("group", { name: "Quick commands" });
    await quickCommands.getByRole("button", { name: "New quote", exact: true }).click();
    await expect(page.getByTestId("quote-builder-draft-conflict")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Start fresh for selected customer" }).click();
    await expect(page.getByTestId("quote-builder-draft-conflict")).toHaveCount(0);
    const freshFirstRow = page.getByTestId("quote-line-row-1");
    await expect(visibleField(freshFirstRow, "Existing line 1 title")).toHaveValue("");
    await visibleField(freshFirstRow, "Existing line 1 title").fill("Fresh selected customer work");
    await visibleField(freshFirstRow, "Existing line 1 price").fill("515");
    await expect.poll(async () => (await getServerDraft(request, account))?.payload.quote?.title).toBe("Selected customer quote");
    await expect.poll(async () => (await getServerDraft(request, account))?.payload.lines[0]?.title).toBe("Fresh selected customer work");
    await expect.poll(async () => (await getServerDraft(request, account))?.payload.lines[0]?.unitPrice).toBe("515");

    await page.reload();
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("quote-builder-draft-conflict")).toHaveCount(0);
    await expect(page.getByLabel("Quote title")).toHaveValue("Selected customer quote");
    const restoredFirstRow = page.getByTestId("quote-line-row-1");
    await expect(visibleField(restoredFirstRow, "Existing line 1 title")).toHaveValue("Fresh selected customer work");
    await expect(visibleField(restoredFirstRow, "Existing line 1 price")).toHaveValue("515");
    await page.getByRole("button", { name: "Create Quote" }).first().click();
    await expect(page).toHaveURL(/\/app\/quotes\/[^/]+$/);
  });

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
    await visibleField(firstRow, "Existing line 1 title").fill("Refresh-safe line");
    await visibleField(firstRow, "Existing line 1 description").fill("Restore quantity and price too");
    await visibleField(firstRow, "Existing line 1 quantity").fill("3");
    await visibleField(firstRow, "Existing line 1 cost").fill("25");
    await visibleField(firstRow, "Existing line 1 price").fill("80");
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
    await expect(visibleField(page.getByTestId("quote-line-row-1"), "Existing line 1 title")).toHaveValue("Refresh-safe line");
    await expect(visibleField(page.getByTestId("quote-line-row-1"), "Existing line 1 quantity")).toHaveValue("3");
    await expect(visibleField(page.getByTestId("quote-line-row-1"), "Existing line 1 price")).toHaveValue("80");
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
    await visibleField(firstRow, "Existing line 1 title").fill("Created line");
    await visibleField(firstRow, "Existing line 1 price").fill("500");
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
