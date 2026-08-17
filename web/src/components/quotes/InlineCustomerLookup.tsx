import { useEffect, useState } from "react";
import { Mail, Phone, Search, UserRoundPlus } from "lucide-react";
import { api, ApiError, type Customer } from "../../lib/api";
import { formatUsPhoneDisplay } from "../../lib/phone";
import { Button } from "../ui";

interface InlineCustomerLookupProps {
  selectedCustomer: Customer | null;
  onSelectCustomer: (customer: Customer) => void;
  onAddCustomer: () => void;
}

export function InlineCustomerLookup({
  selectedCustomer,
  onSelectCustomer,
  onAddCustomer,
}: InlineCustomerLookupProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length < 2) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }

    if (selectedCustomer && trimmedQuery.toLowerCase() === selectedCustomer.fullName.trim().toLowerCase()) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await api.customers.list({ search: trimmedQuery, limit: 5 });
        if (cancelled) return;
        setResults(response.customers);
      } catch (lookupError) {
        if (cancelled) return;
        setResults([]);
        setError(lookupError instanceof ApiError ? lookupError.message : "Customer lookup failed.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, selectedCustomer]);

  return (
    <div className="w-full max-w-[560px]">
      <div className="relative">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--qf-text-muted)]" />
            <input
              aria-label="Find customer by name, phone, or email"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={
                selectedCustomer
                  ? "Find another customer by name, phone, or email"
                  : "Find customer by name, phone, or email"
              }
              className="min-h-[44px] w-full rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] pl-10 pr-3 text-sm text-[var(--qf-text)] placeholder:text-[var(--qf-text-muted)] transition hover:border-[var(--qf-border-strong)] focus:border-[var(--qf-focus)] focus:outline-none focus:ring-4 focus:ring-[var(--qf-focus-ring)] sm:min-h-[40px]"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={onAddCustomer}
            aria-label="Add Customer"
            icon={<UserRoundPlus size={15} />}
            className="shrink-0 sm:min-h-10"
          >
            <span className="sm:hidden">Add</span>
            <span className="hidden sm:inline">Add customer</span>
          </Button>
        </div>

        {query.trim().length >= 2 && query.trim().toLowerCase() !== selectedCustomer?.fullName.trim().toLowerCase() ? (
          <div id="inline-customer-results" className="absolute left-0 right-0 top-[calc(100%+8px)] z-30 overflow-hidden rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)] shadow-[var(--qf-shadow-md)]">
            {loading ? (
              <p role="status" className="px-3 py-3 text-sm text-[var(--qf-text-muted)]">Searching customers...</p>
            ) : error ? (
              <p role="alert" className="px-3 py-3 text-sm text-[var(--qf-danger-text)]">{error}</p>
            ) : results.length ? (
              <div className="max-h-[280px] divide-y divide-[var(--qf-border)] overflow-y-auto">
                {results.map((customer) => (
                  <button
                    key={customer.id}
                    type="button"
                    onClick={() => {
                      onSelectCustomer(customer);
                      setQuery(customer.fullName);
                      setResults([]);
                    }}
                    className="flex min-h-[44px] w-full items-center justify-between gap-3 px-3 py-3 text-left transition hover:bg-[var(--qf-interactive-hover)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--qf-focus)] sm:min-h-[40px]"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-[var(--qf-text)]">{customer.fullName}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--qf-text-muted)]">
                        <span className="inline-flex items-center gap-1">
                          <Phone size={12} />
                          {formatUsPhoneDisplay(customer.phone)}
                        </span>
                        {customer.email ? (
                          <span className="inline-flex min-w-0 items-center gap-1">
                            <Mail size={12} />
                            <span className="truncate">{customer.email}</span>
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <span className="rounded-full border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-2 py-1 text-[11px] font-semibold text-[var(--qf-text-soft)]">
                      Use
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="px-3 py-3 text-sm text-[var(--qf-text-muted)]">No customers matched that search.</p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
