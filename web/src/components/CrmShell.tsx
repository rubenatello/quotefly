import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { BadgeInfo, Clock3, FilePlus2, LayoutDashboard, Lightbulb, MoreHorizontal, PackageSearch, Palette, Search, Settings2, UsersRound } from "lucide-react";
import type { PlanCode, TenantEntitlements, TenantUsageSnapshot } from "../lib/api";
import { setSEOMetadata } from "../lib/seo";
import { cn } from "../lib/utils";
import {
  AnalyticsIcon,
  CustomerIcon,
  QuoteIcon,
} from "./Icons";
import { CrmMobileHeader } from "./crm/CrmMobileHeader";
import { CrmSidebar, type CrmNavLink } from "./crm/CrmSidebar";
import { CrmLayoutFooter } from "./crm/CrmLayoutFooter";
import { Modal, ModalBody, ModalHeader } from "./ui";
import {
  WORKSPACE_OPERATIONS_LINKS,
  WORKSPACE_PAGE_META,
  WORKSPACE_SETTINGS_LINKS,
  type WorkspaceNavigationId,
  type WorkspacePage,
} from "./crm/workspace-navigation";

const CrmCommandPalette = lazy(() => import("./crm/CrmCommandPalette").then((module) => ({ default: module.CrmCommandPalette })));
const FeatureRequestForm = lazy(() => import("./feedback/FeatureRequestForm").then((module) => ({ default: module.FeatureRequestForm })));

interface CrmShellProps {
  currentPage: WorkspacePage;
  onNavigate: (page: WorkspaceNavigationId) => void;
  onQuickAction: (action: "new-customer" | "new-quote") => void;
  onLogout: () => void;
  children: ReactNode;
  fullName?: string;
  email?: string;
  planName?: string;
  planCode?: PlanCode;
  isTrial?: boolean;
  entitlements?: TenantEntitlements;
  usage?: TenantUsageSnapshot;
  canManageCatalog?: boolean;
}

function navigationIcon(icon: (typeof WORKSPACE_OPERATIONS_LINKS)[number]["icon"]) {
  if (icon === "home") return <LayoutDashboard size={15} />;
  if (icon === "customers") return <CustomerIcon size={15} />;
  if (icon === "team") return <UsersRound size={16} />;
  if (icon === "quotes") return <QuoteIcon size={15} />;
  if (icon === "products") return <PackageSearch size={15} />;
  if (icon === "follow-up") return <Clock3 size={15} />;
  if (icon === "analytics") return <AnalyticsIcon size={15} />;
  if (icon === "branding") return <Palette size={16} />;
  if (icon === "about") return <BadgeInfo size={16} />;
  return <Settings2 size={16} />;
}

const OPERATIONS_LINKS: readonly CrmNavLink[] = WORKSPACE_OPERATIONS_LINKS.map((item) => ({
  label: item.label,
  path: item.id,
  icon: navigationIcon(item.icon),
}));

const SETTINGS_LINKS: readonly CrmNavLink[] = WORKSPACE_SETTINGS_LINKS.map((item) => ({
  label: item.label,
  path: item.id,
  icon: navigationIcon(item.icon),
}));

