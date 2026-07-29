import { expect, test, type Locator } from "@playwright/test";
import {
  addSessionCookie,
  createCustomerViaApi,
  createQuoteViaApi,
  getQuoteViaApi,
  signUpViaApi,
} from "./helpers";

function visibleField(row: Locator, accessibleName: string) {
  return row.locator(`[aria-label="${accessibleName}"]:visible`);
}

test.describe("stale outbound protection", () => {
  test("save and continue persists the complete sheet before message and PDF actions", async ({
    context,
    page,
    request,
  }) => {
    const account = await signUpViaApi(request, "stale-outbound-save");
    const customer = await createCustomerViaApi(request, account);
    const quote = await createQuoteViaApi(request, account, customer.id, { title: "Original outbound quote" });
    await addSessionCookie(context, account);
    let atomicSheetWrites = 0;
    let legacyQuoteOrLineWrites = 0;
    page.on("request", (browserRequest) => {
      const requestUrl = new URL(browserRequest.url());
      if (browserRequest.method() === "PATCH" && requestUrl.pathname === `/v1/quotes/${quote.id}/sheet`) {
        atomicSheetWrites += 1;
      } else if (
        ["PATCH", "POST"].includes(browserRequest.method()) &&
        (requestUrl.pathname === `/v1/quotes/${quote.id}` || requestUrl.pathname.includes("/line-items"))
      ) {
        legacyQuoteOrLineWrites += 1;
      }
    });

    await page.goto(`/app/quotes/${quote.id}`);
    await expect(page.getByTestId("quote-desk")).toBeVisible({ timeout: 15_000 });

    const revisedTitle = "Persisted outbound quote";
    const revisedScope = "Persist this revised customer scope before any handoff.";
    await page.getByLabel("Quote title").fill(revisedTitle);
    await page.getByLabel("Quote overview").fill(revisedScope);

    const firstRow = page.getByTestId("existing-quote-line-row-1");
    await visibleField(firstRow, "Existing line 1 description").fill("Persisted existing line details");
    await visibleField(firstRow, "Existing line 1 price").fill("1400");

    const newRow = page.getByTestId("new-quote-line-row");
    await newRow.getByLabel("New line title").fill("Permit coordination");
    await newRow.getByLabel("New line description").fill("Customer-facing permit handling");
    await newRow.getByLabel("New line quantity").fill("1");
    await newRow.getByLabel("New line cost").fill("75");
    await newRow.getByLabel("New line price").fill("200");

    await page.getByRole("button", { name: "Send", exact: true }).click();
    const saveGate = page.getByRole("dialog", { name: "Save changes before sending" });
    await expect(saveGate).toBeVisible();
    await expect(saveGate.getByText(/completed new line will be added/i)).toBeVisible();
    await saveGate.getByRole("button", { name: "Save and Continue" }).click();

    await expect(saveGate).toBeHidden();
    await expect(page.getByRole("button", { name: "Copy Message" })).toBeVisible();

    await expect.poll(async () => {
      const latest = await getQuoteViaApi(request, account, quote.id);
      return {
        title: latest.title,
        scopeText: latest.scopeText,
        totalAmount: Number(latest.totalAmount),
        descriptions: latest.lineItems?.map((line) => line.description) ?? [],
      };
    }).toMatchObject({
      title: revisedTitle,
      scopeText: revisedScope,
      descriptions: [
        "Leak repair and flashing reset\nPersisted existing line details",
        "Cleanup and disposal",
        "Permit coordination\nCustomer-facing permit handling",
      ],
    });
    const latestQuote = await getQuoteViaApi(request, account, quote.id);
    expect(atomicSheetWrites).toBe(1);
    expect(legacyQuoteOrLineWrites).toBe(0);
    await page.getByRole("button", { name: "Copy Message" }).click();
    const sendDialog = page.getByRole("dialog", { name: "Send quote confirmation" });
    const message = await sendDialog.getByLabel("Message").inputValue();
    expect(message).toContain(revisedTitle);
    expect(message).toContain(revisedScope);
    expect(message).toContain(
      new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(latestQuote.totalAmount)),
    );
    await sendDialog.getByRole("button", { name: "Cancel" }).click();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download PDF" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("persisted-outbound-quote.pdf");
  });

  test("a rejected atomic sheet save launches no outbound action, persists no hybrid, and retains every draft", async ({
    context,
    page,
    request,
  }) => {
    const account = await signUpViaApi(request, "stale-outbound-failure");
    const customer = await createCustomerViaApi(request, account);
    const quote = await createQuoteViaApi(request, account, customer.id, { title: "Outbound failure original" });
    await addSessionCookie(context, account);

    let sheetWrites = 0;
    let pdfRequests = 0;
    let outboundRequests = 0;
    await page.route("**/v1/quotes/**", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.pathname === `/v1/quotes/${quote.id}/sheet` && route.request().method() === "PATCH") {
        sheetWrites += 1;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Quote save failed during a later write. Every draft is still in the editor." }),
        });
        return;
      }
      if (requestUrl.pathname.endsWith("/pdf")) pdfRequests += 1;
      if (requestUrl.pathname.endsWith("/confirm-send") || requestUrl.pathname.endsWith("/outbound-events")) {
        outboundRequests += 1;
      }
      await route.continue();
    });

    await page.goto(`/app/quotes/${quote.id}`);
    await expect(page.getByTestId("quote-desk")).toBeVisible({ timeout: 15_000 });
    await page.getByLabel("Quote title").fill("Outbound failure draft title");
    await page.getByLabel("Quote overview").fill("Outbound failure draft scope");
    const firstRow = page.getByTestId("existing-quote-line-row-1");
    await visibleField(firstRow, "Existing line 1 description").fill("Unsaved existing row retained");
    const newRow = page.getByTestId("new-quote-line-row");
    await newRow.getByLabel("New line title").fill("Unsaved new row retained");
    await newRow.getByLabel("New line price").fill("225");

    await page.getByRole("button", { name: "Send", exact: true }).click();
    const saveGate = page.getByRole("dialog", { name: "Save changes before sending" });
    await saveGate.getByRole("button", { name: "Save and Continue" }).click();

    await expect(saveGate).toBeHidden();
    await expect(page.getByText("Quote save failed during a later write. Every draft is still in the editor.")).toBeVisible();
    await expect(page.getByLabel("Quote title")).toHaveValue("Outbound failure draft title");
    await expect(page.getByLabel("Quote overview")).toHaveValue("Outbound failure draft scope");
    await expect(visibleField(firstRow, "Existing line 1 description")).toHaveValue("Unsaved existing row retained");
    await expect(newRow.getByLabel("New line title")).toHaveValue("Unsaved new row retained");
    await expect(newRow.getByLabel("New line price")).toHaveValue("225");
    expect(sheetWrites).toBe(1);
    expect(pdfRequests).toBe(0);
    expect(outboundRequests).toBe(0);
    await expect(page.getByRole("dialog", { name: "Send quote confirmation" })).toHaveCount(0);
    const persisted = await getQuoteViaApi(request, account, quote.id);
    expect(persisted.title).toBe("Outbound failure original");
    expect(persisted.scopeText).toBe("Repair leak, replace damaged flashing, seal exposed fasteners, and clean the work area.");
    expect(persisted.lineItems?.map((line) => line.description)).toEqual([
      "Leak repair and flashing reset",
      "Cleanup and disposal",
    ]);
  });
});
