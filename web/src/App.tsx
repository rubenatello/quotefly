import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import { Navbar } from "./components/Navbar";
import { CrmShell } from "./components/CrmShell";
import { AuthModal } from "./components/AuthModal";
import { Footer } from "./components/Footer";
import { AppLoadingScreen } from "./components/AppLoadingScreen";
import { BottomTabBar } from "./components/crm/BottomTabBar";
import { LandingPage } from "./pages/LandingPage";
import { PricingPage } from "./pages/PricingPage";
import { SolutionsPage } from "./pages/SolutionsPage";
import { AboutPage } from "./pages/AboutPage";
import { BrandingPage } from "./pages/BrandingPage";
import { AdminPage } from "./pages/AdminPage";
import { DashboardProvider, type DashboardSession } from "./components/dashboard/DashboardContext";
import { PipelineView } from "./views/PipelineView";
import { QuoteBuilderView } from "./views/QuoteBuilderView";
import { QuoteDeskView } from "./views/QuoteDeskView";
import { QuoteHistoryView } from "./views/QuoteHistoryView";
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

function toDashboardSession(s: Session): DashboardSession {
  return {
    email: s.email,
    fullName: s.fullName,
    tenantId: s.tenantId,
    primaryTrade: s.primaryTrade,
    onboardingCompletedAtUtc: s.onboardingCompletedAtUtc,
    effectivePlanName: s.effectivePlanName,
    effectivePlanCode: s.effectivePlanCode,
    isTrial: s.isTrial,
    entitlements: s.entitlements,
  };
}

/* ─── CRM Layout with DashboardProvider + BottomTabBar ─── */

function CrmLayout({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();

  // Map location to legacy "currentPage" for CrmShell sidebar highlighting
  const currentPage = (() => {
    if (location.pathname.startsWith("/app/branding")) return "branding";
    if (location.pathname.startsWith("/app/admin")) return "admin";
    return "dashboard";
  })();

  const handleNavigate = (page: string) => {
    if (page === "dashboard") navigate("/app");
    else if (page === "branding") navigate("/app/branding");
    else if (page === "admin") navigate("/app/admin");
    else navigate("/app");
  };

  return (
    <CrmShell
      currentPage={currentPage}
      onNavigate={handleNavigate}
      onLogout={onLogout}
      fullName={session.fullName}
      planName={session.effectivePlanName}
      planCode={session.effectivePlanCode}
      isTrial={session.isTrial}
      entitlements={session.entitlements}
    >
      <DashboardProvider
        session={toDashboardSession(session)}
        onNavigateToQuote={(quoteId) => navigate(`/app/quotes/${quoteId}`)}
      >
        <main className="crm-light min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(42,127,216,0.10),_transparent_38%),radial-gradient(circle_at_top_right,_rgba(244,96,54,0.08),_transparent_36%),#f8fafc] p-3 pb-24 sm:p-6 sm:pb-8 lg:p-8">
          <div className="mx-auto max-w-7xl">
            <Routes>
              <Route index element={<PipelineView />} />
              <Route path="build" element={<QuoteBuilderView />} />
              <Route path="quotes" element={<QuoteDeskView />} />
              <Route path="quotes/:quoteId" element={<QuoteDeskView />} />
              <Route path="history" element={<QuoteHistoryView />} />
              <Route path="settings" element={<Navigate to="/app/admin" replace />} />
              <Route path="branding" element={<BrandingPage tenantId={session.tenantId} />} />
              <Route path="admin" element={<AdminPage session={session} />} />
              <Route path="*" element={<Navigate to="/app" replace />} />
            </Routes>
          </div>
        </main>
        <BottomTabBar />
      </DashboardProvider>
    </CrmShell>
  );
}

/* ─── Marketing Layout ─── */

function MarketingLayout({
  onOpenAuth,
  onLogout,
  isLoggedIn,
}: {
  onOpenAuth: () => void;
  onLogout: () => void;
  isLoggedIn: boolean;
}) {
  const location = useLocation();
  const currentPage = location.pathname === "/" ? "landing" : location.pathname.slice(1);

  const navigate = useNavigate();
  const handleNavigate = (page: string) => {
    if (page === "landing") navigate("/");
    else navigate(`/${page}`);
  };

  return (
    <div className="min-h-screen flex flex-col bg-stone-50">
      <Navbar
        currentPage={currentPage}
        onNavigate={handleNavigate}
        isLoggedIn={isLoggedIn}
        onOpenAuth={onOpenAuth}
        onLogout={onLogout}
      />
      <main className="flex-1">
        <Routes>
          <Route index element={<LandingPage onOpenAuth={onOpenAuth} />} />
          <Route path="pricing" element={<PricingPage onOpenAuth={onOpenAuth} />} />
          <Route path="solutions" element={<SolutionsPage onOpenAuth={onOpenAuth} />} />
          <Route path="about" element={<AboutPage onOpenAuth={onOpenAuth} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <Footer />
    </div>
  );
}

/* ─── Root App ─── */

function AppRoutes() {
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [isSessionChecking, setIsSessionChecking] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    let isMounted = true;
    const token = localStorage.getItem("qf_token");

    if (!token) {
      setIsSessionChecking(false);
      return () => { isMounted = false; };
    }

    async function restoreSession() {
      try {
        const payload = await api.auth.me();
        if (!isMounted) return;
        localStorage.setItem("qf_tenant_id", payload.tenant.id);
        localStorage.setItem("qf_full_name", payload.user.fullName);
        setSession(toSession(payload));
        navigate("/app", { replace: true });
      } catch (error) {
        clearStoredSession();
        if (isMounted) setSession(null);
        if (!(error instanceof ApiError && error.status === 401)) {
          console.error("Session restore failed", error);
        }
      } finally {
        if (isMounted) setIsSessionChecking(false);
      }
    }

    void restoreSession();
    return () => { isMounted = false; };
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
        navigate("/app", { replace: true });
        setIsSessionChecking(false);
      });
  };

  const handleLogout = () => {
    clearStoredSession();
    setSession(null);
    navigate("/", { replace: true });
  };

  if (isSessionChecking) {
    return <AppLoadingScreen message="Restoring your session..." />;
  }

  const isLoggedIn = session !== null;

  return (
    <>
      <Routes>
        {isLoggedIn && session ? (
          <Route path="/app/*" element={<CrmLayout session={session} onLogout={handleLogout} />} />
        ) : (
          <Route path="/app/*" element={<Navigate to="/" replace />} />
        )}
        <Route
          path="/*"
          element={
            isLoggedIn
              ? <Navigate to="/app" replace />
              : <MarketingLayout onOpenAuth={() => setIsAuthModalOpen(true)} onLogout={handleLogout} isLoggedIn={isLoggedIn} />
          }
        />
      </Routes>
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
        onSuccess={handleAuthSuccess}
      />
    </>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}

export default App;
