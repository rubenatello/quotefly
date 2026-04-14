import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { CheckIcon, ClockIcon, CustomerIcon, DeleteIcon, InvoiceIcon, QuoteIcon, SendIcon } from "../components/Icons";
import { AppLoadingScreen } from "../components/AppLoadingScreen";
import {
  FeatureLockedCard,
  HistoryEventPill,
  MobileSectionSwitcher,
  OutboundChannelPill,
  PipelineColumn,
  PipelineFlow,
  QuoteMathSummaryPanel,
  QuoteStatusPill,
  StatCard,
  type DashboardMobileSection,
  type LeadCardItem,
  type QuoteMathSummary,
} from "../components/dashboard/DashboardUi";
import { ConfirmModal, Modal, ModalBody, ModalFooter, ModalHeader } from "../components/ui";
import {
  api,
  ApiError,
  type ChatToQuoteParsed,
  type Customer,
  type CustomerDuplicateMatch,
  type LeadFollowUpStatus,
  type QuoteOutboundChannel,
  type QuoteOutboundEvent,
  type Quote,
  type QuoteRevision,
  type QuoteStatus,
  type ServiceType,
  type TenantEntitlements,
} from "../lib/api";
import { formatAiUsageNotice } from "../lib/ai-credits";
import { setSEOMetadata } from "../lib/seo";
import { formatUsPhoneDisplay, formatUsPhoneInput, toPhoneHrefValue } from "../lib/phone";

interface DashboardPageProps {
  session?: {
    email: string;
    fullName: string;
    tenantId: string;
    primaryTrade?: ServiceType | null;
    onboardingCompletedAtUtc?: string | null;
    effectivePlanName?: string;
    effectivePlanCode?: "starter" | "professional" | "enterprise";
    isTrial?: boolean;
    entitlements?: TenantEntitlements;
  } | null;
  onLogout?: () => void;
}

type CustomerForm = { fullName: string; phone: string; email: string };
type QuoteForm = {
  customerId: string;
  serviceType: ServiceType;
  title: string;
  scopeText: string;
  internalCostSubtotal: string;
  customerPriceSubtotal: string;
  taxAmount: string;
};
type QuoteEditForm = { serviceType: ServiceType; status: QuoteStatus; title: string; scopeText: string; taxAmount: string };
type LineItemForm = { description: string; quantity: string; unitCost: string; unitPrice: string };
type HistoryMode = "quote" | "customer" | "all";
type SendChannel = "email" | "sms" | "copy";
type CreateCustomerPayload = { fullName: string; phone: string; email: string | null };
type DuplicateCustomerModalState = {
  payload: CreateCustomerPayload;
  matches: CustomerDuplicateMatch[];
  selectedMatchId: string;
};
type SendComposerState = {
  channel: SendChannel;
  quoteId: string;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string;
  subject: string;
  body: string;
};

const SERVICE_TYPES: ServiceType[] = ["HVAC", "PLUMBING", "FLOORING", "ROOFING", "GARDENING", "CONSTRUCTION"];
const QUOTE_STATUSES: QuoteStatus[] = ["DRAFT", "READY_FOR_REVIEW", "SENT_TO_CUSTOMER", "ACCEPTED", "REJECTED"];

const EMPTY_CUSTOMER: CustomerForm = { fullName: "", phone: "", email: "" };
const EMPTY_QUOTE: QuoteForm = {
  customerId: "",
  serviceType: "HVAC",
  title: "",
  scopeText: "",
  internalCostSubtotal: "0",
  customerPriceSubtotal: "0",
  taxAmount: "0",
};
const EMPTY_EDIT: QuoteEditForm = { serviceType: "HVAC", status: "DRAFT", title: "", scopeText: "", taxAmount: "0" };
const EMPTY_LINE_ITEM: LineItemForm = { description: "", quantity: "1", unitCost: "0", unitPrice: "0" };
const CHAT_PROMPT_EXAMPLE =
  "New quote for Alan Johnson 818-233-4333. He has a roof that is about 1,250 square feet and wants to replace his roof-shingles. We will remove old and aged roofing and check for any damage underneath and apply new layer as needed. Whole job should cost about 8,500 using standard asphalt shingles.";

const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function money(value: string | number): string {
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) ? USD_FORMATTER.format(amount) : "$0.00";
}

function safeAmount(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function summarizeQuoteMath(input: {
  internalCostSubtotal: string | number;
  customerPriceSubtotal: string | number;
  taxAmount: string | number;
}): QuoteMathSummary {
  const internalSubtotal = safeAmount(input.internalCostSubtotal);
  const customerSubtotal = safeAmount(input.customerPriceSubtotal);
  const taxAmount = safeAmount(input.taxAmount);
  const totalAmount = customerSubtotal + taxAmount;
  const estimatedProfit = customerSubtotal - internalSubtotal;
  const estimatedMarginPercent =
    customerSubtotal > 0 ? Number(((estimatedProfit / customerSubtotal) * 100).toFixed(1)) : 0;

  return {
    internalSubtotal,
    customerSubtotal,
    taxAmount,
    totalAmount,
    estimatedProfit,
    estimatedMarginPercent,
  };
}

function fileLabel(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "quote"
  );
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
}

function followUpLabel(status: LeadFollowUpStatus): string {
  if (status === "NEEDS_FOLLOW_UP") return "Needs Follow Up";
  if (status === "FOLLOWED_UP") return "Followed Up";
  if (status === "WON") return "Won";
  return "Lost";
}

function effectiveFollowUpStatus(customer: Customer, latestQuote?: Quote): LeadFollowUpStatus {
  if (latestQuote?.status === "ACCEPTED") return "WON";
  if (latestQuote?.status === "REJECTED") return "LOST";
  return customer.followUpStatus;
}

function normalizeCustomerPayload(form: CustomerForm): CreateCustomerPayload {
  return {
    fullName: form.fullName.trim(),
    phone: formatUsPhoneDisplay(form.phone) || form.phone.trim(),
    email: form.email.trim() ? form.email.trim().toLowerCase() : null,
  };
}

function duplicateReasonLabel(reason: "phone" | "email"): string {
  return reason === "phone" ? "Phone match" : "Email match";
}

function buildQuoteMessageDraft(quote: Quote, customerName: string): { subject: string; body: string } {
  const subject = `${quote.title} - Quote`;
  const body = [
    `Hi ${customerName},`,
    "",
    "Thanks for the opportunity to quote this project.",
    "",
    `Quote: ${quote.title}`,
    `Total: ${money(quote.totalAmount)}`,
    "",
    "Scope:",
    quote.scopeText,
    "",
    "Reply to confirm or ask for any revisions.",
  ].join("\n");

  return { subject, body };
}

function mapSendChannelToOutboundChannel(channel: SendChannel): QuoteOutboundChannel {
  if (channel === "email") return "EMAIL_APP";
  if (channel === "sms") return "SMS_APP";
  return "COPY";
}

