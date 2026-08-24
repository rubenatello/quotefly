import { expect, test } from "@playwright/test";
import {
  addSessionCookie,
  apiBaseUrl,
  createCustomerViaApi,
  escapeRegExp,
  signUpViaApi,
} from "./helpers";

test("Spanish quote creation stays localized through preview, sending, and history", async ({
  context,
  page,
  request,
}) => {
  test.setTimeout(120_000);

  const account = await signUpViaApi(request, "spanish-quote-workflow");
  const preference = await request.patch(`${apiBaseUrl}/v1/auth/me/preferences`, {
    headers: { Cookie: account.cookieHeader },
    data: { preferredLocale: "es-US" },
  });
  expect(preference.status()).toBe(200);

  const customer = await createCustomerViaApi(request, account, {
    fullName: "María Peña",
    email: "maria.pena@example.com",
  });
  const quoteTitle = "Mantenimiento de jardín Peña";

  await addSessionCookie(context, account);
  await page.addInitScript(() => window.localStorage.setItem("qf_locale", "es-US"));
  await page.goto("/app/build");

  await expect(page.locator("html")).toHaveAttribute("lang", "es-US");
  await expect(page.getByTestId("quote-builder")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { level: 1, name: "Cotización rápida", exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Progreso de la cotización" })).toBeVisible();

  await page.getByRole("combobox", { name: "Buscar un cliente", exact: true }).fill(customer.fullName);
  await page
    .getByRole("option", {
      name: new RegExp(`${escapeRegExp(customer.fullName)}[\\s\\S]*Usar cliente`, "i"),
    })
    .click();

  await page.getByLabel("Idioma del documento para el cliente").filter({ visible: true }).first().selectOption("es-US");
  await page.getByLabel("Título de la cotización").fill(quoteTitle);
  await page.getByRole("button", { name: "Mostrar detalles", exact: true }).click();
  await page
    .getByLabel("Resumen de la cotización")
    .fill("Poda de arbustos, limpieza del jardín y retiro de residuos verdes.");

  const firstLine = page.getByTestId("quote-line-row-1");
  await firstLine.getByRole("textbox", { name: "Título de la línea 1", exact: true }).fill("Poda de arbustos");
  await firstLine.getByRole("spinbutton", { name: "Cantidad de la línea 1", exact: true }).fill("1");
  await firstLine.getByRole("spinbutton", { name: "Precio de la línea 1", exact: true }).fill("180");

  await page.getByRole("button", { name: "Revisar cotización", exact: true }).click();
  await expect(page.getByText("Cotización para el cliente", { exact: true })).toBeVisible();
  await expect(page.getByText(quoteTitle, { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Crear cotización", exact: true }).click();

  await expect(page).toHaveURL(/\/app\/quotes\/[^/]+$/);
  await expect(page.getByTestId("quote-desk")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: quoteTitle, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Editar cotización", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Vista previa", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Guardar cotización", exact: true }).filter({ visible: true })).toBeVisible();

  await page.getByRole("button", { name: "Vista previa", exact: true }).first().click();
  await expect(page.getByText("Cotización para el cliente", { exact: true })).toBeVisible();
  await expect(page.getByText(customer.fullName, { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Editar cotización", exact: true }).first().click();

  await page.getByRole("button", { name: "Enviar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Enviar la cotización", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Aplicación de correo", exact: true }).click();

  const sendComposer = page.getByRole("dialog", { name: "Confirmación de envío de cotización" });
  await expect(sendComposer.getByRole("heading", { name: "Enviar cotización por correo", exact: true })).toBeVisible();
  await expect(sendComposer.getByLabel("Asunto", { exact: true })).toBeVisible();
  await expect(sendComposer.getByLabel("Mensaje", { exact: true })).toBeVisible();
  await expect(sendComposer.getByText(`Cliente: ${customer.fullName}`, { exact: true })).toBeVisible();
  await sendComposer.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(sendComposer).toBeHidden();

  await page.getByRole("button", { name: "Historial", exact: true }).click();
  await expect(page.getByText("Actividad de IA", { exact: true })).toBeVisible();
  await expect(page.getByText("Historial de revisiones", { exact: true })).toBeVisible();
  await expect(page.getByText(quoteTitle, { exact: true }).filter({ visible: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Registro de envíos", exact: true }).click();
  await expect(page.getByText("Revisa las acciones de correo, mensaje y copia de esta cotización.", { exact: true })).toBeVisible();
  await expect(page.getByText("No hay envíos registrados", { exact: true })).toBeVisible();

  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1);
});
