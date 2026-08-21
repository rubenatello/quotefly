import type { FastifyInstance } from "fastify";
import { ServiceCategory } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildServer } from "../../src/app";
import { prisma } from "../../src/lib/prisma";
import { recommendedPresetsForTrade } from "../../src/services/onboarding";
import { normalizeTenantProductName } from "../../src/services/tenant-starter-catalog";

let app: FastifyInstance;

function cookieFrom(response: { headers: Record<string, number | string | string[] | undefined> }): string {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error("Expected a session cookie.");
  return String(value).split(";")[0] ?? String(value);
}

async function signUp() {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      email: `onboarding-preservation-${unique}@example.com`,
      password: "TestPassword123!",
      fullName: "Catalog Owner",
      companyName: `Catalog Preservation ${unique}`,
      primaryTrade: "ROOFING",
      acceptedLegalTerms: true,
      termsVersion: "2026-07-30",
      privacyPolicyVersion: "2026-08-10",
    },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as { tenant: { id: string } };
  return { cookie: cookieFrom(response), tenantId: body.tenant.id };
}

async function fillActiveCatalog(tenantId: string, targetCount = 200) {
  const activeCount = await prisma.workPreset.count({
    where: { tenantId, deletedAtUtc: null },
  });
  expect(activeCount).toBeLessThanOrEqual(targetCount);
  const needed = targetCount - activeCount;
  if (needed === 0) return;
  await prisma.workPreset.createMany({
    data: Array.from({ length: needed }, (_, index) => ({
      tenantId,
      serviceType: "ROOFING" as const,
      name: `Capacity filler ${index + 1}`,
      description: "Integration-test capacity filler.",
      category: "SERVICE" as const,
      unitType: "FLAT" as const,
      defaultQuantity: 1,
      unitCost: 1,
      unitPrice: 2,
      isDefault: false,
    })),
  });
}

function customPresetPayload(name: string, id?: string) {
  return {
    ...(id ? { id } : {}),
    serviceType: "ROOFING",
    name,
    description: "Tenant-owned integration test service.",
    category: "SERVICE",
    unitType: "FLAT",
    defaultQuantity: 1,
    unitCost: 15,
    unitPrice: 30,
    isDefault: true,
  };
}

