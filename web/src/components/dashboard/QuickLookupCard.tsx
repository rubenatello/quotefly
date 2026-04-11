import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Search } from "lucide-react";
import { money } from "./DashboardContext";
import { QuoteStatusPill } from "./DashboardUi";
import { CustomerIcon, EmailIcon, MessageIcon, QuoteIcon } from "../Icons";
import { Button, Card, CardHeader, EmptyState, Input, Skeleton } from "../ui";
import { api, ApiError, type Customer, type Quote } from "../../lib/api";

type ActionVariant = "primary" | "secondary" | "outline" | "ghost";

interface QuickLookupCardProps {
  title?: string;
  subtitle?: string;
  customerActionLabel: string;
  customerActionVariant?: ActionVariant;
  onCustomerAction: (customer: Customer) => void;
  onQuoteAction: (quote: Quote) => void;
  activeCustomerId?: string;
  activeQuoteId?: string | null;
  className?: string;
}

export function QuickLookupCard({
  title = "Find Customer or Quote",
  subtitle = "Search by customer name, phone, email, or quote title before creating anything new.",
  customerActionLabel,
  customerActionVariant = "outline",
  onCustomerAction,
  onQuoteAction,
  activeCustomerId,
  activeQuoteId,
  className = "",
}: QuickLookupCardProps) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [quotes, setQuotes] = useState<Quote[]>([]);

  useEffect(() => {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length < 2) {
      setCustomers([]);
      setQuotes([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const [customerResponse, quoteResponse] = await Promise.all([
          api.customers.list({ search: trimmedQuery, limit: 6 }),
          api.quotes.list({ search: trimmedQuery, limit: 6 }),
        ]);

        if (cancelled) return;
        setCustomers(customerResponse.customers);
        setQuotes(quoteResponse.quotes);
      } catch (lookupError) {
        if (cancelled) return;
        setCustomers([]);
        setQuotes([]);
        setError(lookupError instanceof ApiError ? lookupError.message : "Lookup failed.");
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }, 220);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const hasQuery = query.trim().length >= 2;
  const hasResults = customers.length > 0 || quotes.length > 0;

  return (
    <Card variant="elevated" padding="lg" className={className}>
      <CardHeader title={title} subtitle={subtitle} />

      <div className="space-y-4">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search customer name, phone, email, or quote title"
          icon={<Search size={16} />}
        />

        {error ? <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}

        {!hasQuery && !loading ? (
          <EmptyState
            icon={<Search size={18} />}
            title="Start typing to search"
            description="Type at least two characters to look up customers and quotes."
          />
        ) : null}

        {loading ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <LookupSkeletonSection title="Customers" />
            <LookupSkeletonSection title="Quotes" />
          </div>
        ) : null}

        {hasQuery && !loading ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <LookupSection
              title="Customers"
              emptyLabel="No customers matched this search."
              results={customers.map((customer) => (
                <LookupResultCard
                  key={customer.id}
                  icon={<CustomerIcon size={15} />}
                  active={customer.id === activeCustomerId}
                  title={customer.fullName}
                  meta={[
                    { icon: <MessageIcon size={12} />, label: customer.phone },
                    ...(customer.email ? [{ icon: <EmailIcon size={12} />, label: customer.email }] : []),
                  ]}
                  actionLabel={customer.id === activeCustomerId ? "Selected" : customerActionLabel}
                  actionVariant={customer.id === activeCustomerId ? "ghost" : customerActionVariant}
                  actionDisabled={customer.id === activeCustomerId}
                  onAction={() => onCustomerAction(customer)}
                />
              ))}
            />

            <LookupSection
              title="Quotes"
              emptyLabel="No quotes matched this search."
              results={quotes.map((quote) => (
                <LookupResultCard
                  key={quote.id}
                  icon={<QuoteIcon size={15} />}
                  active={quote.id === activeQuoteId}
                  title={quote.title}
                  meta={[
                    { label: quote.customer?.fullName ?? "Customer unavailable" },
                    { label: money(quote.totalAmount) },
                  ]}
                  aside={<QuoteStatusPill status={quote.status} compact />}
                  actionLabel={quote.id === activeQuoteId ? "Open Now" : "Open Quote"}
                  actionVariant={quote.id === activeQuoteId ? "ghost" : "outline"}
                  actionDisabled={quote.id === activeQuoteId}
                  onAction={() => onQuoteAction(quote)}
                />
              ))}
            />
          </div>
        ) : null}

        {hasQuery && !loading && !hasResults ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-600">
            Nothing matched. Try a customer phone number, customer email, or part of the quote title.
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function LookupSection({
  title,
  emptyLabel,
  results,
}: {
  title: string;
  emptyLabel: string;
  results: ReactNode[];
}) {
  return (
    <div className="rounded-[24px] border border-slate-200 bg-[linear-gradient(180deg,rgba(255,255,255,1)_0%,rgba(248,250,252,1)_100%)] p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-900">{title}</p>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">{results.length}</span>
      </div>
      <div className="space-y-3">
        {results.length ? results : <p className="rounded-2xl border border-dashed border-slate-300 bg-white px-3 py-4 text-sm text-slate-500">{emptyLabel}</p>}
      </div>
    </div>
  );
}

function LookupResultCard({
  icon,
  title,
  meta,
  aside,
  active,
  actionLabel,
  actionVariant,
  actionDisabled,
  onAction,
}: {
  icon: ReactNode;
  title: string;
  meta: Array<{ icon?: ReactNode; label: string }>;
  aside?: ReactNode;
  active?: boolean;
  actionLabel: string;
  actionVariant: ActionVariant;
  actionDisabled?: boolean;
  onAction: () => void;
}) {
  return (
    <div
      className={`rounded-[22px] border p-3 shadow-sm transition ${
        active
          ? "border-quotefly-blue/25 bg-[linear-gradient(180deg,rgba(91,133,170,0.14)_0%,rgba(255,255,255,1)_100%)]"
          : "border-slate-200 bg-white"
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-slate-100 text-slate-600">
              {icon}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900">{title}</p>
              {aside ? <div className="mt-1">{aside}</div> : null}
            </div>
          </div>

          <div className="mt-3 space-y-1.5">
            {meta.map((item, index) => (
              <p key={`${item.label}-${index}`} className="flex items-center gap-2 text-xs text-slate-600">
                {item.icon ? <span className="text-slate-400">{item.icon}</span> : null}
                <span className="truncate">{item.label}</span>
              </p>
            ))}
          </div>
        </div>

        <Button type="button" size="sm" variant={actionVariant} onClick={onAction} disabled={actionDisabled}>
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}

function LookupSkeletonSection({ title }: { title: string }) {
  return (
    <div className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-900">{title}</p>
        <Skeleton className="h-5 w-8 rounded-full" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-28 w-full rounded-[22px]" />
        <Skeleton className="h-28 w-full rounded-[22px]" />
      </div>
    </div>
  );
}
