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

  test("a lost-response retry stays locked when the staged customer is edited", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "builder-staged-customer-response-loss");
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
    await page.getByRole("button", { name: "Add customer", exact: true }).first().click();
    const customerDialog = page.getByRole("dialog", { name: "Add customer fast" });
    await customerDialog.getByLabel("Full name").fill("Locked Retry Customer");
    await customerDialog.getByLabel("Phone").fill("555-010-7840");
    await customerDialog.getByLabel("Email").fill("locked-retry@example.com");
    await customerDialog.getByRole("button", { name: "Save + build quote", exact: true }).click();
    await page.getByLabel("Quote title").fill("One staged response-loss quote");
    const firstRow = page.getByTestId("quote-line-row-1");
    await visibleField(firstRow, "Existing line 1 title").fill("Response-safe staged work");
    await visibleField(firstRow, "Existing line 1 price").fill("640");
    await page.getByRole("button", { name: "Create Quote" }).first().click();
    await expect.poll(() => quoteCreateKeys.length).toBe(1);
    expect(quoteCreateKeys[0]).toMatch(/^qf-quote-/);

    await page.getByRole("button", { name: "Add customer", exact: true }).first().click();
    await customerDialog.getByLabel("Full name").fill("Changed Retry Customer");
    await customerDialog.getByRole("button", { name: "Save + build quote", exact: true }).click();
    await page.getByRole("button", { name: "Create Quote" }).first().click();
    await expect(
      page.getByRole("alert").filter({ hasText: "This retry is locked to the original quote details" }).first(),
    ).toBeVisible();
    expect(quoteCreateKeys).toHaveLength(1);

    await page.getByRole("button", { name: "Add customer", exact: true }).first().click();
    await customerDialog.getByLabel("Full name").fill("Locked Retry Customer");
    await customerDialog.getByRole("button", { name: "Save + build quote", exact: true }).click();
    await page.reload();
    await expect(page.getByTestId("quote-builder-draft-status")).toContainText("Draft restored");
    await expect(page.getByLabel("Quote title")).toHaveValue("One staged response-loss quote");
    await page.getByRole("button", { name: "Create Quote" }).first().click();
    await expect(page).toHaveURL(/\/app\/quotes\/[^/]+$/, { timeout: 30_000 });
    expect(quoteCreateKeys).toHaveLength(2);
    expect(quoteCreateKeys[1]).toBe(quoteCreateKeys[0]);
    expect(quoteCreateBodies[1]).toBe(quoteCreateBodies[0]);

    const quotesResponse = await request.get(`${apiBaseUrl}/v1/quotes?limit=100`, {
      headers: { cookie: account.cookieHeader },
    });
    expect(quotesResponse.status()).toBe(200);
    const quotesPayload = await quotesResponse.json() as { quotes: Array<{ title: string }> };
    expect(quotesPayload.quotes.filter((quote) => quote.title === "One staged response-loss quote")).toHaveLength(1);
    const customersResponse = await request.get(`${apiBaseUrl}/v1/customers?search=${encodeURIComponent("locked-retry@example.com")}&limit=100`, {
      headers: { cookie: account.cookieHeader },
    });
    expect(customersResponse.status()).toBe(200);
    const customersPayload = await customersResponse.json() as { customers: Array<{ email: string | null }> };
    expect(customersPayload.customers.filter((customer) => customer.email === "locked-retry@example.com")).toHaveLength(1);
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

  test("stages a new customer and persists it only inside the reviewed quote command", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "builder-atomic-new-customer");
    await addSessionCookie(context, account);
    let standaloneCustomerWrites = 0;
    const quoteCreateBodies: Array<Record<string, unknown>> = [];
    await page.route("**/v1/customers", async (route) => {
      if (route.request().method() === "POST") standaloneCustomerWrites += 1;
      await route.fallback();
    });
    await page.route("**/v1/quotes", async (route) => {
      if (route.request().method() === "POST") {
        quoteCreateBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      }
      await route.fallback();
    });

    await page.goto("/app/build");
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Add customer", exact: true }).first().click();
    const customerDialog = page.getByRole("dialog", { name: "Add customer fast" });
    await customerDialog.getByLabel("Full name").fill("Atomic Browser Customer");
    await customerDialog.getByLabel("Phone").fill("555-010-7831");
    await customerDialog.getByLabel("Email").fill("atomic-browser@example.com");
    await customerDialog.getByLabel("Customer notes").fill("Create only with the reviewed quote.");
    await customerDialog.getByRole("button", { name: "Save + build quote", exact: true }).click();
    await expect(customerDialog).toBeHidden();
    expect(standaloneCustomerWrites).toBe(0);
    await expect(page.getByText("Atomic Browser Customer").filter({ visible: true }).first()).toBeVisible();

    await page.getByLabel("Quote title").fill("Atomic browser quote");
    const firstRow = page.getByTestId("quote-line-row-1");
    await visibleField(firstRow, "Existing line 1 title").fill("Reviewed inspection labor");
    await visibleField(firstRow, "Existing line 1 price").fill("420");
    await page.getByRole("button", { name: "Create Quote" }).first().click();
    await expect(page).toHaveURL(/\/app\/quotes\/[^/]+$/, { timeout: 30_000 });

    expect(standaloneCustomerWrites).toBe(0);
    expect(quoteCreateBodies).toHaveLength(1);
    expect(quoteCreateBodies[0]).not.toHaveProperty("customerId");
    expect(quoteCreateBodies[0]).toMatchObject({
      customerDraft: {
        fullName: "Atomic Browser Customer",
        phone: "(555) 010-7831",
        email: "atomic-browser@example.com",
        notes: "Create only with the reviewed quote.",
      },
    });
    const customerResponse = await request.get(`${apiBaseUrl}/v1/customers?search=atomic-browser%40example.com`, {
      headers: { cookie: account.cookieHeader },
    });
    expect(customerResponse.status()).toBe(200);
    const customerPayload = await customerResponse.json() as { customers: Array<{ id: string }> };
    expect(customerPayload.customers).toHaveLength(1);
  });

  test("reopens duplicate review and retries the atomic quote with explicit customer reuse", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "builder-atomic-duplicate-customer");
    const existing = await createCustomerViaApi(request, account, {
      fullName: "Existing Atomic Customer",
      phone: "555-010-7832",
      email: "existing-atomic@example.com",
    });
    await addSessionCookie(context, account);
    const quoteCreateBodies: Array<Record<string, unknown>> = [];
    await page.route("**/v1/quotes", async (route) => {
      if (route.request().method() === "POST") {
        quoteCreateBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      }
      await route.fallback();
    });

    await page.goto("/app/build");
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Add customer", exact: true }).first().click();
    const customerDialog = page.getByRole("dialog", { name: "Add customer fast" });
    await customerDialog.getByLabel("Full name").fill("Kody Duplicate Customer");
    await customerDialog.getByLabel("Phone").fill(existing.phone);
    await customerDialog.getByLabel("Email").fill(existing.email ?? "");
    await customerDialog.getByRole("button", { name: "Save + build quote", exact: true }).click();

    await page.getByLabel("Quote title").fill("Duplicate-safe atomic quote");
    const firstRow = page.getByTestId("quote-line-row-1");
    await visibleField(firstRow, "Existing line 1 title").fill("Duplicate-safe work");
    await visibleField(firstRow, "Existing line 1 price").fill("510");
    await page.getByRole("button", { name: "Create Quote" }).first().click();

    await expect(customerDialog).toBeVisible({ timeout: 30_000 });
    await expect(customerDialog).toContainText("Existing Atomic Customer");
    await customerDialog.getByRole("button", { name: "Use existing", exact: true }).click();
    await expect(customerDialog).toBeHidden();
    await expect(page.getByTestId("quote-builder")).toContainText(existing.fullName);
    await expect(page.getByTestId("quote-builder")).toContainText(existing.phone);
    await expect(page.getByTestId("quote-builder")).toContainText(existing.email ?? "");
    await page.getByRole("button", { name: "Create Quote" }).first().click();
    await expect(page).toHaveURL(/\/app\/quotes\/[^/]+$/, { timeout: 30_000 });

    expect(quoteCreateBodies).toHaveLength(2);
    expect(quoteCreateBodies[0]).toHaveProperty("customerDraft");
    expect(quoteCreateBodies[0]!.customerDraft).not.toHaveProperty("duplicateAction");
    expect(quoteCreateBodies[1]).toMatchObject({
      customerDraft: {
        fullName: existing.fullName,
        phone: existing.phone,
        email: existing.email,
        duplicateAction: "use_existing",
        duplicateCustomerId: existing.id,
      },
    });
  });

  test("preserves the explicitly selected nonpreferred duplicate in the atomic retry", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "builder-atomic-nonpreferred-duplicate");
    const sharedEmail = "shared-duplicate-review@example.com";
    const olderCustomer = await createCustomerViaApi(request, account, {
      fullName: "Older Nonpreferred Customer",
      phone: "555-010-7828",
      email: sharedEmail,
    });
    const newerCustomerResponse = await request.post(`${apiBaseUrl}/v1/customers`, {
      headers: { cookie: account.cookieHeader },
      data: {
        fullName: "Newer Preferred Customer",
        phone: "555-010-7829",
        email: sharedEmail,
        duplicateAction: "create_new",
      },
    });
    expect(newerCustomerResponse.status()).toBe(201);
    const { customer: newerCustomer } = await newerCustomerResponse.json() as {
      customer: { id: string; fullName: string };
    };
    await addSessionCookie(context, account);
    const quoteCreateBodies: Array<Record<string, unknown>> = [];
    await page.route("**/v1/quotes", async (route) => {
      if (route.request().method() === "POST") {
        quoteCreateBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      }
      await route.fallback();
    });

    await page.goto("/app/build");
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Add customer", exact: true }).first().click();
    const customerDialog = page.getByRole("dialog", { name: "Add customer fast" });
    await customerDialog.getByLabel("Full name").fill("Reviewed Email Duplicate");
    await customerDialog.getByLabel("Phone").fill("555-010-7830");
    await customerDialog.getByLabel("Email").fill(sharedEmail);
    await customerDialog.getByRole("button", { name: "Save + build quote", exact: true }).click();
    await page.getByLabel("Quote title").fill("Selected duplicate stays selected");
    const firstRow = page.getByTestId("quote-line-row-1");
    await visibleField(firstRow, "Existing line 1 title").fill("Selection-safe work");
    await visibleField(firstRow, "Existing line 1 price").fill("545");
    await page.getByRole("button", { name: "Create Quote" }).first().click();

    await expect(customerDialog).toBeVisible({ timeout: 30_000 });
    await expect(customerDialog).toContainText(newerCustomer.fullName);
    const olderMatch = customerDialog.locator("label").filter({ hasText: olderCustomer.fullName });
    await olderMatch.getByRole("radio").check();
    await expect(olderMatch.getByRole("radio")).toBeChecked();
    await customerDialog.getByRole("button", { name: "Use existing", exact: true }).click();
    await page.getByRole("button", { name: "Create Quote" }).first().click();
    await expect(page).toHaveURL(/\/app\/quotes\/[^/]+$/, { timeout: 30_000 });

    expect(quoteCreateBodies).toHaveLength(2);
    expect(quoteCreateBodies[1]).toMatchObject({
      customerDraft: {
        duplicateAction: "use_existing",
        duplicateCustomerId: olderCustomer.id,
      },
    });
  });

  test("recovered staged customer keeps duplicate resolution inside the atomic quote command", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "builder-recovered-atomic-duplicate");
    const existing = await createCustomerViaApi(request, account, {
      fullName: "Existing Recovered Customer",
      phone: "555-010-7833",
      email: "existing-recovered@example.com",
    });
    await addSessionCookie(context, account);
    let standaloneCustomerWrites = 0;
    const quoteCreateBodies: Array<Record<string, unknown>> = [];
    await page.route("**/v1/customers", async (route) => {
      if (route.request().method() === "POST") standaloneCustomerWrites += 1;
      await route.fallback();
    });
    await page.route("**/v1/quotes", async (route) => {
      if (route.request().method() === "POST") {
        quoteCreateBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      }
      await route.fallback();
    });

    await page.goto("/app/build");
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Add customer", exact: true }).first().click();
    const customerDialog = page.getByRole("dialog", { name: "Add customer fast" });
    await customerDialog.getByLabel("Full name").fill("Recovered Duplicate Customer");
    await customerDialog.getByLabel("Phone").fill(existing.phone);
    await customerDialog.getByLabel("Email").fill(existing.email ?? "");
    await customerDialog.getByRole("button", { name: "Save + build quote", exact: true }).click();
    await page.getByLabel("Quote title").fill("Recovered duplicate-safe quote");
    const firstRow = page.getByTestId("quote-line-row-1");
    await visibleField(firstRow, "Existing line 1 title").fill("Recovered duplicate-safe work");
    await visibleField(firstRow, "Existing line 1 price").fill("615");
    await expect.poll(async () => {
      const draft = await getServerDraft(request, account);
      return draft?.payload.quickCustomerDraft?.fullName;
    }).toBe("Recovered Duplicate Customer");

    await page.reload();
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Recovered Duplicate Customer").filter({ visible: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Create Quote" }).first().click();

    await expect(customerDialog).toBeVisible({ timeout: 30_000 });
    await expect(customerDialog).toContainText("Existing Recovered Customer");
    await customerDialog.getByRole("button", { name: "Use existing", exact: true }).click();
    await expect(customerDialog).toBeHidden();
    expect(standaloneCustomerWrites).toBe(0);
    await page.getByRole("button", { name: "Create Quote" }).first().click();
    await expect(page).toHaveURL(/\/app\/quotes\/[^/]+$/, { timeout: 30_000 });

    expect(standaloneCustomerWrites).toBe(0);
    expect(quoteCreateBodies).toHaveLength(2);
    expect(quoteCreateBodies[1]).toMatchObject({
      customerDraft: {
        duplicateAction: "use_existing",
        duplicateCustomerId: existing.id,
      },
    });
  });

  test("merge contact conflict explains recovery and keeps every write atomic", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "builder-atomic-merge-conflict");
    const existing = await createCustomerViaApi(request, account, {
      fullName: "Archived Contact Customer",
      phone: "555-010-7834",
      email: "saved-contact@example.com",
    });
    const archiveResponse = await request.post(`${apiBaseUrl}/v1/customers/${existing.id}/archive`, {
      headers: { cookie: account.cookieHeader },
    });
    expect(archiveResponse.status()).toBe(204);
    await addSessionCookie(context, account);
    let standaloneCustomerWrites = 0;
    const quoteCreateBodies: Array<Record<string, unknown>> = [];
    await page.route("**/v1/customers", async (route) => {
      if (route.request().method() === "POST") standaloneCustomerWrites += 1;
      await route.fallback();
    });
    await page.route("**/v1/quotes", async (route) => {
      if (route.request().method() === "POST") {
        quoteCreateBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      }
      await route.fallback();
    });

    await page.goto("/app/build");
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Add customer", exact: true }).first().click();
    const customerDialog = page.getByRole("dialog", { name: "Add customer fast" });
    await customerDialog.getByLabel("Full name").fill("Reviewed Restored Customer");
    await customerDialog.getByLabel("Phone").fill(existing.phone);
    await customerDialog.getByLabel("Email").fill("conflicting-contact@example.com");
    await customerDialog.getByRole("button", { name: "Save + build quote", exact: true }).click();
    await page.getByLabel("Quote title").fill("Atomic contact-conflict quote");
    const firstRow = page.getByTestId("quote-line-row-1");
    await visibleField(firstRow, "Existing line 1 title").fill("Conflict-safe restoration work");
    await visibleField(firstRow, "Existing line 1 price").fill("725");

    await page.getByRole("button", { name: "Create Quote" }).first().click();
    await expect(customerDialog).toBeVisible({ timeout: 30_000 });
    await customerDialog.getByRole("button", { name: "Merge selected", exact: true }).click();
    await expect(customerDialog).toBeHidden();
    await page.getByRole("button", { name: "Create Quote" }).first().click();

    await expect(customerDialog).toBeVisible({ timeout: 30_000 });
    await expect(customerDialog.getByRole("alert")).toContainText(
      "The selected customer has different saved contact details",
    );
    expect(standaloneCustomerWrites).toBe(0);

    const archivedResponse = await request.get(
      `${apiBaseUrl}/v1/customers?search=saved-contact%40example.com&lifecycle=archived`,
      { headers: { cookie: account.cookieHeader } },
    );
    expect(archivedResponse.status()).toBe(200);
    const archivedPayload = await archivedResponse.json() as {
      customers: Array<{ id: string; fullName: string; email: string | null; archivedAtUtc: string | null }>;
    };
    expect(archivedPayload.customers).toContainEqual(expect.objectContaining({
      id: existing.id,
      fullName: "Archived Contact Customer",
      email: "saved-contact@example.com",
      archivedAtUtc: expect.any(String),
    }));
    const failedQuotesResponse = await request.get(
      `${apiBaseUrl}/v1/quotes?customerId=${encodeURIComponent(existing.id)}&limit=100`,
      { headers: { cookie: account.cookieHeader } },
    );
    expect(failedQuotesResponse.status()).toBe(200);
    const failedQuotes = await failedQuotesResponse.json() as { quotes: Array<{ title: string }> };
    expect(failedQuotes.quotes.filter((quote) => quote.title === "Atomic contact-conflict quote")).toHaveLength(0);

    await customerDialog.getByLabel("Email").fill(existing.email ?? "");
    await expect(customerDialog.getByRole("alert")).toHaveCount(0);
    await customerDialog.getByRole("button", { name: "Save + build quote", exact: true }).click();
    await page.getByRole("button", { name: "Create Quote" }).first().click();
    await expect(customerDialog).toBeVisible({ timeout: 30_000 });
    await customerDialog.getByRole("button", { name: "Merge selected", exact: true }).click();
    await page.getByRole("button", { name: "Create Quote" }).first().click();
    await expect(page).toHaveURL(/\/app\/quotes\/[^/]+$/, { timeout: 30_000 });

    expect(standaloneCustomerWrites).toBe(0);
    expect(quoteCreateBodies).toHaveLength(4);
    expect(quoteCreateBodies[3]).toMatchObject({
      customerDraft: {
        duplicateAction: "merge",
        duplicateCustomerId: existing.id,
        email: "saved-contact@example.com",
      },
    });
    const activeResponse = await request.get(
      `${apiBaseUrl}/v1/customers?search=saved-contact%40example.com&lifecycle=active`,
      { headers: { cookie: account.cookieHeader } },
    );
    expect(activeResponse.status()).toBe(200);
    const activePayload = await activeResponse.json() as {
      customers: Array<{ id: string; fullName: string; email: string | null; archivedAtUtc: string | null }>;
    };
    expect(activePayload.customers).toContainEqual(expect.objectContaining({
      id: existing.id,
      fullName: "Reviewed Restored Customer",
      email: "saved-contact@example.com",
      archivedAtUtc: null,
    }));
    const savedQuotesResponse = await request.get(
      `${apiBaseUrl}/v1/quotes?customerId=${encodeURIComponent(existing.id)}&limit=100`,
      { headers: { cookie: account.cookieHeader } },
    );
    const savedQuotes = await savedQuotesResponse.json() as { quotes: Array<{ title: string }> };
    expect(savedQuotes.quotes.filter((quote) => quote.title === "Atomic contact-conflict quote")).toHaveLength(1);
  });

  test("restricted phone conflict reveals no candidate and recovers through quote-only restaging", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "builder-restricted-phone-conflict");
    await addSessionCookie(context, account);
    let standaloneCustomerWrites = 0;
    let quoteCreateAttempts = 0;
    await page.route("**/v1/customers", async (route) => {
      if (route.request().method() === "POST") standaloneCustomerWrites += 1;
      await route.fallback();
    });
    await page.route("**/v1/quotes", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      quoteCreateAttempts += 1;
      if (quoteCreateAttempts === 1) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            code: "PHONE_CONFLICT",
            error: "This phone number is already in use. Search for the existing customer and try again.",
          }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto("/app/build");
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Add customer", exact: true }).first().click();
    const customerDialog = page.getByRole("dialog", { name: "Add customer fast" });
    await customerDialog.getByLabel("Full name").fill("Restricted Phone Draft");
    await customerDialog.getByLabel("Phone").fill("555-010-7835");
    await customerDialog.getByLabel("Email").fill("restricted-phone@example.com");
    await customerDialog.getByRole("button", { name: "Save + build quote", exact: true }).click();
    await page.getByLabel("Quote title").fill("Restricted phone recovery quote");
    const firstRow = page.getByTestId("quote-line-row-1");
    await visibleField(firstRow, "Existing line 1 title").fill("Restricted phone recovery work");
    await visibleField(firstRow, "Existing line 1 price").fill("825");
    await page.getByRole("button", { name: "Create Quote" }).first().click();

    await expect(customerDialog).toBeVisible({ timeout: 30_000 });
    await expect(customerDialog.getByRole("alert")).toContainText(
      "This phone cannot be added to your assigned records",
    );
    await expect(customerDialog.getByRole("button", { name: "Save customer", exact: true })).toHaveCount(0);
    await expect(customerDialog.getByText(/Private Customer|existing customer details/i)).toHaveCount(0);
    expect(standaloneCustomerWrites).toBe(0);

    await customerDialog.getByLabel("Phone").fill("555-010-7836");
    await expect(customerDialog.getByRole("alert")).toHaveCount(0);
    await customerDialog.getByRole("button", { name: "Save + build quote", exact: true }).click();
    await page.getByRole("button", { name: "Create Quote" }).first().click();
    await expect(page).toHaveURL(/\/app\/quotes\/[^/]+$/, { timeout: 30_000 });
    expect(standaloneCustomerWrites).toBe(0);
    expect(quoteCreateAttempts).toBe(2);
  });

  test("zero-match stale duplicate reopens actionable quote-only review", async ({ context, page, request }) => {
    const account = await signUpViaApi(request, "builder-zero-match-stale-duplicate");
    await addSessionCookie(context, account);
    let standaloneCustomerWrites = 0;
    let quoteCreateAttempts = 0;
    await page.route("**/v1/customers", async (route) => {
      if (route.request().method() === "POST") standaloneCustomerWrites += 1;
      await route.fallback();
    });
    await page.route("**/v1/quotes", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      quoteCreateAttempts += 1;
      if (quoteCreateAttempts === 1) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            code: "STALE_DUPLICATE_TARGET",
            error: "The selected customer changed and no longer matches. Review the latest results.",
            matches: [],
          }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto("/app/build");
    await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Add customer", exact: true }).first().click();
    const customerDialog = page.getByRole("dialog", { name: "Add customer fast" });
    await customerDialog.getByLabel("Full name").fill("Stale Reviewed Customer");
    await customerDialog.getByLabel("Phone").fill("555-010-7837");
    await customerDialog.getByLabel("Email").fill("stale-reviewed@example.com");
    await customerDialog.getByRole("button", { name: "Save + build quote", exact: true }).click();
    await page.getByLabel("Quote title").fill("Zero-match stale recovery quote");
    const firstRow = page.getByTestId("quote-line-row-1");
    await visibleField(firstRow, "Existing line 1 title").fill("Stale recovery work");
    await visibleField(firstRow, "Existing line 1 price").fill("925");
    await page.getByRole("button", { name: "Create Quote" }).first().click();

    await expect(customerDialog).toBeVisible({ timeout: 30_000 });
    await expect(customerDialog.getByRole("alert")).toContainText(
      "Customer details changed after the duplicate warning",
    );
    await expect(customerDialog.getByRole("button", { name: "Save customer", exact: true })).toHaveCount(0);
    expect(standaloneCustomerWrites).toBe(0);

    await customerDialog.getByLabel("Email").fill("stale-reviewed-corrected@example.com");
    await expect(customerDialog.getByRole("alert")).toHaveCount(0);
    await customerDialog.getByRole("button", { name: "Save + build quote", exact: true }).click();
    await page.getByRole("button", { name: "Create Quote" }).first().click();
    await expect(page).toHaveURL(/\/app\/quotes\/[^/]+$/, { timeout: 30_000 });
    expect(standaloneCustomerWrites).toBe(0);
    expect(quoteCreateAttempts).toBe(2);
  });
});
