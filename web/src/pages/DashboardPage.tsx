import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { CustomerIcon, DeleteIcon, InvoiceIcon, QuoteIcon, SendIcon } from "../components/Icons";
import {
  api,
  ApiError,
  type Customer,
  type Quote,
  type QuoteRevision,
  type QuoteStatus,
  type ServiceType,
} from "../lib/api";
import { setSEOMetadata } from "../lib/seo";

interface DashboardPageProps {
  session?: { email: string; fullName: string; tenantId: string } | null;
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
type LeadCardItem = {
  customerId: string;
  customerName: string;
  phone: string;
  quoteId?: string;
  quoteTitle?: string;
  totalAmount?: number;
  status?: QuoteStatus;
  createdAt: string;
};

const SERVICE_TYPES: ServiceType[] = ["HVAC", "PLUMBING", "FLOORING", "ROOFING", "GARDENING"];
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

function money(value: string | number): string {
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : "$0.00";
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

function statusClass(status: QuoteStatus): string {
  if (status === "ACCEPTED") return "text-emerald-300 border-emerald-500/40 bg-emerald-500/10";
  if (status === "REJECTED") return "text-rose-300 border-rose-500/40 bg-rose-500/10";
  if (status === "SENT_TO_CUSTOMER") return "text-sky-300 border-sky-500/40 bg-sky-500/10";
  if (status === "READY_FOR_REVIEW") return "text-amber-300 border-amber-500/40 bg-amber-500/10";
  return "text-zinc-300 border-zinc-600 bg-zinc-700/30";
}

function eventLabel(eventType: QuoteRevision["eventType"]): string {
  if (eventType === "CREATED") return "Created";
  if (eventType === "STATUS_CHANGED") return "Status";
  if (eventType === "LINE_ITEM_CHANGED") return "Line Items";
  if (eventType === "DECISION") return "Decision";
  return "Updated";
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
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
  const [historyMode, setHistoryMode] = useState<HistoryMode>("quote");
  const [historyCustomerId, setHistoryCustomerId] = useState<string>("ALL");
  const [historyLoading, setHistoryLoading] = useState(false);

  const [customerForm, setCustomerForm] = useState<CustomerForm>(EMPTY_CUSTOMER);
  const [quoteForm, setQuoteForm] = useState<QuoteForm>(EMPTY_QUOTE);
  const [quoteEditForm, setQuoteEditForm] = useState<QuoteEditForm>(EMPTY_EDIT);
  const [lineItemForm, setLineItemForm] = useState<LineItemForm>(EMPTY_LINE_ITEM);

  useEffect(() => {
    setSEOMetadata({
      title: "CRM Dashboard",
      description: "QuoteFly CRM workspace for customer and quote management.",
    });
    void loadAll();
  }, []);

  useEffect(() => {
    if (!selectedQuoteId) return;
    void loadQuoteDetail(selectedQuoteId);
  }, [selectedQuoteId]);

  useEffect(() => {
    void loadQuoteHistory();
  }, [historyMode, historyCustomerId, selectedQuoteId]);

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [customerRes, quoteRes] = await Promise.all([api.customers.list({ limit: 200 }), api.quotes.list({ limit: 100 })]);
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
      const res = await api.customers.list({ limit: 200 });
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
      setQuoteEditForm({
        serviceType: quote.serviceType,
        status: quote.status,
        title: quote.title,
        scopeText: quote.scopeText,
        taxAmount: String(Number(quote.taxAmount)),
      });
    } catch (err) {
      setSelectedQuote(null);
      setError(err instanceof ApiError ? err.message : "Failed loading quote detail.");
    }
  }

  async function loadQuoteHistory() {
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

  async function createCustomer(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const result = await api.customers.create({
        fullName: customerForm.fullName,
        phone: customerForm.phone,
        email: customerForm.email || null,
      });
      setCustomerForm(EMPTY_CUSTOMER);
      setNotice(result.restored ? "Customer restored." : "Customer created.");
      await loadCustomers();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed creating customer.");
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
      setSelectedQuoteId(quote.id);
      setNotice("Quote created.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed creating quote.");
    } finally {
      setSaving(false);
    }
  }

