import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { money } from "./DashboardContext";
import { QuoteStatusPill } from "./DashboardUi";
import { CustomerIcon, EmailIcon, MessageIcon, QuoteIcon } from "../Icons";
import { Button, Card, CardHeader, EmptyState, Input, Skeleton } from "../ui";
import { api, type Customer, type Quote } from "../../lib/api";
import { localizedApiError } from "../../lib/localized-api-error";
import { formatUsPhoneDisplay } from "../../lib/phone";

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
  title,
  subtitle,
  customerActionLabel,
  customerActionVariant = "outline",
  onCustomerAction,
  onQuoteAction,
  activeCustomerId,
  activeQuoteId,
  className = "",
}: QuickLookupCardProps) {
  const { t, i18n } = useTranslation();
  const formatMoney = (value: string | number) => money(value, i18n.resolvedLanguage ?? "en-US");
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
        setError(localizedApiError(lookupError, t, { fallbackKey: "quoteComponents.quickLookup.error" }));
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
  }, [query, t]);

  const hasQuery = query.trim().length >= 2;
  const hasResults = customers.length > 0 || quotes.length > 0;

  return (
    <Card variant="default" padding="md" className={className}>
      <CardHeader
        title={title ?? t("quoteComponents.quickLookup.title")}
        subtitle={subtitle ?? t("quoteComponents.quickLookup.subtitle")}
      />

      <div className="space-y-3">
        <Input
          aria-label={t("quoteComponents.quickLookup.searchLabel")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("quoteComponents.quickLookup.searchPlaceholder")}
          icon={<Search size={16} />}
        />

        {error ? <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}

        {!hasQuery && !loading ? (
          <EmptyState
            icon={<Search size={18} />}
            title={t("quoteComponents.quickLookup.start")}
            description={t("quoteComponents.quickLookup.startDescription")}
          />
        ) : null}

        {loading ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <LookupSkeletonSection title={t("quoteComponents.quickLookup.customers")} />
            <LookupSkeletonSection title={t("quoteComponents.quickLookup.quotes")} />
          </div>
        ) : null}

        {hasQuery && !loading ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <LookupSection
              title={t("quoteComponents.quickLookup.customers")}
              emptyLabel={t("quoteComponents.quickLookup.noCustomers")}
              results={customers.map((customer) => (
                <LookupResultCard
                  key={customer.id}
                  icon={<CustomerIcon size={15} />}
                  active={customer.id === activeCustomerId}
                  title={customer.fullName}
                  meta={[
                    { icon: <MessageIcon size={12} />, label: formatUsPhoneDisplay(customer.phone) },
                    ...(customer.email ? [{ icon: <EmailIcon size={12} />, label: customer.email }] : []),
                  ]}
                  actionLabel={customer.id === activeCustomerId ? t("quoteComponents.quickLookup.selected") : customerActionLabel}
                  actionVariant={customer.id === activeCustomerId ? "ghost" : customerActionVariant}
                  actionDisabled={customer.id === activeCustomerId}
                  onAction={() => onCustomerAction(customer)}
                />
              ))}
            />

            <LookupSection
              title={t("quoteComponents.quickLookup.quotes")}
              emptyLabel={t("quoteComponents.quickLookup.noQuotes")}
              results={quotes.map((quote) => (
                <LookupResultCard
                  key={quote.id}
                  icon={<QuoteIcon size={15} />}
                  active={quote.id === activeQuoteId}
                  title={quote.title}
                  meta={[
                    { label: quote.customer?.fullName ?? t("quoteComponents.quickLookup.customerUnavailable") },
                    { label: formatMoney(quote.totalAmount) },
                  ]}
                  aside={<QuoteStatusPill status={quote.status} compact />}
                  actionLabel={quote.id === activeQuoteId ? t("quoteComponents.quickLookup.openNow") : t("quoteComponents.quickLookup.openQuote")}
                  actionVariant={quote.id === activeQuoteId ? "ghost" : "outline"}
                  actionDisabled={quote.id === activeQuoteId}
                  onAction={() => onQuoteAction(quote)}
                />
              ))}
            />
          </div>
        ) : null}

        {hasQuery && !loading && !hasResults ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-600">
            {t("quoteComponents.quickLookup.none")}
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
    <div className="overflow-hidden rounded-[18px] border border-slate-200 bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
        <p className="text-sm font-semibold text-slate-900">{title}</p>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">{results.length}</span>
      </div>
      <div className="divide-y divide-slate-200">
        {results.length ? results : <p className="px-4 py-4 text-sm text-slate-500">{emptyLabel}</p>}
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
      className={`px-4 py-3 transition ${
        active
          ? "bg-quotefly-blue/[0.04]"
          : "bg-white hover:bg-slate-50/80"
      }`}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600">
              {icon}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900">{title}</p>
              {aside ? <div className="mt-1">{aside}</div> : null}
            </div>
          </div>

          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {meta.map((item, index) => (
              <p key={`${item.label}-${index}`} className="flex items-center gap-1.5 text-xs text-slate-600">
                {item.icon ? <span className="text-slate-400">{item.icon}</span> : null}
                <span className="truncate">{item.label}</span>
              </p>
            ))}
          </div>
        </div>

        <Button type="button" size="sm" variant={actionVariant} onClick={onAction} disabled={actionDisabled} className="md:shrink-0">
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}

function LookupSkeletonSection({ title }: { title: string }) {
  return (
    <div className="overflow-hidden rounded-[18px] border border-slate-200 bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
        <p className="text-sm font-semibold text-slate-900">{title}</p>
        <Skeleton className="h-5 w-8 rounded-full" />
      </div>
      <div className="space-y-0 divide-y divide-slate-200 p-0">
        <Skeleton className="h-20 w-full rounded-none" />
        <Skeleton className="h-20 w-full rounded-none" />
      </div>
    </div>
  );
}
