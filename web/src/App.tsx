import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import "./App.css";
import { Navbar } from "./components/Navbar";
import type { AuthEntryMode } from "./components/AuthModal";
import { Footer } from "./components/Footer";
import { AppLoadingScreen } from "./components/AppLoadingScreen";
import { CookieConsentBanner } from "./components/CookieConsentBanner";
import { useTheme } from "./components/theme/theme-context";
import {
  api,
  ApiError,
  type AuthPayload,
  type AuthSessionPayload,
} from "./lib/api";
import type { AppSession, SessionRecovery } from "./lib/app-session";
import { prepareQuoteBuilderDraftStorage, purgeQuoteBuilderDraftStorage } from "./lib/quote-builder-draft-storage";
import { Toaster } from "sonner";

const LandingPage = lazy(() => import("./pages/LandingPage").then((module) => ({ default: module.LandingPage })));
const PricingPage = lazy(() => import("./pages/PricingPage").then((module) => ({ default: module.PricingPage })));
const ServicesPage = lazy(() => import("./pages/ServicesPage").then((module) => ({ default: module.ServicesPage })));
const SolutionsPage = lazy(() => import("./pages/SolutionsPage").then((module) => ({ default: module.SolutionsPage })));
const LandscapingSolutionsPage = lazy(() => import("./pages/LandscapingSolutionsPage").then((module) => ({ default: module.LandscapingSolutionsPage })));
const AboutPage = lazy(() => import("./pages/AboutPage").then((module) => ({ default: module.AboutPage })));
const SupportPage = lazy(() => import("./pages/SupportPage").then((module) => ({ default: module.SupportPage })));
const PrivacyPage = lazy(() => import("./pages/PrivacyPage").then((module) => ({ default: module.PrivacyPage })));
const DataPrivacyPage = lazy(() => import("./pages/DataPrivacyPage").then((module) => ({ default: module.DataPrivacyPage })));
const TermsPage = lazy(() => import("./pages/TermsPage").then((module) => ({ default: module.TermsPage })));
const CookiePolicyPage = lazy(() => import("./pages/CookiePolicyPage").then((module) => ({ default: module.CookiePolicyPage })));
const ResetPasswordPage = lazy(() => import("./pages/ResetPasswordPage").then((module) => ({ default: module.ResetPasswordPage })));
const AuthModal = lazy(() => import("./components/AuthModal").then((module) => ({ default: module.AuthModal })));
const CrmAppLayout = lazy(() => import("./components/CrmAppLayout").then((module) => ({ default: module.CrmAppLayout })));

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

function toSession(payload: AuthSessionPayload): AppSession {
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
  session?: AppSession | null;
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
            <Route path="solutions/landscaping" element={<LandscapingSolutionsPage onOpenAuth={onOpenAuth} />} />
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
  const { resolvedTheme } = useTheme();
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [authEntryMode, setAuthEntryMode] = useState<AuthEntryMode>("signup");
  const [session, setSession] = useState<AppSession | null>(null);
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

  const hydrateSessionState = useCallback(async (): Promise<AppSession> => {
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

  function navigateAfterHydration(nextSession: AppSession, source: SessionRecovery["source"]) {
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
            element={
              <Suspense fallback={<AppLoadingScreen message="Loading workspace..." />}>
                <CrmAppLayout session={session} onLogout={handleLogout} onRefreshSession={refreshSessionState} />
              </Suspense>
            }
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
      {isAuthModalOpen ? (
        <Suspense fallback={null}>
          <AuthModal
            isOpen={isAuthModalOpen}
            onClose={() => setIsAuthModalOpen(false)}
            onSuccess={handleAuthSuccess}
            initialMode={authEntryMode}
          />
        </Suspense>
      ) : null}
      <CookieConsentBanner />
      <Toaster position="top-right" richColors closeButton theme={resolvedTheme} />
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
