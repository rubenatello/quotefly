import { useLocation, useNavigate } from "react-router-dom";
import type { ReactNode } from "react";
import { Clock3, FilePlus2, FileText } from "lucide-react";
import {
  AnalyticsIcon,
  CustomerIcon,
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
  { id: "customers", path: "/app/customers", label: "Customers", icon: <CustomerIcon size={22} /> },
  { id: "quotes", path: "/app/quotes", label: "Quotes", icon: <FileText size={22} /> },
];

const SECONDARY_TABS: TabItem[] = [
  { id: "follow-up", path: "/app/follow-up", label: "Follow-up", icon: <Clock3 size={22} /> },
  { id: "analytics", path: "/app/analytics", label: "Analytics", icon: <AnalyticsIcon size={22} /> },
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
        className={`relative flex min-h-[64px] min-w-0 items-center justify-center overflow-hidden transition-colors ${
          active
            ? "text-quotefly-blue"
            : "text-slate-500 hover:text-slate-700"
        }`}
        aria-label={tab.label}
        aria-current={active ? "page" : undefined}
        title={tab.label}
      >
        {active ? <span className="absolute top-1.5 h-1 w-5 rounded-full bg-quotefly-blue" aria-hidden="true" /> : null}
        <span
          className={`inline-flex h-11 w-11 items-center justify-center rounded-2xl transition ${
            active ? "bg-quotefly-blue/[0.1] shadow-[0_5px_14px_rgba(47,111,214,0.12)]" : ""
          }`}
          aria-hidden="true"
        >
          {tab.icon}
        </span>
        <span className="sr-only">{tab.label}</span>
      </button>
    );
  };

  return (
    <nav
      aria-label="Mobile workspace"
      className="qf-mobile-bottom-nav fixed inset-x-0 bottom-0 z-50 border-t border-slate-200/90 bg-white/98 pb-[env(safe-area-inset-bottom)] shadow-[0_-10px_28px_rgba(15,23,42,0.09)] backdrop-blur-xl lg:hidden"
    >
      <div className="mx-auto grid max-w-[540px] grid-cols-5">
        {PRIMARY_TABS.map(renderTab)}
        <button
          type="button"
          onClick={() => navigate("/app/build")}
          className="relative flex min-h-[64px] items-center justify-center text-quotefly-blue"
          aria-label="New quote"
          title="New quote"
          data-testid="mobile-quick-quote"
        >
          <span
            className="inline-flex h-12 w-12 -translate-y-1 items-center justify-center rounded-2xl bg-quotefly-blue text-white shadow-[0_8px_20px_rgba(47,111,214,0.3)]"
            aria-hidden="true"
          >
            <FilePlus2 size={22} />
          </span>
          <span className="sr-only">New quote</span>
        </button>
        {SECONDARY_TABS.map(renderTab)}
      </div>
    </nav>
  );
}
