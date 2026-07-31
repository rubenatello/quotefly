import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  getStoredCookieConsent,
  setStoredCookieConsent,
  subscribeToCookieConsent,
  type CookieConsentChoice,
} from "../lib/cookie-consent";

export function CookieConsentBanner() {
  const [choice, setChoice] = useState<CookieConsentChoice | null>(() => getStoredCookieConsent());

  useEffect(() => subscribeToCookieConsent(() => setChoice(getStoredCookieConsent())), []);

  if (choice !== null) return null;

  function handleChoice(nextChoice: CookieConsentChoice) {
    setStoredCookieConsent(nextChoice);
    setChoice(nextChoice);
  }

  return (
    <aside
      aria-label="Cookie preferences"
      className="fixed inset-x-0 bottom-0 z-[70] max-h-[min(85dvh,36rem)] overflow-y-auto border-t border-slate-200 bg-white/98 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4 shadow-[0_-10px_30px_rgba(15,23,42,0.12)] backdrop-blur"
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-3xl">
          <p className="text-sm font-semibold text-slate-900">Cookie preferences</p>
          <p className="mt-1 text-sm text-slate-600">
            QuoteFly uses essential cookies and browser storage for sign-in, security, and saved preferences. Optional analytics technologies are disabled unless you opt in.
            Read our{" "}
            <Link to="/cookies" className="font-medium text-quotefly-blue hover:text-blue-700">
              Cookie Policy
            </Link>{" "}
            and{" "}
            <Link to="/privacy" className="font-medium text-quotefly-blue hover:text-blue-700">
              Privacy Policy
            </Link>.
          </p>
        </div>
        <div className="grid shrink-0 gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => handleChoice("essential")}
            className="min-h-11 rounded-lg bg-slate-800 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-800"
          >
            Essential only
          </button>
          <button
            type="button"
            onClick={() => handleChoice("accepted")}
            className="min-h-11 rounded-lg bg-quotefly-blue px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-quotefly-blue"
          >
            Accept analytics
          </button>
        </div>
      </div>
    </aside>
  );
}
