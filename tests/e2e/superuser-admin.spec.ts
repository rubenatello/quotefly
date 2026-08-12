import { expect, test } from "@playwright/test";
import { addSessionCookie, signUpViaApi } from "./helpers";

test("superuser data explorer presents an expandable classification table", async ({ context, page, request }) => {
  const account = await signUpViaApi(
    request,
    "superuser-desktop",
    "superuser-e2e@example.com",
  );
  await addSessionCookie(context, account);

  await page.goto("/app/internal/admin");
  await expect(page.getByRole("heading", { level: 1, name: "QuoteFly operator console" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("navigation", { name: "Operator console sections" }).getByRole("button", { name: "Data explorer", exact: true }).click();

  const modelTable = page.getByRole("table", { name: "Data classification models" });
  await expect(modelTable).toBeVisible();
  await expect(modelTable.getByRole("columnheader", { name: "Model and table" })).toBeVisible();
  await expect(modelTable.getByRole("columnheader", { name: "Default class" })).toBeVisible();
  await expect(modelTable.getByRole("columnheader", { name: "RAG eligible" })).toBeVisible();

  await modelTable.getByRole("button", { name: "Expand fields for Customer", exact: true }).click();
  const fieldTable = page.getByRole("table", { name: "Fields for Customer" });
  await expect(fieldTable).toBeVisible();
  await expect(fieldTable.getByText("Customer.notes", { exact: true })).toBeVisible();
  await expect(fieldTable.getByText("C2 Customer confidential", { exact: true }).first()).toBeVisible();
  await expect(fieldTable.getByText("RAG eligible", { exact: true }).first()).toBeVisible();

  await modelTable.getByRole("button", { name: "Collapse fields for Customer", exact: true }).click();
  await expect(fieldTable).toBeHidden();
});
