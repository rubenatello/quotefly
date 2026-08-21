import type { FastifyInstance } from "fastify";
import { inflateSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildServer } from "../../src/app";
import { prisma } from "../../src/lib/prisma";

type Session = {
  cookie: string;
  tenant: { id: string };
  user: { id: string; email: string; fullName: string };
};

function cookieFrom(response: { headers: Record<string, number | string | string[] | undefined> }) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error("Expected session cookie.");
  return String(value).split(";")[0] ?? String(value);
}

async function signUp(label: string): Promise<Session> {
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
      acceptedLegalTerms: true,
      termsVersion: "2026-07-30",
      privacyPolicyVersion: "2026-08-10",
    },
  });
  expect(response.statusCode).toBe(201);
  return { ...(response.json() as Omit<Session, "cookie">), cookie: cookieFrom(response) };
}

async function addMember(owner: Session): Promise<Session> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `locale-member-${unique}@example.com`;
  const password = "WorkspacePassword123!";
  const created = await app.inject({
    method: "POST",
    url: "/v1/org/users",
    headers: { cookie: owner.cookie },
    payload: { email, password, fullName: "Field Member", role: "member" },
  });
  expect(created.statusCode).toBe(201);
  const signedIn = await app.inject({
    method: "POST",
    url: "/v1/auth/signin",
    payload: { email, password },
  });
  expect(signedIn.statusCode).toBe(200);
  return { ...(signedIn.json() as Omit<Session, "cookie">), cookie: cookieFrom(signedIn) };
}

async function createCustomer(session: Session, preferredLocale?: "en-US" | "es-US" | null) {
  const suffix = Math.random().toString().slice(2, 12);
  const response = await app.inject({
    method: "POST",
    url: "/v1/customers",
    headers: { cookie: session.cookie },
    payload: {
      fullName: `Locale Customer ${suffix}`,
      phone: `555${suffix.slice(0, 7).padEnd(7, "0")}`,
      preferredLocale,
    },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { customer: { id: string } }).customer;
}

async function createQuote(
  session: Session,
  customerId: string,
  documentLocale?: "en-US" | "es-US",
  internalCostSubtotal = 400,
) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/quotes",
    headers: { cookie: session.cookie },
    payload: {
      customerId,
      serviceType: "CONSTRUCTION",
      title: "Reparación del jardín",
      scopeText: "Instalar césped y limpiar el área.",
      internalCostSubtotal,
      customerPriceSubtotal: 900,
      taxAmount: 0,
      documentLocale,
    },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { quote: { id: string; documentLocale: string } }).quote;
}

function extractPdfText(pdf: Buffer): string {
  const source = pdf.toString("latin1");
  const contentStreams: string[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const marker = /stream\r?\n/g;
    marker.lastIndex = cursor;
    const match = marker.exec(source);
    if (!match) break;

    const streamStart = match.index + match[0].length;
    const streamEnd = source.indexOf("endstream", streamStart);
    if (streamEnd < 0) break;
    const dictionaryStart = source.lastIndexOf("<<", match.index);
    const dictionaryEnd = source.lastIndexOf(">>", match.index);
    const dictionary =
      dictionaryStart >= 0 && dictionaryEnd > dictionaryStart
        ? source.slice(dictionaryStart, dictionaryEnd + 2)
        : "";

    let streamBuffer = pdf.subarray(streamStart, streamEnd);
    while (
      streamBuffer.length > 0 &&
      (streamBuffer.at(-1) === 0x0a || streamBuffer.at(-1) === 0x0d)
    ) {
      streamBuffer = streamBuffer.subarray(0, -1);
    }

    try {
      const decoded =
        dictionary.includes("/FlateDecode")
          ? inflateSync(streamBuffer).toString("latin1")
          : streamBuffer.toString("latin1");
      if (decoded.includes("BT")) contentStreams.push(decoded);
    } catch {
      // Image and font streams are not needed for customer-visible text assertions.
    }
    cursor = streamEnd + "endstream".length;
  }

  const textRuns: string[] = [];
  for (const content of contentStreams) {
    for (const textArray of content.matchAll(/\[((?:.|\r|\n)*?)\]\s*TJ/g)) {
      const fragments = Array.from(textArray[1].matchAll(/<([0-9a-fA-F]+)>/g), (fragment) =>
        Buffer.from(fragment[1], "hex").toString("latin1"),
      );
      if (fragments.length > 0) textRuns.push(fragments.join(""));
    }
  }

  return textRuns.join("\n");
}

