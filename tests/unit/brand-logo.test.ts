import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import test from "node:test";
import {
  BRAND_LOGO_DATA_URL_MAX_LENGTH,
  BrandLogoDataUrlSchema,
  sanitizeBrandLogoDataUrl,
} from "../../src/lib/brand-logo";
import { isSupportedBrandLogoDataUrl } from "../../web/src/lib/brand-logo";

async function supportedDataUrl(): Promise<string> {
  const logo = await readFile("web/public/favicon.png");
  return `data:image/png;base64,${logo.toString("base64")}`;
}

async function supportedJpegDataUrl(): Promise<string> {
  const logo = await readFile("web/public/images/solutions/carpentry-measurement.jpg");
  return `data:image/jpeg;base64,${logo.toString("base64")}`;
}

test("server and browser accept only bounded PNG/JPEG data logos", async () => {
  const supportedLogo = await supportedDataUrl();
  assert.equal(BrandLogoDataUrlSchema.parse(supportedLogo), supportedLogo);
  assert.equal(sanitizeBrandLogoDataUrl(supportedLogo), supportedLogo);
  assert.equal(isSupportedBrandLogoDataUrl(supportedLogo), true);
  assert.equal(BrandLogoDataUrlSchema.safeParse(await supportedJpegDataUrl()).success, true);

  for (const unsupported of [
    "https://example.com/logo.png",
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA==",
  ]) {
    assert.equal(sanitizeBrandLogoDataUrl(unsupported), null);
    assert.equal(isSupportedBrandLogoDataUrl(unsupported), false);
  }
});

test("server rejects a PNG with forged oversized IHDR dimensions", async () => {
  const supportedLogo = await supportedDataUrl();
  const [, payload] = supportedLogo.split(",", 2);
  const forged = Buffer.from(payload, "base64");
  forged.writeUInt32BE(100_000, 16);
  forged.writeUInt32BE(100_000, 20);
  const forgedDataUrl = `data:image/png;base64,${forged.toString("base64")}`;

  assert.equal(sanitizeBrandLogoDataUrl(forgedDataUrl), null);
  assert.equal(BrandLogoDataUrlSchema.safeParse(forgedDataUrl).success, false);
});

test("server rejects a dimension-safe PNG with oversized inflated IDAT output", () => {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const inflatedBomb = Buffer.alloc(1_048_576);
  const forgedPng = Buffer.concat([
    pngSignature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(inflatedBomb)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const forgedDataUrl = `data:image/png;base64,${forgedPng.toString("base64")}`;

  assert.ok(forgedDataUrl.length < BRAND_LOGO_DATA_URL_MAX_LENGTH);
  assert.equal(sanitizeBrandLogoDataUrl(forgedDataUrl), null);
  assert.equal(BrandLogoDataUrlSchema.safeParse(forgedDataUrl).success, false);
});

test("logo data URLs are rejected above the shared storage cap", () => {
  const oversized = `data:image/png;base64,${"A".repeat(BRAND_LOGO_DATA_URL_MAX_LENGTH)}`;
  assert.equal(sanitizeBrandLogoDataUrl(oversized), null);
  assert.equal(isSupportedBrandLogoDataUrl(oversized), false);
});
