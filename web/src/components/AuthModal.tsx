import { useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type AuthPayload, type ServiceType } from "../lib/api";
import { Button, Modal, ModalBody, ModalFooter, ModalHeader } from "./ui";

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (payload: AuthPayload) => void;
}

export function AuthModal({ isOpen, onClose, onSuccess }: AuthModalProps) {
  const [mode, setMode] = useState<"signin" | "signup">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [primaryTrade, setPrimaryTrade] = useState<ServiceType>("ROOFING");
  const [logoDataUrl, setLogoDataUrl] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      let payload: AuthPayload;
      if (mode === "signup") {
        payload = await api.auth.signup({
          email,
          password,
          fullName,
          companyName: businessName,
          primaryTrade,
          logoUrl: logoDataUrl || undefined,
          generateLogoIfMissing: true,
        });
      } else {
        payload = await api.auth.signin({ email, password });
      }

      localStorage.setItem("qf_token", payload.token);
      localStorage.setItem("qf_tenant_id", payload.tenant.id);

      onSuccess?.(payload);
      setEmail("");
      setPassword("");
      setFullName("");
      setBusinessName("");
      setPrimaryTrade("ROOFING");
      setLogoDataUrl("");
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const switchMode = (next: "signin" | "signup") => {
    setMode(next);
    setError(null);
  };

  if (!isOpen) return null;

  const handleLogoUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      setLogoDataUrl("");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      setLogoDataUrl(value);
    };
    reader.readAsDataURL(file);
  };

  return (
    <Modal open={isOpen} onClose={onClose} size="md" ariaLabel={mode === "signin" ? "Sign in" : "Start free trial"}>
      <ModalHeader
        title={mode === "signin" ? "Sign In" : "Start Free Trial"}
        description={mode === "signin" ? "Access your QuoteFly workspace." : "Create your workspace and start quoting fast."}
        onClose={onClose}
      />

      <ModalBody>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {mode === "signup" && (
            <div>
              <label htmlFor="fullName" className="mb-2 block text-sm font-medium text-slate-700">
                Your Name
              </label>
              <input
                id="fullName"
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Jane Smith"
                autoComplete="name"
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 placeholder-slate-400 focus:border-quotefly-blue focus:outline-none focus:ring-1 focus:ring-quotefly-blue/30"
                required
              />
            </div>
          )}

          {mode === "signup" && (
            <div>
              <label htmlFor="business" className="mb-2 block text-sm font-medium text-slate-700">
                Business Name
              </label>
              <input
                id="business"
                type="text"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                placeholder="Your Contracting Company"
                autoComplete="organization"
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 placeholder-slate-400 focus:border-quotefly-blue focus:outline-none focus:ring-1 focus:ring-quotefly-blue/30"
                required
              />
            </div>
          )}

          {mode === "signup" && (
            <div>
              <label htmlFor="primaryTrade" className="mb-2 block text-sm font-medium text-slate-700">
                What kind of work do you do?
              </label>
              <select
                id="primaryTrade"
                value={primaryTrade}
                onChange={(event) => setPrimaryTrade(event.target.value as ServiceType)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 focus:border-quotefly-blue focus:outline-none focus:ring-1 focus:ring-quotefly-blue/30"
              >
                <option value="HVAC">HVAC</option>
                <option value="ROOFING">Roofing</option>
                <option value="FLOORING">Flooring</option>
                <option value="GARDENING">Gardening</option>
                <option value="PLUMBING">Plumbing</option>
                <option value="CONSTRUCTION">Construction</option>
              </select>
            </div>
          )}

          {mode === "signup" && (
            <div>
              <label htmlFor="logoUpload" className="mb-2 block text-sm font-medium text-slate-700">
                Logo (optional)
              </label>
              <input
                id="logoUpload"
                type="file"
                accept="image/*"
                onChange={handleLogoUpload}
                className="w-full cursor-pointer rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 file:mr-3 file:rounded file:border-0 file:bg-slate-100 file:px-2 file:py-1 file:text-xs file:text-slate-700"
              />
              <p className="mt-1 text-xs text-slate-500">
                If skipped, QuoteFly generates a minimal transparent logo you can replace later.
              </p>
              {logoDataUrl && (
                <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
                  <img src={logoDataUrl} alt="Uploaded logo preview" className="max-h-20 max-w-full object-contain" />
                </div>
              )}
            </div>
          )}

          <div>
            <label htmlFor="email" className="mb-2 block text-sm font-medium text-slate-700">
              Email Address
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              autoComplete={mode === "signin" ? "email" : "username"}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 placeholder-slate-400 focus:border-quotefly-blue focus:outline-none focus:ring-1 focus:ring-quotefly-blue/30"
              required
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-2 block text-sm font-medium text-slate-700">
              Password {mode === "signup" && <span className="text-slate-500">(min 8 chars)</span>}
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="********"
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              minLength={mode === "signup" ? 8 : 1}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 placeholder-slate-400 focus:border-quotefly-blue focus:outline-none focus:ring-1 focus:ring-quotefly-blue/30"
              required
            />
          </div>

          <Button type="submit" disabled={isLoading} loading={isLoading} fullWidth>
            {isLoading ? "Loading..." : mode === "signin" ? "Sign In" : "Start Free Trial"}
          </Button>

          <div className="border-t border-slate-200 pt-4 text-center text-sm text-slate-500">
            {mode === "signin" ? (
              <>
                Don&apos;t have an account?{" "}
                <button
                  type="button"
                  onClick={() => switchMode("signup")}
                  className="font-medium text-quotefly-blue transition-colors hover:text-blue-700"
                >
                  Start free trial
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button
                  type="button"
                  onClick={() => switchMode("signin")}
                  className="font-medium text-quotefly-blue transition-colors hover:text-blue-700"
                >
                  Sign in
                </button>
              </>
            )}
          </div>
        </form>
      </ModalBody>

      <ModalFooter className="justify-between bg-slate-50 text-xs text-slate-500">
        <div>
          <p className="mb-2">14-day free trial | No credit card required</p>
          <p>
            By signing up, you agree to our{" "}
            <Link to="/terms" onClick={onClose} className="text-quotefly-blue hover:text-blue-700">
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link to="/privacy" onClick={onClose} className="text-quotefly-blue hover:text-blue-700">
              Privacy Policy
            </Link>
            .
          </p>
        </div>
      </ModalFooter>
    </Modal>
  );
}
