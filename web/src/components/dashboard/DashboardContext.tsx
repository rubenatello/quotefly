import { createContext, useContext, useEffect, useMemo, useState, useCallback } from "react";
import type { ReactNode, FormEvent } from "react";
import {
  api,
  ApiError,
  type AfterSaleFollowUpStatus,
  type ChatToQuoteParsed,
  type Customer,
  type CustomerDuplicateMatch,
  type LeadFollowUpStatus,
  type QuoteOutboundChannel,
  type QuoteOutboundEvent,
  type Quote,
  type QuoteJobStatus,
  type QuoteRevision,
  type QuoteStatus,
  type ServiceType,
  type TenantEntitlements,
  type TenantUsageSnapshot,
} from "../../lib/api";

/* ─────────────── Types ─────────────── */

export type CustomerForm = { fullName: string; phone: string; email: string };
export type QuoteForm = {
  customerId: string;
  serviceType: ServiceType;
  title: string;
  scopeText: string;
  internalCostSubtotal: string;
  customerPriceSubtotal: string;
  taxAmount: string;
};
export type QuoteEditForm = {
  serviceType: ServiceType;
  status: QuoteStatus;
  jobStatus: QuoteJobStatus;
  afterSaleFollowUpStatus: AfterSaleFollowUpStatus;
  title: string;
  scopeText: string;
  taxAmount: string;
};
export type LineItemForm = { description: string; quantity: string; unitCost: string; unitPrice: string };
export type CreateLineItemInput = { description: string; quantity: number; unitCost: number; unitPrice: number };
export type HistoryMode = "quote" | "customer" | "all";
export type SendChannel = "email" | "sms" | "copy";
export type CreateCustomerPayload = { fullName: string; phone: string; email: string | null };
export type DuplicateCustomerModalState = {
  payload: CreateCustomerPayload;
  matches: CustomerDuplicateMatch[];
  selectedMatchId: string;
};
export type SendComposerState = {
  channel: SendChannel;
  quoteId: string;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string;
  subject: string;
  body: string;
};
export type QuoteMathSummary = {
  internalSubtotal: number;
  customerSubtotal: number;
  taxAmount: number;
  totalAmount: number;
  estimatedProfit: number;
  estimatedMarginPercent: number;
};

export type LeadCardItem = {
  customerId: string;
  customerName: string;
  phone: string;
  email?: string | null;
  quoteId?: string;
  quoteTitle?: string;
  totalAmount?: number;
  status?: QuoteStatus;
  jobStatus?: QuoteJobStatus;
  afterSaleFollowUpStatus?: AfterSaleFollowUpStatus;
  afterSaleFollowUpDueAtUtc?: string | null;
  followUpStatus: LeadFollowUpStatus;
  createdAt: string;
};

export interface DashboardSession {
  email: string;
  fullName: string;
  tenantId: string;
  primaryTrade?: ServiceType | null;
  onboardingCompletedAtUtc?: string | null;
  effectivePlanName?: string;
  effectivePlanCode?: "starter" | "professional" | "enterprise";
  isTrial?: boolean;
  entitlements?: TenantEntitlements;
  usage?: TenantUsageSnapshot;
}

/* ─────────────── Constants ─────────────── */

export const SERVICE_TYPES: ServiceType[] = ["HVAC", "PLUMBING", "FLOORING", "ROOFING", "GARDENING", "CONSTRUCTION"];
export const QUOTE_STATUSES: QuoteStatus[] = ["DRAFT", "READY_FOR_REVIEW", "SENT_TO_CUSTOMER", "ACCEPTED", "REJECTED"];

export const EMPTY_CUSTOMER: CustomerForm = { fullName: "", phone: "", email: "" };
export const EMPTY_QUOTE: QuoteForm = {
  customerId: "",
  serviceType: "HVAC",
  title: "",
  scopeText: "",
  internalCostSubtotal: "0",
  customerPriceSubtotal: "0",
  taxAmount: "0",
};
export const EMPTY_EDIT: QuoteEditForm = {
  serviceType: "HVAC",
  status: "DRAFT",
  jobStatus: "NOT_STARTED",
  afterSaleFollowUpStatus: "NOT_READY",
  title: "",
  scopeText: "",
  taxAmount: "0",
};
export const EMPTY_LINE_ITEM: LineItemForm = { description: "", quantity: "1", unitCost: "0", unitPrice: "0" };
export const CHAT_PROMPT_EXAMPLE =
  "New quote for Alan Johnson 818-233-4333. He has a roof that is about 1,250 square feet and wants to replace his roof-shingles. We will remove old and aged roofing and check for any damage underneath and apply new layer as needed. Whole job should cost about 8,500 using standard asphalt shingles.";

