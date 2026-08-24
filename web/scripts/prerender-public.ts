import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React, { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { Footer } from "../src/components/Footer";
import { Navbar } from "../src/components/Navbar";
import { AboutPage } from "../src/pages/AboutPage";
import { CookiePolicyPage } from "../src/pages/CookiePolicyPage";
import { DataPrivacyPage } from "../src/pages/DataPrivacyPage";
import { LandingPage } from "../src/pages/LandingPage";
import { LandscapingSolutionsPage } from "../src/pages/LandscapingSolutionsPage";
import { PricingPage } from "../src/pages/PricingPage";
import { PrivacyPage } from "../src/pages/PrivacyPage";
import { ServicesPage } from "../src/pages/ServicesPage";
import { SolutionsPage } from "../src/pages/SolutionsPage";
import { SupportPage } from "../src/pages/SupportPage";
import { TermsPage } from "../src/pages/TermsPage";
import { TradeSolutionsPage, type TradeSolutionId } from "../src/pages/TradeSolutionsPage";
import { LANDING_FAQS } from "../src/lib/landing-content";
import {
  PUBLIC_BASIC_PLAN,
  PUBLIC_OG_IMAGE_URL,
  PUBLIC_ROUTE_PATHS,
  PUBLIC_ROUTE_SEO,
  PUBLIC_SITE_URL,
  publicCanonicalUrl,
  type PublicRoutePath,
} from "../src/lib/public-seo-data";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(webRoot, "dist");
const baseHtml = await readFile(join(distDir, "index.html"), "utf8");

// tsx loads imported TSX files outside Vite's automatic JSX runtime. Expose
// React for that server-only render without changing browser component imports.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function replaceTitle(html: string, title: string): string {
  return html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);
}

function replaceNamedMeta(html: string, name: string, content: string): string {
  const tag = `<meta name="${name}" content="${escapeHtml(content)}" />`;
  const expression = new RegExp(`<meta\\s+name=["']${name}["'][^>]*>`, "i");
  return expression.test(html) ? html.replace(expression, tag) : html.replace("</head>", `    ${tag}\n  </head>`);
}

function replacePropertyMeta(html: string, property: string, content: string): string {
  const tag = `<meta property="${property}" content="${escapeHtml(content)}" />`;
  const expression = new RegExp(`<meta\\s+property=["']${property.replace(":", "\\:")}["'][^>]*>`, "i");
  return expression.test(html) ? html.replace(expression, tag) : html.replace("</head>", `    ${tag}\n  </head>`);
}

