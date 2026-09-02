import { QuickBooksProviderError } from "./quickbooks";
import { QuickBooksReconciliationError } from "./quickbooks-reconciliation";

export type QuickBooksWorkerFailure = Readonly<{
  code: string;
  retryable: boolean;
}>;

const SAFE_FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,190}$/;
const FALLBACK_FAILURE_CODE = "QUICKBOOKS_WORKER_FAILURE";

function sanitizedFailureCode(value: string): string {
  return SAFE_FAILURE_CODE.test(value) ? value : FALLBACK_FAILURE_CODE;
}

/**
 * Converts provider and canonical-reconciliation failures into bounded worker
 * policy without persisting provider messages or other potentially sensitive
 * error text. Provider transport failures preserve the existing retry budget;
 * canonical non-retryable failures are quarantined immediately for review.
 */
export function classifyQuickBooksWorkerFailure(error: unknown): QuickBooksWorkerFailure {
  if (error instanceof QuickBooksReconciliationError) {
    return {
      code: sanitizedFailureCode(error.code),
      retryable: error.retryable,
    };
  }
  if (error instanceof QuickBooksProviderError) {
    return {
      code: sanitizedFailureCode(error.code),
      retryable: error.code !== "QUICKBOOKS_REAUTH_REQUIRED"
        && error.statusCode !== 401
        && error.statusCode !== 403,
    };
  }
  return {
    code: FALLBACK_FAILURE_CODE,
    retryable: true,
  };
}
