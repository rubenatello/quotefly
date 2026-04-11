import type { ReactNode } from "react";
import type { PlanCode, TenantEntitlements } from "../../lib/api";
import { ArrowRightIcon, CloseIcon, LockIcon } from "../Icons";

export interface CrmNavLink {
  label: string;
  path: string;
  icon: ReactNode;
}

export interface CrmModuleLink {
  label: string;
  feature: keyof TenantEntitlements["features"];
  requiredPlanLabel: string;
  icon: ReactNode;
}

interface CrmSidebarProps {
  currentPage: string;
  mobileOpen: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onNavigate: (page: string) => void;
  operationsLinks: readonly CrmNavLink[];
  moduleLinks: readonly CrmModuleLink[];
  onLogout: () => void;
  fullName?: string;
  planName?: string;
  planCode?: PlanCode;
  isTrial?: boolean;
  entitlements?: TenantEntitlements;
}

export function CrmSidebar({
  currentPage,
  mobileOpen,
  collapsed,
  onToggleCollapse,
  onNavigate,
  operationsLinks,
  moduleLinks,
  onLogout,
  fullName,
  planName,
  planCode,
  isTrial,
  entitlements,
}: CrmSidebarProps) {
  const displayPlanName = planName ?? "Starter";
  const showTrialBadge = Boolean(isTrial);
  const isFeatureUnlocked = (feature: keyof TenantEntitlements["features"]) =>
    Boolean(entitlements?.features?.[feature]);

  const planBadgeClasses =
    planCode === "enterprise"
      ? "border-quotefly-accent/20 bg-quotefly-accent/[0.06] text-quotefly-accent"
      : planCode === "professional"
        ? "border-quotefly-blue/20 bg-quotefly-blue/[0.06] text-quotefly-blue"
        : "border-slate-200 bg-slate-50 text-slate-600";

  const sidebarWidthClass = collapsed ? "lg:w-[80px]" : "lg:w-[260px]";

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-50 w-64 border-r border-slate-200 bg-white py-5 transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 lg:overflow-y-auto ${sidebarWidthClass} ${
        mobileOpen ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <div className={`mb-6 ${collapsed ? "px-3" : "px-4"}`}>
        <div className={`flex items-center ${collapsed ? "flex-col gap-3" : "justify-between gap-3"}`}>
          <button
            type="button"
            onClick={() => onNavigate("dashboard")}
            className={`inline-flex items-center ${collapsed ? "justify-center" : ""}`}
            title="QuoteFly Dashboard"
            aria-label="Go to dashboard"
          >
            {collapsed ? (
              <span className="inline-flex h-14 w-14 items-center justify-center rounded-[22px] border border-slate-200 bg-white shadow-[0_12px_24px_rgba(15,23,42,0.08)]">
                <img src="/favicon.png" alt="QuoteFly" className="h-10 w-10 object-contain" />
              </span>
            ) : (
              <img src="/logo.png" alt="QuoteFly" className="h-10 w-auto object-contain" />
            )}
          </button>
          <button
            type="button"
            onClick={onToggleCollapse}
            className={`hidden rounded-full border border-slate-200 bg-white p-1.5 text-slate-500 hover:bg-slate-50 lg:inline-flex ${
              collapsed ? "self-center" : ""
            }`}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <ArrowRightIcon size={16} className={collapsed ? "rotate-180" : ""} />
          </button>
        </div>
      </div>

      {!collapsed && (
        <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Operations
        </p>
      )}
      <nav className={`space-y-1 ${collapsed ? "px-2" : "px-3"}`}>
        {operationsLinks.map((link) => (
          <button
            key={link.path}
            type="button"
            onClick={() => onNavigate(link.path)}
            title={link.label}
            aria-label={link.label}
            className={`block w-full rounded-lg py-2 text-sm font-medium transition-all ${
              currentPage === link.path
                ? collapsed
                  ? "bg-quotefly-blue text-white"
                  : "bg-quotefly-blue/[0.08] text-quotefly-blue"
                : "text-slate-600 hover:bg-slate-50"
            } ${collapsed ? "px-0 py-2.5 text-center" : "px-3 text-left"}`}
          >
            <span className={`inline-flex items-center ${collapsed ? "justify-center gap-0" : "gap-2.5"}`}>
              <span className={collapsed ? "inline-flex h-9 w-9 items-center justify-center rounded-lg" : ""}>
                {link.icon}
              </span>
              {!collapsed && link.label}
            </span>
          </button>
        ))}
      </nav>

      {!collapsed && (
        <p className="mb-2 mt-5 px-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Modules
        </p>
      )}
      <nav className={`space-y-1 ${collapsed ? "px-2" : "px-3"}`}>
        {moduleLinks.map((module) => {
          const unlocked = isFeatureUnlocked(module.feature);

          return (
            <button
              key={module.feature}
              type="button"
              title={`${module.label}${unlocked ? "" : ` (${module.requiredPlanLabel})`}`}
              aria-label={`${module.label}${unlocked ? "" : ` locked: ${module.requiredPlanLabel}`}`}
              onClick={() => {
                if (unlocked) {
                  onNavigate("dashboard");
                }
              }}
              className={`flex w-full items-center rounded-lg py-2 text-sm font-medium transition-all ${
                unlocked
                  ? "text-slate-600 hover:bg-slate-50"
                  : "cursor-not-allowed text-slate-400"
              } ${collapsed ? "justify-center px-0 py-2.5" : "justify-between px-3 text-left"}`}
            >
              <span className={`inline-flex items-center ${collapsed ? "justify-center gap-0" : "gap-2.5"}`}>
                <span className={collapsed ? "inline-flex h-9 w-9 items-center justify-center rounded-lg" : ""}>
                  {module.icon}
                </span>
                {!collapsed && module.label}
              </span>
              {collapsed ? (
                <span
                  className={`ml-1 h-2 w-2 rounded-full ${
                    unlocked ? "bg-quotefly-blue" : "bg-slate-300"
                  }`}
                />
              ) : (
                <>
                  {unlocked ? (
                    <span className="rounded-full border border-quotefly-blue/20 bg-quotefly-blue/[0.06] px-2 py-0.5 text-[10px] font-medium text-quotefly-blue">
                      On
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-medium text-slate-500">
                      <LockIcon size={10} />
                      {module.requiredPlanLabel}
                    </span>
                  )}
                </>
              )}
            </button>
          );
        })}
      </nav>

      {!collapsed && (
        <div className={`mx-3 mt-6 rounded-lg border px-3 py-3 text-xs ${planBadgeClasses}`}>
          <p className="font-medium">
            {showTrialBadge ? "Trial Access" : "Current Plan"}: {displayPlanName}
          </p>
          <p className="mt-1 text-slate-500">
            {showTrialBadge
              ? "All modules unlocked during trial. Pick a paid plan before trial ends."
              : "Modules unlock automatically as your subscription tier increases."}
          </p>
        </div>
      )}

      {!collapsed && (
        <div className="mx-3 mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm">
          <p className="font-medium text-slate-800">{fullName || "Signed In User"}</p>
          <p className="text-xs text-slate-500">QuoteFly CRM workspace</p>
        </div>
      )}

      <button
        type="button"
        onClick={onLogout}
        title="Sign Out"
        aria-label="Sign out"
        className={`mt-4 rounded-full border border-slate-200 bg-white py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 ${
          collapsed ? "mx-2 w-[calc(100%-16px)] px-0 text-center" : "mx-3 w-[calc(100%-24px)] px-3"
        }`}
      >
        <span className={`inline-flex items-center ${collapsed ? "justify-center gap-0" : "gap-2"}`}>
          <CloseIcon size={14} />
          {!collapsed && "Sign Out"}
        </span>
      </button>
    </aside>
  );
}
