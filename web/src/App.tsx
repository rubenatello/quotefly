import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import "./App.css";
import { Navbar } from "./components/Navbar";
import { CrmShell } from "./components/CrmShell";
import { AuthModal, type AuthEntryMode } from "./components/AuthModal";
import { Footer } from "./components/Footer";
import { AppLoadingScreen } from "./components/AppLoadingScreen";
import { CookieConsentBanner } from "./components/CookieConsentBanner";
import { BillingRequiredScreen } from "./components/billing/BillingRequiredScreen";
import { TrialConversionBanner } from "./components/billing/TrialConversionBanner";
import { BottomTabBar } from "./components/crm/BottomTabBar";
import {
  workspacePageFromPath,
  workspacePathForNavigation,
  type WorkspaceNavigationId,
} from "./components/crm/workspace-navigation";
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
import { prepareQuoteBuilderDraftStorage, purgeQuoteBuilderDraftStorage } from "./lib/quote-builder-draft-storage";
import { Toaster } from "sonner";

const LandingPage = lazy(() => import("./pages/LandingPage").then((module) => ({ default: module.LandingPage })));
const PricingPage = lazy(() => import("./pages/PricingPage").then((module) => ({ default: module.PricingPage })));
const ServicesPage = lazy(() => import("./pages/ServicesPage").then((module) => ({ default: module.ServicesPage })));
const SolutionsPage = lazy(() => import("./pages/SolutionsPage").then((module) => ({ default: module.SolutionsPage })));
const AboutPage = lazy(() => import("./pages/AboutPage").then((module) => ({ default: module.AboutPage })));
const SupportPage = lazy(() => import("./pages/SupportPage").then((module) => ({ default: module.SupportPage })));
const PrivacyPage = lazy(() => import("./pages/PrivacyPage").then((module) => ({ default: module.PrivacyPage })));
const DataPrivacyPage = lazy(() => import("./pages/DataPrivacyPage").then((module) => ({ default: module.DataPrivacyPage })));
const TermsPage = lazy(() => import("./pages/TermsPage").then((module) => ({ default: module.TermsPage })));
const CookiePolicyPage = lazy(() => import("./pages/CookiePolicyPage").then((module) => ({ default: module.CookiePolicyPage })));
const ResetPasswordPage = lazy(() => import("./pages/ResetPasswordPage").then((module) => ({ default: module.ResetPasswordPage })));
const KodyAssistant = lazy(() => import("./components/ai/KodyAssistant").then((module) => ({ default: module.KodyAssistant })));
const BrandingPage = lazy(() => import("./pages/BrandingPage").then((module) => ({ default: module.BrandingPage })));
const SetupPage = lazy(() => import("./pages/SetupPage").then((module) => ({ default: module.SetupPage })));
const AdminPage = lazy(() => import("./pages/AdminPage").then((module) => ({ default: module.AdminPage })));
const SuperuserAdminPage = lazy(() => import("./pages/SuperuserAdminPage").then((module) => ({ default: module.SuperuserAdminPage })));
const SuperuserAiPage = lazy(() => import("./pages/SuperuserAiPage").then((module) => ({ default: module.SuperuserAiPage })));
const CustomersPage = lazy(() => import("./pages/CustomersPage").then((module) => ({ default: module.CustomersPage })));
const QuotesPage = lazy(() => import("./pages/QuotesPage").then((module) => ({ default: module.QuotesPage })));
const ProductsPage = lazy(() => import("./pages/ProductsPage").then((module) => ({ default: module.ProductsPage })));
const AnalyticsPage = lazy(() => import("./pages/AnalyticsPage").then((module) => ({ default: module.AnalyticsPage })));
const QuoteBuilderView = lazy(() => import("./views/QuoteBuilderView").then((module) => ({ default: module.QuoteBuilderView })));
const QuoteDeskView = lazy(() => import("./views/QuoteDeskView").then((module) => ({ default: module.QuoteDeskView })));
const PipelineView = lazy(() => import("./views/PipelineView").then((module) => ({ default: module.PipelineView })));

