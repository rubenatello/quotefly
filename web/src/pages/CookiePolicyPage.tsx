import { useEffect, useState } from "react";
import { setPublicSEOMetadata } from "../lib/seo";
import {
  clearStoredCookieConsent,
  getStoredCookieConsent,
  getStoredCookieConsentRecord,
  setStoredCookieConsent,
  subscribeToCookieConsent,
  type CookieConsentChoice,
} from "../lib/cookie-consent";

export function CookiePolicyPage() {
  const [choice, setChoice] = useState<CookieConsentChoice | null>(() => getStoredCookieConsent());
  const [expiresAtUtc, setExpiresAtUtc] = useState<string | null>(
    () => getStoredCookieConsentRecord()?.expiresAtUtc ?? null,
  );

  useEffect(() => {
    setPublicSEOMetadata("/cookies");
  }, []);

  useEffect(
    () => subscribeToCookieConsent(() => {
      const record = getStoredCookieConsentRecord();
      setChoice(record?.choice ?? null);
      setExpiresAtUtc(record?.expiresAtUtc ?? null);
    }),
    [],
  );

  function updateChoice(nextChoice: CookieConsentChoice) {
    setStoredCookieConsent(nextChoice);
  }

  function resetChoice() {
    clearStoredCookieConsent();
  }

  return (
    <div className="min-h-screen bg-stone-50 px-4 py-16 text-slate-900 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl space-y-8">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-wide text-quotefly-blue">Cookie Policy</p>
          <h1 className="mt-2 text-4xl font-bold text-slate-900">How cookies work on QuoteFly</h1>
          <p className="mt-3 text-sm text-slate-500">Last updated: July 30, 2026</p>
          <p className="mt-4 text-slate-600">
            QuoteFly uses a small number of cookies and browser storage items to keep the website and application working. Optional analytics technologies remain off unless you choose to enable them.
          </p>
        </div>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-2xl font-semibold text-slate-900">Types of cookies and storage we use</h2>
          <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-[42rem] w-full text-left text-sm text-slate-600">
              <thead className="bg-slate-50 text-slate-900">
                <tr>
                  <th className="px-4 py-3 font-semibold">Name</th>
                  <th className="px-4 py-3 font-semibold">Type</th>
                  <th className="px-4 py-3 font-semibold">Purpose</th>
                  <th className="px-4 py-3 font-semibold">Typical duration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white align-top">
                <tr>
                  <td className="px-4 py-3 font-medium text-slate-900">qf_session</td>
                  <td className="px-4 py-3">Essential HttpOnly cookie</td>
                  <td className="px-4 py-3">Keeps an authenticated account signed in and protects the browser session.</td>
                  <td className="px-4 py-3">7 days, or until sign-out</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-slate-900">qf_cookie_consent</td>
                  <td className="px-4 py-3">Essential local storage</td>
                  <td className="px-4 py-3">Stores the selected cookie preference, consent version, and choice dates.</td>
                  <td className="px-4 py-3">180 days</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-slate-900">Quote draft and UI preferences</td>
                  <td className="px-4 py-3">Essential local/session storage</td>
                  <td className="px-4 py-3">Recovers in-progress quote work and remembers workspace display preferences.</td>
                  <td className="px-4 py-3">Drafts: current tab; preferences: until cleared</td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-slate-900">Optional analytics</td>
                  <td className="px-4 py-3">Optional technology</td>
                  <td className="px-4 py-3">May measure page and feature usage after opt-in. QuoteFly does not currently send the in-app analytics buffer to an external analytics endpoint.</td>
                  <td className="px-4 py-3">Only while consent is active</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-sm text-slate-600">
            An organization may configure a different session-cookie name for its deployment. Essential storage is not used for advertising.
          </p>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-2xl font-semibold text-slate-900">Your current preference</h2>
          <p className="mt-3 text-sm text-slate-600">
            Current setting:{" "}
            <span className="font-semibold text-slate-900">
              {choice === "accepted" ? "Analytics accepted" : choice === "essential" ? "Essential only" : "No choice saved yet"}
            </span>
          </p>
          {expiresAtUtc ? (
            <p className="mt-2 text-xs text-slate-500">
              This choice will be requested again after {new Date(expiresAtUtc).toLocaleDateString()} or when the consent version changes.
            </p>
          ) : null}
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={() => updateChoice("essential")}
              className="min-h-11 rounded-lg bg-slate-800 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-800"
            >
              Use essential only
            </button>
            <button
              type="button"
              onClick={() => updateChoice("accepted")}
              className="min-h-11 rounded-lg bg-quotefly-blue px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-quotefly-blue"
            >
              Accept analytics
            </button>
            <button
              type="button"
              onClick={resetChoice}
              className="min-h-11 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700"
            >
              Ask me again
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
