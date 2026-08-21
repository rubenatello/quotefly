import { expect, test } from "@playwright/test";
import { addSessionCookie, apiBaseUrl, signUpViaApi } from "./helpers";

test("Spanish activity failures stay actionable without exposing backend English", async ({
  context,
  page,
  request,
}) => {
  const account = await signUpViaApi(request, "spanish-activity-error");
  const preference = await request.patch(`${apiBaseUrl}/v1/auth/me/preferences`, {
    headers: { Cookie: account.cookieHeader },
    data: { preferredLocale: "es-US" },
  });
  expect(preference.status()).toBe(200);

  await addSessionCookie(context, account);
  await page.addInitScript(() => window.localStorage.setItem("qf_locale", "es-US"));

  const rawEnglishSentinel = "Raw English database failure must stay private";
  await page.route(/\/v1\/activities(?:\?|$)/, async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: rawEnglishSentinel }),
    });
  });

  await page.goto("/app/follow-up");
  await expect(page.locator("html")).toHaveAttribute("lang", "es-US");
  const tasks = page.getByRole("region", { name: "Tareas de mi trabajo" });
  await expect(tasks.getByText("Las tareas no están disponibles temporalmente", { exact: true })).toBeVisible();
  await expect(tasks).toContainText("QuoteFly no pudo completar esta acción en este momento.");
  await expect(tasks).toContainText("No se cambió ningún registro de tareas.");
  await expect(tasks).not.toContainText(rawEnglishSentinel);
});
