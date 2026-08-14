import process from "node:process";
import { performance } from "node:perf_hooks";

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const baseUrl = argumentValue("--base-url")?.replace(/\/+$/, "") ?? process.env.QF_API_BASE_URL?.replace(/\/+$/, "");
const mode = argumentValue("--mode") ?? "public";
const includeSuperuserReads = process.argv.includes("--include-superuser-reads");
const sessionCookie = process.env.QF_HEALTH_SESSION_COOKIE;
const timeoutMs = Number(argumentValue("--timeout-ms") ?? "20000");

if (!baseUrl || !/^https?:\/\//.test(baseUrl)) throw new Error("A valid --base-url or QF_API_BASE_URL is required.");
if (!["public", "authenticated"].includes(mode)) throw new Error("--mode must be public or authenticated.");
if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new Error("--timeout-ms must be between 1000 and 60000.");
if (mode === "authenticated" && !sessionCookie) throw new Error("QF_HEALTH_SESSION_COOKIE is required for authenticated probes.");

const results = [];

async function probe(label, requestPath, expectedStatuses, captureJson = false) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(`${baseUrl}${requestPath}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(sessionCookie ? { cookie: sessionCookie } : {}),
      },
      redirect: "manual",
      signal: controller.signal,
    });
    const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
    const expected = expectedStatuses.includes(response.status);
    const result = {
      label,
      status: response.status,
      durationMs,
      requestId: response.headers.get("x-request-id"),
      passed: expected && response.status < 500,
    };
    results.push(result);
    if (!captureJson) {
      await response.arrayBuffer();
      return { response, json: null };
    }
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* Never print response content. */ }
    return { response, json };
  } catch (error) {
    results.push({
      label,
      status: null,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      requestId: null,
      passed: false,
      error: error instanceof Error && error.name === "AbortError" ? "timeout" : "network_error",
    });
    return { response: null, json: null };
  } finally {
    clearTimeout(timeout);
  }
}

if (mode === "public") {
  await probe("liveness", "/v1/health", [200]);
  await probe("readiness", "/v1/ready", [200]);
  await probe("unauthenticated session boundary", "/v1/auth/me", [401]);
} else {
  const session = await probe("authenticated session", "/v1/auth/me", [200], true);
  const tenantId = typeof session.json?.tenant?.id === "string" ? session.json.tenant.id : null;
  const isSuperuser = session.json?.isSuperuser === true;
  const readStatuses = [200, 402, 403];

  const customers = await probe("customer list", "/v1/customers?limit=1&offset=0&lifecycle=active", readStatuses, true);
  const quotes = await probe("quote list", "/v1/quotes?limit=1&offset=0", readStatuses, true);
  await probe("product catalog", "/v1/products", readStatuses);
  await probe("organization users", "/v1/org/users", readStatuses);
  await probe("onboarding setup", "/v1/onboarding/setup", readStatuses);
  await probe("recommended presets", "/v1/onboarding/presets/recommended", readStatuses);
  if (tenantId) await probe("tenant branding", `/v1/tenants/${encodeURIComponent(tenantId)}/branding`, readStatuses);

  const customerId = customers.json?.customers?.[0]?.id;
  if (typeof customerId === "string") {
    await probe("customer detail", `/v1/customers/${encodeURIComponent(customerId)}`, readStatuses);
    await probe("customer activity", `/v1/customers/${encodeURIComponent(customerId)}/activity?limit=1&offset=0`, readStatuses);
  }

  const quoteId = quotes.json?.quotes?.[0]?.id;
  if (typeof quoteId === "string") {
    await probe("quote detail", `/v1/quotes/${encodeURIComponent(quoteId)}`, readStatuses);
    await probe("quote history", `/v1/quotes/${encodeURIComponent(quoteId)}/history?limit=1&offset=0`, readStatuses);
    await probe("quote AI runs", `/v1/quotes/${encodeURIComponent(quoteId)}/ai-runs?limit=1&offset=0`, readStatuses);
  }

  if (includeSuperuserReads) {
    if (!isSuperuser) throw new Error("The supplied session is not authorized for superuser probes.");
    await probe("control-plane summary", "/v1/internal/control-plane/summary", [200]);
    await probe("control-plane tenant list", "/v1/internal/control-plane/tenants?limit=1&offset=0&lifecycle=active", [200]);
    await probe("data classification catalog", "/v1/internal/control-plane/data-catalog", [200]);
    await probe("RAG index summary", "/v1/internal/control-plane/rag-index", [200]);
    await probe("permission policy", "/v1/internal/control-plane/permissions", [200]);
    await probe("validation history", "/v1/internal/control-plane/validation-runs?limit=1", [200]);
    await probe("superuser audit history", "/v1/internal/control-plane/audit-events?limit=1", [200]);
    await probe("AI quality summary", "/v1/internal/ai-quality/summary", [200]);
  }
}

for (const result of results) {
  const status = result.status ?? result.error;
  console.log(`${result.passed ? "PASS" : "FAIL"} ${result.label}: ${status} in ${result.durationMs}ms${result.requestId ? ` request=${result.requestId}` : ""}`);
}
console.log(`Summary: ${results.filter((result) => result.passed).length}/${results.length} probes passed.`);
if (results.some((result) => !result.passed)) process.exitCode = 1;
