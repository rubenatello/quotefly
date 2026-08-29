import { Prisma } from "@prisma/client";

type RetryableDatabaseError = Readonly<{
  code?: unknown;
  meta?: Readonly<Record<string, unknown>>;
  cause?: unknown;
}>;

function databaseErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as RetryableDatabaseError;
  if (typeof candidate.code === "string") return candidate.code;
  return databaseErrorCode(candidate.cause);
}

/** PostgreSQL deadlocks can surface directly as 40P01 or through Prisma P2010. */
export function isRetryableTransactionConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2034") return true;
    if (error.code === "P2010" && error.meta?.code === "40P01") return true;
  }
  return databaseErrorCode(error) === "40P01";
}

/**
 * Retries the entire database transaction after a serialization conflict or
 * deadlock. Callers must keep the operation database-only so a rollback is
 * safe to replay.
 */
export async function withTransactionConflictRetry<T>(
  operation: () => Promise<T>,
  options: Readonly<{ maxAttempts?: number; baseDelayMs?: number }> = {},
): Promise<T> {
  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 3, 5));
  const baseDelayMs = Math.max(0, Math.min(options.baseDelayMs ?? 5, 100));
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableTransactionConflict(error) || attempt === maxAttempts - 1) {
        throw error;
      }
      const delayMs = baseDelayMs * (2 ** attempt) + Math.floor(Math.random() * (baseDelayMs + 1));
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
