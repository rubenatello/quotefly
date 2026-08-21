import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildServer } from "../../src/app";
import { prisma } from "../../src/lib/prisma";

type Session = {
  cookie: string;
  tenant: { id: string };
  user: { id: string; email: string; fullName: string; preferredLocale: "en-US" | "es-US" };
};

function cookieFrom(response: { headers: Record<string, number | string | string[] | undefined> }) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error("Expected session cookie.");
  return String(value).split(";")[0] ?? String(value);
}

async function signUp(label: string, preferredLocale?: "en-US" | "es-US"): Promise<Session> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      email: `${label}-${unique}@example.com`,
      password: "TestPassword123!",
      fullName: `${label} Owner`,
      companyName: `${label} Services ${unique}`,
      primaryTrade: "CONSTRUCTION",
      ...(preferredLocale ? { preferredLocale } : {}),
      acceptedLegalTerms: true,
      termsVersion: "2026-07-30",
      privacyPolicyVersion: "2026-08-10",
    },
  });

  expect(response.statusCode).toBe(201);
  return {
    ...(response.json() as Omit<Session, "cookie">),
    cookie: cookieFrom(response),
  };
}

let app: FastifyInstance;

describe("authenticated locale preferences", () => {
  beforeAll(async () => {
    app = buildServer();
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

  test("defaults to English and persists the signed-in user's Spanish preference", async () => {
    const session = await signUp("spanish-preference");
    expect(session.user.preferredLocale).toBe("en-US");

    const initialMe = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { cookie: session.cookie },
    });
    expect(initialMe.statusCode).toBe(200);
    expect(initialMe.json()).toMatchObject({ user: { preferredLocale: "en-US" } });

    const update = await app.inject({
      method: "PATCH",
      url: "/v1/auth/me/preferences",
      headers: { cookie: session.cookie },
      payload: { preferredLocale: "es-US" },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toEqual({ preferences: { preferredLocale: "es-US" } });

    const persisted = await prisma.user.findUniqueOrThrow({
      where: { id: session.user.id },
      select: { preferredLocale: true },
    });
    expect(persisted.preferredLocale).toBe("es-US");

    const refreshedMe = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { cookie: session.cookie },
    });
    expect(refreshedMe.statusCode).toBe(200);
    expect(refreshedMe.json()).toMatchObject({ user: { preferredLocale: "es-US" } });

    const signedInAgain = await app.inject({
      method: "POST",
      url: "/v1/auth/signin",
      payload: { email: session.user.email, password: "TestPassword123!" },
    });
    expect(signedInAgain.statusCode).toBe(200);
    expect(signedInAgain.json()).toMatchObject({ user: { preferredLocale: "es-US" } });
  });

  test("persists the locale selected before account creation", async () => {
    const session = await signUp("spanish-signup", "es-US");

    expect(session.user.preferredLocale).toBe("es-US");

    const persisted = await prisma.user.findUniqueOrThrow({
      where: { id: session.user.id },
      select: { preferredLocale: true },
    });
    expect(persisted.preferredLocale).toBe("es-US");

    const me = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { cookie: session.cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { preferredLocale: "es-US" } });
  });

  test("rejects unsupported locales with a stable code and preserves the prior value", async () => {
    const session = await signUp("invalid-locale");

    const response = await app.inject({
      method: "PATCH",
      url: "/v1/auth/me/preferences",
      headers: { cookie: session.cookie },
      payload: { preferredLocale: "es-MX" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: "INVALID_AUTH_PREFERENCES",
      error: "Preferred locale must be en-US or es-US.",
    });

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: session.user.id },
      select: { preferredLocale: true },
    });
    expect(user.preferredLocale).toBe("en-US");
  });

  test("accepts no target user id and changes only the authenticated user", async () => {
    const alpha = await signUp("locale-alpha");
    const beta = await signUp("locale-beta");

    const injectionAttempt = await app.inject({
      method: "PATCH",
      url: "/v1/auth/me/preferences",
      headers: { cookie: alpha.cookie },
      payload: { preferredLocale: "es-US", userId: beta.user.id },
    });
    expect(injectionAttempt.statusCode).toBe(400);
    expect(injectionAttempt.json()).toMatchObject({ code: "INVALID_AUTH_PREFERENCES" });

    const validUpdate = await app.inject({
      method: "PATCH",
      url: "/v1/auth/me/preferences",
      headers: { cookie: alpha.cookie },
      payload: { preferredLocale: "es-US" },
    });
    expect(validUpdate.statusCode).toBe(200);

    const [alphaUser, betaUser] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: alpha.user.id }, select: { preferredLocale: true } }),
      prisma.user.findUniqueOrThrow({ where: { id: beta.user.id }, select: { preferredLocale: true } }),
    ]);
    expect(alphaUser.preferredLocale).toBe("es-US");
    expect(betaUser.preferredLocale).toBe("en-US");

    const unauthenticated = await app.inject({
      method: "PATCH",
      url: "/v1/auth/me/preferences",
      payload: { preferredLocale: "es-US" },
    });
    expect(unauthenticated.statusCode).toBe(401);
  });
});
