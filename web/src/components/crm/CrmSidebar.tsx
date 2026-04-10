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
      ? "border-purple-200 bg-purple-50 text-purple-700"
      : planCode === "professional"
        ? "border-blue-200 bg-blue-50 text-blue-700"
        : "border-slate-200 bg-slate-50 text-slate-700";

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-50 w-72 border-r border-slate-200 bg-white py-5 shadow-xl transition-transform lg:static lg:w-auto lg:translate-x-0 lg:shadow-none ${
        mobileOpen ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <div className={`mb-6 flex items-center ${collapsed ? "justify-center px-2" : "justify-between px-4"}`}>
        <button
          type="button"
          onClick={() => onNavigate("dashboard")}
          className="inline-flex items-center"
          title="QuoteFly Dashboard"
        >
          <img src="/logo.png" alt="QuoteFly" className={`w-auto ${collapsed ? "h-8" : "h-9"}`} />
        </button>
        <button
          type="button"
          onClick={onToggleCollapse}
          className="hidden rounded-md border border-slate-300 p-1.5 text-slate-600 hover:bg-slate-50 lg:inline-flex"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <ArrowRightIcon size={16} className={collapsed ? "rotate-180" : ""} />
        </button>
      </div>

      {!collapsed && (
        <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Operations
        </p>
      )}
      <nav className="space-y-1">
        {operationsLinks.map((link) => (
          <button
            key={link.path}
            type="button"
            onClick={() => onNavigate(link.path)}
            title={link.label}
            className={`block w-full rounded-lg py-2 text-sm font-medium transition-colors ${
              currentPage === link.path
                ? "bg-blue-50 text-blue-700"
                : "text-slate-700 hover:bg-slate-100"
            } ${collapsed ? "px-2 text-center" : "px-3 text-left"}`}
          >
            <span className={`inline-flex items-center ${collapsed ? "justify-center gap-0" : "gap-2"}`}>
              {link.icon}
              {!collapsed && link.label}
            </span>
          </button>
        ))}
      </nav>

      {!collapsed && (
        <p className="mb-2 mt-5 px-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Modules
        </p>
      )}
      <nav className="space-y-1">
        {moduleLinks.map((module) => {
          const unlocked = isFeatureUnlocked(module.feature);

          return (
            <button
              key={module.feature}
              type="button"
              title={`${module.label}${unlocked ? "" : ` (${module.requiredPlanLabel})`}`}
              onClick={() => {
                if (unlocked) {
                  onNavigate("dashboard");
                }
              }}
              className={`flex w-full items-center rounded-lg py-2 text-sm font-medium transition-colors ${
                unlocked
                  ? "text-slate-700 hover:bg-slate-100"
                  : "cursor-not-allowed text-slate-400 bg-slate-100/60"
              } ${collapsed ? "justify-center px-2" : "justify-between px-3 text-left"}`}
            >
              <span className={`inline-flex items-center ${collapsed ? "justify-center gap-0" : "gap-2"}`}>
                {module.icon}
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
        <div className={`mt-6 rounded-lg border px-3 py-3 text-xs ${planBadgeClasses}`}>
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
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm">
          <p className="font-medium text-slate-800">{fullName || "Signed In User"}</p>
          <p className="text-slate-500">QuoteFly CRM workspace</p>
        </div>
      )}

      <button
        type="button"
        onClick={onLogout}
        title="Sign Out"
        className={`mt-4 w-full rounded-lg border border-slate-300 bg-white py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 ${
          collapsed ? "px-2 text-center" : "px-3"
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
