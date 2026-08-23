import type { TFunction } from "i18next";
import { ApiError } from "./api";

type ApiErrorTranslationOptions = {
  fallbackKey: string;
  codeKeys?: Readonly<Record<string, string>>;
  statusKeys?: Readonly<Partial<Record<number, string>>>;
};

const DEFAULT_CODE_KEYS: Readonly<Record<string, string>> = {
  ACTIVE_ACTIVITY_TASKS: "apiErrors.activeTasks",
  ACTIVE_JOBS: "apiErrors.activeJobs",
  ACTIVITY_ALREADY_ACTIVE: "apiErrors.activityAlreadyOpen",
  ACTIVITY_ALREADY_COMPLETED: "apiErrors.activityAlreadyCompleted",
  ACTIVITY_ALREADY_OPEN: "apiErrors.activityAlreadyOpen",
  ACTIVITY_ASSIGN_FORBIDDEN: "apiErrors.permissionDenied",
  ACTIVITY_ASSIGNEE_RECORD_CONFLICT: "apiErrors.assigneeInactive",
  ACTIVITY_CANCEL_FORBIDDEN: "apiErrors.permissionDenied",
  ACTIVITY_DELETE_FORBIDDEN: "apiErrors.permissionDenied",
  ACTIVITY_IDEMPOTENCY_CONFLICT: "apiErrors.activityCommandConflict",
  ACTIVITY_NOT_FOUND: "apiErrors.activityNotFound",
  ACTIVITY_RELATION_NOT_FOUND: "apiErrors.activityRelationNotFound",
  ACTIVITY_REOPEN_FORBIDDEN: "apiErrors.permissionDenied",
  ACTIVITY_REOPEN_REQUIRED: "apiErrors.activityReopenRequired",
  ACTIVITY_SOURCE_ALREADY_EXISTS: "apiErrors.activitySourceExists",
  ACTIVITY_STALE_VERSION: "apiErrors.activityStale",
  AI_USAGE_LIMIT_REACHED: "apiErrors.aiLimit",
  AI_USAGE_REQUEST_IN_PROGRESS: "apiErrors.aiRequestInProgress",
  AI_USAGE_REQUEST_ALREADY_PROCESSED: "apiErrors.aiAlreadyProcessed",
  AI_USAGE_ACCOUNTING_UNAVAILABLE: "apiErrors.aiAccountingUnavailable",
  ASSIGNEE_INACTIVE: "apiErrors.assigneeInactive",
  BILLING_REQUIRED: "apiErrors.billingRequired",
  BRANDING_ADMIN_REQUIRED: "apiErrors.permissionDenied",
  DUPLICATE_CANDIDATE: "apiErrors.customerDuplicate",
  JOB_ASSIGNEE_NOT_FOUND: "apiErrors.assigneeInactive",
  JOB_ASSIGNEE_RECORD_SCOPE_MISMATCH: "apiErrors.jobAssigneeScope",
  JOB_APPOINTMENT_ASSIGNEE_MISMATCH: "apiErrors.jobAppointmentAssigneeMismatch",
  JOB_APPOINTMENT_INVALID_TIME: "apiErrors.jobAppointmentInvalidTime",
  JOB_APPOINTMENT_INVALID_TRANSITION: "apiErrors.jobAppointmentInvalidTransition",
  JOB_APPOINTMENT_NOT_FOUND: "apiErrors.jobAppointmentNotFound",
  JOB_APPOINTMENT_OVERLAP: "apiErrors.jobAppointmentOverlap",
  JOB_APPOINTMENT_STALE_VERSION: "apiErrors.jobAppointmentStale",
  JOB_APPOINTMENT_TOO_LONG: "apiErrors.jobAppointmentTooLong",
  JOB_FORBIDDEN: "apiErrors.permissionDenied",
  JOB_NOTE_NOT_FOUND: "apiErrors.jobNoteNotFound",
  JOB_NOTE_STALE_VERSION: "apiErrors.conflict",
  JOB_NOT_BOOKABLE: "apiErrors.jobNotBookable",
  JOB_NOT_FOUND: "apiErrors.jobNotFound",
  JOB_SEQUENCE_UNAVAILABLE: "apiErrors.serviceUnavailable",
  JOB_STALE_VERSION: "apiErrors.jobStale",
  INVOICE_ALREADY_ARCHIVED: "apiErrors.invoiceAlreadyArchived",
  INVOICE_FORBIDDEN: "apiErrors.permissionDenied",
  INVOICE_IDEMPOTENCY_KEY_REUSED: "apiErrors.invoiceIdempotencyConflict",
  INVOICE_JOB_NOT_COMPLETED: "apiErrors.invoiceJobNotCompleted",
  INVOICE_NOT_FOUND: "apiErrors.invoiceNotFound",
  INVOICE_QUOTE_NOT_ACCEPTED: "apiErrors.invoiceQuoteNotAccepted",
  INVOICE_REPLAY_UNAVAILABLE: "apiErrors.invoiceReplayUnavailable",
  INVOICE_SEQUENCE_UNAVAILABLE: "apiErrors.serviceUnavailable",
  INVOICE_SOURCE_REQUIRED: "apiErrors.invalidRequest",
  MEMBER_HAS_ACTIVE_ASSIGNMENTS: "apiErrors.memberHasAssignments",
  MERGE_CONTACT_CONFLICT: "apiErrors.customerContactConflict",
  PHONE_CONFLICT: "apiErrors.customerPhoneConflict",
  PLAN_FEATURE_REQUIRED: "apiErrors.featurePlanRequired",
  PLAN_LIMIT_EXCEEDED: "apiErrors.planLimit",
  PRODUCT_CATALOG_LIMIT: "apiErrors.productCatalogLimit",
  PRODUCT_NAME_CONFLICT: "apiErrors.productNameConflict",
  QUOTE_JOB_LOCKED: "apiErrors.quoteJobLocked",
  QUOTE_DOCUMENT_LOCALE_LOCKED: "apiErrors.documentLocaleLocked",
  REVIEW_REQUIRED: "apiErrors.reviewRequired",
  ROLE_CHANGE_ACTIVE_TASK_CONFLICT: "apiErrors.memberHasAssignments",
  ROLE_CHANGE_ACTIVE_WORK_CONFLICT: "apiErrors.memberHasAssignments",
  STALE_DUPLICATE_TARGET: "apiErrors.customerDuplicateChanged",
  STANDARD_PRODUCT_ARCHIVE_FORBIDDEN: "apiErrors.standardProductArchive",
  STARTER_CATALOG_INVALID_SELECTION: "apiErrors.starterCatalogInvalid",
  USE_EXISTING_REQUIRES_RESTORE: "apiErrors.customerRestoreRequired",
};

