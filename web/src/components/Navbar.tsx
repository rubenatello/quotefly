import { MenuIcon, CloseIcon } from "./Icons";
import { useState } from "react";

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
    { label: "Branding", path: "branding" },
  ];

  const handleNavigate = (path: string) => {
    onNavigate(path);
    setMobileMenuOpen(false);
  };

  return (
    <nav className="sticky top-0 z-50 border-b border-slate-200/80 bg-stone-50/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
        {/* Logo/Brand */}
        <button
          onClick={() => handleNavigate("landing")}
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
        >
          <img src="/logo.png" alt="QuoteFly" className="h-9 w-auto sm:h-10" />
        </button>

        {/* Desktop Navigation */}
        <div className="hidden md:flex items-center gap-8">
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

        {/* Auth Buttons */}
        <div className="hidden md:flex items-center gap-3">
          {isLoggedIn ? (
            <div className="flex items-center gap-3">
              <button
                onClick={() => handleNavigate("dashboard")}
                className="px-4 py-2 bg-quotefly-primary text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity"
              >
                Dashboard
              </button>
              <button
                onClick={onLogout}
                className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors"
              >
                Sign Out
              </button>
            </div>
          ) : (
            <>
              <button
                onClick={onOpenAuth}
                className="px-4 py-2 text-sm font-medium text-slate-700 hover:text-quotefly-primary transition-colors"
              >
                Sign In
              </button>
              <button
                onClick={onOpenAuth}
                className="px-4 py-2 bg-quotefly-primary text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity"
              >
                Start Free Trial
              </button>
            </>
          )}
        </div>

        {/* Mobile Menu Button */}
        <button
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="md:hidden text-slate-600 hover:text-slate-900"
        >
          {mobileMenuOpen ? (
            <CloseIcon size={24} />
          ) : (
            <MenuIcon size={24} />
          )}
        </button>
      </div>

      {/* Mobile Menu */}
      {mobileMenuOpen && (
        <div className="md:hidden border-t border-slate-200 bg-white px-4 py-4">
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
            <div className="border-t border-slate-200 pt-4 flex flex-col gap-3">
              {isLoggedIn ? (
                <>
                  <button
                    onClick={() => handleNavigate("dashboard")}
                    className="w-full px-4 py-2 bg-quotefly-primary text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity"
                  >
                    Dashboard
                  </button>
                  <button
                    onClick={() => {
                      onLogout?.();
                      setMobileMenuOpen(false);
                    }}
                    className="w-full px-4 py-2 text-sm font-medium text-slate-700 hover:text-slate-900 transition-colors"
                  >
                    Sign Out
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={onOpenAuth}
                    className="w-full px-4 py-2 text-sm font-medium text-slate-700 hover:text-quotefly-primary transition-colors"
                  >
                    Sign In
                  </button>
                  <button
                    onClick={onOpenAuth}
                    className="w-full px-4 py-2 bg-quotefly-primary text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity"
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
