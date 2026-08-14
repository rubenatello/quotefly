import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  AI_DATA_POLICY_VERSION,
  type DataClassification,
} from "./data-classification";

const REVIEWED_SCHEMA_FIELD_TEXT = {
  TenantBranding: "addressLine1 addressLine2 businessEmail businessPhone city componentColors createdAt deletedAtUtc hideQuoteFlyAttribution id logoPosition logoUrl postalCode primaryColor quoteMessageTemplate state templateId tenantId updatedAt",
  TenantBrandAsset: "byteLength createdAt data id mimeType sha256 tenantId",
  Tenant: "billingStateEventCreatedAtUtc billingStateEventId createdAt deletedAtUtc id name onboardingCompletedAtUtc primaryTrade slug stripeCheckoutAttemptExpiresAtUtc stripeCheckoutAttemptId stripeCheckoutSessionExpiresAtUtc stripeCheckoutSessionId stripeCustomerId stripeSubscriptionId subscriptionCurrentPeriodEndUtc subscriptionPlanCode subscriptionStatus timezone trialEndsAtUtc trialStartsAtUtc updatedAt",
  User: "authVersion createdAt deletedAtUtc email fullName id legalAcceptedAtUtc passwordHash privacyPolicyVersion termsVersion updatedAt",
  PasswordResetToken: "createdAt expiresAtUtc id tokenHash usedAtUtc userId",
  TenantUser: "createdAt deletedAtUtc id role tenantId userId",
  TenantPhoneNumber: "createdAt deletedAtUtc e164Number id provider tenantId updatedAt",
  Customer: "archivedAtUtc assignedTenantUserId createdAt deletedAtUtc email followUpStatus followUpUpdatedAtUtc fullName id notes phone phoneDigits tenantId updatedAt",
  PricingProfile: "createdAt deletedAtUtc id isDefault laborRate materialMarkup serviceType tenantId updatedAt",
  QuoteTemplate: "createdAt deletedAtUtc description id isActive name serviceType tenantId updatedAt",
  Quote: "afterSaleFollowUpCompletedAtUtc afterSaleFollowUpDueAtUtc afterSaleFollowUpStatus aiGeneratedAtUtc aiModel aiPromptText archivedAtUtc assignedTenantUserId closedAtUtc createdAt customerId customerPriceSubtotal deletedAtUtc id internalCostSubtotal jobCompletedAtUtc jobStatus scopeText sentAt serviceType status taxAmount tenantId title totalAmount updatedAt",
  AiUsageEvent: "actorEmail actorName actorUserId classification completionTokens confidenceLabel confidenceLevel createdAt creditsConsumed customerId deletedAtUtc estimatedCostUsd eventType id insightReasons insightSourceLabels insightSummary model patchAdded patchRemoved patchUpdated promptHash promptRedacted promptText promptTokens purpose quoteId requestCount retentionExpiresAtUtc retrievalAuditEventId retrievalAuditTenantId riskNote serviceType sourceCount tenantId totalTokens",
  AiAssistantFeedback: "actorUserId aiUsageEventId createdAt deletedAtUtc id rating tenantId updatedAt",
  AiRetrievalAuditEvent: "actorUserId authorizationDurationMs authorizedCandidateCount candidateCount createdAt deletedAtUtc denialCode embeddingDurationMs filterSummary id inputTokenCount keywordCandidateCount keywordDurationMs maxClassification model outputTokenCount policyVersion purpose queryHash rankingDurationMs rankingMode rankingSummary requestId resultCount retentionExpiresAtUtc semanticCandidateCount sourceRefs sourceTypes status tenantId totalDurationMs",
  AiRetrievalDocument: "chunkerVersion citationLabel contentHash deletedAtUtc id indexedAtUtc maxClassification metadata policyVersion sourceId sourceType sourceUpdatedAtUtc status tenantId",
  AiRetrievalChunk: "assignedTenantUserId chunkerVersion citationLabel chunkIndex classification content contentHash customerId deletedAtUtc documentId embedding embeddingContentHash embeddingDimensions embeddingModel id indexedAtUtc lifecycle metadata pageNumber policyVersion quoteId recordStatus section serviceType sourceCreatedAtUtc sourceField sourceId sourceType sourceUpdatedAtUtc tenantId",
  AiIndexJob: "attempts availableAtUtc completedAtUtc createdAt expectedSourceUpdatedAtUtc generation id lastChunkCount lastDurationMs lastEmbeddingCacheHitCount lastErrorCode lockedAtUtc lockedBy maxAttempts operation sourceId sourceType status tenantId updatedAt",
  DataGovernanceValidationRun: "actorUserId baselineHash createdAt fieldCount id issueCount issues modelCount policyVersion requestId schemaHash status",
  SuperuserAuditEvent: "action actorUserId createdAt id metadata requestId targetRefHash targetType",
  QuoteLineItem: "createdAt deletedAtUtc description id position quantity quoteId sectionLabel sectionType tenantId unitCost unitPrice updatedAt",
  QuoteRevision: "actorEmail actorName actorUserId changedFields createdAt customerId customerPriceSubtotal deletedAtUtc eventType id quoteId snapshot status tenantId title totalAmount version",
  CustomerActivityEvent: "actorEmail actorName actorUserId createdAt customerId deletedAtUtc detail eventType id metadata tenantId title",
  SmsMessage: "body deletedAtUtc direction externalSid fromNumber id receivedAt tenantId toNumber",
  QuoteDecisionSession: "createdAt deletedAtUtc id quoteId requesterPhone status tenantId updatedAt",
  BillingWebhookEvent: "attemptCount createdAt eventType failedAtUtc id lastAttemptAtUtc lastError payload processedAtUtc processingLeaseToken status stripeCreatedAtUtc stripeEventId succeededAtUtc tenantId",
  QuickBooksConnection: "accessTokenEncrypted accessTokenExpiresAtUtc companyName connectedAtUtc createdAt deletedAtUtc disconnectedAtUtc environment id lastError lastSyncAtUtc lastTokenRefreshAtUtc lastWebhookAtUtc realmId refreshTokenEncrypted refreshTokenRotatedAtUtc scopes status tenantId updatedAt",
  QuickBooksCustomerMap: "createdAt customerId deletedAtUtc id quickBooksConnectionId quickBooksCustomerId quickBooksDisplayName tenantId updatedAt",
  QuickBooksItemMap: "createdAt deletedAtUtc id itemKey quickBooksConnectionId quickBooksItemId quickBooksItemName sourceType tenantId updatedAt workPresetId",
  QuickBooksInvoiceSync: "createdAt deletedAtUtc id lastAttemptedAtUtc lastError payloadSnapshot quickBooksConnectionId quickBooksDocNumber quickBooksInvoiceId quoteId requestId status syncedAtUtc tenantId updatedAt",
  QuickBooksWebhookEvent: "entityId eventType id lastError payload processedAtUtc quickBooksConnectionId realmId receivedAtUtc tenantId webhookEventId",
  QuoteOutboundEvent: "actorEmail actorName actorUserId bodyPreview channel createdAt customerId deletedAtUtc destination id idempotencyKey quoteId subject tenantId",
  WorkPreset: "catalogKey category createdAt defaultQuantity deletedAtUtc description id isDefault name serviceType tenantId unitCost unitPrice unitType updatedAt",
} as const;

