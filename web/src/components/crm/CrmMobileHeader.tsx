import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Command, MoreHorizontal, Search } from "lucide-react";
import { CloseIcon, MenuIcon } from "../Icons";
import { cn } from "../../lib/utils";

interface CrmMobileHeaderProps {
  mobileOpen: boolean;
  onToggleMobile: () => void;
  onOpenCommand: () => void;
  onNavigate: (page: string) => void;
  onLogout: () => void;
  currentLabel: string;
  planName?: string;
}

export function CrmMobileHeader({
  mobileOpen,
  onToggleMobile,
  onOpenCommand,
  onNavigate,
  onLogout,
  currentLabel,
  planName,
}: CrmMobileHeaderProps) {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/92 px-[max(1rem,env(safe-area-inset-left))] py-3 pr-[max(1rem,env(safe-area-inset-right))] shadow-[0_4px_24px_rgba(15,23,42,0.06)] backdrop-blur-xl lg:hidden">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={onToggleMobile}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 shadow-sm"
          >
            {mobileOpen ? <CloseIcon size={18} /> : <MenuIcon size={18} />}
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <img src="/favicon.png" alt="QuoteFly" className="h-7 w-7 shrink-0 rounded-lg" />
              <p className="truncate text-sm font-semibold text-slate-900">{currentLabel}</p>
            </div>
            <p className="truncate text-xs text-slate-500">{planName ?? "QuoteFly workspace"}</p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onOpenCommand}
            className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm"
            aria-label="Open workspace search"
          >
            <Search size={17} />
          </button>

          <DropdownMenuPrimitive.Root>
            <DropdownMenuPrimitive.Trigger asChild>
              <button
                type="button"
                className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-600 shadow-sm"
                aria-label="Open workspace menu"
              >
                <MoreHorizontal size={18} />
              </button>
            </DropdownMenuPrimitive.Trigger>
            <DropdownMenuPrimitive.Portal>
              <DropdownMenuPrimitive.Content
                align="end"
                sideOffset={10}
                className="z-[130] min-w-[220px] rounded-3xl border border-slate-200 bg-white p-2 shadow-[0_20px_44px_rgba(15,23,42,0.18)]"
              >
                <DropdownMenuPrimitive.Item
                  onSelect={() => onOpenCommand()}
                  className={cn("flex cursor-pointer items-center gap-2 rounded-2xl px-3 py-2.5 text-sm text-slate-700 outline-none transition hover:bg-slate-50")}
                >
                  <Command size={15} />
                  Search workspace
                </DropdownMenuPrimitive.Item>
                <DropdownMenuPrimitive.Item
                  onSelect={() => onNavigate("admin")}
                  className={cn("flex cursor-pointer items-center gap-2 rounded-2xl px-3 py-2.5 text-sm text-slate-700 outline-none transition hover:bg-slate-50")}
                >
                  Open admin
                </DropdownMenuPrimitive.Item>
                <DropdownMenuPrimitive.Item
                  onSelect={() => onNavigate("branding")}
                  className={cn("flex cursor-pointer items-center gap-2 rounded-2xl px-3 py-2.5 text-sm text-slate-700 outline-none transition hover:bg-slate-50")}
                >
                  Open branding
                </DropdownMenuPrimitive.Item>
                <DropdownMenuPrimitive.Separator className="my-2 h-px bg-slate-200" />
                <DropdownMenuPrimitive.Item
                  onSelect={() => onLogout()}
                  className={cn("flex cursor-pointer items-center gap-2 rounded-2xl px-3 py-2.5 text-sm text-red-600 outline-none transition hover:bg-red-50")}
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
