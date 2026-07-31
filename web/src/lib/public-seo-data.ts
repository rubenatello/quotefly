export const PUBLIC_SITE_URL = "https://www.quotefly.us";
export const PUBLIC_OG_IMAGE_URL = `${PUBLIC_SITE_URL}/og-image.jpg`;

export const PUBLIC_BASIC_PLAN = {
  name: "Basic",
  monthlyPriceUsd: 19,
  trialDays: 14,
} as const;

export const PUBLIC_ROUTE_PATHS = [
  "/",
  "/pricing",
  "/services",
  "/solutions",
  "/about",
  "/support",
  "/privacy",
  "/data-privacy",
  "/terms",
  "/cookies",
] as const;

export type PublicRoutePath = (typeof PUBLIC_ROUTE_PATHS)[number];

export type PublicRouteSeo = {
  path: PublicRoutePath;
  title: string;
  description: string;
  heading: string;
  summary: string;
  schemaType: "WebPage" | "AboutPage" | "ContactPage" | "CollectionPage" | "SoftwareApplication";
};

export const PUBLIC_ROUTE_SEO: Record<PublicRoutePath, PublicRouteSeo> = {
  "/": {
    path: "/",
    title: "Easy Quoting Software for Contractors | QuoteFly",
    description:
      "The easiest quoting software for on-the-go contractors and professionals. Manage customers, build estimates, create branded PDFs, and follow up from any device.",
    heading: "The easiest quoting software for on-the-go contractors and professionals",
    summary:
      "Manage a customer, price the work, review the customer-facing quote, and share a branded PDF from one clean mobile workflow.",
    schemaType: "SoftwareApplication",
  },
  "/pricing": {
    path: "/pricing",
    title: "Contractor Quoting Software Pricing | QuoteFly",
    description:
      `QuoteFly Basic costs $${PUBLIC_BASIC_PLAN.monthlyPriceUsd} per month after a ${PUBLIC_BASIC_PLAN.trialDays}-day trial. Review the current contractor CRM, estimating, and PDF quote features.`,
    heading: "Contractor quoting software pricing",
    summary:
      "Start with the current Basic plan for customer intake, quote creation, branded PDFs, and quote tracking.",
    schemaType: "SoftwareApplication",
  },
  "/services": {
    path: "/services",
    title: "Customer Management and Quoting Services | QuoteFly",
    description:
      "Explore QuoteFly customer management, estimates, branded quote PDFs, sharing, follow-up, and pipeline analytics for small contractors.",
    heading: "Customer management and quoting services in one simple app",
    summary:
      "Move from customer intake to a reviewed estimate, branded quote PDF, and practical follow-up in one mobile-friendly service.",
    schemaType: "CollectionPage",
  },
  "/solutions": {
    path: "/solutions",
    title: "Quoting Solutions for Contractors by Trade | QuoteFly",
    description:
      "See how QuoteFly solves customer, estimating, pricing, PDF, and follow-up problems for HVAC, plumbing, flooring, roofing, landscaping, and construction teams.",
    heading: "Built for the work. Not the paperwork.",
    summary:
      "Turn fresh job details into clear customer quotes with one mobile workflow for customer records, pricing, branded PDFs, and follow-up.",
    schemaType: "CollectionPage",
  },
  "/about": {
    path: "/about",
    title: "About QuoteFly | Contractor Quoting Software",
    description:
      "Learn why QuoteFly is being built as a focused quoting and lightweight CRM tool for contractors who work from the field.",
    heading: "Built for contractors who move fast",
    summary:
      "QuoteFly is focused on reducing the time between a new customer request, a clear estimate, and practical follow-up.",
    schemaType: "AboutPage",
  },
  "/support": {
    path: "/support",
    title: "QuoteFly Support",
    description:
      "Contact QuoteFly for help with account access, billing, customer setup, quote workflows, PDFs, and mobile or browser issues.",
    heading: "QuoteFly support",
    summary:
      "Email the QuoteFly team with the workspace, page, device, and steps involved so the issue can be investigated efficiently.",
    schemaType: "ContactPage",
  },
  "/privacy": {
    path: "/privacy",
    title: "Privacy Policy | QuoteFly",
    description:
      "Review the information QuoteFly collects, how it is used, how service providers are involved, and how to request privacy assistance.",
    heading: "How QuoteFly handles personal data",
    summary:
      "This policy explains the account, customer, quote, operational, and billing information used to provide QuoteFly.",
    schemaType: "WebPage",
  },
  "/data-privacy": {
    path: "/data-privacy",
    title: "Data Privacy and Security | QuoteFly",
    description:
      "Review QuoteFly's approach to tenant separation, access controls, hosted infrastructure, data exports, and security reporting.",
    heading: "Data handling and security posture",
    summary:
      "QuoteFly uses tenant-scoped application controls and hosted providers while continuing to improve operational security practices.",
    schemaType: "WebPage",
  },
  "/terms": {
    path: "/terms",
    title: "Terms of Service | QuoteFly",
    description:
      "Review the terms for QuoteFly accounts, workspace responsibilities, acceptable use, billing, service availability, and termination.",
    heading: "Using QuoteFly",
    summary:
      "These terms explain the responsibilities that apply when creating an account and operating a QuoteFly workspace.",
    schemaType: "WebPage",
  },
  "/cookies": {
    path: "/cookies",
    title: "Cookie Policy | QuoteFly",
    description:
      "Review how QuoteFly uses essential browser storage and optional analytics choices for the website and application.",
    heading: "How cookies work on QuoteFly",
    summary:
      "QuoteFly uses essential storage for core behavior and honors the website's optional analytics preference.",
    schemaType: "WebPage",
  },
};

export function publicCanonicalUrl(path: PublicRoutePath): string {
  return path === "/" ? `${PUBLIC_SITE_URL}/` : `${PUBLIC_SITE_URL}${path}`;
}

export function getPublicRouteSeo(path: PublicRoutePath): PublicRouteSeo {
  return PUBLIC_ROUTE_SEO[path];
}
