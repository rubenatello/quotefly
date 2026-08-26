import { expect, test } from "@playwright/test";
import { addSessionCookie, apiBaseUrl, signUpViaApi } from "./helpers";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("qf_locale", "en-US"));
});

test("mobile direct READY focuses the review and keeps actions field-usable", async ({ context, page, request }) => {
  const account = await signUpViaApi(request, "kody-prepare-mobile-focus");
  const line = {
    description: "Mobile service visit\nInspect the equipment and complete the approved service.",
    sectionType: "INCLUDED",
    sectionLabel: null,
    quantity: 1,
    unitCost: 40,
    unitPrice: 120,
    sourcePresetId: "preset-mobile",
    catalogKey: "mobile-service",
    unitType: "FLAT",
    priceProvenance: "TENANT_PRESET",
  };
  const draft = {
    quoteId: null,
    serviceType: "HVAC",
    title: "Mobile HVAC service",
    scopeText: "Inspect the equipment and complete the approved service.",
    squareFeetEstimate: null,
    squareFeetEstimateLow: null,
    squareFeetEstimateHigh: null,
    estimatedDurationHoursLow: 1,
    estimatedDurationHoursHigh: 2,
    customerPriceSubtotal: 120,
    taxAmount: 0,
    totalAmount: 120,
    internalCostSubtotal: 40,
    lineItems: [line],
    workspaceContext: [],
    requiresPricingReview: false,
  };
  const result = {
    status: "READY",
    customer: null,
    parsed: { customerName: "Jamie Mobile", serviceType: "HVAC" },
    aiRunId: "ai-run-mobile-ready-1234567890",
    usage: {
      consumedCredits: 1,
      consumedSpendUsd: 0.001,
      monthlyCreditsUsed: 1,
      monthlyCreditsLimit: 500,
      monthlyCreditsRemaining: 499,
      monthlySpendUsedUsd: 0.01,
      monthlySpendLimitUsd: 10,
      monthlySpendRemainingUsd: 9.99,
      monthlySpendUsagePercent: 1,
      estimatedPromptsRemaining: 499,
      renewsAtUtc: "2026-09-01T00:00:00.000Z",
    },
    preparation: {
      preparationId: "prep-mobile-ready",
      auditEventId: "audit-mobile-ready",
      status: "READY",
      customerResolution: "NEW_CUSTOMER_DRAFT",
      customer: null,
      customerCandidates: [],
      customerDraft: { fullName: "Jamie Mobile", phone: "555-013-4500", email: null },
      clarification: null,
      sources: [],
      retrievedSourceCount: 0,
      retrievedSourceLabels: [],
      retrievalAuditEventId: null,
      retrievalDegraded: false,
      model: "gpt-test",
      draft,
    },
    suggestion: { ...draft, model: "gpt-test" },
    patch: {
      added: 1,
      updated: 0,
      removed: 0,
      lineChanges: [{
        action: "ADD",
        targetLineId: null,
        previousDescription: null,
        reason: "Add the prepared mobile service.",
        ...line,
      }],
    },
    insight: {
      summary: "Prepared for mobile review.",
      reasons: ["Request parsed"],
      sources: [],
      confidence: { level: "high", label: "High confidence" },
      riskNote: null,
      patch: { added: 1, updated: 0, removed: 0 },
    },
  };

  await page.route(`${apiBaseUrl}/v1/quotes/ai-suggest`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: `${JSON.stringify({ type: "complete", result })}\n`,
    });
  });

  await addSessionCookie(context, account);
  await page.goto("/app/build");
  await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Prepare with Kody", exact: true }).click();
  const compose = page.getByRole("dialog", { name: "Prepare quote with Kody" });
  await compose.getByTestId("quote-kody-prompt").fill("Prepare an HVAC quote for Jamie Mobile at 555-013-4500.");
  await compose.getByRole("button", { name: "Prepare draft" }).click();

  const review = page.getByRole("dialog", { name: "Review Kody's draft" });
  await expect(review.getByTestId("quote-kody-review-heading")).toBeFocused();
  await expect(review.getByRole("status")).toHaveText("Review Kody's draft");
  await expect(review).toContainText("Mobile HVAC service");
  expect((await review.boundingBox())?.width).toBeLessThanOrEqual(393);
  expect((await review.getByRole("button", { name: "Edit request" }).boundingBox())?.height).toBeGreaterThanOrEqual(44);
  expect((await review.getByRole("button", { name: "Apply to quote" }).boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1);
});