type Session = {
  userId: string;
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
    userId: payload.user.id,
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
    userId: s.userId,
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
  const billingReturnState = new URLSearchParams(location.search).get("billing");
  const billingSubscriptionConfirmed =
    Boolean(session.subscriptionPlanCode) &&
    ["active", "trialing"].includes((session.subscriptionStatus ?? "").toLowerCase());

  useEffect(() => {
    if (
      billingReturnState !== "success" ||
      billingSubscriptionConfirmed ||
      session.role.trim().toLowerCase() !== "owner"
    ) {
      return;
    }

    let stopped = false;
    let inFlight = false;
    let attempts = 0;
    const refreshBillingState = async () => {
      if (stopped || inFlight || attempts >= 10) return;
      inFlight = true;
      attempts += 1;
      try {
        await onRefreshSession();
      } catch {
        // The return screen keeps a manual refresh action available if the
        // bounded webhook-confirmation polling window expires.
      } finally {
        inFlight = false;
        if (attempts >= 10) window.clearInterval(intervalId);
      }
    };

    const intervalId = window.setInterval(() => void refreshBillingState(), 1_500);
    void refreshBillingState();
    return () => {
      stopped = true;
      window.clearInterval(intervalId);
    };
  }, [
    billingReturnState,
    billingSubscriptionConfirmed,
    onRefreshSession,
    session.role,
  ]);

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

  const currentPage = workspacePageFromPath(location.pathname);

  const handleNavigate = (page: WorkspaceNavigationId) => {
    navigate(workspacePathForNavigation(page));
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
      email={session.email}
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
        <main id="main-content" className="qf-workspace-main crm-light min-h-screen bg-slate-50 px-3 pb-[var(--qf-mobile-content-clearance)] pt-3 sm:px-6 sm:pt-6 lg:px-8 lg:pb-8 lg:pt-8 xl:px-10 2xl:px-12">
          <Suspense fallback={<AppLoadingScreen message="Loading workspace..." />}>
            <div className="mx-auto w-full max-w-[1840px]">
              {session.isTrial ? (
                <TrialConversionBanner
                  trialEndsAtUtc={session.trialEndsAtUtc}
                  ownerView={session.role.trim().toLowerCase() === "owner"}
                />
              ) : null}
              <Routes>
                <Route index element={<Navigate to="/app/customers" replace />} />
                <Route path="customers" element={<CustomersPage />} />
                <Route path="follow-up" element={<PipelineView />} />
                <Route path="analytics" element={<AnalyticsPage />} />
                <Route path="setup" element={<SetupPage session={session} onSetupSaved={onRefreshSession} />} />
                <Route path="build" element={<QuoteBuilderView />} />
                <Route path="quotes" element={<QuotesPage />} />
                <Route path="products" element={<ProductsPage />} />
                <Route path="quotes/:quoteId" element={<QuoteDeskView />} />
                <Route path="history" element={<Navigate to="/app/analytics" replace />} />
                <Route path="settings" element={<AdminPage session={session} />} />
                <Route path="settings/users" element={<AdminPage session={session} />} />
                <Route
                  path="internal/admin"
                  element={session.isSuperuser ? <SuperuserAdminPage /> : <Navigate to="/app/settings" replace />}
                />
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
                      ? <Navigate to="/app/internal/admin" replace />
                      : <Navigate to="/app/settings" replace />
                  }
                />
                <Route path="*" element={<Navigate to="/app/customers" replace />} />
              </Routes>
            </div>
          </Suspense>
        </main>
        <BottomTabBar />
        <Suspense fallback={null}>
          <KodyAssistant currentPage={currentPage} />
        </Suspense>
      </DashboardProvider>
    </CrmShell>
  );
}

/* ─── Marketing Layout ─── */

