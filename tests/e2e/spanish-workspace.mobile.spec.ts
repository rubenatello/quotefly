import { expect, test } from "@playwright/test";
import { addSessionCookie, apiBaseUrl, signUpViaApi } from "./helpers";

test("a team member's Spanish preference persists and the core mobile workspace remains usable", async ({ context, page, request }) => {
  const account = await signUpViaApi(request, "spanish-workspace");
  const preference = await request.patch(`${apiBaseUrl}/v1/auth/me/preferences`, {
    headers: { Cookie: account.cookieHeader },
    data: { preferredLocale: "es-US" },
  });
  expect(preference.status()).toBe(200);

  await addSessionCookie(context, account);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.addInitScript(() => window.localStorage.setItem("qf_locale", "es-US"));
  await page.goto("/app");

  await expect(page.locator("html")).toHaveAttribute("lang", "es-US");
  await expect(page.getByTestId("workspace-home")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1, name: "Inicio", exact: true })).toHaveClass(/sr-only/);
  await expect(page.getByText("Hoy en QuoteFly", { exact: true })).toBeVisible();
  await expect(page.getByText("Clientes sin cotización", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Priorizar mi día", exact: true })).toBeVisible();
  await expect(page.getByTestId("mobile-tab-home")).toHaveAttribute("aria-label", "Inicio");

  await page.getByRole("button", { name: "Abrir navegación", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Navegación del espacio de trabajo" });
  await expect(drawer.getByRole("button", { name: "Inicio", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(drawer.getByRole("button", { name: "Clientes", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1);

  await page.goto("/app/settings");
  const languageGroup = page.getByRole("group", { name: "Idioma" });
  await expect(languageGroup.getByRole("button", { name: "Español", exact: true })).toHaveAttribute("aria-pressed", "true");

  await page.route("**/v1/auth/me/preferences", async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "simulated failure" }) });
      return;
    }
    await route.continue();
  });
  await languageGroup.getByRole("button", { name: "Inglés", exact: true }).click();
  await expect(languageGroup.getByRole("button", { name: "Español", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveAttribute("lang", "es-US");
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("qf_locale"))).toBe("es-US");
  await page.unroute("**/v1/auth/me/preferences");

  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/v1/auth/me/preferences") && response.request().method() === "PATCH"),
    languageGroup.getByRole("button", { name: "Inglés", exact: true }).click(),
  ]);
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(page.getByRole("heading", { level: 1, name: "Settings", exact: true })).toHaveClass(/sr-only/);
});
