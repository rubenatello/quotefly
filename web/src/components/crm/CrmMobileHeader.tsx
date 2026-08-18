import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { BadgeInfo, Command, FilePlus2, LifeBuoy, MoreHorizontal, Palette, Search, Settings2, UserPlus2 } from "lucide-react";
import type { Ref } from "react";
import { CloseIcon, MenuIcon } from "../Icons";
import { cn } from "../../lib/utils";
import { SUPPORT_MAILTO } from "../../lib/contact";
import type { WorkspaceNavigationId } from "./workspace-navigation";

interface CrmMobileHeaderProps {
  mobileOpen: boolean;
  backgroundInert: boolean;
  menuButtonRef: Ref<HTMLButtonElement>;
  onToggleMobile: () => void;
  onOpenCommand: () => void;
  onNavigate: (page: WorkspaceNavigationId) => void;
  onQuickAction: (action: "new-customer" | "new-quote") => void;
  onLogout: () => void;
  currentLabel: string;
  canManageWorkspace: boolean;
}

export function CrmMobileHeader({
  mobileOpen,
  backgroundInert,
  menuButtonRef,
  onToggleMobile,
  onOpenCommand,
  onNavigate,
  onQuickAction,
  onLogout,
  currentLabel,
  canManageWorkspace,
}: CrmMobileHeaderProps) {
  return (
    <header
      aria-hidden={backgroundInert || undefined}
      inert={backgroundInert || undefined}
      className="qf-mobile-header sticky top-0 z-40 border-b border-qf-border/80 bg-qf-surface/95 px-[max(1rem,env(safe-area-inset-left))] py-2.5 pr-[max(1rem,env(safe-area-inset-right))] backdrop-blur-xl lg:hidden"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <button
            ref={menuButtonRef}
            type="button"
            onClick={onToggleMobile}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] text-[var(--qf-text-soft)] transition hover:border-[var(--qf-border-strong)] hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]"
            aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
            aria-controls="quotefly-workspace-navigation"
            aria-expanded={mobileOpen}
          >
            {mobileOpen ? <CloseIcon size={18} /> : <MenuIcon size={18} />}
          </button>
          <button
            type="button"
            onClick={() => onNavigate("home")}
            className="min-w-0 rounded-xl text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]"
            aria-label="Go to workspace home"
          >
            <div className="flex items-center gap-2">
              <img src="/favicon.png" alt="QuoteFly" className="h-7 w-7 shrink-0 rounded-lg" />
              <p className="truncate text-sm font-semibold text-[var(--qf-text)]">{currentLabel}</p>
            </div>
            <div className="mt-0.5 flex items-center gap-2">
              <p className="truncate text-xs text-[var(--qf-text-muted)]">QuoteFly workspace</p>
            </div>
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onOpenCommand}
            className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] text-[var(--qf-text-soft)] transition hover:border-[var(--qf-border-strong)] hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]"
            aria-label="Open workspace search"
          >
            <Search size={17} />
          </button>

          <DropdownMenuPrimitive.Root>
            <DropdownMenuPrimitive.Trigger asChild>
              <button
                type="button"
                className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] text-[var(--qf-text-soft)] transition hover:border-[var(--qf-border-strong)] hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]"
                aria-label="Open workspace menu"
              >
                <MoreHorizontal size={18} />
              </button>
            </DropdownMenuPrimitive.Trigger>
            <DropdownMenuPrimitive.Portal>
              <DropdownMenuPrimitive.Content
                align="end"
                sideOffset={10}
                className="qf-theme-scope z-[130] min-w-[220px] rounded-3xl border border-qf-border bg-qf-surface p-2 text-qf-text shadow-[var(--qf-shadow-md)]"
              >
                <DropdownMenuPrimitive.Item
                  onSelect={() => onOpenCommand()}
                  className={cn("flex cursor-pointer items-center gap-2 rounded-2xl px-3 py-2.5 text-sm text-[var(--qf-text-soft)] outline-none transition hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)] focus:bg-[var(--qf-interactive-hover)] data-[highlighted]:bg-[var(--qf-interactive-hover)] data-[highlighted]:text-[var(--qf-text)]")}
                >
                  <Command size={15} />
                  Search workspace
                </DropdownMenuPrimitive.Item>
                <DropdownMenuPrimitive.Item
                  onSelect={() => onQuickAction("new-customer")}
                  className={cn("flex cursor-pointer items-center gap-2 rounded-2xl px-3 py-2.5 text-sm text-[var(--qf-text-soft)] outline-none transition hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)] focus:bg-[var(--qf-interactive-hover)] data-[highlighted]:bg-[var(--qf-interactive-hover)] data-[highlighted]:text-[var(--qf-text)]")}
                >
                  <UserPlus2 size={15} className="text-quotefly-blue" />
                  New customer
                </DropdownMenuPrimitive.Item>
                <DropdownMenuPrimitive.Item
                  onSelect={() => onQuickAction("new-quote")}
                  className={cn("flex cursor-pointer items-center gap-2 rounded-2xl px-3 py-2.5 text-sm text-[var(--qf-text-soft)] outline-none transition hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)] focus:bg-[var(--qf-interactive-hover)] data-[highlighted]:bg-[var(--qf-interactive-hover)] data-[highlighted]:text-[var(--qf-text)]")}
                >
                  <FilePlus2 size={15} className="text-quotefly-blue" />
                  New quote
                </DropdownMenuPrimitive.Item>
                <DropdownMenuPrimitive.Separator className="my-2 h-px bg-[var(--qf-border)]" />
                <DropdownMenuPrimitive.Item
                  onSelect={() => onNavigate("settings")}
                  className={cn("flex cursor-pointer items-center gap-2 rounded-2xl px-3 py-2.5 text-sm text-[var(--qf-text-soft)] outline-none transition hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)] focus:bg-[var(--qf-interactive-hover)] data-[highlighted]:bg-[var(--qf-interactive-hover)] data-[highlighted]:text-[var(--qf-text)]")}
                >
                  <Settings2 size={15} aria-hidden="true" />
                  Open settings
                </DropdownMenuPrimitive.Item>
                {canManageWorkspace ? (
                  <DropdownMenuPrimitive.Item
                    onSelect={() => onNavigate("branding")}
                    className={cn("flex cursor-pointer items-center gap-2 rounded-2xl px-3 py-2.5 text-sm text-[var(--qf-text-soft)] outline-none transition hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)] focus:bg-[var(--qf-interactive-hover)] data-[highlighted]:bg-[var(--qf-interactive-hover)] data-[highlighted]:text-[var(--qf-text)]")}
                  >
                    <Palette size={15} aria-hidden="true" />
                    Open branding
                  </DropdownMenuPrimitive.Item>
                ) : null}
                <DropdownMenuPrimitive.Item
                  onSelect={() => onNavigate("about")}
                  className={cn("flex cursor-pointer items-center gap-2 rounded-2xl px-3 py-2.5 text-sm text-[var(--qf-text-soft)] outline-none transition hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)] focus:bg-[var(--qf-interactive-hover)] data-[highlighted]:bg-[var(--qf-interactive-hover)] data-[highlighted]:text-[var(--qf-text)]")}
                >
                  <BadgeInfo size={15} aria-hidden="true" />
                  My info
                </DropdownMenuPrimitive.Item>
                <DropdownMenuPrimitive.Item asChild>
                  <a
                    href={SUPPORT_MAILTO}
                    className={cn("flex cursor-pointer items-center gap-2 rounded-2xl px-3 py-2.5 text-sm text-[var(--qf-text-soft)] outline-none transition hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)] focus:bg-[var(--qf-interactive-hover)] data-[highlighted]:bg-[var(--qf-interactive-hover)] data-[highlighted]:text-[var(--qf-text)]")}
                  >
                    <LifeBuoy size={15} className="text-quotefly-blue" aria-hidden="true" />
                    Contact support
                  </a>
                </DropdownMenuPrimitive.Item>
                <DropdownMenuPrimitive.Separator className="my-2 h-px bg-[var(--qf-border)]" />
                <DropdownMenuPrimitive.Item
                  onSelect={() => onLogout()}
                  className={cn("flex cursor-pointer items-center gap-2 rounded-2xl px-3 py-2.5 text-sm text-[var(--qf-danger-text)] outline-none transition hover:bg-[var(--qf-danger-surface)] focus:bg-[var(--qf-danger-surface)] data-[highlighted]:bg-[var(--qf-danger-surface)]")}
                >
                  Sign out
                </DropdownMenuPrimitive.Item>
              </DropdownMenuPrimitive.Content>
            </DropdownMenuPrimitive.Portal>
          </DropdownMenuPrimitive.Root>
        </div>
      </div>
    </header>
  );
}
