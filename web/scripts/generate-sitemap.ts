import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPublicSitemap } from "./sitemap";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const sitemapPath = join(webRoot, "public", "sitemap.xml");
const expectedSitemap = renderPublicSitemap();
const checkOnly = process.argv.includes("--check");

if (checkOnly) {
  const currentSitemap = await readFile(sitemapPath, "utf8").catch(() => "");
  if (currentSitemap !== expectedSitemap) {
    console.error("web/public/sitemap.xml is stale. Run `npm run generate:sitemap` from web/.");
    process.exitCode = 1;
  } else {
    console.log("Tracked sitemap matches the public SEO route catalog.");
  }
} else {
  await mkdir(dirname(sitemapPath), { recursive: true });
  await writeFile(sitemapPath, expectedSitemap, "utf8");
  console.log(`Generated sitemap.xml with ${expectedSitemap.match(/<url>/g)?.length ?? 0} public URLs.`);
}
