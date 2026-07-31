import { Link } from "react-router-dom";

export function CrmLayoutFooter() {
  return (
    <footer className="border-t border-slate-200/80 bg-white/80 px-6 py-4 text-xs text-slate-500 backdrop-blur-sm">
      <div className="mx-auto flex w-full max-w-[1840px] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span>QuoteFly workspace</span>
        <nav aria-label="Workspace legal links" className="flex flex-wrap gap-x-4 gap-y-2">
          <Link className="inline-flex min-h-11 items-center py-3 hover:text-slate-900" to="/privacy">Privacy</Link>
          <Link className="inline-flex min-h-11 items-center py-3 hover:text-slate-900" to="/terms">Terms</Link>
          <Link className="inline-flex min-h-11 items-center py-3 hover:text-slate-900" to="/cookies">Cookie settings</Link>
          <Link className="inline-flex min-h-11 items-center py-3 hover:text-slate-900" to="/support">Support</Link>
        </nav>
      </div>
    </footer>
  );
}
