import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { CalendarDays, ExternalLink, FileCheck2, ReceiptText, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { money, useDashboard } from "../dashboard/DashboardContext";
import {
  Alert,
  Badge,
  Button,
  ConfirmModal,
  Input,
  LoadingState,
} from "../ui";
import {
  api,
  type Invoice,
  type InvoicePaymentStatus,
  type InvoiceStatus,
  type QuickBooksCustomerCandidate,
  type QuickBooksInvoiceOperationStatus,
  type QuickBooksInvoiceReviewOptions,
  type QuickBooksInvoiceSyncPreview,
  type QuickBooksItemCandidate,
} from "../../lib/api";
import { localizedApiError } from "../../lib/localized-api-error";
import {
  isCurrentQuickBooksRequestContext,
  isQuickBooksPreviewCurrentForPublish,
  isValidQuickBooksBillingEmail,
  safeQuickBooksHostedPaymentUrl,
} from "../../lib/quickbooks-payment-link";
import { tenantWallTimeToIso, toTenantDateTimeInput, validTimeZone } from "../../lib/tenant-time";

type InvoicePanelProps = {
  jobId?: string;
  sourceQuoteId?: string;
  sourceLabel: string;
  sourceAmount: string | number;
  canCreate: boolean;
  createBlockedReason?: string | null;
  kodyInvoiceId?: string | null;
  onKodyInvoiceConsumed?: () => void;
};

function addCalendarDays(dateValue: string, days: number) {
  const [year, month, day] = dateValue.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function defaultDueDate(timeZone: string) {
  return addCalendarDays(toTenantDateTimeInput(new Date(), timeZone).slice(0, 10), 30);
}

function formatInvoiceDate(value: string, locale: string, timeZone: string) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone,
  }).format(new Date(value));
}

function invoiceStatusTone(status: InvoiceStatus): "slate" | "blue" | "emerald" | "red" | "amber" {
  if (status === "PAID") return "emerald";
  if (status === "OPEN") return "blue";
  if (status === "VOID") return "red";
  if (status === "UNCOLLECTIBLE") return "amber";
  return "slate";
}

function paymentStatusTone(status: InvoicePaymentStatus): "slate" | "emerald" | "red" | "amber" {
  if (status === "SUCCEEDED") return "emerald";
  if (status === "FAILED" || status === "CANCELED") return "red";
  if (status === "REFUNDED" || status === "PARTIALLY_REFUNDED") return "amber";
  return "slate";
}

function quickBooksStatusTone(status: QuickBooksInvoiceOperationStatus): "slate" | "blue" | "emerald" | "red" | "amber" {
  if (status === "SUCCEEDED") return "emerald";
  if (status === "FAILED") return "red";
  if (status === "RECONCILIATION_REQUIRED") return "amber";
  if (status === "PROCESSING" || status === "RECONCILING") return "blue";
  return "slate";
}

