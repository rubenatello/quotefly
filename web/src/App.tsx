import { useEffect, useState } from "react";
import { Navbar } from "./components/Navbar";
import { CrmShell } from "./components/CrmShell";
import { AuthModal } from "./components/AuthModal";
import { Footer } from "./components/Footer";
import { LandingPage } from "./pages/LandingPage";
import { PricingPage } from "./pages/PricingPage";
import { SolutionsPage } from "./pages/SolutionsPage";
import { AboutPage } from "./pages/AboutPage";
import { BrandingPage } from "./pages/BrandingPage";
import { DashboardPage } from "./pages/DashboardPage";
import { api, ApiError, type AuthPayload } from "./lib/api";

type Session = { email: string; fullName: string; tenantId: string; role: string };

const PROTECTED_PAGES = new Set(["dashboard", "branding"]);

function clearStoredSession() {
  localStorage.removeItem("qf_token");
  localStorage.removeItem("qf_tenant_id");
  localStorage.removeItem("qf_full_name");
}

function App() {
  const [currentPage, setCurrentPage] = useState("landing");
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [isSessionChecking, setIsSessionChecking] = useState(true);

  useEffect(() => {
    let isMounted = true;
    const token = localStorage.getItem("qf_token");

    if (!token) {
      setIsSessionChecking(false);
      return () => {
        isMounted = false;
      };
    }

    async function restoreSession() {
      try {
        const payload = await api.auth.me();
        if (!isMounted) return;

        localStorage.setItem("qf_tenant_id", payload.tenant.id);
        localStorage.setItem("qf_full_name", payload.user.fullName);

        setSession({
          email: payload.user.email,
          fullName: payload.user.fullName,
          tenantId: payload.tenant.id,
          role: payload.role,
        });
        setCurrentPage("dashboard");
      } catch (error) {
        clearStoredSession();
        if (isMounted) {
          setSession(null);
        }

        if (!(error instanceof ApiError && error.status === 401)) {
          console.error("Session restore failed", error);
        }
      } finally {
        if (isMounted) {
          setIsSessionChecking(false);
        }
      }
    }

    void restoreSession();

    return () => {
      isMounted = false;
    };
  }, []);

  const handleAuthSuccess = (payload: AuthPayload) => {
    localStorage.setItem("qf_full_name", payload.user.fullName);
    setSession({
      email: payload.user.email,
      fullName: payload.user.fullName,
      tenantId: payload.tenant.id,
      role: "owner",
    });
    setCurrentPage("dashboard");
  };

  const handleLogout = () => {
    clearStoredSession();
    setSession(null);
    setCurrentPage("landing");
  };

  const handleNavigate = (nextPage: string) => {
    if (PROTECTED_PAGES.has(nextPage) && !session) {
      setCurrentPage("landing");
      setIsAuthModalOpen(true);
      return;
    }

    setCurrentPage(nextPage);
  };

  const isLoggedIn = session !== null;

  const renderPage = () => {
    if (isLoggedIn && !PROTECTED_PAGES.has(currentPage)) {
      return <DashboardPage session={session} onLogout={handleLogout} />;
    }

    switch (currentPage) {
      case "landing":
        return <LandingPage onOpenAuth={() => setIsAuthModalOpen(true)} />;
      case "pricing":
        return <PricingPage onOpenAuth={() => setIsAuthModalOpen(true)} />;
      case "solutions":
        return <SolutionsPage onOpenAuth={() => setIsAuthModalOpen(true)} />;
      case "about":
        return <AboutPage onOpenAuth={() => setIsAuthModalOpen(true)} />;
      case "branding":
        return isLoggedIn
          ? <BrandingPage tenantId={session?.tenantId} />
          : <LandingPage onOpenAuth={() => setIsAuthModalOpen(true)} />;
      case "dashboard":
        return isLoggedIn
          ? <DashboardPage session={session} onLogout={handleLogout} />
          : <LandingPage onOpenAuth={() => setIsAuthModalOpen(true)} />;
      default:
        return <LandingPage onOpenAuth={() => setIsAuthModalOpen(true)} />;
    }
  };

  if (isSessionChecking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50 px-4">
        <p className="text-sm text-slate-600">Restoring your session...</p>
      </div>
    );
  }

  if (isLoggedIn) {
    return (
      <CrmShell
        currentPage={currentPage}
        onNavigate={handleNavigate}
        onLogout={handleLogout}
        fullName={session?.fullName}
      >
        <main className="flex-1">{renderPage()}</main>
      </CrmShell>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-stone-50">
      <Navbar
        currentPage={currentPage}
        onNavigate={handleNavigate}
        isLoggedIn={isLoggedIn}
        onOpenAuth={() => setIsAuthModalOpen(true)}
        onLogout={handleLogout}
      />
      <main className="flex-1">
        {renderPage()}
      </main>
      <Footer />
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
        onSuccess={handleAuthSuccess}
      />
    </div>
  );
}

export default App;
