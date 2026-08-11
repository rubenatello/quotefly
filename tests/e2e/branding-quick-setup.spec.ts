import path from "node:path";
import { expect, test } from "@playwright/test";
import { addSessionCookie, signUpViaApi } from "./helpers";

test("owner can configure a quote brand from the three-step quick setup", async ({ context, page, request }) => {
  const account = await signUpViaApi(request, "branding-quick");
  await addSessionCookie(context, account);

  await page.goto("/app/branding");

  const quickSetup = page.getByRole("region", { name: "Build your quote look in three steps" });
  await expect(quickSetup).toBeVisible({ timeout: 15_000 });
  await expect(quickSetup.getByRole("button", { name: /quote preset/i })).toHaveCount(3);

  const professionalPreset = quickSetup.getByRole("button", { name: "Use Professional quote preset" });
  await professionalPreset.click();
  await expect(professionalPreset).toHaveAttribute("aria-pressed", "true");

  const navyColor = quickSetup.getByRole("button", { name: "Use Navy (#1E3A5F)" });
  await navyColor.click();
  await expect(navyColor).toHaveAttribute("aria-pressed", "true");

  await page.locator("#branding-logo-upload").setInputFiles(path.resolve("web/public/favicon.png"));
  await expect(quickSetup.getByAltText("Your business logo")).toBeVisible();

  const rightPlacement = quickSetup.getByRole("button", { name: "Place logo right" });
  await rightPlacement.click();
  await expect(rightPlacement).toHaveAttribute("aria-pressed", "true");

  await quickSetup.getByRole("button", { name: "Save Brand" }).click();
  await expect(quickSetup.getByRole("button", { name: "Brand Saved" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("region", { name: "Build your quote look in three steps" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use Professional quote preset" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Use Navy (#1E3A5F)" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Place logo right" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByAltText("Your business logo")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("region", { name: "Build your quote look in three steps" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1);
});
