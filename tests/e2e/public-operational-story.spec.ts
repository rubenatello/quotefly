import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { BASIC_PLAN_PRICING_PATH } from "../../web/src/lib/plans";
import { PUBLIC_ROUTE_SEO } from "../../web/src/lib/public-seo-data";

const PUBLIC_OPERATIONAL_ROUTES = ["/", "/solutions", "/solutions/hvac", "/solutions/landscaping", "/services", "/pricing", "/about"] as const;
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
  await expect(page.locator("#landing-basic-plan")).toBeAttached();
  await expect(page.getByRole("link", { name: "Pricing" }).first()).toHaveAttribute("href", BASIC_PLAN_PRICING_PATH);
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

  await page.goto("/solutions");
  await expect(page.getByRole("heading", { level: 1, name: PUBLIC_ROUTE_SEO["/solutions"].heading })).toBeVisible();
  const operationalKodyExamples = [
    ["Add customer", "#kody-panel-customer", /Jon.*Bacon.*555.*jon\.bacon@example\.com/is],
    ["New quote", "#kody-panel-quote", /Custom Wooden Dining Table Quote.*materials.*\$2,000.*labor.*\$1,500.*\$3,500/is],
    ["Today’s priorities", "#kody-panel-attention", /Call Morgan about the sent estimate.*Confirm tomorrow’s HVAC access.*Review the table quote measurements/is],
    ["Book job from quote", "#kody-panel-booking", /Accepted quote.*Linked Job.*QuoteFly calendar opening.*No active booking overlap.*Dispatch is a second confirmed step/is],
  ] as const;
  for (const [label, panelSelector, resultPattern] of operationalKodyExamples) {
    const control = page.getByRole("button", { name: label, exact: true });
    await control.click();
    await expect(control).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(panelSelector)).toHaveAttribute("role", "region");
    await expect(page.locator(panelSelector)).toContainText(resultPattern);
  }
  const solutionsWorkflow = page.locator("#workflow").getByRole("list");
  await expect(solutionsWorkflow.getByRole("listitem")).toHaveCount(6);
  await expect(page.getByText(/external invoice sending, payment collection, and QuickBooks invoice creation are not part/i)).toBeVisible();
  const basicPricingLink = page.getByRole("link", { name: "See Basic pricing" });
  await expect(basicPricingLink).toHaveAttribute("href", BASIC_PLAN_PRICING_PATH);
  await basicPricingLink.click();
  await expect(page).toHaveURL(new RegExp(`${BASIC_PLAN_PRICING_PATH}$`));
  await expect(page.locator("#basic-plan")).toBeInViewport();
  await expect.poll(() => page.locator("#basic-plan").evaluate((element) => element.getBoundingClientRect().top)).toBeLessThanOrEqual(110);

  await expect(page.getByRole("heading", { level: 1, name: PUBLIC_ROUTE_SEO["/pricing"].heading })).toBeVisible();
  await expect(page.getByText("Basic payment timeline", { exact: true })).toBeVisible();
  await expect(page.getByText("Accepted-quote Jobs with day/week scheduling and dispatch controls")).toBeVisible();
  await expect(page.getByText("Internal invoice records from accepted quotes or completed Jobs")).toBeVisible();
  await expect(page.getByRole("heading", { name: "What Basic includes—and where it stops" })).toBeVisible();
  await expect(page.getByText("QuoteFly calendar only; no external-calendar sync or route optimization.")).toBeVisible();
  await expect(page.getByText("Basic does not send that invoice, collect payment, or create and reconcile a QuickBooks invoice.")).toBeVisible();
  const integrations = page.locator("#integrations");
  await expect(integrations.getByRole("heading", { name: "Integrations on the horizon" })).toBeVisible();
  await expect(integrations.getByRole("article")).toHaveCount(3);
  await expect(integrations.getByText("QuickBooks-friendly CSV export", { exact: true })).toBeVisible();
  await expect(integrations.getByText(/does not currently connect to QuickBooks Online/i)).toBeVisible();
  await expect(integrations.getByText(/EDI is not currently planned/i)).toBeVisible();
  await expect(integrations.getByRole("link", { name: "Request an integration" })).toHaveAttribute("href", "/support#feature-request");
  await expect(page.getByRole("link", { name: "Integrations roadmap" })).toHaveAttribute("href", "/pricing#integrations");
  await expect(page.getByText(/Most popular/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Coming Soon" })).toHaveCount(2);
  for (const button of await page.getByRole("button", { name: "Coming Soon" }).all()) {
    await expect(button).toBeDisabled();
  }
  await page.getByText("Is there a free trial?", { exact: true }).click();
  await expect(page.getByText(/Every workspace starts with a 20-day free trial/i)).toBeVisible();

  await page.goto("/solutions/hvac");
  await expect(page.getByRole("link", { name: "See the quote-to-job workflow" })).toHaveAttribute("href", "/solutions#workflow");
  await expect(page.getByRole("link", { name: "See Basic pricing" })).toHaveAttribute("href", BASIC_PLAN_PRICING_PATH);

  await page.goto("/about");
  await expect(page.getByRole("heading", { level: 1, name: PUBLIC_ROUTE_SEO["/about"].heading })).toBeVisible();
  const aboutWorkflow = page.locator("#workflow").getByRole("list");
  await expect(aboutWorkflow.getByRole("listitem")).toHaveCount(5);
  await expect(page.getByText(/does not claim autonomous booking or sending/i)).toBeVisible();
  await expect(page.getByRole("link", { name: "See Basic pricing" })).toHaveAttribute("href", BASIC_PLAN_PRICING_PATH);
});

