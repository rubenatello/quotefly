import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  AI_DATA_POLICY_VERSION,
  AI_RAG_ELIGIBLE_FIELDS,
  validateAiRagSourceFieldManifest,
  type DataClassification,
} from "./data-classification";

const REVIEWED_SCHEMA_FIELD_TEXT = {
  TenantBranding: "addressLine1 addressLine2 businessEmail businessPhone city componentColors createdAt deletedAtUtc hideQuoteFlyAttribution id logoPosition logoUrl postalCode primaryColor quoteMessageTemplate state templateId tenantId updatedAt",
  TenantBrandAsset: "byteLength createdAt data id mimeType sha256 tenantId",
  Tenant: "billingStateEventCreatedAtUtc billingStateEventId createdAt defaultCustomerLocale deletedAtUtc id name onboardingCompletedAtUtc primaryTrade slug stripeCheckoutAttemptExpiresAtUtc stripeCheckoutAttemptId stripeCheckoutSessionExpiresAtUtc stripeCheckoutSessionId stripeCustomerId stripeSubscriptionId subscriptionCurrentPeriodEndUtc subscriptionCurrentPeriodStartUtc subscriptionPlanCode subscriptionStatus timezone trialEndsAtUtc trialStartsAtUtc updatedAt",
  User: "authVersion createdAt deletedAtUtc email fullName id legalAcceptedAtUtc passwordHash preferredLocale privacyPolicyVersion termsVersion updatedAt",
  PasswordResetToken: "createdAt expiresAtUtc id tokenHash usedAtUtc userId",
  QuoteDraftRecovery: "createdAt expiresAtUtc id payload savedAtUtc scope tenantId tenantUserId updatedAt",
  TenantUser: "createdAt deletedAtUtc id role tenantId userId",
  TenantPhoneNumber: "createdAt deletedAtUtc e164Number id provider tenantId updatedAt",
  Customer: "archivedAtUtc assignedTenantUserId createdAt deletedAtUtc email followUpStatus followUpUpdatedAtUtc fullName id notes phone phoneDigits preferredLocale tenantId updatedAt",
  PricingProfile: "createdAt deletedAtUtc id isDefault laborRate materialMarkup serviceType tenantId updatedAt",
  QuoteTemplate: "createdAt deletedAtUtc description id isActive name serviceType tenantId updatedAt",
  Quote: "afterSaleFollowUpCompletedAtUtc afterSaleFollowUpDueAtUtc afterSaleFollowUpStatus aiGeneratedAtUtc aiModel aiPromptText archivedAtUtc assignedTenantUserId closedAtUtc createIdempotencyKeyHash createRequestHash createdAt customerId customerPriceSubtotal deletedAtUtc documentLocale id internalCostSubtotal jobCompletedAtUtc jobStatus scopeText sentAt serviceType status taxAmount tenantId title totalAmount updatedAt",
  AiUsageEvent: "actorEmail actorName actorUserId classification completionTokens confidenceLabel confidenceLevel createdAt creditsConsumed customerId deletedAtUtc estimatedCostUsd eventType id insightReasons insightSourceLabels insightSummary ledgerAccountedAtUtc model patchAdded patchRemoved patchUpdated promptHash promptRedacted promptText promptTokens purpose quoteId requestCount retentionExpiresAtUtc retrievalAuditEventId retrievalAuditTenantId riskNote rootReservationId serviceType sourceCount tenantId totalTokens",
  AiUsagePeriod: "completedCostMicros completedCredits createdAt id periodEndUtc periodStartUtc tenantId updatedAt",
  AiUsageReservation: "actorTenantUserId actualCostMicros actualCredits ceilingCostMicros createdAt expiresAtUtc finalizedAtUtc id idempotencyKeyHash incidentCode inputRateMicrosPerM kind maxOutputTokens model operation outputRateMicrosPerM parentReservationId periodId pricingVersion providerStartedAtUtc requestHash reservedCredits serializedInputBytes state tenantId updatedAt",
  AiAssistantFeedback: "actorUserId aiUsageEventId createdAt deletedAtUtc id note rating tenantId updatedAt",
  AiRetrievalAuditEvent: "actorUserId authorizationDurationMs authorizedCandidateCount candidateCount createdAt deletedAtUtc denialCode embeddingDurationMs filterSummary id inputTokenCount keywordCandidateCount keywordDurationMs maxClassification model outputTokenCount policyVersion purpose queryHash rankingDurationMs rankingMode rankingSummary requestId resultCount retentionExpiresAtUtc semanticCandidateCount sourceRefs sourceTypes status tenantId totalDurationMs",
  AiRetrievalDocument: "chunkerVersion citationLabel contentHash deletedAtUtc id indexedAtUtc maxClassification metadata policyVersion sourceId sourceType sourceUpdatedAtUtc status tenantId",
  AiRetrievalChunk: "assignedTenantUserId chunkerVersion citationLabel chunkIndex classification content contentHash customerId deletedAtUtc documentId embedding embeddingContentHash embeddingDimensions embeddingModel id indexedAtUtc lifecycle metadata pageNumber policyVersion quoteId recordStatus section serviceType sourceCreatedAtUtc sourceField sourceId sourceType sourceUpdatedAtUtc tenantId",
  AiIndexJob: "attempts availableAtUtc completedAtUtc createdAt expectedSourceUpdatedAtUtc generation id lastChunkCount lastDurationMs lastEmbeddingCacheHitCount lastErrorCode lockedAtUtc lockedBy maxAttempts operation sourceId sourceType status tenantId updatedAt",
  DataGovernanceValidationRun: "actorUserId baselineHash createdAt fieldCount id issueCount issues modelCount policyVersion requestId schemaHash status",
  SuperuserAuditEvent: "action actorUserId createdAt id metadata requestId targetRefHash targetType",
  QuoteLineItem: "createdAt deletedAtUtc description id position priceProvenance quantity quoteId sectionLabel sectionType sourcePresetCatalogKeySnapshot sourcePresetCatalogVersionSnapshot sourcePresetIdSnapshot sourcePresetNameSnapshot sourcePresetUpdatedAtUtcSnapshot tenantId unitCost unitPrice updatedAt",
  QuoteRevision: "actorEmail actorName actorUserId changedFields createdAt customerId customerPriceSubtotal deletedAtUtc eventType id quoteId snapshot status tenantId title totalAmount version",
  CustomerActivityEvent: "actorEmail actorName actorUserId createdAt customerId deletedAtUtc detail eventType id metadata tenantId title",
  ActivityTask: "assignedTenantUserId canceledAtUtc completedAtUtc completedByTenantUserId createdAt createdByTenantUserId customerId deletedAtUtc dueAtUtc id notes priority quoteId sourceKey status tenantId title type updatedAt version",
  ActivityTaskEvent: "activityTaskId actorTenantUserId commandKeyHash commandPayloadHash createdAt fromStatus id requestId tenantId toStatus type",
  TenantSequence: "createdAt id key nextValue tenantId updatedAt",
  Job: "acceptedAtUtc accessInstructions archivedAtUtc assignedTenantUserId canceledAtUtc completedAtUtc createdAt customerId deletedAtUtc dispatchedAtUtc id jobNumber scheduledAtUtc scopeSnapshot serviceAddressSnapshot serviceType sourceQuoteId startedAtUtc status tenantId title updatedAt version",
  JobAppointment: "arrivedAtUtc assignedTenantUserId canceledAtUtc completedAtUtc createdAt createdByTenantUserId deletedAtUtc dispatchedAtUtc endsAtUtc id instructions jobId startsAtUtc status tenantId timeZone updatedAt version",
  JobNote: "body createdAt createdByTenantUserId deletedAtUtc id jobId tenantId",
  JobEvent: "actorTenantUserId commandKeyHash commandPayloadHash createdAt fromStatus id jobId requestId tenantId toStatus type",
  NotificationOutbox: "actorTenantUserId appointmentId archivedAtUtc channel createdAt dedupeKeyHash deliveredAtUtc deliveryStatus endsAtUtc id jobId kind payloadHash readAtUtc recipientTenantUserId sourceJobEventId sourceVersion startsAtUtc templateKey templateVersion tenantId timeZone updatedAt version",
  Invoice: "amountPaid archivedAtUtc balanceDue billingEmailSnapshot createdAt currency customerId deletedAtUtc documentLocale dueAtUtc id invoiceNumber issuedAtUtc jobId paidAtUtc paymentStatus scopeSnapshot sentAtUtc sourceQuoteId status subtotalAmount taxAmount tenantId titleSnapshot totalAmount updatedAt version voidedAtUtc",
  InvoiceLineItem: "createdAt description id invoiceId lineTotal position quantity sectionLabel sectionType sourceQuoteLineItemIdSnapshot tenantId unitPrice",
  InvoicePayment: "amount createdAt currency deletedAtUtc failedAtUtc failureCode id invoiceId paidAtUtc provider providerInvoiceId providerPaymentId providerSyncToken providerUpdatedAtUtc receiptUrl refundedAmount refundedAtUtc status tenantId updatedAt",
  InvoiceEvent: "actorTenantUserId commandKeyHash commandPayloadHash createdAt fromPaymentStatus fromStatus id invoiceId providerEventId requestId tenantId toPaymentStatus toStatus type",
  QuickBooksInvoiceOperation: "allowOnlineAchPayment allowOnlineCardPayment archivedAtUtc attemptCount claimExpiresAtUtc claimTokenHash commandKeyHash createdAt failedAtUtc id invoiceId invoiceLinkFetchedAtUtc lastAttemptAtUtc lastFailureCode lastReconciledAtUtc payloadHash processingStartedAtUtc providerBalance providerDocNumber providerInvoiceId providerInvoiceLink providerInvoiceStatus providerRealmId providerRequestId providerSyncToken providerUpdatedAtUtc quickBooksConnectionId reconciliationCount requestedByTenantUserId status succeededAtUtc tenantId updatedAt",
  SmsMessage: "body deletedAtUtc direction externalSid fromNumber id receivedAt tenantId toNumber",
  QuoteDecisionSession: "createdAt deletedAtUtc id quoteId requesterPhone status tenantId updatedAt",
  BillingWebhookEvent: "attemptCount createdAt eventType failedAtUtc id lastAttemptAtUtc lastError payload processedAtUtc processingLeaseToken status stripeCreatedAtUtc stripeEventId succeededAtUtc tenantId",
  QuickBooksConnection: "accessTokenEncrypted accessTokenExpiresAtUtc allowOnlineAchPayment allowOnlineCardPayment companyName connectedAtUtc createdAt deletedAtUtc disconnectedAtUtc disconnectRequestedAtUtc environment id lastError lastSyncAtUtc lastTokenRefreshAtUtc lastWebhookAtUtc realmId refreshTokenEncrypted refreshTokenRotatedAtUtc revocationAttemptCount revocationNextAttemptAtUtc revocationPendingAtUtc scopes setupChecklistVersion setupConfirmedAtUtc setupConfirmedByTenantUserId status tenantId tokenRefreshClaimExpiresAtUtc tokenRefreshClaimHash updatedAt",
  QuickBooksConnectionEvent: "action actorTenantUserId connectionGeneration createdAt id outcome quickBooksConnectionId requestId tenantId",
  QuickBooksCustomerMap: "createdAt customerId deletedAtUtc id quickBooksConnectionId quickBooksCustomerId quickBooksDisplayName reviewedAtUtc reviewedByTenantUserId reviewVersion tenantId updatedAt",
  QuickBooksItemMap: "createdAt deletedAtUtc id itemKey quickBooksConnectionId quickBooksItemId quickBooksItemName reviewedAtUtc reviewedByTenantUserId reviewVersion sourceType tenantId updatedAt workPresetId",
  QuickBooksInvoiceSync: "createdAt deletedAtUtc id lastAttemptedAtUtc lastError payloadSnapshot quickBooksConnectionId quickBooksDocNumber quickBooksInvoiceId quoteId requestId status syncedAtUtc tenantId updatedAt",
  QuickBooksWebhookEvent: "attemptCount claimExpiresAtUtc claimTokenHash deadAtUtc entityId eventType id lastError nextAttemptAtUtc operation payload processedAtUtc providerUpdatedAtUtc quickBooksConnectionId realmId receivedAtUtc status tenantId webhookEventId",
  QuickBooksOAuthState: "consumedAtUtc createdAt expiresAtUtc id quickBooksConnectionId stateHash tenantId userId",
  QuickBooksOrphanCredentialRevocation: "attemptCount claimExpiresAtUtc claimTokenHash createdAt deadAtUtc dedupeKeyHash id lastAttemptAtUtc lastErrorCode nextAttemptAtUtc refreshTokenEncrypted revokedAtUtc status tenantId updatedAt",
  QuickBooksRealmBinding: "active createdAt id quickBooksConnectionId realmId tenantId updatedAt",
  QuickBooksCdcCursor: "attemptCount changedSinceUtc createdAt id lastAttemptAtUtc lastErrorCode lastSucceededAtUtc nextAttemptAtUtc quickBooksConnectionId tenantId updatedAt",
  QuoteOutboundEvent: "actorEmail actorName actorUserId bodyPreview channel createdAt customerId deletedAtUtc destination id idempotencyKey quoteId subject tenantId",
  WorkPreset: "catalogContentHash catalogCustomizedAtUtc catalogKey catalogVersion category createdAt defaultQuantity deletedAtUtc description id isDefault name serviceType tenantId unitCost unitPrice unitType updatedAt",
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
  QuoteDraftRecovery: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "required", purpose: "Short-lived tenant-member quote recovery containing customer and pricing work in progress" },
  TenantUser: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "required", purpose: "Tenant membership and role authorization" },
  TenantPhoneNumber: { defaultClassification: "C2_CUSTOMER_CONFIDENTIAL", tenantScope: "required", purpose: "Tenant communications configuration" },
  Customer: { defaultClassification: "C2_CUSTOMER_CONFIDENTIAL", tenantScope: "required", purpose: "Tenant customer and lead records" },
  PricingProfile: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "required", purpose: "Internal labor rates and pricing defaults" },
  QuoteTemplate: { defaultClassification: "C1_BUSINESS_INTERNAL", tenantScope: "required", purpose: "Reusable service quote templates" },
  Quote: { defaultClassification: "C2_CUSTOMER_CONFIDENTIAL", tenantScope: "required", purpose: "Customer quote workflow and totals" },
  AiUsageEvent: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "required", purpose: "AI usage, quality, prompt trace, and cost telemetry" },
  AiUsagePeriod: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "required", purpose: "Content-free tenant-month AI entitlement and accounting totals" },
  AiUsageReservation: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "required", purpose: "Content-free atomic AI operation and provider-call accounting state" },
  AiAssistantFeedback: { defaultClassification: "C1_BUSINESS_INTERNAL", tenantScope: "required", purpose: "Tenant-scoped Kody response ratings and optional user notes" },
  AiRetrievalAuditEvent: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "required", purpose: "Content-free AI retrieval audit evidence" },
  AiRetrievalDocument: { defaultClassification: "C2_CUSTOMER_CONFIDENTIAL", tenantScope: "required", purpose: "Tenant-scoped RAG source document index metadata" },
  AiRetrievalChunk: { defaultClassification: "C2_CUSTOMER_CONFIDENTIAL", tenantScope: "required", purpose: "Tenant-scoped RAG source excerpts and embeddings" },
  AiIndexJob: { defaultClassification: "C1_BUSINESS_INTERNAL", tenantScope: "required", purpose: "Content-free tenant RAG indexing work and retry telemetry" },
  DataGovernanceValidationRun: { defaultClassification: "C1_BUSINESS_INTERNAL", tenantScope: "platform", purpose: "Platform schema-classification validation evidence" },
  SuperuserAuditEvent: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "platform", purpose: "Cross-tenant operator action audit evidence" },
  QuoteLineItem: { defaultClassification: "C2_CUSTOMER_CONFIDENTIAL", tenantScope: "required", purpose: "Quote scope, quantity, price, and internal cost lines" },
  QuoteRevision: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "required", purpose: "Immutable quote history including financial snapshots" },
  CustomerActivityEvent: { defaultClassification: "C2_CUSTOMER_CONFIDENTIAL", tenantScope: "required", purpose: "Customer workflow timeline" },
  ActivityTask: { defaultClassification: "C2_CUSTOMER_CONFIDENTIAL", tenantScope: "required", purpose: "Assignable customer work, due dates, and private operational notes" },
  ActivityTaskEvent: { defaultClassification: "C1_BUSINESS_INTERNAL", tenantScope: "required", purpose: "Content-free immutable activity task transition and idempotency audit" },
  TenantSequence: { defaultClassification: "C1_BUSINESS_INTERNAL", tenantScope: "required", purpose: "Tenant-local numbering for operational records" },
  Job: { defaultClassification: "C2_CUSTOMER_CONFIDENTIAL", tenantScope: "required", purpose: "Accepted-quote execution record, assignment, and job lifecycle" },
  JobAppointment: { defaultClassification: "C2_CUSTOMER_CONFIDENTIAL", tenantScope: "required", purpose: "Tenant job booking, dispatch timestamps, assignment, and field instructions" },
  JobNote: { defaultClassification: "C2_CUSTOMER_CONFIDENTIAL", tenantScope: "required", purpose: "Tenant job execution notes and internal field updates" },
  JobEvent: { defaultClassification: "C1_BUSINESS_INTERNAL", tenantScope: "required", purpose: "Content-free immutable job transition and idempotency audit" },
  NotificationOutbox: { defaultClassification: "C1_BUSINESS_INTERNAL", tenantScope: "required", purpose: "Content-minimal in-app appointment notification outbox and recipient inbox" },
  Invoice: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "required", purpose: "Tenant invoice ledger linked to accepted quotes and jobs" },
  InvoiceLineItem: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "required", purpose: "Immutable tenant invoice scope and amount snapshots" },
  InvoicePayment: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "required", purpose: "Provider-safe tenant payment status ledger for invoices" },
  InvoiceEvent: { defaultClassification: "C1_BUSINESS_INTERNAL", tenantScope: "required", purpose: "Content-free immutable invoice/payment transition and idempotency audit" },
  QuickBooksInvoiceOperation: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "required", purpose: "Durable content-free QuickBooks invoice publish claim and reconciliation state" },
  SmsMessage: { defaultClassification: "C2_CUSTOMER_CONFIDENTIAL", tenantScope: "required", purpose: "Tenant SMS communications" },
  QuoteDecisionSession: { defaultClassification: "C2_CUSTOMER_CONFIDENTIAL", tenantScope: "required", purpose: "Quote approval and revision workflow" },
  BillingWebhookEvent: { defaultClassification: "C4_RESTRICTED", tenantScope: "optional", purpose: "Stripe webhook idempotency and processing evidence" },
  QuickBooksConnection: { defaultClassification: "C4_RESTRICTED", tenantScope: "required", purpose: "QuickBooks OAuth credentials and connection state" },
  QuickBooksConnectionEvent: { defaultClassification: "C1_BUSINESS_INTERNAL", tenantScope: "required", purpose: "Content-free immutable QuickBooks connection lifecycle audit evidence" },
  QuickBooksCustomerMap: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "required", purpose: "Tenant-to-QuickBooks customer mapping" },
  QuickBooksItemMap: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "required", purpose: "Tenant-to-QuickBooks item mapping" },
  QuickBooksInvoiceSync: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "required", purpose: "QuickBooks invoice export and synchronization state" },
  QuickBooksWebhookEvent: { defaultClassification: "C4_RESTRICTED", tenantScope: "optional", purpose: "QuickBooks webhook processing envelope" },
  QuickBooksOAuthState: { defaultClassification: "C4_RESTRICTED", tenantScope: "required", purpose: "Single-use hashed QuickBooks OAuth callback state" },
  QuickBooksOrphanCredentialRevocation: { defaultClassification: "C4_RESTRICTED", tenantScope: "required", purpose: "Encrypted orphan QuickBooks OAuth credential revocation retry and incident state" },
  QuickBooksRealmBinding: { defaultClassification: "C4_RESTRICTED", tenantScope: "required", purpose: "Minimal tenant-safe QuickBooks webhook realm routing" },
  QuickBooksCdcCursor: { defaultClassification: "C4_RESTRICTED", tenantScope: "required", purpose: "QuickBooks change-data-capture recovery cursor and retry state" },
  QuoteOutboundEvent: { defaultClassification: "C2_CUSTOMER_CONFIDENTIAL", tenantScope: "required", purpose: "Quote delivery and sharing audit" },
  WorkPreset: { defaultClassification: "C3_FINANCIAL_CONFIDENTIAL", tenantScope: "required", purpose: "Tenant product catalog, prices, and internal costs" },
} as const satisfies Record<ReviewedModel, ModelPolicy>;