function errorTranslationValues(error: ApiError): Record<string, unknown> {
  if (!error.details || typeof error.details !== "object") return {};
  const details = error.details as Record<string, unknown>;
  const count =
    typeof details.activeTaskCount === "number"
      ? details.activeTaskCount
      : typeof details.activeJobCount === "number"
        ? details.activeJobCount
      : typeof details.count === "number"
        ? details.count
        : undefined;
  return count === undefined ? {} : { count };
}

/**
 * Converts an API failure into owned, localized UI copy.
 *
 * Server and provider prose is intentionally never rendered. Stable error codes
 * keep actionable messages specific while HTTP status and a per-surface fallback
 * safely cover older endpoints that do not yet return codes.
 */
export function localizedApiError(
  error: unknown,
  t: TFunction,
  options: ApiErrorTranslationOptions | string,
): string {
  const fallback = typeof options === "string" ? options : t(options.fallbackKey);
  if (!(error instanceof ApiError)) return fallback;

  const codeKey = error.code
    ? (typeof options === "string" ? undefined : options.codeKeys?.[error.code]) ?? DEFAULT_CODE_KEYS[error.code]
    : undefined;
  if (codeKey) {
    const values = errorTranslationValues(error);
    if (!["apiErrors.activeTasks", "apiErrors.activeJobs"].includes(codeKey) || typeof values.count === "number") {
      return t(codeKey, values);
    }
  }

  const statusKey = typeof options === "string" ? undefined : options.statusKeys?.[error.status];
  if (statusKey) return t(statusKey);

  if (error.status === 401) return t("apiErrors.sessionExpired");
  if (error.status === 403) return t("apiErrors.permissionDenied");
  if (error.status === 404) return t("apiErrors.notFound");
  if (error.status === 409) return t("apiErrors.conflict");
  if (error.status === 429) return t("apiErrors.rateLimited");
  if (error.status >= 500) return t("apiErrors.serviceUnavailable");

  return fallback;
}
