import { expect, test } from "@playwright/test";
import { addSessionCookie, apiBaseUrl, createCustomerViaApi, signUpViaApi } from "./helpers";

const usage = {
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
};

function directReadyResult(customer: Record<string, unknown>) {
  const line = {
    description: "Authoritative customer check\nComplete the approved service after verifying the customer.",
    sectionType: "INCLUDED",
    sectionLabel: null,
    quantity: 1,
    unitCost: 25,
    unitPrice: 100,
    sourcePresetId: "preset-check",
    catalogKey: "customer-check",
    unitType: "FLAT",
    priceProvenance: "TENANT_PRESET",
  };
  const draft = {
    quoteId: null,
    serviceType: "HVAC",
    title: "Verified customer service",
    scopeText: "Verify the active customer record, then complete the approved service.",
    squareFeetEstimate: null,
    squareFeetEstimateLow: null,
    squareFeetEstimateHigh: null,
    estimatedDurationHoursLow: 1,
    estimatedDurationHoursHigh: 2,
    customerPriceSubtotal: 100,
    taxAmount: 0,
    totalAmount: 100,
    internalCostSubtotal: 25,
    lineItems: [line],
    workspaceContext: [],
    requiresPricingReview: false,
  };
  return {
    status: "READY",
    customer,
    parsed: { customerName: customer.fullName, serviceType: "HVAC" },
    aiRunId: "ai-run-direct-ready-1234567890",
    usage,
    preparation: {
      preparationId: "prep-direct-ready",
      auditEventId: "audit-prep-direct-ready",
      status: "READY",
      customerResolution: "MATCHED",
      customer,
      customerCandidates: [],
      customerDraft: { fullName: customer.fullName, email: customer.email, phone: customer.phone },
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
        reason: "Add the prepared service.",
        ...line,
      }],
    },
    insight: {
      summary: "Prepared from the matched customer.",
      reasons: ["Customer matched"],
      sources: [],
      confidence: { level: "high", label: "High confidence" },
      riskNote: null,
      patch: { added: 1, updated: 0, removed: 0 },
    },
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("qf_locale", "en-US"));
});

