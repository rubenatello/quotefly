import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { decodeValidatedBrandLogoDataUrl } from "../lib/brand-logo.js";

export interface QuoteBrandAssetReference {
  id: string;
  sha256: string;
}

type BrandAssetClient = Pick<Prisma.TransactionClient, "tenantBrandAsset">;

const supportedMimeTypes = new Set(["image/png", "image/jpeg"]);

function mimeTypeFromValidatedDataUrl(logoUrl: string): "image/png" | "image/jpeg" | null {
  if (logoUrl.startsWith("data:image/png;base64,")) return "image/png";
  if (logoUrl.startsWith("data:image/jpeg;base64,")) return "image/jpeg";
  return null;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function persistQuoteBrandAsset(
  client: BrandAssetClient,
  tenantId: string,
  logoUrl: string | null | undefined,
): Promise<QuoteBrandAssetReference | null> {
  if (!logoUrl) return null;

  const data = decodeValidatedBrandLogoDataUrl(logoUrl);
  const mimeType = mimeTypeFromValidatedDataUrl(logoUrl);
  if (!data || !mimeType) return null;

  const digest = sha256(data);
  const storedData = Uint8Array.from(data);
  const asset = await client.tenantBrandAsset.upsert({
    where: {
      tenantId_sha256: {
        tenantId,
        sha256: digest,
      },
    },
    update: {},
    create: {
      tenantId,
      sha256: digest,
      mimeType,
      data: storedData,
      byteLength: storedData.length,
    },
    select: {
      id: true,
      sha256: true,
    },
  });

  return asset;
}

export class QuoteBrandAssetUnavailableError extends Error {
  constructor() {
    super("Stored quote branding asset is unavailable.");
    this.name = "QuoteBrandAssetUnavailableError";
  }
}

export async function resolveQuoteBrandAssetDataUrl(
  client: BrandAssetClient,
  tenantId: string,
  reference: QuoteBrandAssetReference,
): Promise<string> {
  const asset = await client.tenantBrandAsset.findFirst({
    where: {
      id: reference.id,
      tenantId,
      sha256: reference.sha256,
    },
    select: {
      sha256: true,
      mimeType: true,
      data: true,
      byteLength: true,
    },
  });

  if (
    !asset ||
    !supportedMimeTypes.has(asset.mimeType) ||
    asset.data.length !== asset.byteLength ||
    sha256(asset.data) !== asset.sha256
  ) {
    throw new QuoteBrandAssetUnavailableError();
  }

  return `data:${asset.mimeType};base64,${Buffer.from(asset.data).toString("base64")}`;
}

export async function resolveQuoteBrandingLogoDataUrl(
  client: BrandAssetClient,
  tenantId: string,
  snapshot: {
    logoUrl?: string | null;
    logoAsset?: QuoteBrandAssetReference | null;
  },
): Promise<string | null> {
  if (snapshot.logoAsset) {
    return resolveQuoteBrandAssetDataUrl(client, tenantId, snapshot.logoAsset);
  }
  return snapshot.logoUrl ?? null;
}