function replaceCanonical(html: string, canonical: string): string {
  const tag = `<link rel="canonical" href="${escapeHtml(canonical)}" />`;
  return html.replace(/<link\s+rel=["']canonical["'][^>]*>/i, tag);
}

function removeCanonical(html: string): string {
  return html.replace(/\s*<link\s+rel=["']canonical["'][^>]*>/i, "");
}

function routeSchema(path: PublicRoutePath) {
  const route = PUBLIC_ROUTE_SEO[path];
  const canonical = publicCanonicalUrl(path);

  const softwareApplication = {
    "@type": "SoftwareApplication",
    name: "QuoteFly",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    description: route.description,
    url: canonical,
    offers: {
      "@type": "Offer",
      name: PUBLIC_BASIC_PLAN.name,
      price: String(PUBLIC_BASIC_PLAN.monthlyPriceUsd),
      priceCurrency: "USD",
      url: publicCanonicalUrl("/pricing"),
    },
  };

  if (path === "/") {
    return {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Organization",
          "@id": `${PUBLIC_SITE_URL}/#organization`,
          name: "QuoteFly",
          url: `${PUBLIC_SITE_URL}/`,
          logo: `${PUBLIC_SITE_URL}/logo.png`,
        },
        {
          "@type": "WebSite",
          "@id": `${PUBLIC_SITE_URL}/#website`,
          name: "QuoteFly",
          url: `${PUBLIC_SITE_URL}/`,
          publisher: { "@id": `${PUBLIC_SITE_URL}/#organization` },
        },
        { ...softwareApplication, "@id": `${PUBLIC_SITE_URL}/#software` },
        {
          "@type": "FAQPage",
          "@id": `${PUBLIC_SITE_URL}/#faq`,
          mainEntity: LANDING_FAQS.map((faq) => ({
            "@type": "Question",
            name: faq.q,
            acceptedAnswer: { "@type": "Answer", text: faq.a },
          })),
        },
      ],
    };
  }

  if (path === "/about") {
    return {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "AboutPage",
          "@id": `${canonical}#page`,
          name: route.heading,
          description: route.description,
          url: canonical,
          isPartOf: { "@id": `${PUBLIC_SITE_URL}/#website` },
          publisher: { "@id": `${PUBLIC_SITE_URL}/#organization` },
          about: { "@id": `${PUBLIC_SITE_URL}/#software` },
        },
        {
          "@type": "Organization",
          "@id": `${PUBLIC_SITE_URL}/#organization`,
          name: "QuoteFly",
          url: `${PUBLIC_SITE_URL}/`,
          logo: `${PUBLIC_SITE_URL}/logo.png`,
        },
        {
          "@type": "WebSite",
          "@id": `${PUBLIC_SITE_URL}/#website`,
          name: "QuoteFly",
          url: `${PUBLIC_SITE_URL}/`,
          publisher: { "@id": `${PUBLIC_SITE_URL}/#organization` },
        },
        {
          ...softwareApplication,
          "@id": `${PUBLIC_SITE_URL}/#software`,
          description: PUBLIC_ROUTE_SEO["/"].description,
          url: `${PUBLIC_SITE_URL}/`,
        },
      ],
    };
  }

  if (route.schemaType === "SoftwareApplication") {
    return { "@context": "https://schema.org", ...softwareApplication };
  }

  if (path.startsWith("/solutions/")) {
    return {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "WebPage",
          name: route.heading,
          description: route.description,
          url: canonical,
          isPartOf: { "@type": "WebSite", name: "QuoteFly", url: `${PUBLIC_SITE_URL}/` },
        },
        {
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "Home", item: `${PUBLIC_SITE_URL}/` },
            { "@type": "ListItem", position: 2, name: "Trade solutions", item: publicCanonicalUrl("/solutions") },
            { "@type": "ListItem", position: 3, name: route.heading, item: canonical },
          ],
        },
      ],
    };
  }

  return {
    "@context": "https://schema.org",
    "@type": route.schemaType,
    name: route.heading,
    description: route.description,
    url: canonical,
    isPartOf: {
      "@type": "WebSite",
      name: "QuoteFly",
      url: `${PUBLIC_SITE_URL}/`,
    },
  };
}

function replaceStructuredData(html: string, schema: object | null): string {
  const expression = /\s*<script\s+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/i;
  const withoutExisting = html.replace(expression, "");
  if (!schema) return withoutExisting;
  const serialized = JSON.stringify(schema).replaceAll("<", "\\u003c");
  return withoutExisting.replace("</head>", `    <script type="application/ld+json">${serialized}</script>\n  </head>`);
}

function publicPage(path: PublicRoutePath): ReactElement {
  const onOpenAuth = () => undefined;
  const trade = path.startsWith("/solutions/") && path !== "/solutions/landscaping"
    ? path.slice("/solutions/".length) as TradeSolutionId
    : null;

  if (path === "/") return createElement(LandingPage, { onOpenAuth });
  if (path === "/pricing") return createElement(PricingPage, { onOpenAuth });
  if (path === "/services") return createElement(ServicesPage, { onOpenAuth });
  if (path === "/solutions") return createElement(SolutionsPage, { onOpenAuth });
  if (path === "/solutions/landscaping") return createElement(LandscapingSolutionsPage, { onOpenAuth });
  if (trade) return createElement(TradeSolutionsPage, { trade, onOpenAuth });
  if (path === "/about") return createElement(AboutPage, { onOpenAuth });
  if (path === "/support") return createElement(SupportPage, { onOpenAuth });
  if (path === "/privacy") return createElement(PrivacyPage);
  if (path === "/data-privacy") return createElement(DataPrivacyPage);
  if (path === "/terms") return createElement(TermsPage);
  return createElement(CookiePolicyPage);
}

