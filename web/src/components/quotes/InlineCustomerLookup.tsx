import { useEffect, useState } from "react";
import { Mail, Phone, Search, UserRoundPlus } from "lucide-react";
import { api, ApiError, type Customer } from "../../lib/api";
import { formatUsPhoneDisplay } from "../../lib/phone";

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
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={
                selectedCustomer
                  ? "Find another customer by name, phone, or email"
                  : "Find customer by name, phone, or email"
              }
              className="min-h-[44px] w-full rounded-xl border border-slate-200 bg-white pl-10 pr-3 text-sm text-slate-900 placeholder:text-slate-400 transition focus:border-quotefly-blue focus:outline-none focus:ring-4 focus:ring-quotefly-blue/10 sm:min-h-[40px]"
            />
          </div>
          <button
            type="button"
            onClick={onAddCustomer}
            className="inline-flex min-h-[44px] shrink-0 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-quotefly-blue sm:min-h-[40px]"
          >
            <UserRoundPlus size={15} />
            <span>Add customer</span>
          </button>
        </div>

        {query.trim().length >= 2 ? (
          <div className="absolute left-0 right-0 top-[calc(100%+8px)] z-30 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_20px_40px_rgba(15,23,42,0.12)]">
            {loading ? (
              <p className="px-3 py-3 text-sm text-slate-500">Searching customers...</p>
            ) : error ? (
              <p className="px-3 py-3 text-sm text-red-600">{error}</p>
            ) : results.length ? (
              <div className="max-h-[280px] divide-y divide-slate-200 overflow-y-auto">
                {results.map((customer) => (
                  <button
                    key={customer.id}
                    type="button"
                    onClick={() => {
                      onSelectCustomer(customer);
                      setQuery(customer.fullName);
                      setResults([]);
                    }}
                    className="flex min-h-[44px] w-full items-center justify-between gap-3 px-3 py-3 text-left transition hover:bg-slate-50 sm:min-h-[40px]"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-900">{customer.fullName}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
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
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-600">
                      Use
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="px-3 py-3 text-sm text-slate-500">No customers matched that search.</p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
