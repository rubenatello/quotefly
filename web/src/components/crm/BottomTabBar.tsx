import { useLocation, useNavigate } from "react-router-dom";
import type { ReactNode } from "react";
import {
  ClockIcon,
  CustomerIcon,
  InvoiceIcon,
  QuoteIcon,
  SettingsIcon,
} from "../Icons";

interface TabItem {
  path: string;
  label: string;
  icon: ReactNode;
}

const TABS: TabItem[] = [
  { path: "/app/customers", label: "Customers", icon: <CustomerIcon size={20} /> },
  { path: "/app/quotes", label: "Quotes", icon: <QuoteIcon size={20} /> },
  { path: "/app/analytics", label: "Analytics", icon: <ClockIcon size={20} /> },
  { path: "/app/branding", label: "Branding", icon: <InvoiceIcon size={20} /> },
  { path: "/app/settings", label: "Settings", icon: <SettingsIcon size={20} /> },
];

function isActive(tabPath: string, currentPath: string): boolean {
  if (tabPath === "/app/customers") return currentPath === "/app" || currentPath === "/app/" || currentPath.startsWith("/app/customers");
  if (tabPath === "/app/quotes") return currentPath.startsWith("/app/quotes") || currentPath.startsWith("/app/build");
  return currentPath.startsWith(tabPath);
}

export function BottomTabBar() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] lg:hidden">
      <div className="grid grid-cols-5 overflow-hidden rounded-[30px] border border-slate-200 bg-white/95 shadow-[0_18px_40px_rgba(15,23,42,0.14)] backdrop-blur-xl">
        {TABS.map((tab) => {
          const active = isActive(tab.path, location.pathname);
          return (
            <button
              key={tab.path}
              type="button"
              onClick={() => navigate(tab.path)}
              className={`flex flex-col items-center justify-center gap-0.5 py-2.5 text-[10px] font-medium transition-colors ${
                active
                  ? "text-quotefly-blue"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              <span className={`inline-flex items-center justify-center rounded-2xl p-2 ${active ? "bg-quotefly-blue/[0.08]" : ""}`}>
                {tab.icon}
              </span>
              {tab.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
