import { expect, test } from "@playwright/test";
import { addSessionCookie, apiBaseUrl, signUpViaApi } from "./helpers";

test("superuser AI quality page can run a Kody response test with diagnostics", async ({
  context,
  page,
  request,
}) => {
  const account = await signUpViaApi(
    request,
    "superuser-ai-quality",
    "superuser-e2e@example.com",
  );
  await addSessionCookie(context, account);

  await page.route(`${apiBaseUrl}/v1/internal/ai-quality/summary*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        windowDays: 30,
        windowStartUtc: "2026-07-13T00:00:00.000Z",
        generatedAtUtc: "2026-08-12T18:00:00.000Z",
        totals: {
          totalRuns: 12,
          activeTenants: 1,
          totalCreditsConsumed: 12,
          totalSpendUsd: 0.12,
          totalPromptTokens: 1200,
          totalCompletionTokens: 600,
          totalTokens: 1800,
        },
        averages: {
          spendUsdPerRun: 0.01,
          promptTokensPerRun: 100,
          completionTokensPerRun: 50,
          totalTokensPerRun: 150,
        },
        confidence: {
          high: 10,
          medium: 2,
          low: 0,
        },
        quality: {
          noPatchRuns: 1,
          noPatchRatePct: 8.33,
          lowConfidenceRuns: 0,
          lowConfidenceRatePct: 0,
          regexFallbackRuns: 0,
          regexFallbackRatePct: 0,
        },
        qualitySignals: [
          { key: "no_patch_mutation", label: "No patch mutation", count: 1, ratePct: 8.33 },
          { key: "low_confidence_context", label: "Low confidence context", count: 0, ratePct: 0 },
          { key: "regex_fallback_runtime", label: "Regex fallback runtime", count: 0, ratePct: 0 },
        ],
        models: [{
          model: "gpt-test",
          runCount: 12,
          spendUsd: 0.12,
          averageTokensPerRun: 150,
        }],
        tradeBreakdown: [{
          trade: "ROOFING",
          runCount: 12,
          draftRuns: 5,
          reviseRuns: 1,
          spendUsd: 0.12,
          averageTokensPerRun: 150,
          noPatchRuns: 1,
          noPatchRatePct: 8.33,
          lowConfidenceRuns: 0,
          lowConfidenceRatePct: 0,
          regexFallbackRuns: 0,
          regexFallbackRatePct: 0,
        }],
      }),
    });
  });

  await page.route(`${apiBaseUrl}/v1/internal/ai-quality/tenants*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        windowDays: 30,
        windowStartUtc: "2026-07-13T00:00:00.000Z",
        tenants: [{
          tenantId: "tenant-redacted",
          tenantName: "QuoteFly Beta Test",
          runCount: 12,
          spendUsd: 0.12,
          averageSpendUsdPerRun: 0.01,
          averageTokensPerRun: 150,
          noPatchRuns: 1,
          noPatchRatePct: 8.33,
          lowConfidenceRuns: 0,
          lowConfidenceRatePct: 0,
          regexFallbackRuns: 0,
          regexFallbackRatePct: 0,
        }],
      }),
    });
  });

  const aiRequests: Array<{
    message?: string;
    tool?: string;
    context?: Record<string, unknown>;
  }> = [];
  await page.route(`${apiBaseUrl}/v1/internal/ai-quality/assistant-test`, async (route) => {
    const body = route.request().postDataJSON() as {
      message?: string;
      tool?: string;
      context?: Record<string, unknown>;
    };
    aiRequests.push(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        assistant: {
          tool: "RANK_PROFITABLE_JOBS",
          generatedAtUtc: "2026-08-12T18:05:00.000Z",
          policyVersion: "2026-08-12",
          maxClassification: "C3_FINANCIAL_CONFIDENTIAL",
          answer: "Kody test console response: roofing is the strongest profit category because cited job rows show higher margin.",
          results: [{
            serviceType: "ROOFING",
            revenueAmount: 18000,
            grossProfitAmount: 7200,
            grossMarginPercent: 40,
          }],
          citations: [{
            key: "A1",
            label: "Tenant profitability aggregate",
            sourceType: "Quote",
            classification: "C3_FINANCIAL_CONFIDENTIAL",
          }],
          actions: [{
            type: "OPEN_ANALYTICS",
            label: "Review profitability",
            requiresConfirmation: false,
            payload: {
              insightTool: "SERVICE_PROFITABILITY",
              dateFrom: "2026-05-14T00:00:00.000Z",
              dateTo: "2026-08-12T00:00:00.000Z",
              serviceType: null,
            },
          }],
          auditEventId: "audit-superuser-kody-console-1234567890",
          fieldsExcluded: ["tenant ids", "deleted rows", "provider identifiers"],
          diagnostics: {
            requestedTool: "AUTO",
            resolvedTool: "RANK_PROFITABLE_JOBS",
            resultCount: 1,
            citationCount: 1,
            emptyReason: null,
            archivePolicy: "Archived/deleted quote aggregates were excluded by the current role policy.",
            filters: {
              currentPage: "analytics",
              businessInsightTool: "SERVICE_PROFITABILITY",
              dateField: "Quote.createdAt",
              dateFrom: "2026-05-14T00:00:00.000Z",
              dateTo: "2026-08-12T00:00:00.000Z",
              serviceType: null,
              limit: 5,
              includeArchivedRequested: false,
              includeArchivedEffective: false,
            },
          },
        },
        usage: {
          consumedCredits: 1,
          consumedSpendUsd: 0.001,
          monthlyCreditsUsed: 3,
          monthlyCreditsLimit: null,
          monthlyCreditsRemaining: null,
          monthlySpendUsedUsd: 0.03,
          monthlySpendLimitUsd: null,
          monthlySpendRemainingUsd: null,
          monthlySpendUsagePercent: 0,
          estimatedPromptCostUsd: 0.001,
          estimatedPromptsRemaining: null,
          renewsAtUtc: "2026-09-01T00:00:00.000Z",
        },
      }),
    });
  });

  await page.goto("/app/internal/admin/ai-quality");
  await expect(page.getByRole("heading", { level: 1, name: "Superuser AI Quality" })).toBeVisible({ timeout: 15_000 });

  const consoleCard = page.getByTestId("superuser-kody-test-console");
  await expect(consoleCard).toBeVisible();
  await consoleCard.getByLabel("Search hint").fill("roofing margin");
  await consoleCard.getByLabel("Limit").fill("5");
  await consoleCard.getByRole("button", { name: "Run Kody test" }).click();

  const responsePanel = page.getByTestId("superuser-kody-test-response");
  await expect(responsePanel.getByText("Kody test console response")).toBeVisible();
  await expect(responsePanel.getByText("audit-superuser-kody-console-1234567890")).toBeVisible();
  await expect(responsePanel.getByText("Tenant profitability aggregate")).toBeVisible();
  await expect(responsePanel.getByText("Effective retrieval diagnostics")).toBeVisible();
  await expect(responsePanel.getByText("Archived/deleted quote aggregates were excluded by the current role policy.")).toBeVisible();
  await expect(responsePanel.getByText("Quote.createdAt")).toBeVisible();
  await expect(responsePanel.getByText("includeArchivedEffective")).toBeVisible();
  await expect(responsePanel.getByRole("button", { name: "Copy visible evidence JSON" })).toBeVisible();
  await expect(responsePanel.getByText('"auditEventId": "audit-superuser-kody-console-1234567890"')).toBeHidden();
  await expect(responsePanel.getByText("1 structured result row hidden until sensitive diagnostics are revealed.")).toBeVisible();

  await responsePanel.getByRole("button", { name: "Reveal sensitive diagnostics" }).click();
  await responsePanel.getByText("Request JSON").click();
  await expect(responsePanel.getByText('"currentPage": "analytics"').first()).toBeVisible();
  await expect(responsePanel.getByText('"search": "roofing margin"')).toBeVisible();
  await responsePanel.getByText("Response JSON").click();
  await expect(responsePanel.getByText('"auditEventId": "audit-superuser-kody-console-1234567890"')).toBeVisible();

  expect(aiRequests).toHaveLength(1);
  expect(aiRequests[0]).toEqual(expect.objectContaining({
    message: expect.stringContaining("Rank profitable jobs"),
    tool: "AUTO",
    context: expect.objectContaining({
      currentPage: "analytics",
      search: "roofing margin",
      limit: 5,
      includeArchived: false,
      dateFrom: expect.any(String),
      dateTo: expect.any(String),
    }),
  }));
  expect(JSON.stringify(aiRequests)).not.toContain(account.tenant.id);
});
