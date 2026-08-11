import type { FastifyInstance } from "fastify";
import { ServiceCategory } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildServer } from "../../src/app";
import { prisma } from "../../src/lib/prisma";
import { recommendedPresetsForTrade } from "../../src/services/onboarding";

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
});
