import assert from "node:assert/strict";
import test from "node:test";
import {
  getDataClassificationCatalog,
  validateDataGovernanceInventory,
  validateDataGovernanceSchema,
} from "../../src/lib/data-governance-catalog";

function currentInventory(): Record<string, string[]> {
  const catalog = getDataClassificationCatalog();
  return Object.fromEntries(
    catalog.models.map((model) => [model.model, model.fields.map((field) => field.field)]),
  );
}

test("the generated Prisma schema exactly matches the reviewed classification baseline", () => {
  const validation = validateDataGovernanceSchema();
  assert.equal(validation.status, "PASSED");
  assert.equal(validation.issueCount, 0);
  assert.equal(validation.schemaHash, validation.baselineHash);
  assert.ok(validation.modelCount >= 28);
  assert.ok(validation.fieldCount >= 376);
});

test("new V2 models and fields fail closed until they are explicitly reviewed", () => {
  const inventory = currentInventory();
  inventory.Customer = [...inventory.Customer, "v2UnclassifiedInsightSource"];
  inventory.V2JobAttachment = ["id", "tenantId", "fileName", "extractedText"];

  const validation = validateDataGovernanceInventory(inventory);
  assert.equal(validation.status, "FAILED");
  assert.ok(validation.issues.some((issue) =>
    issue.code === "UNREVIEWED_FIELD"
      && issue.model === "Customer"
      && issue.field === "v2UnclassifiedInsightSource"));
  assert.ok(validation.issues.some((issue) =>
    issue.code === "UNREVIEWED_MODEL" && issue.model === "V2JobAttachment"));
});

test("restricted fields are excluded from RAG while reviewed content fields are eligible", () => {
  const catalog = getDataClassificationCatalog();
  const fields = new Map(
    catalog.models.flatMap((model) =>
      model.fields.map((field) => [`${model.model}.${field.field}`, field] as const)),
  );

  for (const fieldName of [
    "User.passwordHash",
    "PasswordResetToken.tokenHash",
    "TenantBrandAsset.data",
    "BillingWebhookEvent.payload",
    "QuickBooksConnection.accessTokenEncrypted",
    "QuickBooksConnection.refreshTokenEncrypted",
  ]) {
    assert.equal(fields.get(fieldName)?.classification, "C4_RESTRICTED", fieldName);
    assert.equal(fields.get(fieldName)?.ragStatus, "EXCLUDED", fieldName);
  }

  for (const fieldName of [
    "Customer.notes",
    "Quote.title",
    "Quote.scopeText",
    "QuoteLineItem.description",
    "WorkPreset.description",
  ]) {
    assert.equal(fields.get(fieldName)?.ragStatus, "ELIGIBLE", fieldName);
  }

  for (const fieldName of [
    "Quote.customerPriceSubtotal",
    "Quote.internalCostSubtotal",
    "QuoteLineItem.unitPrice",
    "QuoteLineItem.unitCost",
  ]) {
    assert.equal(fields.get(fieldName)?.analyticsStatus, "ELIGIBLE", fieldName);
    assert.equal(fields.get(fieldName)?.ragStatus, "EXCLUDED", fieldName);
  }

  assert.equal(fields.get("AiAssistantFeedback.note")?.classification, "C2_CUSTOMER_CONFIDENTIAL");
  assert.equal(fields.get("AiAssistantFeedback.note")?.ragStatus, "EXCLUDED");
  assert.equal(fields.get("QuoteDraftRecovery.payload")?.classification, "C3_FINANCIAL_CONFIDENTIAL");
  assert.equal(fields.get("QuoteDraftRecovery.payload")?.ragStatus, "EXCLUDED");
});
