import { expect, test } from "@playwright/test";
import { addSessionCookie, addWorkspaceMemberViaApi, apiBaseUrl, createCustomerViaApi, signUpViaApi } from "./helpers";

test("owners can add, complete, undo, and review assigned tasks on mobile", async ({ context, page, request }) => {
  const account = await signUpViaApi(request, "activity-task-mobile");
  const customer = await createCustomerViaApi(request, account, {
    fullName: "Mobile Task Customer",
    phone: "555-014-8811",
    email: "mobile-task@example.com",
  });
  await addSessionCookie(context, account);

  await page.goto("/app/follow-up");
  const myWork = page.getByRole("region", { name: "My work tasks" });
  await expect(myWork).toBeVisible({ timeout: 20_000 });
  await myWork.getByRole("button", { name: "Add task", exact: true }).first().click();

  const dialog = page.getByRole("dialog", { name: "Create activity task" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Find customer").fill(customer.fullName);
  await expect(dialog.getByLabel("Customer", { exact: true })).toContainText(customer.fullName);
  await dialog.getByLabel("Customer", { exact: true }).selectOption(customer.id);
  await dialog.getByLabel("Task title").fill("Confirm the garden service date");
  await dialog.getByRole("button", { name: "Add task", exact: true }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });

  await expect(page.getByText("Task added", { exact: true })).toBeVisible();
  const taskRow = myWork.getByRole("article").filter({ hasText: "Confirm the garden service date" });
  await expect(taskRow).toBeVisible();
  await expect(taskRow.getByText(customer.fullName, { exact: false })).toBeVisible();
  await taskRow.getByRole("button", { name: "Complete", exact: true }).click();
  await expect(page.getByText("Task completed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(taskRow).toBeVisible();

  const listed = await request.get(`${apiBaseUrl}/v1/activities?search=Confirm%20the%20garden%20service%20date`, {
    headers: { Cookie: account.cookieHeader },
  });
  expect(listed.status()).toBe(200);
  const matchingTasks = (await listed.json()) as { items: Array<{ id: string; title: string; version: number }> };
  expect(matchingTasks.items).toHaveLength(1);
  const currentTask = matchingTasks.items[0]!;

  await taskRow.getByRole("button", { name: "Edit", exact: true }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit activity task" });
  await editDialog.getByLabel("Task title").fill("My stale local change");
  const externalUpdate = await request.patch(`${apiBaseUrl}/v1/activities/${currentTask.id}`, {
    headers: { Cookie: account.cookieHeader, "Idempotency-Key": "e2e-external-task-update-0001" },
    data: { version: currentTask.version, title: "Current server task" },
  });
  expect(externalUpdate.status()).toBe(200);
  await editDialog.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(editDialog.getByRole("button", { name: "Reload latest task", exact: true })).toBeVisible();
  await editDialog.getByRole("button", { name: "Reload latest task", exact: true }).click();
  await expect(editDialog).toBeHidden();
  await expect(myWork.getByText("Current server task", { exact: true })).toBeVisible();

  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  for (const control of await taskRow.getByRole("button").all()) {
    expect((await control.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  }

  await page.evaluate(() => window.localStorage.setItem("qf_theme_preference", "dark"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByText("Current server task", { exact: true })).toBeVisible();
});

test("members see only their work and tasks are assigned to them", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "activity-task-member");
  const member = await addWorkspaceMemberViaApi(request, owner, "Mobile Field Member");
  const otherMember = await addWorkspaceMemberViaApi(request, owner, "Other Field Member");
  const customer = await createCustomerViaApi(request, owner, {
    fullName: "Assigned Mobile Customer",
    phone: "555-014-8822",
    email: "assigned-mobile@example.com",
    assignedTenantUserId: member.membershipId,
  });
  const otherCustomer = await createCustomerViaApi(request, owner, {
    fullName: "Other Member Customer",
    phone: "555-014-8833",
    email: "other-member@example.com",
    assignedTenantUserId: otherMember.membershipId,
  });
  const otherTask = await request.post(`${apiBaseUrl}/v1/activities`, {
    headers: {
      Cookie: owner.cookieHeader,
      "Idempotency-Key": "e2e-other-member-task-0001",
    },
    data: {
      customerId: otherCustomer.id,
      assignedTenantUserId: otherMember.membershipId,
      type: "FOLLOW_UP",
      priority: "NORMAL",
      title: "Hidden task for another member",
      dueAtUtc: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
  });
  expect(otherTask.status()).toBe(201);

  await addSessionCookie(context, member);
  await page.goto("/app/follow-up");
  await expect(page.getByRole("button", { name: "Team", exact: true })).toHaveCount(0);
  const myWork = page.getByRole("region", { name: "My work tasks" });
  await myWork.getByRole("button", { name: "Add task", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create activity task" });
  await dialog.getByLabel("Find customer").fill(customer.fullName);
  await dialog.getByLabel("Customer", { exact: true }).selectOption(customer.id);
  await dialog.getByLabel("Task title").fill("My assigned mobile task");
  await expect(dialog.getByText("Assigned to", { exact: true })).toBeVisible();
  await expect(dialog.getByText("You", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Assigned to")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Add task", exact: true }).click();

  await expect(myWork.getByText("My assigned mobile task", { exact: true })).toBeVisible();
  await expect(page.getByText("Hidden task for another member", { exact: true })).toHaveCount(0);

  await myWork.getByRole("button", { name: "Add task", exact: true }).first().click();
  const dirtyDialog = page.getByRole("dialog", { name: "Create activity task" });
  await dirtyDialog.getByLabel("Task title").fill("Unsaved member task");
  await dirtyDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const discardDialog = page.getByRole("dialog", { name: "Discard task changes?" });
  await expect(discardDialog).toBeVisible();
  await discardDialog.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(discardDialog).toBeHidden();
  await expect(dirtyDialog).toBeHidden();
});

test("owners can edit and reassign on a fresh page without opening Add first", async ({ context, page, request }) => {
  const owner = await signUpViaApi(request, "activity-task-edit-first");
  const originalMember = await addWorkspaceMemberViaApi(request, owner, "Original Assignee");
  const nextMember = await addWorkspaceMemberViaApi(request, owner, "Next Assignee");
  const customer = await createCustomerViaApi(request, owner, {
    fullName: "Fresh Edit Customer",
    phone: "555-014-8855",
    email: "fresh-edit@example.com",
    assignedTenantUserId: originalMember.membershipId,
  });
  const created = await request.post(`${apiBaseUrl}/v1/activities`, {
    headers: { Cookie: owner.cookieHeader, "Idempotency-Key": "e2e-edit-first-create-0001" },
    data: {
      customerId: customer.id,
      assignedTenantUserId: originalMember.membershipId,
      type: "FOLLOW_UP",
      priority: "NORMAL",
      title: "Reassign this fresh task",
      dueAtUtc: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
  });
  expect(created.status()).toBe(201);
  const customerReassignment = await request.patch(`${apiBaseUrl}/v1/customers/${customer.id}`, {
    headers: { Cookie: owner.cookieHeader },
    data: { assignedTenantUserId: nextMember.membershipId },
  });
  expect(customerReassignment.status()).toBe(200);

  await addSessionCookie(context, owner);
  await page.goto("/app/follow-up");
  await page.getByRole("button", { name: "Team", exact: true }).click();
  const teamWork = page.getByRole("region", { name: "Team tasks" });
  const taskRow = teamWork.getByRole("article").filter({ hasText: "Reassign this fresh task" });
  await expect(taskRow).toBeVisible({ timeout: 20_000 });
  await taskRow.getByRole("button", { name: "Edit", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Edit activity task" });
  const assignee = dialog.getByLabel("Assigned to");
  await expect(assignee).toContainText("Original Assignee");
  await expect(assignee).toContainText("Next Assignee");
  await assignee.selectOption(nextMember.membershipId);
  await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(taskRow.getByText("Assigned to Next Assignee", { exact: false })).toBeVisible();
});

test("activity tasks stay readable from phone through desktop widths", async ({ context, page, request }) => {
  test.setTimeout(120_000);
  const account = await signUpViaApi(request, "activity-task-responsive");
  const customer = await createCustomerViaApi(request, account, {
    fullName: "Responsive Activity Customer",
    phone: "555-014-8844",
    email: "responsive-activity@example.com",
  });
  const created = await request.post(`${apiBaseUrl}/v1/activities`, {
    headers: { Cookie: account.cookieHeader, "Idempotency-Key": "e2e-responsive-task-0001" },
    data: {
      customerId: customer.id,
      type: "CHECK_IN",
      priority: "HIGH",
      title: "Review the scheduled customer visit",
      dueAtUtc: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    },
  });
  expect(created.status()).toBe(201);
  await addSessionCookie(context, account);

  for (const viewport of [
    { width: 360, height: 800 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/app/follow-up");
    const myWork = page.getByRole("region", { name: "My work tasks" });
    await expect(myWork.getByText("Review the scheduled customer visit", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

    const taskRow = myWork.getByRole("article").filter({ hasText: "Review the scheduled customer visit" });
    if (viewport.width <= 768) {
      for (const control of await taskRow.getByRole("button").all()) {
        expect((await control.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      }
    }

    await page.getByRole("button", { name: "Team", exact: true }).click();
    await expect(page.getByRole("region", { name: "Team tasks" })).toBeVisible();
    await page.getByRole("button", { name: "My work", exact: true }).click();
    await myWork.getByRole("button", { name: "Add task", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Create activity task" });
    await expect(dialog).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
  }
});
