import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  getStoredCookieConsent,
  setStoredCookieConsent,
  type CookieConsentChoice,
} from "../lib/cookie-consent";

export function CookieConsentBanner() {
  const [choice, setChoice] = useState<CookieConsentChoice | null>(null);

  useEffect(() => {
    setChoice(getStoredCookieConsent());
  }, []);

  if (choice !== null) return null;

  function handleChoice(nextChoice: CookieConsentChoice) {
    setStoredCookieConsent(nextChoice);
    setChoice(nextChoice);
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-slate-200 bg-white/98 p-4 shadow-[0_-10px_30px_rgba(15,23,42,0.12)] backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-3xl">
          <p className="text-sm font-semibold text-slate-900">Cookie preferences</p>
          <p className="mt-1 text-sm text-slate-600">
            QuoteFly uses essential cookies for sign-in, security, and saved preferences. Optional analytics cookies help us improve the product.
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
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => handleChoice("essential")}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
          >
            Essential only
          </button>
          <button
            type="button"
            onClick={() => handleChoice("accepted")}
            className="rounded-lg bg-quotefly-blue px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700"
          >
            Accept analytics
          </button>
        </div>
      </div>
    </div>
  );
}
