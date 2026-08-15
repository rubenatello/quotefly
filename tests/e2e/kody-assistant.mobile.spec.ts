import { expect, test, type Locator } from "@playwright/test";
import {
  addSessionCookie,
  apiBaseUrl,
  createCustomerViaApi,
  escapeRegExp,
  signUpViaApi,
} from "./helpers";

async function revealKodyQuickPrompts(panel: Locator) {
  const prompts = panel.getByTestId("kody-quick-prompts");
  const open = await prompts.evaluate((element) => (element as HTMLDetailsElement).open);
  if (!open) await prompts.locator("summary").click();
}

test("Kody navigates on mobile while keeping the conversation open", async ({ context, page, request }) => {
  test.setTimeout(60_000);
  const account = await signUpViaApi(request, "kody-navigation-mobile");

  await page.route(`${apiBaseUrl}/v1/ai/assistant`, async (route) => {
    const body = route.request().postDataJSON() as { tool?: string; message?: string };
    expect(body.tool).toBe("AUTO");
    expect(body.message).toBe("Take me to products");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        assistant: {
          tool: "NAVIGATE_WORKSPACE",
          generatedAtUtc: "2026-08-13T18:00:00.000Z",
          policyVersion: "2026-08-12",
          maxClassification: "C1_BUSINESS_INTERNAL",
          answer: "I can take you to Products. Your Kody conversation will stay open while you move.",
          results: [],
          citations: [],
          actions: [{
            type: "OPEN_WORKSPACE_PAGE",
            label: "Open Products",
            requiresConfirmation: false,
            payload: { page: "products" },
          }],
          auditEventId: "audit-kody-navigation-mobile",
          fieldsExcluded: ["tenant ids", "deleted rows"],
          diagnostics: {
            requestedTool: "AUTO",
            resolvedTool: "NAVIGATE_WORKSPACE",
            resultCount: 0,
            citationCount: 0,
            emptyReason: null,
            archivePolicy: "Navigation does not retrieve customer or quote rows.",
            filters: { targetPage: "products" },
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
          monthlySpendUsedUsd: 0,
          monthlySpendLimitUsd: 1.25,
          monthlySpendRemainingUsd: 1.25,
          monthlySpendUsagePercent: 0,
          estimatedPromptCostUsd: 0.001615,
          estimatedPromptsRemaining: 773,
          renewsAtUtc: "2026-09-01T00:00:00.000Z",
        },
      }),
    });
  });

  await addSessionCookie(context, account);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/customers");
  await expect(page.getByRole("heading", { level: 1, name: "Customers", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("kody-launcher").click();
  const kody = page.getByTestId("kody-chat-panel");
  await kody.getByTestId("kody-prompt").fill("Take me to products");
  await kody.getByRole("button", { name: "Send", exact: true }).click();
  await expect(kody.getByText("I can take you to Products.", { exact: false })).toBeVisible();
  await kody.getByRole("button", { name: "Open Products" }).click();
  await expect(page).toHaveURL(/\/app\/products$/);
  await expect(page.getByRole("heading", { level: 1, name: "Products & services", exact: true })).toBeVisible();
  await expect(kody).toBeVisible();
  await expect(kody.getByText("Take me to products", { exact: true })).toBeVisible();
  await expect(kody.getByText("Your Kody conversation will stay open", { exact: false })).toBeVisible();
});

test("Kody feedback controls are mobile-friendly and save optional notes", async ({ context, page, request }) => {
  test.setTimeout(60_000);
  const account = await signUpViaApi(request, "kody-feedback-mobile");
  const feedbackRequests: Array<{ rating?: string; note?: string | null }> = [];

  await page.route(`${apiBaseUrl}/v1/ai/assistant`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        assistant: {
          tool: "ASSISTANT_HELP",
          generatedAtUtc: "2026-08-14T18:00:00.000Z",
          policyVersion: "2026-08-11",
          maxClassification: "C1_BUSINESS_INTERNAL",
          answer: "I can help with customers, quotes, products, follow-ups, pipeline, and profitability inside QuoteFly.",
          results: [],
          citations: [],
          actions: [],
          auditEventId: "audit-kody-feedback-mobile",
          fieldsExcluded: ["tenant ids", "deleted rows"],
          diagnostics: {
            requestedTool: "AUTO",
            resolvedTool: "ASSISTANT_HELP",
            resultCount: 0,
            citationCount: 0,
            emptyReason: null,
            archivePolicy: "Capability help does not retrieve workspace records.",
            filters: { modelCalled: false },
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
          monthlySpendUsedUsd: 0,
          monthlySpendLimitUsd: 1.25,
          monthlySpendRemainingUsd: 1.25,
          monthlySpendUsagePercent: 0,
          estimatedPromptCostUsd: 0.001615,
          estimatedPromptsRemaining: 773,
          renewsAtUtc: "2026-09-01T00:00:00.000Z",
        },
      }),
    });
  });
  await page.route(`${apiBaseUrl}/v1/ai/assistant/audit-kody-feedback-mobile/feedback`, async (route) => {
    const body = route.request().postDataJSON() as { rating?: string; note?: string | null };
    feedbackRequests.push(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        feedback: {
          rating: body.rating,
          note: body.note ?? null,
          updatedAt: "2026-08-14T18:01:00.000Z",
        },
      }),
    });
  });

  await addSessionCookie(context, account);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/customers");
  await expect(page.getByRole("heading", { level: 1, name: "Customers", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("kody-launcher").click();
  const kody = page.getByTestId("kody-chat-panel");
  await kody.getByTestId("kody-prompt").fill("What can you do?");
  await kody.getByRole("button", { name: "Send", exact: true }).click();

  const thumbsDown = kody.getByRole("button", { name: "Poor response" });
  const thumbsUp = kody.getByRole("button", { name: "Good response" });
  await expect(thumbsDown).toHaveCSS("height", "44px");
  await thumbsDown.click();
  await expect(thumbsDown).toHaveAttribute("aria-pressed", "true");
  await expect(kody.getByText("Thanks—this helps Kody improve.")).toBeVisible();
  const note = "I asked about products, but Kody searched customers.";
  await expect(kody.getByTestId("kody-feedback-note-panel")).toBeVisible();
  await kody.getByTestId("kody-feedback-note").fill(note);
  await kody.getByRole("button", { name: "Save note" }).click();
  await expect(kody.getByText("Thanks—your note was saved.")).toBeVisible();
  await thumbsUp.click();
  await expect(thumbsUp).toHaveAttribute("aria-pressed", "true");
  expect(feedbackRequests).toEqual([
    { rating: "DOWN" },
    { rating: "DOWN", note },
    { rating: "UP" },
  ]);
});

test("Kody turns a product request into a review-only mobile catalog draft", async ({ context, page, request }) => {
  test.setTimeout(60_000);
  const account = await signUpViaApi(request, "kody-product-mobile");
  const prompt = "Add a new product/service as 'Labor Hours' for quotes. The cost internally is $30 and customer price is $75 per hour.";

  await page.route(`${apiBaseUrl}/v1/ai/assistant`, async (route) => {
    const body = route.request().postDataJSON() as { tool?: string; message?: string };
    expect(body.tool).toBe("AUTO");
    expect(body.message).toBe(prompt);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        assistant: {
          tool: "DRAFT_PRODUCT",
          generatedAtUtc: "2026-08-13T21:00:00.000Z",
          policyVersion: "2026-08-12",
          maxClassification: "C3_FINANCIAL_CONFIDENTIAL",
          answer: "I prepared Labor Hours as a per-hour catalog item. Review the pricing and description before saving.",
          results: [{ name: "Labor Hours", serviceType: "ROOFING", category: "LABOR", unitType: "HOUR", defaultQuantity: 1, unitCost: 30, unitPrice: 75 }],
          citations: [{ key: "A1", label: "Product details supplied in this request", sourceType: "WorkPreset", classification: "C3_FINANCIAL_CONFIDENTIAL" }],
          actions: [{
            type: "OPEN_PRODUCT_DRAFT",
            label: "Review product draft",
            requiresConfirmation: true,
            payload: {
              name: "Labor Hours",
              description: "Hourly labor for Labor Hours. Confirm included work, minimums, and exclusions before using on quotes.",
              serviceType: "ROOFING",
              category: "LABOR",
              unitType: "HOUR",
              defaultQuantity: 1,
              unitCost: 30,
              unitPrice: 75,
            },
          }],
          auditEventId: "audit-kody-product-mobile",
          fieldsExcluded: ["tenant ids", "deleted rows"],
          diagnostics: {
            requestedTool: "AUTO",
            resolvedTool: "DRAFT_PRODUCT",
            resultCount: 1,
            citationCount: 1,
            emptyReason: null,
            archivePolicy: "Product drafting does not read archived, deleted, or cross-tenant catalog rows.",
            filters: { currentPage: "customers", internalCostVisible: true },
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
          monthlySpendUsedUsd: 0,
          monthlySpendLimitUsd: 1.25,
          monthlySpendRemainingUsd: 1.25,
          monthlySpendUsagePercent: 0,
          estimatedPromptCostUsd: 0.001615,
          estimatedPromptsRemaining: 773,
          renewsAtUtc: "2026-09-01T00:00:00.000Z",
        },
      }),
    });
  });

  await addSessionCookie(context, account);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/customers");
  await expect(page.getByRole("heading", { level: 1, name: "Customers", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("kody-launcher").click();
  const kody = page.getByTestId("kody-chat-panel");
  await kody.getByTestId("kody-prompt").fill(prompt);
  await kody.getByRole("button", { name: "Send", exact: true }).click();
  await expect(kody.getByText("I prepared Labor Hours", { exact: false })).toBeVisible();
  await kody.getByRole("button", { name: "Review product draft" }).click();
  const confirm = page.getByRole("dialog", { name: "Review Kody's product draft?" });
  await expect(confirm).toContainText("Nothing is added until you review");
  await confirm.getByRole("button", { name: "Open product review" }).click();

  await expect(page).toHaveURL(/\/app\/products$/);
  const productDialog = page.getByRole("dialog", { name: "Add product" });
  await expect(productDialog).toBeVisible();
  await expect(productDialog.getByLabel("Product or service name")).toHaveValue("Labor Hours");
  await expect(productDialog.getByLabel("Pricing unit")).toHaveValue("HOUR");
  await expect(productDialog.getByLabel("Internal unit cost")).toHaveValue("30");
  await expect(productDialog.getByLabel("Customer unit price")).toHaveValue("75");
  await expect(kody).toBeVisible();
  await expect(page.locator("[data-radix-dialog-overlay]")).toHaveCount(0);
});

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
  await expect(kodyLauncher).toHaveCount(0);
  await mobileNav.getByRole("button", { name: "Quotes" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Quotes", exact: true })).toBeVisible();
  await expect(kodyDialog).toBeVisible();
  await mobileNav.getByRole("button", { name: "Customers" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Customers", exact: true })).toBeVisible();
  await expect(kodyDialog).toBeVisible();
  await expect(kodyDialog.getByText("Workspace-only · You approve every change")).toBeVisible();
  await revealKodyQuickPrompts(kodyDialog);
  await kodyDialog.getByTestId("kody-quick-search_customers").click();
  await kodyDialog.getByTestId("kody-prompt").fill(`Find customer ${customer.fullName}`);
  await kodyDialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(kodyDialog.getByText(`Found ${customer.fullName} in this workspace.`)).toBeVisible();
  const guardrails = kodyDialog.getByTestId("kody-data-guardrails");
  await expect(guardrails).toContainText("Sources & safety");
  await expect(guardrails).toContainText("Workspace-only");
  await expect(guardrails).not.toContainText("AI composed");
  await guardrails.getByText("Sources & safety").click();
  await expect(guardrails).toContainText("Customer and quote context is limited to your signed-in workspace.");
  await expect(guardrails).toContainText("tenant boundary fields");
  await expect(guardrails).toContainText("archived records");
  await expect(kodyDialog.getByText("Policy class C2_CUSTOMER_CONFIDENTIAL")).toHaveClass(/sr-only/);

  await kodyDialog.getByRole("button", { name: `Open ${customer.fullName}` }).click();
  const customerDialog = page.getByRole("dialog", { name: "Customer details and activity" });
  await expect(customerDialog.getByRole("heading", { name: `${customer.fullName} activity` })).toBeVisible();
  await expect(kodyDialog).toBeHidden();
  await expect(kodyLauncher).toBeHidden();
  await expect(page.locator("[data-radix-dialog-overlay]")).toHaveCount(0);
  const customerKodyAction = customerDialog.getByRole("button", { name: "Ask Kody" });
  await expect(customerKodyAction).toBeVisible();
  await expect(customerKodyAction).toHaveClass(/bg-\[var\(--qf-action-secondary\)\]/);
  await customerDialog.getByRole("button", { name: "Close modal" }).click();
  await expect(kodyLauncher).toBeVisible();
  await expect(kodyLauncher).toHaveAttribute("aria-expanded", "false");
  await kodyLauncher.click();
  await expect(kodyDialog.getByText(`Found ${customer.fullName} in this workspace.`)).toBeVisible();
  await kodyDialog.getByTestId("kody-prompt").focus();
  await page.keyboard.press("Escape");
  await expect(kodyDialog).toBeHidden();

  await page.goto("/app/build");
  await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("textbox", { name: /find customer by name/i }).fill(customer.fullName);
  await page.getByRole("button", { name: new RegExp(`${escapeRegExp(customer.fullName)}[\\s\\S]*Use`, "i") }).click();
  await page.getByLabel("Quote title").fill("Existing mobile draft should stay");
  await expect(page.locator(".qf-mobile-action-dock")).toBeVisible();
  await expect(page.getByTestId("kody-launcher")).toBeHidden();
  const contextualDraftAction = page.getByRole("button", { name: "Draft with Kody" });
  await expect(contextualDraftAction).toBeVisible();
  await contextualDraftAction.click();
  const draftDialog = page.getByTestId("kody-chat-panel");
  await expect(draftDialog).toBeVisible();
  await expect(page.locator(".qf-mobile-action-dock")).toBeHidden();
  const draftPanelBox = await draftDialog.boundingBox();
  const visibleMobileNavBox = await mobileNav.boundingBox();
  expect((draftPanelBox?.y ?? 0) + (draftPanelBox?.height ?? 0)).toBeLessThanOrEqual((visibleMobileNavBox?.y ?? 0) - 4);
  await revealKodyQuickPrompts(draftDialog);
  await draftDialog.getByTestId("kody-quick-draft_quote").click();
  await draftDialog
    .getByTestId("kody-prompt")
    .fill(`Draft a quote for ${customer.fullName}: 20 squares asphalt shingle roof replacement around $12,000.`);
  await draftDialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(draftDialog.getByText("Prepared a preview for a roofing quote.")).toBeVisible();
  await expect(draftDialog.getByTestId("kody-data-guardrails")).toContainText("Sources & safety");
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

  await expect(page.getByTestId("kody-launcher")).toBeHidden();
  const contextualDraftAction = page.getByRole("button", { name: "Draft with Kody" });
  await expect(contextualDraftAction).toBeVisible();
  await contextualDraftAction.click();
  const kodyDialog = page.getByTestId("kody-chat-panel");
  await expect(kodyDialog).toBeVisible();
  await revealKodyQuickPrompts(kodyDialog);
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
