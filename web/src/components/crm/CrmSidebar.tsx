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
      ? "border-purple-200 bg-[linear-gradient(180deg,rgba(168,85,247,0.12)_0%,rgba(255,255,255,1)_100%)] text-purple-700"
      : planCode === "professional"
        ? "border-quotefly-blue/20 bg-[linear-gradient(180deg,rgba(91,133,170,0.12)_0%,rgba(255,255,255,1)_100%)] text-quotefly-blue"
        : "border-slate-200 bg-[linear-gradient(180deg,rgba(148,163,184,0.08)_0%,rgba(255,255,255,1)_100%)] text-slate-700";

  const sidebarWidthClass = collapsed ? "lg:w-[104px]" : "lg:w-[292px]";

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-50 w-72 border-r border-slate-200 bg-[radial-gradient(circle_at_top_left,rgba(91,133,170,0.12),transparent_26%),radial-gradient(circle_at_top_right,rgba(244,96,54,0.08),transparent_20%),linear-gradient(180deg,#ffffff_0%,#f8fbff_100%)] py-5 shadow-xl transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 lg:overflow-y-auto lg:shadow-none ${sidebarWidthClass} ${
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
            className={`hidden rounded-2xl border border-slate-300 bg-white p-2 text-slate-600 shadow-sm hover:bg-slate-50 lg:inline-flex ${
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
            className={`block w-full rounded-2xl py-2 text-sm font-medium transition-all ${
              currentPage === link.path
                ? collapsed
                  ? "bg-[linear-gradient(135deg,#2f78bf_0%,#5B85AA_100%)] text-white shadow-[0_14px_30px_rgba(47,120,191,0.28)]"
                  : "border border-quotefly-blue/15 bg-[linear-gradient(180deg,rgba(91,133,170,0.14)_0%,rgba(255,255,255,1)_100%)] text-quotefly-blue shadow-sm"
                : "text-slate-700 hover:bg-white hover:shadow-sm"
            } ${collapsed ? "px-0 py-3 text-center" : "px-3.5 text-left"}`}
          >
            <span className={`inline-flex items-center ${collapsed ? "justify-center gap-0" : "gap-2"}`}>
              <span className={collapsed ? "inline-flex h-11 w-11 items-center justify-center rounded-[18px] bg-white/12" : ""}>
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
              className={`flex w-full items-center rounded-2xl py-2 text-sm font-medium transition-all ${
                unlocked
                  ? "text-slate-700 hover:bg-white hover:shadow-sm"
                  : "cursor-not-allowed bg-slate-100/70 text-slate-400"
              } ${collapsed ? "justify-center px-0 py-3" : "justify-between px-3.5 text-left"}`}
            >
              <span className={`inline-flex items-center ${collapsed ? "justify-center gap-0" : "gap-2"}`}>
                <span className={collapsed ? "inline-flex h-11 w-11 items-center justify-center rounded-[18px] bg-white/80 shadow-sm" : ""}>
                  {module.icon}
                </span>
                {!collapsed && module.label}
              </span>
              {collapsed ? (
                <span
                  className={`ml-1 h-2.5 w-2.5 rounded-full ${
                    unlocked ? "bg-emerald-500" : "bg-amber-500"
                  }`}
                />
              ) : (
                <>
                  {unlocked ? (
                    <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                      On
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
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
        <div className={`mx-3 mt-6 rounded-[24px] border px-3.5 py-3.5 text-xs shadow-sm ${planBadgeClasses}`}>
          <p className="font-semibold">
            {showTrialBadge ? "Trial Access" : "Current Plan"}: {displayPlanName}
          </p>
          <p className="mt-1">
            {showTrialBadge
              ? "All modules unlocked during trial. Pick a paid plan before trial ends."
              : "Modules unlock automatically as your subscription tier increases."}
          </p>
        </div>
      )}

      {!collapsed && (
        <div className="mx-3 mt-3 rounded-[24px] border border-slate-200 bg-[linear-gradient(180deg,rgba(255,255,255,1)_0%,rgba(248,250,252,1)_100%)] px-3.5 py-3.5 text-sm shadow-sm">
          <p className="font-medium text-slate-800">{fullName || "Signed In User"}</p>
          <p className="text-slate-500">QuoteFly CRM workspace</p>
        </div>
      )}

      <button
        type="button"
        onClick={onLogout}
        title="Sign Out"
        aria-label="Sign out"
        className={`mt-4 rounded-2xl border border-slate-300 bg-white py-2.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 ${
          collapsed ? "mx-2 w-[calc(100%-16px)] px-0 text-center" : "mx-3 w-[calc(100%-24px)] px-3.5"
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
