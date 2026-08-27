import { expect, test } from "@playwright/test";
import { PUBLIC_ROUTE_SEO } from "../../web/src/lib/public-seo-data";

test("public navigation, services, legal pages, and consent work on mobile", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await page.evaluate(() => localStorage.removeItem("qf_cookie_consent"));
  await page.reload();

  const consent = page.getByRole("complementary", { name: "Cookie preferences" });
  await expect(consent).toBeVisible();
  const essentialButtonBox = await consent.getByRole("button", { name: "Essential only" }).boundingBox();
  const analyticsButtonBox = await consent.getByRole("button", { name: "Accept analytics" }).boundingBox();
  expect(Math.abs((essentialButtonBox?.y ?? 0) - (analyticsButtonBox?.y ?? 0))).toBeLessThanOrEqual(2);
  await consent.getByRole("button", { name: "Essential only" }).click();

  const demoView = page.getByRole("group", { name: "Quote workflow preview" });
  await demoView.scrollIntoViewIfNeeded();
  await demoView.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByText("Quote preview", { exact: true })).toBeVisible();
  await demoView.getByRole("button", { name: "Edit quote", exact: true }).click();
  await expect(page.getByText("Editable quote sheet", { exact: true })).toBeVisible();

  await expect(page.getByRole("button", { name: "Pause workflow highlights" })).toHaveCount(0);
  await expect(page.locator(".qf-momentum-track")).toHaveCount(0);

  const productStory = page.locator("#product-story");
  await productStory.scrollIntoViewIfNeeded();
  await expect(productStory.getByRole("heading", { name: "Move from accepted quote to a finished, billable job." })).toBeVisible();
  const productImages = productStory.getByRole("img");
  await expect(productImages).toHaveCount(3);
  for (const image of await productImages.all()) {
    await image.scrollIntoViewIfNeeded();
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute("loading", "lazy");
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.currentSrc)).toContain("-mobile-v2.webp");
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThanOrEqual(300);
  }
  expect((await productImages.first().boundingBox())?.width).toBeGreaterThanOrEqual(300);
  expect((await productImages.last().boundingBox())?.width).toBeGreaterThanOrEqual(300);

  for (const [controlName, imageName] of [
    ["Kody review", /Kody displaying a review/i],
    ["Job detail", /QuoteFly job detail/i],
    ["Notifications", /QuoteFly notification center/i],
  ] as const) {
    const control = productStory.getByRole("button", { name: controlName, exact: true });
    expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await control.click();
    await expect(control).toHaveAttribute("aria-pressed", "true");
    const selectedImage = productStory.getByRole("img", { name: imageName });
    await expect(selectedImage).toBeVisible();
    await expect.poll(() => selectedImage.evaluate((element: HTMLImageElement) => element.currentSrc)).toContain("-mobile-v2.webp");
    await expect.poll(() => selectedImage.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThanOrEqual(300);
  }
  const productCta = productStory.getByRole("button", { name: "Try the real workflow free" });
  expect((await productCta.boundingBox())?.height).toBeGreaterThanOrEqual(44);

  const landingOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(landingOverflow).toBeLessThanOrEqual(1);

  const menuButton = page.locator('button[aria-controls="mobile-primary-navigation"]');
  await expect(menuButton).toHaveAttribute("aria-expanded", "false");
  await menuButton.click();
  await expect(menuButton).toHaveAttribute("aria-expanded", "true");
  await page.locator("#mobile-primary-navigation").getByRole("link", { name: "Services", exact: true }).click();

  await expect(page).toHaveURL("/services");
  await expect(page.getByRole("heading", { level: 1, name: PUBLIC_ROUTE_SEO["/services"].heading })).toBeVisible();
  const serviceProductImage = page.getByRole("img", { name: /Kody preparing a structured QuoteFly quote draft/i });
  await expect(serviceProductImage).toBeVisible();
  await expect.poll(() => serviceProductImage.evaluate((image: HTMLImageElement) => image.currentSrc)).toContain("-mobile-v2.webp");
  await expect(page.getByRole("list", { name: "Customer to internal invoice workflow" }).getByRole("listitem")).toHaveCount(6);

  await page.goto("/solutions");
  await expect(page.getByRole("heading", { level: 1, name: PUBLIC_ROUTE_SEO["/solutions"].heading })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Trade solutions" })).toBeVisible();
  await expect(page.getByRole("img", { name: /residential construction worker framing/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /quoting headaches do not/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: "HVAC", exact: true })).toBeVisible();
  const kodySimulation = page.locator("#kody");
  await kodySimulation.scrollIntoViewIfNeeded();
  const kodyControls = kodySimulation.getByRole("group", { name: "Kody scripted workflows" }).getByRole("button");
  await expect(kodyControls).toHaveCount(3);
  for (const control of await kodyControls.all()) {
    expect((await control.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await kodySimulation.getByRole("button", { name: "New quote", exact: true }).click();
  await expect(kodySimulation.getByText("Custom Wooden Dining Table Quote", { exact: true })).toBeVisible();

  const fieldImage = page.getByRole("img", { name: /contractor inspecting field equipment/i });
  await fieldImage.scrollIntoViewIfNeeded();
  await expect(fieldImage).toBeVisible();
  await expect.poll(
    () => fieldImage.evaluate((image: HTMLImageElement) => image.naturalWidth),
    { message: "the lazy field image should finish decoding at its canonical width" },
  ).toBe(1600);
  await expect(page.getByRole("img", { name: /carpenter measuring and marking/i })).toBeVisible();

  const solutionsOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(solutionsOverflow).toBeLessThanOrEqual(1);

  await page.goto("/about");
  await expect(page.getByRole("heading", { level: 1, name: PUBLIC_ROUTE_SEO["/about"].heading })).toBeVisible();
  const aboutWorkflow = page.locator("#workflow");
  await expect(aboutWorkflow.getByRole("listitem")).toHaveCount(5);
  const aboutProductImage = page.getByRole("img", { name: /My Day workspace showing follow-up activity/i });
  await aboutProductImage.scrollIntoViewIfNeeded();
  await expect(aboutProductImage).toBeVisible();
  await expect.poll(() => aboutProductImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  const aboutOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(aboutOverflow).toBeLessThanOrEqual(1);

  const tradeRoutes = [
    ["/solutions/hvac", "HVAC", /HVAC technician servicing/i],
    ["/solutions/plumbing", "Plumbing", /Residential plumber repairing/i],
    ["/solutions/flooring", "Flooring", /Flooring installer aligning/i],
    ["/solutions/roofing", "Roofing", /Roofing contractor carrying/i],
    ["/solutions/landscaping", "Landscaping", /Landscaping professional preparing/i],
    ["/solutions/construction", "Construction", /Construction professional framing/i],
  ] as const;

  for (const [route, tradeName, imageName] of tradeRoutes) {
    await page.goto(route);
    await expect(page.getByRole("heading", { level: 1, name: PUBLIC_ROUTE_SEO[route].heading })).toBeVisible();
    await expect(page.getByRole("img", { name: imageName })).toBeVisible();
    await expect(page.getByRole("heading", { name: `How does QuoteFly help ${tradeName} contractors?` })).toBeVisible();
    await expect(page.getByRole("list", { name: `${tradeName} customer-to-invoice workflow` }).getByRole("listitem")).toHaveCount(6);
    await expect(page.getByRole("heading", { name: new RegExp(`Describe the ${tradeName.toLowerCase()} work`, "i") })).toBeVisible();
    await expect(page.getByText("Important boundary:", { exact: false })).toBeVisible();
    const tradeOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(tradeOverflow).toBeLessThanOrEqual(1);
  }

  const industryLinks = page.locator("footer").getByRole("link");
  for (const industry of ["HVAC", "Plumbing", "Flooring", "Roofing", "Landscaping", "Construction"]) {
    await expect(industryLinks.filter({ hasText: industry })).toHaveCount(1);
  }

  await page.goto("/privacy");
  await expect(page.getByRole("heading", { level: 1, name: PUBLIC_ROUTE_SEO["/privacy"].heading })).toBeVisible();
  await page.goto("/data-privacy");
  await expect(page.getByRole("heading", { level: 1, name: PUBLIC_ROUTE_SEO["/data-privacy"].heading })).toBeVisible();

  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(horizontalOverflow).toBeLessThanOrEqual(1);
});
