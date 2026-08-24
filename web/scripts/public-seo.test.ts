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
import { renderPublicSitemap } from "./sitemap";

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

function parseWebpDimensions(buffer: Buffer): { width: number; height: number } {
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF", "WebP must use a RIFF container");
  assert.equal(buffer.toString("ascii", 8, 12), "WEBP", "WebP container signature is required");
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkType = buffer.toString("ascii", offset, offset + 4);
    const chunkLength = buffer.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (chunkType === "VP8 ") {
      assert.equal(buffer.toString("hex", payload + 3, payload + 6), "9d012a", "VP8 key-frame signature is required");
      return {
        width: buffer.readUInt16LE(payload + 6) & 0x3fff,
        height: buffer.readUInt16LE(payload + 8) & 0x3fff,
      };
    }
    if (chunkType === "VP8L") {
      assert.equal(buffer[payload], 0x2f, "VP8L signature is required");
      const b1 = buffer[payload + 1];
      const b2 = buffer[payload + 2];
      const b3 = buffer[payload + 3];
      const b4 = buffer[payload + 4];
      return {
        width: 1 + b1 + ((b2 & 0x3f) << 8),
        height: 1 + ((b2 & 0xc0) >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
      };
    }
    if (chunkType === "VP8X") {
      return {
        width: 1 + buffer.readUIntLE(payload + 4, 3),
        height: 1 + buffer.readUIntLE(payload + 7, 3),
      };
    }
    offset = payload + chunkLength + (chunkLength % 2);
  }
  throw new Error("Supported WebP dimensions were not found.");
}

function webpChunkTypes(buffer: Buffer): string[] {
  const chunks: string[] = [];
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkType = buffer.toString("ascii", offset, offset + 4);
    const chunkLength = buffer.readUInt32LE(offset + 4);
    chunks.push(chunkType);
    offset += 8 + chunkLength + (chunkLength % 2);
  }
  return chunks;
}

function decodeHtmlText(value: string): string {
  return decodeHtmlAttribute(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

test("publishes the current Basic price, trial, and introductory offer", () => {
  assert.equal(PUBLIC_BASIC_PLAN.monthlyPriceUsd, 29);
  assert.equal(PUBLIC_BASIC_PLAN.trialDays, 20);
  assert.equal(PUBLIC_BASIC_PLAN.firstPaidMonthDiscountPercent, 50);
  assert.equal(PUBLIC_BASIC_PLAN.firstPaidMonthPriceUsd, 14.5);
  assert.match(PUBLIC_ROUTE_SEO["/pricing"].description, /\$29/);
  assert.match(PUBLIC_ROUTE_SEO["/pricing"].description, /20-day trial/);
  assert.match(PUBLIC_ROUTE_SEO["/pricing"].description, /first paid month 50% off/i);
});

test("pricing describes the paid-AI cap without hiding deterministic Kody tools", async () => {
  const html = await readFile(join(distDir, "pricing", "index.html"), "utf8");
  const text = decodeHtmlText(html);
  assert.match(text, /billing-cycle limit/i);
  assert.match(text, /next billing cycle/i);
  assert.match(text, /schedule, task, product-catalog, navigation, and review actions remain available/i);
  assert.doesNotMatch(text, /Kody and AI tools pause/i);
});

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

    assert.equal(decodeHtmlAttribute(title), route.title);
    assert.equal(decodeHtmlAttribute(description), route.description);
    assert.equal(canonical, publicCanonicalUrl(path));
    assert.match(html, /<meta\s+name="robots"\s+content="index,follow"/i);
    const h1 = extract(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i, `${path} h1`);
    assert.equal(decodeHtmlText(h1), route.heading);
    assert.ok(html.length > 10_000, `${path} must include its full public page in raw HTML`);
    assert.match(html, /<footer[^>]*>/i, `${path} must include crawlable site navigation and footer content`);
    assert.ok(html.includes(`data-prerendered-route="${path}"`));
    assert.match(html, /<script\s+type="module"/i, `${path} must retain the React client entry`);
    assert.ok(html.includes(PUBLIC_OG_IMAGE_URL));
    assert.doesNotMatch(html, /The easiest quoting software/i);

    const jsonLdText = extract(
      html,
      /<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/i,
      `${path} JSON-LD`,
    );
    const jsonLd = JSON.parse(jsonLdText) as {
      "@type"?: string;
      url?: string;
      offers?: { price?: string };
      "@graph"?: Array<{ "@type"?: string; url?: string; offers?: { price?: string } }>;
    };
    const schemaNodes = jsonLd["@graph"] ?? [jsonLd];
    assert.ok(schemaNodes.some((node) => node.url === canonical), `${path} schema must include its canonical URL`);
    if (path === "/" || path === "/pricing") {
      const application = schemaNodes.find((node) => node["@type"] === "SoftwareApplication");
      assert.equal(application?.offers?.price, String(PUBLIC_BASIC_PLAN.monthlyPriceUsd));
    }
    if (path.startsWith("/solutions/")) {
      assert.ok(schemaNodes.some((node) => node["@type"] === "BreadcrumbList"));
    }

    titles.add(decodeHtmlAttribute(title));
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

  const solutionsAssets = [
    ["construction-framing.jpg", { width: 1600, height: 1067 }],
    ["electrical-service.jpg", { width: 1600, height: 1068 }],
    ["carpentry-measurement.jpg", { width: 1400, height: 1400 }],
    ["contractor-tools.jpg", { width: 1600, height: 1067 }],
    ["construction-silhouette.jpg", { width: 1600, height: 1067 }],
    ["gardening-watering.jpg", { width: 1000, height: 1500 }],
    ["landscaping-field-work.jpg", { width: 1600, height: 1031 }],
    ["roofing-materials.jpg", { width: 1600, height: 1067 }],
    ["hvac-service.jpg", { width: 1536, height: 1024 }],
    ["plumbing-service.jpg", { width: 1536, height: 1024 }],
    ["flooring-installation.jpg", { width: 1536, height: 1024 }],
  ] as const;
  for (const [asset, dimensions] of solutionsAssets) {
    const assetPath = join(distDir, "images", "solutions", asset);
    const image = await readFile(assetPath);
    assert.deepEqual(parseJpegDimensions(image), dimensions);
    assert.ok((await stat(assetPath)).size < 260_000, `${asset} should stay below 260 KB`);
  }
});

