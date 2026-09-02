import { randomBytes, randomUUID } from "node:crypto";

const baseUrl = (process.env.QF_STAGING_API_URL ?? "https://api-staging.quotefly.us").replace(/\/$/, "");
if (baseUrl !== "https://api-staging.quotefly.us") {
  console.error("QuickBooks OAuth smoke testing is restricted to the approved staging API.");
  process.exit(1);
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const unique = `${Date.now()}-${randomBytes(4).toString("hex")}`;
const signupResponse = await fetch(`${baseUrl}/v1/auth/signup`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email: `qf-oauth-${unique}@example.com`,
    password: `${randomBytes(24).toString("base64url")}Aa1!`,
    fullName: "Staging OAuth Owner",
    companyName: `QuoteFly OAuth Sandbox ${unique}`,
    primaryTrade: "CONSTRUCTION",
    acceptedLegalTerms: true,
    termsVersion: "2026-07-30",
    privacyPolicyVersion: "2026-08-10",
  }),
});
await readJson(signupResponse);

const setCookies = typeof signupResponse.headers.getSetCookie === "function"
  ? signupResponse.headers.getSetCookie()
  : [signupResponse.headers.get("set-cookie")].filter(Boolean);
const sessionCookie = setCookies
  .map((cookie) => cookie.split(";", 1)[0])
  .find((cookie) => cookie.includes("="));
if (signupResponse.status !== 201 || !sessionCookie) {
  console.error(`Staging signup failed (HTTP ${signupResponse.status}).`);
  process.exit(1);
}

async function apiRequest(path, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      cookie: sessionCookie,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  return { status: response.status, body: await readJson(response) };
}

const status = await apiRequest("/v1/integrations/quickbooks/status");
const customerSearch = await apiRequest(
  "/v1/integrations/quickbooks/mappings/customers/search",
  { method: "POST", body: { query: "Test customer", limit: 5 } },
);
const invoicePublish = await apiRequest(
  "/v1/integrations/quickbooks/invoices/staging-not-found/publish",
  {
    method: "POST",
    headers: { "idempotency-key": randomUUID() },
    body: {
      invoiceVersion: 1,
      reviewBinding: randomBytes(32).toString("base64url"),
      billingEmail: null,
      allowOnlineAchPayment: false,
      allowOnlineCardPayment: false,
    },
  },
);
const connect = await apiRequest("/v1/integrations/quickbooks/connect", {
  method: "POST",
  body: {},
});

let authorizationUrl = null;
try {
  authorizationUrl = new URL(connect.body?.authorizationUrl);
} catch {
  // The assertions below report a stable failure without printing provider data.
}
const decodedQuery = authorizationUrl ? decodeURIComponent(authorizationUrl.search) : "";
const state = authorizationUrl?.searchParams.get("state") ?? "";

const evidence = {
  signup: signupResponse.status,
  quickbooksStatus: status.status,
  initiallyConnected: status.body?.connection !== null,
  setupConfirmed: status.body?.setup?.confirmed === true,
  customerSearchBeforeOAuth: customerSearch.status,
  customerSearchCode: customerSearch.body?.code ?? null,
  invoicePublishWithRuntimeOff: invoicePublish.status,
  invoicePublishCode: invoicePublish.body?.code ?? null,
  connect: connect.status,
  authorizationHost: authorizationUrl?.host ?? null,
  authorizationPath: authorizationUrl?.pathname ?? null,
  hasClientId: Boolean(authorizationUrl?.searchParams.get("client_id")),
  hasState: state.length >= 32,
  hasAccountingScope: decodedQuery.includes("com.intuit.quickbooks.accounting"),
  usesExactStagingCallback: decodedQuery.includes(
    "https://api-staging.quotefly.us/v1/integrations/quickbooks/callback",
  ),
  authorizationUrlPrinted: false,
  disposableCredentialsPrinted: false,
};

console.log(JSON.stringify(evidence));

const expected = {
  signup: 201,
  quickbooksStatus: 200,
  initiallyConnected: false,
  setupConfirmed: false,
  customerSearchBeforeOAuth: 503,
  customerSearchCode: "QUICKBOOKS_OAUTH_ONLY_MODE",
  invoicePublishWithRuntimeOff: 503,
  invoicePublishCode: "QUICKBOOKS_OAUTH_ONLY_MODE",
  connect: 200,
  authorizationHost: "appcenter.intuit.com",
  authorizationPath: "/connect/oauth2",
  hasClientId: true,
  hasState: true,
  hasAccountingScope: true,
  usesExactStagingCallback: true,
  authorizationUrlPrinted: false,
  disposableCredentialsPrinted: false,
};

for (const [key, value] of Object.entries(expected)) {
  if (evidence[key] !== value) {
    console.error(`Staging OAuth smoke assertion failed: ${key}.`);
    process.exit(1);
  }
}
