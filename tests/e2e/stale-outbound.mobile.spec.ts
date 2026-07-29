import { expect, test } from "@playwright/test";
import {
  addSessionCookie,
  createCustomerViaApi,
  createQuoteViaApi,
  getQuoteViaApi,
  signUpViaApi,
} from "./helpers";

test.describe("mobile stale outbound protection", () => {
  test("Pixel flow saves mobile metadata, existing row, and new row before composing", async ({
    context,
    page,
    request,
  }) => {
    const account = await signUpViaApi(request, "mobile-stale-outbound-save");
    const customer = await createCustomerViaApi(request, account);
    const quote = await createQuoteViaApi(request, account, customer.id, { title: "Mobile outbound original" });
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
    await page.getByLabel("Quote title").fill("Mobile persisted outbound");
    await page.getByLabel("Quote overview").fill("Mobile persisted scope before send.");

    const firstRow = page.getByTestId("existing-quote-line-row-1");
    await firstRow.getByRole("button").first().click();
    await firstRow.locator('[aria-label="Existing line 1 description"]:visible').fill("Mobile persisted line details");
    await firstRow.locator('[aria-label="Existing line 1 price"]:visible').fill("1375");

    const newRow = page.getByTestId("new-quote-line-row");
    await newRow.getByLabel("New line title").fill("Mobile permit line");
    await newRow.getByLabel("New line description").fill("Mobile permit handling");
    await newRow.getByLabel("New line price").fill("175");

    await page.getByRole("button", { name: "Send", exact: true }).click();
    const saveGate = page.getByRole("dialog", { name: "Save changes before sending" });
    await expect(saveGate.getByRole("button", { name: "Save and Continue" })).toBeVisible();
    await saveGate.getByRole("button", { name: "Save and Continue" }).click();

    await expect(saveGate).toBeHidden();
    await expect(page.getByRole("button", { name: "Copy Message" })).toBeVisible();
    await expect.poll(async () => {
      const latest = await getQuoteViaApi(request, account, quote.id);
      return {
        title: latest.title,
        scopeText: latest.scopeText,
        descriptions: latest.lineItems?.map((line) => line.description) ?? [],
      };
    }).toMatchObject({
      title: "Mobile persisted outbound",
      scopeText: "Mobile persisted scope before send.",
      descriptions: [
        "Leak repair and flashing reset\nMobile persisted line details",
        "Cleanup and disposal",
        "Mobile permit line\nMobile permit handling",
      ],
    });
    expect(atomicSheetWrites).toBe(1);
    expect(legacyQuoteOrLineWrites).toBe(0);

    await page.getByRole("button", { name: "Copy Message" }).click();
    const sendDialog = page.getByRole("dialog", { name: "Send quote confirmation" });
    const message = await sendDialog.getByLabel("Message").inputValue();
    expect(message).toContain("Mobile persisted outbound");
    expect(message).toContain("Mobile persisted scope before send.");
  });

  test("Pixel flow keeps all drafts, persists no hybrid, and opens no outbound when atomic save fails late", async ({
    context,
    page,
    request,
  }) => {
    const account = await signUpViaApi(request, "mobile-stale-outbound-failure");
    const customer = await createCustomerViaApi(request, account);
    const quote = await createQuoteViaApi(request, account, customer.id, { title: "Mobile failure original" });
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
          body: JSON.stringify({ error: "Mobile quote save failed during a later write. Drafts are ready to retry." }),
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
    await page.getByLabel("Quote title").fill("Mobile failure draft title");
    const firstRow = page.getByTestId("existing-quote-line-row-1");
    await firstRow.getByRole("button").first().click();
    await firstRow.locator('[aria-label="Existing line 1 description"]:visible').fill("Mobile existing draft retained");
    const newRow = page.getByTestId("new-quote-line-row");
    await newRow.getByLabel("New line title").fill("Mobile new draft retained");
    await newRow.getByLabel("New line price").fill("250");

    await page.getByRole("button", { name: "Send", exact: true }).click();
    const saveGate = page.getByRole("dialog", { name: "Save changes before sending" });
    await saveGate.getByRole("button", { name: "Save and Continue" }).click();

    await expect(saveGate).toBeHidden();
    await expect(page.getByText("Mobile quote save failed during a later write. Drafts are ready to retry.")).toBeVisible();
    await expect(page.getByLabel("Quote title")).toHaveValue("Mobile failure draft title");
    await expect(firstRow.locator('[aria-label="Existing line 1 description"]:visible')).toHaveValue("Mobile existing draft retained");
    await expect(newRow.getByLabel("New line title")).toHaveValue("Mobile new draft retained");
    await expect(newRow.getByLabel("New line price")).toHaveValue("250");
    expect(sheetWrites).toBe(1);
    expect(pdfRequests).toBe(0);
    expect(outboundRequests).toBe(0);
    await expect(page.getByRole("button", { name: "Copy Message" })).toHaveCount(0);
    const persisted = await getQuoteViaApi(request, account, quote.id);
    expect(persisted.title).toBe("Mobile failure original");
    expect(persisted.lineItems?.map((line) => line.description)).toEqual([
      "Leak repair and flashing reset",
      "Cleanup and disposal",
    ]);
  });
});