type ReviewedModel = keyof typeof REVIEWED_SCHEMA_FIELD_TEXT;
type TenantScope = "required" | "optional" | "platform";

type ModelPolicy = Readonly<{
  defaultClassification: DataClassification;
  tenantScope: TenantScope;
  purpose: string;
}>;

const MODEL_POLICIES = {
  TenantBranding: { defaultClassification: "C2_CUSTOMER_CONFIDENTIAL", tenantScope: "required", purpose: "Tenant branding and customer-facing quote identity" },
  TenantBrandAsset: { defaultClassification: "C4_RESTRICTED", tenantScope: "required", purpose: "Validated tenant logo binary storage" },
  Tenant: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "platform", purpose: "Tenant identity, lifecycle, entitlement, and billing state" },
  User: { defaultClassification: "C4_RESTRICTED", tenantScope: "platform", purpose: "Authentication identity and legal acceptance" },
  PasswordResetToken: { defaultClassification: "C4_RESTRICTED", tenantScope: "platform", purpose: "Short-lived account recovery authorization" },
  TenantUser: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "required", purpose: "Tenant membership and role authorization" },
  TenantPhoneNumber: { defaultClassification: "C2_CUSTOMER_CONFIDENTIAL", tenantScope: "required", purpose: "Tenant communications configuration" },
  Customer: { defaultClassification: "C2_CUSTOMER_CONFIDENTIAL", tenantScope: "required", purpose: "Tenant customer and lead records" },
  PricingProfile: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "required", purpose: "Internal labor rates and pricing defaults" },
  QuoteTemplate: { defaultClassification: "C1_BUSINESS_INTERNAL", tenantScope: "required", purpose: "Reusable service quote templates" },
  Quote: { defaultClassification: "C2_CUSTOMER_CONFIDENTIAL", tenantScope: "required", purpose: "Customer quote workflow and totals" },
  AiUsageEvent: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "required", purpose: "AI usage, quality, prompt trace, and cost telemetry" },
  AiAssistantFeedback: { defaultClassification: "C1_BUSINESS_INTERNAL", tenantScope: "required", purpose: "Tenant-scoped Kody response quality feedback" },
  AiRetrievalAuditEvent: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "required", purpose: "Content-free AI retrieval audit evidence" },
  AiRetrievalDocument: { defaultClassification: "C2_CUSTOMER_CONFIDENTIAL", tenantScope: "required", purpose: "Tenant-scoped RAG source document index metadata" },
  AiRetrievalChunk: { defaultClassification: "C2_CUSTOMER_CONFIDENTIAL", tenantScope: "required", purpose: "Tenant-scoped RAG source excerpts and embeddings" },
  AiIndexJob: { defaultClassification: "C1_BUSINESS_INTERNAL", tenantScope: "required", purpose: "Content-free tenant RAG indexing work and retry telemetry" },
  DataGovernanceValidationRun: { defaultClassification: "C1_BUSINESS_INTERNAL", tenantScope: "platform", purpose: "Platform schema-classification validation evidence" },
  SuperuserAuditEvent: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "platform", purpose: "Cross-tenant operator action audit evidence" },
  QuoteLineItem: { defaultClassification: "C2_CUSTOMER_CONFIDENTIAL", tenantScope: "required", purpose: "Quote scope, quantity, price, and internal cost lines" },
  QuoteRevision: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "required", purpose: "Immutable quote history including financial snapshots" },
  CustomerActivityEvent: { defaultClassification: "C2_CUSTOMER_CONFIDENTIAL", tenantScope: "required", purpose: "Customer workflow timeline" },
  SmsMessage: { defaultClassification: "C2_CUSTOMER_CONFIDENTIAL", tenantScope: "required", purpose: "Tenant SMS communications" },
  QuoteDecisionSession: { defaultClassification: "C2_CUSTOMER_CONFIDENTIAL", tenantScope: "required", purpose: "Quote approval and revision workflow" },
  BillingWebhookEvent: { defaultClassification: "C4_RESTRICTED", tenantScope: "optional", purpose: "Stripe webhook idempotency and processing evidence" },
  QuickBooksConnection: { defaultClassification: "C4_RESTRICTED", tenantScope: "required", purpose: "QuickBooks OAuth credentials and connection state" },
  QuickBooksCustomerMap: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "required", purpose: "Tenant-to-QuickBooks customer mapping" },
  QuickBooksItemMap: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "required", purpose: "Tenant-to-QuickBooks item mapping" },
  QuickBooksInvoiceSync: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "required", purpose: "QuickBooks invoice export and synchronization state" },
  QuickBooksWebhookEvent: { defaultClassification: "C4_RESTRICTED", tenantScope: "optional", purpose: "QuickBooks webhook processing envelope" },
  QuoteOutboundEvent: { defaultClassification: "C2_CUSTOMER_CONFIDENTIAL", tenantScope: "required", purpose: "Quote delivery and sharing audit" },
  WorkPreset: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "required", purpose: "Tenant product catalog, prices, and internal costs" },
} as const satisfies Record<ReviewedModel, ModelPolicy>;

