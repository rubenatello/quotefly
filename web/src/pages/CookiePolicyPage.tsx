import { useEffect, useState } from "react";
import { setSEOMetadata } from "../lib/seo";
import {
  clearStoredCookieConsent,
  getStoredCookieConsent,
  setStoredCookieConsent,
  type CookieConsentChoice,
} from "../lib/cookie-consent";

export function CookiePolicyPage() {
  const [choice, setChoice] = useState<CookieConsentChoice | null>(null);

  useEffect(() => {
    setSEOMetadata({
      title: "Cookie Policy - QuoteFly",
      description: "Review QuoteFly's use of essential cookies and optional analytics cookies.",
    });
    setChoice(getStoredCookieConsent());
  }, []);

  function updateChoice(nextChoice: CookieConsentChoice) {
    setStoredCookieConsent(nextChoice);
    setChoice(nextChoice);
  }

  function resetChoice() {
    clearStoredCookieConsent();
    setChoice(null);
  }

  return (
    <div className="min-h-screen bg-stone-50 px-4 py-16 text-slate-900 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl space-y-8">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-wide text-quotefly-blue">Cookie Policy</p>
          <h1 className="mt-2 text-4xl font-bold text-slate-900">How cookies work on QuoteFly</h1>
          <p className="mt-3 text-sm text-slate-500">Last updated: April 10, 2026</p>
          <p className="mt-4 text-slate-600">
            QuoteFly uses a small number of browser storage items and cookies to keep the website and application working.
          </p>
        </div>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-2xl font-semibold text-slate-900">Types of cookies and storage we use</h2>
          <div className="mt-4 space-y-4 text-sm text-slate-600">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="font-semibold text-slate-900">Essential cookies and storage</p>
              <p className="mt-1">
                Used for sign-in state, security, saved UI preferences, and core application behavior.
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="font-semibold text-slate-900">Optional analytics cookies</p>
              <p className="mt-1">
                Used only if you opt in. These help us understand page usage and product behavior so we can improve the experience.
              </p>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-2xl font-semibold text-slate-900">Your current preference</h2>
          <p className="mt-3 text-sm text-slate-600">
            Current setting:{" "}
            <span className="font-semibold text-slate-900">
              {choice === "accepted" ? "Analytics accepted" : choice === "essential" ? "Essential only" : "No choice saved yet"}
            </span>
          </p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={() => updateChoice("essential")}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
            >
              Use essential only
            </button>
            <button
              type="button"
              onClick={() => updateChoice("accepted")}
              className="rounded-lg bg-quotefly-blue px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700"
            >
              Accept analytics
            </button>
            <button
              type="button"
              onClick={resetChoice}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
            >
              Reset choice
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
