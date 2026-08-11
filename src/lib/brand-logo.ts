import { z } from "zod";
import { inflateSync } from "node:zlib";

export const BRAND_LOGO_DATA_URL_MAX_LENGTH = 900_000;
export const BRAND_LOGO_MAX_WIDTH = 4_096;
export const BRAND_LOGO_MAX_HEIGHT = 4_096;
export const BRAND_LOGO_MAX_PIXELS = 4_000_000;

const BrandLogoDataUrlPattern = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;

function hasSafeDimensions(width: number, height: number): boolean {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= BRAND_LOGO_MAX_WIDTH &&
    height <= BRAND_LOGO_MAX_HEIGHT &&
    width * height <= BRAND_LOGO_MAX_PIXELS
  );
}

function isSafePng(buffer: Buffer): boolean {
  if (buffer.length < 45) return false;
  if (!buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return false;
  }
  if (buffer.readUInt32BE(8) !== 13 || buffer.subarray(12, 16).toString("ascii") !== "IHDR") return false;

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  const compressionMethod = buffer[26];
  const filterMethod = buffer[27];
  const interlaceMethod = buffer[28];
  const validBitDepth =
    (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth)) ||
    (colorType === 2 && [8, 16].includes(bitDepth)) ||
    (colorType === 3 && [1, 2, 4, 8].includes(bitDepth)) ||
    ((colorType === 4 || colorType === 6) && [8, 16].includes(bitDepth));
  if (
    !hasSafeDimensions(width, height) ||
    !validBitDepth ||
    compressionMethod !== 0 ||
    filterMethod !== 0 ||
    interlaceMethod !== 0
  ) {
    return false;
  }

  const idatChunks: Buffer[] = [];
  let offset = 8;
  let sawIhdr = false;
  let sawIend = false;
  while (offset + 12 <= buffer.length) {
    const chunkLength = buffer.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = typeStart + 4;
    const dataEnd = dataStart + chunkLength;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > buffer.length) return false;

    const chunkType = buffer.subarray(typeStart, dataStart).toString("ascii");
    if (!sawIhdr) {
      if (chunkType !== "IHDR" || chunkLength !== 13) return false;
      sawIhdr = true;
    } else if (chunkType === "IHDR") {
      return false;
    }

    if (chunkType === "IDAT") idatChunks.push(buffer.subarray(dataStart, dataEnd));
    if (chunkType === "IEND") {
      if (chunkLength !== 0 || chunkEnd !== buffer.length) return false;
      sawIend = true;
      break;
    }
    offset = chunkEnd;
  }

  if (!sawIhdr || !sawIend || idatChunks.length === 0) return false;

  const channelCount = colorType === 0 || colorType === 3 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
  const rowBytes = Math.ceil((width * channelCount * bitDepth) / 8);
  const expectedInflatedBytes = height * (rowBytes + 1);
  try {
    const inflated = inflateSync(Buffer.concat(idatChunks), {
      maxOutputLength: expectedInflatedBytes,
    });
    return inflated.length === expectedInflatedBytes;
  } catch {
    return false;
  }
}

function readJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (
    buffer.length < 12 ||
    buffer[0] !== 0xff ||
    buffer[1] !== 0xd8 ||
    buffer[buffer.length - 2] !== 0xff ||
    buffer[buffer.length - 1] !== 0xd9
  ) {
    return null;
  }

  let offset = 2;
  while (offset < buffer.length - 1) {
    if (buffer[offset] !== 0xff) return null;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) return null;

    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) return null;

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return null;
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isStartOfFrame) {
      if (segmentLength < 7) return null;
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }

    if (marker === 0xda) return null;
    offset += segmentLength;
  }

  return null;
}

export function decodeValidatedBrandLogoDataUrl(logoUrl?: string | null): Buffer | null {
  if (!logoUrl || logoUrl.length > BRAND_LOGO_DATA_URL_MAX_LENGTH) return null;
  const match = BrandLogoDataUrlPattern.exec(logoUrl);
  if (!match) return null;

  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length === 0 || buffer.toString("base64") !== match[2]) return null;

  if (match[1] === "png") return isSafePng(buffer) ? buffer : null;
  const dimensions = readJpegDimensions(buffer);
  return dimensions && hasSafeDimensions(dimensions.width, dimensions.height) ? buffer : null;
}

export const BrandLogoDataUrlSchema = z
  .string()
  .trim()
  .max(BRAND_LOGO_DATA_URL_MAX_LENGTH)
  .regex(/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/)
  .refine((value) => decodeValidatedBrandLogoDataUrl(value) !== null, {
    message: "Logo must be a valid PNG or JPEG within the supported dimensions.",
  });

export function sanitizeBrandLogoDataUrl(logoUrl?: string | null): string | null {
  if (!logoUrl) return null;
  const parsed = BrandLogoDataUrlSchema.safeParse(logoUrl);
  return parsed.success ? parsed.data : null;
}
