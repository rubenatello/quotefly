import { useEffect, useRef, type FormEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, LoaderCircle, Search, Sparkles, UserRound } from "lucide-react";
import type {
  AiQuoteSuggestion,
  QuotePreparationCustomerAmbiguous,
  QuotePreparationNeedsClarification,
  QuotePreparationReady,
  ServiceType,
} from "../../lib/api";
import { KodySparkIcon } from "../ai/KodySparkIcon";
import { Alert, Badge, Button, Modal, ModalBody, ModalFooter, ModalHeader, Select, Textarea } from "../ui";

export type QuoteKodyPreparedReview = {
  preparation: QuotePreparationReady;
  suggestion: AiQuoteSuggestion;
  pricingReviewDescriptions: string[];
};

type QuoteKodyClarification = QuotePreparationNeedsClarification | QuotePreparationCustomerAmbiguous;

type CustomerContext = {
  fullName: string;
  phone?: string | null;
  email?: string | null;
};

const TRADE_OPTIONS: ServiceType[] = [
  "HVAC",
  "PLUMBING",
  "FLOORING",
  "ROOFING",
  "GARDENING",
  "CONSTRUCTION",
];

function customerContact(customer: CustomerContext | QuotePreparationReady["customer"]) {
  if (!customer) return "";
  return [customer.phone, customer.email].filter(Boolean).join(" / ");
}

