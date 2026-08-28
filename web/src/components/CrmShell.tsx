import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { FilePlus2, Lightbulb, MoreHorizontal, Search, UserRoundPlus } from "lucide-react";
import type { PlanCode, TenantEntitlements, TenantUsageSnapshot } from "../lib/api";
import { setSEOMetadata } from "../lib/seo";
import { cn } from "../lib/utils";
import {
  WorkspaceNavigationIcon,
  type WorkspaceIconName,
} from "./Icons";
import { CrmMobileHeader } from "./crm/CrmMobileHeader";
import { CrmSidebar, type CrmNavLink } from "./crm/CrmSidebar";
import { CrmLayoutFooter } from "./crm/CrmLayoutFooter";
import { Modal, ModalBody, ModalHeader } from "./ui";
import { AppTooltip, AppTooltipProvider } from "./ui/tooltip";
import { NotificationBellButton, NotificationCenter } from "./notifications/NotificationCenter";
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
  displayTimeZone: string;
  onNavigateToJob: (jobId: string) => void;
}

function navigationIcon(icon: (typeof WORKSPACE_OPERATIONS_LINKS)[number]["icon"]) {
  const name: WorkspaceIconName = icon === "follow-up" ? "followUp" : icon;
  return {
    icon: <WorkspaceNavigationIcon name={name} size={18} />,
    activeIcon: <WorkspaceNavigationIcon name={name} active size={18} />,
  };
}

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
  displayTimeZone,
  onNavigateToJob,
}: CrmShellProps) {
  const { t } = useTranslation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    const savedValue = localStorage.getItem("qf_sidebar_collapsed");
    return savedValue === "true";
  });
  const [commandOpen, setCommandOpen] = useState(false);
  const [featureRequestOpen, setFeatureRequestOpen] = useState(false);
  const [notificationCenterOpen, setNotificationCenterOpen] = useState(false);
  const [notificationUnreadCount, setNotificationUnreadCount] = useState(0);
  const mobileMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileNotificationTriggerRef = useRef<HTMLButtonElement>(null);
  const desktopNotificationTriggerRef = useRef<HTMLButtonElement>(null);
  const notificationReturnFocusRef = useRef<HTMLButtonElement | null>(null);
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

  const handleOpenNotifications = (source: "mobile" | "desktop") => {
    notificationReturnFocusRef.current = source === "mobile"
      ? mobileNotificationTriggerRef.current
      : desktopNotificationTriggerRef.current;
    setNotificationCenterOpen(true);
  };

  const pageMeta = WORKSPACE_PAGE_META[currentPage];
  const pageLabel = t(`${pageMeta.translationKey}.label`);
  const pageHint = t(`${pageMeta.translationKey}.hint`);
  const translatedOperationsLinks: readonly CrmNavLink[] = WORKSPACE_OPERATIONS_LINKS.map((item) => ({
    label: t(item.labelKey),
    path: item.id,
    ...navigationIcon(item.icon),
  }));
  const translatedSettingsLinks: readonly CrmNavLink[] = WORKSPACE_SETTINGS_LINKS.map((item) => ({
    label: t(item.labelKey),
    path: item.id,
    ...navigationIcon(item.icon),
  }));
  const operationsLinks = canManageCatalog
    ? translatedOperationsLinks
    : translatedOperationsLinks.filter((link) => link.path !== "products");
  const settingsLinks = canManageCatalog
    ? translatedSettingsLinks
    : translatedSettingsLinks.filter((link) => link.path === "settings" || link.path === "about");
  const allowedNavigationPages = [...operationsLinks, ...settingsLinks].map((link) => link.path);

  useEffect(() => {
    setSEOMetadata({
      title: pageMeta.label,
      description: pageHint,
    });
  }, [pageHint, pageLabel, pageMeta.label]);
  return (
    <div className="qf-workspace qf-theme-scope min-h-screen bg-qf-canvas text-qf-text">
      {pageMeta.headingPlacement === "shell" ? <h1 className="sr-only">{pageLabel}</h1> : null}
      <CrmMobileHeader
        mobileOpen={mobileOpen}
        backgroundInert={mobileOpen}
        menuButtonRef={mobileMenuTriggerRef}
        onToggleMobile={handleToggleMobile}
        onOpenCommand={() => setCommandOpen(true)}
        onNavigate={handleNavigate}
        onQuickAction={handleQuickAction}
        onLogout={onLogout}
        currentLabel={pageLabel}
        canManageWorkspace={canManageCatalog}
        notificationButtonRef={mobileNotificationTriggerRef}
        notificationUnreadCount={notificationUnreadCount}
        onOpenNotifications={() => handleOpenNotifications("mobile")}
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
        className={`qf-workspace-shell-grid mx-auto w-full max-w-[1920px] lg:grid ${
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
            aria-label={t("navigation.close")}
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
                  <span>{t("navigation.workspaceName")}</span>
                  <span className="h-1 w-1 rounded-full bg-[var(--qf-border-strong)]" />
                  <span>{pageLabel}</span>
                </div>
                <p className="mt-1 truncate text-sm text-[var(--qf-text-soft)]">{pageHint}</p>
              </div>

              <div className="flex items-center gap-2">
                <NotificationBellButton
                  buttonRef={desktopNotificationTriggerRef}
                  unreadCount={notificationUnreadCount}
                  onClick={() => handleOpenNotifications("desktop")}
                  className="bg-qf-surface"
                />
                <AppTooltipProvider>
                  <div className="flex items-center gap-1.5" role="group" aria-label={t("navigation.quickCommands")}>
                    <AppTooltip content={t("navigation.newCustomer")} side="bottom">
                      <button
                        type="button"
                        aria-label={t("navigation.newCustomer")}
                        onClick={() => handleQuickAction("new-customer")}
                        className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-qf-border bg-qf-surface text-qf-text-soft transition hover:border-[var(--qf-border-strong)] hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-link)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] active:bg-[var(--qf-selected)]"
                      >
                        <UserRoundPlus size={18} aria-hidden="true" />
                      </button>
                    </AppTooltip>
                    <AppTooltip content={t("navigation.newQuote")} side="bottom">
                      <button
                        type="button"
                        aria-label={t("navigation.newQuote")}
                        onClick={() => handleQuickAction("new-quote")}
                        className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--qf-action-primary)] bg-[var(--qf-action-primary)] text-[var(--qf-action-primary-text)] transition hover:border-[var(--qf-action-primary-hover)] hover:bg-[var(--qf-action-primary-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] active:bg-[var(--qf-action-primary-active)]"
                      >
                        <FilePlus2 size={18} aria-hidden="true" />
                      </button>
                    </AppTooltip>
                  </div>
                </AppTooltipProvider>

                <button
                  type="button"
                  onClick={() => setCommandOpen(true)}
                      className="inline-flex min-w-[176px] items-center gap-3 rounded-xl border border-qf-border bg-qf-surface-muted px-3.5 py-2 text-sm font-medium text-qf-text-soft transition hover:border-[var(--qf-border-strong)] hover:bg-qf-surface hover:text-qf-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] xl:min-w-[196px] 2xl:min-w-[216px]"
                >
                  <span className="inline-flex items-center gap-2">
                    <Search size={15} />
                    {t("navigation.searchOrJump")}
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
                          { label: t("navigation.openHome"), page: "home" },
                          { label: t("navigation.openCustomers"), page: "customers" },
                          { label: t("navigation.openProducts"), page: "products" },
                          { label: t("navigation.openSettings"), page: "settings" },
                          ...(canManageCatalog ? [{ label: t("navigation.openBranding"), page: "branding" } as const] : []),
                          { label: t("navigation.myInfo"), page: "about" },
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
                        {t("navigation.requestFeature")}
                      </DropdownMenuPrimitive.Item>
                      <DropdownMenuPrimitive.Separator className="my-2 h-px bg-[var(--qf-border)]" />
                      <DropdownMenuPrimitive.Item
                        onSelect={() => onLogout()}
                        className={cn("cursor-pointer rounded-2xl px-3 py-2.5 text-sm text-[var(--qf-danger-text)] outline-none transition hover:bg-[var(--qf-danger-surface)] focus:bg-[var(--qf-danger-surface)] data-[highlighted]:bg-[var(--qf-danger-surface)]")}
                      >
                        {t("navigation.signOut")}
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

      <NotificationCenter
        open={notificationCenterOpen}
        onOpenChange={setNotificationCenterOpen}
        displayTimeZone={displayTimeZone}
        onUnreadCountChange={setNotificationUnreadCount}
        onOpenJob={onNavigateToJob}
        returnFocusRef={notificationReturnFocusRef}
      />

      <Modal
        open={featureRequestOpen}
        onClose={() => setFeatureRequestOpen(false)}
        size="lg"
        ariaLabel={t("navigation.requestFeatureTitle")}
      >
        <ModalHeader
          title={t("navigation.requestFeature")}
          description={t("navigation.requestFeatureDescription")}
          onClose={() => setFeatureRequestOpen(false)}
        />
        <ModalBody>
          <Suspense fallback={<p className="text-sm text-slate-500">{t("navigation.loadingFeatureForm")}</p>}>
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
