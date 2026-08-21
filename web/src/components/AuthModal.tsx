import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { api, type AuthPayload, type ServiceType } from "../lib/api";
import { CURRENT_PRIVACY_POLICY_VERSION, CURRENT_TERMS_VERSION } from "../lib/legal";
import { localizedApiError } from "../lib/localized-api-error";
import { BASIC_PLAN } from "../lib/plans";
import { useLocale } from "../i18n";
import { Button, Modal, ModalBody, ModalFooter, ModalHeader } from "./ui";
import { LanguageSelector } from "./settings/LanguageSelector";

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (payload: AuthPayload) => void;
  initialMode?: AuthEntryMode;
}

export type AuthEntryMode = "signin" | "signup";
type AuthMode = AuthEntryMode | "forgot";

const TRADE_VALUES: ServiceType[] = ["HVAC", "ROOFING", "FLOORING", "GARDENING", "PLUMBING", "CONSTRUCTION"];

const TRADE_LABEL_KEYS: Record<ServiceType, string> = {
  HVAC: "auth.trades.hvac",
  ROOFING: "auth.trades.roofing",
  FLOORING: "auth.trades.flooring",
  GARDENING: "auth.trades.gardening",
  PLUMBING: "auth.trades.plumbing",
  CONSTRUCTION: "auth.trades.construction",
};

function formatUsd(locale: string, amount: number): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

const inputClass =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 placeholder-slate-400 transition focus:border-quotefly-blue focus:outline-none focus:ring-2 focus:ring-quotefly-blue/20";