export function QuoteKodyPrepareModal({
  open,
  onClose,
  prompt,
  onPromptChange,
  selectedCustomer,
  useSelectedCustomer,
  onUseSelectedCustomerChange,
  tradeHint,
  onTradeHintChange,
  clarification,
  review,
  loading,
  loadingLabel,
  errorMessage,
  statusMessage,
  usageLimitMessage,
  disabled,
  onSubmit,
  onSelectCandidate,
  onEditRequest,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  prompt: string;
  onPromptChange: (value: string) => void;
  selectedCustomer?: CustomerContext | null;
  useSelectedCustomer: boolean;
  onUseSelectedCustomerChange: (value: boolean) => void;
  tradeHint: ServiceType | null;
  onTradeHintChange: (value: ServiceType | null) => void;
  clarification?: QuoteKodyClarification | null;
  review?: QuoteKodyPreparedReview | null;
  loading?: boolean;
  loadingLabel?: string | null;
  errorMessage?: string | null;
  statusMessage?: string | null;
  usageLimitMessage?: string | null;
  disabled?: boolean;
  onSubmit: (event: FormEvent) => void | Promise<void>;
  onSelectCandidate: (customerId: string) => void;
  onEditRequest: () => void;
  onApply: () => void | Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage === "es-US" ? "es-US" : "en-US";
  const money = new Intl.NumberFormat(locale, { style: "currency", currency: "USD" });
  const isReviewing = Boolean(review);
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const wasReviewingRef = useRef(false);
  const close = () => onClose();

  useEffect(() => {
    if (!open || !isReviewing) {
      wasReviewingRef.current = false;
      return;
    }
    if (wasReviewingRef.current) return;

    wasReviewingRef.current = true;
    const frame = window.requestAnimationFrame(() => {
      reviewHeadingRef.current?.focus({ preventScroll: true });
      reviewHeadingRef.current?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isReviewing, open]);

  return (
    <Modal
      open={open}
      onClose={close}
      size={isReviewing ? "lg" : "md"}
      closeOnBackdrop={!loading}
      ariaLabel={t(isReviewing ? "quoteBuilder.kodyPrepare.reviewTitle" : "quoteBuilder.kodyPrepare.title")}
    >
      <ModalHeader
        title={
          <span className="flex items-center gap-2.5">
            <KodySparkIcon size={26} />
            {t(isReviewing ? "quoteBuilder.kodyPrepare.reviewTitle" : "quoteBuilder.kodyPrepare.title")}
          </span>
        }
        description={t(isReviewing ? "quoteBuilder.kodyPrepare.reviewDescription" : "quoteBuilder.kodyPrepare.description")}
        onClose={close}
      />
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {isReviewing ? t("quoteBuilder.kodyPrepare.reviewTitle") : ""}
      </p>

      {isReviewing && review ? (
        <ReviewBody
          review={review}
          money={money}
          headingRef={reviewHeadingRef}
          errorMessage={errorMessage}
          statusMessage={statusMessage}
        />
      ) : (
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit}>
          <ModalBody className="space-y-4 bg-[var(--qf-panel-muted)]">
            {usageLimitMessage ? <Alert tone="warning">{usageLimitMessage}</Alert> : null}

            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_190px]">
              <div className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-3.5 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">
                  {t("quoteBuilder.kodyPrepare.customerContext")}
                </p>
                <div className="mt-2 flex items-start gap-2.5">
                  <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--qf-brand-blue-soft)] text-[var(--qf-link)]">
                    {selectedCustomer && useSelectedCustomer ? <UserRound size={17} aria-hidden="true" /> : <Search size={17} aria-hidden="true" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-[var(--qf-text)]">
                      {selectedCustomer && useSelectedCustomer
                        ? selectedCustomer.fullName
                        : t("quoteBuilder.kodyPrepare.findFromRequest")}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-[var(--qf-text-muted)]">
                      {selectedCustomer && useSelectedCustomer
                        ? customerContact(selectedCustomer) || t("quoteBuilder.kodyPrepare.selectedCustomer")
                        : t("quoteBuilder.kodyPrepare.findFromRequestHelp")}
                    </p>
                  </div>
                </div>
                {selectedCustomer ? (
                  <button
                    type="button"
                    onClick={() => onUseSelectedCustomerChange(!useSelectedCustomer)}
                    disabled={loading}
                    className="mt-2 min-h-11 text-left text-xs font-semibold text-[var(--qf-link)] underline-offset-4 hover:underline disabled:opacity-50 sm:min-h-9"
                  >
                    {t(useSelectedCustomer ? "quoteBuilder.kodyPrepare.useRequestCustomer" : "quoteBuilder.kodyPrepare.useSelectedCustomer")}
                  </button>
                ) : null}
              </div>

              <div className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-3.5 py-3">
                <Select
                  label={t("quoteBuilder.kodyPrepare.trade")}
                  value={tradeHint ?? "AUTO"}
                  onChange={(event) => onTradeHintChange(event.target.value === "AUTO" ? null : event.target.value as ServiceType)}
                  options={[
                    { value: "AUTO", label: t("quoteBuilder.kodyPrepare.autoDetect") },
                    ...TRADE_OPTIONS.map((value) => ({ value, label: t(`domain.trade.${value}`) })),
                  ]}
                  disabled={loading}
                />
              </div>
            </div>

            {clarification ? (
              <div className="rounded-xl border border-[var(--qf-warning-border)] bg-[var(--qf-warning-bg)] px-4 py-3" role="status">
                <p className="text-sm font-semibold text-[var(--qf-warning-text)]">
                  {t("quoteBuilder.kodyPrepare.clarificationTitle")}
                </p>
                <p className="mt-1 text-sm leading-6 text-[var(--qf-warning-text)]">{clarification.clarification.message}</p>
                {clarification.status === "CUSTOMER_AMBIGUOUS" && clarification.customerCandidates.length ? (
                  <div className="mt-3 grid gap-2">
                    {clarification.customerCandidates.map((candidate) => (
                      <button
                        key={candidate.id}
                        type="button"
                        onClick={() => onSelectCandidate(candidate.id)}
                        disabled={loading}
                        className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-[var(--qf-warning-border)] bg-[var(--qf-panel)] px-3 py-2 text-left transition hover:border-[var(--qf-action-primary)] hover:bg-[var(--qf-selected)] disabled:opacity-50"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-[var(--qf-text)]">{candidate.fullName}</span>
                          <span className="mt-0.5 block truncate text-xs text-[var(--qf-text-muted)]">
                            {customerContact(candidate) || t("quoteBuilder.kodyPrepare.customerRecord")}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs font-semibold text-[var(--qf-link)]">{t("quoteBuilder.kodyPrepare.choose")}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div>
              <Textarea
                data-testid="quote-kody-prompt"
                label={t("quoteBuilder.kodyPrepare.promptLabel")}
                aria-label={t("quoteBuilder.kodyPrepare.promptAria")}
                className="min-h-[132px] bg-[var(--qf-panel)] text-[15px] leading-6"
                rows={5}
                placeholder={t(selectedCustomer && useSelectedCustomer
                  ? "quoteBuilder.kodyPrepare.promptPlaceholderSelected"
                  : "quoteBuilder.kodyPrepare.promptPlaceholder")}
                value={prompt}
                onChange={(event) => onPromptChange(event.target.value)}
                disabled={loading}
                autoFocus
              />
              <p className="mt-2 text-xs leading-5 text-[var(--qf-text-muted)]">
                {t("quoteBuilder.kodyPrepare.example")}
              </p>
            </div>

            {loading ? (
              <div className="flex items-start gap-3 rounded-xl border border-[var(--qf-info-border)] bg-[var(--qf-info-surface)] px-4 py-3" role="status" aria-live="polite">
                <LoaderCircle size={19} className="mt-0.5 shrink-0 animate-spin text-[var(--qf-link)]" aria-hidden="true" />
                <div>
                  <p className="text-sm font-semibold text-[var(--qf-info-text)]">
                    {loadingLabel || t("quoteBuilder.kodyPrepare.working")}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-[var(--qf-info-text)]">
                    {t("quoteBuilder.kodyPrepare.workingDetail")}
                  </p>
                </div>
              </div>
            ) : null}

            {errorMessage ? <Alert tone="error">{errorMessage}</Alert> : null}
            {statusMessage ? <Alert tone="info">{statusMessage}</Alert> : null}
          </ModalBody>

          <ModalFooter className="sm:justify-between">
            <p className="hidden max-w-xs text-xs leading-5 text-[var(--qf-text-muted)] sm:block">
              {t("quoteBuilder.kodyPrepare.reviewBoundary")}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="ghost" onClick={close}>
                {loading ? t("quoteComponents.aiModal.stop") : t("common.cancel")}
              </Button>
              <Button type="submit" variant="secondary" loading={loading} icon={<Sparkles size={15} />} disabled={disabled || !prompt.trim()}>
                {clarification ? t("quoteBuilder.kodyPrepare.tryAgain") : t("quoteBuilder.kodyPrepare.prepare")}
              </Button>
            </div>
          </ModalFooter>
        </form>
      )}

      {isReviewing ? (
        <ModalFooter className="sm:justify-between">
          <p className="hidden max-w-sm text-xs leading-5 text-[var(--qf-text-muted)] sm:block">
            {t("quoteBuilder.kodyPrepare.applyBoundary")}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onEditRequest} disabled={loading}>
              {t("quoteBuilder.kodyPrepare.editRequest")}
            </Button>
            <Button type="button" variant="secondary" icon={<Check size={15} />} onClick={() => void onApply()} loading={loading}>
              {t("quoteBuilder.kodyPrepare.apply")}
            </Button>
          </div>
        </ModalFooter>
      ) : null}
    </Modal>
  );
}

function ReviewBody({
  review,
  money,
  headingRef,
  errorMessage,
  statusMessage,
}: {
  review: QuoteKodyPreparedReview;
  money: Intl.NumberFormat;
  headingRef: RefObject<HTMLHeadingElement | null>;
  errorMessage?: string | null;
  statusMessage?: string | null;
}) {
  const { t } = useTranslation();
  const { preparation, suggestion } = review;
  const customer = preparation.customer;
  const customerDraft = preparation.customerDraft;
  const customerName = customer?.fullName ?? customerDraft.fullName ?? t("quoteBuilder.kodyPrepare.customerUnresolved");
  const customerDetails = customer
    ? customerContact(customer)
    : [customerDraft.phone, customerDraft.email].filter(Boolean).join(" / ");
  const sources = preparation.retrievedSourceLabels;
  const requiresPricingReview = suggestion.requiresPricingReview === true || review.pricingReviewDescriptions.length > 0;

  return (
    <ModalBody className="space-y-4 bg-[var(--qf-panel-muted)]">
      <h2
        ref={headingRef}
        tabIndex={-1}
        data-testid="quote-kody-review-heading"
        className="sr-only focus:outline-none"
      >
        {t("quoteBuilder.kodyPrepare.reviewTitle")}
      </h2>
      {errorMessage ? <Alert tone="error">{errorMessage}</Alert> : null}
      {statusMessage ? <Alert tone="info">{statusMessage}</Alert> : null}
      <section className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-4 py-3" aria-labelledby="kody-review-customer">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p id="kody-review-customer" className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">
              {t("quoteBuilder.kodyPrepare.customer")}
            </p>
            <p className="mt-1 truncate text-sm font-semibold text-[var(--qf-text)]">{customerName}</p>
            {customerDetails ? <p className="mt-0.5 truncate text-xs text-[var(--qf-text-muted)]">{customerDetails}</p> : null}
          </div>
          <Badge tone={customer ? "blue" : "orange"}>
            {t(customer ? "quoteBuilder.kodyPrepare.matchedCustomer" : "quoteBuilder.kodyPrepare.newCustomer")}
          </Badge>
        </div>
      </section>

      <section className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-4 py-4" aria-labelledby="kody-review-quote">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p id="kody-review-quote" className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">
            {t("quoteBuilder.kodyPrepare.quote")}
          </p>
          <Badge tone="slate">{t(`domain.trade.${suggestion.serviceType}`)}</Badge>
        </div>
        <div className="mt-3">
          <p className="text-xs font-semibold text-[var(--qf-text-muted)]">{t("quoteBuilder.kodyPrepare.quoteTitle")}</p>
          <p className="mt-1 text-base font-semibold text-[var(--qf-text)]">{suggestion.title}</p>
        </div>
        <div className="mt-3 border-t border-[var(--qf-border)] pt-3">
          <p className="text-xs font-semibold text-[var(--qf-text-muted)]">{t("quoteBuilder.kodyPrepare.overview")}</p>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-[var(--qf-text-soft)]">{suggestion.scopeText}</p>
        </div>
      </section>

      <section className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-4 py-4" aria-labelledby="kody-review-lines">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p id="kody-review-lines" className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">
            {t("quoteBuilder.kodyPrepare.lineItems", { count: suggestion.lineItems.length })}
          </p>
          <p className="text-sm font-semibold text-[var(--qf-text)]">{money.format(suggestion.totalAmount)}</p>
        </div>
        <ol className="mt-3 divide-y divide-[var(--qf-border)]">
          {suggestion.lineItems.map((line, index) => {
            const unresolved = line.priceProvenance === "UNRESOLVED" || line.unitPrice <= 0;
            return (
              <li key={`${line.description}-${index}`} className="grid gap-2 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-bold text-[var(--qf-text-muted)]">{index + 1}</span>
                    {line.sectionType === "ALTERNATE" ? <Badge tone="slate">{t("quoteBuilder.kodyPrepare.alternate")}</Badge> : null}
                    {unresolved ? <Badge tone="orange">{t("quoteBuilder.kodyPrepare.priceNeeded")}</Badge> : null}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-sm font-semibold leading-6 text-[var(--qf-text)]">{line.description}</p>
                </div>
                <div className="flex items-center justify-between gap-4 text-sm sm:block sm:text-right">
                  <p className="text-[var(--qf-text-muted)]">{t("quoteBuilder.kodyPrepare.quantity", { count: line.quantity })}</p>
                  <p className="font-semibold text-[var(--qf-text)]">{money.format(line.quantity * line.unitPrice)}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      {requiresPricingReview ? (
        <Alert tone="warning">
          <span className="font-semibold">{t("quoteBuilder.kodyPrepare.pricingTitle")}</span>{" "}
          {t("quoteBuilder.kodyPrepare.pricingDescription")}
        </Alert>
      ) : null}

      <details className="group rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-4 py-3">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-[var(--qf-text)]">
          <span>{t("quoteBuilder.kodyPrepare.sources", { count: sources.length })}</span>
          <ChevronDown size={16} className="transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="border-t border-[var(--qf-border)] pt-3 text-xs leading-5 text-[var(--qf-text-muted)]">
          {sources.length ? (
            <ul className="list-disc space-y-1 pl-4">
              {sources.map((source) => <li key={source}>{source}</li>)}
            </ul>
          ) : (
            <p>{t("quoteBuilder.kodyPrepare.noSources")}</p>
          )}
          {preparation.retrievalDegraded ? <p className="mt-2 text-[var(--qf-warning-text)]">{t("quoteBuilder.kodyPrepare.retrievalDegraded")}</p> : null}
        </div>
      </details>
    </ModalBody>
  );
}
