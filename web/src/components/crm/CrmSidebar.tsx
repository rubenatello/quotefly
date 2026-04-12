import type { ReactNode } from "react";
import { FilePlus2, PanelLeftClose, PanelLeftOpen, UserPlus2 } from "lucide-react";
import type { TenantEntitlements, TenantUsageSnapshot } from "../../lib/api";
import { CloseIcon } from "../Icons";
import { cn } from "../../lib/utils";
import { AppTooltip, AppTooltipProvider } from "../ui/tooltip";
import { ProgressBar } from "../ui";

export interface CrmNavLink {
  label: string;
  path: string;
  icon: ReactNode;
}

interface CrmSidebarProps {
  currentPage: string;
  mobileOpen: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onNavigate: (page: string) => void;
  onQuickAction: (action: "new-customer" | "new-quote") => void;
  operationsLinks: readonly CrmNavLink[];
  settingsLinks: readonly CrmNavLink[];
  onLogout: () => void;
  planName?: string;
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
  onQuickAction,
  operationsLinks,
  settingsLinks,
  onLogout,
  planName,
  isTrial,
  entitlements,
  usage,
}: CrmSidebarProps) {
  const displayPlanName = planName ?? "Starter";
  const showTrialBadge = Boolean(isTrial);

  const sidebarWidthClass = collapsed ? "lg:w-[76px]" : "lg:w-[228px]";
  const aiQuoteLimit = entitlements?.limits.aiQuotesPerMonth ?? null;
  const aiQuoteUsed = usage?.monthlyAiQuoteCount ?? 0;
  const aiQuoteRemaining = aiQuoteLimit === null ? null : Math.max(aiQuoteLimit - aiQuoteUsed, 0);
  const aiUsagePercent = aiQuoteLimit && aiQuoteLimit > 0 ? Math.min((aiQuoteUsed / aiQuoteLimit) * 100, 100) : 0;

  return (
    <AppTooltipProvider>
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-72 border-r border-slate-200 bg-white py-3 transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 lg:overflow-y-auto ${sidebarWidthClass} ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className={cn("space-y-4", collapsed ? "px-2.5" : "px-3")}>
          <div className={cn("flex items-center", collapsed ? "flex-col gap-3" : "justify-between gap-3")}>
            <button
              type="button"
              onClick={() => onNavigate("customers")}
              className={cn("inline-flex items-center", collapsed ? "justify-center" : "")}
              title="QuoteFly Customers"
              aria-label="Go to customers"
            >
              {collapsed ? (
                <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-slate-200 bg-white">
                  <img src="/favicon.png" alt="QuoteFly" className="h-7 w-7 object-contain" />
                </span>
              ) : (
                <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                  <img src="/logo.png" alt="QuoteFly" className="h-7 w-auto object-contain" />
                </div>
              )}
            </button>
            <button
              type="button"
              onClick={onToggleCollapse}
              className={cn(
                "hidden items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition hover:border-slate-300 hover:text-slate-700 lg:inline-flex",
                collapsed ? "h-10 w-10 self-center" : "h-10 w-10",
              )}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
            </button>
          </div>

          {!collapsed ? (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Quick actions</p>
                  <p className="mt-1 text-xs text-slate-500">Add a customer fast or jump straight into a quote.</p>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => onQuickAction("new-customer")}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-100"
                >
                  <UserPlus2 size={15} className="text-quotefly-blue" />
                  New customer
                </button>
                <button
                  type="button"
                  onClick={() => onQuickAction("new-quote")}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-quotefly-blue bg-quotefly-blue px-3 py-2.5 text-sm font-medium text-white transition hover:bg-[#256fbf]"
                >
                  <FilePlus2 size={15} />
                  New quote
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <SidebarTooltip label="New customer" collapsed={collapsed}>
                <button
                  type="button"
                  onClick={() => onQuickAction("new-customer")}
                  aria-label="New customer"
                  className="inline-flex h-11 w-full items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                >
                  <UserPlus2 size={16} className="text-quotefly-blue" />
                </button>
              </SidebarTooltip>
              <SidebarTooltip label="New quote" collapsed={collapsed}>
                <button
                  type="button"
                  onClick={() => onQuickAction("new-quote")}
                  aria-label="New quote"
                  className="inline-flex h-11 w-full items-center justify-center rounded-xl border border-quotefly-blue bg-quotefly-blue text-white transition hover:bg-[#256fbf]"
                >
                  <FilePlus2 size={16} />
                </button>
              </SidebarTooltip>
            </div>
          )}

          {!collapsed && <p className="px-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Core workflow</p>}
          <nav className={cn("space-y-1", collapsed ? "px-0" : "px-1")}>
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
                    "group flex w-full items-center rounded-xl border text-sm font-medium transition-all",
                    active
                      ? "border-quotefly-blue/20 bg-quotefly-blue/[0.08] text-slate-900"
                      : "border-transparent text-slate-600 hover:border-slate-200 hover:bg-white hover:text-slate-900",
                    collapsed ? "justify-center px-0 py-2.5" : "justify-between px-3 py-2.5",
                  )}
                >
                  <span className={cn("inline-flex items-center", collapsed ? "justify-center" : "gap-3")}>
                    <span
                      className={cn(
                        "inline-flex items-center justify-center rounded-2xl transition",
                        collapsed ? "h-9 w-9" : "h-8 w-8",
                        active
                          ? "bg-white text-quotefly-blue"
                          : "bg-slate-100 text-slate-500 group-hover:bg-slate-50 group-hover:text-quotefly-blue",
                      )}
                    >
                      {link.icon}
                    </span>
                    {!collapsed && (
                      <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                        <span>{link.label}</span>
                        {active ? <span className="h-1.5 w-1.5 rounded-full bg-quotefly-blue" /> : null}
                      </span>
                    )}
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

          {!collapsed && <p className="px-2 pt-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Settings</p>}
          <nav className={cn("space-y-1", collapsed ? "px-0" : "px-1")}>
            {settingsLinks.map((link) => {
              const active = currentPage === link.path;
              const button = (
                <button
                  key={link.path}
                  type="button"
                  title={link.label}
                  aria-label={link.label}
                  onClick={() => onNavigate(link.path)}
                  className={cn(
                    "group flex w-full items-center rounded-xl border transition-all",
                    active
                      ? "border-quotefly-blue/20 bg-quotefly-blue/[0.08] text-slate-900"
                      : "border-transparent text-slate-600 hover:border-slate-200 hover:bg-white hover:text-slate-900",
                    collapsed ? "justify-center px-0 py-2.5" : "justify-between px-3 py-2.5",
                  )}
                >
                  <span className={cn("inline-flex items-center", collapsed ? "justify-center" : "gap-3")}>
                    <span
                      className={cn(
                        "inline-flex items-center justify-center rounded-2xl",
                        collapsed ? "h-9 w-9" : "h-8 w-8",
                        active ? "bg-white text-quotefly-blue" : "bg-slate-100 text-slate-500",
                      )}
                    >
                      {link.icon}
                    </span>
                    {!collapsed && (
                      <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                        <span>{link.label}</span>
                        {active ? <span className="h-1.5 w-1.5 rounded-full bg-quotefly-blue" /> : null}
                      </span>
                    )}
                  </span>
                  {collapsed ? (
                    <span className={cn("ml-1 h-2.5 w-2.5 rounded-full", active ? "bg-quotefly-blue" : "bg-slate-300")} />
                  ) : (
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${active ? "bg-white text-quotefly-blue" : "bg-slate-100 text-slate-500"}`}>
                      {active ? "Open" : ""}
                    </span>
                  )}
                </button>
              );

              return (
                <SidebarTooltip
                  key={link.path}
                  label={link.label}
                  collapsed={collapsed}
                >
                  {button}
                </SidebarTooltip>
              );
            })}
          </nav>
        </div>

        <div className={cn("mt-6 space-y-3", collapsed ? "px-2.5" : "px-3")}>
          {!collapsed && aiQuoteLimit !== null && usage ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">{showTrialBadge ? `Trial · ${displayPlanName}` : displayPlanName}</p>
                <span className="text-xs font-semibold text-slate-900">
                  {aiQuoteUsed}/{aiQuoteLimit} AI
                </span>
              </div>
              <ProgressBar
                value={aiUsagePercent}
                label="Monthly AI quote usage"
                hint={aiQuoteRemaining === 0 ? "Limit reached" : `${aiQuoteRemaining} left this month`}
                className="mt-3"
              />
            </div>
          ) : null}

          <SidebarTooltip label="Sign out" collapsed={collapsed}>
            <button
              type="button"
              onClick={onLogout}
              title="Sign Out"
              aria-label="Sign out"
              className={cn(
                "rounded-xl border border-slate-200 bg-white py-2.5 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:bg-slate-50",
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
