import type { ReactNode } from "react";
import type { PlanCode, TenantEntitlements } from "../../lib/api";
import { LockIcon } from "../Icons";

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
      className={`fixed inset-y-0 left-0 z-50 w-72 border-r border-slate-200 bg-white px-4 py-5 shadow-xl transition-transform lg:static lg:w-auto lg:translate-x-0 lg:shadow-none ${
        mobileOpen ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <button
        type="button"
        onClick={() => onNavigate("dashboard")}
        className="mb-6 inline-flex items-center"
      >
        <img src="/logo.png" alt="QuoteFly" className="h-9 w-auto" />
      </button>

      <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Operations
      </p>
      <nav className="space-y-1">
        {operationsLinks.map((link) => (
          <button
            key={link.path}
            type="button"
            onClick={() => onNavigate(link.path)}
            className={`block w-full rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${
              currentPage === link.path
                ? "bg-blue-50 text-blue-700"
                : "text-slate-700 hover:bg-slate-100"
            }`}
          >
            <span className="inline-flex items-center gap-2">
              {link.icon}
              {link.label}
            </span>
          </button>
        ))}
      </nav>

      <p className="mb-2 mt-5 px-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Modules
      </p>
      <nav className="space-y-1">
        {moduleLinks.map((module) => {
          const unlocked = isFeatureUnlocked(module.feature);

          return (
            <button
              key={module.feature}
              type="button"
              onClick={() => {
                if (unlocked) {
                  onNavigate("dashboard");
                }
              }}
              className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${
                unlocked
                  ? "text-slate-700 hover:bg-slate-100"
                  : "cursor-not-allowed text-slate-400 bg-slate-100/60"
              }`}
            >
              <span className="inline-flex items-center gap-2">
                {module.icon}
                {module.label}
              </span>
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
            </button>
          );
        })}
      </nav>

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

      <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm">
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
  );
}
