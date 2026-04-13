import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { FilePlus2, MoreHorizontal, Plus, Search, UserPlus2 } from "lucide-react";
import type { PlanCode, TenantEntitlements, TenantUsageSnapshot } from "../lib/api";
import { cn } from "../lib/utils";
import {
  ClockIcon,
  CustomerIcon,
  InvoiceIcon,
  QuoteIcon,
  SettingsIcon,
} from "./Icons";
import { CrmMobileHeader } from "./crm/CrmMobileHeader";
import { CrmCommandPalette } from "./crm/CrmCommandPalette";
import { CrmSidebar, type CrmNavLink } from "./crm/CrmSidebar";
import { CrmLayoutFooter } from "./crm/CrmLayoutFooter";

interface CrmShellProps {
  currentPage: string;
  onNavigate: (page: string) => void;
  onQuickAction: (action: "new-customer" | "new-quote") => void;
  onLogout: () => void;
  children: ReactNode;
  fullName?: string;
  planName?: string;
  planCode?: PlanCode;
  isTrial?: boolean;
  entitlements?: TenantEntitlements;
  usage?: TenantUsageSnapshot;
}

const OPERATIONS_LINKS: readonly CrmNavLink[] = [
  { label: "Customers", path: "customers", icon: <CustomerIcon size={15} /> },
  { label: "Quotes", path: "quotes", icon: <QuoteIcon size={15} /> },
  { label: "Analytics", path: "analytics", icon: <ClockIcon size={15} /> },
  { label: "Branding", path: "branding", icon: <InvoiceIcon size={14} /> },
] as const;

const SETTINGS_LINKS: readonly CrmNavLink[] = [
  { label: "Org", path: "settings", icon: <SettingsIcon size={14} /> },
  { label: "Users", path: "settings-users", icon: <CustomerIcon size={14} /> },
];

const PAGE_META: Record<string, { label: string; hint: string }> = {
  customers: {
    label: "Customers",
    hint: "Track customer progress from new to sold in one board.",
  },
  analytics: {
    label: "Analytics",
    hint: "See quote and pipeline performance at a glance.",
  },
  quotes: {
    label: "Quotes",
    hint: "Watch quote volume, status, value, and open the desk when needed.",
  },
  setup: {
    label: "Setup",
    hint: "Configure trades, starter jobs, and onboarding defaults.",
  },
  branding: {
    label: "Branding",
    hint: "Control templates, sender details, and PDF styling.",
  },
  settings: {
    label: "Settings",
    hint: "Handle organization billing, launch-plan access, and workspace controls.",
  },
  "settings-users": {
    label: "Users",
    hint: "Manage roles, seats, and member access.",
  },
};

