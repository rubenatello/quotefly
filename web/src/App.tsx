import { useEffect, useState } from "react";
import { Navbar } from "./components/Navbar";
import { AuthModal } from "./components/AuthModal";
import { Footer } from "./components/Footer";
import { LandingPage } from "./pages/LandingPage";
import { PricingPage } from "./pages/PricingPage";
import { SolutionsPage } from "./pages/SolutionsPage";
import { AboutPage } from "./pages/AboutPage";
import { BrandingPage } from "./pages/BrandingPage";
import { DashboardPage } from "./pages/DashboardPage";
import type { AuthPayload } from "./lib/api";

type Session = { email: string; fullName: string; tenantId: string };

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split(".")[1];
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

function App() {
  const [currentPage, setCurrentPage] = useState("landing");
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    const token = localStorage.getItem("qf_token");
    if (!token) return;
    const claims = decodeJwt(token) as { email?: string; tenantId?: string } | null;
    if (!claims?.email || !claims?.tenantId) {
      localStorage.removeItem("qf_token");
      return;
    }
    const storedName = localStorage.getItem("qf_full_name") ?? claims.email;
    setSession({ email: claims.email, fullName: storedName, tenantId: claims.tenantId });
    setCurrentPage("dashboard");
  }, []);

  const handleAuthSuccess = (payload: AuthPayload) => {
    localStorage.setItem("qf_full_name", payload.user.fullName);
    setSession({
      email: payload.user.email,
      fullName: payload.user.fullName,
      tenantId: payload.tenant.id,
    });
    setCurrentPage("dashboard");
  };

  const handleLogout = () => {
    localStorage.removeItem("qf_token");
    localStorage.removeItem("qf_tenant_id");
    localStorage.removeItem("qf_full_name");
    setSession(null);
    setCurrentPage("landing");
  };

  const isLoggedIn = session !== null;

  const renderPage = () => {
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
        return <BrandingPage tenantId={session?.tenantId} />;
      case "dashboard":
        return <DashboardPage session={session} onLogout={handleLogout} />;
      default:
        return <LandingPage onOpenAuth={() => setIsAuthModalOpen(true)} />;
    }
  };

  return (
    <div className={`min-h-screen flex flex-col ${isLoggedIn ? "bg-zinc-950" : "bg-stone-50"}`}>
      <Navbar
        currentPage={currentPage}
        onNavigate={setCurrentPage}
        isLoggedIn={isLoggedIn}
        onOpenAuth={() => setIsAuthModalOpen(true)}
        onLogout={handleLogout}
      />
      <main className="flex-1">
        {renderPage()}
      </main>
      {!isLoggedIn && <Footer />}
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
        onSuccess={handleAuthSuccess}
      />
    </div>
  );
}

export default App;
