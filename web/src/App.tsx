import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import "./App.css";
import { Navbar } from "./components/Navbar";
import { CrmShell } from "./components/CrmShell";
import { AuthModal } from "./components/AuthModal";
import { Footer } from "./components/Footer";
import { AppLoadingScreen } from "./components/AppLoadingScreen";
import { CookieConsentBanner } from "./components/CookieConsentBanner";
import { BillingRequiredScreen } from "./components/billing/BillingRequiredScreen";
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
const SuperuserAiPage = lazy(() => import("./pages/SuperuserAiPage").then((module) => ({ default: module.SuperuserAiPage })));
const CustomersPage = lazy(() => import("./pages/CustomersPage").then((module) => ({ default: module.CustomersPage })));
const QuotesPage = lazy(() => import("./pages/QuotesPage").then((module) => ({ default: module.QuotesPage })));
const AnalyticsPage = lazy(() => import("./pages/AnalyticsPage").then((module) => ({ default: module.AnalyticsPage })));
const QuoteBuilderView = lazy(() => import("./views/QuoteBuilderView").then((module) => ({ default: module.QuoteBuilderView })));
const QuoteDeskView = lazy(() => import("./views/QuoteDeskView").then((module) => ({ default: module.QuoteDeskView })));

type Session = {
  email: string;
  fullName: string;
  tenantId: string;
  tenantName: string;
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
  isSuperuser?: boolean;
};

type SessionRecovery = {
  source: "restore" | "post-auth";
};

const SESSION_CHECK_TIMEOUT_MS = 15_000;

