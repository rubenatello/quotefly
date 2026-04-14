import { useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, FilePlus2, Search, UserPlus2, X } from "lucide-react";
import type { TenantEntitlements, TenantUsageSnapshot } from "../../lib/api";
import { CloseIcon } from "../Icons";
import { cn } from "../../lib/utils";
import { formatAiRenewalDate } from "../../lib/ai-credits";
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
  const [navQuery, setNavQuery] = useState("");
  const displayPlanName = planName ?? "Starter";
  const showTrialBadge = Boolean(isTrial);

  const sidebarWidthClass = collapsed ? "lg:w-[74px]" : "lg:w-[228px]";
  const aiQuoteLimit = entitlements?.limits.aiQuotesPerMonth ?? null;
  const aiQuoteUsed = usage?.monthlyAiQuoteCount ?? 0;
  const aiQuoteRemaining = aiQuoteLimit === null ? null : Math.max(aiQuoteLimit - aiQuoteUsed, 0);
  const aiUsagePercent = aiQuoteLimit && aiQuoteLimit > 0 ? Math.min((aiQuoteUsed / aiQuoteLimit) * 100, 100) : 0;
  const aiRenewalLabel = formatAiRenewalDate(usage?.periodEndUtc ?? null);
  const normalizedNavQuery = navQuery.trim().toLowerCase();

  const filteredOperationsLinks = useMemo(
    () => operationsLinks.filter((link) => `${link.label} ${link.path}`.toLowerCase().includes(normalizedNavQuery)),
    [operationsLinks, normalizedNavQuery],
  );

  const filteredSettingsLinks = useMemo(
    () => settingsLinks.filter((link) => `${link.label} ${link.path}`.toLowerCase().includes(normalizedNavQuery)),
    [settingsLinks, normalizedNavQuery],
  );

  const totalNavItems = filteredOperationsLinks.length + filteredSettingsLinks.length;

  return (
    <AppTooltipProvider>
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-72 border-r border-slate-200 bg-white py-3 transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 lg:overflow-y-auto ${sidebarWidthClass} ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className={cn("space-y-4", collapsed ? "px-2.5" : "px-3.5")}>
          <div className={cn("flex items-center border-b border-slate-200 pb-3", collapsed ? "flex-col gap-3" : "justify-between gap-3")}>
            <button
              type="button"
              onClick={() => onNavigate("customers")}
              className={cn("inline-flex items-center", collapsed ? "justify-center" : "")}
              title="QuoteFly Customers"
              aria-label="Go to customers"
            >
              {collapsed ? <img src="/favicon.png" alt="QuoteFly" className="h-7 w-7 object-contain" /> : <img src="/logo.png" alt="QuoteFly" className="h-7 w-auto object-contain" />}
            </button>
            <button
              type="button"
              onClick={onToggleCollapse}
              className={cn(
                "hidden items-center justify-center text-slate-400 transition hover:text-slate-700 lg:inline-flex",
                collapsed ? "h-7 w-7 self-center" : "h-7 w-7",
              )}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {collapsed ? <ChevronRight size={18} strokeWidth={2.25} /> : <ChevronLeft size={18} strokeWidth={2.25} />}
            </button>
          </div>

          {!collapsed ? (
            <div className="space-y-3">
              <div className="relative">
                <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-quotefly-blue" />
                <input
                  type="text"
                  value={navQuery}
                  onChange={(event) => setNavQuery(event.target.value)}
                  placeholder="Search navigation"
                  className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pl-10 pr-10 text-sm text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-quotefly-blue focus:bg-white focus:ring-2 focus:ring-quotefly-blue/10"
                />
                {navQuery ? (
                  <button
                    type="button"
                    onClick={() => setNavQuery("")}
                    aria-label="Clear navigation search"
                    className="absolute right-3 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                  >
                    <X size={13} />
                  </button>
                ) : null}
              </div>

              <div className="space-y-2 border-b border-slate-200 pb-3">
                <p className="px-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">Quick add</p>
                <button
                  type="button"
                  onClick={() => onQuickAction("new-quote")}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-quotefly-blue bg-quotefly-blue px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-[#256fbf]"
                >
                  <FilePlus2 size={15} />
                  New quote
                </button>
                <button
                  type="button"
                  onClick={() => onQuickAction("new-customer")}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:bg-white"
                >
                  <UserPlus2 size={15} className="text-quotefly-blue" />
                  New customer
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
                  className="inline-flex h-10 w-full items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                >
                  <UserPlus2 size={16} className="text-quotefly-blue" />
                </button>
              </SidebarTooltip>
              <SidebarTooltip label="New quote" collapsed={collapsed}>
                <button
                  type="button"
                  onClick={() => onQuickAction("new-quote")}
                  aria-label="New quote"
                  className="inline-flex h-10 w-full items-center justify-center rounded-lg border border-quotefly-blue bg-quotefly-blue text-white transition hover:bg-[#256fbf]"
                >
                  <FilePlus2 size={16} />
                </button>
              </SidebarTooltip>
            </div>
          )}

          {!collapsed ? (
            <div className="flex items-center justify-between px-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Navigation</p>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">{totalNavItems}</span>
            </div>
          ) : null}

          <nav className={cn("space-y-1", collapsed ? "px-0" : "px-1")}>
            {filteredOperationsLinks.map((link) => {
              const active = currentPage === link.path;
              const button = (
                <button
                  key={link.path}
                  type="button"
                  onClick={() => onNavigate(link.path)}
                  title={link.label}
                  aria-label={link.label}
                  className={cn(
                    "group relative flex w-full items-center rounded-lg border text-sm font-medium transition-colors",
                    active
                      ? "border-quotefly-blue/10 bg-quotefly-blue/[0.08] text-slate-900"
                      : "border-transparent text-slate-600 hover:bg-slate-50 hover:text-slate-900",
                    collapsed ? "justify-center px-0 py-2.5" : "justify-between px-3 py-2.5",
                  )}
                >
                  {active && !collapsed ? <span className="absolute inset-y-2 left-0 w-1 rounded-r-full bg-quotefly-blue" /> : null}
                  <span className={cn("inline-flex items-center", collapsed ? "justify-center" : "gap-3")}>
                    <span
                      className={cn(
                        "inline-flex items-center justify-center transition",
                        collapsed ? "h-8 w-8" : "h-5 w-5",
                        active
                          ? "text-quotefly-blue"
                          : "text-slate-500 group-hover:text-quotefly-blue",
                      )}
                    >
                      {link.icon}
                    </span>
                    {!collapsed ? (
                      <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                        <span>{link.label}</span>
                        {active ? <span className="h-1.5 w-1.5 rounded-full bg-quotefly-blue" /> : null}
                      </span>
                    ) : null}
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

          {!collapsed ? <p className="px-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Settings</p> : null}
          <nav className={cn("space-y-1", collapsed ? "px-0" : "px-1")}>
            {filteredSettingsLinks.map((link) => {
              const active = currentPage === link.path;
              const button = (
                <button
                  key={link.path}
                  type="button"
                  title={link.label}
                  aria-label={link.label}
                  onClick={() => onNavigate(link.path)}
                  className={cn(
                    "group relative flex w-full items-center rounded-lg border transition-colors",
                    active
                      ? "border-quotefly-blue/10 bg-quotefly-blue/[0.08] text-slate-900"
                      : "border-transparent text-slate-600 hover:bg-slate-50 hover:text-slate-900",
                    collapsed ? "justify-center px-0 py-2.5" : "justify-between px-3 py-2.5",
                  )}
                >
                  {active && !collapsed ? <span className="absolute inset-y-2 left-0 w-1 rounded-r-full bg-quotefly-blue" /> : null}
                  <span className={cn("inline-flex items-center", collapsed ? "justify-center" : "gap-3")}>
                    <span
                      className={cn(
                        "inline-flex items-center justify-center",
                        collapsed ? "h-8 w-8" : "h-5 w-5",
                        active ? "text-quotefly-blue" : "text-slate-500 group-hover:text-quotefly-blue",
                      )}
                    >
                      {link.icon}
                    </span>
                    {!collapsed ? (
                      <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                        <span>{link.label}</span>
                        {active ? <span className="h-1.5 w-1.5 rounded-full bg-quotefly-blue" /> : null}
                      </span>
                    ) : null}
                  </span>
                  {collapsed ? <span className={cn("ml-1 h-2.5 w-2.5 rounded-full", active ? "bg-quotefly-blue" : "bg-slate-300")} /> : null}
                </button>
              );

              return (
                <SidebarTooltip key={link.path} label={link.label} collapsed={collapsed}>
                  {button}
                </SidebarTooltip>
              );
            })}
          </nav>

          {!collapsed && navQuery && totalNavItems === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-3 py-4 text-center text-sm text-slate-500">
              No navigation matches for <span className="font-medium text-slate-700">{navQuery}</span>.
            </div>
          ) : null}
        </div>

        <div className={cn("mt-6 space-y-3", collapsed ? "px-2.5" : "px-3")}>
          {!collapsed && aiQuoteLimit !== null && usage ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                  {showTrialBadge ? `Trial · ${displayPlanName}` : displayPlanName}
                </p>
                <span className="text-xs font-semibold text-slate-900">
                  {aiQuoteUsed}/{aiQuoteLimit} AI
                </span>
              </div>
              <ProgressBar
                value={aiUsagePercent}
                label="Monthly AI credit usage"
                hint={
                  aiQuoteRemaining === 0
                    ? aiRenewalLabel
                      ? `Limit reached · renews ${aiRenewalLabel}`
                      : "Limit reached"
                    : aiRenewalLabel
                      ? `${aiQuoteRemaining} left · renews ${aiRenewalLabel}`
                      : `${aiQuoteRemaining} left this month`
                }
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
                "rounded-lg border border-slate-200 bg-white py-2.5 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:bg-slate-50",
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
