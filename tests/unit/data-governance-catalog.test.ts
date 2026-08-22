import assert from "node:assert/strict";
import test from "node:test";
import {
  getDataClassificationCatalog,
  validateDataGovernanceInventory,
  validateDataGovernanceSchema,
} from "../../src/lib/data-governance-catalog";
import {
  AI_RAG_ELIGIBLE_FIELDS,
  AI_RAG_SOURCE_FIELD_MANIFEST,
  AI_RETRIEVABLE_FIELD_POLICY,
  validateAiRagSourceFieldManifest,
} from "../../src/lib/data-classification";

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
  assert.equal(fields.get("User.preferredLocale")?.classification, "C2_CUSTOMER_CONFIDENTIAL");
  assert.equal(fields.get("User.preferredLocale")?.ragStatus, "EXCLUDED");
  assert.equal(fields.get("Tenant.defaultCustomerLocale")?.classification, "C1_BUSINESS_INTERNAL");
  assert.equal(fields.get("Tenant.defaultCustomerLocale")?.ragStatus, "EXCLUDED");
  assert.equal(fields.get("Customer.preferredLocale")?.classification, "C2_CUSTOMER_CONFIDENTIAL");
  assert.equal(fields.get("Customer.preferredLocale")?.ragStatus, "EXCLUDED");
  assert.equal(fields.get("Quote.documentLocale")?.classification, "C1_BUSINESS_INTERNAL");
  assert.equal(fields.get("Quote.documentLocale")?.ragStatus, "EXCLUDED");
  assert.equal(fields.get("QuoteDraftRecovery.payload")?.classification, "C3_FINANCIAL_CONFIDENTIAL");
  assert.equal(fields.get("QuoteDraftRecovery.payload")?.ragStatus, "EXCLUDED");
  assert.equal(fields.get("WorkPreset.catalogContentHash")?.classification, "C3_FINANCIAL_CONFIDENTIAL");
  assert.equal(fields.get("WorkPreset.catalogContentHash")?.ragStatus, "EXCLUDED");
  for (const scheduleField of [
    "Job.scheduledAtUtc",
    "Job.dispatchedAtUtc",
    "Job.startedAtUtc",
    "Job.completedAtUtc",
    "JobAppointment.startsAtUtc",
    "JobAppointment.endsAtUtc",
    "JobAppointment.timeZone",
    "JobAppointment.dispatchedAtUtc",
    "JobAppointment.arrivedAtUtc",
    "JobAppointment.completedAtUtc",
  ]) {
    assert.equal(fields.get(scheduleField)?.classification, "C2_CUSTOMER_CONFIDENTIAL", scheduleField);
    assert.equal(fields.get(scheduleField)?.ragStatus, "EXCLUDED", scheduleField);
  }
});

test("the RAG catalog exactly reflects fields with implemented source adapters", () => {
  assert.deepEqual(validateAiRagSourceFieldManifest(), {
    missingSourceAdapters: [],
    nonVectorManifestFields: [],
  });
  const catalog = getDataClassificationCatalog();
  const catalogEligible = catalog.models
    .flatMap((model) => model.fields
      .filter((field) => field.ragStatus === "ELIGIBLE")
      .map((field) => `${model.model}.${field.field}`))
    .sort();
  const manifestEligible = [...AI_RAG_ELIGIBLE_FIELDS].sort();

  assert.deepEqual(catalogEligible, manifestEligible);
  assert.equal(catalogEligible.includes("QuoteTemplate.name"), false);
  assert.equal(catalogEligible.includes("QuoteTemplate.description"), false);
  for (const localePreferenceField of [
    "User.preferredLocale",
    "Tenant.defaultCustomerLocale",
    "Customer.preferredLocale",
    "Quote.documentLocale",
  ]) {
    assert.equal(
      manifestEligible.includes(localePreferenceField),
      false,
      `${localePreferenceField} must never enter RAG source content`,
    );
  }

  for (const [sourceType, sourceFields] of Object.entries(AI_RAG_SOURCE_FIELD_MANIFEST)) {
    assert.ok(sourceFields.length > 0, `${sourceType} must expose at least one indexed field`);
    for (const field of sourceFields) {
      assert.equal(field.split(".")[0], sourceType, `${field} must belong to its source adapter`);
      assert.equal(AI_RETRIEVABLE_FIELD_POLICY[field].vectorEligible, true, `${field} must be vector eligible`);
    }
  }
});
