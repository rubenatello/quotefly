import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  persistQuoteBrandAsset,
  QuoteBrandAssetUnavailableError,
  resolveQuoteBrandAssetDataUrl,
  resolveQuoteBrandingLogoDataUrl,
} from "../../src/services/quote-brand-asset";

interface StoredAsset {
  id: string;
  tenantId: string;
  sha256: string;
  mimeType: string;
  data: Uint8Array;
  byteLength: number;
}

function createBrandAssetClient() {
  const assets = new Map<string, StoredAsset>();
  return {
    assets,
    client: {
      tenantBrandAsset: {
        async upsert(args: {
          where: { tenantId_sha256: { tenantId: string; sha256: string } };
          create: Omit<StoredAsset, "id">;
        }) {
          const { tenantId, sha256 } = args.where.tenantId_sha256;
          const key = `${tenantId}:${sha256}`;
          const existing = assets.get(key);
          if (existing) return { id: existing.id, sha256: existing.sha256 };
          const asset = { id: `asset-${assets.size + 1}`, ...args.create };
          assets.set(key, asset);
          return { id: asset.id, sha256: asset.sha256 };
        },
        async findFirst(args: {
          where: { id: string; tenantId: string; sha256: string };
        }) {
          const asset = assets.get(`${args.where.tenantId}:${args.where.sha256}`);
          if (!asset || asset.id !== args.where.id) return null;
          return {
            sha256: asset.sha256,
            mimeType: asset.mimeType,
            data: asset.data,
            byteLength: asset.byteLength,
          };
        },
      },
    },
  };
}

test("quote brand assets deduplicate per tenant and resolve only inside that tenant", async () => {
  const logo = await readFile("web/public/favicon.png");
  const logoUrl = `data:image/png;base64,${logo.toString("base64")}`;
  const store = createBrandAssetClient();
  const client = store.client as never;

  const first = await persistQuoteBrandAsset(client, "tenant-a", logoUrl);
  const repeated = await persistQuoteBrandAsset(client, "tenant-a", logoUrl);
  const otherTenant = await persistQuoteBrandAsset(client, "tenant-b", logoUrl);

  assert.deepEqual(repeated, first);
  assert.notEqual(otherTenant?.id, first?.id);
  assert.equal(store.assets.size, 2);
  assert.equal(await resolveQuoteBrandAssetDataUrl(client, "tenant-a", first!), logoUrl);
  assert.equal(
    await resolveQuoteBrandingLogoDataUrl(client, "tenant-a", { logoUrl }),
    logoUrl,
    "legacy inline document snapshots remain renderable",
  );
  await assert.rejects(
    resolveQuoteBrandAssetDataUrl(client, "tenant-b", first!),
    QuoteBrandAssetUnavailableError,
  );
});

test("invalid or remote logos are never persisted", async () => {
  const store = createBrandAssetClient();
  const client = store.client as never;

  assert.equal(await persistQuoteBrandAsset(client, "tenant-a", "https://example.com/logo.png"), null);
  assert.equal(await persistQuoteBrandAsset(client, "tenant-a", "data:image/png;base64,Zm9yZ2Vk"), null);
  assert.equal(store.assets.size, 0);
});
