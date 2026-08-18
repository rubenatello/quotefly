import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from "react";
import type { ReactNode, FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
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
  type SaveQuoteSheetInput,
  type QuoteStatus,
  type ServiceType,
  type TenantBranding,
  type TenantEntitlements,
  type TenantUsageSnapshot,
} from "../../lib/api";
import {
  isLikelyMobileRuntime,
  openPdfPreviewBlob,
  sharePdfBlobNatively,
} from "../../lib/quote-pdf-actions";
import { buildQuoteMessageDraft } from "../../lib/quote-message-template";
import { formatUsPhoneDisplay, toPhoneHrefValue } from "../../lib/phone";
import { notify } from "../../lib/notifications";

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
export type CreateLineItemInput = {
  description: string;
  sectionType?: "INCLUDED" | "ALTERNATE";
  sectionLabel?: string | null;
  quantity: number;
  unitCost: number;
  unitPrice: number;
  sourcePresetId?: string;
};
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
  confirmedChannel?: QuoteOutboundChannel;
  idempotencyKey: string;
  quoteId: string;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string;
  subject: string;
  body: string;
  handoffComplete?: boolean;
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
  userId: string;
  email: string;
  fullName: string;
  tenantId: string;
  tenantName: string;
  timezone: string;
  role: "owner" | "admin" | "member";
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

const QUOTE_EDIT_FIELDS: Array<keyof QuoteEditForm> = [
  "serviceType",
  "status",
  "jobStatus",
  "afterSaleFollowUpStatus",
  "title",
  "scopeText",
  "taxAmount",
];

const WORKSPACE_COLLECTION_PATHS = new Set([
  "/app/analytics",
  "/app/build",
  "/app/quotes",
]);

function shouldEagerLoadWorkspaceCollections(pathname: string): boolean {
  const normalizedPath = pathname.replace(/\/+$/, "") || pathname;
  return WORKSPACE_COLLECTION_PATHS.has(normalizedPath) || normalizedPath.startsWith("/app/quotes/");
}

/* ─────────────── Helpers ─────────────── */

const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function money(value: string | number): string {
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) ? USD_FORMATTER.format(amount) : "$0.00";
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
    phone: formatUsPhoneDisplay(form.phone) || form.phone.trim(),
    email: form.email.trim() ? form.email.trim().toLowerCase() : null,
  };
}

function toQuoteEditForm(quote: Quote): QuoteEditForm {
  return {
    serviceType: quote.serviceType,
    status: quote.status,
    jobStatus: quote.jobStatus,
    afterSaleFollowUpStatus: quote.afterSaleFollowUpStatus,
    title: quote.title,
    scopeText: quote.scopeText,
    taxAmount: String(Number(quote.taxAmount)),
  };
}

function quoteEditFieldMatches(
  field: keyof QuoteEditForm,
  left: QuoteEditForm[keyof QuoteEditForm],
  right: QuoteEditForm[keyof QuoteEditForm],
): boolean {
  if (field === "taxAmount") return Number(left) === Number(right);
  if (field === "title" || field === "scopeText") return left.trim() === right.trim();
  return left === right;
}