export function CrmShell({
  currentPage,
  onNavigate,
  onQuickAction,
  onLogout,
  children,
  fullName,
  planName,
  planCode: _planCode,
  isTrial,
  entitlements,
  usage,
}: CrmShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);

  useEffect(() => {
    const savedValue = localStorage.getItem("qf_sidebar_collapsed");
    if (savedValue === null) {
      setSidebarCollapsed(true);
    } else if (savedValue === "true") {
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

  const pageMeta = PAGE_META[currentPage] ?? PAGE_META.customers;
  return (
    <div className="min-h-screen bg-slate-50">
      <CrmMobileHeader
        mobileOpen={mobileOpen}
        onToggleMobile={() => setMobileOpen((open) => !open)}
        onOpenCommand={() => setCommandOpen(true)}
        onNavigate={handleNavigate}
        onQuickAction={onQuickAction}
        onLogout={onLogout}
        currentLabel={pageMeta.label}
      />
      <CrmCommandPalette
        open={commandOpen}
        onOpenChange={setCommandOpen}
        onNavigate={(page) => handleNavigate(page)}
        onQuickAction={onQuickAction}
      />

      <div
        className={`mx-auto w-full max-w-[1480px] lg:grid ${
          sidebarCollapsed ? "lg:grid-cols-[76px_1fr]" : "lg:grid-cols-[224px_1fr]"
        }`}
      >
        <CrmSidebar
          currentPage={currentPage}
          mobileOpen={mobileOpen}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((current) => !current)}
          onNavigate={handleNavigate}
          onQuickAction={onQuickAction}
          operationsLinks={OPERATIONS_LINKS}
          settingsLinks={SETTINGS_LINKS}
          onLogout={onLogout}
          planName={planName}
          isTrial={isTrial}
          entitlements={entitlements}
          usage={usage}
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
          <div className="sticky top-0 z-30 hidden border-b border-slate-200/80 bg-white/96 lg:block">
            <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                  <span>QuoteFly workspace</span>
                  <span className="h-1 w-1 rounded-full bg-slate-300" />
                  <span>{pageMeta.label}</span>
                </div>
                <p className="mt-1 truncate text-sm text-slate-600">{pageMeta.hint}</p>
              </div>

              <div className="flex items-center gap-2">
                <DropdownMenuPrimitive.Root>
                  <DropdownMenuPrimitive.Trigger asChild>
                    <button
                      type="button"
                      className="inline-flex items-center gap-2 rounded-xl border border-quotefly-blue bg-quotefly-blue px-3.5 py-2 text-sm font-medium text-white transition hover:bg-[#256fbf]"
                    >
                      <Plus size={15} />
                      New
                    </button>
                  </DropdownMenuPrimitive.Trigger>
                  <DropdownMenuPrimitive.Portal>
                    <DropdownMenuPrimitive.Content
                      align="end"
                      sideOffset={12}
                      className="z-[130] min-w-[220px] rounded-[24px] border border-slate-200 bg-white p-2 shadow-[0_20px_44px_rgba(15,23,42,0.18)]"
                    >
                      <DropdownMenuPrimitive.Item
                        onSelect={() => onQuickAction("new-customer")}
                        className={cn("flex cursor-pointer items-center gap-2 rounded-2xl px-3 py-2.5 text-sm text-slate-700 outline-none transition hover:bg-slate-50")}
                      >
                        <UserPlus2 size={15} className="text-quotefly-blue" />
                        New customer
                      </DropdownMenuPrimitive.Item>
                      <DropdownMenuPrimitive.Item
                        onSelect={() => onQuickAction("new-quote")}
                        className={cn("flex cursor-pointer items-center gap-2 rounded-2xl px-3 py-2.5 text-sm text-slate-700 outline-none transition hover:bg-slate-50")}
                      >
                        <FilePlus2 size={15} className="text-quotefly-blue" />
                        New quote
                      </DropdownMenuPrimitive.Item>
                    </DropdownMenuPrimitive.Content>
                  </DropdownMenuPrimitive.Portal>
                </DropdownMenuPrimitive.Root>

                <button
                  type="button"
                  onClick={() => setCommandOpen(true)}
                  className="inline-flex min-w-[216px] items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:bg-white hover:text-slate-900"
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
                      className="inline-flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 transition hover:border-slate-300"
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
                        <span className="block max-w-[160px] truncate text-sm font-semibold text-slate-900">{fullName ?? "QuoteFly User"}</span>
                      </span>
                      <MoreHorizontal size={16} className="text-slate-400" />
                    </button>
                  </DropdownMenuPrimitive.Trigger>
                  <DropdownMenuPrimitive.Portal>
                    <DropdownMenuPrimitive.Content
                      align="end"
                      sideOffset={12}
                      className="z-[130] min-w-[240px] rounded-[24px] border border-slate-200 bg-white p-2 shadow-[0_20px_44px_rgba(15,23,42,0.18)]"
                    >
                      <div className="rounded-[18px] bg-slate-50 px-3 py-3">
                        <p className="text-sm font-semibold text-slate-900">{fullName ?? "QuoteFly User"}</p>
                      </div>
                      <div className="mt-2 space-y-1">
                        {[
                          { label: "Open customers", page: "customers" },
                          { label: "Open settings", page: "settings" },
                          { label: "Open branding", page: "branding" },
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
          <div className="pb-24 lg:pb-0" />
          <CrmLayoutFooter />
        </div>
      </div>
    </div>
  );
}
