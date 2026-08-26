import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { addSessionCookie, apiBaseUrl, signUpViaApi } from "./helpers";

type UsageState = "partial" | "capped" | "released" | "reconciling";

function usageFor(state: UsageState) {
  if (state === "capped") {
    return {
      monthlyUsageCompletedPercent: 96,
      monthlyUsageReservedPercent: 4,
      monthlyUsageEffectivePercent: 100,
      monthlyUsageRemainingPercent: 0,
      activeReservationCount: 1,
      enforcementMode: "SPEND",
      periodSource: "ACTIVE_TRIAL",
      billingCycleReconciliationPending: false,
      limitReached: true,
      monthlyAiSpendUsagePercent: 100,
      monthlyAiLimitReached: true,
    };
  }
  if (state === "released") {
    return {
      monthlyUsageCompletedPercent: 70,
      monthlyUsageReservedPercent: 0,
      monthlyUsageEffectivePercent: 70,
      monthlyUsageRemainingPercent: 30,
      activeReservationCount: 0,
      enforcementMode: "SPEND",
      periodSource: "ACTIVE_TRIAL",
      billingCycleReconciliationPending: false,
      limitReached: false,
      monthlyAiSpendUsagePercent: 70,
      monthlyAiLimitReached: false,
    };
  }
  if (state === "reconciling") {
    return {
      monthlyUsageCompletedPercent: 70,
      monthlyUsageReservedPercent: 8,
      monthlyUsageEffectivePercent: 78,
      monthlyUsageRemainingPercent: 22,
      activeReservationCount: 2,
      enforcementMode: "SPEND",
      periodSource: "UTC_CALENDAR_LEGACY",
      billingCycleReconciliationPending: true,
      limitReached: false,
      monthlyAiSpendUsagePercent: 78,
      monthlyAiLimitReached: false,
    };
  }
  return {
    monthlyUsageCompletedPercent: 70,
    monthlyUsageReservedPercent: 8,
    monthlyUsageEffectivePercent: 78,
    monthlyUsageRemainingPercent: 22,
    activeReservationCount: 2,
    enforcementMode: "SPEND",
    periodSource: "ACTIVE_TRIAL",
    billingCycleReconciliationPending: false,
    limitReached: false,
    monthlyAiSpendUsagePercent: 78,
    monthlyAiLimitReached: false,
  };
}

async function interceptSession(page: Page, state: () => UsageState, locale: "en-US" | "es-US" = "en-US") {
  await page.route("**/v1/auth/me", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const payload = await response.json() as {
      user: { preferredLocale: string };
      tenant: { usage: Record<string, unknown> };
    };
    if (!payload.user || !payload.tenant) {
      throw new Error(`Unexpected auth session ${response.status()}: ${JSON.stringify(payload)}`);
    }
    payload.user.preferredLocale = locale;
    payload.tenant.usage = {
      ...payload.tenant.usage,
      ...usageFor(state()),
      periodStartUtc: "2026-08-01T00:00:00.000Z",
      periodEndUtc: "2026-09-01T00:00:00.000Z",
    };
    await route.fulfill({ response, json: payload });
  });
}

function scheduleResponse(usageState: UsageState = "capped") {
  return {
    assistant: {
      tool: "LIST_SCHEDULE",
      generatedAtUtc: "2026-08-25T16:00:00.000Z",
      policyVersion: "2026-08-22",
      maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
      answer: "I found one scheduled visit for today.",
      results: [{
        appointmentId: "appointment-usage-test",
        appointmentVersion: 1,
        appointmentStatus: "SCHEDULED",
        startsAtUtc: "2026-08-25T16:00:00.000Z",
        endsAtUtc: "2026-08-25T18:00:00.000Z",
        timeZone: "America/Los_Angeles",
        jobId: "job-usage-test",
        jobNumber: 4100,
        jobStatus: "SCHEDULED",
        jobTitle: "HVAC tune-up",
        customerId: "customer-usage-test",
        customerName: "Schedule Customer",
        assignedTenantUserId: "member-usage-test",
        assigneeName: "Field Tech",
      }],
      citations: [],
      actions: [],
      auditEventId: "audit-usage-schedule",
      fieldsExcluded: ["service addresses", "appointment instructions", "customer phone numbers", "internal costs"],
      diagnostics: {
        requestedTool: "LIST_SCHEDULE",
        resolvedTool: "LIST_SCHEDULE",
        resultCount: 1,
        citationCount: 0,
        emptyReason: null,
        archivePolicy: "Only active visible bookings are included.",
        filters: { mine: true },
        answerMode: "DETERMINISTIC",
        model: null,
      },
    },
    usage: {
      consumedCredits: 0,
      consumedSpendUsd: 0,
      monthlyCreditsUsed: 0,
      monthlyCreditsLimit: 770,
      monthlyCreditsRemaining: 770,
      ...usageFor(usageState),
      estimatedPromptCostUsd: 0,
      estimatedPromptsRemaining: 0,
      renewsAtUtc: usageState === "reconciling" ? null : "2026-09-01T00:00:00.000Z",
    },
  };
}

