import { expect, test, type Page } from "@playwright/test";
import { addSessionCookie, signUpViaApi } from "./helpers";

async function holdAssistantModule(page: Page) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let requested!: () => void;
  const requestSeen = new Promise<void>((resolve) => { requested = resolve; });
  await page.route(/\/src\/components\/ai\/KodyAssistant\.tsx(?:\?.*)?$/, async (route) => {
    requested();
    await released;
    await route.continue();
  });
  return { release, requestSeen };
}

test("a Home launch survives delayed assistant loading and restores the original trigger focus", async ({ page, request, context }) => {
  const account = await signUpViaApi(request, "kody-startup");
  await addSessionCookie(context, account);
  const module = await holdAssistantModule(page);
  try {
    await page.goto("/app", { waitUntil: "domcontentloaded" });
    const trigger = page.getByRole("button", { name: "Prioritize my day", exact: true });
    await expect(trigger).toBeVisible();
    await module.requestSeen;
    await trigger.click();
    const panel = page.getByTestId("kody-chat-panel");
    await expect(panel).toHaveCount(0);
    // Focus can move while the module loads; closing must restore the click-time origin.
    await page.getByRole("button", { name: "Sign out", exact: true }).focus();
    module.release();
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("kody-prompt")).toHaveValue(
      "Review my workspace and tell me the three highest-priority actions I should take today. Focus on new leads, unfinished quotes, sent quotes awaiting follow-up, and after-sale check-ins.",
    );
    await panel.getByRole("button", { name: "Close Kody", exact: true }).click();
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
    // A normal raw DOM event remains supported after the retained intent is consumed.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("quotefly:kody-open", {
      detail: { prompt: "Show my schedule.", tool: "LIST_SCHEDULE" },
    })));
    await expect(panel.getByTestId("kody-prompt")).toHaveValue("Show my schedule.");
  } finally {
    module.release();
  }
});

test("an unconsumed launch does not follow a signed-out user into the next account", async ({ page, request, context }) => {
  const first = await signUpViaApi(request, "kody-startup-first");
  const second = await signUpViaApi(request, "kody-startup-next");
  await addSessionCookie(context, first);
  const module = await holdAssistantModule(page);
  try {
    await page.goto("/app", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Prioritize my day", exact: true }).click();
    await module.requestSeen;
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    module.release();
    // Sign back in through the SPA so the event module's memory is retained.
    await page.getByRole("button", { name: "Sign In", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Sign in" });
    await dialog.getByLabel("Email Address").fill(second.email);
    await dialog.getByLabel("Password").fill(second.password);
    await dialog.getByRole("button", { name: /^Sign in$/i }).click();
    await expect(page.getByRole("button", { name: "Prioritize my day", exact: true })).toBeVisible();
    // A non-contextual page exposes the closed assistant launcher after it mounts.
    await page.getByRole("button", { name: "Customers", exact: true }).click();
    await expect(page.getByRole("button", { name: "Ask Kody", exact: true })).toBeVisible();
    await expect(page.getByTestId("kody-chat-panel")).toBeHidden();
  } finally {
    module.release();
  }
});