const FIELD_CLASSIFICATION_OVERRIDES = {
  "Tenant.name": "C1_BUSINESS_INTERNAL",
  "Tenant.slug": "C1_BUSINESS_INTERNAL",
  "Tenant.timezone": "C1_BUSINESS_INTERNAL",
  "Tenant.primaryTrade": "C1_BUSINESS_INTERNAL",
  "Tenant.stripeCustomerId": "C4_RESTRICTED",
  "Tenant.stripeSubscriptionId": "C4_RESTRICTED",
  "Tenant.stripeCheckoutSessionId": "C4_RESTRICTED",
  "Tenant.stripeCheckoutAttemptId": "C4_RESTRICTED",
  "Tenant.billingStateEventId": "C4_RESTRICTED",
  "User.id": "C1_BUSINESS_INTERNAL",
  "User.email": "C2_CUSTOMER_CONFIDENTIAL",
  "User.fullName": "C2_CUSTOMER_CONFIDENTIAL",
  "User.createdAt": "C1_BUSINESS_INTERNAL",
  "User.updatedAt": "C1_BUSINESS_INTERNAL",
  "User.deletedAtUtc": "C1_BUSINESS_INTERNAL",
  "Customer.id": "C1_BUSINESS_INTERNAL",
  "Customer.tenantId": "C1_BUSINESS_INTERNAL",
  "Customer.assignedTenantUserId": "C1_BUSINESS_INTERNAL",
  "Customer.followUpStatus": "C1_BUSINESS_INTERNAL",
  "Customer.followUpUpdatedAtUtc": "C1_BUSINESS_INTERNAL",
  "Customer.createdAt": "C1_BUSINESS_INTERNAL",
  "Customer.updatedAt": "C1_BUSINESS_INTERNAL",
  "Customer.archivedAtUtc": "C1_BUSINESS_INTERNAL",
  "Customer.deletedAtUtc": "C1_BUSINESS_INTERNAL",
  "Quote.id": "C1_BUSINESS_INTERNAL",
  "Quote.tenantId": "C1_BUSINESS_INTERNAL",
  "Quote.customerId": "C1_BUSINESS_INTERNAL",
  "Quote.assignedTenantUserId": "C1_BUSINESS_INTERNAL",
  "Quote.serviceType": "C1_BUSINESS_INTERNAL",
  "Quote.status": "C1_BUSINESS_INTERNAL",
  "Quote.jobStatus": "C1_BUSINESS_INTERNAL",
  "Quote.afterSaleFollowUpStatus": "C1_BUSINESS_INTERNAL",
  "Quote.internalCostSubtotal": "C3_FINANCIAL_CONFIDENTIAL",
  "Quote.aiPromptText": "C3_FINANCIAL_CONFIDENTIAL",
  "Quote.aiModel": "C1_BUSINESS_INTERNAL",
  "QuoteLineItem.id": "C1_BUSINESS_INTERNAL",
  "QuoteLineItem.tenantId": "C1_BUSINESS_INTERNAL",
  "QuoteLineItem.quoteId": "C1_BUSINESS_INTERNAL",
  "QuoteLineItem.position": "C1_BUSINESS_INTERNAL",
  "QuoteLineItem.sectionType": "C1_BUSINESS_INTERNAL",
  "QuoteLineItem.unitCost": "C3_FINANCIAL_CONFIDENTIAL",
  "WorkPreset.name": "C1_BUSINESS_INTERNAL",
  "WorkPreset.description": "C1_BUSINESS_INTERNAL",
  "WorkPreset.serviceType": "C1_BUSINESS_INTERNAL",
  "WorkPreset.category": "C1_BUSINESS_INTERNAL",
  "WorkPreset.unitType": "C1_BUSINESS_INTERNAL",
  "WorkPreset.catalogKey": "C1_BUSINESS_INTERNAL",
  "WorkPreset.unitPrice": "C2_CUSTOMER_CONFIDENTIAL",
  "QuoteTemplate.name": "C1_BUSINESS_INTERNAL",
  "QuoteTemplate.description": "C1_BUSINESS_INTERNAL",
  "SmsMessage.externalSid": "C4_RESTRICTED",
  "BillingWebhookEvent.payload": "C4_RESTRICTED",
  "BillingWebhookEvent.processingLeaseToken": "C4_RESTRICTED",
  "QuickBooksConnection.companyName": "C3_FINANCIAL_CONFIDENTIAL",
  "QuickBooksConnection.status": "C3_FINANCIAL_CONFIDENTIAL",
  "QuickBooksConnection.lastError": "C3_FINANCIAL_CONFIDENTIAL",
  "QuickBooksInvoiceSync.payloadSnapshot": "C4_RESTRICTED",
  "QuickBooksWebhookEvent.payload": "C4_RESTRICTED",
  "QuoteOutboundEvent.idempotencyKey": "C4_RESTRICTED",
  "AiRetrievalDocument.id": "C1_BUSINESS_INTERNAL",
  "AiRetrievalDocument.tenantId": "C1_BUSINESS_INTERNAL",
  "AiRetrievalDocument.sourceId": "C1_BUSINESS_INTERNAL",
  "AiRetrievalDocument.chunkerVersion": "C1_BUSINESS_INTERNAL",
  "AiRetrievalDocument.contentHash": "C3_FINANCIAL_CONFIDENTIAL",
  "AiRetrievalDocument.metadata": "C3_FINANCIAL_CONFIDENTIAL",
  "AiRetrievalChunk.id": "C1_BUSINESS_INTERNAL",
  "AiRetrievalChunk.tenantId": "C1_BUSINESS_INTERNAL",
  "AiRetrievalChunk.documentId": "C1_BUSINESS_INTERNAL",
  "AiRetrievalChunk.sourceId": "C1_BUSINESS_INTERNAL",
  "AiRetrievalChunk.chunkerVersion": "C1_BUSINESS_INTERNAL",
  "AiRetrievalChunk.embeddingModel": "C1_BUSINESS_INTERNAL",
  "AiRetrievalChunk.embeddingDimensions": "C1_BUSINESS_INTERNAL",
  "AiRetrievalChunk.contentHash": "C3_FINANCIAL_CONFIDENTIAL",
  "AiRetrievalChunk.embeddingContentHash": "C3_FINANCIAL_CONFIDENTIAL",
  "AiRetrievalChunk.embedding": "C3_FINANCIAL_CONFIDENTIAL",
  "AiRetrievalChunk.metadata": "C3_FINANCIAL_CONFIDENTIAL",
  "AiRetrievalChunk.customerId": "C1_BUSINESS_INTERNAL",
  "AiRetrievalChunk.quoteId": "C1_BUSINESS_INTERNAL",
  "AiRetrievalChunk.serviceType": "C1_BUSINESS_INTERNAL",
  "AiRetrievalChunk.recordStatus": "C1_BUSINESS_INTERNAL",
  "AiRetrievalChunk.lifecycle": "C1_BUSINESS_INTERNAL",
  "AiRetrievalChunk.assignedTenantUserId": "C1_BUSINESS_INTERNAL",
  "AiRetrievalChunk.section": "C1_BUSINESS_INTERNAL",
  "AiRetrievalChunk.pageNumber": "C1_BUSINESS_INTERNAL",
  "AiRetrievalChunk.sourceCreatedAtUtc": "C1_BUSINESS_INTERNAL",
  "AiRetrievalAuditEvent.rankingMode": "C1_BUSINESS_INTERNAL",
  "AiRetrievalAuditEvent.candidateCount": "C1_BUSINESS_INTERNAL",
  "AiRetrievalAuditEvent.authorizedCandidateCount": "C1_BUSINESS_INTERNAL",
  "AiRetrievalAuditEvent.semanticCandidateCount": "C1_BUSINESS_INTERNAL",
  "AiRetrievalAuditEvent.keywordCandidateCount": "C1_BUSINESS_INTERNAL",
  "AiRetrievalAuditEvent.embeddingDurationMs": "C1_BUSINESS_INTERNAL",
  "AiRetrievalAuditEvent.authorizationDurationMs": "C1_BUSINESS_INTERNAL",
  "AiRetrievalAuditEvent.keywordDurationMs": "C1_BUSINESS_INTERNAL",
  "AiRetrievalAuditEvent.rankingDurationMs": "C1_BUSINESS_INTERNAL",
  "AiRetrievalAuditEvent.totalDurationMs": "C1_BUSINESS_INTERNAL",
  "AiRetrievalAuditEvent.filterSummary": "C1_BUSINESS_INTERNAL",
  "AiRetrievalAuditEvent.rankingSummary": "C3_FINANCIAL_CONFIDENTIAL",
  "AiIndexJob.lockedBy": "C4_RESTRICTED",
  "AiIndexJob.lastErrorCode": "C1_BUSINESS_INTERNAL",
} as const satisfies Record<string, DataClassification>;