test("a canonical AI usage-limit 402 gates paid work without a reload", async ({ context, page, request }) => {
  test.setTimeout(75_000);
  const account = await signUpViaApi(request, "ai-usage-effective");
  await addSessionCookie(context, account);
  let state: UsageState = "partial";
  await interceptSession(page, () => state);

  let assistantRequests = 0;
  let quoteAiRequests = 0;
  await page.route(`${apiBaseUrl}/v1/ai/assistant`, async (route) => {
    assistantRequests += 1;
    expect(route.request().headers()["idempotency-key"]).toMatch(/^qf-ai-/);
    const body = route.request().postDataJSON() as { tool?: string };
    if (body.tool === "LIST_SCHEDULE") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(scheduleResponse("partial")) });
      return;
    }
    state = "capped";
    await route.fulfill({
      status: 402,
      contentType: "application/json",
      body: JSON.stringify({
        code: "AI_USAGE_LIMIT_REACHED",
        error: "raw backend usage prose must not render",
        renewsAtUtc: "2026-09-01T00:00:00.000Z",
      }),
    });
  });
  await page.route(`${apiBaseUrl}/v1/quotes/ai-suggest`, async (route) => {
    quoteAiRequests += 1;
    await route.abort();
  });

  await page.goto("/app");
  await expect(page.getByRole("progressbar", { name: "Monthly AI usage" })).toHaveAttribute(
    "aria-valuetext",
    /78% used.*70% completed.*8% in progress.*22% available.*2 active requests/i,
  );
  await expect(page.getByText("AI usage is at 75%", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Prioritize my day" }).click();
  const kody = page.getByTestId("kody-chat-panel");
  const prompts = kody.getByTestId("kody-quick-prompts");
  if (!(await prompts.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await prompts.locator(":scope > summary").click();
  }
  await prompts.getByText("More prompts", { exact: true }).click();
  await expect(kody.getByTestId("kody-quick-list_schedule")).toBeEnabled();
  await kody.getByTestId("kody-quick-list_schedule").click();
  await expect(kody.getByText("I found one scheduled visit for today.")).toBeVisible();
  await expect(kody.getByTestId("kody-quick-draft_quote")).toBeEnabled();

  const paidFreeText = "Draft a quote for a rooftop unit replacement";
  await kody.getByTestId("kody-prompt").fill(paidFreeText);
  await kody.getByRole("button", { name: "Send", exact: true }).click();
  await expect(kody.getByTestId("kody-prompt")).toHaveValue(paidFreeText);
  await expect(kody.getByRole("status").filter({ hasText: /paid AI request was not run/i })).toBeVisible();
  await expect(kody.getByText(/Drafting and analysis are paused/i)).toBeVisible();
  await expect(kody.getByTestId("kody-quick-draft_quote")).toBeDisabled();
  expect(assistantRequests).toBe(2);

  await kody.getByTestId("kody-prompt").focus();
  await page.keyboard.press("Escape");
  await expect(kody).toBeHidden();
  await page.goto("/app/build");
  await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
  const prepareWithKody = page.getByRole("button", { name: "Prepare with Kody" });
  await expect(prepareWithKody).toBeDisabled();
  await expect(page.locator('[data-testid="quote-ai-pause-reason"]:visible')).toContainText(
    /Drafting and analysis are paused/i,
  );
  expect(quoteAiRequests).toBe(0);

  state = "released";
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("qf:ai-usage-updated", {
    detail: { monthlyUsageEffectivePercent: 70, limitReached: false, renewsAtUtc: "2026-09-01T00:00:00.000Z" },
  })));
  await expect(prepareWithKody).toBeEnabled();
  await prepareWithKody.click();
  const modal = page.getByRole("dialog", { name: "Prepare quote with Kody" });
  await modal.getByTestId("quote-kody-prompt").fill("Write a concise replacement quote for the selected customer");
  await expect(modal.getByRole("button", { name: "Prepare draft" })).toBeEnabled();
  await expect(modal.getByTestId("quote-kody-prompt")).toHaveValue("Write a concise replacement quote for the selected customer");
  expect(quoteAiRequests).toBe(0);
});

