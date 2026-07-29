import { useEffect } from "react";
import { Headphones, Mail } from "lucide-react";
import { INFO_EMAIL, INFO_MAILTO, SUPPORT_EMAIL, SUPPORT_MAILTO } from "../lib/contact";
import { setPublicSEOMetadata } from "../lib/seo";

interface SupportPageProps {
  onOpenAuth: () => void;
}

export function SupportPage({ onOpenAuth }: SupportPageProps) {
  useEffect(() => {
    setPublicSEOMetadata("/support");
  }, []);

  const supportAreas = [
    {
      title: "Account and billing help",
      text: "Plan changes, Stripe billing issues, seat limits, and workspace access questions.",
    },
    {
      title: "Quote workflow help",
      text: "Customer setup, quote drafting, template questions, PDF output, and day-to-day quoting workflow questions.",
    },
    {
      title: "Technical troubleshooting",
      text: "Login issues, browser problems, mobile layout bugs, and performance concerns.",
    },
  ];

  const checklist = [
    "Your company name and workspace email",
    "A short summary of the issue",
    "Screenshots or screen recording when relevant",
    "The page or action where the issue happened",
    "Whether it happened on desktop or mobile",
  ];

  return (
    <div className="min-h-screen bg-stone-50 text-slate-900">
      <section className="px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <h1 className="mb-4 text-4xl font-bold text-slate-900 sm:text-5xl">Support</h1>
          <p className="text-lg text-slate-600">
            When something blocks your workflow, we want the next step to be obvious.
          </p>
        </div>
      </section>

      <section className="px-4 py-8 sm:px-6 lg:px-8">
        <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-6">
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-2xl font-bold text-slate-900">Contact support</h2>
              <p className="mt-3 text-slate-600">
                Send account, billing, workflow, or technical issues to {SUPPORT_EMAIL}. The email shortcut includes a
                checklist so we can reproduce the issue quickly.
              </p>
              <a
                href={SUPPORT_MAILTO}
                className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-quotefly-blue px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-quotefly-blue sm:w-auto"
              >
                <Headphones size={18} aria-hidden="true" />
                Email support
              </a>
              <p className="mt-3 text-sm text-slate-500">
                V1 support is email-first. We are optimizing for fast, clear responses before we add more channels.
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-xl font-semibold text-slate-900">Sales and general inquiries</h2>
              <p className="mt-3 text-sm text-slate-600">
                Questions about plans, fit, partnerships, or QuoteFly before signing up? Contact {INFO_EMAIL}.
              </p>
              <a
                href={INFO_MAILTO}
                className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-800 transition hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-quotefly-blue sm:w-auto"
              >
                <Mail size={18} aria-hidden="true" />
                Email sales
              </a>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              {supportAreas.map((area) => (
                <div key={area.title} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h3 className="text-lg font-semibold text-slate-900">{area.title}</h3>
                  <p className="mt-2 text-sm text-slate-600">{area.text}</p>
                </div>
              ))}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-xl font-semibold text-slate-900">Before you email us</h2>
              <ul className="mt-4 space-y-3 text-sm text-slate-600">
                {checklist.map((item) => (
                  <li key={item} className="flex gap-3">
                    <span className="text-quotefly-blue">+</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-xl font-semibold text-slate-900">Controlled beta support</h2>
              <p className="mt-4 text-sm leading-6 text-slate-600">
                Support is currently email-first. Include the affected page, device, and steps to reproduce so the team can investigate efficiently. Formal tier-based service levels are not offered during the controlled beta.
              </p>
            </div>

            <div className="rounded-2xl border border-blue-200 bg-blue-50 p-6">
              <h2 className="text-xl font-semibold text-slate-900">New to QuoteFly?</h2>
              <p className="mt-3 text-sm text-slate-700">
                The fastest way to evaluate the product is to create a workspace, add one customer, draft one quote, and export one invoice CSV. That shows the real workflow immediately.
              </p>
              <button
                onClick={onOpenAuth}
                className="mt-4 rounded-lg bg-quotefly-blue px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700"
              >
                Start Free Trial
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