test("Kody resolves an ambiguous customer, reviews placement, and applies separate quote lines", async ({
  context,
  page,
  request,
}) => {
  const account = await signUpViaApi(request, "kody-prepare-review");
  const customer = await createCustomerViaApi(request, account, {
    fullName: "Alex Rivera",
    phone: "555-013-4200",
    email: "alex.rivera@example.com",
  });
  const otherCustomer = await createCustomerViaApi(request, account, {
    fullName: "Alex Rios",
    phone: "555-013-4201",
    email: "alex.rios@example.com",
  });
  const quoteAiRequests: Array<Record<string, unknown>> = [];
  let quoteCreateRequests = 0;

  await page.route(`${apiBaseUrl}/v1/quotes/ai-suggest`, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    quoteAiRequests.push(body);
    const basePreparation = {
      preparationId: `prep-${quoteAiRequests.length}`,
      auditEventId: `audit-prep-${quoteAiRequests.length}`,
      customerDraft: {
        fullName: "Alex",
        email: null,
        phone: null,
      },
      sources: [],
      retrievedSourceCount: 0,
      retrievedSourceLabels: [],
      retrievalAuditEventId: null,
      retrievalDegraded: false,
      model: "gpt-test",
    };
    const parsed = { customerName: "Alex", serviceType: "PLUMBING" };

    if (!body.customerId) {
      const result = {
        status: "CUSTOMER_AMBIGUOUS",
        customer: null,
        parsed,
        aiRunId: "ai-run-ambiguous",
        usage,
        preparation: {
          ...basePreparation,
          status: "CUSTOMER_AMBIGUOUS",
          customerResolution: "AMBIGUOUS",
          customer: null,
          customerCandidates: [customer, otherCustomer],
          clarification: {
            code: "CUSTOMER_SELECTION_REQUIRED",
            message: "I found two Alex customer records. Choose the right customer to continue.",
          },
          draft: {
            quoteId: null,
            serviceType: "PLUMBING",
            title: "",
            scopeText: "",
            squareFeetEstimate: null,
            squareFeetEstimateLow: null,
            squareFeetEstimateHigh: null,
            estimatedDurationHoursLow: 3,
            estimatedDurationHoursHigh: 4,
            customerPriceSubtotal: 0,
            taxAmount: 0,
            totalAmount: 0,
            lineItems: [],
            workspaceContext: [],
            requiresPricingReview: false,
          },
        },
      };
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: `${JSON.stringify({ type: "complete", result })}\n`,
      });
      return;
    }

    const lines = [
      {
        description: "Inspection and repair labor\nInspect damage and complete up to four labor hours.",
        sectionType: "INCLUDED",
        sectionLabel: null,
        quantity: 4,
        unitCost: 45,
        unitPrice: 100,
        sourcePresetId: "preset-labor",
        catalogKey: "plumbing-labor",
        unitType: "HOUR",
        priceProvenance: "TENANT_PRESET",
      },
      {
        description: "Repair materials\nSupply standard fittings and repair materials.",
        sectionType: "INCLUDED",
        sectionLabel: null,
        quantity: 1,
        unitCost: 65,
        unitPrice: 150,
        sourcePresetId: "preset-materials",
        catalogKey: "plumbing-materials",
        unitType: "FLAT",
        priceProvenance: "TENANT_PRESET",
      },
    ];
    const result = {
      status: "READY",
      customer,
      parsed,
      aiRunId: "ai-run-ready-1234567890",
      usage,
      preparation: {
        ...basePreparation,
        status: "READY",
        customerResolution: "MATCHED",
        customer,
        customerCandidates: [],
        clarification: null,
        sources: [
          { key: "A1", label: "Plumbing labor", sourceType: "WorkPreset", classification: "C1_BUSINESS_INTERNAL" },
          { key: "A2", label: "Repair materials", sourceType: "WorkPreset", classification: "C1_BUSINESS_INTERNAL" },
        ],
        retrievedSourceCount: 2,
        retrievedSourceLabels: ["Plumbing labor", "Repair materials"],
        draft: {
          quoteId: null,
          serviceType: "PLUMBING",
          title: "Plumbing inspection and repair",
          scopeText: "Inspect the reported damage, complete the approved repair, and confirm operation with the customer.",
          squareFeetEstimate: null,
          squareFeetEstimateLow: null,
          squareFeetEstimateHigh: null,
          estimatedDurationHoursLow: 3,
          estimatedDurationHoursHigh: 4,
          customerPriceSubtotal: 550,
          taxAmount: 0,
          totalAmount: 550,
          internalCostSubtotal: 245,
          lineItems: lines,
          workspaceContext: [
            { citationKey: "A1", label: "Plumbing labor", sourceType: "WorkPreset", fact: "Four labor hours at the saved rate." },
            { citationKey: "A2", label: "Repair materials", sourceType: "WorkPreset", fact: "Standard repair materials." },
          ],
          requiresPricingReview: false,
        },
      },
      suggestion: {
        serviceType: "PLUMBING",
        title: "Plumbing inspection and repair",
        scopeText: "Inspect the reported damage, complete the approved repair, and confirm operation with the customer.",
        internalCostSubtotal: 245,
        customerPriceSubtotal: 550,
        taxAmount: 0,
        totalAmount: 550,
        requiresPricingReview: false,
        model: "gpt-test",
        lineItems: lines,
      },
      patch: {
        added: 2,
        updated: 0,
        removed: 0,
        lineChanges: lines.map((line) => ({
          action: "ADD",
          targetLineId: null,
          previousDescription: null,
          reason: "Add a separate saved-work line.",
          ...line,
        })),
      },
      insight: {
        summary: "Prepared from the selected customer and saved plumbing work.",
        reasons: ["Customer confirmed", "Saved pricing used"],
        sources: [{ type: "saved_jobs", label: "Saved plumbing work" }],
        confidence: { level: "high", label: "High confidence" },
        riskNote: null,
        patch: { added: 2, updated: 0, removed: 0 },
      },
    };
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: `${JSON.stringify({ type: "complete", result })}\n`,
    });
  });
  await page.route(`${apiBaseUrl}/v1/quotes`, async (route) => {
    if (route.request().method() === "POST") quoteCreateRequests += 1;
    await route.fallback();
  });

  await addSessionCookie(context, account);
  await page.goto("/app/build");
  await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Prepare with Kody", exact: true }).click();
  const compose = page.getByRole("dialog", { name: "Prepare quote with Kody" });
  await expect(compose.getByRole("textbox")).toHaveCount(1);
  await expect(compose.getByRole("combobox", { name: "Trade hint" })).toHaveValue("AUTO");
  await compose.getByTestId("quote-kody-prompt").fill(
    "Kody, prepare a plumbing quote for Alex. The repair should take 3-4 hours after inspection. Separate labor and materials.",
  );
  await compose.getByRole("button", { name: "Prepare draft" }).click();

  await expect(compose.getByText("I found two Alex customer records. Choose the right customer to continue.")).toBeVisible();
  const customerChoice = compose.getByRole("button", { name: /Alex Rivera[\s\S]*Choose/ });
  await customerChoice.focus();
  await expect(customerChoice).toBeFocused();
  await customerChoice.press("Enter");

  const review = page.getByRole("dialog", { name: "Review Kody's draft" });
  await expect(review.getByTestId("quote-kody-review-heading")).toBeFocused();
  await expect(review.getByRole("status")).toHaveText("Review Kody's draft");
  await expect(review).toContainText("Matched customer");
  await expect(review).toContainText("Plumbing inspection and repair");
  await expect(review).toContainText("2 separate line items");
  await expect(review).toContainText("Inspection and repair labor");
  await expect(review).toContainText("Repair materials");
  await expect(review.getByText("Context used (2 sources)")).toBeVisible();
  await expect(page.getByLabel("Quote title")).toHaveValue("");
  expect(quoteCreateRequests).toBe(0);

  await review.getByRole("button", { name: "Apply to quote" }).click();
  await expect(page.getByLabel("Quote title")).toHaveValue("Plumbing inspection and repair");
  await expect(page.getByLabel("Quote overview")).toHaveValue(/Inspect the reported damage/);
  await expect(page.getByTestId("quote-line-row-1")).toContainText("Inspection and repair labor");
  await expect(page.getByTestId("quote-line-row-2")).toContainText("Repair materials");
  await expect(page.getByText("Alex Rivera").filter({ visible: true }).first()).toBeVisible();
  expect(quoteCreateRequests).toBe(0);

  expect(quoteAiRequests).toHaveLength(2);
  expect(quoteAiRequests[0]).not.toHaveProperty("customerId");
  expect(quoteAiRequests[0]).not.toHaveProperty("serviceType");
  expect(quoteAiRequests[1]).toEqual(expect.objectContaining({ customerId: customer.id }));
});