function routeFallback(path: PublicRoutePath): string {
  const currentPage = path === "/" ? "landing" : path.slice(1);
  const app = createElement(
    MemoryRouter,
    { initialEntries: [path] },
    createElement(
      "div",
      { className: "min-h-screen flex flex-col bg-stone-50" },
      createElement(Navbar, {
        currentPage,
        onNavigate: () => undefined,
        isLoggedIn: false,
        onOpenAuth: () => undefined,
        onOpenSignIn: () => undefined,
        onLogout: () => undefined,
      }),
      createElement("main", { id: "main-content", className: "flex-1" }, publicPage(path)),
      createElement(Footer),
    ),
  );
  return `<div id="root" data-prerendered-route="${path}">${renderToStaticMarkup(app)}</div>`;
}

function renderPublicRoute(path: PublicRoutePath): string {
  const route = PUBLIC_ROUTE_SEO[path];
  const canonical = publicCanonicalUrl(path);
  let html = replaceTitle(baseHtml, route.title);
  html = replaceNamedMeta(html, "description", route.description);
  html = replaceNamedMeta(html, "robots", "index,follow");
  html = replaceNamedMeta(html, "twitter:card", "summary_large_image");
  html = replaceNamedMeta(html, "twitter:title", route.title);
  html = replaceNamedMeta(html, "twitter:description", route.description);
  html = replaceNamedMeta(html, "twitter:image", PUBLIC_OG_IMAGE_URL);
  html = replaceCanonical(html, canonical);
  html = replacePropertyMeta(html, "og:type", "website");
  html = replacePropertyMeta(html, "og:url", canonical);
  html = replacePropertyMeta(html, "og:title", route.title);
  html = replacePropertyMeta(html, "og:description", route.description);
  html = replacePropertyMeta(html, "og:image", PUBLIC_OG_IMAGE_URL);
  html = replacePropertyMeta(html, "og:image:width", "1200");
  html = replacePropertyMeta(html, "og:image:height", "630");
  html = replacePropertyMeta(html, "og:image:alt", "QuoteFly contractor quoting workspace");
  html = replaceStructuredData(html, routeSchema(path));
  return html.replace('<div id="root"></div>', routeFallback(path));
}

async function writeRoute(path: PublicRoutePath, html: string) {
  const outputPath = path === "/" ? join(distDir, "index.html") : join(distDir, path.slice(1), "index.html");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, "utf8");
}

for (const path of PUBLIC_ROUTE_PATHS) {
  await writeRoute(path, renderPublicRoute(path));
}

let appShell = replaceTitle(baseHtml, "QuoteFly Workspace");
appShell = replaceNamedMeta(appShell, "description", "Secure QuoteFly contractor workspace.");
appShell = replaceNamedMeta(appShell, "robots", "noindex,nofollow,noarchive");
appShell = removeCanonical(appShell);
appShell = replaceStructuredData(appShell, null);
await writeFile(join(distDir, "app-shell.html"), appShell, "utf8");

let resetPasswordShell = replaceTitle(baseHtml, "Reset your password | QuoteFly");
resetPasswordShell = replaceNamedMeta(
  resetPasswordShell,
  "description",
  "Securely choose a new password for your QuoteFly account.",
);
resetPasswordShell = replaceNamedMeta(resetPasswordShell, "robots", "noindex,nofollow,noarchive");
resetPasswordShell = replaceNamedMeta(resetPasswordShell, "referrer", "no-referrer");
resetPasswordShell = removeCanonical(resetPasswordShell);
resetPasswordShell = replaceStructuredData(resetPasswordShell, null);
await mkdir(join(distDir, "reset-password"), { recursive: true });
await writeFile(join(distDir, "reset-password", "index.html"), resetPasswordShell, "utf8");

let notFound = replaceTitle(baseHtml, "Page Not Found | QuoteFly");
notFound = replaceNamedMeta(notFound, "description", "The requested QuoteFly page could not be found.");
notFound = replaceNamedMeta(notFound, "robots", "noindex,nofollow");
notFound = removeCanonical(notFound);
notFound = replaceStructuredData(notFound, null);
notFound = notFound.replace(/\s*<script\s+type=["']module["'][^>]*><\/script>/i, "");
notFound = notFound.replace(
  '<div id="root"></div>',
  `<div id="root"><main><h1>Page not found</h1><p>The requested QuoteFly page does not exist.</p><a href="/">Return to QuoteFly</a></main></div>`,
);
await writeFile(join(distDir, "404.html"), notFound, "utf8");

console.log(`Prerendered ${PUBLIC_ROUTE_PATHS.length} public QuoteFly routes.`);