export function AuthModal({ isOpen, onClose, onSuccess, initialMode = "signup" }: AuthModalProps) {
  const { locale } = useLocale();
  const { t } = useTranslation();
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [fullName, setFullName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [primaryTrade, setPrimaryTrade] = useState<ServiceType>("ROOFING");
  const [acceptedLegalTerms, setAcceptedLegalTerms] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setMode(initialMode);
    setError(null);
    setSuccess(null);
    setPasswordVisible(false);
  }, [initialMode, isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setIsLoading(true);

    try {
      if (mode === "forgot") {
        await api.auth.forgotPassword({ email });
        setSuccess(t("auth.resetEmailSentDescription"));
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
          preferredLocale: locale,
          acceptedLegalTerms: true,
          termsVersion: CURRENT_TERMS_VERSION,
          privacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION,
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
      setAcceptedLegalTerms(false);
      onClose();
    } catch (err) {
      setError(localizedApiError(err, t, {
        fallbackKey: mode === "forgot" ? "apiErrors.passwordResetFailed" : "auth.genericError",
        statusKeys:
          mode === "signin"
            ? { 400: "apiErrors.invalidRequest", 401: "apiErrors.invalidCredentials" }
            : mode === "signup"
              ? { 400: "apiErrors.invalidRequest", 409: "apiErrors.accountExists" }
              : { 400: "apiErrors.invalidRequest" },
      }));
    } finally {
      setIsLoading(false);
    }
  };

  const switchMode = (next: AuthMode) => {
    setMode(next);
    setError(null);
    setSuccess(null);
    setPassword("");
    setPasswordVisible(false);
  };

  if (!isOpen) return null;

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      size="md"
      ariaLabel={mode === "signin" ? t("auth.signInAria") : mode === "forgot" ? t("auth.resetPasswordAria") : t("auth.startTrialAria")}
    >
      <ModalHeader
        title={mode === "signin" ? t("auth.welcomeBack") : mode === "forgot" ? t("auth.resetPasswordTitle") : t("auth.startTrialTitle")}
        description={
          mode === "signin"
            ? t("auth.signInDescription")
            : mode === "forgot"
              ? t("auth.resetDescription")
              : t("auth.signupDescription")
        }
        onClose={onClose}
      />

      <ModalBody>
        <form onSubmit={handleSubmit} className="space-y-4">
          <LanguageSelector compact />
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
              {success} {t("auth.resetEmailHelp")}
            </div>
          )}

          {mode === "signup" && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="fullName" className="mb-1.5 block text-sm font-medium text-slate-700">
                    {t("auth.yourName")}
                  </label>
                  <input
                    id="fullName"
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder={t("auth.fullNamePlaceholder")}
                    autoComplete="name"
                    className={inputClass}
                    required
                  />
                </div>
                <div>
                  <label htmlFor="business" className="mb-1.5 block text-sm font-medium text-slate-700">
                    {t("auth.businessName")}
                  </label>
                  <input
                    id="business"
                    type="text"
                    value={businessName}
                    onChange={(e) => setBusinessName(e.target.value)}
                    placeholder={t("auth.businessPlaceholder")}
                    autoComplete="organization"
                    className={inputClass}
                    required
                  />
                </div>
              </div>

              <div>
                <label htmlFor="primaryTrade" className="mb-1.5 block text-sm font-medium text-slate-700">
                  {t("auth.primaryTrade")}
                </label>
                <select
                  id="primaryTrade"
                  value={primaryTrade}
                  onChange={(event) => setPrimaryTrade(event.target.value as ServiceType)}
                  className={inputClass}
                >
                  {TRADE_VALUES.map((trade) => (
                    <option key={trade} value={trade}>
                      {t(TRADE_LABEL_KEYS[trade])}
                    </option>
                  ))}
                </select>
              </div>

              <div className="border-t border-slate-100 pt-4">
                <p className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-400">{t("auth.accountCredentials")}</p>
                <p className="-mt-1 text-xs leading-5 text-slate-500">
                  {t("auth.brandingAfterSignup")}
                </p>
              </div>
            </>
          )}

          <div>
            <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-slate-700">
              {t("auth.emailAddress")}
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("auth.emailPlaceholder")}
              autoComplete={mode === "signup" ? "username" : "email"}
              className={inputClass}
              required
            />
          </div>

          {mode !== "forgot" ? (
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <label htmlFor="password" className="block text-sm font-medium text-slate-700">
                  {t("auth.password")}{" "}
                  {mode === "signup" && (
                    <span className="font-normal text-slate-400">{t("auth.passwordMinimum")}</span>
                  )}
                </label>
                {mode === "signin" ? (
                  <button
                    type="button"
                    onClick={() => switchMode("forgot")}
                    className="min-h-11 text-sm font-semibold text-quotefly-blue transition-colors hover:text-blue-700 sm:min-h-0"
                  >
                    {t("auth.forgotPassword")}
                  </button>
                ) : null}
              </div>
              <div className="relative">
                <input
                  id="password"
                  type={passwordVisible ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === "signin" ? t("auth.enterPassword") : t("auth.choosePasswordPlaceholder")}
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  minLength={mode === "signup" ? 8 : 1}
                  className={`${inputClass} pr-12`}
                  required
                />
                <button
                  type="button"
                  onClick={() => setPasswordVisible((current) => !current)}
                  className="absolute inset-y-0 right-0 inline-flex w-11 items-center justify-center rounded-r-lg text-slate-500 transition hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-quotefly-blue"
                  aria-label={passwordVisible ? t("auth.hidePassword") : t("auth.showPassword")}
                  aria-pressed={passwordVisible}
                >
                  {passwordVisible ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
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
                {t("auth.legalAgree")}{" "}
                <Link
                  to="/terms"
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-quotefly-blue hover:text-blue-700"
                >
                  {t("auth.termsOfService")}
                </Link>{" "}
                {t("auth.legalAcknowledge")}{" "}
                <Link
                  to="/privacy"
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-quotefly-blue hover:text-blue-700"
                >
                  {t("auth.privacyPolicy")}
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
              ? t("auth.pleaseWait")
              : mode === "signin"
                ? t("auth.signIn")
                : mode === "forgot"
                  ? success
                    ? t("auth.resetLinkSent")
                    : t("auth.sendResetLink")
                  : t("auth.createAccount")}
          </Button>

          <p className="text-center text-sm text-slate-500">
            {mode === "forgot" ? (
              <>
                {t("auth.rememberPassword")}{" "}
                <button
                  type="button"
                  onClick={() => switchMode("signin")}
                  className="min-h-11 font-medium text-quotefly-blue transition-colors hover:text-blue-700 sm:min-h-0"
                >
                  {t("auth.backToSignIn")}
                </button>
              </>
            ) : mode === "signin" ? (
              <>
                {t("auth.noAccount")}{" "}
                <button
                  type="button"
                  onClick={() => switchMode("signup")}
                  className="inline-flex min-h-11 items-center font-medium text-quotefly-blue transition-colors hover:text-blue-700"
                >
                  {t("auth.startFreeTrial")}
                </button>
              </>
            ) : (
              <>
                {t("auth.haveAccount")}{" "}
                <button
                  type="button"
                  onClick={() => switchMode("signin")}
                  className="inline-flex min-h-11 items-center font-medium text-quotefly-blue transition-colors hover:text-blue-700"
                >
                  {t("auth.signIn")}
                </button>
              </>
            )}
          </p>
        </form>
      </ModalBody>

      <ModalFooter className="justify-center bg-slate-50 text-center text-xs text-slate-400">
        <p>
          {t("auth.trialLength", { days: BASIC_PLAN.trialDays })} &middot; {t("auth.firstPaidMonth", { price: formatUsd(locale, BASIC_PLAN.firstPaidMonthPriceUsd) })} &middot;{" "}
          <Link to="/terms" onClick={onClose} className="text-quotefly-blue hover:text-blue-700">
            {t("auth.terms")}
          </Link>{" "}
          &amp;{" "}
          <Link to="/privacy" onClick={onClose} className="text-quotefly-blue hover:text-blue-700">
            {t("auth.privacy")}
          </Link>
        </p>
      </ModalFooter>
    </Modal>
  );
}