test("private app routes have a server and client noindex boundary", async () => {
  const appShell = await readFile(join(distDir, "app-shell.html"), "utf8");
  assert.match(appShell, /<meta\s+name="robots"\s+content="noindex,nofollow,noarchive"/i);
  assert.doesNotMatch(appShell, /rel="canonical"/i);
  assert.match(appShell, /<script\s+type="module"/i);

  const resetPasswordShell = await readFile(join(distDir, "reset-password", "index.html"), "utf8");
  assert.match(resetPasswordShell, /<meta\s+name="robots"\s+content="noindex,nofollow,noarchive"/i);
  assert.match(resetPasswordShell, /<meta\s+name="referrer"\s+content="no-referrer"/i);
  assert.doesNotMatch(resetPasswordShell, /rel="canonical"/i);
  assert.match(resetPasswordShell, /<script\s+type="module"/i);

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

  const resetHeaders = vercel.headers.find((entry) => entry.source === "/reset-password")?.headers;
  assert.equal(resetHeaders?.find((entry) => entry.key === "X-Robots-Tag")?.value, "noindex, nofollow, noarchive");
  assert.equal(resetHeaders?.find((entry) => entry.key === "Referrer-Policy")?.value, "no-referrer");
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
  assert.doesNotMatch(
    globalHeaders.get("Content-Security-Policy") ?? "",
    /script-src[^;]*'unsafe-inline'/,
  );
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

  const expectedSitemap = renderPublicSitemap();
  const trackedSitemap = await readFile(join(webRoot, "public", "sitemap.xml"), "utf8");
  const sitemap = await readFile(join(distDir, "sitemap.xml"), "utf8");
  assert.equal(trackedSitemap, expectedSitemap, "tracked sitemap must match the public SEO catalog");
  assert.equal(sitemap, expectedSitemap, "deployed sitemap must match the public SEO catalog");
  const locations = Array.from(sitemap.matchAll(/<loc>([^<]+)<\/loc>/g), (match) => match[1]);
  const lastModifiedDates = Array.from(sitemap.matchAll(/<lastmod>([^<]+)<\/lastmod>/g), (match) => match[1]);
  assert.deepEqual(new Set(locations), new Set(PUBLIC_ROUTE_PATHS.map(publicCanonicalUrl)));
  assert.deepEqual(lastModifiedDates, PUBLIC_ROUTE_PATHS.map((path) => PUBLIC_ROUTE_SEO[path].lastModified));
  assert.equal(locations.length, PUBLIC_ROUTE_PATHS.length);
  assert.doesNotMatch(sitemap, /https:\/\/quotefly\.us/);
  assert.doesNotMatch(sitemap, /<priority>|<changefreq>/);
  assert.doesNotMatch(sitemap, /\/app(?:\/|<)/);
});

