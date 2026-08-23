import assert from "node:assert/strict";
import test from "node:test";
import { api, apiTelemetryRoute } from "../src/lib/api";

test("api telemetry route labels remove identifiers and query strings", () => {
  assert.equal(
    apiTelemetryRoute("/v1/customers/cus_1234567890abcdef/activity?search=Ruben&phone=555"),
    "/v1/customers/:id/activity",
  );
  assert.equal(
    apiTelemetryRoute("https://api.quotefly.us/v1/quotes/qte_1234567890abcdef/line-items/item_abcdef1234567890"),
    "/v1/quotes/:id/line-items/:id",
  );
  assert.equal(
    apiTelemetryRoute("/v1/quotes?search=asphalt%20roof&customer=ruben@example.com"),
    "/v1/quotes",
  );
  assert.equal(
    apiTelemetryRoute("/v1/customers/cus_1234567890abcdef"),
    "/v1/customers/:id",
  );
  assert.equal(
    apiTelemetryRoute("/v1/quotes/qte_1234567890abcdef"),
    "/v1/quotes/:id",
  );
  assert.equal(
    apiTelemetryRoute("/v1/internal/control-plane/tenants/tenant_1234567890abcdef/data-classification"),
    "/v1/internal/control-plane/tenants/:id/data-classification",
  );
});

test("provider-capable internal Kody tests include a fresh idempotency key", async () => {
  const originalFetch = globalThis.fetch;
  let capturedKey: string | null = null;
  globalThis.fetch = async (_input, init) => {
    capturedKey = new Headers(init?.headers).get("Idempotency-Key");
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    await api.internal.aiQuality.assistantTest({ message: "Test a safe internal Kody response." });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.match(capturedKey ?? "", /^qf-ui-[0-9a-f-]{36}$/i);
});
