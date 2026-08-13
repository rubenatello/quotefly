import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEnv } from "../../src/config/env.js";
import {
  CURRENT_PRIVACY_POLICY_VERSION as API_PRIVACY_POLICY_VERSION,
  CURRENT_TERMS_VERSION as API_TERMS_VERSION,
} from "../../src/lib/legal.js";
import { generateQuotePdfBuffer } from "../../src/services/quote-pdf.js";
import { buildQuickBooksInvoiceCsv } from "../../src/services/quickbooks-csv.js";
import {
  CURRENT_PRIVACY_POLICY_VERSION as WEB_PRIVACY_POLICY_VERSION,
  CURRENT_TERMS_VERSION as WEB_TERMS_VERSION,
} from "../../web/src/lib/legal.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("security boundary helpers", () => {
  const productionDatabaseEnv = {
    DATABASE_URL: "postgresql://quotefly_runtime:test@example.invalid/quotefly",
  } as const;

  it("keeps browser and API legal acceptance versions synchronized", () => {
    expect(WEB_TERMS_VERSION).toBe(API_TERMS_VERSION);
    expect(WEB_PRIVACY_POLICY_VERSION).toBe(API_PRIVACY_POLICY_VERSION);
  });

  it("rejects production cross-site session cookies until CSRF protection exists", () => {
    expect(() =>
      parseEnv({
        ...process.env,
        NODE_ENV: "production",
        ...productionDatabaseEnv,
        JWT_SECRET: "unique-production-jwt-secret-that-is-long-enough",
        APP_URL: "https://app.quotefly.example",
        API_URL: "https://api.quotefly.example",
        SESSION_COOKIE_SAME_SITE: "none",
        ENABLE_TWILIO_SMS: "false",
      }),
    ).toThrow(/explicit CSRF protection/i);
  });

  it("rejects production Twilio enablement until sender authorization exists", () => {
    expect(() =>
      parseEnv({
        ...process.env,
        NODE_ENV: "production",
        ...productionDatabaseEnv,
        JWT_SECRET: "unique-production-jwt-secret-that-is-long-enough",
        APP_URL: "https://app.quotefly.example",
        API_URL: "https://api.quotefly.example",
        SESSION_COOKIE_SAME_SITE: "lax",
        ENABLE_TWILIO_SMS: "true",
        TWILIO_WEBHOOK_AUTH_TOKEN: "configured-verifier",
      }),
    ).toThrow(/until sender authorization is implemented/i);
  });

  it("requires HTTPS for production app and API URLs", () => {
    expect(() =>
      parseEnv({
        ...process.env,
        NODE_ENV: "production",
        ...productionDatabaseEnv,
        JWT_SECRET: "unique-production-jwt-secret-that-is-long-enough",
        APP_URL: "http://app.quotefly.example",
        API_URL: "https://api.quotefly.example",
        SESSION_COOKIE_SAME_SITE: "lax",
        ENABLE_TWILIO_SMS: "false",
      }),
    ).toThrow(/APP_URL must use HTTPS/i);

    expect(() =>
      parseEnv({
        ...process.env,
        NODE_ENV: "production",
        ...productionDatabaseEnv,
        JWT_SECRET: "unique-production-jwt-secret-that-is-long-enough",
        APP_URL: "https://app.quotefly.example",
        API_URL: "http://api.quotefly.example",
        SESSION_COOKIE_SAME_SITE: "lax",
        ENABLE_TWILIO_SMS: "false",
      }),
    ).toThrow(/API_URL must use HTTPS/i);
  });

  it("requires production URLs to be bare trusted origins", () => {
    for (const APP_URL of [
      "https://user:secret@app.quotefly.example",
      "https://app.quotefly.example/reset-password",
      "https://app.quotefly.example?redirect=attacker",
      "https://app.quotefly.example#fragment",
    ]) {
      expect(() =>
        parseEnv({
          ...process.env,
          NODE_ENV: "production",
          ...productionDatabaseEnv,
          JWT_SECRET: "unique-production-jwt-secret-that-is-long-enough",
          APP_URL,
          API_URL: "https://api.quotefly.example",
          SESSION_COOKIE_SAME_SITE: "lax",
          ENABLE_TWILIO_SMS: "false",
        }),
      ).toThrow(/bare production origin/i);
    }
  });

  it("fails production startup when paid billing or password recovery is not configured", () => {
    const productionEnv = {
      ...process.env,
      NODE_ENV: "production",
      ...productionDatabaseEnv,
      JWT_SECRET: "unique-production-jwt-secret-that-is-long-enough",
      APP_URL: "https://app.quotefly.example",
      API_URL: "https://api.quotefly.example",
      SESSION_COOKIE_SAME_SITE: "lax",
      ENABLE_TWILIO_SMS: "false",
      STRIPE_SECRET_KEY: "sk_live_quotefly_test_value",
      STRIPE_WEBHOOK_SECRET: "whsec_quotefly_test_value",
      STRIPE_PRICE_ID_STARTER: "price_quotefly_basic",
      STRIPE_PRICE_ID_PROFESSIONAL: "",
      STRIPE_PRICE_ID_ENTERPRISE: "",
      RESEND_API_KEY: "re_quotefly_test_value",
      PASSWORD_RESET_EMAIL_FROM: "QuoteFly <support@quotefly.example>",
    } satisfies NodeJS.ProcessEnv;

    expect(() => parseEnv(productionEnv)).not.toThrow();
    expect(() => parseEnv({ ...productionEnv, DATABASE_URL: "postgresql://migration_owner:test@example.invalid/quotefly" })).toThrow(
      /dedicated quotefly_runtime role/i,
    );
    expect(() => parseEnv({
      ...productionEnv,
      DIRECT_DATABASE_URL: "postgresql://migration_owner:test@example.invalid/quotefly",
    })).toThrow(/must not be present in the production API runtime/i);
    expect(() => parseEnv({ ...productionEnv, STRIPE_WEBHOOK_SECRET: "" })).toThrow(
      /STRIPE_WEBHOOK_SECRET must be configured for a paid production launch/i,
    );
    expect(() => parseEnv({ ...productionEnv, RESEND_API_KEY: "", PASSWORD_RESET_EMAIL_FROM: "" })).toThrow(
      /RESEND_API_KEY must be configured for a paid production launch/i,
    );
    expect(() =>
      parseEnv({
        ...productionEnv,
        STRIPE_PRICE_ID_PROFESSIONAL: productionEnv.STRIPE_PRICE_ID_STARTER,
      }),
    ).toThrow(/Stripe plan price ids must be unique/i);
  });

  it("neutralizes spreadsheet formulas in tenant-controlled QuickBooks CSV cells", () => {
    const csv = buildQuickBooksInvoiceCsv(
      [
        {
          id: "quote-security-test",
          title: "=HYPERLINK(\"https://attacker.invalid\")",
          serviceType: "@malicious",
          status: "ACCEPTED",
          scopeText: "scope",
          customerPriceSubtotal: 100,
          taxAmount: 8,
          totalAmount: 108,
          createdAt: new Date("2026-07-29T00:00:00.000Z"),
          customer: {
            fullName: "+SUM(1,1)",
            email: "-cmd@example.invalid",
            phone: "\t=1+1",
          },
          lineItems: [{ description: "=WEBSERVICE(\"https://attacker.invalid\")", quantity: 2, unitPrice: 50 }],
        },
      ],
      { exportedAt: new Date("2026-07-29T00:00:00.000Z") },
    );

    expect(csv).toContain("\"'+SUM(1,1)\"");
    expect(csv).toContain("'-cmd@example.invalid");
    expect(csv).toContain("'\t=1+1");
    expect(csv).toContain("'@malicious Service");
    expect(csv).toContain("\"'=WEBSERVICE(\"\"https://attacker.invalid\"\")\"");
    expect(csv).toContain(",2.00,50.00,100.00,8.00,108.00,");
  });

  it("does not fetch a tenant-controlled remote logo while rendering a quote PDF", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("remote logo fetch must not occur");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const pdf = await generateQuotePdfBuffer({
      quoteId: "quote-security-test",
      serviceType: "General",
      status: "DRAFT",
      title: "Safe quote",
      scopeText: "Scoped work",
      createdAt: new Date("2026-07-29T00:00:00.000Z"),
      sentAt: null,
      customerPriceSubtotal: 100,
      taxAmount: 8,
      totalAmount: 108,
      customer: { fullName: "Customer", email: null, phone: "5555550100" },
      tenant: { name: "Tenant", timezone: "UTC" },
      branding: {
        templateId: "modern",
        primaryColor: "#2563eb",
        logoUrl: "http://169.254.169.254/latest/meta-data/",
        showQuoteFlyAttribution: false,
      },
      lineItems: [{ description: "Work", quantity: 1, unitPrice: 100 }],
    });

    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
