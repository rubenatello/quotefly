import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CheckCircle2, KeyRound, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { LanguageSelector } from "../components/settings/LanguageSelector";
import { Button } from "../components/ui";
import { api } from "../lib/api";
import { localizedApiError } from "../lib/localized-api-error";

interface ResetPasswordPageProps {
  onOpenSignIn: () => void;
}

const inputClass =
  "w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 placeholder-slate-400 transition focus:border-quotefly-blue focus:outline-none focus:ring-4 focus:ring-quotefly-blue/15";

export function ResetPasswordPage({ onOpenSignIn }: ResetPasswordPageProps) {
  const { t } = useTranslation();
  const token = useMemo(() => {
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    return hashParams.get("token")?.trim() ?? "";
  }, []);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isComplete, setIsComplete] = useState(false);

  useEffect(() => {
    document.title = t("auth.reset.documentTitle");
    const robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const previousRobots = robots?.content;
    if (robots) robots.content = "noindex,nofollow";

    return () => {
      if (robots && previousRobots) robots.content = previousRobots;
    };
  }, [t]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!token) {
      setError(t("auth.reset.missingToken"));
      return;
    }

    if (password !== confirmPassword) {
      setError(t("auth.reset.passwordsMismatch"));
      return;
    }

    setIsLoading(true);
    try {
      await api.auth.resetPassword({ token, password });
      window.history.replaceState({}, "", "/reset-password");
      setPassword("");
      setConfirmPassword("");
      setIsComplete(true);
    } catch (err) {
      setError(localizedApiError(err, t, {
        fallbackKey: "auth.reset.failed",
        statusKeys: { 400: "auth.reset.invalidOrExpired" },
      }));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="relative overflow-hidden bg-[#f7f4ee] px-4 py-14 sm:px-6 sm:py-20 lg:px-8">
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div className="absolute -left-24 top-10 h-64 w-64 rounded-full bg-blue-200/35 blur-3xl" />
        <div className="absolute -right-20 bottom-0 h-72 w-72 rounded-full bg-orange-200/35 blur-3xl" />
      </div>

      <div className="relative mx-auto grid max-w-5xl items-center gap-8 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="hidden lg:block">
          <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-white/80 px-4 py-2 text-sm font-semibold text-quotefly-blue shadow-sm">
            <ShieldCheck size={17} aria-hidden="true" />
            {t("auth.reset.secureRecovery")}
          </div>
          <h1 className="mt-6 max-w-lg font-display text-4xl font-semibold tracking-[-0.045em] text-slate-950 xl:text-5xl">
            {t("auth.reset.heroTitle")}
          </h1>
          <p className="mt-5 max-w-md text-lg leading-8 text-slate-600">
            {t("auth.reset.heroDescription")}
          </p>
          <div className="mt-8 space-y-3 text-sm text-slate-600">
            <p className="flex items-center gap-3"><CheckCircle2 className="text-quotefly-blue" size={19} /> {t("auth.reset.singleUse")}</p>
            <p className="flex items-center gap-3"><CheckCircle2 className="text-quotefly-blue" size={19} /> {t("auth.reset.sessionsRevoked")}</p>
            <p className="flex items-center gap-3"><CheckCircle2 className="text-quotefly-blue" size={19} /> {t("auth.reset.neverEmailed")}</p>
          </div>
        </div>

        <div className="mx-auto w-full max-w-xl rounded-[28px] border border-slate-200 bg-white p-6 shadow-[0_28px_70px_rgba(15,23,42,0.12)] sm:p-9">
          <LanguageSelector compact className="mb-6" />
          {isComplete ? (
            <div className="py-3 text-center">
              <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50 text-quotefly-blue">
                <CheckCircle2 size={30} aria-hidden="true" />
              </span>
              <h1 className="mt-5 font-display text-3xl font-semibold tracking-tight text-slate-950">{t("auth.reset.passwordUpdated")}</h1>
              <p className="mx-auto mt-3 max-w-sm leading-7 text-slate-600">
                {t("auth.reset.successDescription")}
              </p>
              <Button type="button" size="lg" fullWidth className="mt-7" onClick={onOpenSignIn}>
                {t("auth.reset.signInToQuoteFly")}
              </Button>
            </div>
          ) : (
            <>
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-50 text-quotefly-blue">
                <KeyRound size={25} aria-hidden="true" />
              </span>
              <h1 className="mt-5 font-display text-3xl font-semibold tracking-tight text-slate-950">{t("auth.reset.chooseNewPassword")}</h1>
              <p className="mt-2 leading-7 text-slate-600">{t("auth.reset.passwordHelp")}</p>

              {!token ? (
                <div role="alert" className="mt-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
                  {t("auth.reset.incompleteLink")}
                </div>
              ) : null}

              {error ? (
                <div role="alert" className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-6 text-red-700">
                  {error}
                </div>
              ) : null}

              <form onSubmit={handleSubmit} className="mt-7 space-y-5">
                <div>
                  <label htmlFor="new-password" className="mb-2 block text-sm font-semibold text-slate-700">{t("auth.reset.newPassword")}</label>
                  <input
                    id="new-password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="new-password"
                    minLength={8}
                    maxLength={120}
                    className={inputClass}
                    required
                  />
                </div>
                <div>
                  <label htmlFor="confirm-password" className="mb-2 block text-sm font-semibold text-slate-700">{t("auth.reset.confirmPassword")}</label>
                  <input
                    id="confirm-password"
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    autoComplete="new-password"
                    minLength={8}
                    maxLength={120}
                    className={inputClass}
                    required
                  />
                </div>
                <Button type="submit" size="lg" fullWidth loading={isLoading} disabled={!token}>
                  {t("auth.reset.updatePassword")}
                </Button>
              </form>

              <div className="mt-6 text-center">
                <Link to="/" className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-slate-600 transition hover:text-quotefly-blue">
                  <ArrowLeft size={16} aria-hidden="true" /> {t("auth.reset.backToQuoteFly")}
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