  async function saveQuote(event: FormEvent) {
    event.preventDefault();
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
      await loadQuoteHistory();
      setNotice("Quote updated.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed saving quote.");
    } finally {
      setSaving(false);
    }
  }

  async function sendDecision(decision: "send" | "revise") {
    if (!selectedQuote) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.quotes.decision(selectedQuote.id, decision);
      await Promise.all([loadQuotes(), loadQuoteDetail(selectedQuote.id)]);
      await loadQuoteHistory();
      setNotice(result.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed updating decision.");
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
      await loadQuoteHistory();
      setNotice("Line item added.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed adding line item.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteLineItem(lineItemId: string) {
    if (!selectedQuote) return;
    if (!confirm("Delete this line item?")) return;
    setSaving(true);
    setError(null);
    try {
      await api.quotes.lineItems.remove(selectedQuote.id, lineItemId);
      await Promise.all([loadQuotes(), loadQuoteDetail(selectedQuote.id)]);
      await loadQuoteHistory();
      setNotice("Line item deleted.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed deleting line item.");
    } finally {
      setSaving(false);
    }
  }

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
        createdAt: customer.createdAt,
      }));

    const newLeads: LeadCardItem[] = [];
    const quotedLeads: LeadCardItem[] = [];
    const closedLeads: LeadCardItem[] = [];

    for (const customer of customers) {
      const latestQuote = latestByCustomer.get(customer.id);
      const baseItem: LeadCardItem = {
        customerId: customer.id,
        customerName: customer.fullName,
        phone: customer.phone,
        quoteId: latestQuote?.id,
        quoteTitle: latestQuote?.title,
        totalAmount: latestQuote ? Number(latestQuote.totalAmount) : undefined,
        status: latestQuote?.status,
        createdAt: latestQuote?.updatedAt ?? customer.createdAt,
      };

      if (!latestQuote || latestQuote.status === "DRAFT") {
        newLeads.push(baseItem);
        continue;
      }

      if (latestQuote.status === "ACCEPTED") {
        closedLeads.push(baseItem);
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
      totals: {
        newLeads: newLeads.length,
        quotedLeads: quotedLeads.length,
        closedLeads: closedLeads.length,
      },
    };
  }, [customers, quotes]);

  if (loading) {
    return <div className="min-h-screen bg-zinc-950 p-6 text-zinc-300">Loading dashboard...</div>;
  }

  return (
    <div className="min-h-screen bg-zinc-950 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-white">
            {session?.fullName ? `Welcome, ${session.fullName.split(" ")[0]}` : "QuoteFly CRM"}
          </h1>
          <p className="mt-2 text-zinc-400">Easy quote flow with full detail controls when needed.</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard icon={<QuoteIcon size={24} />} label="Quotes This Month" value={String(stats.monthlyQuotes)} />
          <StatCard icon={<CustomerIcon size={24} />} label="Active Customers" value={String(customers.length)} />
          <StatCard icon={<InvoiceIcon size={24} />} label="Accepted Revenue" value={money(stats.acceptedRevenue)} />
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
          <div className="mb-4">
            <h2 className="text-xl font-semibold text-white">Lead Pipeline</h2>
            <p className="text-sm text-zinc-400">
              New leads, quoted jobs, and closed work at a glance.
            </p>
          </div>
          <div className="grid gap-4 lg:grid-cols-4">
            <PipelineColumn
              title={`New Leads (${pipeline.totals.newLeads})`}
              subtitle="No quote yet or still draft"
              leads={pipeline.newLeads}
              emptyLabel="No leads waiting for first quote."
              onSelectLead={(quoteId) => setSelectedQuoteId(quoteId ?? null)}
            />
            <PipelineColumn
              title={`Quoted Leads (${pipeline.totals.quotedLeads})`}
              subtitle="Quote prepared or sent"
              leads={pipeline.quotedLeads}
              emptyLabel="No active quoted leads."
              onSelectLead={(quoteId) => setSelectedQuoteId(quoteId ?? null)}
            />
            <PipelineColumn
              title={`Closed Leads (${pipeline.totals.closedLeads})`}
              subtitle="Accepted, work in progress"
              leads={pipeline.closedLeads}
              emptyLabel="No closed deals yet."
              onSelectLead={(quoteId) => setSelectedQuoteId(quoteId ?? null)}
            />
            <PipelineColumn
              title="Recently Added Leads"
              subtitle="Most recent customer records"
              leads={pipeline.recentLeads}
              emptyLabel="No customers added yet."
              onSelectLead={(quoteId) => setSelectedQuoteId(quoteId ?? null)}
            />
          </div>
        </div>

        {error && <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-200">{error}</p>}
        {notice && <p className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-200">{notice}</p>}

        <div className="grid gap-6 xl:grid-cols-[390px_1fr]">
          <div className="space-y-6">
            <form onSubmit={createCustomer} className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
              <h2 className="text-lg font-semibold text-white">Quick Customer</h2>
              <input placeholder="Full name" required value={customerForm.fullName} onChange={(event) => setCustomerForm((prev) => ({ ...prev, fullName: event.target.value }))} className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white" />
              <input placeholder="Phone" required value={customerForm.phone} onChange={(event) => setCustomerForm((prev) => ({ ...prev, phone: event.target.value }))} className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white" />
              <input placeholder="Email (optional)" type="email" value={customerForm.email} onChange={(event) => setCustomerForm((prev) => ({ ...prev, email: event.target.value }))} className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white" />
              <button type="submit" disabled={saving} className="w-full rounded-lg bg-quotefly-blue px-4 py-2 text-sm font-semibold text-white">{saving ? "Saving..." : "Create Customer"}</button>
            </form>

            <form onSubmit={createQuote} className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
              <h2 className="text-lg font-semibold text-white">Create Quote</h2>
              <select value={quoteForm.customerId} required onChange={(event) => setQuoteForm((prev) => ({ ...prev, customerId: event.target.value }))} className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white">
                <option value="">Select customer</option>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>{customer.fullName} ({customer.phone})</option>
                ))}
              </select>
              <select value={quoteForm.serviceType} onChange={(event) => setQuoteForm((prev) => ({ ...prev, serviceType: event.target.value as ServiceType }))} className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white">
                {SERVICE_TYPES.map((serviceType) => <option key={serviceType} value={serviceType}>{serviceType}</option>)}
              </select>
              <input placeholder="Title" required value={quoteForm.title} onChange={(event) => setQuoteForm((prev) => ({ ...prev, title: event.target.value }))} className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white" />
              <textarea placeholder="Scope details" required rows={3} value={quoteForm.scopeText} onChange={(event) => setQuoteForm((prev) => ({ ...prev, scopeText: event.target.value }))} className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white" />
              <div className="grid grid-cols-3 gap-2">
                <input type="number" min="0" step="0.01" placeholder="Internal" value={quoteForm.internalCostSubtotal} onChange={(event) => setQuoteForm((prev) => ({ ...prev, internalCostSubtotal: event.target.value }))} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-white" />
                <input type="number" min="0" step="0.01" placeholder="Customer" value={quoteForm.customerPriceSubtotal} onChange={(event) => setQuoteForm((prev) => ({ ...prev, customerPriceSubtotal: event.target.value }))} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-white" />
                <input type="number" min="0" step="0.01" placeholder="Tax" value={quoteForm.taxAmount} onChange={(event) => setQuoteForm((prev) => ({ ...prev, taxAmount: event.target.value }))} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-white" />
              </div>
              <button type="submit" disabled={saving || !customers.length} className="w-full rounded-lg bg-quotefly-blue px-4 py-2 text-sm font-semibold text-white">{saving ? "Saving..." : "Create Quote"}</button>
            </form>

            <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
              <h2 className="mb-3 text-lg font-semibold text-white">Quote List</h2>
              <div className="mb-2 grid grid-cols-[1fr_140px] gap-2">
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search quotes" className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white" />
                <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as QuoteStatus | "ALL")} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white">
                  <option value="ALL">All statuses</option>
                  {QUOTE_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
                </select>
              </div>
              <button onClick={() => void loadQuotes()} className="mb-3 w-full rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300">Apply Filters</button>
              <div className="max-h-[340px] space-y-2 overflow-auto">
                {quotes.map((quote) => (
                  <button key={quote.id} onClick={() => setSelectedQuoteId(quote.id)} className={`w-full rounded-lg border p-3 text-left ${selectedQuoteId === quote.id ? "border-quotefly-blue bg-quotefly-blue/10" : "border-zinc-800 bg-zinc-950/60"}`}>
                    <p className="text-sm font-semibold text-white">{quote.title}</p>
                    <div className="mt-1 flex items-center justify-between">
                      <span className={`rounded-md border px-2 py-0.5 text-[10px] ${statusClass(quote.status)}`}>{quote.status}</span>
                      <span className="text-xs text-zinc-400">{money(quote.totalAmount)}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
            {!selectedQuote ? (
              <p className="rounded-lg border border-dashed border-zinc-700 p-8 text-center text-zinc-500">Select a quote to view details.</p>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <h2 className="text-xl font-semibold text-white">{selectedQuote.title}</h2>
                  <span className={`rounded-md border px-2 py-1 text-xs ${statusClass(selectedQuote.status)}`}>{selectedQuote.status}</span>
                </div>
                <p className="text-xs text-zinc-400">Customer: {selectedQuote.customer?.fullName ?? selectedQuote.customerId}</p>

                <form onSubmit={saveQuote} className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4">
                  <div className="grid gap-2 sm:grid-cols-3">
                    <select value={quoteEditForm.serviceType} onChange={(event) => setQuoteEditForm((prev) => ({ ...prev, serviceType: event.target.value as ServiceType }))} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-white">
                      {SERVICE_TYPES.map((serviceType) => <option key={serviceType} value={serviceType}>{serviceType}</option>)}
                    </select>
                    <select value={quoteEditForm.status} onChange={(event) => setQuoteEditForm((prev) => ({ ...prev, status: event.target.value as QuoteStatus }))} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-white">
                      {QUOTE_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
                    </select>
                    <input type="number" min="0" step="0.01" placeholder="Tax amount" value={quoteEditForm.taxAmount} onChange={(event) => setQuoteEditForm((prev) => ({ ...prev, taxAmount: event.target.value }))} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-white" />
                  </div>
                  <input value={quoteEditForm.title} onChange={(event) => setQuoteEditForm((prev) => ({ ...prev, title: event.target.value }))} className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white" />
                  <textarea rows={3} value={quoteEditForm.scopeText} onChange={(event) => setQuoteEditForm((prev) => ({ ...prev, scopeText: event.target.value }))} className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white" />
                  <div className="flex flex-wrap gap-2">
                    <button type="submit" disabled={saving} className="rounded-lg bg-quotefly-blue px-4 py-2 text-sm font-semibold text-white">Save Quote</button>
                    <button type="button" onClick={() => void sendDecision("send")} disabled={saving} className="inline-flex items-center gap-1 rounded-lg border border-sky-500/50 px-3 py-2 text-sm text-sky-300"><SendIcon size={14} />Send</button>
                    <button type="button" onClick={() => void sendDecision("revise")} disabled={saving} className="rounded-lg border border-amber-500/50 px-3 py-2 text-sm text-amber-300">Revise</button>
                    <button type="button" onClick={() => void downloadQuotePdf()} disabled={saving} className="rounded-lg border border-zinc-600 px-3 py-2 text-sm text-zinc-200">Download PDF</button>
                    <button type="button" onClick={() => void downloadQuotePdf({ afterSend: true })} disabled={saving} className="rounded-lg border border-emerald-500/50 px-3 py-2 text-sm text-emerald-300">Send + PDF</button>
                  </div>
                </form>

                <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4">
                  <h3 className="mb-3 text-sm font-semibold text-white">Line Items</h3>
                  <div className="space-y-2">
                    {(selectedQuote.lineItems ?? []).map((item) => (
                      <div key={item.id} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
                        <div>
                          <p className="text-sm text-white">{item.description}</p>
                          <p className="text-xs text-zinc-400">Qty {Number(item.quantity)} · {money(item.unitPrice)}</p>
                        </div>
                        <button onClick={() => void deleteLineItem(item.id)} className="inline-flex items-center gap-1 rounded-md border border-red-500/50 px-2 py-1 text-xs text-red-300"><DeleteIcon size={12} />Delete</button>
                      </div>
                    ))}
                  </div>
                  <form onSubmit={addLineItem} className="mt-3 space-y-2 border-t border-zinc-800 pt-3">
                    <input placeholder="Description" value={lineItemForm.description} onChange={(event) => setLineItemForm((prev) => ({ ...prev, description: event.target.value }))} className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white" />
                    <div className="grid grid-cols-3 gap-2">
                      <input type="number" min="0" step="0.01" value={lineItemForm.quantity} onChange={(event) => setLineItemForm((prev) => ({ ...prev, quantity: event.target.value }))} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-white" />
                      <input type="number" min="0" step="0.01" value={lineItemForm.unitCost} onChange={(event) => setLineItemForm((prev) => ({ ...prev, unitCost: event.target.value }))} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-white" />
                      <input type="number" min="0" step="0.01" value={lineItemForm.unitPrice} onChange={(event) => setLineItemForm((prev) => ({ ...prev, unitPrice: event.target.value }))} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-white" />
                    </div>
                    <button type="submit" disabled={saving} className="rounded-lg bg-quotefly-blue px-4 py-2 text-sm font-semibold text-white">Add Line Item</button>
                  </form>
                </div>

                <div className="grid grid-cols-2 gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 sm:grid-cols-4">
                  <Metric label="Internal" value={money(selectedQuote.internalCostSubtotal)} />
                  <Metric label="Customer" value={money(selectedQuote.customerPriceSubtotal)} />
                  <Metric label="Tax" value={money(selectedQuote.taxAmount)} />
                  <Metric label="Total" value={money(selectedQuote.totalAmount)} />
                </div>

                <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-white">Quote Revision History</h3>
                      <p className="text-xs text-zinc-400">
                        Track original quote values, revisions, and decision changes.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void loadQuoteHistory()}
                      className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300"
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
                          : "border-zinc-700 text-zinc-300"
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
                          : "border-zinc-700 text-zinc-300"
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
                          : "border-zinc-700 text-zinc-300"
                      }`}
                    >
                      All Activity
                    </button>

                    {historyMode === "customer" && (
                      <select
                        value={historyCustomerId}
                        onChange={(event) => setHistoryCustomerId(event.target.value)}
                        className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-white"
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
                    <p className="rounded-md border border-zinc-800 px-3 py-2 text-xs text-zinc-400">
                      Loading revision history...
                    </p>
                  ) : quoteHistory.length === 0 ? (
                    <p className="rounded-md border border-zinc-800 px-3 py-2 text-xs text-zinc-500">
                      No history entries for this filter yet.
                    </p>
                  ) : (
                    <div className="max-h-64 space-y-2 overflow-auto">
                      {quoteHistory.map((revision) => (
                        <div
                          key={revision.id}
                          className="rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm font-medium text-white">
                              v{revision.version} · {eventLabel(revision.eventType)} · {revision.title}
                            </p>
                            <p className="text-xs text-zinc-400">{formatDateTime(revision.createdAt)}</p>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs">
                            <p className="text-zinc-400">
                              Customer: {revision.customer.fullName} · Status: {revision.status}
                            </p>
                            <p className="text-zinc-300">
                              Subtotal {money(revision.customerPriceSubtotal)} · Total {money(revision.totalAmount)}
                            </p>
                          </div>
                          {revision.changedFields.length > 0 && (
                            <p className="mt-1 text-[11px] text-zinc-500">
                              Fields: {revision.changedFields.join(", ")}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="mb-2 text-quotefly-blue">{icon}</div>
      <p className="text-xs uppercase text-zinc-400">{label}</p>
      <p className="text-2xl font-bold text-white">{value}</p>
    </div>
  );
}

function PipelineColumn({
  title,
  subtitle,
  leads,
  emptyLabel,
  onSelectLead,
}: {
  title: string;
  subtitle: string;
  leads: LeadCardItem[];
  emptyLabel: string;
  onSelectLead: (quoteId?: string) => void;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      <p className="mb-3 text-xs text-zinc-500">{subtitle}</p>
      {leads.length === 0 ? (
        <p className="rounded-md border border-dashed border-zinc-700 px-2 py-3 text-xs text-zinc-500">
          {emptyLabel}
        </p>
      ) : (
        <div className="max-h-64 space-y-2 overflow-auto">
          {leads.map((lead) => (
            <button
              key={`${lead.customerId}-${lead.quoteId ?? "lead"}`}
              type="button"
              onClick={() => onSelectLead(lead.quoteId)}
              disabled={!lead.quoteId}
              className="w-full rounded-md border border-zinc-800 bg-zinc-900/40 px-2 py-2 text-left transition hover:border-zinc-700 disabled:cursor-not-allowed disabled:opacity-90"
            >
              <p className="text-sm font-medium text-zinc-100">{lead.customerName}</p>
              <p className="text-xs text-zinc-400">{lead.phone}</p>
              {lead.quoteTitle && (
                <p className="mt-1 text-xs text-zinc-300">
                  {lead.quoteTitle} · {lead.totalAmount !== undefined ? money(lead.totalAmount) : ""}
                </p>
              )}
              {lead.status && (
                <span className={`mt-2 inline-block rounded-md border px-1.5 py-0.5 text-[10px] ${statusClass(lead.status)}`}>
                  {lead.status}
                </span>
              )}
              {!lead.quoteId && <p className="mt-1 text-[11px] text-zinc-500">No quote attached yet</p>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase text-zinc-500">{label}</p>
      <p className="text-base font-semibold text-white">{value}</p>
    </div>
  );
}


