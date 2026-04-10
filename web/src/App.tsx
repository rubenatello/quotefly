import { useEffect, useState } from "react";
import { Navbar } from "./components/Navbar";
import { CrmShell } from "./components/CrmShell";
import { AuthModal } from "./components/AuthModal";
import { Footer } from "./components/Footer";
import { AppLoadingScreen } from "./components/AppLoadingScreen";
import { LandingPage } from "./pages/LandingPage";
import { PricingPage } from "./pages/PricingPage";
import { SolutionsPage } from "./pages/SolutionsPage";
import { AboutPage } from "./pages/AboutPage";
import { BrandingPage } from "./pages/BrandingPage";
import { DashboardPage } from "./pages/DashboardPage";
import { AdminPage } from "./pages/AdminPage";
import {
  api,
  ApiError,
  type AuthPayload,
  type AuthSessionPayload,
  type ServiceType,
  type TenantEntitlements,
} from "./lib/api";

type Session = {
  email: string;
  fullName: string;
  tenantId: string;
  role: string;
  primaryTrade?: ServiceType | null;
  onboardingCompletedAtUtc?: string | null;
  subscriptionStatus?: string;
  subscriptionPlanCode?: string | null;
  effectivePlanCode?: "starter" | "professional" | "enterprise";
  effectivePlanName?: string;
  isTrial?: boolean;
  entitlements?: TenantEntitlements;
};

const PROTECTED_PAGES = new Set(["dashboard", "branding", "admin"]);

function clearStoredSession() {
  localStorage.removeItem("qf_token");
  localStorage.removeItem("qf_tenant_id");
  localStorage.removeItem("qf_full_name");
}

function toSession(payload: AuthSessionPayload): Session {
  return {
    email: payload.user.email,
    fullName: payload.user.fullName,
    tenantId: payload.tenant.id,
    role: payload.role,
    primaryTrade: payload.tenant.primaryTrade ?? null,
    onboardingCompletedAtUtc: payload.tenant.onboardingCompletedAtUtc ?? null,
    subscriptionStatus: payload.tenant.subscriptionStatus,
    subscriptionPlanCode: payload.tenant.subscriptionPlanCode,
    effectivePlanCode: payload.tenant.effectivePlanCode,
    effectivePlanName: payload.tenant.effectivePlanName,
    isTrial: payload.tenant.isTrial,
    entitlements: payload.tenant.entitlements,
  };
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

        setSession(toSession(payload));
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
    setIsSessionChecking(true);

    void api.auth
      .me()
      .then((sessionPayload) => {
        setSession(toSession(sessionPayload));
      })
      .catch((error) => {
        if (!(error instanceof ApiError && error.status === 401)) {
          console.error("Session hydration after auth failed", error);
        }
        setSession({
          email: payload.user.email,
          fullName: payload.user.fullName,
          tenantId: payload.tenant.id,
          role: "owner",
        });
      })
      .finally(() => {
        setCurrentPage("dashboard");
        setIsSessionChecking(false);
      });
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
      case "admin":
        return isLoggedIn
          ? <AdminPage session={session} />
          : <LandingPage onOpenAuth={() => setIsAuthModalOpen(true)} />;
      default:
        return <LandingPage onOpenAuth={() => setIsAuthModalOpen(true)} />;
    }
  };

  if (isSessionChecking) {
    return <AppLoadingScreen message="Restoring your session..." />;
  }

  if (isLoggedIn) {
    return (
      <CrmShell
        currentPage={currentPage}
        onNavigate={handleNavigate}
        onLogout={handleLogout}
        fullName={session?.fullName}
        planName={session?.effectivePlanName}
        planCode={session?.effectivePlanCode}
        isTrial={session?.isTrial}
        entitlements={session?.entitlements}
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