let app: FastifyInstance;

describe("customer document locale", () => {
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

  test("uses explicit quote, customer, tenant, then English locale precedence", async () => {
    const owner = await signUp("document-locale");
    const branding = await app.inject({
      method: "PUT",
      url: `/v1/tenants/${owner.tenant.id}/branding`,
      headers: { cookie: owner.cookie },
      payload: {
        primaryColor: "#2a7fd8",
        templateId: "modern",
        logoPosition: "left",
        timezone: "America/Los_Angeles",
        defaultCustomerLocale: "es-US",
        businessProfile: {},
      },
    });
    expect(branding.statusCode).toBe(200);
    expect(branding.json()).toMatchObject({ tenant: { defaultCustomerLocale: "es-US" } });

    const workspaceDefaultCustomer = await createCustomer(owner, null);
    const workspaceDefaultQuote = await createQuote(owner, workspaceDefaultCustomer.id);
    expect(workspaceDefaultQuote.documentLocale).toBe("es-US");

    const EnglishCustomer = await createCustomer(owner, "en-US");
    const customerDefaultQuote = await createQuote(owner, EnglishCustomer.id);
    expect(customerDefaultQuote.documentLocale).toBe("en-US");

    const explicitQuote = await createQuote(owner, EnglishCustomer.id, "es-US");
    expect(explicitQuote.documentLocale).toBe("es-US");
  });

  test("locks the locale after send and snapshots the sent document locale", async () => {
    const owner = await signUp("sent-locale");
    const customer = await createCustomer(owner, "es-US");
    const quote = await createQuote(owner, customer.id);

    const sent = await app.inject({
      method: "PATCH",
      url: `/v1/quotes/${quote.id}`,
      headers: { cookie: owner.cookie },
      payload: { status: "SENT_TO_CUSTOMER", documentLocale: "es-US" },
    });
    expect(sent.statusCode).toBe(200);

    const revision = await prisma.quoteRevision.findFirstOrThrow({
      where: { quoteId: quote.id, status: "SENT_TO_CUSTOMER" },
      orderBy: { version: "desc" },
      select: { snapshot: true },
    });
    expect(revision.snapshot).toMatchObject({
      quote: { documentLocale: "es-US" },
      document: { locale: "es-US" },
    });

    const locked = await app.inject({
      method: "PATCH",
      url: `/v1/quotes/${quote.id}`,
      headers: { cookie: owner.cookie },
      payload: { documentLocale: "en-US" },
    });
    expect(locked.statusCode).toBe(409);
    expect(locked.json()).toMatchObject({ code: "QUOTE_DOCUMENT_LOCALE_LOCKED" });
  });

  test("denies cross-tenant locale mutations and leaves every target record unchanged", async () => {
    const victim = await signUp("locale-victim");
    const attacker = await signUp("locale-attacker");
    const customer = await createCustomer(victim, "es-US");
    const quote = await createQuote(victim, customer.id, "es-US");

    const before = await Promise.all([
      prisma.tenant.findUniqueOrThrow({
        where: { id: victim.tenant.id },
        select: { defaultCustomerLocale: true, updatedAt: true },
      }),
      prisma.customer.findUniqueOrThrow({
        where: { id: customer.id },
        select: { preferredLocale: true, updatedAt: true },
      }),
      prisma.quote.findUniqueOrThrow({
        where: { id: quote.id },
        select: { documentLocale: true, updatedAt: true },
      }),
    ]);

    const tenantAttempt = await app.inject({
      method: "PUT",
      url: `/v1/tenants/${victim.tenant.id}/branding`,
      headers: { cookie: attacker.cookie },
      payload: {
        primaryColor: "#ff6b1a",
        templateId: "modern",
        logoPosition: "left",
        timezone: "UTC",
        defaultCustomerLocale: "es-US",
        businessProfile: {},
      },
    });
    expect(tenantAttempt.statusCode).toBe(403);

    const customerAttempt = await app.inject({
      method: "PATCH",
      url: `/v1/customers/${customer.id}`,
      headers: { cookie: attacker.cookie },
      payload: { preferredLocale: "en-US" },
    });
    expect(customerAttempt.statusCode).toBe(404);

    const quoteAttempt = await app.inject({
      method: "PATCH",
      url: `/v1/quotes/${quote.id}`,
      headers: { cookie: attacker.cookie },
      payload: { documentLocale: "en-US" },
    });
    expect(quoteAttempt.statusCode).toBe(404);

    const after = await Promise.all([
      prisma.tenant.findUniqueOrThrow({
        where: { id: victim.tenant.id },
        select: { defaultCustomerLocale: true, updatedAt: true },
      }),
      prisma.customer.findUniqueOrThrow({
        where: { id: customer.id },
        select: { preferredLocale: true, updatedAt: true },
      }),
      prisma.quote.findUniqueOrThrow({
        where: { id: quote.id },
        select: { documentLocale: true, updatedAt: true },
      }),
    ]);
    expect(after).toEqual(before);
    expect(after[0].defaultCustomerLocale).toBe("en-US");
    expect(after[1].preferredLocale).toBe("es-US");
    expect(after[2].documentLocale).toBe("es-US");
  });

  test("serves the immutable Spanish sent PDF without exposing internal costs", async () => {
    const internalCostSentinel = 4_321.09;
    const owner = await signUp("spanish-sent-pdf");
    const originalBranding = await app.inject({
      method: "PUT",
      url: `/v1/tenants/${owner.tenant.id}/branding`,
      headers: { cookie: owner.cookie },
      payload: {
        businessName: "Servicios Originales",
        primaryColor: "#1d4ed8",
        templateId: "modern",
        logoPosition: "left",
        timezone: "America/Los_Angeles",
        defaultCustomerLocale: "es-US",
        businessProfile: { businessEmail: "original@example.com" },
      },
    });
    expect(originalBranding.statusCode).toBe(200);

    const customer = await createCustomer(owner, "es-US");
    const namedCustomer = await app.inject({
      method: "PATCH",
      url: `/v1/customers/${customer.id}`,
      headers: { cookie: owner.cookie },
      payload: { fullName: "José Cliente" },
    });
    expect(namedCustomer.statusCode).toBe(200);

    const quote = await createQuote(owner, customer.id, "es-US", internalCostSentinel);
    const sent = await app.inject({
      method: "PATCH",
      url: `/v1/quotes/${quote.id}`,
      headers: { cookie: owner.cookie },
      payload: { status: "SENT_TO_CUSTOMER" },
    });
    expect(sent.statusCode).toBe(200);

    const sentRevision = await prisma.quoteRevision.findFirstOrThrow({
      where: {
        tenantId: owner.tenant.id,
        quoteId: quote.id,
        status: "SENT_TO_CUSTOMER",
        changedFields: { has: "documentSnapshot" },
      },
      orderBy: { version: "desc" },
      select: { id: true, snapshot: true },
    });
    expect(sentRevision.snapshot).toMatchObject({
      customer: { fullName: "José Cliente" },
      quote: { documentLocale: "es-US" },
      document: {
        locale: "es-US",
        tenant: { name: "Servicios Originales", timezone: "America/Los_Angeles" },
        branding: { primaryColor: "#1d4ed8", businessEmail: "original@example.com" },
      },
    });

    const originalPdf = await app.inject({
      method: "GET",
      url: `/v1/quotes/${quote.id}/pdf?download=false`,
      headers: { cookie: owner.cookie },
    });
    expect(originalPdf.statusCode).toBe(200);
    expect(originalPdf.headers["content-type"]).toContain("application/pdf");

    const originalText = extractPdfText(originalPdf.rawPayload).replace(/\s+/g, " ");
    expect(originalText).toMatch(/Cotización para el cliente/);
    expect(originalText).toMatch(/José Cliente/);
    expect(originalText).toMatch(/Servicios Originales/);
    expect(originalText).not.toMatch(/Internal cost|Costo interno|\$4,321\.09|4321\.09/i);
    expect(originalPdf.rawPayload.toString("latin1")).not.toMatch(
      /Internal cost|Costo interno|\$4,321\.09|4321\.09/i,
    );

    const changedBranding = await app.inject({
      method: "PUT",
      url: `/v1/tenants/${owner.tenant.id}/branding`,
      headers: { cookie: owner.cookie },
      payload: {
        businessName: "Changed Services",
        primaryColor: "#b91c1c",
        templateId: "minimal",
        logoPosition: "right",
        timezone: "UTC",
        defaultCustomerLocale: "en-US",
        businessProfile: { businessEmail: "changed@example.com" },
      },
    });
    expect(changedBranding.statusCode).toBe(200);

    const changedCustomer = await app.inject({
      method: "PATCH",
      url: `/v1/customers/${customer.id}`,
      headers: { cookie: owner.cookie },
      payload: { fullName: "Changed Customer", preferredLocale: "en-US" },
    });
    expect(changedCustomer.statusCode).toBe(200);

    const current = await Promise.all([
      prisma.tenant.findUniqueOrThrow({
        where: { id: owner.tenant.id },
        select: { name: true, timezone: true, defaultCustomerLocale: true },
      }),
      prisma.customer.findUniqueOrThrow({
        where: { id: customer.id },
        select: { fullName: true, preferredLocale: true },
      }),
    ]);
    expect(current).toEqual([
      { name: "Changed Services", timezone: "UTC", defaultCustomerLocale: "en-US" },
      { fullName: "Changed Customer", preferredLocale: "en-US" },
    ]);

    const preservedPdf = await app.inject({
      method: "GET",
      url: `/v1/quotes/${quote.id}/pdf?download=false`,
      headers: { cookie: owner.cookie },
    });
    expect(preservedPdf.statusCode).toBe(200);
    expect(preservedPdf.rawPayload).toEqual(originalPdf.rawPayload);
    expect(extractPdfText(preservedPdf.rawPayload).replace(/\s+/g, " ")).toEqual(originalText);

    const preservedRevision = await prisma.quoteRevision.findUniqueOrThrow({
      where: { id: sentRevision.id },
      select: { snapshot: true },
    });
    expect(preservedRevision.snapshot).toEqual(sentRevision.snapshot);
  });

  test("members cannot mutate workspace branding or its document-language default", async () => {
    const owner = await signUp("branding-owner-only");
    const member = await addMember(owner);

    const response = await app.inject({
      method: "PUT",
      url: `/v1/tenants/${owner.tenant.id}/branding`,
      headers: { cookie: member.cookie },
      payload: {
        primaryColor: "#ff6b1a",
        templateId: "modern",
        logoPosition: "left",
        timezone: "UTC",
        defaultCustomerLocale: "es-US",
        businessProfile: {},
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "BRANDING_ADMIN_REQUIRED" });

    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: owner.tenant.id },
      select: { defaultCustomerLocale: true },
    });
    expect(tenant.defaultCustomerLocale).toBe("en-US");
  });
});
