import type {
  AiQuoteLinePatch,
  AiQuoteSuggestion,
  QuotePreparationResult,
} from "./api";

export type AppliedQuotePreparation = {
  suggestion: AiQuoteSuggestion;
  patch: {
    lineChanges: AiQuoteLinePatch[];
    added: number;
    updated: number;
    removed: number;
  };
  pricingReviewLines: AiQuoteSuggestion["lineItems"];
};

export type QuotePricingReviewState = {
  quoteId: string;
  lineDescriptions: string[];
  acknowledged: boolean;
};

export type QuotePreparationRetryIdentity = {
  fingerprint: string;
  idempotencyKey: string;
};

function readNonnegativeFiniteAmount(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

export function resolveQuoteHandoffCustomerTotal(
  draft: { totalAmount?: unknown; customerPriceSubtotal?: unknown },
  fallback: unknown,
): number | null {
  return readNonnegativeFiniteAmount(draft.totalAmount)
    ?? readNonnegativeFiniteAmount(draft.customerPriceSubtotal)
    ?? readNonnegativeFiniteAmount(fallback);
}

export function isQuotePricingReviewBlocking(
  review: QuotePricingReviewState | null | undefined,
  quoteId: string | null | undefined,
): boolean {
  return Boolean(review && quoteId && review.quoteId === quoteId && !review.acknowledged);
}

export function parseQuotePricingReviewState(
  value: unknown,
  expectedQuoteId: string,
): QuotePricingReviewState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.quoteId !== expectedQuoteId ||
    typeof candidate.acknowledged !== "boolean" ||
    !Array.isArray(candidate.lineDescriptions) ||
    candidate.lineDescriptions.length > 50 ||
    candidate.lineDescriptions.some((description) =>
      typeof description !== "string" || description.length > 1_000
    )
  ) return null;
  return {
    quoteId: expectedQuoteId,
    acknowledged: candidate.acknowledged,
    lineDescriptions: candidate.lineDescriptions as string[],
  };
}

export function resolveQuotePreparationRetryIdentity(
  previous: QuotePreparationRetryIdentity | null | undefined,
  fingerprint: string,
  createIdempotencyKey: () => string,
): QuotePreparationRetryIdentity {
  return previous?.fingerprint === fingerprint
    ? previous
    : { fingerprint, idempotencyKey: createIdempotencyKey() };
}

export function hasUnsupportedStructuralQuotePatch(patch: AppliedQuotePreparation["patch"]): boolean {
  return patch.added > 0 || patch.removed > 0 || patch.lineChanges.some((change) => change.action !== "UPDATE");
}

export function formatQuotePricingReviewLineDescriptions(descriptions: string[]): string {
  return descriptions.join(" · ");
}

/**
 * One client-side safety reducer for every Kody quote-preparation consumer.
 * The backend is authoritative; this projection is a second boundary that
 * prevents stale/legacy clients from applying an unresolved non-zero price.
 */
export function applyQuotePreparationPricingGuard(input: {
  preparation?: QuotePreparationResult | null;
  suggestion: AiQuoteSuggestion;
  patch: AppliedQuotePreparation["patch"];
}): AppliedQuotePreparation {
  const preparationLines = input.preparation?.draft.lineItems ?? [];
  const unresolvedDescriptions = new Set(
    [...input.suggestion.lineItems, ...preparationLines]
      .filter((line) => line.sectionType !== "ALTERNATE" && line.priceProvenance === "UNRESOLVED")
      .map((line) => line.description.trim().toLocaleLowerCase())
      .filter(Boolean),
  );
  const guardedLines = input.suggestion.lineItems.map((line) => {
    const unresolved = line.sectionType !== "ALTERNATE" && (
      line.priceProvenance === "UNRESOLVED" ||
      unresolvedDescriptions.has(line.description.trim().toLocaleLowerCase())
    );
    return unresolved && line.unitPrice !== 0
      ? { ...line, unitPrice: 0, priceProvenance: "UNRESOLVED" as const }
      : line;
  });
  const pricingReviewLines = guardedLines.filter((line) =>
    line.sectionType !== "ALTERNATE" && (
      line.priceProvenance === "UNRESOLVED" || line.unitPrice <= 0
    ),
  );
  const patch = {
    ...input.patch,
    lineChanges: input.patch.lineChanges.map((change) => {
      const unresolved = change.action !== "REMOVE" && (
        change.priceProvenance === "UNRESOLVED" ||
        unresolvedDescriptions.has(change.description.trim().toLocaleLowerCase())
      );
      return unresolved && change.unitPrice !== 0
        ? { ...change, unitPrice: 0, priceProvenance: "UNRESOLVED" as const }
        : change;
    }),
  };
  return {
    suggestion: {
      ...input.suggestion,
      lineItems: guardedLines,
      requiresPricingReview:
        input.preparation?.draft.requiresPricingReview === true ||
        input.suggestion.requiresPricingReview === true ||
        pricingReviewLines.length > 0,
    },
    patch,
    pricingReviewLines,
  };
}
