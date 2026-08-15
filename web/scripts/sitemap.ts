import {
  PUBLIC_ROUTE_PATHS,
  PUBLIC_ROUTE_SEO,
  PUBLIC_SITE_URL,
  publicCanonicalUrl,
} from "../src/lib/public-seo-data";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function assertValidLastModified(path: string, value: string): void {
  const currentDate = new Date().toISOString().slice(0, 10);
  const parsed = new Date(`${value}T00:00:00.000Z`);

  if (!ISO_DATE.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Public route ${path} has an invalid lastModified date: ${value}`);
  }

  if (value > currentDate) {
    throw new Error(`Public route ${path} has a future lastModified date: ${value}`);
  }
}

export function renderPublicSitemap(): string {
  const seenUrls = new Set<string>();
  const entries = PUBLIC_ROUTE_PATHS.map((path) => {
    const route = PUBLIC_ROUTE_SEO[path];
    const canonicalUrl = publicCanonicalUrl(path);

    if (route.path !== path) {
      throw new Error(`Public route catalog key ${path} does not match its route path ${route.path}.`);
    }

    if (path.startsWith("/app") || path.startsWith("/reset-password")) {
      throw new Error(`Private route ${path} must not be included in the public sitemap.`);
    }

    if (new URL(canonicalUrl).origin !== PUBLIC_SITE_URL) {
      throw new Error(`Public route ${path} does not use the canonical QuoteFly origin.`);
    }

    if (seenUrls.has(canonicalUrl)) {
      throw new Error(`Duplicate canonical URL in public sitemap: ${canonicalUrl}`);
    }
    seenUrls.add(canonicalUrl);
    assertValidLastModified(path, route.lastModified);

    return [
      "  <url>",
      `    <loc>${escapeXml(canonicalUrl)}</loc>`,
      `    <lastmod>${route.lastModified}</lastmod>`,
      "  </url>",
    ].join("\n");
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries,
    "</urlset>",
    "",
  ].join("\n");
}
