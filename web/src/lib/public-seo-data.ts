import { BASIC_PLAN } from "./plans";

export const PUBLIC_SITE_URL = "https://www.quotefly.us";
export const PUBLIC_OG_IMAGE_URL = `${PUBLIC_SITE_URL}/og-image.jpg`;

export const PUBLIC_BASIC_PLAN = BASIC_PLAN;

export const PUBLIC_ROUTE_PATHS = [
  "/",
  "/pricing",
  "/services",
  "/solutions",
  "/solutions/hvac",
  "/solutions/plumbing",
  "/solutions/flooring",
  "/solutions/roofing",
  "/solutions/landscaping",
  "/solutions/construction",
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
  /** Date of the last significant customer-visible content, structured-data, or link update. */
  lastModified: string;
  title: string;
  description: string;
  heading: string;
  summary: string;
  schemaType: "WebPage" | "AboutPage" | "ContactPage" | "CollectionPage" | "SoftwareApplication";
};

export const PUBLIC_ROUTE_SEO: Record<PublicRoutePath, PublicRouteSeo> = {
  "/": {
    path: "/",
    lastModified: "2026-08-27",
    title: "Contractor Quoting, CRM & Dispatch Software | QuoteFly",
    description:
      "QuoteFly connects contractor quoting, customer management, scheduling, dispatch, and internal invoice records for solo operators and small service teams.",
    heading: "Build the quote while the job is still fresh.",
    summary:
      "QuoteFly is quoting, customer management, scheduling, and dispatch software for solo contractors and small service teams. Keep each customer, quote, accepted Job, scheduled visit, dispatch update, and internal invoice record connected.",
    schemaType: "SoftwareApplication",
  },
  "/pricing": {
    path: "/pricing",
    lastModified: "2026-08-23",
    title: "Contractor Quoting Software Pricing & Features | QuoteFly",
    description:
      `QuoteFly Basic costs $${PUBLIC_BASIC_PLAN.monthlyPriceUsd} per month after a ${PUBLIC_BASIC_PLAN.trialDays}-day trial, with the first paid month 50% off. Includes quoting, Jobs, scheduling, dispatch, and internal invoice records.`,
    heading: "Contractor quoting software pricing",
    summary:
      "Basic is the plan available today, with quoting, Jobs, scheduling, dispatch controls, and internal invoice records in one workspace.",
    schemaType: "SoftwareApplication",
  },
  "/services": {
    path: "/services",
    lastModified: "2026-08-25",
    title: "Contractor Quote, Job & Dispatch Software | QuoteFly",
    description:
      "Explore QuoteFly customer management, Kody-assisted quote drafting, accepted-quote Jobs, scheduling, dispatch controls, and internal invoice records.",
    heading: "Customer management and quoting services in one simple app",
    summary:
      "Move from customer intake to a Kody-assisted quote review, accepted Job, scheduled visit, dispatch update, and internal invoice record in one mobile-friendly workspace.",
    schemaType: "CollectionPage",
  },
  "/solutions": {
    path: "/solutions",
    lastModified: "2026-08-27",
    title: "Contractor Quoting, Kody AI & Dispatch Solutions | QuoteFly",
    description:
      "See Kody prepare customers, quotes, schedule openings, booking and dispatch reviews across QuoteFly’s accepted-quote Jobs and internal invoice records.",
    heading: "Built for the work. Not the paperwork.",
    summary:
      "See how Kody structures customer and quote requests, reads the permission-scoped QuoteFly schedule, and prepares booking or dispatch reviews. Accepted quotes become linked Jobs, and a user confirms every booking and status change.",
    schemaType: "CollectionPage",
  },
  "/solutions/hvac": {
    path: "/solutions/hvac",
    lastModified: "2026-08-27",
    title: "HVAC Quoting and Estimating Software | QuoteFly",
    description:
      "Manage HVAC customers, Kody-assisted estimates, repair and replacement quotes, accepted Jobs, technician scheduling, dispatch, and internal invoice records.",
    heading: "HVAC quotes that make repair and replacement options clear",
    summary:
      "QuoteFly helps HVAC contractors keep the customer, diagnosis, repair or replacement quote, accepted Job, technician visit, and internal invoice status connected in one small-team workspace.",
    schemaType: "WebPage",
  },
  "/solutions/plumbing": {
    path: "/solutions/plumbing",
    lastModified: "2026-08-27",
    title: "Plumbing Quote and Estimate Software | QuoteFly",
    description:
      "Manage plumbing customers, Kody-assisted estimates, repair and replacement quotes, accepted Jobs, service scheduling, dispatch, and internal invoice records.",
    heading: "Plumbing quotes that keep diagnosis, repair, and replacement choices clear",
    summary:
      "QuoteFly helps plumbing contractors move from customer lookup and on-site diagnosis to a reviewed repair or replacement quote, an accepted Job, a scheduled service visit, and an internal invoice record.",
    schemaType: "WebPage",
  },
  "/solutions/flooring": {
    path: "/solutions/flooring",
    lastModified: "2026-08-27",
    title: "Flooring Estimating and Quote Software | QuoteFly",
    description:
      "Manage flooring customers, measured-scope estimates, preparation and material lines, accepted installation Jobs, crew scheduling, and internal invoice records.",
    heading: "Flooring estimates that protect prep work, quantities, and margin",
    summary:
      "QuoteFly helps flooring contractors keep measured scope, preparation, material, labor, customer options, the accepted installation Job, and scheduled crew visit connected without turning every quote into a new spreadsheet.",
    schemaType: "WebPage",
  },
  "/solutions/roofing": {
    path: "/solutions/roofing",
    lastModified: "2026-08-27",
    title: "Roofing Estimate and Quote Software | QuoteFly",
    description:
      "Manage roofing customers, repair and reroof estimates, allowances, accepted Jobs, crew scheduling, dispatch controls, and internal invoice records.",
    heading: "Roofing quotes that make the full system and allowances visible",
    summary:
      "QuoteFly helps roofing contractors turn inspection details into a readable repair or reroof quote, keep allowances clear, move accepted work into a Job, and schedule the crew without rebuilding the customer record.",
    schemaType: "WebPage",
  },
  "/solutions/landscaping": {
    path: "/solutions/landscaping",
    lastModified: "2026-08-27",
    title: "Landscaping Quote, Job & Scheduling Software | QuoteFly",
    description:
      "Manage landscaping customers, flexible estimates, accepted Jobs, crew scheduling, dispatch controls, and internal invoice records with QuoteFly.",
    heading: "Landscaping quotes built around the way your crew works",
    summary:
      "QuoteFly helps landscaping contractors connect the customer and site request to a reviewed maintenance or installation quote, an accepted Job, a scheduled crew visit, and an internal invoice record.",
    schemaType: "WebPage",
  },
  "/solutions/construction": {
    path: "/solutions/construction",
    lastModified: "2026-08-27",
    title: "Construction Estimating and Quote Software | QuoteFly",
    description:
      "Manage construction customers, Kody-assisted estimates, phased quotes, accepted Jobs, field scheduling, dispatch controls, and internal invoice records.",
    heading: "Construction quotes that organize complex work into a clear decision",
    summary:
      "QuoteFly helps small construction teams connect customer intake, a phased estimate, human quote review, an accepted Job, scheduled field visits, and internal invoice status without adopting a full enterprise project-management suite.",
    schemaType: "WebPage",
  },
  "/about": {
    path: "/about",
    lastModified: "2026-08-25",
    title: "About QuoteFly | Quoting, CRM & Dispatch Software",
    description:
      "QuoteFly brings quoting, customer management, job scheduling, and dispatch into one practical workflow for solo operators and small service teams.",
    heading: "We are building the easiest way to quote, manage customers, and dispatch work.",
    summary:
      "QuoteFly is contractor operations software that keeps customers, quotes, accepted Jobs, scheduled visits, dispatch status, and internal invoice records connected.",
    schemaType: "AboutPage",
  },
  "/support": {
    path: "/support",
    lastModified: "2026-08-10",
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
    lastModified: "2026-08-11",
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
    lastModified: "2026-08-01",
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
    lastModified: "2026-08-11",
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
    lastModified: "2026-08-11",
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
