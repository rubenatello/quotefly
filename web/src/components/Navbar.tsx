import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CloseIcon, MenuIcon } from "./Icons";

interface NavbarProps {
  currentPage: string;
  onNavigate: (page: string) => void;
  isLoggedIn?: boolean;
  onOpenAuth?: () => void;
  onOpenSignIn?: () => void;
  onLogout?: () => void;
}

export function Navbar({ currentPage, isLoggedIn, onOpenAuth, onOpenSignIn, onLogout }: NavbarProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navLinks = [
    { label: "Services", path: "/services" },
    { label: "Solutions", path: "/solutions" },
    { label: "Pricing", path: "/pricing" },
    { label: "About", path: "/about" },
    { label: "Support", path: "/support" },
  ];

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileMenuOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mobileMenuOpen]);

  return (
    <nav aria-label="Primary navigation" className="sticky top-0 z-50 border-b border-slate-200/80 bg-stone-50/95 backdrop-blur">
      <div className="mx-auto flex min-h-16 max-w-7xl items-center justify-between px-4 py-2 sm:px-6 lg:px-8">
        <Link
          to="/"
          className="flex min-h-11 items-center gap-2 transition-opacity hover:opacity-80"
          aria-label="Go to QuoteFly home"
        >
          <img src="/logo.png" alt="QuoteFly" className="h-9 w-auto sm:h-10" />
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          {navLinks.map((link) => (
            <Link
              key={link.path}
              to={link.path}
              aria-current={`/${currentPage}` === link.path ? "page" : undefined}
              className={`text-sm font-medium transition-colors ${
                `/${currentPage}` === link.path
                  ? "text-quotefly-primary"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </div>

        <div className="hidden items-center gap-3 md:flex">
          {isLoggedIn ? (
            <div className="flex items-center gap-3">
              <Link
                to="/app/customers"
                className="inline-flex min-h-11 items-center rounded-lg bg-quotefly-primary px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
              >
                Dashboard
              </Link>
              <button
                type="button"
                onClick={onLogout}
                className="min-h-11 px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:text-slate-900"
              >
                Sign Out
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={onOpenSignIn ?? onOpenAuth}
                className="min-h-11 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:text-quotefly-primary"
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={onOpenAuth}
                className="min-h-11 rounded-lg bg-quotefly-primary px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
              >
                Start Free Trial
              </button>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={() => setMobileMenuOpen((current) => !current)}
          className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 hover:text-slate-900 md:hidden"
          aria-label={mobileMenuOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={mobileMenuOpen}
          aria-controls="mobile-primary-navigation"
        >
          {mobileMenuOpen ? <CloseIcon size={24} /> : <MenuIcon size={24} />}
        </button>
      </div>

      {mobileMenuOpen && (
        <div id="mobile-primary-navigation" className="border-t border-slate-200 bg-white px-4 py-4 md:hidden">
          <div className="flex flex-col gap-4">
            {navLinks.map((link) => (
              <Link
                key={link.path}
                to={link.path}
                aria-current={`/${currentPage}` === link.path ? "page" : undefined}
                onClick={() => setMobileMenuOpen(false)}
                className={`flex min-h-11 items-center rounded-lg px-3 text-left text-sm font-medium transition-colors ${
                  `/${currentPage}` === link.path
                    ? "text-quotefly-primary"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {link.label}
              </Link>
            ))}
            <div className="flex flex-col gap-3 border-t border-slate-200 pt-4">
              {isLoggedIn ? (
                <>
                  <Link
                    to="/app/customers"
                    onClick={() => setMobileMenuOpen(false)}
                    className="flex min-h-11 w-full items-center justify-center rounded-lg bg-quotefly-primary px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
                  >
                    Dashboard
                  </Link>
                  <button
                    type="button"
                    onClick={() => {
                      onLogout?.();
                      setMobileMenuOpen(false);
                    }}
                    className="min-h-11 w-full px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:text-slate-900"
                  >
                    Sign Out
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      (onOpenSignIn ?? onOpenAuth)?.();
                      setMobileMenuOpen(false);
                    }}
                    className="min-h-11 w-full px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:text-quotefly-primary"
                  >
                    Sign In
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onOpenAuth?.();
                      setMobileMenuOpen(false);
                    }}
                    className="min-h-11 w-full rounded-lg bg-quotefly-primary px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
                  >
                    Start Free Trial
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}
