import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import { Navbar } from "./components/Navbar";
import { CrmShell } from "./components/CrmShell";
import { AuthModal } from "./components/AuthModal";
import { Footer } from "./components/Footer";
import { AppLoadingScreen } from "./components/AppLoadingScreen";
import { CookieConsentBanner } from "./components/CookieConsentBanner";
import { BottomTabBar } from "./components/crm/BottomTabBar";
import { DashboardProvider, type DashboardSession } from "./components/dashboard/DashboardContext";
import {
  api,
  ApiError,
  type AuthPayload,
  type AuthSessionPayload,
  type ServiceType,
  type TenantEntitlements,
  type TenantUsageSnapshot,
} from "./lib/api";
import { Toaster } from "sonner";

const LandingPage = lazy(() => import("./pages/LandingPage").then((module) => ({ default: module.LandingPage })));
const PricingPage = lazy(() => import("./pages/PricingPage").then((module) => ({ default: module.PricingPage })));
const SolutionsPage = lazy(() => import("./pages/SolutionsPage").then((module) => ({ default: module.SolutionsPage })));
const AboutPage = lazy(() => import("./pages/AboutPage").then((module) => ({ default: module.AboutPage })));
const SupportPage = lazy(() => import("./pages/SupportPage").then((module) => ({ default: module.SupportPage })));
const PrivacyPage = lazy(() => import("./pages/PrivacyPage").then((module) => ({ default: module.PrivacyPage })));
const DataPrivacyPage = lazy(() => import("./pages/DataPrivacyPage").then((module) => ({ default: module.DataPrivacyPage })));
const TermsPage = lazy(() => import("./pages/TermsPage").then((module) => ({ default: module.TermsPage })));
const CookiePolicyPage = lazy(() => import("./pages/CookiePolicyPage").then((module) => ({ default: module.CookiePolicyPage })));
const BrandingPage = lazy(() => import("./pages/BrandingPage").then((module) => ({ default: module.BrandingPage })));
const SetupPage = lazy(() => import("./pages/SetupPage").then((module) => ({ default: module.SetupPage })));
const AdminPage = lazy(() => import("./pages/AdminPage").then((module) => ({ default: module.AdminPage })));
const PipelineView = lazy(() => import("./views/PipelineView").then((module) => ({ default: module.PipelineView })));
const QuoteBuilderView = lazy(() => import("./views/QuoteBuilderView").then((module) => ({ default: module.QuoteBuilderView })));
const QuoteDeskView = lazy(() => import("./views/QuoteDeskView").then((module) => ({ default: module.QuoteDeskView })));
const QuoteHistoryView = lazy(() => import("./views/QuoteHistoryView").then((module) => ({ default: module.QuoteHistoryView })));

type Session = {
  email: string;
  fullName: string;
  tenantId: string;
  role: string;
  primaryTrade?: ServiceType | null;
  onboardingCompletedAtUtc?: string | null;
  subscriptionStatus?: string;
  subscriptionPlanCode?: string | null;
  trialEndsAtUtc?: string | null;
  subscriptionCurrentPeriodEndUtc?: string | null;
  effectivePlanCode?: "starter" | "professional" | "enterprise";
  effectivePlanName?: string;
  isTrial?: boolean;
  entitlements?: TenantEntitlements;
  usage?: TenantUsageSnapshot;
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
    trialEndsAtUtc: payload.tenant.trialEndsAtUtc ?? null,
    subscriptionCurrentPeriodEndUtc: payload.tenant.subscriptionCurrentPeriodEndUtc ?? null,
    effectivePlanCode: payload.tenant.effectivePlanCode,
    effectivePlanName: payload.tenant.effectivePlanName,
    isTrial: payload.tenant.isTrial,
    entitlements: payload.tenant.entitlements,
    usage: payload.tenant.usage,
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
    usage: s.usage,
  };
}

/* ─── CRM Layout with DashboardProvider + BottomTabBar ─── */

function CrmLayout({
  session,
  onLogout,
  onRefreshSession,
}: {
  session: Session;
  onLogout: () => void;
  onRefreshSession: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!session.onboardingCompletedAtUtc && !location.pathname.startsWith("/app/setup")) {
      navigate("/app/setup", { replace: true });
    }
  }, [location.pathname, navigate, session.onboardingCompletedAtUtc]);

  const currentPage = (() => {
    if (location.pathname.startsWith("/app/build")) return "build";
    if (location.pathname.startsWith("/app/quotes")) return "quotes";
    if (location.pathname.startsWith("/app/history")) return "history";
    if (location.pathname.startsWith("/app/setup")) return "setup";
    if (location.pathname.startsWith("/app/branding")) return "branding";
    if (location.pathname.startsWith("/app/admin")) return "admin";
    return "pipeline";
  })();

  const handleNavigate = (page: string) => {
    if (page === "pipeline") navigate("/app");
    else if (page === "build") navigate("/app/build");
    else if (page === "quotes") navigate("/app/quotes");
    else if (page === "history") navigate("/app/history");
    else if (page === "setup") navigate("/app/setup");
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
      usage={session.usage}
    >
      <DashboardProvider
        session={toDashboardSession(session)}
        onNavigateToQuote={(quoteId) => navigate(`/app/quotes/${quoteId}`)}
        onNavigateToBuilder={() => navigate("/app/build")}
      >
        <main className="crm-light min-h-screen bg-slate-50 p-3 pb-24 sm:p-6 sm:pb-8 lg:p-8">
          <Suspense fallback={<AppLoadingScreen message="Loading workspace..." />}>
            <div className="mx-auto max-w-7xl">
              <Routes>
                <Route index element={<PipelineView />} />
                <Route path="setup" element={<SetupPage session={session} onSetupSaved={onRefreshSession} />} />
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
          </Suspense>
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
        <Suspense fallback={<AppLoadingScreen message="Loading page..." />}>
          <Routes>
            <Route index element={<LandingPage onOpenAuth={onOpenAuth} />} />
            <Route path="pricing" element={<PricingPage onOpenAuth={onOpenAuth} />} />
            <Route path="solutions" element={<SolutionsPage onOpenAuth={onOpenAuth} />} />
            <Route path="about" element={<AboutPage onOpenAuth={onOpenAuth} />} />
            <Route path="support" element={<SupportPage onOpenAuth={onOpenAuth} />} />
            <Route path="privacy" element={<PrivacyPage />} />
            <Route path="data-privacy" element={<DataPrivacyPage />} />
            <Route path="terms" element={<TermsPage />} />
            <Route path="cookies" element={<CookiePolicyPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </main>
      <Footer />
      <CookieConsentBanner />
    </div>
  );
}

/* ─── Root App ─── */

function AppRoutes() {
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [isSessionChecking, setIsSessionChecking] = useState(true);
  const navigate = useNavigate();

  async function refreshSessionState() {
    const payload = await api.auth.me();
    localStorage.setItem("qf_tenant_id", payload.tenant.id);
    localStorage.setItem("qf_full_name", payload.user.fullName);
    setSession(toSession(payload));
  }

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

    void refreshSessionState()
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
          <Route
            path="/app/*"
            element={<CrmLayout session={session} onLogout={handleLogout} onRefreshSession={refreshSessionState} />}
          />
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
      <Toaster position="top-right" richColors closeButton theme="light" />
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
