import { useLocation, useNavigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { FilePlus2, FileText, LayoutDashboard, ListTodo } from "lucide-react";
import { cn } from "../../lib/utils";
import { CustomerIcon } from "../Icons";
import {
  WORKSPACE_PAGE_META,
  workspacePageFromPath,
  type WorkspaceNavigationId,
} from "./workspace-navigation";

interface TabItem {
  id: WorkspaceNavigationId;
  path: string;
  labelKey: string;
  icon: ReactNode;
}

const PRIMARY_TABS: TabItem[] = [
  { id: "home", path: "/app", labelKey: "navigation.home", icon: <LayoutDashboard size={22} /> },
  { id: "customers", path: "/app/customers", labelKey: "navigation.customers", icon: <CustomerIcon size={22} /> },
];

const SECONDARY_TABS: TabItem[] = [
  { id: "quotes", path: "/app/quotes", labelKey: "navigation.quotes", icon: <FileText size={22} /> },
  { id: "follow-up", path: "/app/follow-up", labelKey: "navigation.activity", icon: <ListTodo size={22} /> },
];

function MobileTabButton({
  tab,
  label,
  active,
  onSelect,
}: {
  tab: TabItem;
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "relative flex min-h-[64px] min-w-0 items-center justify-center overflow-hidden rounded-xl transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-[var(--qf-focus)] active:scale-[0.98]",
        active ? "text-[var(--qf-link)]" : "text-[var(--qf-text-muted)] hover:text-[var(--qf-text)]",
      )}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      title={label}
      data-testid={`mobile-tab-${tab.id}`}
    >
      <span
        className={cn(
          "relative inline-flex h-12 w-12 items-center justify-center rounded-[18px] transition",
          active
            ? "bg-[var(--qf-selected)] shadow-[0_8px_20px_rgba(47,111,214,0.14)] ring-1 ring-[var(--qf-info-border)]"
            : "hover:bg-[var(--qf-interactive-hover)]",
        )}
        aria-hidden="true"
        data-testid={`mobile-tab-${tab.id}-icon`}
      >
        {active ? (
          <>
            <span className="absolute -top-1 h-1.5 w-1.5 rounded-full bg-[var(--qf-action-primary)] shadow-[0_0_0_4px_var(--qf-focus-ring)]" />
            <span className="absolute inset-1 rounded-[15px] border border-[var(--qf-info-border)]" />
          </>
        ) : null}
        <span className="relative">{tab.icon}</span>
      </span>
      <span className="sr-only">{label}</span>
    </button>
  );
}

export function BottomTabBar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const currentPage = workspacePageFromPath(location.pathname);
  const activeNavigation = WORKSPACE_PAGE_META[currentPage].activeNavigation;

  const renderTab = (tab: TabItem) => {
    const active = tab.id === activeNavigation;
    return (
      <MobileTabButton
        key={tab.path}
        tab={tab}
        label={t(tab.labelKey)}
        active={active}
        onSelect={() => navigate(tab.path)}
      />
    );
  };

  return (
    <nav
      aria-label={t("navigation.mobileRegion")}
      className="qf-mobile-bottom-nav fixed inset-x-0 bottom-0 z-50 border-t border-qf-border/90 bg-qf-surface/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-10px_28px_rgba(15,23,42,0.09)] backdrop-blur-xl lg:hidden"
    >
      <div className="mx-auto grid max-w-[540px] grid-cols-5">
        {PRIMARY_TABS.map(renderTab)}
        <button
          type="button"
          onClick={() => navigate("/app/build")}
          className="relative flex min-h-[64px] items-center justify-center rounded-xl text-[var(--qf-link)] focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-[var(--qf-focus)] active:scale-[0.98]"
          aria-label={t("navigation.newQuote")}
          title={t("navigation.newQuote")}
          data-testid="mobile-quick-quote"
        >
          <span
            className="inline-flex h-[54px] w-[54px] -translate-y-1.5 items-center justify-center rounded-[21px] bg-[var(--qf-action-primary)] text-[var(--qf-action-primary-text)] shadow-[0_12px_26px_rgba(47,111,214,0.34)] ring-4 ring-qf-surface transition hover:bg-[var(--qf-action-primary-hover)]"
            aria-hidden="true"
          >
            <FilePlus2 size={22} />
          </span>
          <span className="sr-only">{t("navigation.newQuote")}</span>
        </button>
        {SECONDARY_TABS.map(renderTab)}
      </div>
    </nav>
  );
}
