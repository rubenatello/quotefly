import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { PlanCode, TenantEntitlements } from "../lib/api";
import {
  ClockIcon,
  CustomerIcon,
  EditIcon,
  InvoiceIcon,
  MessageIcon,
  QuoteIcon,
  SettingsIcon,
} from "./Icons";
import { CrmMobileHeader } from "./crm/CrmMobileHeader";
import { CrmSidebar, type CrmModuleLink, type CrmNavLink } from "./crm/CrmSidebar";
import { CrmLayoutFooter } from "./crm/CrmLayoutFooter";

interface CrmShellProps {
  currentPage: string;
  onNavigate: (page: string) => void;
  onLogout: () => void;
  children: ReactNode;
  fullName?: string;
  planName?: string;
  planCode?: PlanCode;
  isTrial?: boolean;
  entitlements?: TenantEntitlements;
}

const OPERATIONS_LINKS: readonly CrmNavLink[] = [
  { label: "Dashboard", path: "dashboard", icon: <QuoteIcon size={14} /> },
  { label: "Setup", path: "setup", icon: <EditIcon size={14} /> },
  { label: "Admin", path: "admin", icon: <SettingsIcon size={14} /> },
  { label: "Branding", path: "branding", icon: <InvoiceIcon size={14} /> },
] as const;

const MODULE_LINKS: readonly CrmModuleLink[] = [
  {
    label: "Quote History",
    feature: "quoteVersionHistory",
    requiredPlanLabel: "Professional+",
    icon: <ClockIcon size={14} />,
  },
  {
    label: "Comms Log",
    feature: "communicationLog",
    requiredPlanLabel: "Professional+",
    icon: <MessageIcon size={14} />,
  },
  {
    label: "Advanced Analytics",
    feature: "advancedAnalytics",
    requiredPlanLabel: "Professional+",
    icon: <CustomerIcon size={14} />,
  },
  {
    label: "API & Integrations",
    feature: "apiAccess",
    requiredPlanLabel: "Enterprise",
    icon: <SettingsIcon size={14} />,
  },
];

export function CrmShell({
  currentPage,
  onNavigate,
  onLogout,
  children,
  fullName,
  planName,
  planCode,
  isTrial,
  entitlements,
}: CrmShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    const savedValue = localStorage.getItem("qf_sidebar_collapsed");
    if (savedValue === "true") {
      setSidebarCollapsed(true);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("qf_sidebar_collapsed", sidebarCollapsed ? "true" : "false");
  }, [sidebarCollapsed]);

  const handleNavigate = (page: string) => {
    onNavigate(page);
    setMobileOpen(false);
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(91,133,170,0.12),transparent_22%),radial-gradient(circle_at_top_right,rgba(244,96,54,0.08),transparent_18%),linear-gradient(180deg,#f8fafc_0%,#eef4fb_100%)]">
      <CrmMobileHeader
        mobileOpen={mobileOpen}
        onToggleMobile={() => setMobileOpen((open) => !open)}
        onLogout={onLogout}
      />

      <div
        className={`mx-auto w-full max-w-[1600px] lg:grid ${
          sidebarCollapsed ? "lg:grid-cols-[96px_1fr]" : "lg:grid-cols-[280px_1fr]"
        }`}
      >
        <CrmSidebar
          currentPage={currentPage}
          mobileOpen={mobileOpen}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((current) => !current)}
          onNavigate={handleNavigate}
          operationsLinks={OPERATIONS_LINKS}
          moduleLinks={MODULE_LINKS}
          onLogout={onLogout}
          fullName={fullName}
          planName={planName}
          planCode={planCode}
          isTrial={isTrial}
          entitlements={entitlements}
        />

        {mobileOpen && (
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
            className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          />
        )}

        <div className="min-w-0">
          {children}
          <CrmLayoutFooter />
        </div>
      </div>
    </div>
  );
}
