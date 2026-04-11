import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Command, MoreHorizontal, Search, Sparkles } from "lucide-react";
import type { PlanCode, TenantEntitlements } from "../lib/api";
import { cn } from "../lib/utils";
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
import { CrmCommandPalette } from "./crm/CrmCommandPalette";
import { CrmSidebar, type CrmModuleLink, type CrmNavLink } from "./crm/CrmSidebar";
import { CrmLayoutFooter } from "./crm/CrmLayoutFooter";
import { Badge } from "./ui";

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
  { label: "Pipeline", path: "pipeline", icon: <CustomerIcon size={15} /> },
  { label: "Build Quote", path: "build", icon: <EditIcon size={15} /> },
  { label: "Quote Desk", path: "quotes", icon: <QuoteIcon size={15} /> },
  { label: "Setup", path: "setup", icon: <EditIcon size={14} /> },
  { label: "Branding", path: "branding", icon: <InvoiceIcon size={14} /> },
  { label: "Admin", path: "admin", icon: <SettingsIcon size={14} /> },
] as const;

const MODULE_LINKS: readonly CrmModuleLink[] = [
  {
    label: "Quote History",
    path: "history",
    feature: "quoteVersionHistory",
    requiredPlanLabel: "Professional+",
    icon: <ClockIcon size={14} />,
  },
  {
    label: "Comms Log",
    path: "quotes",
    feature: "communicationLog",
    requiredPlanLabel: "Professional+",
    icon: <MessageIcon size={14} />,
  },
  {
    label: "Advanced Analytics",
    path: "pipeline",
    feature: "advancedAnalytics",
    requiredPlanLabel: "Professional+",
    icon: <CustomerIcon size={14} />,
  },
  {
    label: "API & Integrations",
    path: "admin",
    feature: "apiAccess",
    requiredPlanLabel: "Enterprise",
    icon: <SettingsIcon size={14} />,
  },
];

const PAGE_META: Record<string, { label: string; hint: string }> = {
  pipeline: {
    label: "Pipeline",
    hint: "Prioritize leads, follow-ups, and closed work.",
  },
  build: {
    label: "Build Quote",
    hint: "Create customers, draft quotes, and prep exports quickly.",
  },
  quotes: {
    label: "Quote Desk",
    hint: "Edit, send, sync, and close active quotes.",
  },
  history: {
    label: "Quote History",
    hint: "Track revisions, outbound actions, and final outcomes.",
  },
  setup: {
    label: "Setup",
    hint: "Configure trades, starter jobs, and onboarding defaults.",
  },
  branding: {
    label: "Branding",
    hint: "Control templates, sender details, and PDF styling.",
  },
  admin: {
    label: "Admin",
    hint: "Handle billing, QuickBooks, users, and workspace control.",
  },
};

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
  const [commandOpen, setCommandOpen] = useState(false);

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
    setCommandOpen(false);
  };

  const pageMeta = PAGE_META[currentPage] ?? PAGE_META.pipeline;
  const displayPlanName = planName ?? "Starter";

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(42,127,216,0.08),_transparent_26%),radial-gradient(circle_at_top_right,_rgba(244,96,54,0.10),_transparent_24%),linear-gradient(180deg,#f8fafc_0%,#eef4fb_100%)]">
      <CrmMobileHeader
        mobileOpen={mobileOpen}
        onToggleMobile={() => setMobileOpen((open) => !open)}
        onOpenCommand={() => setCommandOpen(true)}
        onNavigate={handleNavigate}
        onLogout={onLogout}
        currentLabel={pageMeta.label}
        planName={displayPlanName}
      />
      <CrmCommandPalette
        open={commandOpen}
        onOpenChange={setCommandOpen}
        onNavigate={(page) => handleNavigate(page)}
      />

      <div
        className={`mx-auto w-full max-w-[1600px] lg:grid ${
          sidebarCollapsed ? "lg:grid-cols-[92px_1fr]" : "lg:grid-cols-[284px_1fr]"
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
          <div className="sticky top-0 z-30 hidden border-b border-white/70 bg-white/75 backdrop-blur-xl lg:block">
            <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-8 py-4">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                  QuoteFly Workspace
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span className="text-base font-semibold text-slate-900">{pageMeta.label}</span>
                  <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
                  <span className="text-sm text-slate-600">{pageMeta.hint}</span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setCommandOpen(true)}
                  className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-300 hover:text-slate-900"
                >
                  <Search size={15} />
                  Search or jump
                  <span className="hidden rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-500 xl:inline-flex">
                    <Command size={12} className="mr-1" />
                    K
                  </span>
                </button>

                <Badge tone={isTrial ? "orange" : planCode === "enterprise" ? "purple" : "blue"} icon={<Sparkles size={12} />}>
                  {isTrial ? `Trial: ${displayPlanName}` : displayPlanName}
                </Badge>

                <DropdownMenuPrimitive.Root>
                  <DropdownMenuPrimitive.Trigger asChild>
                    <button
                      type="button"
                      className="inline-flex items-center gap-3 rounded-full border border-slate-200 bg-white px-2 py-1.5 shadow-sm transition hover:border-slate-300"
                    >
                      <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-[linear-gradient(135deg,#2a7fd8,#f46036)] text-sm font-semibold text-white">
                        {(fullName ?? "Q")
                          .split(" ")
                          .map((part) => part[0])
                          .join("")
                          .slice(0, 2)
                          .toUpperCase()}
                      </span>
                      <span className="hidden text-left xl:block">
                        <span className="block max-w-[160px] truncate text-sm font-semibold text-slate-900">{fullName ?? "QuoteFly User"}</span>
                        <span className="block text-xs text-slate-500">{displayPlanName}</span>
                      </span>
                      <MoreHorizontal size={16} className="text-slate-400" />
                    </button>
                  </DropdownMenuPrimitive.Trigger>
                  <DropdownMenuPrimitive.Portal>
                    <DropdownMenuPrimitive.Content
                      align="end"
                      sideOffset={12}
                      className="z-[130] min-w-[240px] rounded-[28px] border border-slate-200 bg-white p-2 shadow-[0_20px_44px_rgba(15,23,42,0.18)]"
                    >
                      <div className="rounded-[22px] bg-slate-50 px-3 py-3">
                        <p className="text-sm font-semibold text-slate-900">{fullName ?? "QuoteFly User"}</p>
                        <p className="text-xs text-slate-500">{displayPlanName}</p>
                      </div>
                      <div className="mt-2 space-y-1">
                        {[
                          { label: "Open admin", page: "admin" },
                          { label: "Open branding", page: "branding" },
                          { label: "Open setup", page: "setup" },
                        ].map((item) => (
                          <DropdownMenuPrimitive.Item
                            key={item.page}
                            onSelect={() => handleNavigate(item.page)}
                            className={cn("cursor-pointer rounded-2xl px-3 py-2.5 text-sm text-slate-700 outline-none transition hover:bg-slate-50")}
                          >
                            {item.label}
                          </DropdownMenuPrimitive.Item>
                        ))}
                      </div>
                      <DropdownMenuPrimitive.Separator className="my-2 h-px bg-slate-200" />
                      <DropdownMenuPrimitive.Item
                        onSelect={() => onLogout()}
                        className={cn("cursor-pointer rounded-2xl px-3 py-2.5 text-sm text-red-600 outline-none transition hover:bg-red-50")}
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
          <CrmLayoutFooter />
        </div>
      </div>
    </div>
  );
}
