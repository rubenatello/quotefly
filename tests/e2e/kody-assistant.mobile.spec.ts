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

  await page.route(`${apiBaseUrl}/v1/ai/assistant`, async (route) => {
    const body = route.request().postDataJSON() as {
      tool?: string;
      message?: string;
      context?: Record<string, unknown>;
    };
    aiRequests.push(body);
    const message = body.message ?? "";
    const generatedAtUtc = "2026-08-12T18:00:00.000Z";
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
        },
        usage,
      }),
    });
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
  const kodyDialog = page.getByRole("dialog", { name: "Kody assistant" });
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
  await page.getByRole("dialog", { name: "Customer details and activity" }).getByRole("button", { name: "Close modal" }).click();

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
  const draftDialog = page.getByRole("dialog", { name: "Kody assistant" });
  await draftDialog.getByTestId("kody-quick-draft_quote").click();
  await draftDialog
    .getByTestId("kody-prompt")
    .fill(`Draft a quote for ${customer.fullName}: 20 squares asphalt shingle roof replacement around $12,000.`);
  await draftDialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(draftDialog.getByText("Prepared a preview for a roofing quote.")).toBeVisible();
  await expect(draftDialog.getByTestId("kody-data-guardrails")).toContainText("Customer and quote context");
  await draftDialog.getByRole("button", { name: "Review quote draft" }).click();

  await expect(page).toHaveURL(/\/app\/build$/);
  await expect(page.getByLabel("Quote title")).toHaveValue("Existing mobile draft should stay");
  await expect(page.getByText("Kody prepared a quote prompt without changing your existing draft.")).toBeVisible();
  const quoteAiDialog = page.getByRole("dialog", { name: "Draft quote with AI" });
  await expect(quoteAiDialog).toBeVisible();
  await expect(page.getByTestId("quote-ai-prompt")).toHaveValue(/20 squares asphalt shingle roof replacement/);

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
