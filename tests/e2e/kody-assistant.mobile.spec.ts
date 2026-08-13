import { expect, test } from "@playwright/test";
import {
  addSessionCookie,
  apiBaseUrl,
  createCustomerViaApi,
  escapeRegExp,
  signUpViaApi,
} from "./helpers";

test("Kody mobile assistant shows data guardrails and hands off review-first actions", async ({
  context,
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const account = await signUpViaApi(request, "kody-mobile");
  const customer = await createCustomerViaApi(request, account, {
    fullName: "Kody Mobile Customer",
    phone: "555-018-1122",
    email: "kody-mobile@example.com",
  });
  const aiRequests: Array<{ tool?: string; message?: string; context?: Record<string, unknown> }> = [];
  const quoteCreateRequests: unknown[] = [];

  await page.route(`${apiBaseUrl}/v1/ai/assistant`, async (route) => {
    const body = route.request().postDataJSON() as {
      tool?: string;
      message?: string;
      context?: Record<string, unknown>;
    };
    aiRequests.push(body);
    const message = body.message ?? "";
    const generatedAtUtc = "2026-08-12T18:00:00.000Z";
    const diagnostics = (resolvedTool: "SEARCH_CUSTOMERS" | "DRAFT_QUOTE") => ({
      requestedTool: body.tool ?? "AUTO",
      resolvedTool,
      resultCount: 1,
      citationCount: 1,
      emptyReason: null,
      archivePolicy: resolvedTool === "SEARCH_CUSTOMERS"
        ? "Customer lookup searches active customers only; archived/deleted customers are excluded."
        : "Quote drafting context uses active tenant customers and quotes only.",
      filters: {
        currentPage: body.context?.currentPage === "quotes" || body.context?.currentPage === "customers"
          ? body.context.currentPage
          : null,
        includeArchivedRequested: false,
        includeArchivedEffective: false,
      },
      answerMode: "DETERMINISTIC",
      model: null,
    });
    const usage = {
      consumedCredits: 1,
      consumedSpendUsd: 0.001,
      monthlyCreditsUsed: 2,
      monthlyCreditsLimit: 500,
      monthlyCreditsRemaining: 498,
      monthlySpendUsedUsd: 0.02,
      monthlySpendLimitUsd: 10,
      monthlySpendRemainingUsd: 9.98,
      monthlySpendUsagePercent: 1,
      estimatedPromptCostUsd: 0.001,
      estimatedPromptsRemaining: 498,
      renewsAtUtc: "2026-09-01T00:00:00.000Z",
    };

    if (body.tool === "SEARCH_CUSTOMERS") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          assistant: {
            tool: "SEARCH_CUSTOMERS",
            generatedAtUtc,
            policyVersion: "2026-08-12",
            maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
            answer: `Found ${customer.fullName} in this workspace.`,
            results: [{
              customerId: customer.id,
              fullName: customer.fullName,
              phone: customer.phone,
              email: customer.email,
              followUpStatus: "NEW",
              quoteCount: 0,
            }],
            citations: [{
              key: "A1",
              label: "Active tenant customer lookup",
              sourceType: "Customer",
              classification: "C2_CUSTOMER_CONFIDENTIAL",
            }],
            actions: [{
              type: "OPEN_CUSTOMER",
              label: `Open ${customer.fullName}`,
              requiresConfirmation: false,
              payload: { customerId: customer.id },
            }],
            auditEventId: "audit-kody-mobile-customer-1234567890",
            fieldsExcluded: ["tenantId", "archived customers", "deleted customers"],
            diagnostics: diagnostics("SEARCH_CUSTOMERS"),
          },
          usage,
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        assistant: {
          tool: "DRAFT_QUOTE",
          generatedAtUtc,
          policyVersion: "2026-08-12",
          maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
          answer: "Prepared a preview for a roofing quote. Review it before creating or sending anything.",
          results: [{
            title: "Kody Mobile Roof Replacement",
            serviceType: "ROOFING",
            customerName: customer.fullName,
            estimatedTotalAmount: 12000,
            lineItemCount: 2,
          }],
          citations: [{
            key: "A1",
            label: "Parsed quote drafting prompt",
            sourceType: "Quote",
            classification: "C2_CUSTOMER_CONFIDENTIAL",
          }],
          actions: [{
            type: "OPEN_QUOTE_DRAFT",
            label: "Review quote draft",
            requiresConfirmation: true,
            payload: {
              prompt: message,
              customerId: customer.id,
              customerName: customer.fullName,
              serviceType: "ROOFING",
              title: "Kody Mobile Roof Replacement",
              scopeText: "Replace asphalt shingle roof, include tear-off, underlayment, flashing, cleanup, and disposal.",
              lineItems: [
                { description: "Tear-off, disposal, and roof prep", quantity: 1, sectionType: "INCLUDED", sectionLabel: null },
                { description: "Install asphalt shingles and flashing", quantity: 1, sectionType: "INCLUDED", sectionLabel: null },
              ],
            },
          }],
          auditEventId: "audit-kody-mobile-draft-1234567890",
          fieldsExcluded: ["tenantId", "internal cost totals", "deleted records"],
          diagnostics: diagnostics("DRAFT_QUOTE"),
        },
        usage,
      }),
    });
  });
  await page.route(`${apiBaseUrl}/v1/quotes`, async (route) => {
    if (route.request().method() === "POST") {
      quoteCreateRequests.push(route.request().postDataJSON());
    }
    await route.fallback();
  });

  await addSessionCookie(context, account);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/app/customers");
  await expect(page.getByRole("heading", { level: 1, name: "Customers", exact: true })).toBeVisible({ timeout: 30_000 });
  const kodyLauncher = page.getByTestId("kody-launcher");
  await expect(kodyLauncher).toBeVisible();
  expect((await kodyLauncher.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  const mobileNav = page.getByRole("navigation", { name: "Mobile workspace" });
  const launcherBox = await kodyLauncher.boundingBox();
  const navBox = await mobileNav.boundingBox();
  expect((launcherBox?.y ?? 0) + (launcherBox?.height ?? 0)).toBeLessThanOrEqual((navBox?.y ?? 0) - 4);

  await kodyLauncher.click();
  const kodyDialog = page.getByTestId("kody-chat-panel");
  await expect(kodyDialog).toBeVisible();
  await expect(kodyDialog).toHaveAttribute("role", "dialog");
  await expect(kodyDialog).toHaveAttribute("aria-modal", "false");
  await expect(page.locator("[data-radix-dialog-overlay]")).toHaveCount(0);
  await expect(kodyLauncher).toHaveAttribute("aria-expanded", "true");
  await mobileNav.getByRole("button", { name: "Quotes" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Quotes", exact: true })).toBeVisible();
  await expect(kodyDialog).toBeVisible();
  await mobileNav.getByRole("button", { name: "Customers" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Customers", exact: true })).toBeVisible();
  await expect(kodyDialog).toBeVisible();
  await expect(kodyDialog.getByText("Backend-only AI. Tenant-scoped data.")).toBeVisible();
  await kodyDialog.getByTestId("kody-quick-search_customers").click();
  await kodyDialog.getByTestId("kody-prompt").fill(`Find customer ${customer.fullName}`);
  await kodyDialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(kodyDialog.getByText(`Found ${customer.fullName} in this workspace.`)).toBeVisible();
  const guardrails = kodyDialog.getByTestId("kody-data-guardrails");
  await expect(guardrails).toContainText("Customer and quote context");
  await expect(guardrails).toContainText("Customer and quote context is limited to your signed-in workspace.");
  await expect(guardrails).toContainText("tenant boundary fields");
  await expect(guardrails).toContainText("archived records");
  await expect(kodyDialog.getByText("Policy class C2_CUSTOMER_CONFIDENTIAL")).toHaveClass(/sr-only/);

  await kodyDialog.getByRole("button", { name: `Open ${customer.fullName}` }).click();
  await expect(page.getByRole("heading", { name: `${customer.fullName} activity` })).toBeVisible();
  await expect(kodyDialog).toBeVisible();
  await page.getByRole("dialog", { name: "Customer details and activity" }).getByRole("button", { name: "Close modal" }).click();
  await kodyDialog.getByTestId("kody-prompt").focus();
  await page.keyboard.press("Escape");
  await expect(kodyDialog).toBeHidden();
  await expect(kodyLauncher).toHaveAttribute("aria-expanded", "false");
  await kodyLauncher.click();
  await expect(kodyDialog.getByText(`Found ${customer.fullName} in this workspace.`)).toBeVisible();
  await kodyDialog.getByRole("button", { name: "Close Kody" }).click();
  await expect(kodyDialog).toBeHidden();

  await page.goto("/app/build");
  await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("textbox", { name: /find customer by name/i }).fill(customer.fullName);
  await page.getByRole("button", { name: new RegExp(`${escapeRegExp(customer.fullName)}[\\s\\S]*Use`, "i") }).click();
  await page.getByLabel("Quote title").fill("Existing mobile draft should stay");
  await expect(page.locator(".qf-mobile-action-dock")).toBeVisible();
  const buildKodyBox = await page.getByTestId("kody-launcher").boundingBox();
  const buildActionDockBox = await page.locator(".qf-mobile-action-dock").boundingBox();
  expect((buildKodyBox?.y ?? 0) + (buildKodyBox?.height ?? 0)).toBeLessThanOrEqual((buildActionDockBox?.y ?? 0) - 4);

  await page.getByTestId("kody-launcher").click();
  const draftDialog = page.getByTestId("kody-chat-panel");
  await expect(draftDialog).toBeVisible();
  const draftPanelBox = await draftDialog.boundingBox();
  const visibleBuildActionDockBox = await page.locator(".qf-mobile-action-dock").boundingBox();
  expect((draftPanelBox?.y ?? 0) + (draftPanelBox?.height ?? 0)).toBeLessThanOrEqual((visibleBuildActionDockBox?.y ?? 0) - 4);
  await draftDialog.getByTestId("kody-quick-draft_quote").click();
  await draftDialog
    .getByTestId("kody-prompt")
    .fill(`Draft a quote for ${customer.fullName}: 20 squares asphalt shingle roof replacement around $12,000.`);
  await draftDialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(draftDialog.getByText("Prepared a preview for a roofing quote.")).toBeVisible();
  await expect(draftDialog.getByTestId("kody-data-guardrails")).toContainText("Customer and quote context");
  await draftDialog.getByRole("button", { name: "Review quote draft" }).click();
  const confirmKodyDraft = page.getByRole("dialog", { name: "Review Kody's quote draft?" });
  await expect(confirmKodyDraft).toContainText("Nothing will be saved or sent");
  await confirmKodyDraft.getByRole("button", { name: "Open review draft" }).click();

  await expect(page).toHaveURL(/\/app\/build$/);
  await expect(draftDialog).toBeVisible();
  await expect(page.getByLabel("Quote title")).toHaveValue("Existing mobile draft should stay");
  await expect(page.getByText("Kody prepared a quote prompt without changing your existing draft.")).toBeVisible();
  const kodyHandoff = page.getByTestId("kody-draft-handoff");
  await expect(kodyHandoff).toBeVisible();
  await expect(kodyHandoff).toContainText("Kody prepared a draft");
  await expect(kodyHandoff).toContainText("Not saved");
  await expect(kodyHandoff).toContainText("Not sent");
  await expect(kodyHandoff).toContainText(customer.fullName);
  await expect(kodyHandoff).toContainText("Kody Mobile Roof Replacement");
  await expect(kodyHandoff).toContainText("Tear-off, disposal, and roof prep");
  await expect(kodyHandoff).toContainText("Nothing is saved to the quote list or sent to the customer");
  const quoteAiDialog = page.getByRole("dialog", { name: "Draft quote with AI" });
  await expect(quoteAiDialog).toBeVisible();
  await expect(page.getByTestId("quote-ai-prompt")).toHaveValue(/20 squares asphalt shingle roof replacement/);
  expect(quoteCreateRequests).toHaveLength(0);

  expect(aiRequests).toEqual(expect.arrayContaining([
    expect.objectContaining({
      tool: "SEARCH_CUSTOMERS",
      context: expect.objectContaining({ currentPage: "customers" }),
    }),
    expect.objectContaining({
      tool: "DRAFT_QUOTE",
      context: expect.objectContaining({ currentPage: "quotes" }),
    }),
  ]));
  expect(JSON.stringify(aiRequests)).not.toContain(account.tenant.id);
});

test("Kody applies a parsed quote draft to an empty mobile builder without saving it", async ({
  context,
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const account = await signUpViaApi(request, "kody-prefill");
  const customer = await createCustomerViaApi(request, account, {
    fullName: "Kody Prefill Customer",
    phone: "555-018-1199",
    email: "kody-prefill@example.com",
  });
  const aiRequests: Array<{ tool?: string; message?: string; context?: Record<string, unknown> }> = [];

  await page.route(`${apiBaseUrl}/v1/ai/assistant`, async (route) => {
    const body = route.request().postDataJSON() as {
      tool?: string;
      message?: string;
      context?: Record<string, unknown>;
    };
    aiRequests.push(body);
    const message = body.message ?? "";

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        assistant: {
          tool: "DRAFT_QUOTE",
          generatedAtUtc: "2026-08-12T18:30:00.000Z",
          policyVersion: "2026-08-12",
          maxClassification: "C2_CUSTOMER_CONFIDENTIAL",
          answer: "Prepared a preview for a roofing quote. Review it before creating or sending anything.",
          results: [{
            title: "Kody Prefill Roof Replacement",
            serviceType: "ROOFING",
            customerName: customer.fullName,
            estimatedTotalAmount: 12000,
            lineItemCount: 2,
          }],
          citations: [{
            key: "A1",
            label: "Parsed quote drafting prompt",
            sourceType: "Quote",
            classification: "C2_CUSTOMER_CONFIDENTIAL",
          }],
          actions: [{
            type: "OPEN_QUOTE_DRAFT",
            label: "Review quote draft",
            requiresConfirmation: true,
            payload: {
              prompt: message,
              customerId: customer.id,
              customerName: customer.fullName,
              serviceType: "ROOFING",
              title: "Kody Prefill Roof Replacement",
              scopeText: "Replace asphalt shingle roof, include tear-off, underlayment, flashing, cleanup, and disposal.",
              estimatedTotalAmount: 12000,
              lineItems: [
                { description: "Tear-off, disposal, and roof prep", quantity: 1, sectionType: "INCLUDED", sectionLabel: null },
                { description: "Install asphalt shingles and flashing", quantity: 1, sectionType: "INCLUDED", sectionLabel: null },
              ],
            },
          }],
          auditEventId: "audit-kody-prefill-draft-1234567890",
          fieldsExcluded: ["tenantId", "internal cost totals", "deleted records"],
          diagnostics: {
            requestedTool: body.tool ?? "AUTO",
            resolvedTool: "DRAFT_QUOTE",
            resultCount: 1,
            citationCount: 1,
            emptyReason: null,
            archivePolicy: "Quote drafting context uses active tenant customers and quotes only.",
            filters: {
              currentPage: body.context?.currentPage === "quotes" ? body.context.currentPage : null,
              includeArchivedRequested: false,
              includeArchivedEffective: false,
            },
            answerMode: "DETERMINISTIC",
            model: null,
          },
        },
        usage: {
          consumedCredits: 1,
          consumedSpendUsd: 0.001,
          monthlyCreditsUsed: 2,
          monthlyCreditsLimit: 500,
          monthlyCreditsRemaining: 498,
          monthlySpendUsedUsd: 0.02,
          monthlySpendLimitUsd: 10,
          monthlySpendRemainingUsd: 9.98,
          monthlySpendUsagePercent: 1,
          estimatedPromptCostUsd: 0.001,
          estimatedPromptsRemaining: 498,
          renewsAtUtc: "2026-09-01T00:00:00.000Z",
        },
      }),
    });
  });

  await addSessionCookie(context, account);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/build");
  await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("kody-launcher").click();
  const kodyDialog = page.getByTestId("kody-chat-panel");
  await expect(kodyDialog).toBeVisible();
  await kodyDialog.getByTestId("kody-quick-draft_quote").click();
  await kodyDialog
    .getByTestId("kody-prompt")
    .fill(`Draft a quote for ${customer.fullName}: 20 squares asphalt shingle roof replacement around $12,000.`);
  await kodyDialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(kodyDialog.getByText("Prepared a preview for a roofing quote.")).toBeVisible();
  await kodyDialog.getByRole("button", { name: "Review quote draft" }).click();
  const confirmKodyDraft = page.getByRole("dialog", { name: "Review Kody's quote draft?" });
  await expect(confirmKodyDraft).toContainText("Nothing will be saved or sent");
  await confirmKodyDraft.getByRole("button", { name: "Open review draft" }).click();
  await kodyDialog.getByRole("button", { name: "Close Kody" }).click();

  await expect(page).toHaveURL(/\/app\/build$/);
  await expect(page.getByText("Kody prepared a review draft in the builder.")).toBeVisible();
  await expect(page.getByTestId("kody-draft-handoff")).toContainText("Not saved");
  await expect(page.getByTestId("kody-draft-handoff")).toContainText("Not sent");
  await expect(page.getByTestId("kody-draft-handoff")).toContainText("Pricing still needs review");
  await expect(page.getByRole("dialog", { name: "Draft quote with AI" })).toHaveCount(0);
  await expect(page.getByLabel("Quote title")).toHaveValue("Kody Prefill Roof Replacement");
  await expect(page.getByLabel("Quote overview")).toHaveValue(/Replace asphalt shingle roof/);
  await expect(page.getByTestId("quote-line-row-1")).toContainText("Tear-off, disposal, and roof prep");
  await expect(page.getByTestId("quote-line-row-2")).toContainText("Install asphalt shingles and flashing");
  expect(aiRequests).toEqual([
    expect.objectContaining({
      tool: "DRAFT_QUOTE",
      context: expect.objectContaining({ currentPage: "quotes" }),
    }),
  ]);
  expect(JSON.stringify(aiRequests)).not.toContain(account.tenant.id);
});
