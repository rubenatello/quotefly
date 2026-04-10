import { useState } from "react";
import type { ReactNode } from "react";
import { CloseIcon, MenuIcon } from "./Icons";

interface CrmShellProps {
  currentPage: string;
  onNavigate: (page: string) => void;
  onLogout: () => void;
  children: ReactNode;
  fullName?: string;
}

const OPERATIONS_LINKS = [
  { label: "Dashboard", path: "dashboard" },
  { label: "Branding", path: "branding" },
];

export function CrmShell({ currentPage, onNavigate, onLogout, children, fullName }: CrmShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleNavigate = (page: string) => {
    onNavigate(page);
    setMobileOpen(false);
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen((open) => !open)}
          className="inline-flex items-center justify-center rounded-md border border-slate-300 p-2 text-slate-700"
        >
          {mobileOpen ? <CloseIcon size={18} /> : <MenuIcon size={18} />}
        </button>
        <img src="/logo.png" alt="QuoteFly" className="h-8 w-auto" />
        <button
          type="button"
          onClick={onLogout}
          className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
        >
          Sign Out
        </button>
      </header>

      <div className="mx-auto w-full max-w-[1600px] lg:grid lg:grid-cols-[250px_1fr]">
        <aside
          className={`fixed inset-y-0 left-0 z-50 w-72 border-r border-slate-200 bg-white px-4 py-5 shadow-xl transition-transform lg:static lg:w-auto lg:translate-x-0 lg:shadow-none ${
            mobileOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <button
            type="button"
            onClick={() => handleNavigate("dashboard")}
            className="mb-6 inline-flex items-center"
          >
            <img src="/logo.png" alt="QuoteFly" className="h-9 w-auto" />
          </button>

          <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Operations
          </p>
          <nav className="space-y-1">
            {OPERATIONS_LINKS.map((link) => (
              <button
                key={link.path}
                type="button"
                onClick={() => handleNavigate(link.path)}
                className={`block w-full rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${
                  currentPage === link.path
                    ? "bg-blue-50 text-blue-700"
                    : "text-slate-700 hover:bg-slate-100"
                }`}
              >
                {link.label}
              </button>
            ))}
          </nav>

          <div className="mt-8 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm">
            <p className="font-medium text-slate-800">{fullName || "Signed In User"}</p>
            <p className="text-slate-500">QuoteFly CRM workspace</p>
          </div>

          <button
            type="button"
            onClick={onLogout}
            className="mt-4 w-full rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-sm font-medium text-orange-700 hover:bg-orange-100"
          >
            Sign Out
          </button>
        </aside>

        {mobileOpen && (
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
            className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          />
        )}

        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
