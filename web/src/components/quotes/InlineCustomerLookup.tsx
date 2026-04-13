import { useEffect, useState } from "react";
import { Phone, Search, UserPlus2 } from "lucide-react";
import { api, ApiError, type Customer } from "../../lib/api";
import { Button, Input } from "../ui";

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
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="flex-1">
          <Input
            placeholder="Find by customer name, phone, or email"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            icon={<Search size={14} />}
          />
        </div>
        <Button type="button" variant="outline" size="sm" icon={<UserPlus2 size={14} />} onClick={onAddCustomer}>
          Add customer
        </Button>
      </div>

      {selectedCustomer ? (
        <div className="rounded-2xl border border-quotefly-blue/15 bg-quotefly-blue/[0.05] px-3 py-2.5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-quotefly-blue">Selected</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">{selectedCustomer.fullName}</p>
          <p className="mt-1 text-xs text-slate-600">
            {selectedCustomer.phone}
            {selectedCustomer.email ? ` / ${selectedCustomer.email}` : ""}
          </p>
        </div>
      ) : null}

      {query.trim().length >= 2 ? (
        <div className="rounded-2xl border border-slate-200 bg-white">
          {loading ? (
            <p className="px-3 py-3 text-sm text-slate-500">Searching customers…</p>
          ) : error ? (
            <p className="px-3 py-3 text-sm text-red-600">{error}</p>
          ) : results.length ? (
            <div className="divide-y divide-slate-200">
              {results.map((customer) => (
                <button
                  key={customer.id}
                  type="button"
                  onClick={() => {
                    onSelectCustomer(customer);
                    setQuery(customer.fullName);
                    setResults([]);
                  }}
                  className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left transition hover:bg-slate-50"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-900">{customer.fullName}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                      <span className="inline-flex items-center gap-1">
                        <Phone size={12} />
                        {customer.phone}
                      </span>
                      {customer.email ? <span className="truncate">{customer.email}</span> : null}
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
  );
}