export function DashboardPage({ session }: DashboardPageProps) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [selectedQuoteId, setSelectedQuoteId] = useState<string | null>(null);
  const [selectedQuote, setSelectedQuote] = useState<Quote | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<QuoteStatus | "ALL">("ALL");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [quoteHistory, setQuoteHistory] = useState<QuoteRevision[]>([]);
  const [outboundEvents, setOutboundEvents] = useState<QuoteOutboundEvent[]>([]);
  const [outboundEventsLoading, setOutboundEventsLoading] = useState(false);
  const [historyMode, setHistoryMode] = useState<HistoryMode>("quote");
  const [historyCustomerId, setHistoryCustomerId] = useState<string>("ALL");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [mobileSection, setMobileSection] = useState<DashboardMobileSection>("pipeline");

  const [customerForm, setCustomerForm] = useState<CustomerForm>(EMPTY_CUSTOMER);
  const [quoteForm, setQuoteForm] = useState<QuoteForm>(EMPTY_QUOTE);
  const [quoteEditForm, setQuoteEditForm] = useState<QuoteEditForm>(EMPTY_EDIT);
  const [lineItemForm, setLineItemForm] = useState<LineItemForm>(EMPTY_LINE_ITEM);
  const [duplicateModal, setDuplicateModal] = useState<DuplicateCustomerModalState | null>(null);
  const [sendComposer, setSendComposer] = useState<SendComposerState | null>(null);
  const [lineItemPendingDeleteId, setLineItemPendingDeleteId] = useState<string | null>(null);
  const [chatPrompt, setChatPrompt] = useState("");
  const [chatParsed, setChatParsed] = useState<ChatToQuoteParsed | null>(null);
  const [setupTrade, setSetupTrade] = useState<ServiceType>(session?.primaryTrade ?? "ROOFING");
  const [setupSqFtMode, setSetupSqFtMode] = useState(false);
  const [setupSqFtUnitCost, setSetupSqFtUnitCost] = useState("");
  const [setupSqFtUnitPrice, setSetupSqFtUnitPrice] = useState("");
  const [recommendedPresetCount, setRecommendedPresetCount] = useState(0);
  const canUseChatToQuote = session?.entitlements?.features.aiAutomation ?? true;
  const aiQuoteLimit = session?.entitlements?.limits.aiQuotesPerMonth ?? null;
  const canViewQuoteHistory = session?.entitlements?.features.quoteVersionHistory ?? true;
  const canViewCommunicationLog = session?.entitlements?.features.communicationLog ?? true;
  const currentPlanLabel = session?.effectivePlanName ?? "Starter";
  const canAutoUpgradeMessage = !(session?.isTrial ?? false);

  useEffect(() => {
    setSEOMetadata({
      title: "CRM Dashboard",
      description: "QuoteFly CRM workspace for customer and quote management.",
    });
    void loadAll();
  }, []);

  useEffect(() => {
    let mounted = true;
    api.onboarding
      .getRecommendedPresets(setupTrade)
      .then((result) => {
        if (!mounted) return;
        setRecommendedPresetCount(result.presets.length);
      })
      .catch(() => {
        if (!mounted) return;
        setRecommendedPresetCount(0);
      });

    return () => {
      mounted = false;
    };
  }, [setupTrade]);

  useEffect(() => {
    if (!selectedQuoteId) return;
    void loadQuoteDetail(selectedQuoteId);
  }, [selectedQuoteId, canViewCommunicationLog]);

  useEffect(() => {
    if (!canViewQuoteHistory) {
      setQuoteHistory([]);
      return;
    }
    void loadQuoteHistory();
  }, [canViewQuoteHistory, historyMode, historyCustomerId, selectedQuoteId]);

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [customerRes, quoteRes] = await Promise.all([api.customers.list({ limit: 100 }), api.quotes.list({ limit: 100 })]);
      setCustomers(customerRes.customers);
      setQuotes(quoteRes.quotes);
      setQuoteForm((prev) => ({ ...prev, customerId: prev.customerId || customerRes.customers[0]?.id || "" }));
      setSelectedQuoteId((prev) => prev || quoteRes.quotes[0]?.id || null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed loading dashboard data.");
    } finally {
      setLoading(false);
    }
  }

  async function loadQuotes() {
    try {
      const res = await api.quotes.list({
        limit: 100,
        search: search || undefined,
        status: statusFilter === "ALL" ? undefined : statusFilter,
      });
      setQuotes(res.quotes);
      setSelectedQuoteId((current) => {
        if (!res.quotes.length) return null;
        if (!current) return res.quotes[0].id;
        return res.quotes.some((quote) => quote.id === current) ? current : res.quotes[0].id;
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed loading quotes.");
    }
  }

  async function loadCustomers() {
    try {
      const res = await api.customers.list({ limit: 100 });
      setCustomers(res.customers);
      setQuoteForm((prev) => ({ ...prev, customerId: prev.customerId || res.customers[0]?.id || "" }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed loading customers.");
    }
  }

  async function loadQuoteDetail(quoteId: string) {
    try {
      const { quote } = await api.quotes.get(quoteId);
      setSelectedQuote(quote);
      if (canViewCommunicationLog) {
        await loadOutboundEvents(quoteId);
      } else {
        setOutboundEvents([]);
      }
      setQuoteEditForm({
        serviceType: quote.serviceType,
        status: quote.status,
        title: quote.title,
        scopeText: quote.scopeText,
        taxAmount: String(Number(quote.taxAmount)),
      });
    } catch (err) {
      setSelectedQuote(null);
      setOutboundEvents([]);
      setError(err instanceof ApiError ? err.message : "Failed loading quote detail.");
    }
  }

  async function loadOutboundEvents(quoteId: string) {
    if (!canViewCommunicationLog) {
      setOutboundEvents([]);
      return;
    }

    setOutboundEventsLoading(true);
    try {
      const { events } = await api.quotes.outboundEvents.list(quoteId, { limit: 15 });
      setOutboundEvents(events);
    } catch (err) {
      setOutboundEvents([]);
      setError(err instanceof ApiError ? err.message : "Failed loading send activity.");
    } finally {
      setOutboundEventsLoading(false);
    }
  }

  async function loadQuoteHistory() {
    if (!canViewQuoteHistory) {
      setQuoteHistory([]);
      return;
    }

    setHistoryLoading(true);
    try {
      if (historyMode === "quote") {
        if (!selectedQuoteId) {
          setQuoteHistory([]);
          return;
        }
        const { revisions } = await api.quotes.getHistory(selectedQuoteId, { limit: 30 });
        setQuoteHistory(revisions);
        return;
      }

      if (historyMode === "customer") {
        const customerId = historyCustomerId === "ALL" ? undefined : historyCustomerId;
        if (!customerId) {
          setQuoteHistory([]);
          return;
        }
        const { revisions } = await api.quotes.history({ customerId, limit: 30 });
        setQuoteHistory(revisions);
        return;
      }

      const { revisions } = await api.quotes.history({ limit: 30 });
      setQuoteHistory(revisions);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed loading quote history.");
    } finally {
      setHistoryLoading(false);
    }
  }

  function focusQuoteDesk(quoteId: string | null) {
    setSelectedQuoteId(quoteId);
    if (quoteId) {
      setMobileSection("quote");
    }
  }

  async function createCustomer(event: FormEvent) {
    event.preventDefault();
    const payload = normalizeCustomerPayload(customerForm);

    if (!payload.fullName || !payload.phone) {
      setError("Full name and phone are required.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await submitCustomerPayload(payload);
    } catch (err) {
      if (err instanceof ApiError) {
        const details = err.details as
          | { code?: string; matches?: CustomerDuplicateMatch[] }
          | undefined;

        if (details?.code === "DUPLICATE_CANDIDATE" && Array.isArray(details.matches) && details.matches.length > 0) {
          setDuplicateModal({
            payload,
            matches: details.matches,
            selectedMatchId: details.matches[0].id,
          });
          return;
        }

        setError(err.message);
        return;
      }

      setError("Failed creating customer.");
    } finally {
      setSaving(false);
    }
  }

  async function submitCustomerPayload(
    payload: CreateCustomerPayload,
    options?: { duplicateAction?: "merge" | "create_new" | "use_existing"; duplicateCustomerId?: string },
  ) {
    const result = await api.customers.create({
      ...payload,
      duplicateAction: options?.duplicateAction,
      duplicateCustomerId: options?.duplicateCustomerId,
    });

    setCustomerForm(EMPTY_CUSTOMER);
    setDuplicateModal(null);
    setNotice(
      result.reusedExisting
        ? "Using existing customer record."
        : result.merged
        ? result.restored
          ? "Duplicate merged and archived customer restored."
          : "Duplicate merged into existing customer."
        : result.restored
          ? "Customer restored."
          : "Customer created.",
    );
    await loadCustomers();
  }

  async function mergeDuplicateCustomer() {
    if (!duplicateModal) return;

    setSaving(true);
    setError(null);
    try {
      await submitCustomerPayload(duplicateModal.payload, {
        duplicateAction: "merge",
        duplicateCustomerId: duplicateModal.selectedMatchId,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed merging duplicate customer.");
    } finally {
      setSaving(false);
    }
  }

  async function createDuplicateAsNew() {
    if (!duplicateModal) return;

    setSaving(true);
    setError(null);
    try {
      await submitCustomerPayload(duplicateModal.payload, {
        duplicateAction: "create_new",
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed creating new customer record.");
    } finally {
      setSaving(false);
    }
  }

  async function createQuoteFromChatPrompt(event: FormEvent) {
    event.preventDefault();
    if (!canUseChatToQuote) {
      setError("Chat to Quote is not available on your current plan.");
      return;
    }

    const prompt = chatPrompt.trim();
    if (!prompt) {
      setError("Enter a prompt before generating a quote.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const { quote, parsed, usage } = await api.quotes.createFromChat({ prompt });
      setChatParsed(parsed);
      setChatPrompt("");
      setQuoteForm((prev) => ({ ...prev, customerId: quote.customerId }));
      await Promise.all([loadCustomers(), loadQuotes()]);
      focusQuoteDesk(quote.id);
      await loadQuoteDetail(quote.id);
      if (canViewQuoteHistory) {
        const { revisions } = await api.quotes.getHistory(quote.id, { limit: 30 });
        setQuoteHistory(revisions);
      }

      const customerName = quote.customer?.fullName ?? parsed.customerName ?? "customer";
      const usageSummary = formatAiUsageNotice(usage);
      setNotice(
        `Draft quote created for ${customerName}. ${usageSummary} Review details, then use Email App, Text App, or PDF actions.`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed creating quote from prompt.");
    } finally {
      setSaving(false);
    }
  }

  async function applyTradeSetup(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    try {
      await api.onboarding.saveSetup({
        primaryTrade: setupTrade,
        generateLogoIfMissing: true,
        chargeBySquareFoot: setupSqFtMode,
        sqFtUnitCost: setupSqFtMode && setupSqFtUnitCost ? Number(setupSqFtUnitCost) : undefined,
        sqFtUnitPrice: setupSqFtMode && setupSqFtUnitPrice ? Number(setupSqFtUnitPrice) : undefined,
      });
      setNotice(`Trade setup saved for ${setupTrade}. Presets and pricing defaults are ready.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed saving trade setup.");
    } finally {
      setSaving(false);
    }
  }

  async function createQuote(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const { quote } = await api.quotes.create({
        customerId: quoteForm.customerId,
        serviceType: quoteForm.serviceType,
        title: quoteForm.title,
        scopeText: quoteForm.scopeText,
        internalCostSubtotal: Number(quoteForm.internalCostSubtotal),
        customerPriceSubtotal: Number(quoteForm.customerPriceSubtotal),
        taxAmount: Number(quoteForm.taxAmount),
      });
      setQuoteForm((prev) => ({ ...EMPTY_QUOTE, customerId: prev.customerId }));
      await loadQuotes();
      focusQuoteDesk(quote.id);
      setNotice("Quote created.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed creating quote.");
    } finally {
      setSaving(false);
    }
  }

  async function persistSelectedQuote() {
    if (!selectedQuote) return;
    setSaving(true);
    setError(null);
    try {
      await api.quotes.update(selectedQuote.id, {
        serviceType: quoteEditForm.serviceType,
        status: quoteEditForm.status,
        title: quoteEditForm.title,
        scopeText: quoteEditForm.scopeText,
        taxAmount: Number(quoteEditForm.taxAmount),
      });
      await Promise.all([loadQuotes(), loadQuoteDetail(selectedQuote.id)]);
      if (canViewQuoteHistory) {
        await loadQuoteHistory();
      }
      setNotice("Quote updated.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed saving quote.");
    } finally {
      setSaving(false);
    }
  }

  async function saveQuote(event: FormEvent) {
    event.preventDefault();
    await persistSelectedQuote();
  }

  async function sendDecision(decision: "send" | "revise") {
    if (!selectedQuote) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.quotes.decision(selectedQuote.id, decision);
      await Promise.all([loadQuotes(), loadQuoteDetail(selectedQuote.id)]);
      if (canViewQuoteHistory) {
        await loadQuoteHistory();
      }
      setNotice(result.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed updating decision.");
    } finally {
      setSaving(false);
    }
  }

  function openSendComposer(channel: SendChannel) {
    if (!selectedQuote) return;

    const customerRecord =
      selectedQuote.customer ??
      customers.find((candidate) => candidate.id === selectedQuote.customerId);

    if (!customerRecord) {
      setError("Customer details are not loaded yet. Try selecting the quote again.");
      return;
    }

    if (channel === "email" && !customerRecord.email) {
      setError("Customer does not have an email address yet.");
      return;
    }

    const draft = buildQuoteMessageDraft(selectedQuote, customerRecord.fullName);

    setSendComposer({
      channel,
      quoteId: selectedQuote.id,
      customerName: customerRecord.fullName,
      customerEmail: customerRecord.email ?? null,
      customerPhone: customerRecord.phone,
      subject: draft.subject,
      body: draft.body,
    });
  }

  async function confirmSendComposer() {
    if (!sendComposer) return;

    setSaving(true);
    setError(null);
    try {
      await api.quotes.decision(sendComposer.quoteId, "send");
      if (canViewCommunicationLog) {
        await api.quotes.outboundEvents.create(sendComposer.quoteId, {
          channel: mapSendChannelToOutboundChannel(sendComposer.channel),
          destination:
            sendComposer.channel === "email"
              ? sendComposer.customerEmail ?? undefined
              : sendComposer.channel === "sms"
                ? sendComposer.customerPhone
                : undefined,
          subject: sendComposer.subject,
          body: sendComposer.body,
        });
      }

      if (sendComposer.channel === "email") {
        const recipient = sendComposer.customerEmail ?? "";
        const mailto = `mailto:${recipient}?subject=${encodeURIComponent(sendComposer.subject)}&body=${encodeURIComponent(sendComposer.body)}`;
        window.location.assign(mailto);
      } else if (sendComposer.channel === "sms") {
        const smsLink = `sms:${toPhoneHrefValue(sendComposer.customerPhone)}?&body=${encodeURIComponent(sendComposer.body)}`;
        window.location.assign(smsLink);
      } else {
        if (!navigator.clipboard) {
          throw new Error("Clipboard API is not available in this browser.");
        }
        await navigator.clipboard.writeText(sendComposer.body);
      }

      await Promise.all([loadQuotes(), loadQuoteDetail(sendComposer.quoteId)]);
      if (canViewCommunicationLog) {
        await loadOutboundEvents(sendComposer.quoteId);
      }
      if (canViewQuoteHistory) {
        await loadQuoteHistory();
      }
      setNotice(
        sendComposer.channel === "copy"
          ? "Quote marked as quoted and message copied."
          : "Quote marked as quoted and message opened in your app.",
      );
      setSendComposer(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed preparing outbound message.");
    } finally {
      setSaving(false);
    }
  }

  async function downloadQuotePdf(options?: { inline?: boolean; afterSend?: boolean }) {
    if (!selectedQuote) return;
    setSaving(true);
    setError(null);
    try {
      if (options?.afterSend) {
        await api.quotes.decision(selectedQuote.id, "send");
      }

      const blob = await api.quotes.downloadPdf(selectedQuote.id, { inline: options?.inline });
      const fileName = `${fileLabel(selectedQuote.title)}.pdf`;
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);

      await Promise.all([loadQuotes(), loadQuoteDetail(selectedQuote.id)]);
      setNotice(options?.afterSend ? "Quote sent and PDF downloaded." : "PDF downloaded.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed generating PDF.");
    } finally {
      setSaving(false);
    }
  }

  async function addLineItem(event: FormEvent) {
    event.preventDefault();
    if (!selectedQuote) return;
    setSaving(true);
    setError(null);
    try {
      await api.quotes.lineItems.create(selectedQuote.id, {
        description: lineItemForm.description,
        quantity: Number(lineItemForm.quantity),
        unitCost: Number(lineItemForm.unitCost),
        unitPrice: Number(lineItemForm.unitPrice),
      });
      setLineItemForm(EMPTY_LINE_ITEM);
      await Promise.all([loadQuotes(), loadQuoteDetail(selectedQuote.id)]);
      if (canViewQuoteHistory) {
        await loadQuoteHistory();
      }
      setNotice("Line item added.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed adding line item.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteLineItem(lineItemId: string) {
    if (!selectedQuote) return;
    setSaving(true);
    setError(null);
    try {
      await api.quotes.lineItems.remove(selectedQuote.id, lineItemId);
      await Promise.all([loadQuotes(), loadQuoteDetail(selectedQuote.id)]);
      if (canViewQuoteHistory) {
        await loadQuoteHistory();
      }
      setNotice("Line item deleted.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed deleting line item.");
    } finally {
      setSaving(false);
    }
  }

  async function updateLeadFollowUpStatus(customerId: string, followUpStatus: LeadFollowUpStatus) {
    setSaving(true);
    setError(null);
    try {
      await api.customers.update(customerId, { followUpStatus });
      await Promise.all([loadCustomers(), loadQuotes()]);
      if (selectedQuote) {
        await loadQuoteDetail(selectedQuote.id);
      }
      setNotice(`Follow-up status updated to ${followUpLabel(followUpStatus)}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed updating follow-up status.");
    } finally {
      setSaving(false);
    }
  }

  const createQuoteMath = useMemo(
    () =>
      summarizeQuoteMath({
        internalCostSubtotal: quoteForm.internalCostSubtotal,
        customerPriceSubtotal: quoteForm.customerPriceSubtotal,
        taxAmount: quoteForm.taxAmount,
      }),
    [quoteForm.internalCostSubtotal, quoteForm.customerPriceSubtotal, quoteForm.taxAmount],
  );

  const selectedQuoteMath = useMemo(() => {
    if (!selectedQuote) return null;

    return summarizeQuoteMath({
      internalCostSubtotal: selectedQuote.internalCostSubtotal,
      customerPriceSubtotal: selectedQuote.customerPriceSubtotal,
      taxAmount: quoteEditForm.taxAmount,
    });
  }, [selectedQuote, quoteEditForm.taxAmount]);

  const lineItemMath = useMemo(() => {
    const quantity = safeAmount(lineItemForm.quantity);
    const unitCost = safeAmount(lineItemForm.unitCost);
    const unitPrice = safeAmount(lineItemForm.unitPrice);
    const costTotal = quantity * unitCost;
    const priceTotal = quantity * unitPrice;

    return {
      quantity,
      costTotal,
      priceTotal,
      profit: priceTotal - costTotal,
    };
  }, [lineItemForm.quantity, lineItemForm.unitCost, lineItemForm.unitPrice]);

  const stats = useMemo(() => {
    const acceptedRevenue = quotes
      .filter((quote) => quote.status === "ACCEPTED")
      .reduce((sum, quote) => sum + Number(quote.totalAmount), 0);
    const month = new Date().getMonth();
    const year = new Date().getFullYear();
    const monthlyQuotes = quotes.filter((quote) => {
      const created = new Date(quote.createdAt);
      return created.getMonth() === month && created.getFullYear() === year;
    }).length;
    return { acceptedRevenue, monthlyQuotes };
  }, [quotes]);

  const pipeline = useMemo(() => {
    const latestByCustomer = new Map<string, Quote>();
    for (const quote of quotes) {
      const existing = latestByCustomer.get(quote.customerId);
      if (!existing || new Date(quote.updatedAt).getTime() > new Date(existing.updatedAt).getTime()) {
        latestByCustomer.set(quote.customerId, quote);
      }
    }

    const recentLeads: LeadCardItem[] = [...customers]
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
      .slice(0, 6)
      .map((customer) => ({
        customerId: customer.id,
        customerName: customer.fullName,
        phone: customer.phone,
        email: customer.email ?? null,
        followUpStatus: customer.followUpStatus,
        createdAt: customer.createdAt,
      }));

    const newLeads: LeadCardItem[] = [];
    const quotedLeads: LeadCardItem[] = [];
    const closedLeads: LeadCardItem[] = [];
    const afterSaleLeads: LeadCardItem[] = [];

    for (const customer of customers) {
      const latestQuote = latestByCustomer.get(customer.id);
      const followUpStatus = effectiveFollowUpStatus(customer, latestQuote);
      const baseItem: LeadCardItem = {
        customerId: customer.id,
        customerName: customer.fullName,
        phone: customer.phone,
        email: customer.email ?? null,
        quoteId: latestQuote?.id,
        quoteTitle: latestQuote?.title,
        totalAmount: latestQuote ? Number(latestQuote.totalAmount) : undefined,
        status: latestQuote?.status,
        followUpStatus,
        createdAt: latestQuote?.updatedAt ?? customer.createdAt,
      };

      if (followUpStatus === "WON" || followUpStatus === "LOST") {
        closedLeads.push(baseItem);
        continue;
      }

      if (!latestQuote || latestQuote.status === "DRAFT") {
        newLeads.push(baseItem);
        continue;
      }

      quotedLeads.push(baseItem);
    }

    const byNewest = (left: LeadCardItem, right: LeadCardItem) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();

    return {
      recentLeads,
      newLeads: newLeads.sort(byNewest).slice(0, 8),
      quotedLeads: quotedLeads.sort(byNewest).slice(0, 8),
      closedLeads: closedLeads.sort(byNewest).slice(0, 8),
      afterSaleLeads,
      totals: {
        newLeads: newLeads.length,
        quotedLeads: quotedLeads.length,
        closedLeads: closedLeads.length,
        afterSaleLeads: afterSaleLeads.length,
      },
    };
  }, [customers, quotes]);

  if (loading) {
    return <AppLoadingScreen message="Loading dashboard..." />;
  }

  return (
    <div className="crm-light">
      <div className="min-h-screen bg-slate-50 p-3 pb-24 sm:p-6 sm:pb-8 lg:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">
            {session?.fullName ? `Welcome, ${session.fullName.split(" ")[0]}` : "QuoteFly CRM"}
          </h1>
          <p className="mt-2 text-sm text-slate-600 sm:text-base">
            Easy quote flow with full detail controls when needed.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard icon={<QuoteIcon size={24} />} label="Quotes This Month" value={String(stats.monthlyQuotes)} />
          <StatCard icon={<CustomerIcon size={24} />} label="Active Customers" value={String(customers.length)} />
          <StatCard icon={<InvoiceIcon size={24} />} label="Accepted Revenue" value={money(stats.acceptedRevenue)} />
        </div>

        <MobileSectionSwitcher
          activeSection={mobileSection}
          onChange={setMobileSection}
          selectedQuoteId={selectedQuoteId}
          quoteCount={quotes.length}
          totals={pipeline.totals}
        />

        <div className={`${mobileSection === "pipeline" ? "block" : "hidden"} rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 lg:block`}>
          <div className="mb-4">
            <h2 className="text-xl font-semibold text-slate-900">Lead Pipeline</h2>
            <p className="text-sm text-slate-600">
              New leads, quoted jobs, and closed work at a glance.
            </p>
          </div>
          <PipelineFlow
            newLeads={pipeline.totals.newLeads}
            quotedLeads={pipeline.totals.quotedLeads}
            closedLeads={pipeline.totals.closedLeads}
            afterSaleLeads={pipeline.totals.afterSaleLeads}
          />
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <PipelineColumn
              icon={<CustomerIcon size={14} />}
              title={`New Leads (${pipeline.totals.newLeads})`}
              subtitle="No quote yet or still draft"
              leads={pipeline.newLeads}
              emptyLabel="No leads waiting for first quote."
              onSelectLead={(quoteId) => focusQuoteDesk(quoteId ?? null)}
              onUpdateFollowUp={(customerId, followUpStatus) =>
                void updateLeadFollowUpStatus(customerId, followUpStatus)
              }
              saving={saving}
              money={money}
            />
            <PipelineColumn
              icon={<SendIcon size={14} />}
              title={`Quoted Leads (${pipeline.totals.quotedLeads})`}
              subtitle="Quote prepared or sent"
              leads={pipeline.quotedLeads}
              emptyLabel="No active quoted leads."
              onSelectLead={(quoteId) => focusQuoteDesk(quoteId ?? null)}
              onUpdateFollowUp={(customerId, followUpStatus) =>
                void updateLeadFollowUpStatus(customerId, followUpStatus)
              }
              saving={saving}
              money={money}
            />
            <PipelineColumn
              icon={<CheckIcon size={14} />}
              title={`Closed Leads (${pipeline.totals.closedLeads})`}
              subtitle="Accepted, work in progress"
              leads={pipeline.closedLeads}
              emptyLabel="No closed deals yet."
              onSelectLead={(quoteId) => focusQuoteDesk(quoteId ?? null)}
              onUpdateFollowUp={(customerId, followUpStatus) =>
                void updateLeadFollowUpStatus(customerId, followUpStatus)
              }
              saving={saving}
              money={money}
            />
            <PipelineColumn
              icon={<ClockIcon size={14} />}
              title="Recently Added Leads"
              subtitle="Most recent customer records"
              leads={pipeline.recentLeads}
              emptyLabel="No customers added yet."
              onSelectLead={(quoteId) => focusQuoteDesk(quoteId ?? null)}
              onUpdateFollowUp={(customerId, followUpStatus) =>
                void updateLeadFollowUpStatus(customerId, followUpStatus)
              }
              saving={saving}
              money={money}
            />
          </div>
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700"
          >
            {error}
          </p>
        )}
        {notice && (
          <p
            role="status"
            aria-live="polite"
            className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-700"
          >
            {notice}
          </p>
        )}

        <div className="grid gap-6 xl:grid-cols-[390px_1fr]">
          <div className={`space-y-6 ${mobileSection === "builder" ? "block" : "hidden"} lg:block`}>
            {canUseChatToQuote ? (
              <form
                onSubmit={createQuoteFromChatPrompt}
                className="space-y-3 rounded-xl border border-blue-200 bg-white p-4 shadow-sm"
              >
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-lg font-semibold text-slate-900">Chat to Quote</h2>
                  <button
                    type="button"
                    onClick={() => setChatPrompt(CHAT_PROMPT_EXAMPLE)}
                    className="rounded-md border border-blue-300 bg-white px-2 py-1 text-xs text-blue-700"
                  >
                    Use Sample
                  </button>
                </div>
                <p className="text-xs text-slate-600">
                  Describe customer, scope, and pricing in one message. QuoteFly will build the customer, quote, and labor/material lines.
                </p>
                <p className="text-[11px] text-blue-700">
                  AI quote generations this month: {aiQuoteLimit === null ? "Unlimited" : aiQuoteLimit}. Manual revisions stay unlimited.
                </p>
                <p className="text-[11px] text-slate-600">
                  AI only generates the first draft. Final quote edits are performed directly by your team.
                </p>
                <textarea
                  rows={6}
                  value={chatPrompt}
                  onChange={(event) => setChatPrompt(event.target.value)}
                  placeholder="New quote for..."
                  className="w-full rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm text-slate-900"
                />
                {chatParsed && (
                  <div className="rounded-lg border border-blue-200 bg-white px-3 py-2 text-xs text-slate-700">
                    <p>
                      Last parse: {chatParsed.serviceType}
                      {chatParsed.squareFeetEstimate ? ` · ${chatParsed.squareFeetEstimate.toLocaleString()} sq ft` : ""}
                      {chatParsed.estimatedTotalAmount ? ` · Est. ${money(chatParsed.estimatedTotalAmount)}` : ""}
                    </p>
                  </div>
                )}
                <button
                  type="submit"
                  disabled={saving}
                  className="w-full rounded-lg bg-quotefly-blue px-4 py-2 text-sm font-semibold text-white"
                >
                  {saving ? "Generating..." : "Generate Draft Quote"}
                </button>
              </form>
            ) : (
              <FeatureLockedCard
                title="Chat to Quote"
                description="Turn one natural-language prompt into a ready quote with labor/material lines."
                currentPlanLabel={currentPlanLabel}
                requiredPlanLabel="Supported Plan"
                showUpgradeHint={canAutoUpgradeMessage}
              />
            )}

            <form onSubmit={applyTradeSetup} className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-900">Quick Trade Setup</h2>
              <p className="text-xs text-slate-600">
                Set your trade defaults and save ready-to-use labor/material presets for faster quote creation.
              </p>
              <select
                value={setupTrade}
                onChange={(event) => setSetupTrade(event.target.value as ServiceType)}
                className="w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm text-slate-900"
              >
                {SERVICE_TYPES.map((serviceType) => (
                  <option key={serviceType} value={serviceType}>
                    {serviceType}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-2 text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={setupSqFtMode}
                  onChange={(event) => setSetupSqFtMode(event.target.checked)}
                />
                I price jobs by square foot (optional)
              </label>
              {setupSqFtMode && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="SQ FT internal cost"
                    value={setupSqFtUnitCost}
                    onChange={(event) => setSetupSqFtUnitCost(event.target.value)}
                    className="rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm text-slate-900"
                  />
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="SQ FT customer price"
                    value={setupSqFtUnitPrice}
                    onChange={(event) => setSetupSqFtUnitPrice(event.target.value)}
                    className="rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm text-slate-900"
                  />
                </div>
              )}
              <p className="text-[11px] text-amber-700">
                Recommended presets for {setupTrade}: {recommendedPresetCount}
              </p>
              <button
                type="submit"
                disabled={saving}
                className="w-full rounded-lg bg-quotefly-blue px-4 py-2 text-sm font-semibold text-white"
              >
                {saving ? "Saving..." : "Save Trade Presets"}
              </button>
            </form>

            <form onSubmit={createCustomer} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-900">Quick Customer</h2>
              <input placeholder="Full name" required value={customerForm.fullName} onChange={(event) => setCustomerForm((prev) => ({ ...prev, fullName: event.target.value }))} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900" />
              <input placeholder="Phone" required value={customerForm.phone} onChange={(event) => setCustomerForm((prev) => ({ ...prev, phone: formatUsPhoneInput(event.target.value) }))} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900" />
              <input placeholder="Email (optional)" type="email" value={customerForm.email} onChange={(event) => setCustomerForm((prev) => ({ ...prev, email: event.target.value }))} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900" />
              <button type="submit" disabled={saving} className="w-full rounded-lg bg-quotefly-blue px-4 py-2 text-sm font-semibold text-white">{saving ? "Saving..." : "Create Customer"}</button>
            </form>

            <form onSubmit={createQuote} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-900">Create Quote</h2>
              <select value={quoteForm.customerId} required onChange={(event) => setQuoteForm((prev) => ({ ...prev, customerId: event.target.value }))} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900">
                <option value="">Select customer</option>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>{customer.fullName} ({formatUsPhoneDisplay(customer.phone)})</option>
                ))}
              </select>
              <select value={quoteForm.serviceType} onChange={(event) => setQuoteForm((prev) => ({ ...prev, serviceType: event.target.value as ServiceType }))} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900">
                {SERVICE_TYPES.map((serviceType) => <option key={serviceType} value={serviceType}>{serviceType}</option>)}
              </select>
              <input placeholder="Title" required value={quoteForm.title} onChange={(event) => setQuoteForm((prev) => ({ ...prev, title: event.target.value }))} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900" />
              <textarea placeholder="Scope details" required rows={3} value={quoteForm.scopeText} onChange={(event) => setQuoteForm((prev) => ({ ...prev, scopeText: event.target.value }))} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900" />
              <div className="grid gap-2 sm:grid-cols-3">
                <input type="number" min="0" step="0.01" placeholder="Internal cost subtotal" value={quoteForm.internalCostSubtotal} onChange={(event) => setQuoteForm((prev) => ({ ...prev, internalCostSubtotal: event.target.value }))} className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900" />
                <input type="number" min="0" step="0.01" placeholder="Customer subtotal" value={quoteForm.customerPriceSubtotal} onChange={(event) => setQuoteForm((prev) => ({ ...prev, customerPriceSubtotal: event.target.value }))} className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900" />
                <input type="number" min="0" step="0.01" placeholder="Tax amount" value={quoteForm.taxAmount} onChange={(event) => setQuoteForm((prev) => ({ ...prev, taxAmount: event.target.value }))} className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900" />
              </div>
              <QuoteMathSummaryPanel
                summary={createQuoteMath}
                compact
                money={money}
                warning={
                  createQuoteMath.customerSubtotal > 0 && createQuoteMath.estimatedProfit < 0
                    ? "Customer subtotal is lower than cost. This quote would lose money."
                    : createQuoteMath.customerSubtotal > 0 && createQuoteMath.estimatedMarginPercent < 10
                      ? "Margin is below 10%. Confirm this is intentional."
                      : undefined
                }
              />
              <button type="submit" disabled={saving || !customers.length} className="w-full rounded-lg bg-quotefly-blue px-4 py-2 text-sm font-semibold text-white">{saving ? "Saving..." : "Create Quote"}</button>
            </form>

            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="mb-3 text-lg font-semibold text-slate-900">Quote List</h2>
              <div className="mb-2 grid grid-cols-[1fr_140px] gap-2">
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search quotes" className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900" />
                <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as QuoteStatus | "ALL")} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900">
                  <option value="ALL">All statuses</option>
                  {QUOTE_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
                </select>
              </div>
              <button onClick={() => void loadQuotes()} className="mb-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50">Apply Filters</button>
              <div className="max-h-[340px] space-y-2 overflow-auto">
                {quotes.map((quote) => (
                  <button key={quote.id} onClick={() => focusQuoteDesk(quote.id)} className={`w-full rounded-lg border p-3 text-left ${selectedQuoteId === quote.id ? "border-quotefly-blue bg-quotefly-blue/10" : "border-slate-200 bg-slate-50 hover:bg-slate-100"}`}>
                    <p className="text-sm font-semibold text-slate-900">{quote.title}</p>
                    <div className="mt-1 flex items-center justify-between">
                      <QuoteStatusPill status={quote.status} compact />
                      <span className="text-xs text-slate-600">{money(quote.totalAmount)}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className={`${mobileSection === "quote" ? "block" : "hidden"} space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 lg:block`}>
            <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3 lg:hidden">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-slate-900">Quote Desk</h2>
                <button
                  type="button"
                  onClick={() => setMobileSection("builder")}
                  className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
                >
                  Open Builder
                </button>
              </div>
              <div className="grid grid-cols-[1fr_130px] gap-2">
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search quotes"
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                />
                <select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value as QuoteStatus | "ALL")}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                >
                  <option value="ALL">All statuses</option>
                  {QUOTE_STATUSES.map((status) => (
                    <option key={`mobile-quote-filter-${status}`} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={() => void loadQuotes()}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700"
              >
                Refresh Quote List
              </button>
              <div className="max-h-56 space-y-2 overflow-auto">
                {quotes.map((quote) => (
                  <button
                    key={`mobile-quote-${quote.id}`}
                    type="button"
                    onClick={() => focusQuoteDesk(quote.id)}
                    className={`w-full rounded-lg border p-3 text-left ${
                      selectedQuoteId === quote.id
                        ? "border-quotefly-blue bg-quotefly-blue/10"
                        : "border-slate-200 bg-white hover:bg-slate-100"
                    }`}
                  >
                    <p className="text-sm font-semibold text-slate-900">{quote.title}</p>
                    <div className="mt-1 flex items-center justify-between">
                      <QuoteStatusPill status={quote.status} compact />
                      <span className="text-xs text-slate-600">{money(quote.totalAmount)}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
            {!selectedQuote ? (
              <p className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-slate-500">
                Select a quote to view details.
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <h2 className="text-xl font-semibold text-slate-900">{selectedQuote.title}</h2>
                  <QuoteStatusPill status={selectedQuote.status} />
                </div>
                <p className="text-xs text-slate-600">Customer: {selectedQuote.customer?.fullName ?? selectedQuote.customerId}</p>

                <form onSubmit={saveQuote} className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <div className="grid gap-2 sm:grid-cols-3">
                    <select value={quoteEditForm.serviceType} onChange={(event) => setQuoteEditForm((prev) => ({ ...prev, serviceType: event.target.value as ServiceType }))} className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900">
                      {SERVICE_TYPES.map((serviceType) => <option key={serviceType} value={serviceType}>{serviceType}</option>)}
                    </select>
                    <select value={quoteEditForm.status} onChange={(event) => setQuoteEditForm((prev) => ({ ...prev, status: event.target.value as QuoteStatus }))} className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900">
                      {QUOTE_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
                    </select>
                    <input type="number" min="0" step="0.01" placeholder="Tax amount" value={quoteEditForm.taxAmount} onChange={(event) => setQuoteEditForm((prev) => ({ ...prev, taxAmount: event.target.value }))} className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900" />
                  </div>
                  <input value={quoteEditForm.title} onChange={(event) => setQuoteEditForm((prev) => ({ ...prev, title: event.target.value }))} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900" />
                  <textarea rows={3} value={quoteEditForm.scopeText} onChange={(event) => setQuoteEditForm((prev) => ({ ...prev, scopeText: event.target.value }))} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900" />
                  {selectedQuoteMath && (
                    <QuoteMathSummaryPanel
                      summary={selectedQuoteMath}
                      money={money}
                      warning={
                        selectedQuoteMath.customerSubtotal > 0 && selectedQuoteMath.estimatedProfit < 0
                          ? "Current pricing is below cost."
                          : selectedQuoteMath.customerSubtotal > 0 && selectedQuoteMath.estimatedMarginPercent < 10
                            ? "Margin is below 10%."
                            : undefined
                      }
                    />
                  )}
                  <div className="hidden flex-wrap gap-2 sm:flex">
                    <button type="submit" disabled={saving} className="rounded-lg bg-quotefly-blue px-4 py-2 text-sm font-semibold text-white">Save Quote</button>
                    <button type="button" onClick={() => void sendDecision("send")} disabled={saving} className="inline-flex items-center gap-1 rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-700"><SendIcon size={14} />Mark Quoted</button>
                    <button type="button" onClick={() => void sendDecision("revise")} disabled={saving} className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-700">Revise</button>
                    <button type="button" onClick={() => openSendComposer("email")} disabled={saving} className="rounded-lg border border-cyan-300 bg-cyan-50 px-3 py-2 text-sm text-cyan-700">Email App</button>
                    <button type="button" onClick={() => openSendComposer("sms")} disabled={saving} className="rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-2 text-sm text-indigo-700">Text App</button>
                    <button type="button" onClick={() => openSendComposer("copy")} disabled={saving} className="rounded-lg border border-violet-300 bg-violet-50 px-3 py-2 text-sm text-violet-700">Copy Message</button>
                    <button type="button" onClick={() => void downloadQuotePdf()} disabled={saving} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700">Download PDF</button>
                    <button type="button" onClick={() => void downloadQuotePdf({ afterSend: true })} disabled={saving} className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">Send + PDF</button>
                  </div>
                  <p className="text-xs text-slate-600">
                    Email and text use the device apps after confirmation, so no paid messaging service is required for v1.
                  </p>
                </form>

                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <h3 className="mb-3 text-sm font-semibold text-slate-900">Line Items</h3>
                  <div className="space-y-2">
                    {(selectedQuote.lineItems ?? []).map((item) => (
                      <div key={item.id} className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2">
                        <div>
                          <p className="text-sm text-slate-900">{item.description}</p>
                          <p className="text-xs text-slate-600">Qty {Number(item.quantity)} · {money(item.unitPrice)}</p>
                        </div>
                        <button onClick={() => setLineItemPendingDeleteId(item.id)} className="inline-flex items-center gap-1 rounded-md border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-700"><DeleteIcon size={12} />Delete</button>
                      </div>
                    ))}
                  </div>
                  <form onSubmit={addLineItem} className="mt-3 space-y-2 border-t border-slate-200 pt-3">
                    <input placeholder="Description" value={lineItemForm.description} onChange={(event) => setLineItemForm((prev) => ({ ...prev, description: event.target.value }))} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900" />
                    <div className="grid gap-2 sm:grid-cols-3">
                      <input type="number" min="0" step="0.01" placeholder="Qty" value={lineItemForm.quantity} onChange={(event) => setLineItemForm((prev) => ({ ...prev, quantity: event.target.value }))} className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900" />
                      <input type="number" min="0" step="0.01" placeholder="Unit cost" value={lineItemForm.unitCost} onChange={(event) => setLineItemForm((prev) => ({ ...prev, unitCost: event.target.value }))} className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900" />
                      <input type="number" min="0" step="0.01" placeholder="Unit price" value={lineItemForm.unitPrice} onChange={(event) => setLineItemForm((prev) => ({ ...prev, unitPrice: event.target.value }))} className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900" />
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700">
                      Draft line math: Cost {money(lineItemMath.costTotal)} · Price {money(lineItemMath.priceTotal)} · Profit{" "}
                      <span className={lineItemMath.profit >= 0 ? "text-emerald-700" : "text-red-700"}>
                        {money(lineItemMath.profit)}
                      </span>
                    </div>
                    <button type="submit" disabled={saving} className="rounded-lg bg-quotefly-blue px-4 py-2 text-sm font-semibold text-white">Add Line Item</button>
                  </form>
                </div>

                {selectedQuoteMath && <QuoteMathSummaryPanel summary={selectedQuoteMath} money={money} />}

                <div className="sticky bottom-3 z-20 rounded-xl border border-slate-200 bg-white p-3 shadow-lg sm:hidden">
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void persistSelectedQuote()}
                      className="rounded-lg bg-quotefly-blue px-3 py-2 text-sm font-semibold text-white"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => void sendDecision("send")}
                      disabled={saving}
                      className="rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-700"
                    >
                      Mark Quoted
                    </button>
                    <button
                      type="button"
                      onClick={() => openSendComposer("email")}
                      disabled={saving}
                      className="rounded-lg border border-cyan-300 bg-cyan-50 px-3 py-2 text-sm text-cyan-700"
                    >
                      Email
                    </button>
                    <button
                      type="button"
                      onClick={() => void downloadQuotePdf()}
                      disabled={saving}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
                    >
                      PDF
                    </button>
                  </div>
                </div>

                {canViewQuoteHistory ? (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-semibold text-slate-900">Quote Revision History</h3>
                        <p className="text-xs text-slate-600">
                          Track original quote values, revisions, and decision changes.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void loadQuoteHistory()}
                        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
                      >
                        Refresh
                      </button>
                    </div>

                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setHistoryMode("quote")}
                        className={`rounded-md border px-2 py-1 text-xs ${
                          historyMode === "quote"
                            ? "border-quotefly-blue bg-quotefly-blue/20 text-white"
                            : "border-slate-300 bg-white text-slate-700"
                        }`}
                      >
                        Selected Quote
                      </button>
                      <button
                        type="button"
                        onClick={() => setHistoryMode("customer")}
                        className={`rounded-md border px-2 py-1 text-xs ${
                          historyMode === "customer"
                            ? "border-quotefly-blue bg-quotefly-blue/20 text-white"
                            : "border-slate-300 bg-white text-slate-700"
                        }`}
                      >
                        By Customer
                      </button>
                      <button
                        type="button"
                        onClick={() => setHistoryMode("all")}
                        className={`rounded-md border px-2 py-1 text-xs ${
                          historyMode === "all"
                            ? "border-quotefly-blue bg-quotefly-blue/20 text-white"
                            : "border-slate-300 bg-white text-slate-700"
                        }`}
                      >
                        All Activity
                      </button>

                      {historyMode === "customer" && (
                        <select
                          value={historyCustomerId}
                          onChange={(event) => setHistoryCustomerId(event.target.value)}
                          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
                        >
                          <option value="ALL">Select customer...</option>
                          {customers.map((customer) => (
                            <option key={customer.id} value={customer.id}>
                              {customer.fullName}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>

                    {historyLoading ? (
                      <p className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                        Loading revision history...
                      </p>
                    ) : quoteHistory.length === 0 ? (
                      <p className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500">
                        No history entries for this filter yet.
                      </p>
                    ) : (
                      <div className="max-h-64 space-y-2 overflow-auto">
                        {quoteHistory.map((revision) => (
                          <div
                            key={revision.id}
                            className="rounded-md border border-slate-200 bg-white px-3 py-2"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex min-w-0 items-center gap-2">
                                <HistoryEventPill eventType={revision.eventType} />
                                <p className="truncate text-sm font-medium text-slate-900">{revision.title}</p>
                              </div>
                              <p className="text-xs text-slate-600">{formatDateTime(revision.createdAt)}</p>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs">
                              <p className="text-slate-600">
                                v{revision.version} · Customer: {revision.customer.fullName}
                              </p>
                              <div className="flex items-center gap-2">
                                <QuoteStatusPill status={revision.status} compact />
                                <p className="text-slate-700">
                                  Subtotal {money(revision.customerPriceSubtotal)} · Total {money(revision.totalAmount)}
                                </p>
                              </div>
                            </div>
                            {revision.changedFields.length > 0 && (
                              <p className="mt-1 text-[11px] text-slate-500">
                                Fields: {revision.changedFields.join(", ")}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <FeatureLockedCard
                    title="Quote Revision History"
                    description="Revision history, customer-level history, and long-term quote timelines unlock on Professional."
                    currentPlanLabel={currentPlanLabel}
                    requiredPlanLabel="Professional"
                    showUpgradeHint={canAutoUpgradeMessage}
                  />
                )}

                {canViewCommunicationLog ? (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-semibold text-slate-900">Send Activity</h3>
                        <p className="text-xs text-slate-600">
                          Logged email/text/copy actions for this quote.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void loadOutboundEvents(selectedQuote.id)}
                        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
                      >
                        Refresh
                      </button>
                    </div>

                    {outboundEventsLoading ? (
                      <p className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                        Loading send activity...
                      </p>
                    ) : outboundEvents.length === 0 ? (
                      <p className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500">
                        No send actions logged yet.
                      </p>
                    ) : (
                      <div className="max-h-52 space-y-2 overflow-auto">
                        {outboundEvents.map((event) => (
                          <div
                            key={event.id}
                            className="rounded-md border border-slate-200 bg-white px-3 py-2"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <OutboundChannelPill channel={event.channel} />
                              <p className="text-xs text-slate-600">{formatDateTime(event.createdAt)}</p>
                            </div>
                            <p className="mt-1 text-xs text-slate-500">
                              {event.destination ? `To: ${event.destination}` : "Destination not captured"}
                            </p>
                            {event.subject && (
                              <p className="mt-1 text-xs text-slate-600">Subject: {event.subject}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <FeatureLockedCard
                    title="Communication Log"
                    description="Email/text/copy activity tracking unlocks on Professional."
                    currentPlanLabel={currentPlanLabel}
                    requiredPlanLabel="Professional"
                    showUpgradeHint={canAutoUpgradeMessage}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </div>
      </div>

      <DuplicateCustomerModal
        open={duplicateModal !== null}
        state={duplicateModal}
        saving={saving}
        onClose={() => setDuplicateModal(null)}
        onSelect={(customerId) =>
          setDuplicateModal((prev) => (prev ? { ...prev, selectedMatchId: customerId } : prev))
        }
        onMerge={() => void mergeDuplicateCustomer()}
        onSaveNew={() => void createDuplicateAsNew()}
      />

      <SendComposerModal
        open={sendComposer !== null}
        state={sendComposer}
        saving={saving}
        onClose={() => setSendComposer(null)}
        onChange={(next) =>
          setSendComposer((current) => (current ? { ...current, ...next } : current))
        }
        onConfirm={() => void confirmSendComposer()}
      />

      <ConfirmModal
        open={lineItemPendingDeleteId !== null}
        onClose={() => setLineItemPendingDeleteId(null)}
        onConfirm={() => {
          if (!lineItemPendingDeleteId) return;
          void deleteLineItem(lineItemPendingDeleteId).finally(() => setLineItemPendingDeleteId(null));
        }}
        title="Delete line item"
        description="This removes the line item from the quote and recalculates totals."
        confirmLabel="Delete line item"
        loading={saving}
      />
    </div>
  );
}

function DuplicateCustomerModal({
  open,
  state,
  saving,
  onClose,
  onSelect,
  onMerge,
  onSaveNew,
}: {
  open: boolean;
  state: DuplicateCustomerModalState | null;
  saving: boolean;
  onClose: () => void;
  onSelect: (customerId: string) => void;
  onMerge: () => void;
  onSaveNew: () => void;
}) {
  if (!open || !state) return null;
  const canSaveAsNew = !state.matches.some((match) => match.matchReasons.includes("phone"));

  return (
    <Modal open={open} onClose={onClose} size="lg" ariaLabel="Potential duplicate customer">
      <ModalHeader
        title="Potential Duplicate Customer"
        description="We found matching customer records. Merge to keep one clean record, or save as new."
        onClose={onClose}
      />
      <ModalBody className="max-h-[70vh] space-y-4">
        <div className="max-h-64 space-y-2 overflow-auto">
          {state.matches.map((match) => (
            <label
              key={match.id}
              className={`block cursor-pointer rounded-lg border px-3 py-2 ${
                state.selectedMatchId === match.id
                  ? "border-quotefly-blue bg-quotefly-blue/10"
                  : "border-slate-200 bg-slate-50"
              }`}
            >
              <input
                type="radio"
                name="duplicate-match"
                className="mr-2"
                checked={state.selectedMatchId === match.id}
                onChange={() => onSelect(match.id)}
              />
              <span className="text-sm font-medium text-slate-900">{match.fullName}</span>
              <p className="text-xs text-slate-600">
                {formatUsPhoneDisplay(match.phone)} {match.email ? `| ${match.email}` : ""}
              </p>
              <div className="mt-1 flex flex-wrap gap-1">
                {match.matchReasons.map((reason) => (
                  <span
                    key={`${match.id}-${reason}`}
                    className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] text-slate-700"
                  >
                    {duplicateReasonLabel(reason)}
                  </span>
                ))}
                {match.deletedAtUtc && (
                  <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">
                    Archived record
                  </span>
                )}
              </div>
            </label>
          ))}
        </div>

        {!canSaveAsNew && (
          <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-700">
            Save as new is disabled when the phone number already exists. Use merge for phone matches.
          </p>
        )}
      </ModalBody>
      <ModalFooter>
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSaveNew}
          disabled={saving || !canSaveAsNew}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Save as New
        </button>
        <button
          type="button"
          onClick={onMerge}
          disabled={saving}
          className="rounded-lg bg-quotefly-blue px-3 py-2 text-sm font-semibold text-white"
        >
          Merge Selected
        </button>
      </ModalFooter>
    </Modal>
  );
}

function SendComposerModal({
  open,
  state,
  saving,
  onClose,
  onChange,
  onConfirm,
}: {
  open: boolean;
  state: SendComposerState | null;
  saving: boolean;
  onClose: () => void;
  onChange: (next: Partial<Pick<SendComposerState, "subject" | "body">>) => void;
  onConfirm: () => void;
}) {
  if (!open || !state) return null;

  const channelLabel =
    state.channel === "email" ? "Email App" : state.channel === "sms" ? "Text App" : "Copy Message";

  return (
    <Modal open={open} onClose={onClose} size="lg" ariaLabel="Confirm send action">
      <ModalHeader
        title="Confirm Send Action"
        description={`Confirming will mark this quote as quoted, then open ${channelLabel.toLowerCase()}.`}
        onClose={onClose}
      />
      <ModalBody className="space-y-4">
        <div className="space-y-2">
          <p className="text-sm text-slate-800">Customer: {state.customerName}</p>
          {state.channel === "email" && (
            <p className="text-sm text-slate-600">To: {state.customerEmail ?? "No email set"}</p>
          )}
          {state.channel === "sms" && (
            <p className="text-sm text-slate-600">To: {formatUsPhoneDisplay(state.customerPhone)}</p>
          )}
        </div>

        {state.channel === "email" && (
          <div className="mt-4">
            <label className="mb-1 block text-xs uppercase tracking-wide text-slate-500">Subject</label>
            <input
              value={state.subject}
              onChange={(event) => onChange({ subject: event.target.value })}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
            />
          </div>
        )}

        <div>
          <label className="mb-1 block text-xs uppercase tracking-wide text-slate-500">Message</label>
          <textarea
            rows={10}
            value={state.body}
            onChange={(event) => onChange({ body: event.target.value })}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
          />
        </div>
      </ModalBody>
      <ModalFooter>
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={saving}
          className="rounded-lg bg-quotefly-blue px-3 py-2 text-sm font-semibold text-white"
        >
          Confirm + Open {channelLabel}
        </button>
      </ModalFooter>
    </Modal>
  );
}