/* ─────────────── Helpers ─────────────── */

export function money(value: string | number): string {
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : "$0.00";
}

export function safeAmount(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

export function summarizeQuoteMath(input: {
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
  return { internalSubtotal, customerSubtotal, taxAmount, totalAmount, estimatedProfit, estimatedMarginPercent };
}

export function followUpLabel(status: LeadFollowUpStatus): string {
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
    phone: form.phone.trim(),
    email: form.email.trim() ? form.email.trim().toLowerCase() : null,
  };
}

export function fileLabel(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "quote"
  );
}

export function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
}

function mapSendChannelToOutboundChannel(channel: SendChannel): QuoteOutboundChannel {
  if (channel === "email") return "EMAIL_APP";
  if (channel === "sms") return "SMS_APP";
  return "COPY";
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

/* ─────────────── Context Shape ─────────────── */

export interface DashboardContextValue {
  // Session
  session: DashboardSession | null;
  // Data
  customers: Customer[];
  quotes: Quote[];
  selectedQuoteId: string | null;
  selectedQuote: Quote | null;
  quoteHistory: QuoteRevision[];
  outboundEvents: QuoteOutboundEvent[];
  // UI state
  search: string;
  statusFilter: QuoteStatus | "ALL";
  loading: boolean;
  saving: boolean;
  error: string | null;
  notice: string | null;
  historyMode: HistoryMode;
  historyCustomerId: string;
  historyLoading: boolean;
  outboundEventsLoading: boolean;
  // Forms
  customerForm: CustomerForm;
  quoteForm: QuoteForm;
  quoteEditForm: QuoteEditForm;
  lineItemForm: LineItemForm;
  chatPrompt: string;
  chatParsed: ChatToQuoteParsed | null;
  setupTrade: ServiceType;
  setupSqFtMode: boolean;
  setupSqFtUnitCost: string;
  setupSqFtUnitPrice: string;
  recommendedPresetCount: number;
  // Modals
  duplicateModal: DuplicateCustomerModalState | null;
  sendComposer: SendComposerState | null;
  // Plan limits
  canUseChatToQuote: boolean;
  aiQuoteLimit: number | null;
  canViewQuoteHistory: boolean;
  canViewCommunicationLog: boolean;
  currentPlanLabel: string;
  canAutoUpgradeMessage: boolean;
  // Computed
  stats: { acceptedRevenue: number; monthlyQuotes: number };
  pipeline: {
    recentLeads: LeadCardItem[];
    newLeads: LeadCardItem[];
    quotedLeads: LeadCardItem[];
    closedLeads: LeadCardItem[];
    afterSaleLeads: LeadCardItem[];
    totals: { newLeads: number; quotedLeads: number; closedLeads: number; afterSaleLeads: number };
  };
  createQuoteMath: QuoteMathSummary;
  selectedQuoteMath: QuoteMathSummary | null;
  lineItemMath: { quantity: number; costTotal: number; priceTotal: number; profit: number };
  // Setters
  setSearch: (val: string) => void;
  setStatusFilter: (val: QuoteStatus | "ALL") => void;
  setError: (val: string | null) => void;
  setNotice: (val: string | null) => void;
  setHistoryMode: (val: HistoryMode) => void;
  setHistoryCustomerId: (val: string) => void;
  setCustomerForm: React.Dispatch<React.SetStateAction<CustomerForm>>;
  setQuoteForm: React.Dispatch<React.SetStateAction<QuoteForm>>;
  setQuoteEditForm: React.Dispatch<React.SetStateAction<QuoteEditForm>>;
  setLineItemForm: React.Dispatch<React.SetStateAction<LineItemForm>>;
  setChatPrompt: (val: string) => void;
  setChatParsed: (val: ChatToQuoteParsed | null) => void;
  setSetupTrade: (val: ServiceType) => void;
  setSetupSqFtMode: (val: boolean) => void;
  setSetupSqFtUnitCost: (val: string) => void;
  setSetupSqFtUnitPrice: (val: string) => void;
  setDuplicateModal: React.Dispatch<React.SetStateAction<DuplicateCustomerModalState | null>>;
  setSendComposer: React.Dispatch<React.SetStateAction<SendComposerState | null>>;
  // Actions
  loadAll: () => Promise<void>;
  loadQuotes: () => Promise<void>;
  loadCustomers: () => Promise<void>;
  loadQuoteHistory: () => Promise<void>;
  focusQuoteDesk: (quoteId: string | null) => void;
  selectQuoteCustomer: (customerId: string) => void;
  navigateToBuilder: (customerId?: string | null) => void;
  createCustomer: (event: FormEvent) => Promise<void>;
  mergeDuplicateCustomer: () => Promise<void>;
  createDuplicateAsNew: () => Promise<void>;
  createQuoteFromChatPrompt: (event: FormEvent) => Promise<void>;
  applyTradeSetup: (event: FormEvent) => Promise<void>;
  createQuoteDraftFromForm: (options?: {
    initialLineItems?: CreateLineItemInput[];
    successNotice?: string;
  }) => Promise<Quote | null>;
  createQuote: (event: FormEvent) => Promise<void>;
  persistSelectedQuote: () => Promise<void>;
  updateQuoteLifecycle: (quoteId: string, patch: {
    status?: QuoteStatus;
    jobStatus?: QuoteJobStatus;
    afterSaleFollowUpStatus?: AfterSaleFollowUpStatus;
  }) => Promise<void>;
  saveQuote: (event: FormEvent) => Promise<void>;
  sendDecision: (decision: "send" | "revise") => Promise<void>;
  openSendComposer: (channel: SendChannel) => void;
  confirmSendComposer: () => Promise<void>;
  downloadQuotePdf: (options?: { inline?: boolean; afterSend?: boolean }) => Promise<void>;
  exportQuotesAsInvoicesCsv: (quoteIds: string[], options?: { dueInDays?: number }) => Promise<void>;
  addLineItem: (event: FormEvent) => Promise<void>;
  addLineItemDraft: (input: CreateLineItemInput, options?: { resetForm?: boolean; notice?: string }) => Promise<void>;
  deleteLineItem: (lineItemId: string) => Promise<void>;
  updateLeadFollowUpStatus: (customerId: string, followUpStatus: LeadFollowUpStatus) => Promise<void>;
  loadOutboundEvents: (quoteId: string) => Promise<void>;
  navigateToQuote: (quoteId: string) => void;
}

const DashboardContext = createContext<DashboardContextValue | null>(null);

export function useDashboard(): DashboardContextValue {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error("useDashboard must be used within DashboardProvider");
  return ctx;
}

/* ─────────────── Provider ─────────────── */

export function DashboardProvider({
  session,
  children,
  onNavigateToQuote,
  onNavigateToBuilder,
}: {
  session: DashboardSession | null;
  children: ReactNode;
  onNavigateToQuote?: (quoteId: string) => void;
  onNavigateToBuilder?: () => void;
}) {
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

  const [customerForm, setCustomerForm] = useState<CustomerForm>(EMPTY_CUSTOMER);
  const [quoteForm, setQuoteForm] = useState<QuoteForm>(EMPTY_QUOTE);
  const [quoteEditForm, setQuoteEditForm] = useState<QuoteEditForm>(EMPTY_EDIT);
  const [lineItemForm, setLineItemForm] = useState<LineItemForm>(EMPTY_LINE_ITEM);
  const [duplicateModal, setDuplicateModal] = useState<DuplicateCustomerModalState | null>(null);
  const [sendComposer, setSendComposer] = useState<SendComposerState | null>(null);
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

  /* ─── Data loaders ─── */

  useEffect(() => { void loadAll(); }, []);

  useEffect(() => {
    let mounted = true;
    api.onboarding.getRecommendedPresets(setupTrade)
      .then((result) => { if (mounted) setRecommendedPresetCount(result.presets.length); })
      .catch(() => { if (mounted) setRecommendedPresetCount(0); });
    return () => { mounted = false; };
  }, [setupTrade]);

  useEffect(() => {
    if (!selectedQuoteId) return;
    void loadQuoteDetail(selectedQuoteId);
  }, [selectedQuoteId, canViewCommunicationLog]);

  useEffect(() => {
    if (!canViewQuoteHistory) { setQuoteHistory([]); return; }
    void loadQuoteHistory();
  }, [canViewQuoteHistory, historyMode, historyCustomerId, selectedQuoteId]);

  const loadAll = useCallback(async () => {
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
  }, []);

  const loadQuotes = useCallback(async () => {
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
        return res.quotes.some((q) => q.id === current) ? current : res.quotes[0].id;
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed loading quotes.");
    }
  }, [search, statusFilter]);

  const loadCustomers = useCallback(async () => {
    try {
      const res = await api.customers.list({ limit: 100 });
      setCustomers(res.customers);
      setQuoteForm((prev) => ({ ...prev, customerId: prev.customerId || res.customers[0]?.id || "" }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed loading customers.");
    }
  }, []);

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
        jobStatus: quote.jobStatus,
        afterSaleFollowUpStatus: quote.afterSaleFollowUpStatus,
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
    if (!canViewCommunicationLog) { setOutboundEvents([]); return; }
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

  const loadQuoteHistory = useCallback(async () => {
    if (!canViewQuoteHistory) { setQuoteHistory([]); return; }
    setHistoryLoading(true);
    try {
      if (historyMode === "quote") {
        if (!selectedQuoteId) { setQuoteHistory([]); return; }
        const { revisions } = await api.quotes.getHistory(selectedQuoteId, { limit: 30 });
        setQuoteHistory(revisions);
        return;
      }
      if (historyMode === "customer") {
        const customerId = historyCustomerId === "ALL" ? undefined : historyCustomerId;
        if (!customerId) { setQuoteHistory([]); return; }
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
  }, [canViewQuoteHistory, historyMode, historyCustomerId, selectedQuoteId]);

  function focusQuoteDesk(quoteId: string | null) {
    setSelectedQuoteId(quoteId);
  }

  function navigateToQuote(quoteId: string) {
    setSelectedQuoteId(quoteId);
    onNavigateToQuote?.(quoteId);
  }

  function selectQuoteCustomer(customerId: string) {
    setQuoteForm((prev) => ({ ...prev, customerId }));
  }

  function navigateToBuilder(customerId?: string | null) {
    if (customerId) {
      setQuoteForm((prev) => ({ ...prev, customerId }));
    }
    onNavigateToBuilder?.();
  }

  /* ─── Customer actions ─── */

  async function submitCustomerPayload(
    payload: CreateCustomerPayload,
    options?: { duplicateAction?: "merge" | "create_new"; duplicateCustomerId?: string },
  ) {
    const result = await api.customers.create({
      ...payload,
      duplicateAction: options?.duplicateAction,
      duplicateCustomerId: options?.duplicateCustomerId,
    });
    setCustomerForm(EMPTY_CUSTOMER);
    setDuplicateModal(null);
    setNotice(
      result.merged
        ? result.restored ? "Duplicate merged and archived customer restored." : "Duplicate merged into existing customer."
        : result.restored ? "Customer restored." : "Customer created.",
    );
    await loadCustomers();
  }

  const createCustomer = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    const payload = normalizeCustomerPayload(customerForm);
    if (!payload.fullName || !payload.phone) { setError("Full name and phone are required."); return; }
    setSaving(true); setError(null);
    try {
      await submitCustomerPayload(payload);
    } catch (err) {
      if (err instanceof ApiError) {
        const details = err.details as { code?: string; matches?: CustomerDuplicateMatch[] } | undefined;
        if (details?.code === "DUPLICATE_CANDIDATE" && Array.isArray(details.matches) && details.matches.length > 0) {
          setDuplicateModal({ payload, matches: details.matches, selectedMatchId: details.matches[0].id });
          return;
        }
        setError(err.message); return;
      }
      setError("Failed creating customer.");
    } finally { setSaving(false); }
  }, [customerForm]);

  const mergeDuplicateCustomer = useCallback(async () => {
    if (!duplicateModal) return;
    setSaving(true); setError(null);
    try {
      await submitCustomerPayload(duplicateModal.payload, { duplicateAction: "merge", duplicateCustomerId: duplicateModal.selectedMatchId });
    } catch (err) { setError(err instanceof ApiError ? err.message : "Failed merging duplicate customer."); } finally { setSaving(false); }
  }, [duplicateModal]);

  const createDuplicateAsNew = useCallback(async () => {
    if (!duplicateModal) return;
    setSaving(true); setError(null);
    try {
      await submitCustomerPayload(duplicateModal.payload, { duplicateAction: "create_new" });
    } catch (err) { setError(err instanceof ApiError ? err.message : "Failed creating new customer record."); } finally { setSaving(false); }
  }, [duplicateModal]);

  /* ─── Quote actions ─── */

  const createQuoteFromChatPrompt = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (!canUseChatToQuote) { setError("Chat to Quote is not available on your current plan."); return; }
    const prompt = chatPrompt.trim();
    if (!prompt) { setError("Enter a prompt before generating a quote."); return; }
    setSaving(true); setError(null);
    try {
      const { quote, parsed } = await api.quotes.createFromChat({ prompt });
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
      setNotice(`Draft quote created for ${customerName}. Review details, then use Email App, Text App, or PDF actions.`);
      navigateToQuote(quote.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed creating quote from prompt.");
    } finally { setSaving(false); }
  }, [canUseChatToQuote, chatPrompt, canViewQuoteHistory]);

  const applyTradeSetup = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true); setError(null);
    try {
      await api.onboarding.saveSetup({
        primaryTrade: setupTrade,
        generateLogoIfMissing: true,
        chargeBySquareFoot: setupSqFtMode,
        sqFtUnitCost: setupSqFtMode && setupSqFtUnitCost ? Number(setupSqFtUnitCost) : undefined,
        sqFtUnitPrice: setupSqFtMode && setupSqFtUnitPrice ? Number(setupSqFtUnitPrice) : undefined,
      });
      setNotice(`Trade setup saved for ${setupTrade}. Presets and pricing defaults are ready.`);
    } catch (err) { setError(err instanceof ApiError ? err.message : "Failed saving trade setup."); } finally { setSaving(false); }
  }, [setupTrade, setupSqFtMode, setupSqFtUnitCost, setupSqFtUnitPrice]);

  const createQuoteDraftFromForm = useCallback(async (options?: {
    initialLineItems?: CreateLineItemInput[];
    successNotice?: string;
  }) => {
    setSaving(true); setError(null);
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
      if (options?.initialLineItems?.length) {
        for (const lineItem of options.initialLineItems) {
          await api.quotes.lineItems.create(quote.id, {
            description: lineItem.description,
            quantity: lineItem.quantity,
            unitCost: lineItem.unitCost,
            unitPrice: lineItem.unitPrice,
          });
        }
      }
      setQuoteForm((prev) => ({ ...EMPTY_QUOTE, customerId: prev.customerId }));
      await loadQuotes();
      focusQuoteDesk(quote.id);
      setNotice(options?.successNotice ?? "Quote created.");
      navigateToQuote(quote.id);
      return quote;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed creating quote.");
      return null;
    } finally { setSaving(false); }
  }, [quoteForm]);

  const createQuote = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    await createQuoteDraftFromForm();
  }, [quoteForm]);

  const persistSelectedQuote = useCallback(async () => {
    if (!selectedQuote) return;
    setSaving(true); setError(null);
    try {
      await api.quotes.update(selectedQuote.id, {
        serviceType: quoteEditForm.serviceType,
        status: quoteEditForm.status,
        jobStatus: quoteEditForm.jobStatus,
        afterSaleFollowUpStatus: quoteEditForm.afterSaleFollowUpStatus,
        title: quoteEditForm.title,
        scopeText: quoteEditForm.scopeText,
        taxAmount: Number(quoteEditForm.taxAmount),
      });
      await Promise.all([loadQuotes(), loadQuoteDetail(selectedQuote.id)]);
      if (canViewQuoteHistory) await loadQuoteHistory();
      setNotice("Quote updated.");
    } catch (err) { setError(err instanceof ApiError ? err.message : "Failed saving quote."); } finally { setSaving(false); }
  }, [selectedQuote, quoteEditForm, canViewQuoteHistory]);

  const updateQuoteLifecycle = useCallback(async (quoteId: string, patch: {
    status?: QuoteStatus;
    jobStatus?: QuoteJobStatus;
    afterSaleFollowUpStatus?: AfterSaleFollowUpStatus;
  }) => {
    setSaving(true);
    setError(null);
    try {
      await api.quotes.update(quoteId, patch);
      await Promise.all([loadQuotes(), loadQuoteDetail(quoteId)]);
      if (canViewQuoteHistory) await loadQuoteHistory();
      setNotice("Quote lifecycle updated.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed updating quote lifecycle.");
    } finally {
      setSaving(false);
    }
  }, [canViewQuoteHistory]);

  const saveQuote = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    await persistSelectedQuote();
  }, [persistSelectedQuote]);

  const sendDecision = useCallback(async (decision: "send" | "revise") => {
    if (!selectedQuote) return;
    setSaving(true); setError(null);
    try {
      const result = await api.quotes.decision(selectedQuote.id, decision);
      await Promise.all([loadQuotes(), loadQuoteDetail(selectedQuote.id)]);
      if (canViewQuoteHistory) await loadQuoteHistory();
      setNotice(result.message);
    } catch (err) { setError(err instanceof ApiError ? err.message : "Failed updating decision."); } finally { setSaving(false); }
  }, [selectedQuote, canViewQuoteHistory]);

  const openSendComposer = useCallback((channel: SendChannel) => {
    if (!selectedQuote) return;
    const customerRecord = selectedQuote.customer ?? customers.find((c) => c.id === selectedQuote.customerId);
    if (!customerRecord) { setError("Customer details are not loaded yet. Try selecting the quote again."); return; }
    if (channel === "email" && !customerRecord.email) { setError("Customer does not have an email address yet."); return; }
    const draft = buildQuoteMessageDraft(selectedQuote, customerRecord.fullName);
    setSendComposer({
      channel, quoteId: selectedQuote.id,
      customerName: customerRecord.fullName, customerEmail: customerRecord.email ?? null, customerPhone: customerRecord.phone,
      subject: draft.subject, body: draft.body,
    });
  }, [selectedQuote, customers]);

  const confirmSendComposer = useCallback(async () => {
    if (!sendComposer) return;
    setSaving(true); setError(null);
    try {
      await api.quotes.decision(sendComposer.quoteId, "send");
      if (canViewCommunicationLog) {
        await api.quotes.outboundEvents.create(sendComposer.quoteId, {
          channel: mapSendChannelToOutboundChannel(sendComposer.channel),
          destination: sendComposer.channel === "email" ? sendComposer.customerEmail ?? undefined : sendComposer.channel === "sms" ? sendComposer.customerPhone : undefined,
          subject: sendComposer.subject, body: sendComposer.body,
        });
      }
      if (sendComposer.channel === "email") {
        const mailto = `mailto:${sendComposer.customerEmail ?? ""}?subject=${encodeURIComponent(sendComposer.subject)}&body=${encodeURIComponent(sendComposer.body)}`;
        window.location.assign(mailto);
      } else if (sendComposer.channel === "sms") {
        window.location.assign(`sms:${sendComposer.customerPhone}?&body=${encodeURIComponent(sendComposer.body)}`);
      } else {
        if (!navigator.clipboard) throw new Error("Clipboard API is not available in this browser.");
        await navigator.clipboard.writeText(sendComposer.body);
      }
      await Promise.all([loadQuotes(), loadQuoteDetail(sendComposer.quoteId)]);
      if (canViewCommunicationLog) await loadOutboundEvents(sendComposer.quoteId);
      if (canViewQuoteHistory) await loadQuoteHistory();
      setNotice(sendComposer.channel === "copy" ? "Quote marked as quoted and message copied." : "Quote marked as quoted and message opened in your app.");
      setSendComposer(null);
    } catch (err) { setError(err instanceof ApiError ? err.message : "Failed preparing outbound message."); } finally { setSaving(false); }
  }, [sendComposer, canViewCommunicationLog, canViewQuoteHistory]);

  const downloadQuotePdf = useCallback(async (options?: { inline?: boolean; afterSend?: boolean }) => {
    if (!selectedQuote) return;
    setSaving(true); setError(null);
    try {
      if (options?.afterSend) await api.quotes.decision(selectedQuote.id, "send");
      const blob = await api.quotes.downloadPdf(selectedQuote.id, { inline: options?.inline });
      const fileName = `${fileLabel(selectedQuote.title)}.pdf`;
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl; anchor.download = fileName;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      URL.revokeObjectURL(objectUrl);
      await Promise.all([loadQuotes(), loadQuoteDetail(selectedQuote.id)]);
      setNotice(options?.afterSend ? "Quote sent and PDF downloaded." : "PDF downloaded.");
    } catch (err) { setError(err instanceof ApiError ? err.message : "Failed generating PDF."); } finally { setSaving(false); }
  }, [selectedQuote]);

  const exportQuotesAsInvoicesCsv = useCallback(
    async (quoteIds: string[], options?: { dueInDays?: number }) => {
      const uniqueQuoteIds = Array.from(new Set(quoteIds.filter((quoteId) => quoteId.trim().length > 0)));
      if (uniqueQuoteIds.length === 0) {
        setError("Select at least one quote to export.");
        return;
      }

      setSaving(true);
      setError(null);

      try {
        const blob = await api.quotes.exportInvoiceCsv({
          quoteIds: uniqueQuoteIds,
          dueInDays: options?.dueInDays,
        });

        const dateLabel = new Date().toISOString().slice(0, 10);
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = `quotefly-quickbooks-invoices-${dateLabel}.csv`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(objectUrl);

        setNotice(
          `Exported ${uniqueQuoteIds.length} quote${uniqueQuoteIds.length === 1 ? "" : "s"} to QuickBooks CSV.`,
        );
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Failed exporting QuickBooks CSV.");
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  const addLineItemDraft = useCallback(async (
    input: CreateLineItemInput,
    options?: { resetForm?: boolean; notice?: string },
  ) => {
    if (!selectedQuote) return;
    setSaving(true); setError(null);
    try {
      await api.quotes.lineItems.create(selectedQuote.id, {
        description: input.description,
        quantity: input.quantity,
        unitCost: input.unitCost,
        unitPrice: input.unitPrice,
      });
      if (options?.resetForm !== false) {
        setLineItemForm(EMPTY_LINE_ITEM);
      }
      await Promise.all([loadQuotes(), loadQuoteDetail(selectedQuote.id)]);
      if (canViewQuoteHistory) await loadQuoteHistory();
      setNotice(options?.notice ?? "Line item added.");
    } catch (err) { setError(err instanceof ApiError ? err.message : "Failed adding line item."); } finally { setSaving(false); }
  }, [selectedQuote, canViewQuoteHistory]);

  const addLineItem = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    await addLineItemDraft({
      description: lineItemForm.description,
      quantity: Number(lineItemForm.quantity),
      unitCost: Number(lineItemForm.unitCost),
      unitPrice: Number(lineItemForm.unitPrice),
    });
  }, [lineItemForm, addLineItemDraft]);

  const deleteLineItem = useCallback(async (lineItemId: string) => {
    if (!selectedQuote) return;
    setSaving(true); setError(null);
    try {
      await api.quotes.lineItems.remove(selectedQuote.id, lineItemId);
      await Promise.all([loadQuotes(), loadQuoteDetail(selectedQuote.id)]);
      if (canViewQuoteHistory) await loadQuoteHistory();
      setNotice("Line item deleted.");
    } catch (err) { setError(err instanceof ApiError ? err.message : "Failed deleting line item."); } finally { setSaving(false); }
  }, [selectedQuote, canViewQuoteHistory]);

  const updateLeadFollowUpStatus = useCallback(async (customerId: string, followUpStatus: LeadFollowUpStatus) => {
    setSaving(true); setError(null);
    try {
      await api.customers.update(customerId, { followUpStatus });
      await Promise.all([loadCustomers(), loadQuotes()]);
      if (selectedQuote) await loadQuoteDetail(selectedQuote.id);
      setNotice(`Follow-up status updated to ${followUpLabel(followUpStatus)}.`);
    } catch (err) { setError(err instanceof ApiError ? err.message : "Failed updating follow-up status."); } finally { setSaving(false); }
  }, [selectedQuote]);

  /* ─── Computed ─── */

  const stats = useMemo(() => {
    const acceptedRevenue = quotes.filter((q) => q.status === "ACCEPTED").reduce((sum, q) => sum + Number(q.totalAmount), 0);
    const month = new Date().getMonth();
    const year = new Date().getFullYear();
    const monthlyQuotes = quotes.filter((q) => { const d = new Date(q.createdAt); return d.getMonth() === month && d.getFullYear() === year; }).length;
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
      .sort((l, r) => new Date(r.createdAt).getTime() - new Date(l.createdAt).getTime())
      .slice(0, 6)
      .map((c) => ({ customerId: c.id, customerName: c.fullName, phone: c.phone, email: c.email ?? null, followUpStatus: c.followUpStatus, createdAt: c.createdAt }));
    const newLeads: LeadCardItem[] = [];
    const quotedLeads: LeadCardItem[] = [];
    const closedLeads: LeadCardItem[] = [];
    const afterSaleLeads: LeadCardItem[] = [];
    for (const customer of customers) {
      const latestQuote = latestByCustomer.get(customer.id);
      const followUpStatus = effectiveFollowUpStatus(customer, latestQuote);
      const baseItem: LeadCardItem = {
        customerId: customer.id, customerName: customer.fullName, phone: customer.phone, email: customer.email ?? null,
        quoteId: latestQuote?.id, quoteTitle: latestQuote?.title, totalAmount: latestQuote ? Number(latestQuote.totalAmount) : undefined,
        status: latestQuote?.status,
        jobStatus: latestQuote?.jobStatus,
        afterSaleFollowUpStatus: latestQuote?.afterSaleFollowUpStatus,
        afterSaleFollowUpDueAtUtc: latestQuote?.afterSaleFollowUpDueAtUtc ?? null,
        followUpStatus,
        createdAt: latestQuote?.updatedAt ?? customer.createdAt,
      };
      if (!latestQuote || latestQuote.status === "DRAFT" || latestQuote.status === "READY_FOR_REVIEW") {
        newLeads.push(baseItem);
        continue;
      }

      if (latestQuote.status === "REJECTED" || followUpStatus === "LOST") {
        continue;
      }

      if (latestQuote.status === "ACCEPTED") {
        if (latestQuote.afterSaleFollowUpStatus === "DUE") {
          afterSaleLeads.push(baseItem);
          continue;
        }

        if (latestQuote.afterSaleFollowUpStatus === "COMPLETED") {
          continue;
        }

        closedLeads.push(baseItem);
        continue;
      }

      quotedLeads.push(baseItem);
    }

    const followUpPriority: Record<LeadFollowUpStatus, number> = {
      NEEDS_FOLLOW_UP: 0,
      FOLLOWED_UP: 1,
      WON: 2,
      LOST: 3,
    };

    const byFollowUpOldestFirst = (left: LeadCardItem, right: LeadCardItem) => {
      const priorityDelta = followUpPriority[left.followUpStatus] - followUpPriority[right.followUpStatus];
      if (priorityDelta !== 0) return priorityDelta;
      return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
    };

    const byOldestFirst = (left: LeadCardItem, right: LeadCardItem) =>
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();

    const jobPriority: Record<QuoteJobStatus, number> = {
      NOT_STARTED: 0,
      SCHEDULED: 1,
      IN_PROGRESS: 2,
      COMPLETED: 3,
    };

    const byJobStageThenOldest = (left: LeadCardItem, right: LeadCardItem) => {
      const leftPriority = jobPriority[left.jobStatus ?? "NOT_STARTED"];
      const rightPriority = jobPriority[right.jobStatus ?? "NOT_STARTED"];
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      return byOldestFirst(left, right);
    };

    const byAfterSaleDueDate = (left: LeadCardItem, right: LeadCardItem) => {
      const leftDue = left.afterSaleFollowUpDueAtUtc ? new Date(left.afterSaleFollowUpDueAtUtc).getTime() : 0;
      const rightDue = right.afterSaleFollowUpDueAtUtc ? new Date(right.afterSaleFollowUpDueAtUtc).getTime() : 0;
      if (leftDue !== rightDue) return leftDue - rightDue;
      return byOldestFirst(left, right);
    };

    return {
      recentLeads,
      newLeads: newLeads.sort(byFollowUpOldestFirst).slice(0, 12),
      quotedLeads: quotedLeads.sort(byFollowUpOldestFirst).slice(0, 12),
      closedLeads: closedLeads.sort(byJobStageThenOldest).slice(0, 12),
      afterSaleLeads: afterSaleLeads.sort(byAfterSaleDueDate).slice(0, 12),
      totals: {
        newLeads: newLeads.length,
        quotedLeads: quotedLeads.length,
        closedLeads: closedLeads.length,
        afterSaleLeads: afterSaleLeads.length,
      },
    };
  }, [customers, quotes]);

  const createQuoteMath = useMemo(() => summarizeQuoteMath({
    internalCostSubtotal: quoteForm.internalCostSubtotal,
    customerPriceSubtotal: quoteForm.customerPriceSubtotal,
    taxAmount: quoteForm.taxAmount,
  }), [quoteForm.internalCostSubtotal, quoteForm.customerPriceSubtotal, quoteForm.taxAmount]);

  const selectedQuoteMath = useMemo(() => {
    if (!selectedQuote) return null;
    return summarizeQuoteMath({ internalCostSubtotal: selectedQuote.internalCostSubtotal, customerPriceSubtotal: selectedQuote.customerPriceSubtotal, taxAmount: quoteEditForm.taxAmount });
  }, [selectedQuote, quoteEditForm.taxAmount]);

  const lineItemMath = useMemo(() => {
    const quantity = safeAmount(lineItemForm.quantity);
    const unitCost = safeAmount(lineItemForm.unitCost);
    const unitPrice = safeAmount(lineItemForm.unitPrice);
    return { quantity, costTotal: quantity * unitCost, priceTotal: quantity * unitPrice, profit: quantity * unitPrice - quantity * unitCost };
  }, [lineItemForm.quantity, lineItemForm.unitCost, lineItemForm.unitPrice]);

  const value: DashboardContextValue = {
    session, customers, quotes, selectedQuoteId, selectedQuote, quoteHistory, outboundEvents,
    search, statusFilter, loading, saving, error, notice,
    historyMode, historyCustomerId, historyLoading, outboundEventsLoading,
    customerForm, quoteForm, quoteEditForm, lineItemForm,
    chatPrompt, chatParsed, setupTrade, setupSqFtMode, setupSqFtUnitCost, setupSqFtUnitPrice, recommendedPresetCount,
    duplicateModal, sendComposer,
    canUseChatToQuote, aiQuoteLimit, canViewQuoteHistory, canViewCommunicationLog, currentPlanLabel, canAutoUpgradeMessage,
    stats, pipeline, createQuoteMath, selectedQuoteMath, lineItemMath,
    setSearch, setStatusFilter, setError, setNotice, setHistoryMode, setHistoryCustomerId,
    setCustomerForm, setQuoteForm, setQuoteEditForm, setLineItemForm,
    setChatPrompt, setChatParsed, setSetupTrade, setSetupSqFtMode, setSetupSqFtUnitCost, setSetupSqFtUnitPrice,
    setDuplicateModal, setSendComposer,
    loadAll, loadQuotes, loadCustomers, loadQuoteHistory,
    focusQuoteDesk, selectQuoteCustomer, navigateToBuilder, createCustomer, mergeDuplicateCustomer, createDuplicateAsNew,
    createQuoteFromChatPrompt, applyTradeSetup, createQuoteDraftFromForm, createQuote, persistSelectedQuote, updateQuoteLifecycle, saveQuote,
    sendDecision, openSendComposer, confirmSendComposer,
    downloadQuotePdf, exportQuotesAsInvoicesCsv,
    addLineItem, addLineItemDraft, deleteLineItem, updateLeadFollowUpStatus, loadOutboundEvents, navigateToQuote,
  };

  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}