export function InvoicePanel({
  jobId,
  sourceQuoteId,
  sourceLabel,
  sourceAmount,
  canCreate,
  createBlockedReason,
  kodyInvoiceId = null,
  onKodyInvoiceConsumed,
}: InvoicePanelProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { session } = useDashboard();
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const locale = i18n.resolvedLanguage ?? "en-US";
  const timeZone = validTimeZone(session?.timezone ?? "UTC");
  const sourceKey = jobId ? `job:${jobId}` : sourceQuoteId ? `quote:${sourceQuoteId}` : "missing";
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [quickBooksConfirmOpen, setQuickBooksConfirmOpen] = useState(false);
  const [quickBooksPreview, setQuickBooksPreview] = useState<QuickBooksInvoiceSyncPreview | null>(null);
  const [quickBooksEnabled, setQuickBooksEnabled] = useState(false);
  const [quickBooksLoading, setQuickBooksLoading] = useState(false);
  const [quickBooksSaving, setQuickBooksSaving] = useState(false);
  const [quickBooksMappingSaving, setQuickBooksMappingSaving] = useState<string | null>(null);
  const [quickBooksError, setQuickBooksError] = useState<string | null>(null);
  const [quickBooksBillingEmail, setQuickBooksBillingEmail] = useState("");
  const [quickBooksAllowAch, setQuickBooksAllowAch] = useState(false);
  const [quickBooksAllowCard, setQuickBooksAllowCard] = useState(false);
  const [quickBooksReviewDirty, setQuickBooksReviewDirty] = useState(false);
  const [quickBooksCustomerId, setQuickBooksCustomerId] = useState("");
  const [quickBooksItemIds, setQuickBooksItemIds] = useState<Record<string, string>>({});
  const [quickBooksCustomerSearch, setQuickBooksCustomerSearch] = useState("");
  const [quickBooksCustomerCandidates, setQuickBooksCustomerCandidates] = useState<QuickBooksCustomerCandidate[]>([]);
  const [quickBooksItemSearches, setQuickBooksItemSearches] = useState<Record<string, string>>({});
  const [quickBooksItemCandidates, setQuickBooksItemCandidates] = useState<Record<string, QuickBooksItemCandidate[]>>({});
  const [quickBooksSearchLoading, setQuickBooksSearchLoading] = useState<string | null>(null);
  const [quickBooksSearchErrors, setQuickBooksSearchErrors] = useState<Record<string, string>>({});
  const [quickBooksSearchCompleted, setQuickBooksSearchCompleted] = useState<Record<string, boolean>>({});
  const [quickBooksPaymentLink, setQuickBooksPaymentLink] = useState<string | null>(null);
  const [quickBooksPaymentLinkLoading, setQuickBooksPaymentLinkLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ message: string; tone: "success" | "warning" } | null>(null);
  const [dueDate, setDueDate] = useState(() => defaultDueDate(timeZone));
  const commandRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const sourceRef = useRef(sourceKey);
  const operationGenerationRef = useRef(0);
  const quickBooksGenerationRef = useRef(0);
  const quickBooksOperationGenerationRef = useRef(0);
  const quickBooksMappingMutationGenerationRef = useRef(0);
  const quickBooksLookupGenerationRef = useRef(0);
  const quickBooksPaymentLinkGenerationRef = useRef(0);
  const activeInvoiceRef = useRef<Invoice | null>(invoice);
  activeInvoiceRef.current = invoice;
  const quickBooksCommandRef = useRef<{ fingerprint: string; key: string } | null>(null);
  if (sourceRef.current !== sourceKey) {
    sourceRef.current = sourceKey;
    operationGenerationRef.current += 1;
    quickBooksGenerationRef.current += 1;
    quickBooksOperationGenerationRef.current += 1;
    quickBooksMappingMutationGenerationRef.current += 1;
    quickBooksLookupGenerationRef.current += 1;
    quickBooksPaymentLinkGenerationRef.current += 1;
  }

  const operationIsCurrent = useCallback(
    (operationSource: string, generation: number) =>
      sourceRef.current === operationSource && operationGenerationRef.current === generation,
    [],
  );

  const quickBooksOperationIsCurrent = useCallback(
    (operationSource: string, generation: number) =>
      sourceRef.current === operationSource && quickBooksOperationGenerationRef.current === generation,
    [],
  );

  const quickBooksLookupIsCurrent = useCallback(
    (operationSource: string, generation: number) =>
      isCurrentQuickBooksRequestContext({
        requestedSource: operationSource,
        requestedGeneration: generation,
        currentSource: sourceRef.current,
        currentGeneration: quickBooksLookupGenerationRef.current,
      }),
    [],
  );

  const quickBooksMappingMutationIsCurrent = useCallback(
    (
      operationSource: string,
      generation: number,
      requestedInvoiceId: string,
      requestedInvoiceVersion?: number,
    ) =>
      isCurrentQuickBooksRequestContext({
        requestedSource: operationSource,
        requestedGeneration: generation,
        currentSource: sourceRef.current,
        currentGeneration: quickBooksMappingMutationGenerationRef.current,
        requestedInvoiceId,
        currentInvoiceId: activeInvoiceRef.current?.id ?? null,
        ...(requestedInvoiceVersion === undefined ? {} : {
          requestedInvoiceVersion,
          currentInvoiceVersion: activeInvoiceRef.current?.version ?? null,
        }),
      }),
    [],
  );

  const quickBooksPaymentLinkIsCurrent = useCallback(
    (operationSource: string, generation: number, requestedInvoiceId?: string, responseInvoiceId?: string) =>
      isCurrentQuickBooksRequestContext({
        requestedSource: operationSource,
        requestedGeneration: generation,
        currentSource: sourceRef.current,
        currentGeneration: quickBooksPaymentLinkGenerationRef.current,
        requestedInvoiceId,
        responseInvoiceId,
        currentInvoiceId: activeInvoiceRef.current?.id ?? null,
      }),
    [],
  );

  const loadInvoice = useCallback(async () => {
    const operationSource = sourceKey;
    const generation = ++operationGenerationRef.current;
    if (!jobId && !sourceQuoteId) {
      if (operationIsCurrent(operationSource, generation)) {
        setLoading(false);
        setInvoice(null);
      }
      return;
    }
    setLoading(true);
    setInvoice(null);
    setError(null);
    try {
      const response = await api.invoices.list({
        jobId,
        sourceQuoteId,
        limit: 1,
        offset: 0,
      });
      if (!operationIsCurrent(operationSource, generation)) return;
      setInvoice(response.items[0] ?? null);
    } catch (err) {
      if (!operationIsCurrent(operationSource, generation)) return;
      setInvoice(null);
      setError(localizedApiError(err, t, { fallbackKey: "invoices.loadError" }));
    } finally {
      if (operationIsCurrent(operationSource, generation)) setLoading(false);
    }
  }, [jobId, operationIsCurrent, sourceKey, sourceQuoteId, t]);

  const loadQuickBooksPreview = useCallback(async (
    currentInvoice: Invoice,
    options: {
      clearError?: boolean;
      preservePreviewOnError?: boolean;
      reviewOptions?: QuickBooksInvoiceReviewOptions;
    } = {},
  ) => {
    const operationSource = sourceRef.current;
    const requestedInvoiceId = currentInvoice.id;
    const generation = ++quickBooksGenerationRef.current;
    setQuickBooksLoading(true);
    if (options.clearError !== false) setQuickBooksError(null);
    try {
      const response = await api.integrations.quickbooks.invoiceSyncPreview(currentInvoice.id, options.reviewOptions);
      if (!isCurrentQuickBooksRequestContext({
        requestedSource: operationSource,
        requestedGeneration: generation,
        currentSource: sourceRef.current,
        currentGeneration: quickBooksGenerationRef.current,
        requestedInvoiceId,
        responseInvoiceId: response.preview.invoice.id,
        currentInvoiceId: activeInvoiceRef.current?.id ?? null,
      })) return;
      setQuickBooksEnabled(response.providerWorkflowsEnabled);
      setQuickBooksPreview(response.preview);
      setInvoice((current) => current?.id === response.preview.invoice.id
        && current.version !== response.preview.invoice.version
        ? { ...current, version: response.preview.invoice.version }
        : current);
      setQuickBooksBillingEmail(response.preview.billingEmail ?? "");
      setQuickBooksAllowAch(response.preview.paymentMethods?.ach ?? false);
      setQuickBooksAllowCard(response.preview.paymentMethods?.card ?? false);
      setQuickBooksCustomerId(response.preview.customerMapping?.quickBooksCustomerId ?? "");
      setQuickBooksItemIds(Object.fromEntries(response.preview.lineItems.map((line) => [line.itemKey ?? line.description, line.quickBooksItemId ?? ""])));
      setQuickBooksCustomerSearch(response.preview.invoice.customerName);
      setQuickBooksCustomerCandidates([]);
      setQuickBooksItemSearches(Object.fromEntries(response.preview.lineItems.map((line) => [line.itemKey ?? line.description, line.description])));
      setQuickBooksItemCandidates({});
      setQuickBooksSearchErrors({});
      setQuickBooksSearchCompleted({});
      setQuickBooksReviewDirty(false);
    } catch (err) {
      if (!isCurrentQuickBooksRequestContext({
        requestedSource: operationSource,
        requestedGeneration: generation,
        currentSource: sourceRef.current,
        currentGeneration: quickBooksGenerationRef.current,
        requestedInvoiceId,
        currentInvoiceId: activeInvoiceRef.current?.id ?? null,
      })) return;
      if (!options.preservePreviewOnError) setQuickBooksPreview(null);
      setQuickBooksError(localizedApiError(err, t, { fallbackKey: "invoices.quickBooks.loadError" }));
    } finally {
      if (isCurrentQuickBooksRequestContext({
        requestedSource: operationSource,
        requestedGeneration: generation,
        currentSource: sourceRef.current,
        currentGeneration: quickBooksGenerationRef.current,
        requestedInvoiceId,
        currentInvoiceId: activeInvoiceRef.current?.id ?? null,
      })) setQuickBooksLoading(false);
    }
  }, [t]);

  useEffect(() => {
    setDueDate(defaultDueDate(timeZone));
    setInvoice(null);
    setError(null);
    setNotice(null);
    setConfirmOpen(false);
    setQuickBooksConfirmOpen(false);
    setSaving(false);
    setQuickBooksPreview(null);
    setQuickBooksError(null);
    setQuickBooksSaving(false);
    setQuickBooksMappingSaving(null);
    setQuickBooksBillingEmail("");
    setQuickBooksAllowAch(false);
    setQuickBooksAllowCard(false);
    setQuickBooksReviewDirty(false);
    setQuickBooksCustomerId("");
    setQuickBooksItemIds({});
    setQuickBooksCustomerSearch("");
    setQuickBooksCustomerCandidates([]);
    setQuickBooksItemSearches({});
    setQuickBooksItemCandidates({});
    setQuickBooksSearchLoading(null);
    setQuickBooksSearchErrors({});
    setQuickBooksSearchCompleted({});
    setQuickBooksPaymentLink(null);
    setQuickBooksPaymentLinkLoading(false);
    commandRef.current = null;
    quickBooksCommandRef.current = null;
    quickBooksGenerationRef.current += 1;
    quickBooksOperationGenerationRef.current += 1;
    quickBooksMappingMutationGenerationRef.current += 1;
    void loadInvoice();
    return () => {
      operationGenerationRef.current += 1;
    };
  }, [loadInvoice, sourceKey, timeZone]);

  useEffect(() => {
    if (!invoice || !canCreate) return;
    void loadQuickBooksPreview(invoice);
    return () => {
      quickBooksGenerationRef.current += 1;
    };
  }, [canCreate, invoice, loadQuickBooksPreview]);

  useEffect(() => {
    if (!kodyInvoiceId || loading || error) return;
    if (invoice?.id !== kodyInvoiceId) {
      onKodyInvoiceConsumed?.();
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      headingRef.current?.scrollIntoView({
        block: "center",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
      headingRef.current?.focus({ preventScroll: true });
      onKodyInvoiceConsumed?.();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [error, invoice, kodyInvoiceId, loading, onKodyInvoiceConsumed]);

  const dueAtUtc = useMemo(
    () => dueDate ? tenantWallTimeToIso(`${dueDate}T12:00`, timeZone) : null,
    [dueDate, timeZone],
  );

  const quickBooksReviewOptions = useMemo<QuickBooksInvoiceReviewOptions>(() => ({
    billingEmail: quickBooksBillingEmail.trim() || null,
    allowOnlineAchPayment: quickBooksAllowAch,
    allowOnlineCardPayment: quickBooksAllowCard,
  }), [quickBooksAllowAch, quickBooksAllowCard, quickBooksBillingEmail]);
  const quickBooksBillingEmailInvalid = Boolean(
    quickBooksBillingEmail.trim()
    && !isValidQuickBooksBillingEmail(quickBooksBillingEmail),
  ) || Boolean(
    (quickBooksAllowAch || quickBooksAllowCard)
    && !isValidQuickBooksBillingEmail(quickBooksBillingEmail),
  );
  const quickBooksPreviewMatchesInvoice = isQuickBooksPreviewCurrentForPublish({
    activeInvoiceId: invoice?.id,
    activeInvoiceVersion: invoice?.version,
    previewInvoiceId: quickBooksPreview?.invoice.id,
    previewInvoiceVersion: quickBooksPreview?.invoice.version,
  });

  const handleCreate = async () => {
    if (saving || !canCreate || createBlockedReason || (!jobId && !sourceQuoteId)) return;
    if (!dueAtUtc) {
      setError(t("invoices.invalidDueDate"));
      setConfirmOpen(false);
      return;
    }

    const payload = {
      ...(jobId ? { jobId } : { sourceQuoteId }),
      dueAtUtc,
    };
    const fingerprint = JSON.stringify(payload);
    if (!commandRef.current || commandRef.current.fingerprint !== fingerprint) {
      commandRef.current = { fingerprint, key: `qf-invoice-${crypto.randomUUID()}` };
    }
    const operationSource = sourceKey;
    const generation = ++operationGenerationRef.current;

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await api.invoices.create(payload, commandRef.current.key);
      if (!operationIsCurrent(operationSource, generation)) return;
      setInvoice(response.invoice);
      setNotice({
        message: response.duplicate ? t("invoices.existingNotice") : t("invoices.createdNotice"),
        tone: "success",
      });
      setConfirmOpen(false);
    } catch (err) {
      if (!operationIsCurrent(operationSource, generation)) return;
      setError(localizedApiError(err, t, { fallbackKey: "invoices.createError" }));
      setConfirmOpen(false);
    } finally {
      if (operationIsCurrent(operationSource, generation)) setSaving(false);
    }
  };

  const handleQuickBooksPublish = async () => {
    if (
      !invoice
      || !quickBooksPreview?.ready
      || !quickBooksPreview.reviewBinding
      || !quickBooksEnabled
      || quickBooksSaving
    ) return;
    const reviewedPreview = quickBooksPreview;
    if (!isQuickBooksPreviewCurrentForPublish({
      activeInvoiceId: invoice.id,
      activeInvoiceVersion: invoice.version,
      previewInvoiceId: reviewedPreview.invoice.id,
      previewInvoiceVersion: reviewedPreview.invoice.version,
    })) {
      setQuickBooksConfirmOpen(false);
      setQuickBooksError(t("invoices.quickBooks.reviewStale"));
      void loadQuickBooksPreview(invoice);
      return;
    }
    const reviewBinding = reviewedPreview.reviewBinding;
    if (!reviewBinding) return;
    const fingerprint = `${reviewedPreview.invoice.id}:${reviewedPreview.invoice.version}:${reviewBinding}`;
    if (!quickBooksCommandRef.current || quickBooksCommandRef.current.fingerprint !== fingerprint) {
      quickBooksCommandRef.current = {
        fingerprint,
        key: `qf-quickbooks-invoice-${crypto.randomUUID()}`,
      };
    }
    const operationSource = sourceKey;
    const generation = ++quickBooksOperationGenerationRef.current;
    setQuickBooksSaving(true);
    setQuickBooksError(null);
    setNotice(null);
    try {
      const response = await api.integrations.quickbooks.publishQuoteFlyInvoice(
        reviewedPreview.invoice.id,
        {
          invoiceVersion: reviewedPreview.invoice.version,
          reviewBinding,
          billingEmail: reviewedPreview.billingEmail,
          allowOnlineAchPayment: reviewedPreview.paymentMethods?.ach ?? false,
          allowOnlineCardPayment: reviewedPreview.paymentMethods?.card ?? false,
        },
        quickBooksCommandRef.current.key,
      );
      if (!quickBooksOperationIsCurrent(operationSource, generation)) return;
      setQuickBooksPreview((current) => current ? { ...current, operation: response.operation } : current);
      setQuickBooksConfirmOpen(false);
      await loadQuickBooksPreview(invoice, { clearError: false, preservePreviewOnError: true });
    } catch (err) {
      if (!quickBooksOperationIsCurrent(operationSource, generation)) return;
      const message = localizedApiError(err, t, {
        fallbackKey: "invoices.quickBooks.publishError",
        codeKeys: {
          INVOICE_VERSION_CONFLICT: "invoices.quickBooks.versionConflict",
          QUICKBOOKS_REVIEW_STALE: "invoices.quickBooks.reviewStale",
        },
      });
      setQuickBooksConfirmOpen(false);
      await loadQuickBooksPreview(invoice, { clearError: false });
      if (quickBooksOperationIsCurrent(operationSource, generation)) setQuickBooksError(message);
    } finally {
      if (quickBooksOperationIsCurrent(operationSource, generation)) setQuickBooksSaving(false);
    }
  };

  const handleQuickBooksReviewOptions = async () => {
    if (!invoice || quickBooksLoading || quickBooksSaving || quickBooksBillingEmailInvalid) {
      if (quickBooksBillingEmailInvalid) setQuickBooksError(t("invoices.quickBooks.invalidBillingEmail"));
      return;
    }
    setQuickBooksPaymentLink(null);
    await loadQuickBooksPreview(invoice, { reviewOptions: quickBooksReviewOptions });
  };

  const handleQuickBooksCustomerSearch = async () => {
    const query = quickBooksCustomerSearch.trim();
    if (query.length < 2) {
      setQuickBooksSearchErrors((current) => ({ ...current, customer: t("invoices.quickBooks.searchMinimum") }));
      return;
    }
    const operationSource = sourceKey;
    const generation = ++quickBooksLookupGenerationRef.current;
    setQuickBooksSearchLoading("customer");
    setQuickBooksSearchErrors((current) => ({ ...current, customer: "" }));
    setQuickBooksSearchCompleted((current) => ({ ...current, customer: false }));
    try {
      const response = await api.integrations.quickbooks.searchCustomerMappings(query);
      if (!quickBooksLookupIsCurrent(operationSource, generation)) return;
      setQuickBooksCustomerCandidates(response.candidates ?? []);
      setQuickBooksSearchCompleted((current) => ({ ...current, customer: true }));
    } catch (err) {
      if (!quickBooksLookupIsCurrent(operationSource, generation)) return;
      setQuickBooksCustomerCandidates([]);
      setQuickBooksSearchErrors((current) => ({
        ...current,
        customer: localizedApiError(err, t, { fallbackKey: "invoices.quickBooks.searchError" }),
      }));
    } finally {
      if (quickBooksLookupIsCurrent(operationSource, generation)) setQuickBooksSearchLoading(null);
    }
  };

  const handleQuickBooksItemSearch = async (itemKey: string) => {
    const query = quickBooksItemSearches[itemKey]?.trim() ?? "";
    if (query.length < 2) {
      setQuickBooksSearchErrors((current) => ({ ...current, [itemKey]: t("invoices.quickBooks.searchMinimum") }));
      return;
    }
    const operationSource = sourceKey;
    const generation = ++quickBooksLookupGenerationRef.current;
    setQuickBooksSearchLoading(itemKey);
    setQuickBooksSearchErrors((current) => ({ ...current, [itemKey]: "" }));
    setQuickBooksSearchCompleted((current) => ({ ...current, [itemKey]: false }));
    try {
      const response = await api.integrations.quickbooks.searchItemMappings(query);
      if (!quickBooksLookupIsCurrent(operationSource, generation)) return;
      setQuickBooksItemCandidates((current) => ({ ...current, [itemKey]: response.candidates ?? [] }));
      setQuickBooksSearchCompleted((current) => ({ ...current, [itemKey]: true }));
    } catch (err) {
      if (!quickBooksLookupIsCurrent(operationSource, generation)) return;
      setQuickBooksItemCandidates((current) => ({ ...current, [itemKey]: [] }));
      setQuickBooksSearchErrors((current) => ({
        ...current,
        [itemKey]: localizedApiError(err, t, { fallbackKey: "invoices.quickBooks.searchError" }),
      }));
    } finally {
      if (quickBooksLookupIsCurrent(operationSource, generation)) setQuickBooksSearchLoading(null);
    }
  };

  const handleQuickBooksCustomerMappingReview = async () => {
    const providerCustomerId = quickBooksCustomerId.trim();
    if (!invoice || !providerCustomerId || quickBooksMappingSaving) {
      if (!providerCustomerId) setQuickBooksError(t("invoices.quickBooks.customerIdRequired"));
      return;
    }
    const operationSource = sourceKey;
    const requestedInvoice = invoice;
    const generation = ++quickBooksMappingMutationGenerationRef.current;
    setQuickBooksMappingSaving("customer");
    setQuickBooksError(null);
    try {
      await api.integrations.quickbooks.reviewInvoiceCustomerMapping({
        customerId: requestedInvoice.customerId,
        quickBooksCustomerId: providerCustomerId,
      });
      if (!quickBooksMappingMutationIsCurrent(
        operationSource,
        generation,
        requestedInvoice.id,
        requestedInvoice.version,
      )) return;
      await loadQuickBooksPreview(requestedInvoice, { clearError: false, reviewOptions: quickBooksReviewOptions });
    } catch (err) {
      if (!quickBooksMappingMutationIsCurrent(
        operationSource,
        generation,
        requestedInvoice.id,
        requestedInvoice.version,
      )) return;
      setQuickBooksError(localizedApiError(err, t, { fallbackKey: "invoices.quickBooks.mappingReviewError" }));
    } finally {
      if (quickBooksMappingMutationIsCurrent(
        operationSource,
        generation,
        requestedInvoice.id,
      )) setQuickBooksMappingSaving(null);
    }
  };

  const handleQuickBooksItemMappingReview = async (line: QuickBooksInvoiceSyncPreview["lineItems"][number]) => {
    const itemKey = line.itemKey ?? line.description;
    const providerItemId = quickBooksItemIds[itemKey]?.trim();
    if (!invoice || !providerItemId || quickBooksMappingSaving) {
      if (!providerItemId) setQuickBooksError(t("invoices.quickBooks.itemIdRequired"));
      return;
    }
    const operationSource = sourceKey;
    const requestedInvoice = invoice;
    const generation = ++quickBooksMappingMutationGenerationRef.current;
    setQuickBooksMappingSaving(itemKey);
    setQuickBooksError(null);
    try {
      await api.integrations.quickbooks.reviewInvoiceItemMapping({ itemKey, quickBooksItemId: providerItemId });
      if (!quickBooksMappingMutationIsCurrent(
        operationSource,
        generation,
        requestedInvoice.id,
        requestedInvoice.version,
      )) return;
      await loadQuickBooksPreview(requestedInvoice, { clearError: false, reviewOptions: quickBooksReviewOptions });
    } catch (err) {
      if (!quickBooksMappingMutationIsCurrent(
        operationSource,
        generation,
        requestedInvoice.id,
        requestedInvoice.version,
      )) return;
      setQuickBooksError(localizedApiError(err, t, { fallbackKey: "invoices.quickBooks.mappingReviewError" }));
    } finally {
      if (quickBooksMappingMutationIsCurrent(
        operationSource,
        generation,
        requestedInvoice.id,
      )) setQuickBooksMappingSaving(null);
    }
  };

  const handleQuickBooksRefresh = async () => {
    if (!invoice || quickBooksSaving) return;
    const operationSource = sourceKey;
    const generation = ++quickBooksOperationGenerationRef.current;
    setQuickBooksSaving(true);
    setQuickBooksError(null);
    setQuickBooksPaymentLink(null);
    try {
      await api.integrations.quickbooks.refreshQuoteFlyInvoice(invoice.id);
      if (!quickBooksOperationIsCurrent(operationSource, generation)) return;
      await loadInvoice();
    } catch (err) {
      if (quickBooksOperationIsCurrent(operationSource, generation)) {
        setQuickBooksError(localizedApiError(err, t, { fallbackKey: "invoices.quickBooks.refreshError" }));
      }
    } finally {
      if (quickBooksOperationIsCurrent(operationSource, generation)) setQuickBooksSaving(false);
    }
  };

  const handleQuickBooksPaymentLink = async () => {
    if (!invoice || quickBooksPaymentLinkLoading) return;
    const operationSource = sourceKey;
    const requestedInvoiceId = invoice.id;
    const generation = ++quickBooksPaymentLinkGenerationRef.current;
    setQuickBooksPaymentLinkLoading(true);
    setQuickBooksError(null);
    try {
      const response = await api.integrations.quickbooks.invoicePaymentLink(requestedInvoiceId);
      if (
        !quickBooksPaymentLinkIsCurrent(
          operationSource,
          generation,
          requestedInvoiceId,
          response.invoiceId,
        )
      ) return;
      const safeUrl = safeQuickBooksHostedPaymentUrl(response.hostedPaymentUrl);
      if (!safeUrl) {
        setQuickBooksPaymentLink(null);
        setQuickBooksError(t("invoices.quickBooks.paymentLinkUnsafe"));
        return;
      }
      setQuickBooksPaymentLink(safeUrl);
      setInvoice((current) => current?.id === response.invoiceId
        ? { ...current, paymentStatus: response.paymentStatus, balanceDue: response.balanceDue }
        : current);
    } catch (err) {
      if (!quickBooksPaymentLinkIsCurrent(operationSource, generation)) return;
      setQuickBooksPaymentLink(null);
      setQuickBooksError(localizedApiError(err, t, { fallbackKey: "invoices.quickBooks.paymentLinkError" }));
    } finally {
      if (quickBooksPaymentLinkIsCurrent(operationSource, generation)) setQuickBooksPaymentLinkLoading(false);
    }
  };

  const handleQuickBooksReconcile = async () => {
    if (!invoice || quickBooksSaving) return;
    const operationSource = sourceKey;
    const generation = ++quickBooksOperationGenerationRef.current;
    setQuickBooksSaving(true);
    setQuickBooksError(null);
    setNotice(null);
    try {
      const response = await api.integrations.quickbooks.reconcileQuoteFlyInvoice(invoice.id);
      if (!quickBooksOperationIsCurrent(operationSource, generation)) return;
      setQuickBooksPreview((current) => current ? { ...current, operation: response.operation } : current);
      await loadQuickBooksPreview(invoice, { clearError: false, preservePreviewOnError: true });
    } catch (err) {
      if (!quickBooksOperationIsCurrent(operationSource, generation)) return;
      const message = localizedApiError(err, t, { fallbackKey: "invoices.quickBooks.reconcileError" });
      await loadQuickBooksPreview(invoice, { clearError: false });
      if (quickBooksOperationIsCurrent(operationSource, generation)) setQuickBooksError(message);
    } finally {
      if (quickBooksOperationIsCurrent(operationSource, generation)) setQuickBooksSaving(false);
    }
  };

  return (
    <section
      aria-labelledby={headingId}
      data-testid="invoice-panel"
      className="rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)] p-4 shadow-[var(--qf-shadow-sm)] sm:p-5"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("invoices.eyebrow")}</p>
          <h2
            ref={headingRef}
            id={headingId}
            data-testid="invoice-panel-heading"
            tabIndex={-1}
            className="mt-1 flex items-center gap-2 text-base font-semibold text-[var(--qf-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--qf-primary)]"
          >
            <ReceiptText size={18} aria-hidden="true" />
            {invoice ? t("invoices.number", { number: invoice.invoiceNumber }) : t("invoices.title")}
          </h2>
          <p className="mt-1 text-sm text-[var(--qf-text-soft)]">
            {invoice
              ? t("invoices.recordDescription")
              : sourceQuoteId
                ? t("invoices.quoteDescription")
                : t("invoices.jobDescription")}
          </p>
        </div>
        {invoice ? (
          <div className="flex flex-wrap gap-2">
            <Badge tone={invoiceStatusTone(invoice.status)}>{t(`domain.invoiceStatus.${invoice.status}`)}</Badge>
            <Badge tone={paymentStatusTone(invoice.paymentStatus)}>{t(`domain.invoicePaymentStatus.${invoice.paymentStatus}`)}</Badge>
          </div>
        ) : null}
      </div>

      {notice ? (
        <div className="mt-4">
          <Alert tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.message}</Alert>
        </div>
      ) : null}
      {error ? (
        <div className="mt-4">
          <Alert tone="error" onDismiss={() => setError(null)}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span>{error}</span>
              {!invoice ? <Button type="button" variant="outline" className="min-h-11" onClick={() => void loadInvoice()}>{t("invoices.retry")}</Button> : null}
            </div>
          </Alert>
        </div>
      ) : null}

      {loading ? (
        <div className="mt-4"><LoadingState variant="compact" title={t("invoices.loading")} /></div>
      ) : invoice ? (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl bg-[var(--qf-panel-muted)] p-3">
              <p className="text-xs text-[var(--qf-text-muted)]">{t("invoices.customer")}</p>
              <p className="mt-1 break-words text-sm font-semibold text-[var(--qf-text)] [overflow-wrap:anywhere]">{invoice.customer.fullName}</p>
            </div>
            <div className="rounded-xl bg-[var(--qf-panel-muted)] p-3">
              <p className="text-xs text-[var(--qf-text-muted)]">{t("invoices.total")}</p>
              <p className="mt-1 text-sm font-semibold text-[var(--qf-text)]">{money(invoice.totalAmount, locale)}</p>
            </div>
            <div className="rounded-xl bg-[var(--qf-panel-muted)] p-3">
              <p className="text-xs text-[var(--qf-text-muted)]">{t("invoices.balance")}</p>
              <p className="mt-1 text-sm font-semibold text-[var(--qf-text)]">{money(invoice.balanceDue, locale)}</p>
            </div>
            <div className="rounded-xl bg-[var(--qf-panel-muted)] p-3">
              <p className="text-xs text-[var(--qf-text-muted)]">{t("invoices.due")}</p>
              <p className="mt-1 text-sm font-semibold text-[var(--qf-text)]">
                {invoice.dueAtUtc ? formatInvoiceDate(invoice.dueAtUtc, locale, timeZone) : t("invoices.noDueDate")}
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-3 border-t border-[var(--qf-border)] pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs leading-5 text-[var(--qf-text-muted)]">
              {quickBooksPreview?.operation?.status === "SUCCEEDED"
                ? t("invoices.quickBooks.providerBoundary")
                : t("invoices.providerBoundary")}
            </p>
            <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
              {!jobId ? (
                <Button type="button" variant="outline" className="min-h-11" onClick={() => navigate(`/app/jobs/${invoice.job.id}`)}>
                  <ExternalLink size={15} aria-hidden="true" />
                  {t("invoices.openJob", { number: invoice.job.jobNumber })}
                </Button>
              ) : null}
              {!sourceQuoteId ? (
                <Button type="button" variant="outline" className="min-h-11" onClick={() => navigate(`/app/quotes/${invoice.sourceQuote.id}`)}>
                  <ExternalLink size={15} aria-hidden="true" />
                  {t("invoices.openQuote")}
                </Button>
              ) : null}
            </div>
          </div>
          {canCreate ? (
            <div className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-4" data-testid="quickbooks-invoice-panel">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="flex items-center gap-2 text-sm font-semibold text-[var(--qf-text)]">
                    <FileCheck2 size={17} aria-hidden="true" />
                    {t("invoices.quickBooks.title")}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-[var(--qf-text-muted)]">
                    {t("invoices.quickBooks.description")}
                  </p>
                </div>
                {quickBooksPreview?.operation ? (
                  <Badge tone={quickBooksStatusTone(quickBooksPreview.operation.status)}>
                    {t(`invoices.quickBooks.status.${quickBooksPreview.operation.status}`)}
                  </Badge>
                ) : null}
              </div>

              {quickBooksError ? (
                <div className="mt-3">
                  <Alert tone="error" onDismiss={() => setQuickBooksError(null)}>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <span>{quickBooksError}</span>
                      <Button type="button" variant="outline" className="min-h-11" onClick={() => invoice && void loadQuickBooksPreview(invoice)}>
                        {t("invoices.retry")}
                      </Button>
                    </div>
                  </Alert>
                </div>
              ) : null}

              {quickBooksLoading ? (
                <div className="mt-3"><LoadingState variant="compact" title={t("invoices.quickBooks.loading")} /></div>
              ) : quickBooksPreview ? (
                <div className="mt-3 space-y-3">
                  {!quickBooksEnabled ? <Alert tone="info">{t("invoices.quickBooks.paused")}</Alert> : null}
                  {!quickBooksPreview.operation && quickBooksPreview.connection ? (
                    <div className="space-y-4 rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] p-3 sm:p-4" data-testid="quickbooks-review-controls">
                      <div>
                        <p className="text-sm font-semibold text-[var(--qf-text)]">{t("invoices.quickBooks.reviewSetupTitle")}</p>
                        <p className="mt-1 text-xs leading-5 text-[var(--qf-text-muted)]">{t("invoices.quickBooks.reviewSetupDescription")}</p>
                      </div>

                      <div className="space-y-2 border-t border-[var(--qf-border)] pt-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-xs font-semibold text-[var(--qf-text-soft)]">{t("invoices.quickBooks.customerMapping")}</p>
                          <Badge tone={quickBooksPreview.customerMapping?.reviewedAtUtc ? "emerald" : "amber"}>
                            {quickBooksPreview.customerMapping?.reviewedAtUtc
                              ? t("invoices.quickBooks.reviewed")
                              : t("invoices.quickBooks.needsReview")}
                          </Badge>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                          <Input
                            label={t("invoices.quickBooks.searchCustomers")}
                            value={quickBooksCustomerSearch}
                            autoComplete="off"
                            onChange={(event) => {
                              setQuickBooksCustomerSearch(event.target.value);
                              setQuickBooksSearchCompleted((current) => ({ ...current, customer: false }));
                              setQuickBooksSearchErrors((current) => ({ ...current, customer: "" }));
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                void handleQuickBooksCustomerSearch();
                              }
                            }}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11"
                            loading={quickBooksSearchLoading === "customer"}
                            disabled={quickBooksCustomerSearch.trim().length < 2 || Boolean(quickBooksSearchLoading) || !quickBooksEnabled}
                            onClick={() => void handleQuickBooksCustomerSearch()}
                          >
                            {t("invoices.quickBooks.search")}
                          </Button>
                        </div>
                        <p className="sr-only" aria-live="polite">
                          {quickBooksSearchLoading === "customer"
                            ? t("invoices.quickBooks.searching")
                            : quickBooksSearchErrors.customer
                              ? quickBooksSearchErrors.customer
                              : quickBooksSearchCompleted.customer
                                ? quickBooksCustomerCandidates.length
                                  ? `${t("invoices.quickBooks.customerResults")}: ${quickBooksCustomerCandidates.length}`
                                  : t("invoices.quickBooks.noCustomerMatches")
                                : ""}
                        </p>
                        {quickBooksSearchErrors.customer ? <p role="alert" className="text-xs text-[var(--qf-danger-text)]">{quickBooksSearchErrors.customer}</p> : null}
                        {quickBooksSearchCompleted.customer && !quickBooksCustomerCandidates.length ? (
                          <p className="rounded-lg bg-[var(--qf-panel-muted)] px-3 py-2 text-xs text-[var(--qf-text-muted)]">{t("invoices.quickBooks.noCustomerMatches")}</p>
                        ) : null}
                        {quickBooksCustomerCandidates.length ? (
                          <ul aria-label={t("invoices.quickBooks.customerResults")} className="max-h-52 space-y-1 overflow-y-auto rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-1">
                            {quickBooksCustomerCandidates.map((candidate) => {
                              const selected = candidate.quickBooksCustomerId === quickBooksCustomerId;
                              return (
                                <li key={candidate.quickBooksCustomerId}>
                                  <button
                                    type="button"
                                    aria-pressed={selected}
                                    onClick={() => {
                                      setQuickBooksCustomerId(candidate.quickBooksCustomerId);
                                      setQuickBooksReviewDirty(true);
                                      setQuickBooksError(null);
                                    }}
                                    className={`flex min-h-11 w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] ${selected ? "border-[var(--qf-info-border)] bg-[var(--qf-selected)]" : "border-transparent bg-[var(--qf-panel)] hover:border-[var(--qf-border-strong)]"}`}
                                  >
                                    <span className="min-w-0">
                                      <span className="block truncate font-semibold text-[var(--qf-text)]">{candidate.displayName}</span>
                                      {candidate.email ? <span className="block truncate text-xs text-[var(--qf-text-muted)]">{candidate.email}</span> : null}
                                    </span>
                                    <span className="shrink-0 text-xs text-[var(--qf-text-muted)]">{selected ? t("invoices.quickBooks.selected") : t("invoices.quickBooks.select")}</span>
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        ) : null}
                        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                          <details className="rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel-muted)]">
                            <summary className="flex min-h-11 cursor-pointer items-center px-3 text-xs font-semibold text-[var(--qf-text-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]">
                              {t("invoices.quickBooks.rawIdFallback")}
                            </summary>
                            <div className="border-t border-[var(--qf-border)] p-3">
                              <Input
                                label={t("invoices.quickBooks.customerProviderId")}
                                value={quickBooksCustomerId}
                                autoComplete="off"
                                onChange={(event) => {
                                  setQuickBooksCustomerId(event.target.value);
                                  setQuickBooksReviewDirty(true);
                                  setQuickBooksError(null);
                                }}
                              />
                            </div>
                          </details>
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11"
                            loading={quickBooksMappingSaving === "customer"}
                            disabled={!quickBooksCustomerId.trim() || Boolean(quickBooksMappingSaving) || !quickBooksEnabled}
                            onClick={() => void handleQuickBooksCustomerMappingReview()}
                          >
                            {t("invoices.quickBooks.reviewMapping")}
                          </Button>
                        </div>
                        {quickBooksPreview.customerMapping?.quickBooksDisplayName ? (
                          <p className="text-xs text-[var(--qf-text-muted)]">{t("invoices.quickBooks.mapsTo", { target: quickBooksPreview.customerMapping.quickBooksDisplayName })}</p>
                        ) : null}
                      </div>

                      <div className="space-y-3 border-t border-[var(--qf-border)] pt-3">
                        <p className="text-xs font-semibold text-[var(--qf-text-soft)]">{t("invoices.quickBooks.itemMappings")}</p>
                        {quickBooksPreview.lineItems.map((line, index) => {
                          const itemKey = line.itemKey ?? line.description;
                          return (
                            <details key={`${itemKey}:${index}`} open={!line.reviewedAtUtc} className="group rounded-lg bg-[var(--qf-panel-muted)]">
                              <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-2 rounded-lg p-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] [&::-webkit-details-marker]:hidden">
                                <span className="min-w-0 flex-1 break-words text-xs font-medium text-[var(--qf-text)] [overflow-wrap:anywhere]">{line.description}</span>
                                <Badge tone={line.reviewedAtUtc ? "emerald" : "amber"}>
                                  {line.reviewedAtUtc ? t("invoices.quickBooks.reviewed") : t("invoices.quickBooks.needsReview")}
                                </Badge>
                              </summary>
                              <div className="border-t border-[var(--qf-border)] px-3 pb-3">
                              <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                                <Input
                                  label={t("invoices.quickBooks.searchItems")}
                                  value={quickBooksItemSearches[itemKey] ?? ""}
                                  autoComplete="off"
                                  onChange={(event) => {
                                    setQuickBooksItemSearches((current) => ({ ...current, [itemKey]: event.target.value }));
                                    setQuickBooksSearchCompleted((current) => ({ ...current, [itemKey]: false }));
                                    setQuickBooksSearchErrors((current) => ({ ...current, [itemKey]: "" }));
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                      event.preventDefault();
                                      void handleQuickBooksItemSearch(itemKey);
                                    }
                                  }}
                                />
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="min-h-11"
                                  aria-label={t("invoices.quickBooks.searchItemsFor", { description: line.description })}
                                  loading={quickBooksSearchLoading === itemKey}
                                  disabled={(quickBooksItemSearches[itemKey]?.trim().length ?? 0) < 2 || Boolean(quickBooksSearchLoading) || !quickBooksEnabled}
                                  onClick={() => void handleQuickBooksItemSearch(itemKey)}
                                >
                                  {t("invoices.quickBooks.search")}
                                </Button>
                              </div>
                              <p className="sr-only" aria-live="polite">
                                {quickBooksSearchLoading === itemKey
                                  ? t("invoices.quickBooks.searching")
                                  : quickBooksSearchErrors[itemKey]
                                    ? quickBooksSearchErrors[itemKey]
                                    : quickBooksSearchCompleted[itemKey]
                                      ? quickBooksItemCandidates[itemKey]?.length
                                        ? `${t("invoices.quickBooks.itemResults", { description: line.description })}: ${quickBooksItemCandidates[itemKey].length}`
                                        : t("invoices.quickBooks.noItemMatches")
                                      : ""}
                              </p>
                              {quickBooksSearchErrors[itemKey] ? <p role="alert" className="mt-2 text-xs text-[var(--qf-danger-text)]">{quickBooksSearchErrors[itemKey]}</p> : null}
                              {quickBooksSearchCompleted[itemKey] && !(quickBooksItemCandidates[itemKey]?.length) ? (
                                <p className="mt-2 rounded-lg bg-[var(--qf-panel)] px-3 py-2 text-xs text-[var(--qf-text-muted)]">{t("invoices.quickBooks.noItemMatches")}</p>
                              ) : null}
                              {quickBooksItemCandidates[itemKey]?.length ? (
                                <ul aria-label={t("invoices.quickBooks.itemResults", { description: line.description })} className="mt-2 max-h-52 space-y-1 overflow-y-auto rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel)] p-1">
                                  {quickBooksItemCandidates[itemKey].map((candidate) => {
                                    const selected = candidate.quickBooksItemId === quickBooksItemIds[itemKey];
                                    return (
                                      <li key={candidate.quickBooksItemId}>
                                        <button
                                          type="button"
                                          aria-pressed={selected}
                                          onClick={() => {
                                            setQuickBooksItemIds((current) => ({ ...current, [itemKey]: candidate.quickBooksItemId }));
                                            setQuickBooksReviewDirty(true);
                                            setQuickBooksError(null);
                                          }}
                                          className={`flex min-h-11 w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] ${selected ? "border-[var(--qf-info-border)] bg-[var(--qf-selected)]" : "border-transparent bg-[var(--qf-panel-muted)] hover:border-[var(--qf-border-strong)]"}`}
                                        >
                                          <span className="min-w-0">
                                            <span className="block truncate font-semibold text-[var(--qf-text)]">{candidate.name}</span>
                                            {candidate.type ? <span className="block truncate text-xs text-[var(--qf-text-muted)]">{candidate.type}</span> : null}
                                          </span>
                                          <span className="shrink-0 text-xs text-[var(--qf-text-muted)]">{selected ? t("invoices.quickBooks.selected") : t("invoices.quickBooks.select")}</span>
                                        </button>
                                      </li>
                                    );
                                  })}
                                </ul>
                              ) : null}
                              <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                                <details className="rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel)]">
                                  <summary className="flex min-h-11 cursor-pointer items-center px-3 text-xs font-semibold text-[var(--qf-text-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]">
                                    {t("invoices.quickBooks.rawIdFallback")}
                                  </summary>
                                  <div className="border-t border-[var(--qf-border)] p-3">
                                    <Input
                                      label={t("invoices.quickBooks.itemProviderId")}
                                      value={quickBooksItemIds[itemKey] ?? ""}
                                      autoComplete="off"
                                      onChange={(event) => {
                                        setQuickBooksItemIds((current) => ({ ...current, [itemKey]: event.target.value }));
                                        setQuickBooksReviewDirty(true);
                                        setQuickBooksError(null);
                                      }}
                                    />
                                  </div>
                                </details>
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="min-h-11"
                                  aria-label={t("invoices.quickBooks.reviewItemMapping", { description: line.description })}
                                  loading={quickBooksMappingSaving === itemKey}
                                  disabled={!quickBooksItemIds[itemKey]?.trim() || Boolean(quickBooksMappingSaving) || !quickBooksEnabled}
                                  onClick={() => void handleQuickBooksItemMappingReview(line)}
                                >
                                  {t("invoices.quickBooks.reviewMapping")}
                                </Button>
                              </div>
                              {line.quickBooksItemName ? (
                                <p className="mt-2 text-xs text-[var(--qf-text-muted)]">{t("invoices.quickBooks.mapsTo", { target: line.quickBooksItemName })}</p>
                              ) : null}
                              </div>
                            </details>
                          );
                        })}
                      </div>

                      <fieldset className="space-y-3 border-t border-[var(--qf-border)] pt-3">
                        <legend className="text-xs font-semibold text-[var(--qf-text-soft)]">{t("invoices.quickBooks.paymentChoices")}</legend>
                        <Input
                          type="email"
                          inputMode="email"
                          label={t("invoices.quickBooks.billingEmail")}
                          value={quickBooksBillingEmail}
                          error={quickBooksBillingEmailInvalid ? t("invoices.quickBooks.invalidBillingEmail") : undefined}
                          autoComplete="email"
                          onChange={(event) => {
                            setQuickBooksBillingEmail(event.target.value);
                            setQuickBooksReviewDirty(true);
                            setQuickBooksPaymentLink(null);
                            setQuickBooksError(null);
                          }}
                        />
                        <div className="grid gap-2 sm:grid-cols-2">
                          <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-3 py-2 text-sm font-medium text-[var(--qf-text-soft)] focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--qf-focus)]">
                            <input
                              type="checkbox"
                              className="h-5 w-5 accent-[var(--qf-action-primary)]"
                              checked={quickBooksAllowAch}
                              onChange={(event) => {
                                setQuickBooksAllowAch(event.target.checked);
                                setQuickBooksReviewDirty(true);
                                setQuickBooksPaymentLink(null);
                              }}
                            />
                            {t("invoices.quickBooks.allowAch")}
                          </label>
                          <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-3 py-2 text-sm font-medium text-[var(--qf-text-soft)] focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--qf-focus)]">
                            <input
                              type="checkbox"
                              className="h-5 w-5 accent-[var(--qf-action-primary)]"
                              checked={quickBooksAllowCard}
                              onChange={(event) => {
                                setQuickBooksAllowCard(event.target.checked);
                                setQuickBooksReviewDirty(true);
                                setQuickBooksPaymentLink(null);
                              }}
                            />
                            {t("invoices.quickBooks.allowCard")}
                          </label>
                        </div>
                        <p className="text-xs leading-5 text-[var(--qf-text-muted)]">{t("invoices.quickBooks.paymentChoicesHelp")}</p>
                        <div className="grid gap-2 sm:flex sm:flex-wrap">
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11"
                            disabled={!quickBooksReviewDirty || quickBooksBillingEmailInvalid || !quickBooksEnabled}
                            loading={quickBooksLoading}
                            onClick={() => void handleQuickBooksReviewOptions()}
                          >
                            {t("invoices.quickBooks.reviewPaymentChoices")}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            className="min-h-11"
                            disabled={!quickBooksReviewDirty}
                            onClick={() => invoice && void loadQuickBooksPreview(invoice)}
                          >
                            {t("invoices.quickBooks.resetReviewChanges")}
                          </Button>
                        </div>
                      </fieldset>
                      {quickBooksReviewDirty ? <Alert tone="warning">{t("invoices.quickBooks.unsavedReviewChanges")}</Alert> : null}
                    </div>
                  ) : null}
                  {quickBooksPreview.operation?.status === "SUCCEEDED" ? (
                    <Alert tone="success">{t("invoices.quickBooks.success", { number: quickBooksPreview.providerDocNumber })}</Alert>
                  ) : quickBooksPreview.operation?.status === "RECONCILIATION_REQUIRED" ? (
                    <Alert tone="warning">{t("invoices.quickBooks.reconciliationRequired")}</Alert>
                  ) : quickBooksPreview.operation?.status === "FAILED" ? (
                    <Alert tone="error">{t("invoices.quickBooks.failed")}</Alert>
                  ) : quickBooksPreview.operation ? (
                    <Alert tone="info">{t("invoices.quickBooks.inProgress")}</Alert>
                  ) : quickBooksPreview.blockers.length ? (
                    <div>
                      <p className="text-xs font-semibold text-[var(--qf-text-soft)]">{t("invoices.quickBooks.setupNeeded")}</p>
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-[var(--qf-text-muted)]">
                        {quickBooksPreview.blockers.map((blocker) => (
                          <li key={blocker}>{t(`invoices.quickBooks.blockers.${blocker}`)}</li>
                        ))}
                      </ul>
                      <Button type="button" variant="outline" className="mt-3 min-h-11" onClick={() => navigate("/app/settings")}>
                        {t("invoices.quickBooks.openSettings")}
                      </Button>
                    </div>
                  ) : (
                    <p className="text-xs text-[var(--qf-text-muted)]">
                      {t("invoices.quickBooks.ready", {
                        company: quickBooksPreview.connection?.companyName || t("invoices.quickBooks.connectedCompany"),
                        number: quickBooksPreview.providerDocNumber,
                      })}
                    </p>
                  )}

                  {quickBooksEnabled && quickBooksPreview.operation?.status === "SUCCEEDED" ? (
                    <div className="grid gap-2 sm:flex sm:flex-wrap">
                      <Button type="button" variant="outline" className="min-h-11" loading={quickBooksSaving} onClick={() => void handleQuickBooksRefresh()}>
                        <RefreshCw size={16} aria-hidden="true" />
                        {t("invoices.quickBooks.refreshInvoice")}
                      </Button>
                      {quickBooksPreview.operation.paymentLinkAvailable
                      || quickBooksPreview.operation.paymentMethods?.ach
                      || quickBooksPreview.operation.paymentMethods?.card ? quickBooksPaymentLink ? (
                        <a
                          href={quickBooksPaymentLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--qf-action-primary)] bg-[var(--qf-action-primary)] px-4 py-2 text-sm font-semibold text-[var(--qf-action-primary-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]"
                        >
                          <ExternalLink size={16} aria-hidden="true" />
                          {t("invoices.quickBooks.openPaymentPage")}
                        </a>
                      ) : (
                        <Button type="button" className="min-h-11" loading={quickBooksPaymentLinkLoading} onClick={() => void handleQuickBooksPaymentLink()}>
                          <ExternalLink size={16} aria-hidden="true" />
                          {t("invoices.quickBooks.loadPaymentPage")}
                        </Button>
                      ) : null}
                    </div>
                  ) : quickBooksEnabled && quickBooksPreview.operation?.reconciliationAvailable ? (
                    <Button type="button" variant="outline" className="min-h-11" loading={quickBooksSaving} onClick={() => void handleQuickBooksReconcile()}>
                      <RefreshCw size={16} aria-hidden="true" />
                      {t("invoices.quickBooks.reconcile")}
                    </Button>
                  ) : quickBooksEnabled && quickBooksPreview.ready && quickBooksPreviewMatchesInvoice && !quickBooksPreview.operation && !quickBooksReviewDirty && !quickBooksBillingEmailInvalid ? (
                    <Button type="button" variant="outline" className="min-h-11" onClick={() => setQuickBooksConfirmOpen(true)}>
                      <FileCheck2 size={16} aria-hidden="true" />
                      {t("invoices.quickBooks.review")}
                    </Button>
                  ) : quickBooksPreview.operation?.status === "PROCESSING" || quickBooksPreview.operation?.status === "RECONCILING" ? (
                    <Button type="button" variant="outline" className="min-h-11" onClick={() => void loadQuickBooksPreview(invoice)}>
                      <RefreshCw size={16} aria-hidden="true" />
                      {t("invoices.quickBooks.refreshStatus")}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-dashed border-[var(--qf-border-strong)] bg-[var(--qf-panel-muted)] p-4">
          {canCreate && createBlockedReason ? (
            <Alert tone="warning">{createBlockedReason}</Alert>
          ) : canCreate ? (
            <div className="grid gap-4 lg:grid-cols-[minmax(200px,.4fr)_minmax(0,1fr)_auto] lg:items-end">
              <Input
                type="date"
                label={t("invoices.dueDate")}
                value={dueDate}
                min={toTenantDateTimeInput(new Date(), timeZone).slice(0, 10)}
                onChange={(event) => {
                  setDueDate(event.target.value);
                  setError(null);
                }}
              />
              <p className="text-sm leading-6 text-[var(--qf-text-soft)]">{t("invoices.createHelp")}</p>
              <Button type="button" className="min-h-11" disabled={!dueAtUtc} onClick={() => setConfirmOpen(true)}>
                <ReceiptText size={16} aria-hidden="true" />
                {t("invoices.create")}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-[var(--qf-text-soft)]">{t("invoices.waiting")}</p>
          )}
        </div>
      )}

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void handleCreate()}
        title={t("invoices.confirmTitle")}
        description={t("invoices.confirmDescription", {
          source: sourceLabel,
          amount: money(sourceAmount, locale),
        })}
        confirmLabel={t("invoices.confirmCreate")}
        confirmVariant="primary"
        loading={saving}
      >
        <div className="rounded-xl bg-[var(--qf-panel-muted)] p-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2 text-[var(--qf-text-muted)]">
              <CalendarDays size={15} aria-hidden="true" />
              {t("invoices.due")}
            </span>
            <span className="font-semibold text-[var(--qf-text)]">
              {dueAtUtc ? formatInvoiceDate(dueAtUtc, locale, timeZone) : t("invoices.noDueDate")}
            </span>
          </div>
        </div>
      </ConfirmModal>

      <ConfirmModal
        open={quickBooksConfirmOpen}
        onClose={() => setQuickBooksConfirmOpen(false)}
        onConfirm={() => void handleQuickBooksPublish()}
        title={t("invoices.quickBooks.confirmTitle")}
        description={t("invoices.quickBooks.confirmDescription")}
        confirmLabel={t("invoices.quickBooks.publish")}
        confirmVariant="primary"
        loading={quickBooksSaving}
        size="md"
      >
        {quickBooksPreview ? (
          <div className="space-y-3 rounded-xl bg-[var(--qf-panel-muted)] p-3 text-sm">
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-start gap-3">
              <span className="text-[var(--qf-text-muted)]">{t("invoices.quickBooks.destination")}</span>
              <span className="break-words text-right font-semibold text-[var(--qf-text)] [overflow-wrap:anywhere]">
                {quickBooksPreview.connection?.companyName || t("invoices.quickBooks.connectedCompany")}
              </span>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-start gap-3">
              <span className="text-[var(--qf-text-muted)]">{t("invoices.customer")}</span>
              <span className="min-w-0 break-words text-right font-semibold text-[var(--qf-text)] [overflow-wrap:anywhere]">
                {quickBooksPreview.invoice.customerName}
                {quickBooksPreview.quickBooksCustomerName ? (
                  <small className="mt-1 block font-normal text-[var(--qf-text-muted)]">
                    {t("invoices.quickBooks.mapsTo", { target: quickBooksPreview.quickBooksCustomerName })}
                  </small>
                ) : null}
              </span>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
              <span className="text-[var(--qf-text-muted)]">{t("invoices.quickBooks.documentNumber")}</span>
              <span className="font-semibold text-[var(--qf-text)]">{quickBooksPreview.providerDocNumber}</span>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-start gap-3">
              <span className="text-[var(--qf-text-muted)]">{t("invoices.quickBooks.billingEmail")}</span>
              <span className="break-words text-right font-semibold text-[var(--qf-text)] [overflow-wrap:anywhere]">
                {quickBooksPreview.billingEmail || t("invoices.quickBooks.noOnlinePayment")}
              </span>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-start gap-3">
              <span className="text-[var(--qf-text-muted)]">{t("invoices.quickBooks.paymentMethods")}</span>
              <span className="text-right font-semibold text-[var(--qf-text)]">
                {[
                  quickBooksPreview.paymentMethods?.ach ? "ACH" : null,
                  quickBooksPreview.paymentMethods?.card ? t("invoices.quickBooks.allowCard") : null,
                ].filter(Boolean).join(" + ") || t("invoices.quickBooks.noOnlinePayment")}
              </span>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
              <span className="text-[var(--qf-text-muted)]">{t("invoices.due")}</span>
              <span className="font-semibold text-[var(--qf-text)]">
                {quickBooksPreview.invoice.dueAtUtc
                  ? formatInvoiceDate(quickBooksPreview.invoice.dueAtUtc, locale, timeZone)
                  : t("invoices.noDueDate")}
              </span>
            </div>
            <div className="space-y-2 border-t border-[var(--qf-border)] pt-3">
              {quickBooksPreview.lineItems.map((line, index) => (
                <div key={`${line.description}:${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                  <span className="min-w-0 break-words text-[var(--qf-text-soft)] [overflow-wrap:anywhere]">
                    {line.description}
                    {line.quickBooksItemName ? (
                      <small className="mt-1 block text-[var(--qf-text-muted)]">
                        {t("invoices.quickBooks.mapsTo", { target: line.quickBooksItemName })}
                      </small>
                    ) : null}
                    <small className="mt-1 block text-[var(--qf-text-muted)]">
                      {t("invoices.quickBooks.lineMath", {
                        quantity: line.quantity,
                        unitPrice: money(line.unitPrice, locale),
                      })}
                    </small>
                  </span>
                  <span className="shrink-0 font-medium text-[var(--qf-text)]">{money(line.amount, locale)}</span>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-[var(--qf-border)] pt-3">
              <span className="font-semibold text-[var(--qf-text)]">{t("invoices.total")}</span>
              <span className="font-semibold text-[var(--qf-text)]">{money(quickBooksPreview.invoice.totalAmount, locale)}</span>
            </div>
          </div>
        ) : null}
      </ConfirmModal>
    </section>
  );
}
