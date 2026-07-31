import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_BASIC_PLAN,
  PUBLIC_OG_IMAGE_URL,
  PUBLIC_ROUTE_PATHS,
  PUBLIC_ROUTE_SEO,
  PUBLIC_SITE_URL,
  publicCanonicalUrl,
} from "../src/lib/public-seo-data";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(webRoot, "dist");

function extract(html: string, expression: RegExp, label: string): string {
  const value = html.match(expression)?.[1]?.trim();
  assert.ok(value, `Missing ${label}`);
  return value;
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function parseJpegDimensions(buffer: Buffer): { width: number; height: number } {
  assert.equal(buffer[0], 0xff, "JPEG must start with FF D8");
  assert.equal(buffer[1], 0xd8, "JPEG must start with FF D8");
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  throw new Error("JPEG dimensions were not found.");
}

test("every public route has unique raw crawlable HTML", async () => {
  const titles = new Set<string>();
  const descriptions = new Set<string>();
  const canonicals = new Set<string>();

  for (const path of PUBLIC_ROUTE_PATHS) {
    const outputPath = path === "/" ? join(distDir, "index.html") : join(distDir, path.slice(1), "index.html");
    const html = await readFile(outputPath, "utf8");
    const route = PUBLIC_ROUTE_SEO[path];
    const title = extract(html, /<title>([^<]+)<\/title>/i, `${path} title`);
    const description = extract(html, /<meta\s+name="description"\s+content="([^"]+)"/i, `${path} description`);
    const canonical = extract(html, /<link\s+rel="canonical"\s+href="([^"]+)"/i, `${path} canonical`);

    assert.equal(title, route.title);
    assert.equal(decodeHtmlAttribute(description), route.description);
    assert.equal(canonical, publicCanonicalUrl(path));
    assert.match(html, /<meta\s+name="robots"\s+content="index,follow"/i);
    assert.match(html, new RegExp(`<h1>${route.heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</h1>`));
    assert.ok(decodeHtmlAttribute(html).includes(route.summary), `${path} must include its route summary in raw HTML`);
    assert.ok(html.includes(`data-prerendered-route="${path}"`));
    assert.match(html, /<script\s+type="module"/i, `${path} must retain the React client entry`);
    assert.ok(html.includes(PUBLIC_OG_IMAGE_URL));

    const jsonLdText = extract(
      html,
      /<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/i,
      `${path} JSON-LD`,
    );
    const jsonLd = JSON.parse(jsonLdText) as { url?: string; offers?: { price?: string } };
    assert.equal(jsonLd.url, canonical);
    if (path === "/" || path === "/pricing") {
      assert.equal(jsonLd.offers?.price, String(PUBLIC_BASIC_PLAN.monthlyPriceUsd));
    }

    titles.add(title);
    descriptions.add(description);
    canonicals.add(canonical);
  }

  assert.equal(titles.size, PUBLIC_ROUTE_PATHS.length);
  assert.equal(descriptions.size, PUBLIC_ROUTE_PATHS.length);
  assert.equal(canonicals.size, PUBLIC_ROUTE_PATHS.length);
});

test("social and visible marketing images are valid JPEG assets with expected dimensions", async () => {
  const ogPath = join(distDir, "og-image.jpg");
  const og = await readFile(ogPath);
  assert.notEqual(og.subarray(0, 32).toString("utf8").trimStart().slice(0, 5).toLowerCase(), "<html");
  assert.deepEqual(parseJpegDimensions(og), { width: 1200, height: 630 });
  assert.ok((await stat(ogPath)).size < 300_000, "OG image should stay below 300 KB");

  const workflowBackgroundPath = join(distDir, "contractor-workbench-hero.jpg");
  const workflowBackground = await readFile(workflowBackgroundPath);
  assert.deepEqual(parseJpegDimensions(workflowBackground), { width: 1448, height: 1086 });
  assert.ok((await stat(workflowBackgroundPath)).size < 180_000, "Hero background should stay below 180 KB");
});

test("private app routes have a server and client noindex boundary", async () => {
  const appShell = await readFile(join(distDir, "app-shell.html"), "utf8");
  assert.match(appShell, /<meta\s+name="robots"\s+content="noindex,nofollow,noarchive"/i);
  assert.doesNotMatch(appShell, /rel="canonical"/i);
  assert.match(appShell, /<script\s+type="module"/i);

  const vercel = JSON.parse(await readFile(join(webRoot, "vercel.json"), "utf8")) as {
    rewrites: Array<{ source: string; destination: string }>;
    headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  };
  assert.deepEqual(
    vercel.rewrites,
    [
      { source: "/app", destination: "/app-shell.html" },
      { source: "/app/(.*)", destination: "/app-shell.html" },
    ],
  );
  for (const source of ["/app", "/app/(.*)"]) {
    const header = vercel.headers.find((entry) => entry.source === source)?.headers.find((entry) => entry.key === "X-Robots-Tag");
    assert.equal(header?.value, "noindex, nofollow, noarchive");
  }
});

test("Vercel applies browser security headers to every route", async () => {
  const vercel = JSON.parse(await readFile(join(webRoot, "vercel.json"), "utf8")) as {
    headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  };
  const globalHeaders = new Map(
    vercel.headers.find((entry) => entry.source === "/(.*)")?.headers.map((entry) => [entry.key, entry.value]),
  );

  assert.match(globalHeaders.get("Content-Security-Policy") ?? "", /default-src 'self'/);
  assert.match(globalHeaders.get("Content-Security-Policy") ?? "", /frame-ancestors 'none'/);
  assert.match(globalHeaders.get("Content-Security-Policy") ?? "", /object-src 'none'/);
  assert.equal(globalHeaders.get("Strict-Transport-Security"), "max-age=31536000");
  assert.equal(globalHeaders.get("X-Content-Type-Options"), "nosniff");
  assert.equal(globalHeaders.get("X-Frame-Options"), "DENY");
  assert.equal(globalHeaders.get("Referrer-Policy"), "strict-origin-when-cross-origin");
  assert.equal(
    globalHeaders.get("Permissions-Policy"),
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
});

test("unknown URLs use a noindex static 404 instead of the homepage SPA", async () => {
  const notFound = await readFile(join(distDir, "404.html"), "utf8");
  assert.match(notFound, /<h1>Page not found<\/h1>/i);
  assert.match(notFound, /<meta\s+name="robots"\s+content="noindex,nofollow"/i);
  assert.doesNotMatch(notFound, /rel="canonical"/i);
  assert.doesNotMatch(notFound, /<script\s+type="module"/i);
});

test("robots and sitemap use the canonical host and cover all public routes", async () => {
  const robots = await readFile(join(distDir, "robots.txt"), "utf8");
  assert.ok(robots.includes("Disallow: /app"));
  assert.ok(robots.includes(`Host: ${new URL(PUBLIC_SITE_URL).host}`));
  assert.ok(robots.includes(`Sitemap: ${PUBLIC_SITE_URL}/sitemap.xml`));

  const sitemap = await readFile(join(distDir, "sitemap.xml"), "utf8");
  const locations = Array.from(sitemap.matchAll(/<loc>([^<]+)<\/loc>/g), (match) => match[1]);
  assert.deepEqual(new Set(locations), new Set(PUBLIC_ROUTE_PATHS.map(publicCanonicalUrl)));
  assert.equal(locations.length, PUBLIC_ROUTE_PATHS.length);
  assert.doesNotMatch(sitemap, /https:\/\/quotefly\.us/);
});