function reconcileQuoteEditForm(
  current: QuoteEditForm,
  previousSaved: QuoteEditForm,
  server: QuoteEditForm,
): QuoteEditForm {
  const next = { ...server };

  for (const field of QUOTE_EDIT_FIELDS) {
    const hasLocalDraft = !quoteEditFieldMatches(field, current[field], previousSaved[field]);
    const serverAcceptedDraft = quoteEditFieldMatches(field, current[field], server[field]);
    if (hasLocalDraft && !serverAcceptedDraft) {
      Object.assign(next, { [field]: current[field] });
    }
  }

  return next;
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

function createSendIdempotencyKey(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  return `quote-send:${randomId ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

/* ─────────────── Context Shape ─────────────── */

export interface DashboardContextValue {
  // Session
  session: DashboardSession | null;
  // Data
  customers: Customer[];
  quotes: Quote[];
  branding: TenantBranding | null;
  selectedQuoteId: string | null;
  selectedQuote: Quote | null;
  quoteDetailLoading: boolean;
  quoteDetailError: { kind: "not-found" | "load"; message: string } | null;
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
  canViewInternalCosts: boolean;
  canManageCatalog: boolean;
  canManageAssignments: boolean;
  canManageRecordRetention: boolean;
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
  refreshSelectedQuote: () => Promise<void>;
  retrySelectedQuote: () => Promise<void>;
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
    quoteOverride?: Partial<QuoteForm>;
    aiUsageEventId?: string;
  }) => Promise<Quote | null>;
  createQuote: (event: FormEvent) => Promise<void>;
  persistSelectedQuote: () => Promise<boolean>;
  saveQuoteSheet: (input: SaveQuoteSheetInput) => Promise<Quote | null>;
  updateQuoteLifecycle: (quoteId: string, patch: {
    status?: QuoteStatus;
    jobStatus?: QuoteJobStatus;
    afterSaleFollowUpStatus?: AfterSaleFollowUpStatus;
  }) => Promise<void>;
  saveQuote: (event: FormEvent) => Promise<void>;
  sendDecision: (decision: "send" | "revise") => Promise<void>;
  openSendComposer: (channel: SendChannel, quoteOverride?: Quote) => void;
  confirmSendComposer: () => Promise<void>;
  downloadQuotePdf: (options?: { inline?: boolean; quoteOverride?: Quote }) => Promise<void>;
  exportQuotesAsInvoicesCsv: (quoteIds: string[], options?: { dueInDays?: number }) => Promise<void>;
  addLineItem: (event: FormEvent) => Promise<void>;
  addLineItemDraft: (input: CreateLineItemInput, options?: { resetForm?: boolean; notice?: string }) => Promise<boolean>;
  updateLineItem: (
    lineItemId: string,
    input: Partial<CreateLineItemInput> & { description?: string },
    options?: { notice?: string },
  ) => Promise<boolean>;
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
  const location = useLocation();
  const navigate = useNavigate();
  const routeQuoteId = useMemo(() => {
    const match = location.pathname.match(/^\/app\/quotes\/([^/]+)\/?$/);
    if (!match?.[1]) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }, [location.pathname]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [branding, setBranding] = useState<TenantBranding | null>(null);
  const [selectedQuoteId, setSelectedQuoteId] = useState<string | null>(() => routeQuoteId);
  const [selectedQuote, setSelectedQuote] = useState<Quote | null>(null);
  const [quoteDetailLoading, setQuoteDetailLoading] = useState(Boolean(routeQuoteId));
  const [quoteDetailError, setQuoteDetailError] = useState<DashboardContextValue["quoteDetailError"]>(null);
  const routeQuoteIdRef = useRef<string | null>(routeQuoteId);
  const selectedQuoteIdRef = useRef<string | null>(routeQuoteId);
  const quoteDetailRequestIdRef = useRef(0);
  const outboundRequestIdRef = useRef(0);
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
  const quoteEditBaselineQuoteIdRef = useRef<string | null>(null);
  const quoteEditBaselineRef = useRef<QuoteEditForm | null>(null);
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
  const hasLoadedWorkspaceCollectionsRef = useRef(false);
  const shouldLoadWorkspaceCollections = useMemo(
    () => shouldEagerLoadWorkspaceCollections(location.pathname),
    [location.pathname],
  );

  const canUseChatToQuote = session?.entitlements?.features.aiAutomation ?? true;
  const aiQuoteLimit = session?.entitlements?.limits.aiQuotesPerMonth ?? null;
  const canViewQuoteHistory = session?.entitlements?.features.quoteVersionHistory ?? true;
  const canViewCommunicationLog = session?.entitlements?.features.communicationLog ?? true;
  const currentPlanLabel = session?.effectivePlanName ?? "Basic";
  const canAutoUpgradeMessage = !(session?.isTrial ?? false);

  const selectQuoteId = useCallback((quoteId: string | null) => {
    if (selectedQuoteIdRef.current === quoteId) return;
    selectedQuoteIdRef.current = quoteId;
    quoteDetailRequestIdRef.current += 1;
    outboundRequestIdRef.current += 1;
    setSelectedQuoteId(quoteId);
    setSelectedQuote((current) => current?.id === quoteId ? current : null);
    setQuoteDetailError(null);
  }, []);

  useEffect(() => {
    routeQuoteIdRef.current = routeQuoteId;
    if (routeQuoteId) selectQuoteId(routeQuoteId);
  }, [routeQuoteId, selectQuoteId]);

  /* ─── Data loaders ─── */

  useEffect(() => {
    if (!shouldLoadWorkspaceCollections) {
      setRecommendedPresetCount(0);
      return;
    }

    let mounted = true;
    api.onboarding.getRecommendedPresets(setupTrade)
      .then((result) => { if (mounted) setRecommendedPresetCount(result.presets.length); })
      .catch(() => { if (mounted) setRecommendedPresetCount(0); });
    return () => { mounted = false; };
  }, [setupTrade, shouldLoadWorkspaceCollections]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [customerRes, quoteRes, brandingRes] = await Promise.all([
        api.customers.list({ limit: 100 }),
        api.quotes.list({ limit: 100 }),
        session?.tenantId ? api.branding.get(session.tenantId) : Promise.resolve(null),
      ]);
      setCustomers(customerRes.customers);
      setQuotes(quoteRes.quotes);
      setBranding(brandingRes?.branding ?? null);
      hasLoadedWorkspaceCollectionsRef.current = true;
      setQuoteForm((prev) => {
        const nextCustomerId =
          prev.customerId && customerRes.customers.some((customer) => customer.id === prev.customerId)
            ? prev.customerId
            : "";
        return { ...prev, customerId: nextCustomerId };
      });
      const currentQuoteId = selectedQuoteIdRef.current;
      const nextQuoteId = routeQuoteIdRef.current
        ?? (currentQuoteId && quoteRes.quotes.some((quote) => quote.id === currentQuoteId)
          ? currentQuoteId
          : null);
      selectQuoteId(nextQuoteId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed loading dashboard data.");
    } finally {
      setLoading(false);
    }
  }, [selectQuoteId, session?.tenantId]);

  useEffect(() => {
    if (!shouldLoadWorkspaceCollections) {
      setLoading(false);
      return;
    }
    if (hasLoadedWorkspaceCollectionsRef.current) return;
    void loadAll();
  }, [loadAll, shouldLoadWorkspaceCollections]);

  const loadQuotes = useCallback(async () => {
    try {
      const res = await api.quotes.list({
        limit: 100,
        search: search || undefined,
        status: statusFilter === "ALL" ? undefined : statusFilter,
      });
      setQuotes(res.quotes);
      const currentQuoteId = selectedQuoteIdRef.current;
      const nextQuoteId = routeQuoteIdRef.current
        ?? (currentQuoteId && res.quotes.some((quote) => quote.id === currentQuoteId)
          ? currentQuoteId
          : null);
      selectQuoteId(nextQuoteId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed loading quotes.");
    }
  }, [search, selectQuoteId, statusFilter]);

  const loadCustomers = useCallback(async () => {
    try {
      const res = await api.customers.list({ limit: 100 });
      setCustomers(res.customers);
      setQuoteForm((prev) => {
        const nextCustomerId =
          prev.customerId && res.customers.some((customer) => customer.id === prev.customerId)
            ? prev.customerId
            : "";
        return { ...prev, customerId: nextCustomerId };
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed loading customers.");
    }
  }, []);

  const loadOutboundEvents = useCallback(async (quoteId: string) => {
    if (!canViewCommunicationLog) { setOutboundEvents([]); return; }
    const requestId = ++outboundRequestIdRef.current;
    setOutboundEventsLoading(true);
    try {
      const { events } = await api.quotes.outboundEvents.list(quoteId, { limit: 15 });
      if (requestId !== outboundRequestIdRef.current || selectedQuoteIdRef.current !== quoteId) return;
      setOutboundEvents(events);
    } catch (err) {
      if (requestId !== outboundRequestIdRef.current || selectedQuoteIdRef.current !== quoteId) return;
      setOutboundEvents([]);
      setError(err instanceof ApiError ? err.message : "Failed loading send activity.");
    } finally {
      if (requestId === outboundRequestIdRef.current) setOutboundEventsLoading(false);
    }
  }, [canViewCommunicationLog]);

  const loadQuoteDetail = useCallback(async (
    quoteId: string,
    options?: { includeOutboundEvents?: boolean },
  ) => {
    const requestId = ++quoteDetailRequestIdRef.current;
    setQuoteDetailLoading(true);
    setQuoteDetailError(null);
    setSelectedQuote((current) => current?.id === quoteId ? current : null);
    try {
      const { quote } = await api.quotes.get(quoteId);
      if (requestId !== quoteDetailRequestIdRef.current || selectedQuoteIdRef.current !== quoteId) return;
      setSelectedQuote(quote);
      const serverEditForm = toQuoteEditForm(quote);
      const previousSaved =
        quoteEditBaselineQuoteIdRef.current === quote.id ? quoteEditBaselineRef.current : null;
      setQuoteEditForm((current) =>
        previousSaved ? reconcileQuoteEditForm(current, previousSaved, serverEditForm) : serverEditForm,
      );
      quoteEditBaselineQuoteIdRef.current = quote.id;
      quoteEditBaselineRef.current = serverEditForm;
      const includeOutboundEvents = options?.includeOutboundEvents ?? true;
      if (canViewCommunicationLog && includeOutboundEvents) {
        await loadOutboundEvents(quoteId);
      } else if (!canViewCommunicationLog) {
        setOutboundEvents([]);
      }
    } catch (err) {
      if (requestId !== quoteDetailRequestIdRef.current || selectedQuoteIdRef.current !== quoteId) return;
      setSelectedQuote(null);
      setOutboundEvents([]);
      setQuoteDetailError(
        err instanceof ApiError && err.status === 404
          ? { kind: "not-found", message: "This quote could not be found. It may have been archived, deleted, or you may no longer have access." }
          : { kind: "load", message: "Quote details could not be loaded. Check your connection and try again." },
      );
    } finally {
      if (requestId === quoteDetailRequestIdRef.current) setQuoteDetailLoading(false);
    }
  }, [canViewCommunicationLog, loadOutboundEvents]);

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

  useEffect(() => {
    if (!selectedQuoteId) {
      setSelectedQuote(null);
      setOutboundEvents([]);
      setQuoteDetailLoading(false);
      return;
    }
    void loadQuoteDetail(selectedQuoteId);
  }, [selectedQuoteId, loadQuoteDetail]);

  useEffect(() => {
    void loadQuoteHistory();
  }, [loadQuoteHistory]);

  const refreshSelectedQuote = useCallback(async () => {
    if (!selectedQuoteId) return;
    await Promise.all([loadQuotes(), loadQuoteDetail(selectedQuoteId)]);
  }, [selectedQuoteId, loadQuotes, loadQuoteDetail]);

  const retrySelectedQuote = useCallback(async () => {
    if (!selectedQuoteId) return;
    await loadQuoteDetail(selectedQuoteId);
  }, [loadQuoteDetail, selectedQuoteId]);

  const focusQuoteDesk = useCallback((quoteId: string | null) => {
    selectQuoteId(quoteId);
  }, [selectQuoteId]);

  const navigateToQuote = useCallback((quoteId: string) => {
    selectQuoteId(quoteId);
    onNavigateToQuote?.(quoteId);
  }, [onNavigateToQuote, selectQuoteId]);

  const selectQuoteCustomer = useCallback((customerId: string) => {
    setQuoteForm((prev) => ({ ...prev, customerId }));
  }, []);

  const navigateToBuilder = useCallback((customerId?: string | null) => {
    if (customerId) {
      setQuoteForm((prev) => ({ ...prev, customerId }));
    }
    onNavigateToBuilder?.();
  }, [onNavigateToBuilder]);

  /* ─── Customer actions ─── */

  const submitCustomerPayload = useCallback(async (
    payload: CreateCustomerPayload,
    options?: { duplicateAction?: "merge" | "create_new" | "use_existing"; duplicateCustomerId?: string },
  ) => {
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
        ? result.restored ? "Duplicate merged and archived customer restored." : "Duplicate merged into existing customer."
        : result.restored ? "Customer restored." : "Customer created.",
    );
    void loadCustomers();
  }, [loadCustomers]);

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
  }, [customerForm, submitCustomerPayload]);

  const mergeDuplicateCustomer = useCallback(async () => {
    if (!duplicateModal) return;
    setSaving(true); setError(null);
    try {
      await submitCustomerPayload(duplicateModal.payload, { duplicateAction: "merge", duplicateCustomerId: duplicateModal.selectedMatchId });
    } catch (err) { setError(err instanceof ApiError ? err.message : "Failed merging duplicate customer."); } finally { setSaving(false); }
  }, [duplicateModal, submitCustomerPayload]);

  const createDuplicateAsNew = useCallback(async () => {
    if (!duplicateModal) return;
    setSaving(true); setError(null);
    try {
      await submitCustomerPayload(duplicateModal.payload, { duplicateAction: "create_new" });
    } catch (err) { setError(err instanceof ApiError ? err.message : "Failed creating new customer record."); } finally { setSaving(false); }
  }, [duplicateModal, submitCustomerPayload]);

  /* ─── Quote actions ─── */

  const createQuoteFromChatPrompt = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (!canUseChatToQuote) { setError("Chat to Quote is not available on your current plan."); return; }
    const prompt = chatPrompt.trim();
    if (!prompt) { setError("Enter a prompt before generating a quote."); return; }
    setError(null);
    setChatParsed(null);
    setChatPrompt("");
    setNotice("Opening the quote builder. Generate and review the AI draft there before creating anything.");
    navigate("/app/build", {
      state: {
        kodyQuoteDraft: {
          prompt,
        },
      },
    });
  }, [canUseChatToQuote, chatPrompt, navigate]);

  const applyTradeSetup = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true); setError(null);
    try {
      await api.onboarding.saveSetup({
        primaryTrade: setupTrade,
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
    quoteOverride?: Partial<QuoteForm>;
    aiUsageEventId?: string;
  }) => {
    setSaving(true); setError(null);
    try {
      const mergedQuoteForm = {
        ...quoteForm,
        ...(options?.quoteOverride ?? {}),
      };
      const { quote } = await api.quotes.create({
        customerId: mergedQuoteForm.customerId,
        serviceType: mergedQuoteForm.serviceType,
        title: mergedQuoteForm.title,
        scopeText: mergedQuoteForm.scopeText,
        internalCostSubtotal: Number(mergedQuoteForm.internalCostSubtotal),
        customerPriceSubtotal: Number(mergedQuoteForm.customerPriceSubtotal),
        taxAmount: Number(mergedQuoteForm.taxAmount),
        aiUsageEventId: options?.aiUsageEventId,
        lineItems: options?.initialLineItems?.map((lineItem) => ({
          description: lineItem.description,
          sectionType: lineItem.sectionType ?? "INCLUDED",
          sectionLabel: lineItem.sectionLabel ?? null,
          quantity: lineItem.quantity,
          unitCost: lineItem.unitCost,
          unitPrice: lineItem.unitPrice,
        })),
      });
      setQuoteForm((prev) => ({ ...EMPTY_QUOTE, customerId: prev.customerId }));
      focusQuoteDesk(quote.id);
      setNotice(options?.successNotice ?? "Quote created.");
      navigateToQuote(quote.id);
      void loadQuotes();
      return quote;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed creating quote.");
      return null;
    } finally { setSaving(false); }
  }, [focusQuoteDesk, quoteForm, loadQuotes, navigateToQuote]);

  const createQuote = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    await createQuoteDraftFromForm();
  }, [createQuoteDraftFromForm]);

  const persistSelectedQuote = useCallback(async () => {
    if (!selectedQuote) return false;
    setSaving(true); setError(null); setNotice(null);
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
      await Promise.all([
        loadQuotes(),
        loadQuoteDetail(selectedQuote.id, { includeOutboundEvents: false }),
      ]);
      if (canViewQuoteHistory) void loadQuoteHistory();
      setNotice("Quote updated.");
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Quote changes could not be saved. Try again.");
      return false;
    } finally { setSaving(false); }
  }, [selectedQuote, quoteEditForm, canViewQuoteHistory, loadQuotes, loadQuoteDetail, loadQuoteHistory]);

  const saveQuoteSheet = useCallback(async (input: SaveQuoteSheetInput) => {
    if (!selectedQuote) return null;
    setSaving(true); setError(null); setNotice(null);
    try {
      const result = await api.quotes.saveSheet(selectedQuote.id, input);
      await Promise.all([
        loadQuotes(),
        loadQuoteDetail(selectedQuote.id, { includeOutboundEvents: false }),
      ]);
      if (canViewQuoteHistory) void loadQuoteHistory();
      setNotice("Quote updated.");
      return result.quote;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Quote changes could not be saved. Try again.");
      return null;
    } finally { setSaving(false); }
  }, [selectedQuote, canViewQuoteHistory, loadQuotes, loadQuoteDetail, loadQuoteHistory]);

  const updateQuoteLifecycle = useCallback(async (quoteId: string, patch: {
    status?: QuoteStatus;
    jobStatus?: QuoteJobStatus;
    afterSaleFollowUpStatus?: AfterSaleFollowUpStatus;
  }) => {
    setSaving(true);
    setError(null);
    try {
      await api.quotes.update(quoteId, patch);
      await Promise.all([
        loadQuotes(),
        loadQuoteDetail(quoteId, { includeOutboundEvents: false }),
      ]);
      if (canViewQuoteHistory) void loadQuoteHistory();
      setNotice("Quote lifecycle updated.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed updating quote lifecycle.");
    } finally {
      setSaving(false);
    }
  }, [canViewQuoteHistory, loadQuotes, loadQuoteDetail, loadQuoteHistory]);

  const saveQuote = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    await persistSelectedQuote();
  }, [persistSelectedQuote]);

  const sendDecision = useCallback(async (decision: "send" | "revise") => {
    if (!selectedQuote) return;
    setSaving(true); setError(null);
    try {
      const result = await api.quotes.decision(selectedQuote.id, decision);
      await Promise.all([
        loadQuotes(),
        loadQuoteDetail(selectedQuote.id, { includeOutboundEvents: false }),
      ]);
      if (canViewQuoteHistory) void loadQuoteHistory();
      setNotice(result.message);
    } catch (err) { setError(err instanceof ApiError ? err.message : "Failed updating decision."); } finally { setSaving(false); }
  }, [selectedQuote, canViewQuoteHistory, loadQuotes, loadQuoteDetail, loadQuoteHistory]);

  const openSendComposer = useCallback((channel: SendChannel, quoteOverride?: Quote) => {
    const quoteForSend = quoteOverride ?? selectedQuote;
    if (!quoteForSend) return;
    const customerRecord = quoteForSend.customer ?? customers.find((c) => c.id === quoteForSend.customerId);
    if (!customerRecord) { setError("Customer details are not loaded yet. Try selecting the quote again."); return; }
    if (channel === "email" && !customerRecord.email) { setError("Customer does not have an email address yet."); return; }
    const draft = buildQuoteMessageDraft({
      customerName: customerRecord.fullName,
      quoteTitle: quoteForSend.title,
      quoteTotalAmount: quoteForSend.totalAmount,
      scopeText: quoteForSend.scopeText,
      branding,
    });
    setSendComposer({
      channel, quoteId: quoteForSend.id,
      idempotencyKey: createSendIdempotencyKey(),
      customerName: customerRecord.fullName, customerEmail: customerRecord.email ?? null, customerPhone: customerRecord.phone,
      subject: draft.subject, body: draft.body,
    });
  }, [selectedQuote, customers, branding]);

  const confirmSendComposer = useCallback(async () => {
    if (!sendComposer) return;
    setSaving(true); setError(null);
    try {
      if (sendComposer.handoffComplete) {
        await api.quotes.confirmSend(sendComposer.quoteId, {
          channel: sendComposer.confirmedChannel ?? mapSendChannelToOutboundChannel(sendComposer.channel),
          idempotencyKey: sendComposer.idempotencyKey,
          destination:
            sendComposer.confirmedChannel === "NATIVE_SHARE"
              ? undefined
              : sendComposer.channel === "email"
                ? sendComposer.customerEmail ?? undefined
                : sendComposer.channel === "sms"
                  ? sendComposer.customerPhone
                  : undefined,
          subject: sendComposer.subject,
          body: sendComposer.body,
        });
        await Promise.all([
          loadQuotes(),
          loadQuoteDetail(sendComposer.quoteId, { includeOutboundEvents: false }),
          canViewCommunicationLog ? loadOutboundEvents(sendComposer.quoteId) : Promise.resolve(),
        ]);
        if (canViewQuoteHistory) void loadQuoteHistory();
        setNotice(canViewCommunicationLog ? "Quote marked sent and the communication was logged." : "Quote marked sent.");
        setSendComposer(null);
        return;
      }

      const activeQuote =
        selectedQuote?.id === sendComposer.quoteId
          ? selectedQuote
          : quotes.find((quote) => quote.id === sendComposer.quoteId) ?? null;

      if (sendComposer.channel === "email" && activeQuote && isLikelyMobileRuntime()) {
        const blob = await api.quotes.downloadPdf(sendComposer.quoteId);
        const shared = await sharePdfBlobNatively(blob, activeQuote.title, {
          subject: sendComposer.subject,
          body: sendComposer.body,
        });

        if (shared) {
          setSendComposer((current) => current ? { ...current, confirmedChannel: "NATIVE_SHARE", handoffComplete: true } : current);
          setNotice(
            `Share sheet completed. Confirm here after you send the quote through ${sendComposer.channel === "email" ? "Mail" : "Messages"}.`,
          );
          return;
        }
      }

      if (sendComposer.channel === "email") {
        setSendComposer((current) => current ? { ...current, confirmedChannel: "EMAIL_APP", handoffComplete: true } : current);
        const mailto = `mailto:${sendComposer.customerEmail ?? ""}?subject=${encodeURIComponent(sendComposer.subject)}&body=${encodeURIComponent(sendComposer.body)}`;
        window.location.assign(mailto);
        setNotice("Email app opened. Return here after sending to mark the quote sent.");
      } else if (sendComposer.channel === "sms") {
        setSendComposer((current) => current ? { ...current, confirmedChannel: "SMS_APP", handoffComplete: true } : current);
        window.location.assign(`sms:${toPhoneHrefValue(sendComposer.customerPhone)}?&body=${encodeURIComponent(sendComposer.body)}`);
        setNotice(`Text app opened for ${formatUsPhoneDisplay(sendComposer.customerPhone)}. Return here after sending to mark the quote sent.`);
      } else {
        if (!navigator.clipboard) throw new Error("Clipboard API is not available in this browser.");
        await navigator.clipboard.writeText(sendComposer.body);
        setSendComposer((current) => current ? { ...current, confirmedChannel: "COPY", handoffComplete: true } : current);
        setNotice("Message copied. Return here after sending to mark the quote sent.");
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      setError(err instanceof ApiError ? err.message : "Failed preparing outbound message.");
    } finally { setSaving(false); }
  }, [sendComposer, canViewCommunicationLog, canViewQuoteHistory, selectedQuote, quotes, loadQuotes, loadQuoteDetail, loadOutboundEvents, loadQuoteHistory]);

  const downloadQuotePdf = useCallback(async (options?: { inline?: boolean; quoteOverride?: Quote }) => {
    const quoteForDownload = options?.quoteOverride ?? selectedQuote;
    if (!quoteForDownload) return;
    setSaving(true); setError(null);
    try {
      const blob = await api.quotes.downloadPdf(quoteForDownload.id, { inline: options?.inline });
      if (options?.inline) {
        openPdfPreviewBlob(blob);
      } else {
        const fileName = `${fileLabel(quoteForDownload.title)}.pdf`;
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl; anchor.download = fileName;
        document.body.appendChild(anchor); anchor.click(); anchor.remove();
        URL.revokeObjectURL(objectUrl);
      }
      await Promise.all([
        loadQuotes(),
        loadQuoteDetail(quoteForDownload.id, { includeOutboundEvents: false }),
      ]);
      setNotice(options?.inline ? "PDF preview opened." : "PDF downloaded.");
    } catch (err) { setError(err instanceof ApiError ? err.message : "Failed generating PDF."); } finally { setSaving(false); }
  }, [selectedQuote, loadQuotes, loadQuoteDetail]);

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
    if (!selectedQuote) return false;
    setSaving(true); setError(null); setNotice(null);
    try {
      await api.quotes.lineItems.create(selectedQuote.id, {
        description: input.description,
        sectionType: input.sectionType,
        sectionLabel: input.sectionLabel,
        quantity: input.quantity,
        unitCost: input.unitCost,
        unitPrice: input.unitPrice,
      });
      if (options?.resetForm !== false) {
        setLineItemForm(EMPTY_LINE_ITEM);
      }
      await Promise.all([
        loadQuotes(),
        loadQuoteDetail(selectedQuote.id, { includeOutboundEvents: false }),
      ]);
      if (canViewQuoteHistory) void loadQuoteHistory();
      setNotice(options?.notice ?? "Line item added.");
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The line could not be added. Check the fields and try again.");
      return false;
    } finally { setSaving(false); }
  }, [selectedQuote, canViewQuoteHistory, loadQuotes, loadQuoteDetail, loadQuoteHistory]);

  const addLineItem = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    await addLineItemDraft({
      description: lineItemForm.description,
      quantity: Number(lineItemForm.quantity),
      unitCost: Number(lineItemForm.unitCost),
      unitPrice: Number(lineItemForm.unitPrice),
    });
  }, [lineItemForm, addLineItemDraft]);

  const updateLineItem = useCallback(async (
    lineItemId: string,
    input: Partial<CreateLineItemInput> & { description?: string },
    options?: { notice?: string },
  ) => {
    if (!selectedQuote) return false;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.quotes.lineItems.update(selectedQuote.id, lineItemId, input);
      await Promise.all([
        loadQuotes(),
        loadQuoteDetail(selectedQuote.id, { includeOutboundEvents: false }),
      ]);
      if (canViewQuoteHistory) void loadQuoteHistory();
      setNotice(options?.notice ?? "Line item updated.");
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The line could not be saved. Review it and try again.");
      return false;
    } finally {
      setSaving(false);
    }
  }, [selectedQuote, canViewQuoteHistory, loadQuotes, loadQuoteDetail, loadQuoteHistory]);

  const deleteLineItem = useCallback(async (lineItemId: string) => {
    if (!selectedQuote) return;
    setSaving(true); setError(null);
    try {
      await api.quotes.lineItems.remove(selectedQuote.id, lineItemId);
      await Promise.all([
        loadQuotes(),
        loadQuoteDetail(selectedQuote.id, { includeOutboundEvents: false }),
      ]);
      if (canViewQuoteHistory) void loadQuoteHistory();
      notify.success("Line item deleted", { description: "Quote totals were recalculated." });
    } catch (err) {
      notify.error("Line item could not be deleted", {
        description: err instanceof ApiError ? err.message : "Please try again. The quote was not changed.",
      });
    } finally { setSaving(false); }
  }, [selectedQuote, canViewQuoteHistory, loadQuotes, loadQuoteDetail, loadQuoteHistory]);

  const updateLeadFollowUpStatus = useCallback(async (customerId: string, followUpStatus: LeadFollowUpStatus) => {
    setSaving(true); setError(null);
    try {
      await api.customers.update(customerId, { followUpStatus });
      await Promise.all([loadCustomers(), loadQuotes()]);
      if (selectedQuote) await loadQuoteDetail(selectedQuote.id, { includeOutboundEvents: false });
      setNotice(`Follow-up status updated to ${followUpLabel(followUpStatus)}.`);
    } catch (err) { setError(err instanceof ApiError ? err.message : "Failed updating follow-up status."); } finally { setSaving(false); }
  }, [selectedQuote, loadCustomers, loadQuotes, loadQuoteDetail]);

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
    return summarizeQuoteMath({ internalCostSubtotal: selectedQuote.internalCostSubtotal ?? 0, customerPriceSubtotal: selectedQuote.customerPriceSubtotal, taxAmount: quoteEditForm.taxAmount });
  }, [selectedQuote, quoteEditForm.taxAmount]);

  const lineItemMath = useMemo(() => {
    const quantity = safeAmount(lineItemForm.quantity);
    const unitCost = safeAmount(lineItemForm.unitCost);
    const unitPrice = safeAmount(lineItemForm.unitPrice);
    return { quantity, costTotal: quantity * unitCost, priceTotal: quantity * unitPrice, profit: quantity * unitPrice - quantity * unitCost };
  }, [lineItemForm.quantity, lineItemForm.unitCost, lineItemForm.unitPrice]);

  const value: DashboardContextValue = {
    session, customers, quotes, branding, selectedQuoteId, selectedQuote, quoteDetailLoading, quoteDetailError, quoteHistory, outboundEvents,
    search, statusFilter, loading, saving, error, notice,
    historyMode, historyCustomerId, historyLoading, outboundEventsLoading,
    customerForm, quoteForm, quoteEditForm, lineItemForm,
    chatPrompt, chatParsed, setupTrade, setupSqFtMode, setupSqFtUnitCost, setupSqFtUnitPrice, recommendedPresetCount,
    duplicateModal, sendComposer,
    canUseChatToQuote, aiQuoteLimit, canViewQuoteHistory, canViewCommunicationLog,
    canViewInternalCosts: session?.role !== "member",
    canManageCatalog: session?.role === "owner" || session?.role === "admin",
    canManageAssignments: session?.role === "owner" || session?.role === "admin",
    canManageRecordRetention: session?.role === "owner" || session?.role === "admin",
    currentPlanLabel, canAutoUpgradeMessage,
    stats, pipeline, createQuoteMath, selectedQuoteMath, lineItemMath,
    setSearch, setStatusFilter, setError, setNotice, setHistoryMode, setHistoryCustomerId,
    setCustomerForm, setQuoteForm, setQuoteEditForm, setLineItemForm,
    setChatPrompt, setChatParsed, setSetupTrade, setSetupSqFtMode, setSetupSqFtUnitCost, setSetupSqFtUnitPrice,
    setDuplicateModal, setSendComposer,
    loadAll, loadQuotes, loadCustomers, loadQuoteHistory, refreshSelectedQuote, retrySelectedQuote,
    focusQuoteDesk, selectQuoteCustomer, navigateToBuilder, createCustomer, mergeDuplicateCustomer, createDuplicateAsNew,
    createQuoteFromChatPrompt, applyTradeSetup, createQuoteDraftFromForm, createQuote, persistSelectedQuote, saveQuoteSheet, updateQuoteLifecycle, saveQuote,
    sendDecision, openSendComposer, confirmSendComposer,
    downloadQuotePdf, exportQuotesAsInvoicesCsv,
    addLineItem, addLineItemDraft, updateLineItem, deleteLineItem, updateLeadFollowUpStatus, loadOutboundEvents, navigateToQuote,
  };

  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}
