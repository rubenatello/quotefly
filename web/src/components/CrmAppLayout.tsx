import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { AppLoadingScreen } from "./AppLoadingScreen";
import { CrmShell } from "./CrmShell";
import { BillingRequiredScreen } from "./billing/BillingRequiredScreen";
import { TrialConversionBanner } from "./billing/TrialConversionBanner";
import { BottomTabBar } from "./crm/BottomTabBar";
import {
  workspacePageFromPath,
  workspacePathForNavigation,
  type WorkspaceNavigationId,
} from "./crm/workspace-navigation";
import { DashboardProvider, type DashboardSession } from "./dashboard/DashboardContext";
import type { AppSession } from "../lib/app-session";

const KodyAssistant = lazy(() => import("./ai/KodyAssistant").then((module) => ({ default: module.KodyAssistant })));
const BrandingPage = lazy(() => import("../pages/BrandingPage").then((module) => ({ default: module.BrandingPage })));
const SetupPage = lazy(() => import("../pages/SetupPage").then((module) => ({ default: module.SetupPage })));
const AdminPage = lazy(() => import("../pages/AdminPage").then((module) => ({ default: module.AdminPage })));
const SuperuserAdminPage = lazy(() => import("../pages/SuperuserAdminPage").then((module) => ({ default: module.SuperuserAdminPage })));
const SuperuserAiPage = lazy(() => import("../pages/SuperuserAiPage").then((module) => ({ default: module.SuperuserAiPage })));
const CustomersPage = lazy(() => import("../pages/CustomersPage").then((module) => ({ default: module.CustomersPage })));
const QuotesPage = lazy(() => import("../pages/QuotesPage").then((module) => ({ default: module.QuotesPage })));
const ProductsPage = lazy(() => import("../pages/ProductsPage").then((module) => ({ default: module.ProductsPage })));
const AnalyticsPage = lazy(() => import("../pages/AnalyticsPage").then((module) => ({ default: module.AnalyticsPage })));
const QuoteBuilderView = lazy(() => import("../views/QuoteBuilderView").then((module) => ({ default: module.QuoteBuilderView })));
const QuoteDeskView = lazy(() => import("../views/QuoteDeskView").then((module) => ({ default: module.QuoteDeskView })));
const PipelineView = lazy(() => import("../views/PipelineView").then((module) => ({ default: module.PipelineView })));

function toDashboardSession(s: AppSession): DashboardSession {
  return {
    userId: s.userId,
    email: s.email,
    fullName: s.fullName,
    tenantId: s.tenantId,
    tenantName: s.tenantName,
    role: s.role.trim().toLowerCase() === "owner" || s.role.trim().toLowerCase() === "admin"
      ? s.role.trim().toLowerCase() as "owner" | "admin"
      : "member",
    primaryTrade: s.primaryTrade,
    onboardingCompletedAtUtc: s.onboardingCompletedAtUtc,
    effectivePlanName: s.effectivePlanName,
    effectivePlanCode: s.effectivePlanCode,
    isTrial: s.isTrial,
    entitlements: s.entitlements,
    usage: s.usage,
  };
}

export function CrmAppLayout({
  session,
  onLogout,
  onRefreshSession,
}: {
  session: AppSession;
  onLogout: () => void;
  onRefreshSession: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const canManageCatalog = ["owner", "admin"].includes(session.role.trim().toLowerCase());
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
    if (canManageCatalog && !session.onboardingCompletedAtUtc && !location.pathname.startsWith("/app/setup")) {
      navigate("/app/setup", { replace: true });
    }
  }, [canManageCatalog, location.pathname, navigate, session.onboardingCompletedAtUtc, workspaceLocked]);

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
      canManageCatalog={canManageCatalog}
    >
      <DashboardProvider
        session={toDashboardSession(session)}
        onNavigateToQuote={(quoteId) => navigate(`/app/quotes/${quoteId}`)}
        onNavigateToBuilder={() => navigate("/app/build")}
      >
        <main id="main-content" className="qf-workspace-main min-h-screen bg-qf-canvas px-3 pb-[var(--qf-mobile-content-clearance)] pt-3 sm:px-6 sm:pt-6 lg:px-8 lg:pb-8 lg:pt-8 xl:px-10 2xl:px-12">
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
                <Route path="setup" element={canManageCatalog ? <SetupPage session={session} onSetupSaved={onRefreshSession} /> : <Navigate to="/app/quotes" replace />} />
                <Route path="build" element={<QuoteBuilderView />} />
                <Route path="quotes" element={<QuotesPage />} />
                <Route path="products" element={canManageCatalog ? <ProductsPage /> : <Navigate to="/app/quotes" replace />} />
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
          <KodyAssistant currentPage={currentPage} canViewInternalCosts={session.role.trim().toLowerCase() !== "member"} />
        </Suspense>
      </DashboardProvider>
    </CrmShell>
  );
}