test("a mid-session accounting 503 immediately pauses paid AI without hiding deterministic Kody tools", async ({ context, page, request }) => {
  test.setTimeout(75_000);
  const account = await signUpViaApi(request, "ai-usage-reconciliation");
  await addSessionCookie(context, account);
  await interceptSession(page, () => "partial");

  let assistantRequests = 0;
  let quoteAiRequests = 0;
  await page.route(`${apiBaseUrl}/v1/ai/assistant`, async (route) => {
    assistantRequests += 1;
    const body = route.request().postDataJSON() as { tool?: string };
    if (body.tool === "LIST_SCHEDULE") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(scheduleResponse("partial")) });
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        code: "AI_USAGE_ACCOUNTING_UNAVAILABLE",
        error: "raw accounting provider prose must not render",
      }),
    });
  });
  await page.route(`${apiBaseUrl}/v1/quotes/ai-suggest`, async (route) => {
    quoteAiRequests += 1;
    await route.abort();
  });

  await page.goto("/app");
  await expect(page.getByRole("progressbar", { name: "Monthly AI usage" })).toBeVisible();
  await page.evaluate(() => {
    window.addEventListener("qf:ai-usage-updated", (event) => {
      (window as Window & { __lastAiUsageUpdate?: unknown }).__lastAiUsageUpdate =
        (event as CustomEvent).detail;
    });
  });

  await page.getByRole("button", { name: "Prioritize my day" }).click();
  const kody = page.getByTestId("kody-chat-panel");
  const prompts = kody.getByTestId("kody-quick-prompts");
  if (!(await prompts.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await prompts.locator(":scope > summary").click();
  }
  await prompts.getByText("More prompts", { exact: true }).click();
  await expect(kody.getByTestId("kody-quick-list_schedule")).toBeEnabled();
  await expect(kody.getByTestId("kody-quick-draft_quote")).toBeEnabled();
  await kody.getByTestId("kody-quick-list_schedule").click();
  await expect(kody.getByText("I found one scheduled visit for today.")).toBeVisible();

  const paidFreeText = "Analyze my pipeline and draft a follow-up plan";
  await kody.getByTestId("kody-prompt").fill(paidFreeText);
  await kody.getByRole("button", { name: "Send", exact: true }).click();
  await expect(kody.getByTestId("kody-prompt")).toHaveValue(paidFreeText);
  await expect(kody).toContainText(/could not verify AI usage/i);
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __lastAiUsageUpdate?: unknown }).__lastAiUsageUpdate,
  )).toEqual({ accountingUnavailable: true });
  await expect(kody).not.toContainText("raw accounting provider prose must not render");
  await expect(page.getByRole("progressbar", { name: "Monthly AI usage" })).toBeVisible();
  await expect(kody.getByTestId("kody-quick-list_schedule")).toBeEnabled();
  await expect(kody.getByTestId("kody-quick-draft_quote")).toBeDisabled();
  expect(assistantRequests).toBe(2);

  await kody.getByRole("button", { name: "Close Kody" }).click();
  await page.getByRole("button", { name: "New quote", exact: true }).first().click();
  await expect(page).toHaveURL(/\/app\/build$/);
  await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Prepare with Kody", exact: true })).toBeDisabled();
  expect(quoteAiRequests).toBe(0);
});

