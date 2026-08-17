import { useEffect, useState } from "react";
import { Cookie } from "lucide-react";
import { PolicyPageLayout, PolicySection } from "../components/marketing/PublicPageLayout";
import { CURRENT_PRIVACY_POLICY_UPDATED_LABEL } from "../lib/legal";
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
    <PolicyPageLayout
      eyebrow="Cookie Policy"
      title="How cookies work on QuoteFly"
      description="QuoteFly uses a small number of cookies and browser storage items to keep the website and application working. Optional analytics technologies remain off unless you choose to enable them."
      updated={CURRENT_PRIVACY_POLICY_UPDATED_LABEL}
      icon={Cookie}
    >
        <PolicySection title="Types of cookies and storage we use">
          <div className="mt-5 overflow-x-auto rounded-2xl border border-slate-200">
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
                  <td className="px-4 py-3 font-medium text-slate-900">UI preferences</td>
                  <td className="px-4 py-3">Essential local storage</td>
                  <td className="px-4 py-3">Remembers workspace display preferences on this device.</td>
                  <td className="px-4 py-3">Until cleared</td>
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
          <p className="mt-3 text-sm text-slate-600">
            In-progress quote recovery drafts are stored securely in the authenticated QuoteFly workspace for up to 12 hours. QuoteFly does not store their contents in browser local or session storage.
          </p>
        </PolicySection>

        <PolicySection title="Your current preference" tone="accent">
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
              className="min-h-12 rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-slate-300/60"
            >
              Use essential only
            </button>
            <button
              type="button"
              onClick={() => updateChoice("accepted")}
              className="min-h-12 rounded-xl bg-quotefly-blue px-5 py-3 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(47,111,214,0.2)] transition hover:-translate-y-0.5 hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-quotefly-blue/20"
            >
              Accept analytics
            </button>
            <button
              type="button"
              onClick={resetChoice}
              className="min-h-12 rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:-translate-y-0.5 hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-slate-300/60"
            >
              Ask me again
            </button>
          </div>
        </PolicySection>
    </PolicyPageLayout>
  );
}
