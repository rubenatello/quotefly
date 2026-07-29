import { expect, type APIRequestContext, type APIResponse, type BrowserContext, type Page } from "@playwright/test";

export const apiBaseUrl =
  process.env.E2E_API_URL || `http://127.0.0.1:${process.env.E2E_API_PORT || "4100"}`;

const sessionCookieName = process.env.SESSION_COOKIE_NAME || "qf_session";

export type E2eAccount = {
  email: string;
  password: string;
  cookieHeader: string;
  cookieName: string;
  cookieValue: string;
  user: {
    id: string;
    email: string;
    fullName: string;
  };
  tenant: {
    id: string;
    name: string;
    slug: string;
  };
};

type Customer = {
  id: string;
  fullName: string;
  phone: string;
  email?: string | null;
};

type Quote = {
  id: string;
  customerId: string;
  title: string;
  scopeText: string;
  status: string;
  totalAmount: number | string;
  lineItems?: Array<{ id: string; description: string }>;
};

export function uniqueRunLabel(prefix: string) {
  const safePrefix =
    prefix
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "run";
  return `${safePrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractSessionCookie(response: APIResponse) {
  const setCookie =
    response.headersArray().find((header) => header.name.toLowerCase() === "set-cookie")?.value ??
    response.headers()["set-cookie"];

  if (!setCookie) {
    throw new Error("Expected API auth response to set a session cookie.");
  }

  const cookieHeader = setCookie.split(";")[0] ?? setCookie;
  const [cookieName, ...cookieValueParts] = cookieHeader.split("=");
  const cookieValue = cookieValueParts.join("=");

  if (!cookieName || !cookieValue) {
    throw new Error("Session cookie was malformed.");
  }

  return { cookieHeader, cookieName, cookieValue };
}

async function expectStatus(response: APIResponse, expectedStatus: number) {
  if (response.status() !== expectedStatus) {
    throw new Error(
      `Expected ${expectedStatus} from ${response.url()}, got ${response.status()}: ${await response.text()}`,
    );
  }
}

export async function signUpViaApi(request: APIRequestContext, prefix = "beta"): Promise<E2eAccount> {
  const label = uniqueRunLabel(prefix);
  const password = "TestPassword123!";
  const email = `${label}@example.com`;
  const response = await request.post(`${apiBaseUrl}/v1/auth/signup`, {
    data: {
      email,
      password,
      fullName: "Beta Test Owner",
      companyName: `QuoteFly Beta ${label}`,
      primaryTrade: "ROOFING",
      generateLogoIfMissing: false,
    },
  });

  await expectStatus(response, 201);

  const payload = (await response.json()) as Pick<E2eAccount, "user" | "tenant">;
  const cookie = extractSessionCookie(response);

  return {
    email,
    password,
    ...cookie,
    ...payload,
  };
}

export async function addSessionCookie(context: BrowserContext, account: E2eAccount) {
  await context.addCookies([
    {
      name: account.cookieName,
      value: account.cookieValue,
      url: apiBaseUrl,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
}

export async function expectNoFrontendJwtStorage(page: Page) {
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("qf_token")))
    .toBeNull();
}

export async function expectSessionCookiePresent(context: BrowserContext) {
  const cookies = await context.cookies(apiBaseUrl);
  const sessionCookie = cookies.find((cookie) => cookie.name === sessionCookieName);

  expect(sessionCookie, "Expected browser context to contain the HttpOnly API session cookie.").toBeTruthy();
  expect(sessionCookie?.httpOnly).toBe(true);
}

export async function expectSessionCookieCleared(context: BrowserContext) {
  await expect
    .poll(async () => {
      const cookies = await context.cookies(apiBaseUrl);
      return cookies.some((cookie) => cookie.name === sessionCookieName);
    })
    .toBe(false);
}

export async function createCustomerViaApi(
  request: APIRequestContext,
  account: E2eAccount,
  overrides: Partial<Customer> = {},
) {
  const label = uniqueRunLabel("customer");
  const response = await request.post(`${apiBaseUrl}/v1/customers`, {
    headers: { Cookie: account.cookieHeader },
    data: {
      fullName: overrides.fullName ?? `Beta Customer ${label}`,
      phone: overrides.phone ?? `555-01${Math.floor(1000 + Math.random() * 8999)}`,
      email: overrides.email ?? `${label}@example.com`,
      notes: "Seeded by Playwright launch smoke.",
    },
  });

  await expectStatus(response, 201);
  const payload = (await response.json()) as { customer: Customer };
  return payload.customer;
}

export async function createQuoteViaApi(
  request: APIRequestContext,
  account: E2eAccount,
  customerId: string,
  overrides: Partial<Quote> = {},
) {
  const label = uniqueRunLabel("quote");
  const customerPriceSubtotal = 1485;
  const taxAmount = 115;
  const response = await request.post(`${apiBaseUrl}/v1/quotes`, {
    headers: { Cookie: account.cookieHeader },
    data: {
      customerId,
      serviceType: "ROOFING",
      title: overrides.title ?? `Beta Roof Repair ${label}`,
      scopeText: "Repair leak, replace damaged flashing, seal exposed fasteners, and clean the work area.",
      internalCostSubtotal: 720,
      customerPriceSubtotal,
      taxAmount,
      lineItems: [
        {
          description: "Leak repair and flashing reset",
          quantity: 1,
          unitCost: 520,
          unitPrice: 1185,
        },
        {
          description: "Cleanup and disposal",
          quantity: 1,
          unitCost: 200,
          unitPrice: 300,
        },
      ],
    },
  });

  await expectStatus(response, 201);
  const payload = (await response.json()) as { quote: Quote };
  return payload.quote;
}

export async function getQuoteViaApi(
  request: APIRequestContext,
  account: E2eAccount,
  quoteId: string,
) {
  const response = await request.get(`${apiBaseUrl}/v1/quotes/${quoteId}`, {
    headers: { Cookie: account.cookieHeader },
  });

  await expectStatus(response, 200);
  const payload = (await response.json()) as { quote: Quote };
  return payload.quote;
}

export async function createOutboundEventViaApi(
  request: APIRequestContext,
  account: E2eAccount,
  quoteId: string,
) {
  const response = await request.post(`${apiBaseUrl}/v1/quotes/${quoteId}/outbound-events`, {
    headers: { Cookie: account.cookieHeader },
    data: {
      channel: "EMAIL_APP",
      destination: account.email,
      subject: "QuoteFly beta smoke quote",
      body: "This outbound event was seeded by Playwright for launch readiness.",
    },
  });

  await expectStatus(response, 201);
}

export async function expectPdfResponseSucceeds(
  request: APIRequestContext,
  account: E2eAccount,
  quoteId: string,
) {
  const response = await request.get(`${apiBaseUrl}/v1/quotes/${quoteId}/pdf?download=false`, {
    headers: { Cookie: account.cookieHeader },
  });

  await expectStatus(response, 200);
  expect(response.headers()["content-type"]).toContain("application/pdf");
  expect((await response.body()).length).toBeGreaterThan(1_000);
}
