import { useLocation, useNavigate } from "react-router-dom";
import type { ReactNode } from "react";
import {
  CustomerIcon,
  EditIcon,
  QuoteIcon,
  ClockIcon,
  SettingsIcon,
} from "../Icons";

interface TabItem {
  path: string;
  label: string;
  icon: ReactNode;
}

const TABS: TabItem[] = [
  { path: "/app", label: "Pipeline", icon: <CustomerIcon size={20} /> },
  { path: "/app/build", label: "Build", icon: <EditIcon size={20} /> },
  { path: "/app/quotes", label: "Quotes", icon: <QuoteIcon size={20} /> },
  { path: "/app/history", label: "History", icon: <ClockIcon size={20} /> },
  { path: "/app/admin", label: "More", icon: <SettingsIcon size={20} /> },
];

function isActive(tabPath: string, currentPath: string): boolean {
  if (tabPath === "/app") return currentPath === "/app" || currentPath === "/app/";
  return currentPath.startsWith(tabPath);
}

export function BottomTabBar() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 border-t border-slate-200 bg-white/95 backdrop-blur-md pb-[env(safe-area-inset-bottom)] lg:hidden">
      <div className="grid grid-cols-5">
        {TABS.map((tab) => {
          const active = isActive(tab.path, location.pathname);
          return (
            <button
              key={tab.path}
              type="button"
              onClick={() => navigate(tab.path)}
              className={`flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition-colors ${
                active
                  ? "text-quotefly-blue"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              <span className={`inline-flex items-center justify-center rounded-full p-1 ${active ? "bg-blue-50" : ""}`}>
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
