import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { PUBLIC_ROUTE_SEO } from "../../web/src/lib/public-seo-data";

const PUBLIC_OPERATIONAL_ROUTES = ["/", "/solutions", "/pricing"] as const;
const RESPONSIVE_WIDTHS = [360, 390, 768, 1280, 1440] as const;

async function expectNoSeriousAccessibilityViolations(page: Page, label: string) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = [
    ...result.violations.map((violation) => ({ outcome: "violation" as const, violation })),
    ...result.incomplete.map((violation) => ({ outcome: "incomplete" as const, violation })),
  ]
    .filter(({ outcome, violation }) =>
      violation.id === "aria-prohibited-attr"
      || (outcome === "violation" && (violation.impact === "critical" || violation.impact === "serious")),
    )
    .map(({ outcome, violation }) => ({
      id: violation.id,
      impact: violation.impact,
      outcome,
      help: violation.help,
      targets: violation.nodes.slice(0, 8).flatMap((node) => node.target),
    }));
  expect(blocking, `${label} has serious/critical violations or unresolved prohibited ARIA`).toEqual([]);
}

async function expectNoPageOverflow(page: Page, label: string) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), {
      message: `${label} must not introduce horizontal page scrolling`,
    })
    .toBeLessThanOrEqual(1);
}

test("public pages tell the verified quote-to-internal-invoice story", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: PUBLIC_ROUTE_SEO["/"].heading })).toBeVisible();
  await expect(page.getByRole("link", { name: "See the quote-to-job workflow" })).toHaveAttribute("href", "#product-story");

  const homeWorkflow = page.getByRole("list", { name: "Quote to internal invoice workflow" });
  await expect(homeWorkflow.getByRole("listitem")).toHaveCount(6);
  for (const stage of [
    "Capture and price",
    "Review and share",
    "Turn yes into a Job",
    "Assign and schedule",
    "Run the field visit",
    "Record the invoice",
  ]) {
    await expect(homeWorkflow.getByRole("heading", { name: stage })).toBeVisible();
  }

  const operationalKodyExamples = [
    ["What is on my schedule today?", /read-only result.*does not change/i],
    ["Prepare a visit for the Smith job tomorrow at 9 a.m.", /Nothing is booked until.*reviews and confirms/i],
    ["Prepare my next visit for dispatch.", /stays scheduled until you confirm/i],
  ] as const;
  for (const [prompt, resultPattern] of operationalKodyExamples) {
    const control = page.getByRole("button", { name: prompt });
    await control.click();
    await expect(control).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#kody-example-response")).toContainText(resultPattern);
  }

  await page.goto("/solutions");
  await expect(page.getByRole("heading", { level: 1, name: PUBLIC_ROUTE_SEO["/solutions"].heading })).toBeVisible();
  const solutionsWorkflow = page.locator("#workflow").getByRole("list");
  await expect(solutionsWorkflow.getByRole("listitem")).toHaveCount(6);
  await expect(page.getByText(/external invoice sending, payment collection, and QuickBooks invoice creation are not part/i)).toBeVisible();
  await expect(page.getByRole("link", { name: "See Basic pricing" })).toHaveAttribute("href", "/pricing");

  await page.goto("/pricing");
  await expect(page.getByRole("heading", { level: 1, name: PUBLIC_ROUTE_SEO["/pricing"].heading })).toBeVisible();
  await expect(page.getByText("Accepted-quote Jobs with day/week scheduling and dispatch controls")).toBeVisible();
  await expect(page.getByText("Internal invoice records from accepted quotes or completed Jobs")).toBeVisible();
  await expect(page.getByText(/does not send that invoice, collect payment, or create and reconcile a QuickBooks invoice/i)).toBeVisible();
  await expect(page.getByText(/Most popular/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Coming Soon" })).toHaveCount(2);
  for (const button of await page.getByRole("button", { name: "Coming Soon" }).all()) {
    await expect(button).toBeDisabled();
  }

  await page.goto("/solutions/hvac");
  await expect(page.getByRole("link", { name: "See the quote-to-job workflow" })).toHaveAttribute("href", "/solutions#workflow");
  await expect(page.getByRole("link", { name: "See Basic pricing" })).toHaveAttribute("href", "/pricing");
});

test("operational marketing pages stay responsive at release widths", async ({ page }) => {
  test.setTimeout(120_000);
  for (const width of RESPONSIVE_WIDTHS) {
    await page.setViewportSize({ width, height: width < 1000 ? 844 : 900 });
    for (const route of PUBLIC_OPERATIONAL_ROUTES) {
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1, name: PUBLIC_ROUTE_SEO[route].heading })).toBeVisible();
      await expectNoPageOverflow(page, `${route} at ${width}px`);
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const kodyControlBox = await page.getByRole("button", { name: "What is on my schedule today?" }).boundingBox();
  expect(kodyControlBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  const trialControlBox = await page.getByRole("button", { name: /Start your 20-day free trial/i }).first().boundingBox();
  expect(trialControlBox?.height ?? 0).toBeGreaterThanOrEqual(44);
});

test("operational marketing pages pass Axe at phone and desktop widths", async ({ page }) => {
  test.setTimeout(120_000);
  // Audit the stable rendered state rather than a partially transparent reveal-transition frame.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const requestedPath = process.env.E2E_PUBLIC_PATH;
  const routes = requestedPath
    ? PUBLIC_OPERATIONAL_ROUTES.filter((route) => route === requestedPath)
    : PUBLIC_OPERATIONAL_ROUTES;
  expect(routes.length, "E2E_PUBLIC_PATH must match an operational public route").toBeGreaterThan(0);
  for (const width of [390, 1440] as const) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const route of routes) {
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1, name: PUBLIC_ROUTE_SEO[route].heading })).toBeVisible();
      await expectNoSeriousAccessibilityViolations(page, `${route} at ${width}px`);
    }
  }
});

test("Kody examples support keyboard use and reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const scheduleControl = page.getByRole("button", { name: "What is on my schedule today?" });
  await scheduleControl.focus();
  await expect(scheduleControl).toBeFocused();
  await scheduleControl.press("Enter");
  await expect(scheduleControl).toHaveAttribute("aria-pressed", "true");
  await expect(scheduleControl).not.toHaveCSS("box-shadow", "none");

  await scheduleControl.press("Tab");
  const bookingControl = page.getByRole("button", { name: "Prepare a visit for the Smith job tomorrow at 9 a.m." });
  await expect(bookingControl).toBeFocused();
  await bookingControl.press("Space");
  await expect(page.locator("#kody-example-response")).toContainText(/Nothing is booked until/i);

  const animatedStyles = await page.locator(".qf-demo-pane-enter").evaluateAll((elements) =>
    elements.map((element) => {
      const style = window.getComputedStyle(element);
      return { animationName: style.animationName, transitionDuration: style.transitionDuration };
    }),
  );
  expect(animatedStyles.length).toBeGreaterThan(0);
  expect(animatedStyles.every((style) => style.animationName === "none" && style.transitionDuration === "0s")).toBe(true);

  const revealStyles = await page.locator("[data-marketing-reveal]").evaluateAll((elements) =>
    elements.map((element) => {
      const style = window.getComputedStyle(element);
      return { opacity: style.opacity, transform: style.transform };
    }),
  );
  expect(revealStyles.every((style) => style.opacity === "1" && style.transform === "none")).toBe(true);
});