test("operational marketing pages stay responsive at release widths", async ({ page }) => {
  // This test performs 35 full-page navigations before its post-loop touch-target
  // checks. Cold Node/Docker launch runners can legitimately exceed two minutes
  // without a failed assertion, so keep enough headroom to report the actual
  // responsive result instead of timing out inside an active overflow poll.
  test.setTimeout(300_000);
  for (const width of RESPONSIVE_WIDTHS) {
    await page.setViewportSize({ width, height: width < 1000 ? 844 : 900 });
    for (const route of PUBLIC_OPERATIONAL_ROUTES) {
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1, name: PUBLIC_ROUTE_SEO[route].heading })).toBeVisible();
      await expectNoPageOverflow(page, `${route} at ${width}px`);
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/solutions");
  const kodyControlBox = await page.getByRole("button", { name: "Today’s priorities", exact: true }).boundingBox();
  expect(kodyControlBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  const bookingControlBox = await page.getByRole("button", { name: "Book job from quote", exact: true }).boundingBox();
  expect(bookingControlBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await page.goto("/");
  const trialControlBox = await page.getByRole("button", { name: /Start your 20-day free trial/i }).first().boundingBox();
  expect(trialControlBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  const kodyTeaserLink = page.getByRole("link", { name: "Explore the guided Kody simulation" });
  expect((await kodyTeaserLink.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await kodyTeaserLink.click();
  await expect(page).toHaveURL(/\/solutions#kody$/);
  await expect(page.getByRole("heading", { name: "One request becomes organized work." })).toBeVisible();
  await expect(page.locator("#kody")).toBeInViewport();
  await page.goto("/");
  for (const controlName of ["My Day", "Kody review", "Schedule", "Job detail", "Invoice record", "Notifications"]) {
    const controlBox = await page.locator("#product-story").getByRole("button", { name: controlName, exact: true }).boundingBox();
    expect(controlBox?.height ?? 0, `${controlName} must remain touchable at 390px`).toBeGreaterThanOrEqual(44);
  }

  await page.goto("/pricing");
  const pricingTrialBox = await page.getByRole("button", { name: "Start Free Trial" }).first().boundingBox();
  expect(pricingTrialBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  const pricingFaqBox = await page.locator("details").filter({ hasText: "Is there a free trial?" }).locator("summary").boundingBox();
  expect(pricingFaqBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  const integrationRequestBox = await page.getByRole("link", { name: "Request an integration" }).boundingBox();
  expect(integrationRequestBox?.height ?? 0).toBeGreaterThanOrEqual(44);

  await page.goto("/services");
  await expect(page.getByRole("heading", { level: 1, name: PUBLIC_ROUTE_SEO["/services"].heading })).toBeVisible();
  await expect(page.getByRole("list", { name: "Customer to internal invoice workflow" }).getByRole("listitem")).toHaveCount(6);
  await expect(page.getByText(/does not send customer invoices or collect payment/i)).toBeVisible();
  await expect(page.getByRole("img", { name: /Kody preparing a structured QuoteFly quote draft/i })).toBeVisible();

  await page.goto("/about");
  const aboutTrialBox = await page.getByRole("button", { name: "Start free trial" }).first().boundingBox();
  expect(aboutTrialBox?.height ?? 0).toBeGreaterThanOrEqual(44);
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
  const aiRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/v1\/ai(?:\/|\?|$)/.test(new URL(request.url()).pathname)) aiRequests.push(request.url());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/solutions");

  const customerControl = page.getByRole("button", { name: "Add customer", exact: true });
  await customerControl.focus();
  await expect(customerControl).toBeFocused();
  await customerControl.press("Enter");
  await expect(customerControl).toHaveAttribute("aria-pressed", "true");
  await expect(customerControl).not.toHaveCSS("box-shadow", "none");

  await customerControl.press("Tab");
  const quoteControl = page.getByRole("button", { name: "New quote", exact: true });
  await expect(quoteControl).toBeFocused();
  await quoteControl.press("Space");
  await expect(quoteControl).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#kody-panel-quote")).toContainText(/Custom Wooden Dining Table Quote/i);
  await expect(page.getByRole("status")).toHaveText("Showing the New quote sample result.");
  const bookingControl = page.getByRole("button", { name: "Book job from quote", exact: true });
  await bookingControl.focus();
  await bookingControl.press("Enter");
  await expect(bookingControl).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#kody-panel-booking")).toContainText(/No active booking overlap/i);
  await expect(page.getByRole("status")).toHaveText("Showing the Book job from quote sample result.");
  const kodyAnimatedStyles = await page.locator("#kody .qf-demo-pane-enter").evaluateAll((elements) =>
    elements.map((element) => {
      const style = window.getComputedStyle(element);
      return { animationName: style.animationName, transitionDuration: style.transitionDuration };
    }),
  );
  expect(kodyAnimatedStyles.length).toBeGreaterThan(0);
  expect(kodyAnimatedStyles.every((style) => style.animationName === "none" && style.transitionDuration === "0s")).toBe(true);
  expect(aiRequests).toEqual([]);

  await page.goto("/");
  const jobDetailControl = page.locator("#product-story").getByRole("button", { name: "Job detail", exact: true });
  await jobDetailControl.focus();
  await expect(jobDetailControl).toBeFocused();
  await jobDetailControl.press("Enter");
  await expect(jobDetailControl).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("img", { name: /QuoteFly job detail showing/i })).toBeVisible();

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