async function loadAuthSession(): Promise<AuthSessionPayload> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error("Session check timed out.")), SESSION_CHECK_TIMEOUT_MS);
  });

  try {
    return await Promise.race([api.auth.me(), timeout]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

function isDefinitiveSignedOut(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

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
    tenantName: payload.tenant.name,
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
    isSuperuser: payload.isSuperuser ?? false,
  };
}

function toDashboardSession(s: Session): DashboardSession {
  return {
    email: s.email,
    fullName: s.fullName,
    tenantId: s.tenantId,
    tenantName: s.tenantName,
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
  const workspaceLocked =
    session.entitlements?.billingRequired === true &&
    session.entitlements.hasWorkspaceAccess === false &&
    !session.isSuperuser;

  useEffect(() => {
    if (workspaceLocked) return;
    if (!session.onboardingCompletedAtUtc && !location.pathname.startsWith("/app/setup")) {
      navigate("/app/setup", { replace: true });
    }
  }, [location.pathname, navigate, session.onboardingCompletedAtUtc, workspaceLocked]);

  if (workspaceLocked) {
    return (
      <BillingRequiredScreen
        session={session}
        onLogout={onLogout}
        onRefreshSession={onRefreshSession}
      />
    );
  }

  const currentPage = (() => {
    if (location.pathname.startsWith("/app/analytics")) return "analytics";
    if (location.pathname.startsWith("/app/customers")) return "customers";
    if (location.pathname.startsWith("/app/quotes")) return "quotes";
    if (location.pathname.startsWith("/app/build")) return "quotes";
    if (location.pathname.startsWith("/app/history")) return "analytics";
    if (location.pathname.startsWith("/app/settings/users")) return "settings-users";
    if (location.pathname.startsWith("/app/settings")) return "settings";
    if (location.pathname.startsWith("/app/setup")) return "settings";
    if (location.pathname.startsWith("/app/branding")) return "branding";
    if (location.pathname.startsWith("/app/internal/admin")) return "settings";
    if (location.pathname.startsWith("/app/admin")) return "settings";
    return "customers";
  })();

  const handleNavigate = (page: string) => {
    if (page === "customers") navigate("/app/customers");
    else if (page === "analytics") navigate("/app/analytics");
    else if (page === "quotes") navigate("/app/quotes");
    else if (page === "branding") navigate("/app/branding");
    else if (page === "settings") navigate("/app/settings");
    else if (page === "settings-users") navigate("/app/settings/users");
    else navigate("/app/customers");
  };

  const handleQuickAction = (action: "new-customer" | "new-quote") => {
    if (action === "new-customer") {
      navigate("/app/customers?compose=customer");
      return;
    }

    navigate("/app/build");
  };

  return (
    <CrmShell
      currentPage={currentPage}
      onNavigate={handleNavigate}
      onQuickAction={handleQuickAction}
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
        <main className="qf-workspace-main crm-light min-h-screen bg-slate-50 px-3 pb-28 pt-3 sm:px-6 sm:pb-8 sm:pt-6 lg:px-8 lg:pt-8 xl:px-10 2xl:px-12">
          <Suspense fallback={<AppLoadingScreen message="Loading workspace..." />}>
            <div className="mx-auto w-full max-w-[1840px]">
              <Routes>
                <Route index element={<Navigate to="/app/customers" replace />} />
                <Route path="customers" element={<CustomersPage />} />
                <Route path="analytics" element={<AnalyticsPage />} />
                <Route path="setup" element={<SetupPage session={session} onSetupSaved={onRefreshSession} />} />
                <Route path="build" element={<QuoteBuilderView />} />
                <Route path="quotes" element={<QuotesPage />} />
                <Route path="quotes/:quoteId" element={<QuoteDeskView />} />
                <Route path="history" element={<Navigate to="/app/analytics" replace />} />
                <Route path="settings" element={<AdminPage session={session} />} />
                <Route path="settings/users" element={<AdminPage session={session} />} />
                <Route
                  path="internal/admin/ai-quality"
                  element={session.isSuperuser ? <SuperuserAiPage /> : <Navigate to="/app/settings" replace />}
                />
                <Route
                  path="internal/ai-quality"
                  element={<Navigate to="/app/internal/admin/ai-quality" replace />}
                />
                <Route
                  path="branding"
                  element={<BrandingPage tenantId={session.tenantId} effectivePlanCode={session.effectivePlanCode ?? "starter"} />}
                />
                <Route
                  path="admin"
                  element={
                    session.isSuperuser
                      ? <Navigate to="/app/internal/admin/ai-quality" replace />
                      : <Navigate to="/app/settings" replace />
                  }
                />
                <Route path="*" element={<Navigate to="/app/customers" replace />} />
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
  const [sessionRecovery, setSessionRecovery] = useState<SessionRecovery | null>(null);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const navigate = useNavigate();
  const location = useLocation();
  const [initialPath] = useState(() => location.pathname);

  async function hydrateSessionState(): Promise<Session> {
    const payload = await loadAuthSession();
    localStorage.setItem("qf_tenant_id", payload.tenant.id);
    localStorage.setItem("qf_full_name", payload.user.fullName);
    const nextSession = toSession(payload);
    setSession(nextSession);
    return nextSession;
  }

  async function refreshSessionState(): Promise<void> {
    await hydrateSessionState();
  }

  const handleSessionCheckFailure = useCallback((error: unknown, source: SessionRecovery["source"]) => {
    if (isDefinitiveSignedOut(error)) {
      clearStoredSession();
      setSession(null);
      setSessionRecovery(null);
      return;
    }

    console.error(source === "post-auth" ? "Session hydration after auth failed" : "Session restore failed", error);
    setSession(null);
    setSessionRecovery(source === "post-auth" || initialPath.startsWith("/app") ? { source } : null);
  }, [initialPath]);

  function navigateAfterHydration(nextSession: Session, source: SessionRecovery["source"]) {
    if (source === "post-auth" || !initialPath.startsWith("/app")) {
      navigate(nextSession.onboardingCompletedAtUtc ? "/app/customers" : "/app/setup", { replace: true });
    }
  }

  useEffect(() => {
    const updateOnlineStatus = () => setIsOnline(navigator.onLine);
    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);
    return () => {
      window.removeEventListener("online", updateOnlineStatus);
      window.removeEventListener("offline", updateOnlineStatus);
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function restoreSession() {
      try {
        const payload = await loadAuthSession();
        if (!isMounted) return;
        localStorage.setItem("qf_tenant_id", payload.tenant.id);
        localStorage.setItem("qf_full_name", payload.user.fullName);
        setSession(toSession(payload));
        if (!initialPath.startsWith("/app")) {
          navigate(payload.tenant.onboardingCompletedAtUtc ? "/app/customers" : "/app/setup", { replace: true });
        }
      } catch (error) {
        if (isMounted) handleSessionCheckFailure(error, "restore");
      } finally {
        if (isMounted) setIsSessionChecking(false);
      }
    }

    void restoreSession();
    return () => { isMounted = false; };
  }, [handleSessionCheckFailure, initialPath, navigate]);

  const handleAuthSuccess = (payload: AuthPayload) => {
    localStorage.setItem("qf_full_name", payload.user.fullName);
    setIsSessionChecking(true);
    setSessionRecovery(null);
    setSession(null);

    void hydrateSessionState()
      .then((nextSession) => {
        navigateAfterHydration(nextSession, "post-auth");
      })
      .catch((error) => {
        handleSessionCheckFailure(error, "post-auth");
      })
      .finally(() => {
        setIsSessionChecking(false);
      });
  };

  const retrySessionRestore = async () => {
    if (!sessionRecovery || isSessionChecking) return;
    const recoverySource = sessionRecovery.source;
    setIsSessionChecking(true);

    try {
      const nextSession = await hydrateSessionState();
      setSessionRecovery(null);
      navigateAfterHydration(nextSession, recoverySource);
    } catch (error) {
      handleSessionCheckFailure(error, recoverySource);
    } finally {
      setIsSessionChecking(false);
    }
  };

  const handleLogout = async () => {
    try {
      await api.auth.logout();
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) {
        console.error("Logout failed", error);
      }
    } finally {
      clearStoredSession();
      setSession(null);
    }
  };

  if (sessionRecovery) {
    return (
      <AppLoadingScreen
        message="QuoteFly couldn't verify your secure session. Your current page has not been changed."
        recovery={{
          isOnline,
          retrying: isSessionChecking,
          onRetry: () => void retrySessionRestore(),
        }}
      />
    );
  }

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
