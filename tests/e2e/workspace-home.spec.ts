import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  addSessionCookie,
  apiBaseUrl,
  createCustomerViaApi,
  createQuoteViaApi,
  signUpViaApi,
  uniqueRunLabel,
} from "./helpers";

test("members can access support identifiers without seeing management navigation", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "workspace-member-navigation");
  const memberEmail = `${uniqueRunLabel("workspace-member")}@example.com`;
  const createMember = await request.post(`${apiBaseUrl}/v1/org/users`, {
    headers: { Cookie: owner.cookieHeader },
    data: {
      fullName: "Workspace Field Member",
      email: memberEmail,
      password: "TestPassword123!",
      role: "member",
    },
  });
  expect(createMember.status()).toBe(201);

  const member = await signUpViaApi(request, "workspace-member-signin", memberEmail);
  await addSessionCookie(context, member);
  await page.goto("/app");
  await expect(page.getByTestId("workspace-home")).toBeVisible({ timeout: 20_000 });

  await expect(page.getByRole("button", { name: "My info", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Team & users", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Branding", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Products", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "My info", exact: true }).click();
  await expect(page.getByText(owner.tenant.id, { exact: true })).toBeVisible();
  await expect(page.getByText(memberEmail, { exact: true })).toBeVisible();
  await expect(page.getByText(member.user.id, { exact: true })).toBeVisible();
  await expect(page.getByText("Member", { exact: true })).toBeVisible();

  await page.goto("/app/settings/users");
  await expect(page).toHaveURL(/\/app\/settings$/);
  await page.goto("/app/branding");
  await expect(page).toHaveURL(/\/app\/settings$/);
});

test("workspace home summarizes leads, quote momentum, and priority work without a list-page waterfall", async ({
  context,
  page,
  request,
}) => {
  const captureDirectory = process.env.E2E_CAPTURE_DIR;
  if (captureDirectory) await mkdir(captureDirectory, { recursive: true });
  const account = await signUpViaApi(request, "workspace-home");
  const unquotedCustomer = await createCustomerViaApi(request, account, {
    fullName: "Home Unquoted Lead",
    phone: "555-014-1101",
    email: "home-unquoted@example.com",
  });
  const quotedCustomer = await createCustomerViaApi(request, account, {
    fullName: "Home Quoted Customer",
    phone: "555-014-1102",
    email: "home-quoted@example.com",
  });
  const quote = await createQuoteViaApi(request, account, quotedCustomer.id, {
    title: "Home Roof Repair Quote",
  });
  const sent = await request.patch(`${apiBaseUrl}/v1/quotes/${quote.id}`, {
    headers: { Cookie: account.cookieHeader },
    data: { status: "SENT_TO_CUSTOMER" },
  });
  expect(sent.status()).toBe(200);

  await addSessionCookie(context, account);
  const workspaceRequests: string[] = [];
  page.on("request", (browserRequest) => {
    if (browserRequest.url().startsWith(apiBaseUrl)) workspaceRequests.push(browserRequest.url());
  });

  await page.goto("/app");
  await expect(page).toHaveURL(/\/app\/?$/);
  await expect(page.getByTestId("workspace-home")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1, name: "Home", exact: true })).toHaveClass(/sr-only/);
  await expect(page.getByText("Good morning", { exact: false }).or(page.getByText("Good afternoon", { exact: false })).or(page.getByText("Good evening", { exact: false }))).toBeVisible();

  await expect(page.getByText("Unquoted leads", { exact: true })).toBeVisible();
  await expect(page.getByText("Needs follow-up", { exact: true })).toBeVisible();
  await expect(page.getByText("Open pipeline", { exact: true })).toBeVisible();
  await expect(page.getByText("$1,600", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Home Unquoted Lead", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Home Quoted Customer", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Home Roof Repair Quote", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Awaiting response", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Prioritize my day", exact: true })).toBeVisible();
  await expect(page.getByTestId("kody-launcher")).toBeHidden();
  await expect(page.getByRole("button", { name: "New quote", exact: true })).toHaveCount(1);
  const metricCards = page.getByRole("region", { name: "Workspace summary" }).getByRole("button");
  await expect(metricCards).toHaveCount(4);
  expect((await metricCards.first().boundingBox())?.height ?? 0).toBeLessThanOrEqual(120);

  expect(workspaceRequests.filter((url) => url.includes("/v1/workspace/overview"))).toHaveLength(1);
  expect(workspaceRequests.filter((url) => /\/v1\/(customers|quotes)(\?|$)/.test(url))).toHaveLength(0);

  await expect(page.getByRole("button", { name: "Home", exact: true })).toHaveAttribute("aria-current", "page");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1);
  await expect(page.getByRole("navigation", { name: "Mobile workspace" }).getByRole("button", { name: "Home", exact: true }))
    .toHaveAttribute("aria-current", "page");

  await page.getByRole("button", { name: "My info", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/about$/);
  await expect(page.getByText(account.tenant.name, { exact: true })).toBeVisible();
  await expect(page.getByText(account.tenant.id, { exact: true })).toBeVisible();
  await expect(page.getByText(account.email, { exact: true })).toBeVisible();
  await expect(page.getByText(account.user.id, { exact: true })).toBeVisible();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
  const copyIdButton = page.getByRole("button", { name: "Copy tenant ID", exact: true });
  expect((await copyIdButton.boundingBox())?.height).toBeGreaterThanOrEqual(38);
  await copyIdButton.click();
  await expect(page.getByText("Tenant ID copied", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByTestId("workspace-home")).toBeVisible();

  if (captureDirectory) {
    await page.screenshot({ path: path.join(captureDirectory, "workspace-home-desktop-light.png"), fullPage: true });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByTestId("workspace-home")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("dialog", { name: "Workspace navigation" }).getByRole("button", { name: "Home", exact: true }))
    .toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Escape");
  if (captureDirectory) {
    await page.screenshot({ path: path.join(captureDirectory, "workspace-home-mobile-light.png"), fullPage: true });
  }

  await page.evaluate(() => window.localStorage.setItem("qf_theme_preference", "dark"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByTestId("workspace-home")).toBeVisible();
  await expect(page.getByText(unquotedCustomer.fullName, { exact: true }).first()).toBeVisible();
  if (captureDirectory) {
    await page.screenshot({ path: path.join(captureDirectory, "workspace-home-mobile-dark.png"), fullPage: true });
  }
});
