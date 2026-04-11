import type { ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { PlanCode, TenantEntitlements, TenantUsageSnapshot } from "../../lib/api";
import { CloseIcon, LockIcon } from "../Icons";
import { cn } from "../../lib/utils";
import { AppTooltip, AppTooltipProvider } from "../ui/tooltip";
import { ProgressBar } from "../ui";

export interface CrmNavLink {
  label: string;
  path: string;
  icon: ReactNode;
}

export interface CrmModuleLink {
  label: string;
  path?: string;
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
  usage?: TenantUsageSnapshot;
}

function SidebarTooltip({
  label,
  collapsed,
  children,
}: {
  label: string;
  collapsed: boolean;
  children: ReactNode;
}) {
  if (!collapsed) return <>{children}</>;
  return <AppTooltip content={label}>{children}</AppTooltip>;
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
  usage,
}: CrmSidebarProps) {
  const displayPlanName = planName ?? "Starter";
  const showTrialBadge = Boolean(isTrial);
  const isFeatureUnlocked = (feature: keyof TenantEntitlements["features"]) =>
    Boolean(entitlements?.features?.[feature]);

  const planBadgeClasses =
    planCode === "enterprise"
      ? "border-quotefly-accent/20 bg-quotefly-accent/[0.06] text-quotefly-accent"
      : planCode === "professional"
        ? "border-quotefly-orange/20 bg-quotefly-orange/[0.06] text-quotefly-orange"
        : "border-quotefly-blue/20 bg-quotefly-blue/[0.06] text-quotefly-blue";

  const sidebarWidthClass = collapsed ? "lg:w-[92px]" : "lg:w-[284px]";
  const aiQuoteLimit = entitlements?.limits.aiQuotesPerMonth ?? null;
  const aiQuoteUsed = usage?.monthlyAiQuoteCount ?? 0;
  const aiQuoteRemaining = aiQuoteLimit === null ? null : Math.max(aiQuoteLimit - aiQuoteUsed, 0);
  const aiUsagePercent = aiQuoteLimit && aiQuoteLimit > 0 ? Math.min((aiQuoteUsed / aiQuoteLimit) * 100, 100) : 0;
  const totalQuoteLimit = entitlements?.limits.quotesPerMonth ?? null;
  const totalQuoteUsed = usage?.monthlyQuoteCount ?? 0;
  const totalUsagePercent = totalQuoteLimit && totalQuoteLimit > 0 ? Math.min((totalQuoteUsed / totalQuoteLimit) * 100, 100) : 0;

  return (
    <AppTooltipProvider>
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-72 border-r border-slate-200 bg-white py-5 shadow-[0_18px_40px_rgba(15,23,42,0.06)] transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 lg:overflow-y-auto ${sidebarWidthClass} ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className={cn("space-y-4", collapsed ? "px-3" : "px-4")}>
          <div className={cn("flex items-center", collapsed ? "flex-col gap-3" : "justify-between gap-3")}>
            <button
              type="button"
              onClick={() => onNavigate("pipeline")}
              className={cn("inline-flex items-center", collapsed ? "justify-center" : "")}
              title="QuoteFly Pipeline"
              aria-label="Go to pipeline"
            >
              {collapsed ? (
                <span className="inline-flex h-14 w-14 items-center justify-center rounded-[22px] border border-slate-200 bg-white shadow-[0_18px_36px_rgba(15,23,42,0.08)]">
                  <img src="/favicon.png" alt="QuoteFly" className="h-10 w-10 object-contain" />
                </span>
              ) : (
                <div className="rounded-[26px] border border-slate-200 bg-white px-3 py-3 shadow-[0_16px_34px_rgba(15,23,42,0.06)]">
                  <img src="/logo.png" alt="QuoteFly" className="h-10 w-auto object-contain" />
                </div>
              )}
            </button>
            <button
              type="button"
              onClick={onToggleCollapse}
              className={cn(
                "hidden items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:border-slate-300 hover:text-slate-700 lg:inline-flex",
                collapsed ? "h-11 w-11 self-center" : "h-11 w-11",
              )}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
            </button>
          </div>

          {!collapsed && (
            <div className="rounded-[26px] border border-slate-200 bg-white px-4 py-3 shadow-[0_16px_34px_rgba(15,23,42,0.05)]">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                QuoteFly Workspace
              </p>
              <p className="mt-2 text-sm font-semibold text-slate-900">
                Close more leads without fighting the software.
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Pipeline, quoting, branding, billing, and accounting in one operator view.
              </p>
            </div>
          )}

          {!collapsed && (
            <p className="px-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
              Core workflow
            </p>
          )}
          <nav className={cn("space-y-1.5", collapsed ? "px-0" : "px-1")}>
            {operationsLinks.map((link) => {
              const active = currentPage === link.path;
              const button = (
                <button
                  key={link.path}
                  type="button"
                  onClick={() => onNavigate(link.path)}
                  title={link.label}
                  aria-label={link.label}
                  className={cn(
                    "group flex w-full items-center rounded-[22px] border text-sm font-medium transition-all",
                    active
                      ? "border-quotefly-blue/20 bg-quotefly-blue/[0.08] text-slate-900 shadow-sm"
                      : "border-transparent text-slate-600 hover:border-slate-200 hover:bg-white hover:text-slate-900 hover:shadow-sm",
                    collapsed ? "justify-center px-0 py-3" : "justify-between px-3 py-3",
                  )}
                >
                  <span className={cn("inline-flex items-center", collapsed ? "justify-center" : "gap-3")}>
                    <span
                      className={cn(
                        "inline-flex items-center justify-center rounded-2xl transition",
                        collapsed ? "h-11 w-11" : "h-10 w-10",
                        active
                          ? "bg-white text-quotefly-blue shadow-sm"
                          : "bg-slate-100 text-slate-500 group-hover:bg-slate-50 group-hover:text-quotefly-blue",
                      )}
                    >
                      {link.icon}
                    </span>
                    {!collapsed && <span>{link.label}</span>}
                  </span>
                </button>
              );

              return (
                <SidebarTooltip key={link.path} label={link.label} collapsed={collapsed}>
                  {button}
                </SidebarTooltip>
              );
            })}
          </nav>

          {!collapsed && (
            <p className="px-2 pt-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
              Tier access
            </p>
          )}
          <nav className={cn("space-y-1.5", collapsed ? "px-0" : "px-1")}>
            {moduleLinks.map((module) => {
              const unlocked = isFeatureUnlocked(module.feature);
              const button = (
                <button
                  key={module.feature}
                  type="button"
                  title={`${module.label}${unlocked ? "" : ` (${module.requiredPlanLabel})`}`}
                  aria-label={`${module.label}${unlocked ? "" : ` locked: ${module.requiredPlanLabel}`}`}
                  onClick={() => {
                    if (unlocked && module.path) {
                      onNavigate(module.path);
                    }
                  }}
                  className={cn(
                    "group flex w-full items-center rounded-[20px] border transition-all",
                    unlocked
                      ? "border-transparent text-slate-600 hover:border-slate-200 hover:bg-white hover:text-slate-900 hover:shadow-sm"
                      : "cursor-not-allowed border-transparent text-slate-400",
                    collapsed ? "justify-center px-0 py-3" : "justify-between px-3 py-2.5",
                  )}
                >
                  <span className={cn("inline-flex items-center", collapsed ? "justify-center" : "gap-3")}>
                    <span
                      className={cn(
                        "inline-flex items-center justify-center rounded-2xl",
                        collapsed ? "h-11 w-11" : "h-9 w-9",
                        unlocked ? "bg-slate-100 text-slate-500" : "bg-slate-100 text-slate-400",
                      )}
                    >
                      {module.icon}
                    </span>
                    {!collapsed && module.label}
                  </span>
                  {collapsed ? (
                    <span className={cn("ml-1 h-2.5 w-2.5 rounded-full", unlocked ? "bg-quotefly-blue" : "bg-slate-300")} />
                  ) : unlocked ? (
                    <span className="rounded-full border border-quotefly-blue/20 bg-quotefly-blue/[0.06] px-2 py-0.5 text-[10px] font-medium text-quotefly-blue">
                      On
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-medium text-slate-500">
                      <LockIcon size={10} />
                      {module.requiredPlanLabel}
                    </span>
                  )}
                </button>
              );

              return (
                <SidebarTooltip
                  key={module.feature}
                  label={`${module.label}${unlocked ? "" : ` (${module.requiredPlanLabel})`}`}
                  collapsed={collapsed}
                >
                  {button}
                </SidebarTooltip>
              );
            })}
          </nav>
        </div>

        <div className={cn("mt-6 space-y-3", collapsed ? "px-3" : "px-4")}>
          {!collapsed && (
            <div className={`rounded-[24px] border px-4 py-3 text-xs shadow-sm ${planBadgeClasses}`}>
              <p className="font-semibold">
                {showTrialBadge ? "Trial Access" : "Current Plan"}: {displayPlanName}
              </p>
              <p className="mt-1 text-slate-500">
                {showTrialBadge
                  ? "All modules are open during trial. Pick a paid plan before trial ends."
                  : "QuoteFly unlocks more depth as your subscription grows."}
              </p>
            </div>
          )}

          {!collapsed && aiQuoteLimit !== null && usage ? (
            <div className="rounded-[24px] border border-slate-200 bg-white px-4 py-3 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">AI Drafts</p>
                <span className="text-xs font-semibold text-slate-900">
                  {aiQuoteUsed}/{aiQuoteLimit}
                </span>
              </div>
              <ProgressBar
                value={aiUsagePercent}
                label="Monthly AI quote usage"
                hint={aiQuoteRemaining === 0 ? "Limit reached" : `${aiQuoteRemaining} left this month`}
                className="mt-3"
              />
              {totalQuoteLimit !== null ? (
                <div className="mt-3 rounded-[18px] border border-slate-200 bg-slate-50 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    <span>Total quotes</span>
                    <span>{totalQuoteUsed}/{totalQuoteLimit}</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200">
                    <div className="h-full rounded-full bg-quotefly-orange" style={{ width: `${totalUsagePercent}%` }} />
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {!collapsed && (
            <div className="rounded-[24px] border border-slate-200 bg-white px-4 py-3 shadow-sm">
              <p className="text-sm font-semibold text-slate-900">{fullName || "Signed In User"}</p>
              <p className="text-xs text-slate-500">QuoteFly CRM workspace</p>
            </div>
          )}

          <SidebarTooltip label="Sign out" collapsed={collapsed}>
            <button
              type="button"
              onClick={onLogout}
              title="Sign Out"
              aria-label="Sign out"
              className={cn(
                "rounded-full border border-slate-200 bg-white py-2.5 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-300 hover:bg-slate-50",
                collapsed ? "w-full px-0 text-center" : "w-full px-4",
              )}
            >
              <span className={cn("inline-flex items-center", collapsed ? "justify-center gap-0" : "gap-2")}>
                <CloseIcon size={14} />
                {!collapsed && "Sign Out"}
              </span>
            </button>
          </SidebarTooltip>
        </div>
      </aside>
    </AppTooltipProvider>
  );
}