export function CrmShell({
  currentPage,
  onNavigate,
  onQuickAction,
  onLogout,
  children,
  fullName,
  email,
  planName,
  isTrial,
  entitlements,
  usage,
  canManageCatalog = false,
}: CrmShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    const savedValue = localStorage.getItem("qf_sidebar_collapsed");
    return savedValue === "true";
  });
  const [commandOpen, setCommandOpen] = useState(false);
  const [featureRequestOpen, setFeatureRequestOpen] = useState(false);
  const mobileMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileDrawerWasOpenRef = useRef(false);

  useEffect(() => {
    localStorage.setItem("qf_sidebar_collapsed", sidebarCollapsed ? "true" : "false");
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!mobileOpen) return;

    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };

    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", closeOnEscape);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [mobileOpen]);

  useEffect(() => {
    const desktopMediaQuery = window.matchMedia("(min-width: 1024px)");
    const closeMobileDrawerAtDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) setMobileOpen(false);
    };

    desktopMediaQuery.addEventListener("change", closeMobileDrawerAtDesktop);
    return () => desktopMediaQuery.removeEventListener("change", closeMobileDrawerAtDesktop);
  }, []);

  useEffect(() => {
    if (mobileOpen) {
      mobileDrawerWasOpenRef.current = true;
      return;
    }

    if (!mobileDrawerWasOpenRef.current) return;
    mobileDrawerWasOpenRef.current = false;

    if (window.matchMedia("(min-width: 1024px)").matches) return;
    window.requestAnimationFrame(() => mobileMenuTriggerRef.current?.focus());
  }, [mobileOpen]);

  const handleNavigate = (page: WorkspaceNavigationId) => {
    onNavigate(page);
    setMobileOpen(false);
    setCommandOpen(false);
  };

  const handleQuickAction = (action: "new-customer" | "new-quote") => {
    setMobileOpen(false);
    onQuickAction(action);
  };

  const handleToggleMobile = () => {
    setCommandOpen(false);
    setMobileOpen((open) => !open);
  };

  const handleRequestFeature = () => {
    setMobileOpen(false);
    setCommandOpen(false);
    setFeatureRequestOpen(true);
  };

  const pageMeta = WORKSPACE_PAGE_META[currentPage];
  const operationsLinks = canManageCatalog
    ? OPERATIONS_LINKS
    : OPERATIONS_LINKS.filter((link) => link.path !== "products");
  const settingsLinks = canManageCatalog
    ? SETTINGS_LINKS
    : SETTINGS_LINKS.filter((link) => link.path === "settings" || link.path === "about");
  const allowedNavigationPages = [...operationsLinks, ...settingsLinks].map((link) => link.path);

  useEffect(() => {
    setSEOMetadata({
      title: pageMeta.label,
      description: pageMeta.hint,
    });
  }, [pageMeta.hint, pageMeta.label]);
  return (
    <div className="qf-workspace qf-theme-scope min-h-screen bg-qf-canvas text-qf-text">
      {pageMeta.headingPlacement === "shell" ? <h1 className="sr-only">{pageMeta.label}</h1> : null}
      <CrmMobileHeader
        mobileOpen={mobileOpen}
        backgroundInert={mobileOpen}
        menuButtonRef={mobileMenuTriggerRef}
        onToggleMobile={handleToggleMobile}
        onOpenCommand={() => setCommandOpen(true)}
        onNavigate={handleNavigate}
        onQuickAction={handleQuickAction}
        onLogout={onLogout}
        currentLabel={pageMeta.label}
        canManageWorkspace={canManageCatalog}
      />
      {commandOpen ? (
        <Suspense fallback={null}>
          <CrmCommandPalette
            open={commandOpen}
            onOpenChange={setCommandOpen}
            onNavigate={(page) => handleNavigate(page)}
            onQuickAction={handleQuickAction}
            allowedPages={allowedNavigationPages}
          />
        </Suspense>
      ) : null}

      <div
        className={`mx-auto w-full max-w-[1920px] lg:grid ${
          sidebarCollapsed ? "lg:grid-cols-[74px_1fr]" : "lg:grid-cols-[228px_1fr]"
        }`}
      >
        <CrmSidebar
          currentPage={currentPage}
          mobileOpen={mobileOpen}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((current) => !current)}
          onCloseMobile={() => setMobileOpen(false)}
          onNavigate={handleNavigate}
          operationsLinks={operationsLinks}
          settingsLinks={settingsLinks}
          onLogout={onLogout}
          onRequestFeature={handleRequestFeature}
          planName={planName}
          isTrial={isTrial}
          entitlements={entitlements}
          usage={usage}
        />

        {mobileOpen && (
          <button
            type="button"
            aria-label="Close navigation"
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => setMobileOpen(false)}
            className="fixed inset-0 z-40 bg-[var(--qf-overlay)] lg:hidden"
          />
        )}

        <div
          aria-hidden={mobileOpen || undefined}
          inert={mobileOpen || undefined}
          className="min-w-0"
        >
          <div className="sticky top-0 z-30 hidden border-b border-qf-border/80 bg-qf-surface/95 backdrop-blur-xl lg:block">
            <div className="flex w-full items-center justify-between gap-4 px-5 py-2 xl:px-8 2xl:px-10">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">
                  <span>QuoteFly workspace</span>
                  <span className="h-1 w-1 rounded-full bg-[var(--qf-border-strong)]" />
                  <span>{pageMeta.label}</span>
                </div>
                <p className="mt-1 truncate text-sm text-[var(--qf-text-soft)]">{pageMeta.hint}</p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleQuickAction("new-quote")}
                  className="inline-flex items-center gap-2 rounded-xl border border-[var(--qf-action-primary)] bg-[var(--qf-action-primary)] px-3.5 py-2 text-sm font-semibold text-[var(--qf-action-primary-text)] transition hover:border-[var(--qf-action-primary-hover)] hover:bg-[var(--qf-action-primary-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] active:bg-[var(--qf-action-primary-active)]"
                >
                  <FilePlus2 size={15} />
                  New quote
                </button>

                <button
                  type="button"
                  onClick={() => setCommandOpen(true)}
                      className="inline-flex min-w-[176px] items-center gap-3 rounded-xl border border-qf-border bg-qf-surface-muted px-3.5 py-2 text-sm font-medium text-qf-text-soft transition hover:border-[var(--qf-border-strong)] hover:bg-qf-surface hover:text-qf-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] xl:min-w-[196px] 2xl:min-w-[216px]"
                >
                  <span className="inline-flex items-center gap-2">
                    <Search size={15} />
                    Search or jump
                  </span>
                </button>

                <DropdownMenuPrimitive.Root>
                  <DropdownMenuPrimitive.Trigger asChild>
                    <button
                      type="button"
                      className="inline-flex items-center gap-3 rounded-xl border border-qf-border bg-qf-surface px-2.5 py-1.5 transition hover:border-[var(--qf-border-strong)] hover:bg-[var(--qf-interactive-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]"
                    >
                      <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-quotefly-blue text-sm font-semibold text-white">
                        {(fullName ?? "Q")
                          .split(" ")
                          .map((part) => part[0])
                          .join("")
                          .slice(0, 2)
                          .toUpperCase()}
                      </span>
                      <span className="hidden text-left xl:block">
                        <span className="block max-w-[160px] truncate text-sm font-semibold text-[var(--qf-text)]">{fullName ?? "QuoteFly User"}</span>
                      </span>
                      <MoreHorizontal size={16} className="text-[var(--qf-text-muted)]" />
                    </button>
                  </DropdownMenuPrimitive.Trigger>
                  <DropdownMenuPrimitive.Portal>
                    <DropdownMenuPrimitive.Content
                      align="end"
                      sideOffset={12}
                      className="qf-theme-scope z-[130] min-w-[240px] rounded-[24px] border border-qf-border bg-qf-surface p-2 text-qf-text shadow-[var(--qf-shadow-md)]"
                    >
                      <div className="rounded-[18px] bg-[var(--qf-panel-muted)] px-3 py-3">
                        <p className="text-sm font-semibold text-[var(--qf-text)]">{fullName ?? "QuoteFly User"}</p>
                      </div>
                      <div className="mt-2 space-y-1">
                        {([
                          { label: "Open home", page: "home" },
                          { label: "Open customers", page: "customers" },
                          { label: "Open products", page: "products" },
                          { label: "Open settings", page: "settings" },
                          ...(canManageCatalog ? [{ label: "Open branding", page: "branding" } as const] : []),
                          { label: "About workspace", page: "about" },
                        ] as const).map((item) => (
                          <DropdownMenuPrimitive.Item
                            key={item.page}
                            onSelect={() => handleNavigate(item.page)}
                            className={cn("cursor-pointer rounded-2xl px-3 py-2.5 text-sm text-[var(--qf-text-soft)] outline-none transition hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)] focus:bg-[var(--qf-interactive-hover)] focus:text-[var(--qf-text)] data-[highlighted]:bg-[var(--qf-interactive-hover)] data-[highlighted]:text-[var(--qf-text)]")}
                          >
                            {item.label}
                          </DropdownMenuPrimitive.Item>
                        ))}
                      </div>
                      <DropdownMenuPrimitive.Separator className="my-2 h-px bg-[var(--qf-border)]" />
                      <DropdownMenuPrimitive.Item
                        onSelect={handleRequestFeature}
                        className={cn("flex cursor-pointer items-center gap-2 rounded-2xl px-3 py-2.5 text-sm text-[var(--qf-text-soft)] outline-none transition hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)] focus:bg-[var(--qf-interactive-hover)] data-[highlighted]:bg-[var(--qf-interactive-hover)] data-[highlighted]:text-[var(--qf-text)]")}
                      >
                        <Lightbulb size={15} className="text-quotefly-blue" aria-hidden="true" />
                        Request a feature
                      </DropdownMenuPrimitive.Item>
                      <DropdownMenuPrimitive.Separator className="my-2 h-px bg-[var(--qf-border)]" />
                      <DropdownMenuPrimitive.Item
                        onSelect={() => onLogout()}
                        className={cn("cursor-pointer rounded-2xl px-3 py-2.5 text-sm text-[var(--qf-danger-text)] outline-none transition hover:bg-[var(--qf-danger-surface)] focus:bg-[var(--qf-danger-surface)] data-[highlighted]:bg-[var(--qf-danger-surface)]")}
                      >
                        Sign out
                      </DropdownMenuPrimitive.Item>
                    </DropdownMenuPrimitive.Content>
                  </DropdownMenuPrimitive.Portal>
                </DropdownMenuPrimitive.Root>
              </div>
            </div>
          </div>

          {children}
          <div className="pb-[var(--qf-mobile-content-clearance)] lg:pb-0">
            <CrmLayoutFooter />
          </div>
        </div>
      </div>

      <Modal
        open={featureRequestOpen}
        onClose={() => setFeatureRequestOpen(false)}
        size="lg"
        ariaLabel="Request a QuoteFly feature"
      >
        <ModalHeader
          title="Request a feature"
          description="Tell us what would make QuoteFly faster or easier on the job."
          onClose={() => setFeatureRequestOpen(false)}
        />
        <ModalBody>
          <Suspense fallback={<p className="text-sm text-slate-500">Loading feature request form...</p>}>
            <FeatureRequestForm
              source="WORKSPACE"
              initialName={fullName}
              initialEmail={email}
            />
          </Suspense>
        </ModalBody>
      </Modal>
    </div>
  );
}
