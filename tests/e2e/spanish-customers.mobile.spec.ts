import { expect, test } from "@playwright/test";
import {
  addSessionCookie,
  apiBaseUrl,
  createCustomerViaApi,
  escapeRegExp,
  signUpViaApi,
} from "./helpers";

test("Spanish customer activity clears prior records and offers retry after a safe localized failure", async ({
  context,
  page,
  request,
}) => {
  const account = await signUpViaApi(request, "spanish-customer-activity");
  const firstCustomer = await createCustomerViaApi(request, account, { fullName: "Ana Primera" });
  const secondCustomer = await createCustomerViaApi(request, account, { fullName: "Beatriz Segunda" });
  const preference = await request.patch(`${apiBaseUrl}/v1/auth/me/preferences`, {
    headers: { Cookie: account.cookieHeader },
    data: { preferredLocale: "es-US" },
  });
  expect(preference.status()).toBe(200);

  await addSessionCookie(context, account);
  await page.addInitScript(() => window.localStorage.setItem("qf_locale", "es-US"));

  let secondActivityAttempts = 0;
  const secondActivityPattern = new RegExp(
    `/v1/customers/${escapeRegExp(secondCustomer.id)}/activity(?:\\?|$)`,
  );
  await page.route(secondActivityPattern, async (route) => {
    secondActivityAttempts += 1;
    if (secondActivityAttempts === 1) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Raw backend database failure must stay private" }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/app/customers");
  await expect(page.locator("html")).toHaveAttribute("lang", "es-US");

  await page.getByRole("button", { name: `Abrir detalles de ${firstCustomer.fullName}` }).click();
  let dialog = page.getByRole("dialog", { name: "Detalles del cliente" });
  let activityFeed = dialog.getByTestId("customer-activity-feed");
  await expect(activityFeed).toContainText(firstCustomer.fullName);
  await dialog.getByRole("button", { name: "Cerrar", exact: true }).last().click();

  await page.getByRole("button", { name: `Abrir detalles de ${secondCustomer.fullName}` }).click();
  dialog = page.getByRole("dialog", { name: "Detalles del cliente" });
  activityFeed = dialog.getByTestId("customer-activity-feed");
  await expect(activityFeed.getByRole("alert")).toHaveText(
    "QuoteFly no pudo completar esta acción en este momento. Inténtalo de nuevo en unos minutos.",
  );
  await expect(activityFeed).not.toContainText(firstCustomer.fullName);
  await expect(activityFeed).not.toContainText("Raw backend database failure must stay private");
  await expect(activityFeed).not.toContainText("Todavía no hay actividad");

  await activityFeed.getByRole("button", { name: "Intentar de nuevo", exact: true }).click();
  await expect(activityFeed).toContainText(secondCustomer.fullName);
  await expect(activityFeed.getByRole("alert")).toHaveCount(0);
  expect(secondActivityAttempts).toBe(2);
});

test("customer updated dates use the active Spanish locale and tenant timezone across a year boundary", async ({
  context,
  page,
  request,
}) => {
  const account = await signUpViaApi(request, "spanish-customer-timezone");
  const customer = await createCustomerViaApi(request, account, { fullName: "Cliente Zona Horaria" });
  const preference = await request.patch(`${apiBaseUrl}/v1/auth/me/preferences`, {
    headers: { Cookie: account.cookieHeader },
    data: { preferredLocale: "es-US" },
  });
  expect(preference.status()).toBe(200);

  await addSessionCookie(context, account);
  await page.addInitScript(() => window.localStorage.setItem("qf_locale", "es-US"));
  await page.clock.setFixedTime(new Date("2026-06-15T12:00:00.000Z"));

  await page.route("**/v1/auth/me", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.tenant.timezone = "Pacific/Kiritimati";
    await route.fulfill({ response, json: payload });
  });
  await page.route(/\/v1\/customers(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.customers = payload.customers.map((item: { id: string; updatedAt: string }) => (
      item.id === customer.id
        ? { ...item, updatedAt: "2025-12-31T20:00:00.000Z" }
        : item
    ));
    await route.fulfill({ response, json: payload });
  });

  await page.goto("/app/customers");
  const openCustomer = page.getByRole("button", { name: `Abrir detalles de ${customer.fullName}` });
  await expect(openCustomer).toContainText("Actualizado 1 ene");
  await expect(openCustomer).not.toContainText("2025");
});
