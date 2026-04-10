import { useState } from "react";
import { CloseIcon, MenuIcon } from "./Icons";

interface NavbarProps {
  currentPage: string;
  onNavigate: (page: string) => void;
  isLoggedIn?: boolean;
  onOpenAuth?: () => void;
  onLogout?: () => void;
}

export function Navbar({ currentPage, onNavigate, isLoggedIn, onOpenAuth, onLogout }: NavbarProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navLinks = [
    { label: "Solutions", path: "solutions" },
    { label: "Pricing", path: "pricing" },
    { label: "About", path: "about" },
    { label: "Support", path: "support" },
  ];

  const handleNavigate = (path: string) => {
    onNavigate(path);
    setMobileMenuOpen(false);
  };

  return (
    <nav className="sticky top-0 z-50 border-b border-slate-200/80 bg-stone-50/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
        <button
          onClick={() => handleNavigate("landing")}
          className="flex items-center gap-2 transition-opacity hover:opacity-80"
          aria-label="Go to QuoteFly home"
        >
          <img src="/logo.png" alt="QuoteFly" className="h-9 w-auto sm:h-10" />
        </button>

        <div className="hidden items-center gap-8 md:flex">
          {navLinks.map((link) => (
            <button
              key={link.path}
              onClick={() => handleNavigate(link.path)}
              className={`text-sm font-medium transition-colors ${
                currentPage === link.path
                  ? "text-quotefly-primary"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {link.label}
            </button>
          ))}
        </div>

        <div className="hidden items-center gap-3 md:flex">
          {isLoggedIn ? (
            <div className="flex items-center gap-3">
              <button
                onClick={() => handleNavigate("dashboard")}
                className="rounded-lg bg-quotefly-primary px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
              >
                Dashboard
              </button>
              <button
                onClick={onLogout}
                className="px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:text-slate-900"
              >
                Sign Out
              </button>
            </div>
          ) : (
            <>
              <button
                onClick={onOpenAuth}
                className="px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:text-quotefly-primary"
              >
                Sign In
              </button>
              <button
                onClick={onOpenAuth}
                className="rounded-lg bg-quotefly-primary px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
              >
                Start Free Trial
              </button>
            </>
          )}
        </div>

        <button
          onClick={() => setMobileMenuOpen((current) => !current)}
          className="text-slate-600 hover:text-slate-900 md:hidden"
          aria-label={mobileMenuOpen ? "Close navigation" : "Open navigation"}
        >
          {mobileMenuOpen ? <CloseIcon size={24} /> : <MenuIcon size={24} />}
        </button>
      </div>

      {mobileMenuOpen && (
        <div className="border-t border-slate-200 bg-white px-4 py-4 md:hidden">
          <div className="flex flex-col gap-4">
            {navLinks.map((link) => (
              <button
                key={link.path}
                onClick={() => handleNavigate(link.path)}
                className={`text-left text-sm font-medium transition-colors ${
                  currentPage === link.path
                    ? "text-quotefly-primary"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {link.label}
              </button>
            ))}
            <div className="flex flex-col gap-3 border-t border-slate-200 pt-4">
              {isLoggedIn ? (
                <>
                  <button
                    onClick={() => handleNavigate("dashboard")}
                    className="w-full rounded-lg bg-quotefly-primary px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
                  >
                    Dashboard
                  </button>
                  <button
                    onClick={() => {
                      onLogout?.();
                      setMobileMenuOpen(false);
                    }}
                    className="w-full px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:text-slate-900"
                  >
                    Sign Out
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={onOpenAuth}
                    className="w-full px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:text-quotefly-primary"
                  >
                    Sign In
                  </button>
                  <button
                    onClick={onOpenAuth}
                    className="w-full rounded-lg bg-quotefly-primary px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
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