const FIELD_CLASSIFICATION_OVERRIDES = {
  "Tenant.name": "C1_BUSINESS_INTERNAL",
  "Tenant.slug": "C1_BUSINESS_INTERNAL",
  "Tenant.timezone": "C1_BUSINESS_INTERNAL",
  "Tenant.primaryTrade": "C1_BUSINESS_INTERNAL",
  "Tenant.defaultCustomerLocale": "C1_BUSINESS_INTERNAL",
  "Tenant.stripeCustomerId": "C4_RESTRICTED",
  "Tenant.stripeSubscriptionId": "C4_RESTRICTED",
  "Tenant.stripeCheckoutSessionId": "C4_RESTRICTED",
  "Tenant.stripeCheckoutAttemptId": "C4_RESTRICTED",
  "Tenant.billingStateEventId": "C4_RESTRICTED",
  "QuickBooksInvoiceOperation.providerInvoiceLink": "C4_RESTRICTED",
  "QuickBooksOrphanCredentialRevocation.refreshTokenEncrypted": "C4_RESTRICTED",
  "QuickBooksOrphanCredentialRevocation.dedupeKeyHash": "C4_RESTRICTED",
  "User.id": "C1_BUSINESS_INTERNAL",
  "User.email": "C2_CUSTOMER_CONFIDENTIAL",
  "User.fullName": "C2_CUSTOMER_CONFIDENTIAL",
  "User.preferredLocale": "C2_CUSTOMER_CONFIDENTIAL",
  "User.createdAt": "C1_BUSINESS_INTERNAL",
  "User.updatedAt": "C1_BUSINESS_INTERNAL",
  "User.deletedAtUtc": "C1_BUSINESS_INTERNAL",
  "QuoteDraftRecovery.id": "C1_BUSINESS_INTERNAL",
  "QuoteDraftRecovery.tenantId": "C1_BUSINESS_INTERNAL",
  "QuoteDraftRecovery.tenantUserId": "C1_BUSINESS_INTERNAL",
  "QuoteDraftRecovery.scope": "C1_BUSINESS_INTERNAL",
  "QuoteDraftRecovery.savedAtUtc": "C1_BUSINESS_INTERNAL",
  "QuoteDraftRecovery.expiresAtUtc": "C1_BUSINESS_INTERNAL",
  "QuoteDraftRecovery.createdAt": "C1_BUSINESS_INTERNAL",
  "QuoteDraftRecovery.updatedAt": "C1_BUSINESS_INTERNAL",
  "Customer.id": "C1_BUSINESS_INTERNAL",
  "Customer.tenantId": "C1_BUSINESS_INTERNAL",
  "Customer.assignedTenantUserId": "C1_BUSINESS_INTERNAL",
  "Customer.followUpStatus": "C1_BUSINESS_INTERNAL",
  "Customer.followUpUpdatedAtUtc": "C1_BUSINESS_INTERNAL",
  "Customer.createdAt": "C1_BUSINESS_INTERNAL",
  "Customer.updatedAt": "C1_BUSINESS_INTERNAL",
  "Customer.archivedAtUtc": "C1_BUSINESS_INTERNAL",
  "Customer.deletedAtUtc": "C1_BUSINESS_INTERNAL",
  "Customer.preferredLocale": "C2_CUSTOMER_CONFIDENTIAL",
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
  "Quote.createIdempotencyKeyHash": "C4_RESTRICTED",
  "Quote.createRequestHash": "C4_RESTRICTED",
  "Quote.aiModel": "C1_BUSINESS_INTERNAL",
  "Quote.documentLocale": "C1_BUSINESS_INTERNAL",
  "QuoteLineItem.id": "C1_BUSINESS_INTERNAL",
  "QuoteLineItem.tenantId": "C1_BUSINESS_INTERNAL",
  "QuoteLineItem.quoteId": "C1_BUSINESS_INTERNAL",
  "QuoteLineItem.position": "C1_BUSINESS_INTERNAL",
  "QuoteLineItem.sectionType": "C1_BUSINESS_INTERNAL",
  "QuoteLineItem.priceProvenance": "C1_BUSINESS_INTERNAL",
  "QuoteLineItem.sourcePresetIdSnapshot": "C1_BUSINESS_INTERNAL",
  "QuoteLineItem.sourcePresetNameSnapshot": "C1_BUSINESS_INTERNAL",
  "QuoteLineItem.sourcePresetCatalogKeySnapshot": "C1_BUSINESS_INTERNAL",
  "QuoteLineItem.sourcePresetCatalogVersionSnapshot": "C1_BUSINESS_INTERNAL",
  "QuoteLineItem.sourcePresetUpdatedAtUtcSnapshot": "C1_BUSINESS_INTERNAL",
  "QuoteLineItem.unitCost": "C3_FINANCIAL_CONFIDENTIAL",
  "ActivityTask.id": "C1_BUSINESS_INTERNAL",
  "ActivityTask.tenantId": "C1_BUSINESS_INTERNAL",
  "ActivityTask.customerId": "C1_BUSINESS_INTERNAL",
  "ActivityTask.quoteId": "C1_BUSINESS_INTERNAL",
  "ActivityTask.assignedTenantUserId": "C1_BUSINESS_INTERNAL",
  "ActivityTask.createdByTenantUserId": "C1_BUSINESS_INTERNAL",
  "ActivityTask.completedByTenantUserId": "C1_BUSINESS_INTERNAL",
  "ActivityTask.type": "C1_BUSINESS_INTERNAL",
  "ActivityTask.status": "C1_BUSINESS_INTERNAL",
  "ActivityTask.priority": "C1_BUSINESS_INTERNAL",
  "ActivityTask.dueAtUtc": "C1_BUSINESS_INTERNAL",
  "ActivityTask.completedAtUtc": "C1_BUSINESS_INTERNAL",
  "ActivityTask.canceledAtUtc": "C1_BUSINESS_INTERNAL",
  "ActivityTask.sourceKey": "C4_RESTRICTED",
  "ActivityTask.version": "C1_BUSINESS_INTERNAL",
  "ActivityTask.createdAt": "C1_BUSINESS_INTERNAL",
  "ActivityTask.updatedAt": "C1_BUSINESS_INTERNAL",
  "ActivityTask.deletedAtUtc": "C1_BUSINESS_INTERNAL",
  "ActivityTaskEvent.commandKeyHash": "C4_RESTRICTED",
  "ActivityTaskEvent.commandPayloadHash": "C4_RESTRICTED",
  "ActivityTaskEvent.requestId": "C4_RESTRICTED",
  "TenantSequence.id": "C1_BUSINESS_INTERNAL",
  "TenantSequence.tenantId": "C1_BUSINESS_INTERNAL",
  "TenantSequence.key": "C1_BUSINESS_INTERNAL",
  "TenantSequence.nextValue": "C1_BUSINESS_INTERNAL",
  "Job.id": "C1_BUSINESS_INTERNAL",
  "Job.tenantId": "C1_BUSINESS_INTERNAL",
  "Job.customerId": "C1_BUSINESS_INTERNAL",
  "Job.sourceQuoteId": "C1_BUSINESS_INTERNAL",
  "Job.assignedTenantUserId": "C1_BUSINESS_INTERNAL",
  "Job.jobNumber": "C1_BUSINESS_INTERNAL",
  "Job.status": "C1_BUSINESS_INTERNAL",
  "Job.serviceType": "C1_BUSINESS_INTERNAL",
  "Job.acceptedAtUtc": "C2_CUSTOMER_CONFIDENTIAL",
  "Job.scheduledAtUtc": "C2_CUSTOMER_CONFIDENTIAL",
  "Job.dispatchedAtUtc": "C2_CUSTOMER_CONFIDENTIAL",
  "Job.startedAtUtc": "C2_CUSTOMER_CONFIDENTIAL",
  "Job.completedAtUtc": "C2_CUSTOMER_CONFIDENTIAL",
  "Job.canceledAtUtc": "C2_CUSTOMER_CONFIDENTIAL",
  "Job.version": "C1_BUSINESS_INTERNAL",
  "Job.createdAt": "C1_BUSINESS_INTERNAL",
  "Job.updatedAt": "C1_BUSINESS_INTERNAL",
  "Job.archivedAtUtc": "C1_BUSINESS_INTERNAL",
  "Job.deletedAtUtc": "C1_BUSINESS_INTERNAL",
  "JobAppointment.id": "C1_BUSINESS_INTERNAL",
  "JobAppointment.tenantId": "C1_BUSINESS_INTERNAL",
  "JobAppointment.jobId": "C1_BUSINESS_INTERNAL",
  "JobAppointment.assignedTenantUserId": "C1_BUSINESS_INTERNAL",
  "JobAppointment.createdByTenantUserId": "C1_BUSINESS_INTERNAL",
  "JobAppointment.status": "C1_BUSINESS_INTERNAL",
  "JobAppointment.startsAtUtc": "C2_CUSTOMER_CONFIDENTIAL",
  "JobAppointment.endsAtUtc": "C2_CUSTOMER_CONFIDENTIAL",
  "JobAppointment.timeZone": "C2_CUSTOMER_CONFIDENTIAL",
  "JobAppointment.dispatchedAtUtc": "C2_CUSTOMER_CONFIDENTIAL",
  "JobAppointment.arrivedAtUtc": "C2_CUSTOMER_CONFIDENTIAL",
  "JobAppointment.completedAtUtc": "C2_CUSTOMER_CONFIDENTIAL",
  "JobAppointment.canceledAtUtc": "C2_CUSTOMER_CONFIDENTIAL",
  "JobAppointment.version": "C1_BUSINESS_INTERNAL",
  "JobAppointment.createdAt": "C1_BUSINESS_INTERNAL",
  "JobAppointment.updatedAt": "C1_BUSINESS_INTERNAL",
  "JobAppointment.deletedAtUtc": "C1_BUSINESS_INTERNAL",
  "JobNote.id": "C1_BUSINESS_INTERNAL",
  "JobNote.tenantId": "C1_BUSINESS_INTERNAL",
  "JobNote.jobId": "C1_BUSINESS_INTERNAL",
  "JobNote.createdByTenantUserId": "C1_BUSINESS_INTERNAL",
  "JobNote.createdAt": "C1_BUSINESS_INTERNAL",
  "JobNote.deletedAtUtc": "C1_BUSINESS_INTERNAL",
  "JobEvent.actorTenantUserId": "C1_BUSINESS_INTERNAL",
  "JobEvent.commandKeyHash": "C4_RESTRICTED",
  "JobEvent.commandPayloadHash": "C4_RESTRICTED",
  "JobEvent.requestId": "C4_RESTRICTED",
  "NotificationOutbox.kind": "C2_CUSTOMER_CONFIDENTIAL",
  "NotificationOutbox.templateKey": "C2_CUSTOMER_CONFIDENTIAL",
  "NotificationOutbox.startsAtUtc": "C2_CUSTOMER_CONFIDENTIAL",
  "NotificationOutbox.endsAtUtc": "C2_CUSTOMER_CONFIDENTIAL",
  "NotificationOutbox.timeZone": "C2_CUSTOMER_CONFIDENTIAL",
  "NotificationOutbox.dedupeKeyHash": "C4_RESTRICTED",
  "NotificationOutbox.payloadHash": "C4_RESTRICTED",
  "Invoice.id": "C1_BUSINESS_INTERNAL",
  "Invoice.tenantId": "C1_BUSINESS_INTERNAL",
  "Invoice.customerId": "C1_BUSINESS_INTERNAL",
  "Invoice.jobId": "C1_BUSINESS_INTERNAL",
  "Invoice.sourceQuoteId": "C1_BUSINESS_INTERNAL",
  "Invoice.invoiceNumber": "C1_BUSINESS_INTERNAL",
  "Invoice.status": "C1_BUSINESS_INTERNAL",
  "Invoice.paymentStatus": "C1_BUSINESS_INTERNAL",
  "Invoice.documentLocale": "C1_BUSINESS_INTERNAL",
  "Invoice.currency": "C1_BUSINESS_INTERNAL",
  "Invoice.titleSnapshot": "C2_CUSTOMER_CONFIDENTIAL",
  "Invoice.scopeSnapshot": "C2_CUSTOMER_CONFIDENTIAL",
  "Invoice.subtotalAmount": "C2_CUSTOMER_CONFIDENTIAL",
  "Invoice.taxAmount": "C2_CUSTOMER_CONFIDENTIAL",
  "Invoice.totalAmount": "C2_CUSTOMER_CONFIDENTIAL",
  "Invoice.amountPaid": "C2_CUSTOMER_CONFIDENTIAL",
  "Invoice.balanceDue": "C2_CUSTOMER_CONFIDENTIAL",
  "Invoice.issuedAtUtc": "C2_CUSTOMER_CONFIDENTIAL",
  "Invoice.dueAtUtc": "C2_CUSTOMER_CONFIDENTIAL",
  "Invoice.sentAtUtc": "C2_CUSTOMER_CONFIDENTIAL",
  "Invoice.paidAtUtc": "C2_CUSTOMER_CONFIDENTIAL",
  "Invoice.voidedAtUtc": "C2_CUSTOMER_CONFIDENTIAL",
  "Invoice.version": "C1_BUSINESS_INTERNAL",
  "Invoice.createdAt": "C1_BUSINESS_INTERNAL",
  "Invoice.updatedAt": "C1_BUSINESS_INTERNAL",
  "Invoice.archivedAtUtc": "C1_BUSINESS_INTERNAL",
  "Invoice.deletedAtUtc": "C1_BUSINESS_INTERNAL",
  "InvoiceLineItem.id": "C1_BUSINESS_INTERNAL",
  "InvoiceLineItem.tenantId": "C1_BUSINESS_INTERNAL",
  "InvoiceLineItem.invoiceId": "C1_BUSINESS_INTERNAL",
  "InvoiceLineItem.sourceQuoteLineItemIdSnapshot": "C1_BUSINESS_INTERNAL",
  "InvoiceLineItem.sectionType": "C1_BUSINESS_INTERNAL",
  "InvoiceLineItem.position": "C1_BUSINESS_INTERNAL",
  "InvoiceLineItem.description": "C2_CUSTOMER_CONFIDENTIAL",
  "InvoiceLineItem.sectionLabel": "C2_CUSTOMER_CONFIDENTIAL",
  "InvoiceLineItem.createdAt": "C1_BUSINESS_INTERNAL",
  "InvoicePayment.id": "C1_BUSINESS_INTERNAL",
  "InvoicePayment.tenantId": "C1_BUSINESS_INTERNAL",
  "InvoicePayment.invoiceId": "C1_BUSINESS_INTERNAL",
  "InvoicePayment.provider": "C1_BUSINESS_INTERNAL",
  "InvoicePayment.currency": "C1_BUSINESS_INTERNAL",
  "InvoicePayment.status": "C1_BUSINESS_INTERNAL",
  "InvoicePayment.providerPaymentId": "C4_RESTRICTED",
  "InvoicePayment.providerInvoiceId": "C4_RESTRICTED",
  "InvoicePayment.receiptUrl": "C4_RESTRICTED",
  "InvoicePayment.failureCode": "C4_RESTRICTED",
  "InvoicePayment.createdAt": "C1_BUSINESS_INTERNAL",
  "InvoicePayment.updatedAt": "C1_BUSINESS_INTERNAL",
  "InvoicePayment.deletedAtUtc": "C1_BUSINESS_INTERNAL",
  "InvoiceEvent.actorTenantUserId": "C1_BUSINESS_INTERNAL",
  "InvoiceEvent.commandKeyHash": "C4_RESTRICTED",
  "InvoiceEvent.commandPayloadHash": "C4_RESTRICTED",
  "InvoiceEvent.requestId": "C4_RESTRICTED",
  "InvoiceEvent.providerEventId": "C4_RESTRICTED",
  "QuickBooksInvoiceOperation.id": "C1_BUSINESS_INTERNAL",
  "QuickBooksInvoiceOperation.tenantId": "C1_BUSINESS_INTERNAL",
  "QuickBooksInvoiceOperation.invoiceId": "C1_BUSINESS_INTERNAL",
  "QuickBooksInvoiceOperation.quickBooksConnectionId": "C4_RESTRICTED",
  "QuickBooksInvoiceOperation.requestedByTenantUserId": "C1_BUSINESS_INTERNAL",
  "QuickBooksInvoiceOperation.status": "C1_BUSINESS_INTERNAL",
  "QuickBooksInvoiceOperation.attemptCount": "C1_BUSINESS_INTERNAL",
  "QuickBooksInvoiceOperation.reconciliationCount": "C1_BUSINESS_INTERNAL",
  "QuickBooksInvoiceOperation.processingStartedAtUtc": "C1_BUSINESS_INTERNAL",
  "QuickBooksInvoiceOperation.claimExpiresAtUtc": "C1_BUSINESS_INTERNAL",
  "QuickBooksInvoiceOperation.lastAttemptAtUtc": "C1_BUSINESS_INTERNAL",
  "QuickBooksInvoiceOperation.lastReconciledAtUtc": "C1_BUSINESS_INTERNAL",
  "QuickBooksInvoiceOperation.succeededAtUtc": "C1_BUSINESS_INTERNAL",
  "QuickBooksInvoiceOperation.failedAtUtc": "C1_BUSINESS_INTERNAL",
  "QuickBooksInvoiceOperation.createdAt": "C1_BUSINESS_INTERNAL",
  "QuickBooksInvoiceOperation.updatedAt": "C1_BUSINESS_INTERNAL",
  "QuickBooksInvoiceOperation.archivedAtUtc": "C1_BUSINESS_INTERNAL",
  "QuickBooksInvoiceOperation.commandKeyHash": "C4_RESTRICTED",
  "QuickBooksInvoiceOperation.payloadHash": "C4_RESTRICTED",
  "QuickBooksInvoiceOperation.providerRealmId": "C4_RESTRICTED",
  "QuickBooksInvoiceOperation.claimTokenHash": "C4_RESTRICTED",
  "QuickBooksInvoiceOperation.providerRequestId": "C4_RESTRICTED",
  "QuickBooksInvoiceOperation.providerInvoiceId": "C4_RESTRICTED",
  "QuickBooksInvoiceOperation.providerDocNumber": "C3_FINANCIAL_CONFIDENTIAL",
  "QuickBooksInvoiceOperation.lastFailureCode": "C4_RESTRICTED",
  "WorkPreset.name": "C1_BUSINESS_INTERNAL",
  "WorkPreset.description": "C1_BUSINESS_INTERNAL",
  "WorkPreset.serviceType": "C1_BUSINESS_INTERNAL",
  "WorkPreset.category": "C1_BUSINESS_INTERNAL",
  "WorkPreset.unitType": "C1_BUSINESS_INTERNAL",
  "WorkPreset.catalogKey": "C1_BUSINESS_INTERNAL",
  "WorkPreset.catalogVersion": "C1_BUSINESS_INTERNAL",
  "WorkPreset.catalogContentHash": "C3_FINANCIAL_CONFIDENTIAL",
  "WorkPreset.catalogCustomizedAtUtc": "C1_BUSINESS_INTERNAL",
  "WorkPreset.unitPrice": "C2_CUSTOMER_CONFIDENTIAL",
  "QuoteTemplate.name": "C1_BUSINESS_INTERNAL",
  "QuoteTemplate.description": "C1_BUSINESS_INTERNAL",
  "SmsMessage.externalSid": "C4_RESTRICTED",
  "BillingWebhookEvent.payload": "C4_RESTRICTED",
  "BillingWebhookEvent.processingLeaseToken": "C4_RESTRICTED",
  "QuickBooksConnection.companyName": "C3_FINANCIAL_CONFIDENTIAL",
  "QuickBooksConnection.environment": "C1_BUSINESS_INTERNAL",
  "QuickBooksConnection.status": "C3_FINANCIAL_CONFIDENTIAL",
  "QuickBooksConnection.lastError": "C3_FINANCIAL_CONFIDENTIAL",
  "QuickBooksConnection.disconnectRequestedAtUtc": "C1_BUSINESS_INTERNAL",
  "QuickBooksConnection.setupConfirmedAtUtc": "C1_BUSINESS_INTERNAL",
  "QuickBooksConnection.setupConfirmedByTenantUserId": "C1_BUSINESS_INTERNAL",
  "QuickBooksConnection.setupChecklistVersion": "C1_BUSINESS_INTERNAL",
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
  "AiAssistantFeedback.note": "C2_CUSTOMER_CONFIDENTIAL",
  "AiIndexJob.lockedBy": "C4_RESTRICTED",
  "AiIndexJob.lastErrorCode": "C1_BUSINESS_INTERNAL",
} as const satisfies Record<string, DataClassification>;

const RAG_ELIGIBLE_FIELDS = new Set<string>(AI_RAG_ELIGIBLE_FIELDS);

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
    | "RAG_SOURCE_ADAPTER_MISSING"
    | "RAG_FIELD_POLICY_MISMATCH"
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

  const ragManifestValidation = validateAiRagSourceFieldManifest();
  for (const qualifiedField of ragManifestValidation.missingSourceAdapters) {
    const [model, field] = qualifiedField.split(".");
    issues.push({
      severity: "error",
      code: "RAG_SOURCE_ADAPTER_MISSING",
      model: model || "unknown",
      field,
      message: `RAG field ${qualifiedField} is vector eligible but has no canonical source adapter.`,
    });
  }
  for (const qualifiedField of ragManifestValidation.nonVectorManifestFields) {
    const [model, field] = qualifiedField.split(".");
    issues.push({
      severity: "error",
      code: "RAG_FIELD_POLICY_MISMATCH",
      model: model || "unknown",
      field,
      message: `RAG source adapter field ${qualifiedField} is not vector eligible under the field policy.`,
    });
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
