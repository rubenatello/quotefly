import { PUBLIC_ROUTE_PATHS, PUBLIC_SITE_URL } from "../src/lib/public-seo-data";
import { renderPublicSitemap } from "./sitemap";

const sitemapUrl = process.env.SITEMAP_URL?.trim() || `${PUBLIC_SITE_URL}/sitemap.xml`;
const response = await fetch(sitemapUrl, {
  headers: { Accept: "application/xml,text/xml;q=0.9,*/*;q=0.1" },
  redirect: "follow",
});

if (!response.ok) {
  throw new Error(`Live sitemap check failed: ${response.status} ${response.statusText} at ${sitemapUrl}`);
}

const liveSitemap = await response.text();
const expectedSitemap = renderPublicSitemap();
const normalizeSitemap = (value: string) => value.replaceAll("\r\n", "\n").trim();

if (normalizeSitemap(liveSitemap) !== normalizeSitemap(expectedSitemap)) {
  const liveUrls = Array.from(liveSitemap.matchAll(/<loc>([^<]+)<\/loc>/g), (match) => match[1]);
  throw new Error(
    `Live sitemap differs from the release catalog (${liveUrls.length}/${PUBLIC_ROUTE_PATHS.length} URLs). ` +
      "Confirm the latest Vercel deployment completed before re-running this check.",
  );
}

console.log(`Live sitemap is current at ${sitemapUrl} (${PUBLIC_ROUTE_PATHS.length} public URLs).`);