test("homepage prerender contains the real product, Kody, trade, and offer content", async () => {
  const html = decodeHtmlAttribute(await readFile(join(distDir, "index.html"), "utf8"));
  for (const expected of [
    "Build the quote while the job is still fresh.",
    "Tell Kody what you are trying to get done.",
    "Move from accepted quote to a finished, billable job.",
    "Actual QuoteFly interface · Sanitized fictional data",
    "Find Elena Torres.",
    "HVAC quoting software",
    "Start your 20-day free trial",
    "First paid month $14.50",
  ]) {
    assert.ok(html.includes(expected), `homepage raw HTML must include: ${expected}`);
  }
  assert.ok(html.length > 30_000, "homepage prerender must contain the full public experience, not a thin crawler fallback");
  assert.doesNotMatch(html, /The easiest quoting software/i);
  assert.doesNotMatch(html, /"price":"19"/);
  assert.doesNotMatch(html, /<link[^>]+rel="preload"[^>]+kody-ai-thumbnail/i);

  const kodyThumbnail = join(distDir, "images", "kody", "kody-ai-thumbnail.webp");
  assert.ok((await stat(kodyThumbnail)).size < 25_000, "the below-fold Kody thumbnail must stay below 25 KB");

  const productScreens = [
    ["activity-my-day-desktop-v1.webp", 1440, 900, 225_000],
    ["activity-my-day-mobile-v1.webp", 390, 844, 95_000],
    ["jobs-schedule-desktop-v1.webp", 1440, 900, 225_000],
    ["jobs-schedule-mobile-v1.webp", 390, 844, 95_000],
    ["job-detail-desktop-v1.webp", 1440, 900, 225_000],
    ["job-detail-mobile-v1.webp", 390, 844, 95_000],
    ["kody-review-desktop-v1.webp", 1440, 900, 225_000],
    ["kody-review-mobile-v1.webp", 390, 844, 95_000],
    ["internal-invoice-desktop-v1.webp", 1440, 900, 225_000],
    ["internal-invoice-mobile-v1.webp", 390, 844, 95_000],
    ["notification-center-desktop-v1.webp", 1440, 900, 225_000],
    ["notification-center-mobile-v1.webp", 390, 844, 95_000],
  ] as const;
  for (const [filename, width, height, maxBytes] of productScreens) {
    const assetPath = join(distDir, "images", "product", filename);
    const buffer = await readFile(assetPath);
    assert.deepEqual(parseWebpDimensions(buffer), { width, height }, `${filename} dimensions must remain stable`);
    assert.ok(buffer.length < maxBytes, `${filename} must remain below ${maxBytes} bytes`);
    assert.deepEqual(
      webpChunkTypes(buffer).filter((chunk) => ["EXIF", "XMP ", "ICCP"].includes(chunk)),
      [],
      `${filename} must not contain EXIF, XMP, or ICC metadata chunks`,
    );
    assert.ok(html.includes(`/images/product/${filename}`), `${filename} must be present in raw homepage HTML`);
  }
  for (const altText of [
    "QuoteFly My Day workspace showing due tasks, quote pipeline, active jobs, and recent customer work.",
    "QuoteFly day schedule showing booked field visits, assigned teammates, times, addresses, and dispatch status.",
    "QuoteFly job detail showing an accepted scope, assignment, access instructions, and a scheduled visit.",
    "Kody displaying a review of three tenant-scoped appointments with times, jobs, assignees, and statuses.",
    "QuoteFly internal invoice record showing draft and payment-pending status, customer total, balance, and due date.",
    "QuoteFly notification center showing booked, rescheduled, and dispatched visit updates for fictional jobs.",
  ]) {
    assert.ok(html.includes(altText), `homepage raw HTML must contain screenshot alt text: ${altText}`);
  }
  assert.doesNotMatch(html, /<link[^>]+rel="preload"[^>]+images\/product/i);
  assert.equal((html.match(/loading="lazy"/g) ?? []).length >= 6, true, "all below-fold product images must be lazy");
  assert.equal((html.match(/<picture>/g) ?? []).length >= 6, true, "product proof must use responsive pictures");
  assert.ok(html.includes('media="(max-width: 640px)"'), "product proof must select mobile captures on narrow screens");
});