test("an auth refresh that began before an accounting 503 cannot reopen paid AI controls", async ({ context, page, request }) => {
  test.setTimeout(75_000);
  const account = await signUpViaApi(request, "ai-usage-accounting-refresh-race");
  await addSessionCookie(context, account);

  let holdNextAuthMe = false;
  let releaseOldRefresh: (() => void) | null = null;
  const oldRefreshReleased = new Promise<void>((resolve) => { releaseOldRefresh = resolve; });
  let markOldRefreshStarted: (() => void) | null = null;
  const oldRefreshStarted = new Promise<void>((resolve) => { markOldRefreshStarted = resolve; });
  let markOldRefreshFulfilled: (() => void) | null = null;
  const oldRefreshFulfilled = new Promise<void>((resolve) => { markOldRefreshFulfilled = resolve; });
  await page.route("**/v1/auth/me", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const payload = await response.json() as {
      user: { preferredLocale: string };
      tenant: { usage: Record<string, unknown> };
    };
    const heldResponse = holdNextAuthMe;
    payload.user.preferredLocale = "en-US";
    payload.tenant.usage = {
      ...payload.tenant.usage,
      // This proves the held session response has actually committed after it
      // is released, rather than merely asserting the already-disabled button.
      ...usageFor(heldResponse ? "released" : "partial"),
      periodStartUtc: "2026-08-01T00:00:00.000Z",
      periodEndUtc: "2026-09-01T00:00:00.000Z",
    };
    if (heldResponse) {
      holdNextAuthMe = false;
      markOldRefreshStarted?.();
      await oldRefreshReleased;
    }
    await route.fulfill({ response, json: payload });
    if (heldResponse) markOldRefreshFulfilled?.();
  });

  let paidRequests = 0;
  await page.route(`${apiBaseUrl}/v1/ai/assistant`, async (route) => {
    const body = route.request().postDataJSON() as { tool?: string };
    if (body.tool === "LIST_SCHEDULE") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(scheduleResponse("partial")) });
      return;
    }
    paidRequests += 1;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify(paidRequests === 1
        ? { code: "UPSTREAM_UNAVAILABLE", error: "ordinary upstream outage" }
        : { code: "AI_USAGE_ACCOUNTING_UNAVAILABLE", error: "accounting outage" }),
    });
  });

  await page.goto("/app");
  await expect(page.getByRole("progressbar", { name: "Monthly AI usage" })).toBeVisible();
  await page.getByRole("button", { name: "Prioritize my day" }).click();
  const kody = page.getByTestId("kody-chat-panel");
  const prompts = kody.getByTestId("kody-quick-prompts");
  if (!(await prompts.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await prompts.locator(":scope > summary").click();
  }
  await prompts.getByText("More prompts", { exact: true }).click();
  await expect(kody.getByTestId("kody-quick-list_schedule")).toBeEnabled();
  await expect(kody.getByTestId("kody-quick-draft_quote")).toBeEnabled();

  // An unrelated 503 remains a request error; it must not become an accounting pause.
  await kody.getByTestId("kody-prompt").fill("Draft a short follow-up");
  await kody.getByRole("button", { name: "Send", exact: true }).click();
  await expect(kody.getByTestId("kody-quick-draft_quote")).toBeEnabled();

  // Start a normal usage-driven refresh, but delay its response until after the
  // canonical accounting failure arrives.
  holdNextAuthMe = true;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("qf:ai-usage-updated", {
    detail: { monthlyUsageEffectivePercent: 78, limitReached: false },
  })));
  await oldRefreshStarted;

  await kody.getByTestId("kody-prompt").fill("Draft an HVAC replacement quote");
  await kody.getByRole("button", { name: "Send", exact: true }).click();
  await expect(kody).toContainText(/could not verify AI usage/i);
  await expect(kody.getByTestId("kody-quick-list_schedule")).toBeEnabled();
  await expect(kody.getByTestId("kody-quick-draft_quote")).toBeDisabled();

  releaseOldRefresh?.();
  await oldRefreshFulfilled;
  // The deferred, pre-pause auth/me result has committed its otherwise-healthy
  // snapshot, but it must not clear the fail-closed pause.
  await expect(page.getByRole("progressbar", { name: "Monthly AI usage" })).toHaveAttribute("aria-valuetext", /70% used/i);
  await expect(kody.getByTestId("kody-quick-draft_quote")).toBeDisabled();
});

test("capped usage remains readable in Spanish mobile dark mode", async ({ context, page, request }) => {
  test.setTimeout(60_000);
  const account = await signUpViaApi(request, "ai-usage-spanish-mobile");
  await addSessionCookie(context, account);
  await interceptSession(page, () => "capped", "es-US");
  await page.addInitScript(() => window.localStorage.setItem("qf_theme_preference", "dark"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app");
  await page.getByRole("button", { name: "Priorizar mi día" }).click();
  const kody = page.getByTestId("kody-chat-panel");
  await expect(kody.getByText(/La redacción y el análisis están en pausa/i)).toBeVisible();
  await expect(kody.getByTestId("kody-prompt")).toBeEnabled();
  const results = await new AxeBuilder({ page }).include('[data-testid="kody-chat-panel"]').analyze();
  expect(results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
});

test("reconciliation guidance remains localized in Spanish mobile dark mode", async ({ context, page, request }) => {
  test.setTimeout(60_000);
  const account = await signUpViaApi(request, "ai-usage-reconciliation-spanish");
  await addSessionCookie(context, account);
  await interceptSession(page, () => "reconciling", "es-US");
  await page.addInitScript(() => window.localStorage.setItem("qf_theme_preference", "dark"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app");
  await expect(page.getByRole("progressbar", { name: "Uso mensual de IA" })).toHaveCount(0);
  await page.getByRole("button", { name: "Priorizar mi día" }).click();
  const kody = page.getByTestId("kody-chat-panel");
  await expect(kody.getByText(/conciliando el ciclo de facturación/i)).toBeVisible();
  await expect(kody).not.toContainText(/se renueva|1 de septiembre|se usó el 78%/i);
  await expect(kody.getByTestId("kody-prompt")).toBeEnabled();
  const prompts = kody.getByTestId("kody-quick-prompts");
  if (!(await prompts.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await prompts.locator(":scope > summary").click();
  }
  await prompts.getByText("Más opciones", { exact: true }).click();
  await expect(kody.getByTestId("kody-quick-list_schedule")).toBeEnabled();
  await expect(kody.getByTestId("kody-quick-draft_quote")).toBeDisabled();
  const results = await new AxeBuilder({ page }).include('[data-testid="kody-chat-panel"]').analyze();
  expect(results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
});
