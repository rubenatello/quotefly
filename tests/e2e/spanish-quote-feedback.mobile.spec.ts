import { expect, test } from "@playwright/test";
import {
  addSessionCookie,
  apiBaseUrl,
  createCustomerViaApi,
  createQuoteViaApi,
  signUpViaApi,
} from "./helpers";

test("Spanish quote actions show localized, safe save, PDF, line, and send feedback", async ({
  context,
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const account = await signUpViaApi(request, "spanish-quote-feedback");
  const preference = await request.patch(`${apiBaseUrl}/v1/auth/me/preferences`, {
    headers: { Cookie: account.cookieHeader },
    data: { preferredLocale: "es-US" },
  });
  expect(preference.status()).toBe(200);
  const customer = await createCustomerViaApi(request, account, {
    fullName: "Cliente de Prueba",
    email: "cliente-cotizacion@example.com",
  });
  const quote = await createQuoteViaApi(request, account, customer.id, {
    title: "Reparación de Techo",
  });

  await addSessionCookie(context, account);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.addInitScript(() => {
    window.localStorage.setItem("qf_locale", "es-US");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => undefined },
    });
  });
  await page.goto(`/app/quotes/${quote.id}`);
  await expect(page.getByTestId("quote-desk")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("html")).toHaveAttribute("lang", "es-US");

  const unsafeServerMessage = "Provider database shard failed with internal English details";
  await page.route(`**/v1/quotes/${quote.id}/sheet`, async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: unsafeServerMessage }),
      });
      return;
    }
    await route.continue();
  }, { times: 1 });

  await page.getByLabel("Título de la cotización").fill("Reparación de Techo Actualizada");
  await page.getByRole("button", { name: "Guardar cotización", exact: true }).filter({ visible: true }).click();
  await expect(page.getByText("QuoteFly no pudo completar esta acción en este momento. Inténtalo de nuevo en unos minutos.", { exact: true })).toBeVisible();
  await expect(page.getByText(unsafeServerMessage, { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Guardar cotización", exact: true }).filter({ visible: true }).click();
  await expect(page.getByText("Cotización actualizada.", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Enviar", exact: true }).click();
  await page.route(`**/v1/quotes/${quote.id}/pdf?download=true`, async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: unsafeServerMessage }),
    });
  }, { times: 1 });
  await page.getByRole("button", { name: "Descargar PDF", exact: true }).click();
  await expect(page.getByText("QuoteFly no pudo completar esta acción en este momento. Inténtalo de nuevo en unos minutos.", { exact: true })).toBeVisible();
  await expect(page.getByText(unsafeServerMessage, { exact: true })).toHaveCount(0);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Descargar PDF", exact: true }).click();
  await downloadPromise;
  await expect(page.getByText("PDF descargado.", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Cotización", exact: true }).click();
  const firstLine = page.getByTestId("existing-quote-line-row-1");
  await firstLine.getByRole("button").first().click();
  await firstLine.getByRole("button", { name: "Quitar", exact: true }).click();
  const deleteLineDialog = page.getByRole("dialog", { name: "Eliminar línea" });
  await expect(deleteLineDialog).toContainText("Esto quita la línea de la cotización y vuelve a calcular los totales.");
  await deleteLineDialog.getByRole("button", { name: "Eliminar línea", exact: true }).click();
  await expect(page.getByText("Línea eliminada", { exact: true })).toBeVisible();
  await expect(page.getByTestId("existing-quote-line-row-2")).toHaveCount(0);

  await page.getByRole("button", { name: "Enviar", exact: true }).click();
  await page.getByRole("button", { name: "Copiar mensaje", exact: true }).click();
  const sendDialog = page.getByRole("dialog", { name: "Confirmación de envío de cotización" });
  await expect(sendDialog).toBeVisible();
  await expect(sendDialog).toContainText(customer.fullName);
  await sendDialog.getByRole("button", { name: "Copiar mensaje", exact: true }).click();
  await expect(sendDialog).toContainText("¿El mensaje salió de tu teléfono? QuoteFly todavía no cambió el estado de la cotización.");
  await expect(sendDialog.getByRole("button", { name: "Sí, marcar como enviada", exact: true })).toBeVisible();
});
