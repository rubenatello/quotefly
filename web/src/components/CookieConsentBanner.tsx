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
      className="fixed inset-x-0 bottom-0 z-[70] max-h-[min(72dvh,32rem)] overflow-y-auto border-t border-slate-200 bg-white/98 px-4 pb-[calc(0.625rem+env(safe-area-inset-bottom))] pt-2.5 shadow-[0_-10px_30px_rgba(15,23,42,0.12)] backdrop-blur sm:pb-[calc(0.875rem+env(safe-area-inset-bottom))] sm:pt-3.5"
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
        <div className="max-w-3xl">
          <p className="text-sm font-semibold text-slate-900">Your privacy choices</p>
          <p className="mt-0.5 text-xs leading-5 text-slate-600 sm:text-sm">
            Essential storage keeps QuoteFly working. Optional analytics stay off unless you allow them. Learn more in our{" "}
            <Link to="/cookies" className="font-medium text-quotefly-blue hover:text-blue-700">
              privacy choices
            </Link>.
          </p>
        </div>
        <div className="grid w-full shrink-0 grid-cols-2 gap-2 sm:w-auto">
          <button
            type="button"
            onClick={() => handleChoice("essential")}
            className="min-h-11 rounded-lg bg-slate-800 px-3 py-2.5 text-xs font-semibold text-white transition hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-800 sm:px-4 sm:text-sm"
          >
            Essential only
          </button>
          <button
            type="button"
            onClick={() => handleChoice("accepted")}
            className="min-h-11 rounded-lg bg-quotefly-blue px-3 py-2.5 text-xs font-semibold text-white transition hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-quotefly-blue sm:px-4 sm:text-sm"
          >
            Accept analytics
          </button>
        </div>
      </div>
    </aside>
  );
}
