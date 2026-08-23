import { expect, test } from "@playwright/test";
import {
  addSessionCookie,
  addWorkspaceMemberViaApi,
  apiBaseUrl,
  createCustomerViaApi,
  createQuoteViaApi,
  signUpViaApi,
} from "./helpers";

test("schedule workspace is URL-backed, responsive, complete, and manager-reviewed", async ({ context, page, request }) => {
  test.setTimeout(180_000);

  const owner = await signUpViaApi(request, "schedule-workspace");
  const member = await addWorkspaceMemberViaApi(request, owner, "Schedule Field Member");
  const customer = await createCustomerViaApi(request, owner, {
    fullName: "Schedule Calendar Customer",
    phone: "555-014-8821",
    email: "schedule-calendar@example.com",
  });
  const quote = await createQuoteViaApi(request, owner, customer.id, { title: "Calendar HVAC Visit" });

  const customerAssignment = await request.patch(`${apiBaseUrl}/v1/customers/${customer.id}`, {
    headers: { Cookie: owner.cookieHeader },
    data: { assignedTenantUserId: member.membershipId },
  });
  expect(customerAssignment.status()).toBe(200);
  const quoteAssignment = await request.patch(`${apiBaseUrl}/v1/quotes/${quote.id}`, {
    headers: { Cookie: owner.cookieHeader },
    data: { assignedTenantUserId: member.membershipId },
  });
  expect(quoteAssignment.status()).toBe(200);
  const accepted = await request.patch(`${apiBaseUrl}/v1/quotes/${quote.id}`, {
    headers: { Cookie: owner.cookieHeader },
    data: { status: "ACCEPTED" },
  });
  expect(accepted.status()).toBe(200);

  const jobsResponse = await request.get(`${apiBaseUrl}/v1/jobs?search=Calendar%20HVAC%20Visit&limit=25&offset=0`, {
    headers: { Cookie: owner.cookieHeader },
  });
  expect(jobsResponse.status()).toBe(200);
  const jobs = (await jobsResponse.json()) as {
    items: Array<{ id: string; version: number; assignedTenantUserId: string | null }>;
  };
  const job = jobs.items[0];
  expect(job).toBeTruthy();
  if (job.assignedTenantUserId !== member.membershipId) {
    const assigned = await request.patch(`${apiBaseUrl}/v1/jobs/${job.id}`, {
      headers: { Cookie: owner.cookieHeader },
      data: { version: job.version, assignedTenantUserId: member.membershipId },
    });
    expect(assigned.status()).toBe(200);
  }

  const booking = await request.post(`${apiBaseUrl}/v1/jobs/${job.id}/appointments`, {
    headers: { Cookie: owner.cookieHeader },
    data: {
      assignedTenantUserId: member.membershipId,
      startsAtUtc: "2026-08-25T16:00:00.000Z",
      endsAtUtc: "2026-08-25T18:00:00.000Z",
      timeZone: "America/Los_Angeles",
      instructions: "Use the west driveway.",
    },
  });
  expect(booking.status()).toBe(201);
  const createdBooking = (await booking.json()) as { appointment: { id: string; version: number } };
  for (const [startsAtUtc, endsAtUtc] of [
    ["2026-08-25T19:00:00.000Z", "2026-08-25T19:15:00.000Z"],
    ["2026-08-25T19:15:00.000Z", "2026-08-25T19:30:00.000Z"],
  ]) {
    const shortBooking = await request.post(`${apiBaseUrl}/v1/jobs/${job.id}/appointments`, {
      headers: { Cookie: owner.cookieHeader },
      data: {
        assignedTenantUserId: member.membershipId,
        startsAtUtc,
        endsAtUtc,
        timeZone: "America/Los_Angeles",
      },
    });
    expect(shortBooking.status()).toBe(201);
  }

  await addSessionCookie(context, owner);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/jobs?view=schedule&range=week&date=2026-08-25&assignee=all");
  await expect(page.getByRole("heading", { name: "Today and upcoming work", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Schedule Calendar Customer", exact: true }).first()).toBeVisible();
  await expect(page).toHaveURL(/view=schedule/);
  await expect(page).toHaveURL(/range=week/);
  await expect(page).toHaveURL(/date=2026-08-25/);
  await expect(page).toHaveURL(/assignee=all/);
  await expect.poll(() => page.evaluate(() => {
    window.scrollTo({ left: 10_000, top: window.scrollY });
    return window.scrollX;
  })).toBeLessThanOrEqual(1);

  await page.getByRole("button", { name: "Day", exact: true }).click();
  await expect(page).toHaveURL(/range=day/);
  await page.getByRole("button", { name: "Next schedule range", exact: true }).click();
  await expect(page).toHaveURL(/date=2026-08-26/);
  await page.getByRole("button", { name: "Previous schedule range", exact: true }).click();
  await expect(page).toHaveURL(/date=2026-08-25/);

  await page.getByRole("button", { name: "Reschedule", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Review reschedule" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Start time", { exact: true }).fill("2026-08-25T10:00");
  await dialog.getByLabel("End time", { exact: true }).fill("2026-08-25T12:00");
  const externalReschedule = await request.patch(`${apiBaseUrl}/v1/jobs/${job.id}/appointments/${createdBooking.appointment.id}`, {
    headers: { Cookie: owner.cookieHeader },
    data: {
      version: createdBooking.appointment.version,
      startsAtUtc: "2026-08-25T16:15:00.000Z",
      endsAtUtc: "2026-08-25T18:15:00.000Z",
      timeZone: "America/Los_Angeles",
    },
  });
  expect(externalReschedule.status()).toBe(200);
  await dialog.getByRole("button", { name: "Confirm reschedule", exact: true }).click();
  const reloadRequest = page.waitForResponse((response) =>
    response.request().method() === "GET"
    && response.url().includes(`/v1/jobs/${job.id}/appointments?`),
  );
  await expect(dialog.getByRole("button", { name: "Load current version and keep my times", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Load current version and keep my times", exact: true }).click();
  expect((await reloadRequest).status()).toBe(200);
  await expect(dialog.getByLabel("Start time", { exact: true })).toHaveValue("2026-08-25T10:00");
  await expect(dialog.getByLabel("End time", { exact: true })).toHaveValue("2026-08-25T12:00");
  await expect(dialog.getByText("The current booking version is loaded. Your entered times were kept.", { exact: true })).toBeVisible();
  const patchResponse = page.waitForResponse((response) =>
    response.request().method() === "PATCH"
    && response.url().includes(`/v1/jobs/${job.id}/appointments/`),
  );
  await dialog.getByRole("button", { name: "Confirm reschedule", exact: true }).click();
  expect((await patchResponse).status()).toBe(200);
  await expect(dialog).toBeHidden();
  const scheduleReceiptNotice = page.getByRole("status").filter({ hasText: "Booking updated." });
  await expect(scheduleReceiptNotice).toContainText("An in-app update is available to the relevant team members.");
  await expect(scheduleReceiptNotice).toContainText("No email or text message was sent.");

  // A manager submitting the current window is a successful no-op: it must
  // close like a save, restore focus, and avoid a misleading update receipt.
  const noOpTrigger = page.getByRole("button", { name: "Reschedule", exact: true }).first();
  await noOpTrigger.focus();
  await noOpTrigger.click();
  await expect(dialog.getByLabel("Start time", { exact: true })).toHaveValue("2026-08-25T10:00");
  await expect(dialog.getByLabel("End time", { exact: true })).toHaveValue("2026-08-25T12:00");
  const noOpResponse = page.waitForResponse((response) =>
    response.request().method() === "PATCH"
    && response.url().includes(`/v1/jobs/${job.id}/appointments/${createdBooking.appointment.id}`),
  );
  await dialog.getByRole("button", { name: "Confirm reschedule", exact: true }).click();
  const noOpPayload = await (await noOpResponse).json() as {
    appointment: { version: number };
    notificationReceipt: null;
  };
  expect(noOpPayload.notificationReceipt).toBeNull();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "No changes were made." })).toBeVisible();
  await expect(noOpTrigger).toBeFocused();

  await page.getByRole("button", { name: "Reschedule", exact: true }).first().click();
  await dialog.getByLabel("Start time", { exact: true }).fill("2026-08-25T19:00");
  await dialog.getByLabel("End time", { exact: true }).fill("2026-08-25T19:15");
  await dialog.getByRole("button", { name: "Confirm reschedule", exact: true }).click();
  await expect(dialog.getByText("This team member already has a booking that overlaps that time.", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Conflicting booking:/)).toBeVisible();
  await expect(dialog.getByLabel("Start time", { exact: true })).toHaveValue("2026-08-25T19:00");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Week", exact: true }).click();
  await expect(page).toHaveURL(/range=week/);

  for (const width of [768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("heading", { name: "Today and upcoming work", exact: true })).toBeVisible();
    if (width >= 1280) {
      const weekGrid = page.getByTestId("schedule-week-grid");
      await expect(weekGrid).toBeVisible();
      const eventBoxes = await weekGrid.locator('button[aria-label*="Schedule Calendar Customer"]:visible').evaluateAll((elements) => elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      }));
      expect(eventBoxes.length).toBeGreaterThanOrEqual(3);
      for (let leftIndex = 0; leftIndex < eventBoxes.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < eventBoxes.length; rightIndex += 1) {
          const left = eventBoxes[leftIndex];
          const right = eventBoxes[rightIndex];
          const overlaps = left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
          expect(overlaps, `calendar events ${leftIndex} and ${rightIndex} overlap visually`).toBe(false);
        }
      }
    }
    await expect.poll(() => page.evaluate(() => {
      window.scrollTo({ left: 10_000, top: window.scrollY });
      return window.scrollX;
    })).toBeLessThanOrEqual(1);
  }

  await page.route("**/v1/auth/me", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.tenant.timezone = "America/Los_Angeles";
    await route.fulfill({ response, json: payload });
  });
  const spanishPreference = await request.patch(`${apiBaseUrl}/v1/auth/me/preferences`, {
    headers: { Cookie: owner.cookieHeader },
    data: { preferredLocale: "es-US" },
  });
  expect(spanishPreference.status()).toBe(200);
  await page.evaluate(() => {
    window.localStorage.setItem("qf_locale", "es-US");
    window.localStorage.setItem("qf_theme_preference", "dark");
  });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("heading", { name: "Trabajo de hoy y próximos días", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[aria-current="date"]:visible')).toHaveCount(1);
  const spanishReschedule = page.getByRole("button", { name: "Reprogramar", exact: true }).first();
  await spanishReschedule.focus();
  await expect(spanishReschedule).toBeFocused();
  await page.keyboard.press("Enter");
  const spanishDialog = page.getByRole("dialog", { name: "Revisar reprogramación" });
  await expect(spanishDialog).toBeVisible();
  await spanishDialog.getByLabel("Hora de inicio", { exact: true }).fill("2026-03-08T02:30");
  await expect(spanishDialog.getByText("Esta hora local no existe porque el reloj cambia en ese momento. Elige otra hora.", { exact: true })).toBeVisible();
  await spanishDialog.getByLabel("Hora de inicio", { exact: true }).fill("2026-11-01T01:30");
  await spanishDialog.getByLabel("Hora de fin", { exact: true }).fill("2026-11-01T02:30");
  await expect(spanishDialog.getByLabel("Desplazamiento de la hora de inicio", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(spanishDialog).toBeHidden();
  await expect(spanishReschedule).toBeFocused();
  await expect.poll(() => page.evaluate(() => {
    window.scrollTo({ left: 10_000, top: window.scrollY });
    return window.scrollX;
  })).toBeLessThanOrEqual(1);

  await page.goto(`/app/jobs/${job.id}`);
  const detailBooking = page.locator(`[data-appointment-id="${createdBooking.appointment.id}"]`);
  await expect(detailBooking).toBeVisible({ timeout: 20_000 });
  await detailBooking.getByRole("button", { name: "Editar visita", exact: true }).click();
  const detailDialog = page.getByRole("dialog", { name: "Revisar reprogramación" });
  await detailDialog.getByLabel("Hora de inicio", { exact: true }).fill("2026-11-01T01:30");
  await detailDialog.getByLabel("Hora de fin", { exact: true }).fill("2026-11-01T02:30");
  await expect(detailDialog.getByLabel("Desplazamiento de la hora de inicio", { exact: true })).toBeVisible();
  await detailDialog.getByLabel("Hora de inicio", { exact: true }).fill("2026-08-26T08:00");
  await detailDialog.getByLabel("Hora de fin", { exact: true }).fill("2026-08-26T09:00");
  await detailDialog.getByLabel("Instrucciones de la visita", { exact: true }).fill("Conservar estas instrucciones durante la recuperación obsoleta.");

  const detailAppointmentsResponse = await request.get(`${apiBaseUrl}/v1/jobs/${job.id}/appointments?limit=100&offset=0`, {
    headers: { Cookie: owner.cookieHeader },
  });
  expect(detailAppointmentsResponse.status()).toBe(200);
  const detailAppointments = (await detailAppointmentsResponse.json()) as {
    items: Array<{ id: string; version: number }>;
  };
  const detailLatest = detailAppointments.items.find((appointment) => appointment.id === createdBooking.appointment.id);
  expect(detailLatest).toBeTruthy();
  const detailExternalUpdate = await request.patch(`${apiBaseUrl}/v1/jobs/${job.id}/appointments/${createdBooking.appointment.id}`, {
    headers: { Cookie: owner.cookieHeader },
    data: {
      version: detailLatest!.version,
      startsAtUtc: "2026-08-26T15:15:00.000Z",
      endsAtUtc: "2026-08-26T16:15:00.000Z",
      timeZone: "America/Los_Angeles",
    },
  });
  expect(detailExternalUpdate.status()).toBe(200);
  await detailDialog.getByRole("button", { name: "Confirmar reprogramación", exact: true }).click();
  const detailReloadResponse = page.waitForResponse((response) =>
    response.request().method() === "GET"
    && response.url().includes(`/v1/jobs/${job.id}/appointments?`),
  );
  const detailReload = detailDialog.getByRole("button", { name: "Cargar versión actual y conservar mis horas", exact: true });
  await expect(detailReload).toBeVisible();
  await detailReload.click();
  expect((await detailReloadResponse).status()).toBe(200);
  await expect(detailDialog.getByLabel("Hora de inicio", { exact: true })).toHaveValue("2026-08-26T08:00");
  await expect(detailDialog.getByLabel("Hora de fin", { exact: true })).toHaveValue("2026-08-26T09:00");
  await expect(detailDialog.getByLabel("Instrucciones de la visita", { exact: true })).toHaveValue("Conservar estas instrucciones durante la recuperación obsoleta.");
  await expect(detailDialog.getByText("Se cargó la versión actual de la visita. Se conservaron las horas que escribiste.", { exact: true })).toBeVisible();
  const detailSaveResponse = page.waitForResponse((response) =>
    response.request().method() === "PATCH"
    && response.url().includes(`/v1/jobs/${job.id}/appointments/${createdBooking.appointment.id}`),
  );
  await detailDialog.getByRole("button", { name: "Confirmar reprogramación", exact: true }).click();
  expect((await detailSaveResponse).status()).toBe(200);
  await expect(detailDialog).toBeHidden();
  const savedDetailResponse = await request.get(`${apiBaseUrl}/v1/jobs/${job.id}/appointments?limit=100&offset=0`, {
    headers: { Cookie: owner.cookieHeader },
  });
  expect(savedDetailResponse.status()).toBe(200);
  const savedDetail = (await savedDetailResponse.json()) as {
    items: Array<{ id: string; instructions: string | null }>;
  };
  expect(savedDetail.items.find((appointment) => appointment.id === createdBooking.appointment.id)?.instructions)
    .toBe("Conservar estas instrucciones durante la recuperación obsoleta.");

  await page.unroute("**/v1/auth/me");
  const englishPreference = await request.patch(`${apiBaseUrl}/v1/auth/me/preferences`, {
    headers: { Cookie: owner.cookieHeader },
    data: { preferredLocale: "en-US" },
  });
  expect(englishPreference.status()).toBe(200);
  await page.evaluate(() => {
    window.localStorage.setItem("qf_locale", "en-US");
    window.localStorage.setItem("qf_theme_preference", "light");
  });

  await context.clearCookies();
  await addSessionCookie(context, member);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/jobs?view=schedule&range=week&date=2026-08-25&assignee=all");
  await expect(page).toHaveURL(/assignee=me/);
  await expect(page.getByRole("heading", { name: "Schedule Calendar Customer", exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Reschedule", exact: true })).toHaveCount(0);
  await expect(page.getByText("View only", { exact: true }).first()).toBeVisible();

  await page.route("**/v1/jobs/schedule?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], pagination: { limit: 100, offset: 0, total: 501 } }),
    });
  });
  await page.reload();
  await expect(page.getByText("This calendar is too large to display safely", { exact: true })).toBeVisible({ timeout: 20_000 });
});
