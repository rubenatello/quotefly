import { Link } from "react-router-dom";
import { INFO_EMAIL, INFO_MAILTO, SUPPORT_EMAIL, SUPPORT_MAILTO } from "../lib/contact";

const PRODUCT_LINKS = [
  { label: "Services", to: "/services" },
  { label: "Pricing", to: "/pricing" },
  { label: "Solutions", to: "/solutions" },
  { label: "About", to: "/about" },
  { label: "Support", to: "/support" },
];

const INDUSTRY_LINKS = [
  { label: "HVAC", to: "/solutions/hvac" },
  { label: "Plumbing", to: "/solutions/plumbing" },
  { label: "Flooring", to: "/solutions/flooring" },
  { label: "Roofing", to: "/solutions/roofing" },
  { label: "Landscaping", to: "/solutions/landscaping" },
  { label: "Construction", to: "/solutions/construction" },
];

const LEGAL_LINKS = [
  { label: "Terms", to: "/terms" },
  { label: "Privacy", to: "/privacy" },
  { label: "Data Privacy", to: "/data-privacy" },
  { label: "Cookie Policy", to: "/cookies" },
];

export function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="border-t border-slate-200 bg-white px-4 py-12 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-[1.45fr_0.8fr_1.1fr_1fr]">
          <div className="max-w-md">
            <img src="/logo.png" alt="QuoteFly" className="h-9 w-auto" />
            <p className="mt-3 text-sm text-slate-600">
              QuoteFly helps contractors add leads, build quotes, and send branded PDFs from one clean, mobile-first CRM.
            </p>
            <div className="mt-4 space-y-1 text-sm text-slate-600">
              <p>
                Support:{" "}
                <a href={SUPPORT_MAILTO} className="font-medium text-quotefly-blue hover:text-blue-700">
                  {SUPPORT_EMAIL}
                </a>
              </p>
              <p>
                Sales &amp; inquiries:{" "}
                <a href={INFO_MAILTO} className="font-medium text-quotefly-blue hover:text-blue-700">
                  {INFO_EMAIL}
                </a>
              </p>
              <p>Headquarters: United States</p>
            </div>
          </div>

          <div>
            <h2 className="font-semibold text-slate-900">Product</h2>
            <ul className="mt-4 space-y-2 text-sm text-slate-600">
              {PRODUCT_LINKS.map((link) => (
                <li key={link.to}>
                  <Link to={link.to} className="transition-colors hover:text-slate-900">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h2 className="font-semibold text-slate-900">Industries</h2>
            <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm text-slate-600 lg:grid-cols-1">
              {INDUSTRY_LINKS.map((link) => (
                <li key={link.to}>
                  <Link to={link.to} className="transition-colors hover:text-slate-900">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h2 className="font-semibold text-slate-900">Legal and privacy</h2>
            <ul className="mt-4 space-y-2 text-sm text-slate-600">
              {LEGAL_LINKS.map((link) => (
                <li key={link.to}>
                  <Link to={link.to} className="transition-colors hover:text-slate-900">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-8 border-t border-slate-200 pt-8 text-center text-sm text-slate-500">
          <p>&copy; {currentYear} QuoteFly. All rights reserved. You can change optional analytics choices at any time in Cookie Policy.</p>
        </div>
      </div>
    </footer>
  );
}