function MarketingLayout({
  onOpenAuth,
  onOpenSignIn,
  onLogout,
  isLoggedIn,
  session,
}: {
  onOpenAuth: () => void;
  onOpenSignIn: () => void;
  onLogout: () => void;
  isLoggedIn: boolean;
  session?: Session | null;
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
        onOpenSignIn={onOpenSignIn}
        onLogout={onLogout}
      />
      <main id="main-content" className="flex-1">
        <Suspense fallback={<AppLoadingScreen message="Loading page..." />}>
          <Routes>
            <Route index element={<LandingPage onOpenAuth={onOpenAuth} />} />
            <Route path="pricing" element={<PricingPage onOpenAuth={onOpenAuth} />} />
            <Route path="services" element={<ServicesPage onOpenAuth={onOpenAuth} />} />
            <Route path="solutions" element={<SolutionsPage onOpenAuth={onOpenAuth} />} />
            <Route path="about" element={<AboutPage onOpenAuth={onOpenAuth} />} />
            <Route
              path="support"
              element={
                <SupportPage
                  onOpenAuth={onOpenAuth}
                  initialName={session?.fullName}
                  initialEmail={session?.email}
                />
              }
            />
            <Route path="privacy" element={<PrivacyPage />} />
            <Route path="data-privacy" element={<DataPrivacyPage />} />
            <Route path="terms" element={<TermsPage />} />
            <Route path="cookies" element={<CookiePolicyPage />} />
            <Route path="reset-password" element={<ResetPasswordPage onOpenSignIn={onOpenSignIn} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </main>
      <Footer />
    </div>
  );
}

function ScrollToRoute() {
  const location = useLocation();

  useEffect(() => {
    if (location.hash) {
      window.requestAnimationFrame(() => document.querySelector(location.hash)?.scrollIntoView());
      return;
    }
    window.scrollTo({ top: 0, left: 0 });
  }, [location.hash, location.pathname]);

  return null;
}

/* ─── Root App ─── */

function AppRoutes() {
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [authEntryMode, setAuthEntryMode] = useState<AuthEntryMode>("signup");
  const [session, setSession] = useState<Session | null>(null);
  const [isSessionChecking, setIsSessionChecking] = useState(true);
  const [sessionRecovery, setSessionRecovery] = useState<SessionRecovery | null>(null);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const navigate = useNavigate();
  const location = useLocation();
  const [initialPath] = useState(() => location.pathname);

  const openAuth = (mode: AuthEntryMode) => {
    setAuthEntryMode(mode);
    setIsAuthModalOpen(true);
  };

  const hydrateSessionState = useCallback(async (): Promise<Session> => {
    try {
      const payload = await loadAuthSession();
      prepareQuoteBuilderDraftStorage(payload.tenant.id, payload.user.id);
      localStorage.setItem("qf_tenant_id", payload.tenant.id);
      localStorage.setItem("qf_full_name", payload.user.fullName);
      const nextSession = toSession(payload);
      setSession(nextSession);
      return nextSession;
    } catch (error) {
      if (isDefinitiveSignedOut(error)) {
        purgeQuoteBuilderDraftStorage();
        clearStoredSession();
        setSession(null);
      }
      throw error;
    }
  }, []);

  const refreshSessionState = useCallback(async (): Promise<void> => {
    await hydrateSessionState();
  }, [hydrateSessionState]);

  const handleSessionCheckFailure = useCallback((error: unknown, source: SessionRecovery["source"]) => {
    if (isDefinitiveSignedOut(error)) {
      purgeQuoteBuilderDraftStorage();
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
    if (source === "post-auth") {
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
        prepareQuoteBuilderDraftStorage(payload.tenant.id, payload.user.id);
        localStorage.setItem("qf_tenant_id", payload.tenant.id);
        localStorage.setItem("qf_full_name", payload.user.fullName);
        setSession(toSession(payload));
      } catch (error) {
        if (isMounted) handleSessionCheckFailure(error, "restore");
      } finally {
        if (isMounted) setIsSessionChecking(false);
      }
    }

    void restoreSession();
    return () => { isMounted = false; };
  }, [handleSessionCheckFailure]);

  const handleAuthSuccess = (payload: AuthPayload) => {
    purgeQuoteBuilderDraftStorage();
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
    purgeQuoteBuilderDraftStorage();
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

  const isAppRoute = location.pathname === "/app" || location.pathname.startsWith("/app/");

  if (sessionRecovery && (isAppRoute || sessionRecovery.source === "post-auth")) {
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

  if (isSessionChecking && isAppRoute) {
    return <AppLoadingScreen message="Restoring your session..." />;
  }

  const isLoggedIn = session !== null;

  return (
    <>
      <a
        href="#main-content"
        className="sr-only z-[100] rounded-md bg-white px-4 py-3 font-semibold text-slate-900 shadow-lg focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to main content
      </a>
      <ScrollToRoute />
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
            <MarketingLayout
              onOpenAuth={() => openAuth("signup")}
              onOpenSignIn={() => openAuth("signin")}
              onLogout={handleLogout}
              isLoggedIn={isLoggedIn}
              session={session}
            />
          }
        />
      </Routes>
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
        onSuccess={handleAuthSuccess}
        initialMode={authEntryMode}
      />
      <CookieConsentBanner />
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