describe("onboarding catalog preservation", () => {
  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  beforeEach(async () => {
    await prisma.quickBooksWebhookEvent.deleteMany();
    await prisma.billingWebhookEvent.deleteMany();
    await prisma.tenant.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  test("setup save without presets preserves custom products and canonical preset customizations", async () => {
    const session = await signUp();
    const customProductResponse = await app.inject({
      method: "POST",
      url: "/v1/products",
      headers: { cookie: session.cookie },
      payload: {
        serviceType: "ROOFING",
        name: "Custom copper flashing package",
        description: "Tenant-authored catalog item that setup must not archive.",
        category: "MATERIAL",
        unitType: "EACH",
        defaultQuantity: 1,
        unitCost: 125,
        unitPrice: 275,
        isDefault: true,
      },
    });
    expect(customProductResponse.statusCode).toBe(201);
    const customProduct = (customProductResponse.json() as { product: { id: string } }).product;

    const canonicalPreset = await prisma.workPreset.findFirstOrThrow({
      where: {
        tenantId: session.tenantId,
        serviceType: "ROOFING",
        catalogKey: { not: null },
        deletedAtUtc: null,
      },
      select: { id: true, catalogKey: true },
    });
    await prisma.workPreset.update({
      where: { id: canonicalPreset.id },
      data: { unitPrice: 987.65 },
    });

    const saveSetupResponse = await app.inject({
      method: "POST",
      url: "/v1/onboarding/setup",
      headers: { cookie: session.cookie },
      payload: {
        primaryTrade: "ROOFING",
        chargeBySquareFoot: false,
      },
    });
    expect(saveSetupResponse.statusCode).toBe(200);

    const [storedCustomProduct, storedCanonicalPreset, activeCanonicalPresets] = await Promise.all([
      prisma.workPreset.findUniqueOrThrow({ where: { id: customProduct.id } }),
      prisma.workPreset.findUniqueOrThrow({ where: { id: canonicalPreset.id } }),
      prisma.workPreset.findMany({
        where: {
          tenantId: session.tenantId,
          serviceType: "ROOFING",
          catalogKey: { not: null },
          deletedAtUtc: null,
        },
        select: { catalogKey: true },
      }),
    ]);

    expect(storedCustomProduct.deletedAtUtc).toBeNull();
    expect(Number(storedCanonicalPreset.unitPrice)).toBe(987.65);
    const expectedCatalogKeys = recommendedPresetsForTrade(ServiceCategory.ROOFING).flatMap((preset) =>
      preset.catalogKey ? [preset.catalogKey] : [],
    );
    expect(activeCanonicalPresets.map((preset) => preset.catalogKey).sort()).toEqual(expectedCatalogKeys.sort());
    expect(new Set(activeCanonicalPresets.map((preset) => preset.catalogKey)).size).toBe(activeCanonicalPresets.length);

    const enableSquareFootResponse = await app.inject({
      method: "POST",
      url: "/v1/onboarding/setup",
      headers: { cookie: session.cookie },
      payload: {
        primaryTrade: "ROOFING",
        chargeBySquareFoot: true,
        sqFtUnitCost: 6.25,
        sqFtUnitPrice: 13.5,
      },
    });
    expect(enableSquareFootResponse.statusCode).toBe(200);
    const enabledSquareFootPreset = await prisma.workPreset.findFirstOrThrow({
      where: {
        tenantId: session.tenantId,
        serviceType: "ROOFING",
        catalogKey: "sq_ft_base",
        deletedAtUtc: null,
      },
      select: { id: true, unitCost: true, unitPrice: true },
    });
    expect(Number(enabledSquareFootPreset.unitCost)).toBe(6.25);
    expect(Number(enabledSquareFootPreset.unitPrice)).toBe(13.5);

    const updateSquareFootResponse = await app.inject({
      method: "POST",
      url: "/v1/onboarding/setup",
      headers: { cookie: session.cookie },
      payload: {
        primaryTrade: "ROOFING",
        chargeBySquareFoot: true,
        sqFtUnitCost: 8.25,
        sqFtUnitPrice: 17.75,
      },
    });
    expect(updateSquareFootResponse.statusCode).toBe(200);
    const updatedSquareFootPreset = await prisma.workPreset.findUniqueOrThrow({
      where: { id: enabledSquareFootPreset.id },
      select: { deletedAtUtc: true, unitCost: true, unitPrice: true },
    });
    expect(updatedSquareFootPreset.deletedAtUtc).toBeNull();
    expect(Number(updatedSquareFootPreset.unitCost)).toBe(8.25);
    expect(Number(updatedSquareFootPreset.unitPrice)).toBe(17.75);

    const disableSquareFootResponse = await app.inject({
      method: "POST",
      url: "/v1/onboarding/setup",
      headers: { cookie: session.cookie },
      payload: {
        primaryTrade: "ROOFING",
        chargeBySquareFoot: false,
      },
    });
    expect(disableSquareFootResponse.statusCode).toBe(200);
    await expect(
      prisma.workPreset.findUniqueOrThrow({
        where: { id: enabledSquareFootPreset.id },
        select: { deletedAtUtc: true },
      }),
    ).resolves.toMatchObject({ deletedAtUtc: expect.any(Date) });

    const reenableSquareFootResponse = await app.inject({
      method: "POST",
      url: "/v1/onboarding/setup",
      headers: { cookie: session.cookie },
      payload: {
        primaryTrade: "ROOFING",
        chargeBySquareFoot: true,
        sqFtUnitCost: 9.25,
        sqFtUnitPrice: 19.75,
      },
    });
    expect(reenableSquareFootResponse.statusCode).toBe(200);
    const restoredSquareFootPresets = await prisma.workPreset.findMany({
      where: {
        tenantId: session.tenantId,
        serviceType: "ROOFING",
        catalogKey: "sq_ft_base",
      },
      select: { id: true, deletedAtUtc: true, unitCost: true, unitPrice: true },
    });
    expect(restoredSquareFootPresets).toHaveLength(1);
    expect(restoredSquareFootPresets[0]).toMatchObject({
      id: enabledSquareFootPreset.id,
      deletedAtUtc: null,
    });
    expect(Number(restoredSquareFootPresets[0]?.unitCost)).toBe(9.25);
    expect(Number(restoredSquareFootPresets[0]?.unitPrice)).toBe(19.75);
    await expect(
      prisma.workPreset.findUniqueOrThrow({ where: { id: customProduct.id }, select: { deletedAtUtc: true } }),
    ).resolves.toMatchObject({ deletedAtUtc: null });
  });

  test("setup enforces the 200-active limit for restores and serializes case-insensitive duplicate creates", async () => {
    const capacitySession = await signUp();
    const archived = await prisma.workPreset.create({
      data: {
        tenantId: capacitySession.tenantId,
        serviceType: "ROOFING",
        name: "Archived setup capacity service",
        category: "SERVICE",
        unitType: "FLAT",
        defaultQuantity: 1,
        unitCost: 10,
        unitPrice: 20,
        isDefault: true,
        deletedAtUtc: new Date(),
      },
    });
    await fillActiveCatalog(capacitySession.tenantId);

    const blockedRestore = await app.inject({
      method: "POST",
      url: "/v1/onboarding/setup",
      headers: { cookie: capacitySession.cookie },
      payload: {
        primaryTrade: "ROOFING",
        chargeBySquareFoot: false,
        presets: [customPresetPayload("Archived setup capacity service", archived.id)],
      },
    });
    expect(blockedRestore.statusCode, blockedRestore.body).toBe(409);
    expect(blockedRestore.json()).toMatchObject({
      code: "PRODUCT_CATALOG_LIMIT",
      activeProductCount: 200,
      maximumProductCount: 200,
    });
    await expect(
      prisma.workPreset.findUniqueOrThrow({ where: { id: archived.id }, select: { deletedAtUtc: true } }),
    ).resolves.toMatchObject({ deletedAtUtc: expect.any(Date) });

    const concurrentSession = await signUp();
    const setupRequest = (name: string) => app.inject({
      method: "POST",
      url: "/v1/onboarding/setup",
      headers: { cookie: concurrentSession.cookie },
      payload: {
        primaryTrade: "ROOFING",
        chargeBySquareFoot: false,
        presets: [customPresetPayload(name)],
      },
    });
    const responses = await Promise.all([
      setupRequest("Concurrent Setup Service"),
      setupRequest("concurrent setup service"),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    await expect(prisma.workPreset.count({
      where: {
        tenantId: concurrentSession.tenantId,
        serviceType: "ROOFING",
        catalogKey: null,
        deletedAtUtc: null,
        name: { equals: "concurrent setup service", mode: "insensitive" },
      },
    })).resolves.toBe(1);
  });

  test("preset save enforces the 200-active limit for restores and serializes case-insensitive duplicate creates", async () => {
    const capacitySession = await signUp();
    const archived = await prisma.workPreset.create({
      data: {
        tenantId: capacitySession.tenantId,
        serviceType: "ROOFING",
        name: "Archived preset capacity service",
        category: "SERVICE",
        unitType: "FLAT",
        defaultQuantity: 1,
        unitCost: 10,
        unitPrice: 20,
        isDefault: true,
        deletedAtUtc: new Date(),
      },
    });
    await fillActiveCatalog(capacitySession.tenantId);

    const blockedRestore = await app.inject({
      method: "POST",
      url: "/v1/onboarding/presets",
      headers: { cookie: capacitySession.cookie },
      payload: customPresetPayload("ARCHIVED PRESET CAPACITY SERVICE"),
    });
    expect(blockedRestore.statusCode, blockedRestore.body).toBe(409);
    expect(blockedRestore.json()).toMatchObject({
      code: "PRODUCT_CATALOG_LIMIT",
      activeProductCount: 200,
      maximumProductCount: 200,
    });
    await expect(
      prisma.workPreset.findUniqueOrThrow({ where: { id: archived.id }, select: { deletedAtUtc: true } }),
    ).resolves.toMatchObject({ deletedAtUtc: expect.any(Date) });

    const concurrentSession = await signUp();
    const presetRequest = (name: string) => app.inject({
      method: "POST",
      url: "/v1/onboarding/presets",
      headers: { cookie: concurrentSession.cookie },
      payload: customPresetPayload(name),
    });
    const responses = await Promise.all([
      presetRequest("Concurrent Preset Service"),
      presetRequest("concurrent preset service"),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    await expect(prisma.workPreset.count({
      where: {
        tenantId: concurrentSession.tenantId,
        serviceType: "ROOFING",
        catalogKey: null,
        deletedAtUtc: null,
        name: { equals: "concurrent preset service", mode: "insensitive" },
      },
    })).resolves.toBe(1);
  });

  test("legacy onboarding writes reject active starter names case-insensitively", async () => {
    const session = await signUp();
    const starter = await prisma.workPreset.findFirstOrThrow({
      where: {
        tenantId: session.tenantId,
        serviceType: "ROOFING",
        catalogKey: { not: null },
        deletedAtUtc: null,
      },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    });

    const presetResponse = await app.inject({
      method: "POST",
      url: "/v1/onboarding/presets",
      headers: { cookie: session.cookie },
      payload: customPresetPayload(starter.name.toLowerCase().replaceAll(" ", "   ")),
    });
    expect(presetResponse.statusCode).toBe(409);
    expect(presetResponse.json()).toMatchObject({
      code: "PRODUCT_NAME_CONFLICT",
      productId: starter.id,
    });

    const existingCustom = await prisma.workPreset.create({
      data: {
        tenantId: session.tenantId,
        serviceType: "ROOFING",
        name: "Setup rename source",
        category: "SERVICE",
        unitType: "FLAT",
        defaultQuantity: 1,
        unitCost: 15,
        unitPrice: 30,
        isDefault: true,
      },
    });
    const setupResponse = await app.inject({
      method: "POST",
      url: "/v1/onboarding/setup",
      headers: { cookie: session.cookie },
      payload: {
        primaryTrade: "ROOFING",
        chargeBySquareFoot: false,
        presets: [customPresetPayload(
          starter.name.toUpperCase().replaceAll(" ", "   "),
          existingCustom.id,
        )],
      },
    });
    expect(setupResponse.statusCode).toBe(409);
    expect(setupResponse.json()).toMatchObject({
      code: "PRODUCT_NAME_CONFLICT",
      productId: starter.id,
    });
    const activeCustomProducts = await prisma.workPreset.findMany({
      where: {
        tenantId: session.tenantId,
        serviceType: "ROOFING",
        catalogKey: null,
        deletedAtUtc: null,
      },
      select: { name: true },
    });
    expect(activeCustomProducts.some((product) =>
      normalizeTenantProductName(product.name) === normalizeTenantProductName(starter.name))).toBe(false);
    await expect(prisma.workPreset.findUniqueOrThrow({
      where: { id: existingCustom.id },
      select: { name: true, catalogKey: true },
    })).resolves.toEqual({ name: "Setup rename source", catalogKey: null });
  });

  test("managed square-foot activation never restores over an active normalized-name owner", async () => {
    const session = await signUp();
    const enable = await app.inject({
      method: "POST",
      url: "/v1/onboarding/setup",
      headers: { cookie: session.cookie },
      payload: {
        primaryTrade: "ROOFING",
        chargeBySquareFoot: true,
        sqFtUnitCost: 6,
        sqFtUnitPrice: 12,
      },
    });
    expect(enable.statusCode).toBe(200);
    const managed = await prisma.workPreset.findFirstOrThrow({
      where: {
        tenantId: session.tenantId,
        serviceType: "ROOFING",
        catalogKey: "sq_ft_base",
        deletedAtUtc: null,
      },
      select: { id: true, name: true },
    });
    const disable = await app.inject({
      method: "POST",
      url: "/v1/onboarding/setup",
      headers: { cookie: session.cookie },
      payload: { primaryTrade: "ROOFING", chargeBySquareFoot: false },
    });
    expect(disable.statusCode).toBe(200);

    const customCreate = await app.inject({
      method: "POST",
      url: "/v1/products",
      headers: { cookie: session.cookie },
      payload: {
        serviceType: "ROOFING",
        name: managed.name.toUpperCase().replaceAll(" ", "   "),
        category: "SERVICE",
        unitType: "SQ_FT",
        defaultQuantity: 100,
        unitCost: 8,
        unitPrice: 16,
        isDefault: true,
      },
    });
    expect(customCreate.statusCode).toBe(201);
    const customId = (customCreate.json() as { product: { id: string } }).product.id;

    const blockedReenable = await app.inject({
      method: "POST",
      url: "/v1/onboarding/setup",
      headers: { cookie: session.cookie },
      payload: {
        primaryTrade: "ROOFING",
        chargeBySquareFoot: true,
        sqFtUnitCost: 9,
        sqFtUnitPrice: 18,
      },
    });
    expect(blockedReenable.statusCode).toBe(409);
    expect(blockedReenable.json()).toMatchObject({
      code: "PRODUCT_NAME_CONFLICT",
      productId: customId,
    });
    await expect(prisma.workPreset.findUniqueOrThrow({
      where: { id: managed.id },
      select: { deletedAtUtc: true },
    })).resolves.toMatchObject({ deletedAtUtc: expect.any(Date) });
    const storedCustom = await prisma.workPreset.findUniqueOrThrow({
      where: { id: customId },
      select: { catalogKey: true, deletedAtUtc: true, unitPrice: true },
    });
    expect(storedCustom).toMatchObject({ catalogKey: null, deletedAtUtc: null });
    expect(Number(storedCustom.unitPrice)).toBe(16);

    const sameRequestSession = await signUp();
    const renameSource = await prisma.workPreset.create({
      data: {
        tenantId: sameRequestSession.tenantId,
        serviceType: "ROOFING",
        name: "Same-request rename source",
        category: "SERVICE",
        unitType: "FLAT",
        defaultQuantity: 1,
        unitCost: 10,
        unitPrice: 20,
        isDefault: true,
      },
    });
    const baselineName = "ROOFING SQ FT Base";
    const sameRequestCollision = await app.inject({
      method: "POST",
      url: "/v1/onboarding/setup",
      headers: { cookie: sameRequestSession.cookie },
      payload: {
        primaryTrade: "ROOFING",
        chargeBySquareFoot: true,
        sqFtUnitCost: 7,
        sqFtUnitPrice: 14,
        presets: [customPresetPayload(
          baselineName.toLowerCase().replaceAll(" ", "   "),
          renameSource.id,
        )],
      },
    });
    expect(sameRequestCollision.statusCode).toBe(409);
    await expect(prisma.workPreset.count({
      where: { tenantId: sameRequestSession.tenantId, catalogKey: "sq_ft_base" },
    })).resolves.toBe(0);
    await expect(prisma.workPreset.findUniqueOrThrow({
      where: { id: renameSource.id },
      select: { name: true, catalogKey: true, deletedAtUtc: true },
    })).resolves.toEqual({
      name: "Same-request rename source",
      catalogKey: null,
      deletedAtUtc: null,
    });
  });
});
