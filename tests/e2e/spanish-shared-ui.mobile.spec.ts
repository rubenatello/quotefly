import { expect, test } from "@playwright/test";
import {
  addSessionCookie,
  apiBaseUrl,
  createCustomerViaApi,
  signUpViaApi,
} from "./helpers";

test("Spanish shared pagination and confirmation defaults remain accessible on mobile", async ({
  context,
  page,
  request,
}) => {
  const account = await signUpViaApi(request, "spanish-shared-ui");
  const customer = await createCustomerViaApi(request, account, { fullName: "María Accesible" });
  const preference = await request.patch(`${apiBaseUrl}/v1/auth/me/preferences`, {
    headers: { Cookie: account.cookieHeader },
    data: { preferredLocale: "es-US" },
  });
  expect(preference.status()).toBe(200);

  await addSessionCookie(context, account);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.addInitScript(() => window.localStorage.setItem("qf_locale", "es-US"));
  await page.goto("/app/customers");

  const pagination = page.getByRole("navigation", { name: "Paginación de clientes" });
  await expect(pagination).toBeVisible();
  await expect(pagination.getByRole("combobox", { name: "Filas por página para clientes" })).toHaveValue("25");
  await expect(pagination.getByText("1-1 de 1", { exact: true })).toBeVisible();
  await expect(pagination.getByText("Página 1 de 1", { exact: true })).toBeVisible();
  await expect(pagination.getByRole("button", { name: "Página anterior de clientes" })).toBeDisabled();
  await expect(pagination.getByRole("button", { name: "Página siguiente de clientes" })).toBeDisabled();

  await page.getByRole("button", { name: `Abrir detalles de ${customer.fullName}` }).click();
  const customerDialog = page.getByRole("dialog", { name: "Detalles del cliente" });
  await expect(customerDialog.getByRole("button", { name: "Cerrar modal" })).toBeVisible();
  await customerDialog.getByRole("button", { name: "Archivar", exact: true }).click();

  const confirmation = page.getByRole("dialog", { name: "¿Archivar cliente?" });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "Cerrar modal" })).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "Cancelar", exact: true })).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "Archivar cliente", exact: true })).toBeVisible();

  await confirmation.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(confirmation).toBeHidden();
  await expect(customerDialog).toBeVisible();

  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1);
});
