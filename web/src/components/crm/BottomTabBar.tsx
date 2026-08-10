import { useLocation, useNavigate } from "react-router-dom";
import type { ReactNode } from "react";
import { Clock3, FilePlus2 } from "lucide-react";
import {
  AnalyticsIcon,
  CustomerIcon,
  QuoteIcon,
} from "../Icons";
import {
  WORKSPACE_PAGE_META,
  workspacePageFromPath,
  type WorkspaceNavigationId,
} from "./workspace-navigation";

interface TabItem {
  id: WorkspaceNavigationId;
  path: string;
  label: string;
  icon: ReactNode;
}

const PRIMARY_TABS: TabItem[] = [
  { id: "customers", path: "/app/customers", label: "Customers", icon: <CustomerIcon size={20} /> },
  { id: "quotes", path: "/app/quotes", label: "Quotes", icon: <QuoteIcon size={20} /> },
];

const SECONDARY_TABS: TabItem[] = [
  { id: "follow-up", path: "/app/follow-up", label: "Follow-up", icon: <Clock3 size={20} /> },
  { id: "analytics", path: "/app/analytics", label: "Analytics", icon: <AnalyticsIcon size={20} /> },
];

export function BottomTabBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const currentPage = workspacePageFromPath(location.pathname);
  const activeNavigation = WORKSPACE_PAGE_META[currentPage].activeNavigation;

  const renderTab = (tab: TabItem) => {
    const active = tab.id === activeNavigation;
    return (
      <button
        key={tab.path}
        type="button"
        onClick={() => navigate(tab.path)}
        className={`relative flex min-h-[64px] min-w-0 flex-col items-center justify-center overflow-hidden px-0.5 py-2 text-[10px] font-medium transition-colors ${
          active
            ? "text-quotefly-blue"
            : "text-slate-500 hover:text-slate-700"
        }`}
        aria-current={active ? "page" : undefined}
      >
        {active ? <span className="absolute inset-x-4 top-0 h-0.5 rounded-full bg-quotefly-blue" /> : null}
        <span className={`mb-1 inline-flex items-center justify-center rounded-xl p-1.5 ${active ? "bg-quotefly-blue/[0.08]" : ""}`}>
          {tab.icon}
        </span>
        <span className="block max-w-full truncate text-center leading-none">{tab.label}</span>
      </button>
    );
  };

  return (
    <nav aria-label="Mobile workspace" className="qf-mobile-bottom-nav fixed inset-x-0 bottom-0 z-50 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] lg:hidden">
      <div className="grid grid-cols-5 overflow-hidden rounded-[28px] border border-slate-200 bg-white/96 shadow-[0_14px_34px_rgba(15,23,42,0.12)] backdrop-blur-xl">
        {PRIMARY_TABS.map(renderTab)}
        <button
          type="button"
          onClick={() => navigate("/app/build")}
          className="relative flex min-h-[64px] flex-col items-center justify-center text-[10px] font-semibold text-quotefly-blue"
          aria-label="New quote"
          data-testid="mobile-quick-quote"
        >
          <span className="mb-1 inline-flex h-10 w-10 -translate-y-1 items-center justify-center rounded-2xl bg-quotefly-blue text-white shadow-[0_8px_20px_rgba(47,111,214,0.3)]">
            <FilePlus2 size={20} />
          </span>
          <span className="absolute bottom-2 leading-none">New</span>
        </button>
        {SECONDARY_TABS.map(renderTab)}
      </div>
    </nav>
  );
}
