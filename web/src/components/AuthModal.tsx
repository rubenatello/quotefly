import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type AuthPayload, type ServiceType } from "../lib/api";
import { CURRENT_LEGAL_VERSION } from "../lib/legal";
import { Button, Modal, ModalBody, ModalFooter, ModalHeader } from "./ui";

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (payload: AuthPayload) => void;
  initialMode?: AuthEntryMode;
}

export type AuthEntryMode = "signin" | "signup";
type AuthMode = AuthEntryMode | "forgot";

const TRADE_OPTIONS: { value: ServiceType; label: string }[] = [
  { value: "HVAC", label: "HVAC" },
  { value: "ROOFING", label: "Roofing" },
  { value: "FLOORING", label: "Flooring" },
  { value: "GARDENING", label: "Gardening" },
  { value: "PLUMBING", label: "Plumbing" },
  { value: "CONSTRUCTION", label: "Construction" },
];

const inputClass =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 placeholder-slate-400 transition focus:border-quotefly-blue focus:outline-none focus:ring-2 focus:ring-quotefly-blue/20";

export function AuthModal({ isOpen, onClose, onSuccess, initialMode = "signup" }: AuthModalProps) {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [primaryTrade, setPrimaryTrade] = useState<ServiceType>("ROOFING");
  const [logoDataUrl, setLogoDataUrl] = useState<string>("");
  const [acceptedLegalTerms, setAcceptedLegalTerms] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setMode(initialMode);
    setError(null);
    setSuccess(null);
  }, [initialMode, isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setIsLoading(true);

    try {
      if (mode === "forgot") {
        const response = await api.auth.forgotPassword({ email });
        setSuccess(response.message);
        return;
      }

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
          acceptedLegalTerms: true,
          termsVersion: CURRENT_LEGAL_VERSION,
          privacyPolicyVersion: CURRENT_LEGAL_VERSION,
        });
      } else {
        payload = await api.auth.signin({ email, password });
      }

      localStorage.setItem("qf_tenant_id", payload.tenant.id);

      onSuccess?.(payload);
      setEmail("");
      setPassword("");
      setFullName("");
      setBusinessName("");
      setPrimaryTrade("ROOFING");
      setLogoDataUrl("");
      setAcceptedLegalTerms(false);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const switchMode = (next: AuthMode) => {
    setMode(next);
    setError(null);
    setSuccess(null);
    setPassword("");
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
    <Modal
      open={isOpen}
      onClose={onClose}
      size="md"
      ariaLabel={mode === "signin" ? "Sign in" : mode === "forgot" ? "Reset password" : "Start free trial"}
    >
      <ModalHeader
        title={mode === "signin" ? "Welcome Back" : mode === "forgot" ? "Reset Your Password" : "Start Your Free Trial"}
        description={
          mode === "signin"
            ? "Sign in to your QuoteFly workspace."
            : mode === "forgot"
              ? "Enter your account email and we’ll send you a secure reset link."
              : "Set up your account in under a minute."
        }
        onClose={onClose}
      />

      <ModalBody>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              <svg className="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 16 16" fill="currentColor">
                <path fillRule="evenodd" d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14zm.75-9.25a.75.75 0 0 0-1.5 0v2.5a.75.75 0 0 0 1.5 0v-2.5zM8 11a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" clipRule="evenodd" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          {success && (
            <div role="status" className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm leading-6 text-blue-800">
              {success} Check your spam folder if it does not arrive within a few minutes.
            </div>
          )}

          {mode === "signup" && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="fullName" className="mb-1.5 block text-sm font-medium text-slate-700">
                    Your Name
                  </label>
                  <input
                    id="fullName"
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Jane Smith"
                    autoComplete="name"
                    className={inputClass}
                    required
                  />
                </div>
                <div>
                  <label htmlFor="business" className="mb-1.5 block text-sm font-medium text-slate-700">
                    Business Name
                  </label>
                  <input
                    id="business"
                    type="text"
                    value={businessName}
                    onChange={(e) => setBusinessName(e.target.value)}
                    placeholder="Your Contracting Co."
                    autoComplete="organization"
                    className={inputClass}
                    required
                  />
                </div>
              </div>

              <div>
                <label htmlFor="primaryTrade" className="mb-1.5 block text-sm font-medium text-slate-700">
                  Primary Trade
                </label>
                <select
                  id="primaryTrade"
                  value={primaryTrade}
                  onChange={(event) => setPrimaryTrade(event.target.value as ServiceType)}
                  className={inputClass}
                >
                  {TRADE_OPTIONS.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="logoUpload" className="mb-1.5 block text-sm font-medium text-slate-700">
                  Logo <span className="text-slate-400">(optional)</span>
                </label>
                <div className="flex items-center gap-3">
                  {logoDataUrl ? (
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 p-1">
                      <img src={logoDataUrl} alt="Logo preview" className="max-h-full max-w-full object-contain" />
                    </div>
                  ) : (
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-slate-400">
                      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0 0 22.5 18.75V5.25A2.25 2.25 0 0 0 20.25 3H3.75A2.25 2.25 0 0 0 1.5 5.25v13.5A2.25 2.25 0 0 0 3.75 21Z" />
                      </svg>
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <input
                      id="logoUpload"
                      type="file"
                      accept="image/*"
                      onChange={handleLogoUpload}
                      className="w-full cursor-pointer text-sm text-slate-600 file:mr-3 file:rounded-full file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-slate-700 hover:file:bg-slate-200"
                    />
                    <p className="mt-0.5 text-[11px] text-slate-400">
                      We&apos;ll generate one if you skip this.
                    </p>
                  </div>
                </div>
              </div>

              <div className="border-t border-slate-100 pt-4">
                <p className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-400">Account Credentials</p>
              </div>
            </>
          )}

          <div>
            <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-slate-700">
              Email Address
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              autoComplete={mode === "signup" ? "username" : "email"}
              className={inputClass}
              required
            />
          </div>

          {mode !== "forgot" ? (
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <label htmlFor="password" className="block text-sm font-medium text-slate-700">
                  Password{" "}
                  {mode === "signup" && (
                    <span className="font-normal text-slate-400">(min 8 characters)</span>
                  )}
                </label>
                {mode === "signin" ? (
                  <button
                    type="button"
                    onClick={() => switchMode("forgot")}
                    className="min-h-11 text-sm font-semibold text-quotefly-blue transition-colors hover:text-blue-700 sm:min-h-0"
                  >
                    Forgot password?
                  </button>
                ) : null}
              </div>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === "signin" ? "Enter your password" : "Choose a password"}
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
                minLength={mode === "signup" ? 8 : 1}
                className={inputClass}
                required
              />
            </div>
          ) : null}

          {mode === "signup" ? (
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={acceptedLegalTerms}
                onChange={(event) => setAcceptedLegalTerms(event.target.checked)}
                className="mt-0.5 h-5 w-5 shrink-0 rounded border-slate-300 text-quotefly-blue focus:ring-quotefly-blue"
                required
              />
              <span>
                I agree to the{" "}
                <Link
                  to="/terms"
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-quotefly-blue hover:text-blue-700"
                >
                  Terms of Service
                </Link>{" "}
                and acknowledge the{" "}
                <Link
                  to="/privacy"
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-quotefly-blue hover:text-blue-700"
                >
                  Privacy Policy
                </Link>
                .
              </span>
            </label>
          ) : null}

          <Button
            type="submit"
            disabled={isLoading || Boolean(success) || (mode === "signup" && !acceptedLegalTerms)}
            loading={isLoading}
            fullWidth
            size="lg"
          >
            {isLoading
              ? "Please wait..."
              : mode === "signin"
                ? "Sign In"
                : mode === "forgot"
                  ? success
                    ? "Reset Link Sent"
                    : "Send Reset Link"
                  : "Create Account"}
          </Button>

          <p className="text-center text-sm text-slate-500">
            {mode === "forgot" ? (
              <>
                Remember your password?{" "}
                <button
                  type="button"
                  onClick={() => switchMode("signin")}
                  className="min-h-11 font-medium text-quotefly-blue transition-colors hover:text-blue-700 sm:min-h-0"
                >
                  Back to sign in
                </button>
              </>
            ) : mode === "signin" ? (
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
          </p>
        </form>
      </ModalBody>

      <ModalFooter className="justify-center bg-slate-50 text-center text-xs text-slate-400">
        <p>
          14-day free trial &middot; No credit card required &middot;{" "}
          <Link to="/terms" onClick={onClose} className="text-quotefly-blue hover:text-blue-700">
            Terms
          </Link>{" "}
          &amp;{" "}
          <Link to="/privacy" onClick={onClose} className="text-quotefly-blue hover:text-blue-700">
            Privacy
          </Link>
        </p>
      </ModalFooter>
    </Modal>
  );
}