const RAG_ELIGIBLE_FIELDS = new Set([
  "Customer.notes",
  "Quote.title",
  "Quote.scopeText",
  "QuoteLineItem.description",
  "CustomerActivityEvent.title",
  "CustomerActivityEvent.detail",
  "QuoteTemplate.name",
  "QuoteTemplate.description",
  "WorkPreset.name",
  "WorkPreset.description",
]);

const ANALYTICS_ELIGIBLE_FIELDS = new Set([
  "Quote.serviceType",
  "Quote.status",
  "Quote.jobStatus",
  "Quote.customerPriceSubtotal",
  "Quote.internalCostSubtotal",
  "Quote.taxAmount",
  "Quote.totalAmount",
  "Quote.createdAt",
  "Quote.closedAtUtc",
  "QuoteLineItem.description",
  "QuoteLineItem.quantity",
  "QuoteLineItem.unitPrice",
  "QuoteLineItem.unitCost",
]);

const reviewedFields = Object.fromEntries(
  Object.entries(REVIEWED_SCHEMA_FIELD_TEXT).map(([model, fields]) => [model, fields.split(" ")]),
) as Record<ReviewedModel, string[]>;

export type DataGovernanceIssue = Readonly<{
  severity: "error" | "warning";
  code:
    | "UNREVIEWED_MODEL"
    | "UNREVIEWED_FIELD"
    | "REMOVED_MODEL"
    | "REMOVED_FIELD"
    | "UNKNOWN_FIELD_OVERRIDE"
    | "UNKNOWN_RAG_FIELD"
    | "RAG_CLASSIFICATION_FORBIDDEN";
  model: string;
  field?: string;
  message: string;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function currentScalarModels() {
  return Prisma.dmmf.datamodel.models
    .map((model) => ({
      name: model.name,
      dbName: model.dbName ?? model.name,
      fields: model.fields
        .filter((field) => field.kind !== "object")
        .map((field) => ({
          name: field.name,
          dbName: field.dbName ?? field.name,
          kind: field.kind,
          type: field.type,
          isRequired: field.isRequired,
          isList: field.isList,
          isId: field.isId,
          isUnique: field.isUnique,
          hasDefaultValue: field.hasDefaultValue,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function schemaShape(models: readonly GovernanceInventoryModel[]) {
  return models.map((model) => ({
    model: model.name,
    fields: model.fields.map((field) => field.name),
  }));
}

function reviewedShape() {
  return Object.entries(reviewedFields)
    .map(([model, fields]) => ({ model, fields: [...fields].sort((left, right) => left.localeCompare(right)) }))
    .sort((left, right) => left.model.localeCompare(right.model));
}

function classificationFor(model: string, field: string): DataClassification {
  const override = FIELD_CLASSIFICATION_OVERRIDES[`${model}.${field}` as keyof typeof FIELD_CLASSIFICATION_OVERRIDES];
  if (override) return override;
  const policy = MODEL_POLICIES[model as ReviewedModel];
  return policy?.defaultClassification ?? "C4_RESTRICTED";
}

function requiredAccessFor(classification: DataClassification): string[] {
  if (classification === "C0_PUBLIC") return ["public"];
  if (classification === "C1_BUSINESS_INTERNAL") return ["authenticatedTenantContext"];
  if (classification === "C2_CUSTOMER_CONFIDENTIAL") return ["viewCustomerPii", "tenantScope"];
  if (classification === "C3_FINANCIAL_CONFIDENTIAL") return ["viewInternalCosts", "tenantScope"];
  return ["restrictedSystemOnly"];
}

type GovernanceInventoryModel = Readonly<{
  name: string;
  fields: readonly Readonly<{ name: string }>[];
}>;

function validateInventory(models: readonly GovernanceInventoryModel[]) {
  const currentMap = new Map(models.map((model) => [model.name, new Set(model.fields.map((field) => field.name))]));
  const issues: DataGovernanceIssue[] = [];

  for (const model of models) {
    const baseline = reviewedFields[model.name as ReviewedModel];
    if (!baseline) {
      issues.push({
        severity: "error",
        code: "UNREVIEWED_MODEL",
        model: model.name,
        message: `Model ${model.name} has no reviewed data-classification policy.`,
      });
      continue;
    }
    const baselineSet = new Set(baseline);
    for (const field of model.fields) {
      if (!baselineSet.has(field.name)) {
        issues.push({
          severity: "error",
          code: "UNREVIEWED_FIELD",
          model: model.name,
          field: field.name,
          message: `Field ${model.name}.${field.name} must be classified before RAG or insight use.`,
        });
      }
    }
  }

  for (const [model, baseline] of Object.entries(reviewedFields)) {
    const current = currentMap.get(model);
    if (!current) {
      issues.push({
        severity: "warning",
        code: "REMOVED_MODEL",
        model,
        message: `Reviewed model ${model} is no longer present in the Prisma client.`,
      });
      continue;
    }
    for (const field of baseline) {
      if (!current.has(field)) {
        issues.push({
          severity: "warning",
          code: "REMOVED_FIELD",
          model,
          field,
          message: `Reviewed field ${model}.${field} is no longer present in the Prisma client.`,
        });
      }
    }
  }

  for (const qualifiedField of Object.keys(FIELD_CLASSIFICATION_OVERRIDES)) {
    const [model, field] = qualifiedField.split(".");
    if (!model || !field || !currentMap.get(model)?.has(field)) {
      issues.push({
        severity: "error",
        code: "UNKNOWN_FIELD_OVERRIDE",
        model: model || "unknown",
        field,
        message: `Classification override ${qualifiedField} does not match a current scalar field.`,
      });
    }
  }

  for (const qualifiedField of RAG_ELIGIBLE_FIELDS) {
    const [model, field] = qualifiedField.split(".");
    if (!model || !field || !currentMap.get(model)?.has(field)) {
      issues.push({
        severity: "error",
        code: "UNKNOWN_RAG_FIELD",
        model: model || "unknown",
        field,
        message: `RAG field ${qualifiedField} does not match a current scalar field.`,
      });
      continue;
    }
    const classification = classificationFor(model, field);
    if (classification === "C3_FINANCIAL_CONFIDENTIAL" || classification === "C4_RESTRICTED") {
      issues.push({
        severity: "error",
        code: "RAG_CLASSIFICATION_FORBIDDEN",
        model,
        field,
        message: `${qualifiedField} is ${classification} and cannot be RAG-eligible in the initial policy.`,
      });
    }
  }

  for (const qualifiedField of ANALYTICS_ELIGIBLE_FIELDS) {
    const [model, field] = qualifiedField.split(".");
    if (!model || !field || !currentMap.get(model)?.has(field)) {
      issues.push({
        severity: "error",
        code: "UNKNOWN_RAG_FIELD",
        model: model || "unknown",
        field,
        message: `Analytics field ${qualifiedField} does not match a current scalar field.`,
      });
    }
  }

  const schemaHash = sha256(JSON.stringify(schemaShape(models)));
  const baselineHash = sha256(JSON.stringify(reviewedShape()));
  const fieldCount = models.reduce((sum, model) => sum + model.fields.length, 0);
  const errorCount = issues.filter((issue) => issue.severity === "error").length;

  return {
    status: errorCount === 0 ? "PASSED" as const : "FAILED" as const,
    policyVersion: AI_DATA_POLICY_VERSION,
    schemaHash,
    baselineHash,
    modelCount: models.length,
    fieldCount,
    issueCount: issues.length,
    errorCount,
    warningCount: issues.length - errorCount,
    issues,
  };
}

export function validateDataGovernanceSchema() {
  return validateInventory(currentScalarModels());
}

/**
 * Pure validation entry point for CI drift tests. Production callers should use
 * validateDataGovernanceSchema(), which reads the generated Prisma DMMF.
 */
export function validateDataGovernanceInventory(
  inventory: Readonly<Record<string, readonly string[]>>,
) {
  const models = Object.entries(inventory)
    .map(([name, fields]) => ({
      name,
      fields: [...fields]
        .sort((left, right) => left.localeCompare(right))
        .map((field) => ({ name: field })),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return validateInventory(models);
}

export function getDataClassificationCatalog() {
  const validation = validateDataGovernanceSchema();
  const unreviewed = new Set(
    validation.issues
      .filter((issue) => issue.code === "UNREVIEWED_MODEL" || issue.code === "UNREVIEWED_FIELD")
      .map((issue) => issue.field ? `${issue.model}.${issue.field}` : `${issue.model}.*`),
  );

  const models = currentScalarModels().map((model) => {
    const policy = MODEL_POLICIES[model.name as ReviewedModel];
    const modelUnreviewed = unreviewed.has(`${model.name}.*`);
    return {
      model: model.name,
      table: model.dbName,
      purpose: policy?.purpose ?? "Unreviewed model; access fails closed",
      tenantScope: policy?.tenantScope ?? "platform",
      defaultClassification: policy?.defaultClassification ?? "C4_RESTRICTED",
      reviewStatus: modelUnreviewed ? "REVIEW_REQUIRED" as const : "REVIEWED" as const,
      fields: model.fields.map((field) => {
        const qualifiedField = `${model.name}.${field.name}`;
        const fieldUnreviewed = modelUnreviewed || unreviewed.has(qualifiedField);
        const classification = classificationFor(model.name, field.name);
        const eligible = RAG_ELIGIBLE_FIELDS.has(qualifiedField) && !fieldUnreviewed;
        const analyticsEligible = ANALYTICS_ELIGIBLE_FIELDS.has(qualifiedField) && !fieldUnreviewed;
        return {
          field: field.name,
          column: field.dbName,
          type: field.type,
          kind: field.kind,
          isRequired: field.isRequired,
          isList: field.isList,
          isId: field.isId,
          isUnique: field.isUnique,
          hasDefaultValue: field.hasDefaultValue,
          classification,
          classificationSource:
            qualifiedField in FIELD_CLASSIFICATION_OVERRIDES
              ? "field_override" as const
              : policy
                ? "model_default" as const
                : "fail_closed" as const,
          ragStatus: fieldUnreviewed
            ? "REVIEW_REQUIRED" as const
            : eligible
              ? "ELIGIBLE" as const
              : "EXCLUDED" as const,
          analyticsStatus: fieldUnreviewed
            ? "REVIEW_REQUIRED" as const
            : analyticsEligible
              ? "ELIGIBLE" as const
              : "EXCLUDED" as const,
          requiredAccess: requiredAccessFor(classification),
        };
      }),
    };
  });

  const fields = models.flatMap((model) => model.fields);
  const classificationCounts = fields.reduce<Record<DataClassification, number>>(
    (counts, field) => {
      counts[field.classification] += 1;
      return counts;
    },
    {
      C0_PUBLIC: 0,
      C1_BUSINESS_INTERNAL: 0,
      C2_CUSTOMER_CONFIDENTIAL: 0,
      C3_FINANCIAL_CONFIDENTIAL: 0,
      C4_RESTRICTED: 0,
    },
  );

  return {
    policyVersion: AI_DATA_POLICY_VERSION,
    validation,
    summary: {
      modelCount: models.length,
      fieldCount: fields.length,
      classificationCounts,
      ragEligibleCount: fields.filter((field) => field.ragStatus === "ELIGIBLE").length,
      analyticsEligibleCount: fields.filter((field) => field.analyticsStatus === "ELIGIBLE").length,
      reviewRequiredCount: fields.filter((field) => field.ragStatus === "REVIEW_REQUIRED").length,
    },
    models,
  };
}
