import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CheckCircle2, KeyRound, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "../components/ui";
import { api, ApiError } from "../lib/api";

interface ResetPasswordPageProps {
  onOpenSignIn: () => void;
}

const inputClass =
  "w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 placeholder-slate-400 transition focus:border-quotefly-blue focus:outline-none focus:ring-4 focus:ring-quotefly-blue/15";

export function ResetPasswordPage({ onOpenSignIn }: ResetPasswordPageProps) {
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
    document.title = "Reset your password | QuoteFly";
    const robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const previousRobots = robots?.content;
    if (robots) robots.content = "noindex,nofollow";

    return () => {
      if (robots && previousRobots) robots.content = previousRobots;
    };
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!token) {
      setError("This reset link is missing its security token. Request a new link from the sign-in screen.");
      return;
    }

    if (password !== confirmPassword) {
      setError("The passwords do not match.");
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
      setError(err instanceof ApiError ? err.message : "We could not reset your password. Please request a new link.");
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
            Secure account recovery
          </div>
          <h1 className="mt-6 max-w-lg font-display text-4xl font-semibold tracking-[-0.045em] text-slate-950 xl:text-5xl">
            Get back to quoting without the runaround.
          </h1>
          <p className="mt-5 max-w-md text-lg leading-8 text-slate-600">
            Choose a new password, then sign in normally. The reset link works once and automatically signs out older sessions.
          </p>
          <div className="mt-8 space-y-3 text-sm text-slate-600">
            <p className="flex items-center gap-3"><CheckCircle2 className="text-quotefly-blue" size={19} /> Single-use recovery link</p>
            <p className="flex items-center gap-3"><CheckCircle2 className="text-quotefly-blue" size={19} /> Existing sessions are revoked</p>
            <p className="flex items-center gap-3"><CheckCircle2 className="text-quotefly-blue" size={19} /> Your password is never sent by email</p>
          </div>
        </div>

        <div className="mx-auto w-full max-w-xl rounded-[28px] border border-slate-200 bg-white p-6 shadow-[0_28px_70px_rgba(15,23,42,0.12)] sm:p-9">
          {isComplete ? (
            <div className="py-3 text-center">
              <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50 text-quotefly-blue">
                <CheckCircle2 size={30} aria-hidden="true" />
              </span>
              <h1 className="mt-5 font-display text-3xl font-semibold tracking-tight text-slate-950">Password updated</h1>
              <p className="mx-auto mt-3 max-w-sm leading-7 text-slate-600">
                Your previous QuoteFly sessions have been signed out. Sign in with your new password to continue.
              </p>
              <Button type="button" size="lg" fullWidth className="mt-7" onClick={onOpenSignIn}>
                Sign in to QuoteFly
              </Button>
            </div>
          ) : (
            <>
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-50 text-quotefly-blue">
                <KeyRound size={25} aria-hidden="true" />
              </span>
              <h1 className="mt-5 font-display text-3xl font-semibold tracking-tight text-slate-950">Choose a new password</h1>
              <p className="mt-2 leading-7 text-slate-600">Use at least 8 characters and something you do not use for another account.</p>

              {!token ? (
                <div role="alert" className="mt-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
                  This reset link is incomplete. Open the full link from your email or request a new one from sign in.
                </div>
              ) : null}

              {error ? (
                <div role="alert" className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-6 text-red-700">
                  {error}
                </div>
              ) : null}

              <form onSubmit={handleSubmit} className="mt-7 space-y-5">
                <div>
                  <label htmlFor="new-password" className="mb-2 block text-sm font-semibold text-slate-700">New password</label>
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
                  <label htmlFor="confirm-password" className="mb-2 block text-sm font-semibold text-slate-700">Confirm new password</label>
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
                  Update password
                </Button>
              </form>

              <div className="mt-6 text-center">
                <Link to="/" className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-slate-600 transition hover:text-quotefly-blue">
                  <ArrowLeft size={16} aria-hidden="true" /> Back to QuoteFly
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