test("direct READY focuses review and an archived customer cannot mutate the quote", async ({
  context,
  page,
  request,
}) => {
  const account = await signUpViaApi(request, "kody-prepare-archived-refresh");
  const customer = await createCustomerViaApi(request, account, {
    fullName: "Morgan Stale",
    phone: "555-013-4300",
    email: "morgan.stale@example.com",
  });

  await page.route(`${apiBaseUrl}/v1/quotes/ai-suggest`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: `${JSON.stringify({ type: "complete", result: directReadyResult(customer as unknown as Record<string, unknown>) })}\n`,
    });
  });

  await addSessionCookie(context, account);
  await page.goto("/app/build");
  await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Prepare with Kody", exact: true }).click();
  const compose = page.getByRole("dialog", { name: "Prepare quote with Kody" });
  await compose.getByTestId("quote-kody-prompt").fill("Prepare an HVAC service quote for Morgan Stale.");
  await compose.getByRole("button", { name: "Prepare draft" }).click();

  const review = page.getByRole("dialog", { name: "Review Kody's draft" });
  await expect(review.getByTestId("quote-kody-review-heading")).toBeFocused();
  await page.route(`${apiBaseUrl}/v1/customers/${customer.id}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        customer: { ...customer, archivedAtUtc: "2026-08-26T12:00:00.000Z" },
        quotes: [],
      }),
    });
  });

  await review.getByRole("button", { name: "Apply to quote" }).click();
  await expect(review).toContainText("QuoteFly could not verify that record");
  await expect(page.getByLabel("Quote title")).toHaveValue("");
  await expect(page.getByTestId("quote-line-row-1").locator('[aria-label="Existing line 1 title"]:visible')).toHaveValue("");
  await expect(review).toBeVisible();
});

test("a changed builder state rejects stale Apply without partial mutation", async ({ context, page, request }) => {
  const account = await signUpViaApi(request, "kody-prepare-stale-builder");
  const customer = await createCustomerViaApi(request, account, {
    fullName: "Taylor Current",
    phone: "555-013-4400",
    email: "taylor.current@example.com",
  });

  await page.route(`${apiBaseUrl}/v1/quotes/ai-suggest`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: `${JSON.stringify({ type: "complete", result: directReadyResult(customer as unknown as Record<string, unknown>) })}\n`,
    });
  });

  await addSessionCookie(context, account);
  await page.goto("/app/build");
  await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Prepare with Kody", exact: true }).click();
  const compose = page.getByRole("dialog", { name: "Prepare quote with Kody" });
  await compose.getByTestId("quote-kody-prompt").fill("Prepare an HVAC quote for Taylor Current.");
  await compose.getByRole("button", { name: "Prepare draft" }).click();

  let review = page.getByRole("dialog", { name: "Review Kody's draft" });
  await expect(review.getByTestId("quote-kody-review-heading")).toBeFocused();
  await review.getByRole("button", { name: "Close modal" }).click();
  const trade = page.getByRole("combobox", { name: "Trade" }).filter({ visible: true }).first();
  await trade.selectOption("ROOFING");
  await page.getByLabel("Quote title").fill("Operator's newer quote title");
  const lineTitle = page.getByTestId("quote-line-row-1").locator('[aria-label="Existing line 1 title"]:visible');
  await lineTitle.fill("Operator's newer line");

  await page.getByRole("button", { name: "Prepare with Kody", exact: true }).click();
  review = page.getByRole("dialog", { name: "Review Kody's draft" });
  await review.getByRole("button", { name: "Apply to quote" }).click();

  await expect(review).toContainText("The quote changed after Kody prepared this review");
  await expect(trade).toHaveValue("ROOFING");
  await expect(page.getByLabel("Quote title")).toHaveValue("Operator's newer quote title");
  await expect(lineTitle).toHaveValue("Operator's newer line");
  await expect(page.getByTestId("quote-line-row-2")).toHaveCount(0);
});
