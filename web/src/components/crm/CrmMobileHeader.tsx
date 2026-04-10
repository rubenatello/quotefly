import { CloseIcon, MenuIcon } from "../Icons";

interface CrmMobileHeaderProps {
  mobileOpen: boolean;
  onToggleMobile: () => void;
  onLogout: () => void;
}

export function CrmMobileHeader({ mobileOpen, onToggleMobile, onLogout }: CrmMobileHeaderProps) {
  return (
    <header className="sticky top-0 z-40 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
      <button
        type="button"
        onClick={onToggleMobile}
        className="inline-flex items-center justify-center rounded-md border border-slate-300 p-2 text-slate-700"
      >
        {mobileOpen ? <CloseIcon size={18} /> : <MenuIcon size={18} />}
      </button>
      <img src="/logo.png" alt="QuoteFly" className="h-8 w-auto" />
      <button
        type="button"
        onClick={onLogout}
        className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
      >
        Sign Out
      </button>
    </header>
  );
}
