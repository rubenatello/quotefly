import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, LifeBuoy, Lightbulb } from "lucide-react";
import type { TenantEntitlements, TenantUsageSnapshot } from "../../lib/api";
import { SUPPORT_MAILTO } from "../../lib/contact";
import { CloseIcon } from "../Icons";
import { cn } from "../../lib/utils";
import { aiUsageProgressTone, formatAiRenewalDate } from "../../lib/ai-credits";
import { AppTooltip, AppTooltipProvider } from "../ui/tooltip";
import { ProgressBar } from "../ui";
import {
  isWorkspaceNavigationActive,
  type WorkspaceNavigationId,
  type WorkspacePage,
} from "./workspace-navigation";

export interface CrmNavLink {
  label: string;
  path: WorkspaceNavigationId;
  icon: ReactNode;
}

interface CrmSidebarProps {
  currentPage: WorkspacePage;
  mobileOpen: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onCloseMobile: () => void;
  onNavigate: (page: WorkspaceNavigationId) => void;
  operationsLinks: readonly CrmNavLink[];
  settingsLinks: readonly CrmNavLink[];
  onLogout: () => void;
  onRequestFeature: () => void;
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
  collapsed: desktopCollapsed,
  onToggleCollapse,
  onCloseMobile,
  onNavigate,
  operationsLinks,
  settingsLinks,
  onLogout,
  onRequestFeature,
  planName,
  isTrial,
  entitlements,
  usage,
}: CrmSidebarProps) {
  const sidebarRef = useRef<HTMLElement>(null);
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia("(min-width: 1024px)").matches);
  const collapsed = desktopCollapsed && !mobileOpen;
  const isHidden = !isDesktop && !mobileOpen;
  const displayPlanName = planName ?? "Basic";
  const showTrialBadge = Boolean(isTrial);

  const sidebarWidthClass = collapsed ? "lg:w-[74px]" : "lg:w-[228px]";
  const aiSpendLimitUsd = entitlements?.limits.aiSpendUsdPerMonth ?? null;
  const aiSpendUsedUsd = usage?.monthlyAiSpendUsd ?? 0;
  const aiUsagePercent =
    usage?.monthlyAiSpendUsagePercent ??
    (aiSpendLimitUsd && aiSpendLimitUsd > 0
      ? Math.min((aiSpendUsedUsd / aiSpendLimitUsd) * 100, 100)
      : 0);
  const usagePercentLabel = useMemo(() => `${Math.round(aiUsagePercent)}% used`, [aiUsagePercent]);
  const aiRenewalLabel = formatAiRenewalDate(usage?.periodEndUtc ?? null);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(min-width: 1024px)");
    const updateViewport = () => setIsDesktop(mediaQuery.matches);
    updateViewport();
    mediaQuery.addEventListener("change", updateViewport);
    return () => mediaQuery.removeEventListener("change", updateViewport);
  }, []);

  useEffect(() => {
    if (!mobileOpen || isDesktop) return;
    window.requestAnimationFrame(() => {
      const sidebar = sidebarRef.current;
      const initialFocus = sidebar?.querySelector<HTMLElement>("[data-mobile-drawer-initial-focus]");
      (initialFocus ?? sidebar)?.focus();
    });
  }, [isDesktop, mobileOpen]);

  const handleDrawerKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!mobileOpen || isDesktop || event.key !== "Tab") return;

    const sidebar = sidebarRef.current;
    if (!sidebar) return;

    const focusableElements = Array.from(
      sidebar.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");

    if (focusableElements.length === 0) {
      event.preventDefault();
      sidebar.focus();
      return;
    }

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];
    const activeElement = document.activeElement;

    if (event.shiftKey && (activeElement === firstElement || !sidebar.contains(activeElement))) {
      event.preventDefault();
      lastElement.focus();
      return;
    }

    if (!event.shiftKey && (activeElement === lastElement || !sidebar.contains(activeElement))) {
      event.preventDefault();
      firstElement.focus();
    }
  };

  return (
    <AppTooltipProvider>
      <aside
        ref={sidebarRef}
        id="quotefly-workspace-navigation"
        data-testid="workspace-sidebar"
        data-collapsed={collapsed ? "true" : "false"}
        role={!isDesktop && mobileOpen ? "dialog" : undefined}
        aria-modal={!isDesktop && mobileOpen ? "true" : undefined}
        aria-label="Workspace navigation"
        aria-hidden={isHidden || undefined}
        inert={isHidden || undefined}
        tabIndex={-1}
        onKeyDown={handleDrawerKeyDown}
        className={`qf-workspace-sidebar fixed inset-y-0 left-0 z-50 w-72 overflow-x-hidden overflow-y-auto border-r border-qf-border bg-qf-surface py-3 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 ${sidebarWidthClass} ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className={cn("space-y-4 transition-[padding] duration-300", collapsed ? "px-2.5" : "px-3.5")}>
          <div className={cn("flex items-center border-b border-[var(--qf-border)] pb-3 transition-all duration-300", collapsed ? "flex-col gap-3" : "justify-between gap-3")}>
            <button
              type="button"
              onClick={() => onNavigate("home")}
              className={cn(
                "relative inline-flex h-7 shrink-0 items-center overflow-hidden transition-[width] duration-300",
                collapsed ? "w-7 justify-center" : "w-[126px]",
              )}
              title="QuoteFly workspace home"
              aria-label="Go to workspace home"
            >
              <img
                src="/logo.png"
                alt="QuoteFly"
                className={cn("absolute left-0 h-7 w-auto max-w-none object-contain transition-[opacity,transform] duration-200", collapsed ? "translate-x-1 opacity-0" : "translate-x-0 opacity-100")}
              />
              <img
                src="/favicon.png"
                alt=""
                aria-hidden="true"
                className={cn("absolute left-0 h-7 w-7 object-contain transition-[opacity,transform] duration-200", collapsed ? "translate-x-0 opacity-100" : "-translate-x-1 opacity-0")}
              />
            </button>
            <button
              type="button"
              onClick={onToggleCollapse}
              className={cn(
                "hidden items-center justify-center rounded-lg text-[var(--qf-text-muted)] transition hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)] focus-visible:outline-2 focus-visible:outline-[var(--qf-focus)] lg:inline-flex",
                collapsed ? "h-7 w-7 self-center" : "h-7 w-7",
              )}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {collapsed ? <ChevronRight size={18} strokeWidth={2.25} /> : <ChevronLeft size={18} strokeWidth={2.25} />}
            </button>
            <button
              type="button"
              onClick={onCloseMobile}
              data-mobile-drawer-initial-focus
              className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] text-[var(--qf-text-soft)] transition hover:border-[var(--qf-border-strong)] hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] lg:hidden"
              aria-label="Close navigation"
            >
              <CloseIcon size={18} />
            </button>
          </div>

          {!collapsed ? <div className="flex items-center justify-between px-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">Navigation</p>
          </div> : null}

          <nav className={cn("space-y-1", collapsed ? "px-0" : "px-1")}>
            {operationsLinks.map((link) => {
              const active = isWorkspaceNavigationActive(link.path, currentPage);
              const button = (
                <button
                  key={link.path}
                  type="button"
                  onClick={() => onNavigate(link.path)}
                  title={link.label}
                  aria-label={link.label}
                  aria-current={active ? "page" : undefined}
                  data-current={active ? "true" : "false"}
                  className={cn(
                    "qf-sidebar-nav-item group relative flex w-full min-h-[44px] items-center rounded-lg border text-sm font-medium transition-[border-color,background-color,color,box-shadow] sm:min-h-[40px]",
                    active
                      ? "border-[var(--qf-info-border)] bg-[var(--qf-selected)] text-[var(--qf-text)]"
                      : "border-transparent text-[var(--qf-text-soft)] hover:border-[var(--qf-border)] hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)]",
                    collapsed ? "justify-center px-0 py-2.5" : "justify-between px-3 py-2.5",
                  )}
                >
                  <span className={cn("inline-flex items-center", collapsed ? "justify-center" : "gap-3")}>
                    <span
                      className={cn(
                        "inline-flex items-center justify-center rounded-lg transition",
                        collapsed ? "h-8 w-8" : "h-5 w-5",
                        active
                          ? "bg-[var(--qf-info-surface)] text-[var(--qf-link)]"
                          : "text-[var(--qf-text-muted)] group-hover:text-[var(--qf-link)]",
                      )}
                    >
                      {link.icon}
                    </span>
                    <span aria-hidden={collapsed} className="qf-sidebar-nav-label min-w-0 flex-1 text-left">{link.label}</span>
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

          {!collapsed ? <p className="px-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">Workspace</p> : null}
          <nav className={cn("space-y-1", collapsed ? "px-0" : "px-1")}>
            {settingsLinks.map((link) => {
              const active = isWorkspaceNavigationActive(link.path, currentPage);
              const button = (
                <button
                  key={link.path}
                  type="button"
                  title={link.label}
                  aria-label={link.label}
                  aria-current={active ? "page" : undefined}
                  data-current={active ? "true" : "false"}
                  onClick={() => onNavigate(link.path)}
                  className={cn(
                    "qf-sidebar-nav-item group relative flex w-full min-h-[44px] items-center rounded-lg border transition-[border-color,background-color,color,box-shadow] sm:min-h-[40px]",
                    active
                      ? "border-[var(--qf-info-border)] bg-[var(--qf-selected)] text-[var(--qf-text)]"
                      : "border-transparent text-[var(--qf-text-soft)] hover:border-[var(--qf-border)] hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)]",
                    collapsed ? "justify-center px-0 py-2.5" : "justify-between px-3 py-2.5",
                  )}
                >
                  <span className={cn("inline-flex items-center", collapsed ? "justify-center" : "gap-3")}>
                    <span
                      className={cn(
                        "inline-flex items-center justify-center rounded-lg transition",
                        collapsed ? "h-9 w-9" : "h-8 w-8",
                        active
                          ? "bg-[var(--qf-info-surface)] text-[var(--qf-link)]"
                          : "bg-[var(--qf-panel-muted)] text-[var(--qf-text-muted)] group-hover:bg-[var(--qf-info-surface)] group-hover:text-[var(--qf-link)]",
                      )}
                    >
                      {link.icon}
                    </span>
                    <span aria-hidden={collapsed} className="qf-sidebar-nav-label min-w-0 flex-1 text-left">{link.label}</span>
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

        </div>

        <div className={cn("mt-6 space-y-3 transition-[padding] duration-300", collapsed ? "px-2.5" : "px-3")}>
          {aiSpendLimitUsd !== null && usage ? (
            <div aria-hidden={collapsed} className="qf-sidebar-detail rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">
                  {showTrialBadge ? "Full trial access" : displayPlanName}
                </p>
                <span className="text-xs font-semibold text-[var(--qf-text)]">
                  {usagePercentLabel}
                </span>
              </div>
              <ProgressBar
                value={aiUsagePercent}
                label="Monthly AI usage"
                tone={aiUsageProgressTone(aiUsagePercent)}
                hint={
                  aiUsagePercent >= 100
                    ? aiRenewalLabel
                      ? `Usage limit reached · renews ${aiRenewalLabel}`
                      : "Limit reached"
                    : aiRenewalLabel
                      ? `Renews ${aiRenewalLabel}`
                      : undefined
                }
                className="mt-3"
              />
            </div>
          ) : null}

          <SidebarTooltip label="Request a feature" collapsed={collapsed}>
            <button
              type="button"
              onClick={onRequestFeature}
              aria-label="Request a feature"
              className={cn(
                "inline-flex min-h-[44px] w-full items-center justify-center rounded-lg border border-[var(--qf-info-border)] bg-[var(--qf-info-surface)] py-2.5 text-sm font-medium text-[var(--qf-info-text)] transition hover:bg-[var(--qf-info-surface-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] sm:min-h-[40px]",
                collapsed ? "px-0" : "gap-2 px-4",
              )}
            >
              <Lightbulb size={15} aria-hidden="true" />
              <span aria-hidden={collapsed} className="qf-sidebar-action-label">Request a feature</span>
            </button>
          </SidebarTooltip>

          <SidebarTooltip label="Contact support" collapsed={collapsed}>
            <a
              href={SUPPORT_MAILTO}
              aria-label="Contact support"
              className={cn(
                "inline-flex min-h-[44px] w-full items-center justify-center rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel)] py-2.5 text-sm font-medium text-[var(--qf-text-soft)] transition hover:border-[var(--qf-border-strong)] hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] sm:min-h-[40px]",
                collapsed ? "px-0" : "gap-2 px-4",
              )}
            >
              <LifeBuoy size={15} className="text-quotefly-blue" aria-hidden="true" />
              <span aria-hidden={collapsed} className="qf-sidebar-action-label">Contact support</span>
            </a>
          </SidebarTooltip>

          <SidebarTooltip label="Sign out" collapsed={collapsed}>
            <button
              type="button"
              onClick={onLogout}
              title="Sign Out"
              aria-label="Sign out"
              className={cn(
                "min-h-[44px] rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel)] py-2.5 text-sm font-medium text-[var(--qf-text-soft)] transition hover:border-[var(--qf-danger-border)] hover:bg-[var(--qf-danger-surface)] hover:text-[var(--qf-danger-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] sm:min-h-[40px]",
                collapsed ? "w-full px-0 text-center" : "w-full px-4",
              )}
            >
              <span className={cn("inline-flex items-center", collapsed ? "justify-center gap-0" : "gap-2")}>
                <CloseIcon size={14} />
                <span aria-hidden={collapsed} className="qf-sidebar-action-label">Sign Out</span>
              </span>
            </button>
          </SidebarTooltip>
        </div>
      </aside>
    </AppTooltipProvider>
  );
}
