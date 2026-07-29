import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  PUBLIC_BASIC_PLAN,
  PUBLIC_OG_IMAGE_URL,
  PUBLIC_ROUTE_PATHS,
  PUBLIC_ROUTE_SEO,
  PUBLIC_SITE_URL,
  publicCanonicalUrl,
  type PublicRoutePath,
} from "../src/lib/public-seo-data";

const webRoot = new URL("..", import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1));
const distDir = join(webRoot, "dist");
const baseHtml = await readFile(join(distDir, "index.html"), "utf8");

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

  if (route.schemaType === "SoftwareApplication") {
    return {
      "@context": "https://schema.org",
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

function crawlerNavigation(): string {
  return PUBLIC_ROUTE_PATHS.map((path) => {
    const route = PUBLIC_ROUTE_SEO[path];
    return `<a href="${path}">${escapeHtml(route.heading)}</a>`;
  }).join(" ");
}

function routeFallback(path: PublicRoutePath): string {
  const route = PUBLIC_ROUTE_SEO[path];
  return `<div id="root" data-prerendered-route="${path}"><main><p>QuoteFly contractor quoting software</p><h1>${escapeHtml(route.heading)}</h1><p>${escapeHtml(route.summary)}</p><nav aria-label="Public pages">${crawlerNavigation()}</nav></main></div>`;
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
