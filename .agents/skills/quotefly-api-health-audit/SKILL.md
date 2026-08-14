---
name: quotefly-api-health-audit
description: Inventory and audit QuoteFly Fastify endpoints without unsafe production mutations. Use for API 5xx incidents, endpoint health checks, release smoke tests, latency regressions, migration/schema drift, provider-route failures, or requests to validate all API endpoints across public, authenticated, superuser, and test-only mutation tiers.
---

# QuoteFly API Health Audit

Audit endpoint availability in layers so production checks never create customers, quotes, charges, messages, or provider events.

## Workflow

1. Read the project `AGENTS.md`. For production, tenant, auth, billing, provider, or AI incidents, also use `$quotefly-security-review`.
2. Record branch/SHA, environment, API origin, deployment ID/region, database region, and whether an authenticated test account is available.
3. Inventory every declared route:

   ```powershell
   node .agents/skills/quotefly-api-health-audit/scripts/inventory-routes.mjs
   ```

   Treat any unmatched Fastify route declaration as a failed audit. Review the route-risk totals before probing.
4. Run public, read-only production probes:

   ```powershell
   node .agents/skills/quotefly-api-health-audit/scripts/probe-read-endpoints.mjs --base-url https://api.quotefly.us --mode public
   ```

5. Run authenticated GET probes only with explicit production authorization. Put the full session cookie in `QF_HEALTH_SESSION_COOKIE`; never pass it as a CLI argument, print it, store it in a file, or include it in a report.

   ```powershell
   $env:QF_HEALTH_SESSION_COOKIE = '<temporary cookie value>'
   node .agents/skills/quotefly-api-health-audit/scripts/probe-read-endpoints.mjs --base-url https://api.quotefly.us --mode authenticated
   Remove-Item Env:QF_HEALTH_SESSION_COOKIE
   ```

   Add `--include-superuser-reads` only for an approved superuser account. Superuser GET routes record bounded audit events, so report that expected side effect.
6. Never probe POST, PUT, PATCH, or DELETE production routes generically. Exercise mutations with `npm run verify:ci` against a migrated database whose name includes `test`. Exercise Stripe, Twilio, QuickBooks, email, and OpenAI paths only in provider sandboxes or mocks.
7. For any 5xx, correlate timestamp, request ID, deployment, route, duration, performance timings, and sanitized server error code. Do not expose response bodies, customer data, credentials, raw prompts, or provider payloads.
8. Check migration status, `/v1/ready`, runtime-role separation, region colocation, connection-pool mode, rate limits, and bounded query concurrency when the failure involves Prisma or latency.
9. Read [references/health-matrix.md](references/health-matrix.md) for tier definitions and release criteria.

## Decision rules

- Return `CHANGES_REQUIRED` for reproducible 5xx responses, schema drift, unsafe authorization behavior, unbounded production probes, or missing mutation coverage on a changed route.
- Return `BLOCKED_MISSING_EVIDENCE` when authenticated, test-database, provider-sandbox, or production-log access required by the scope is unavailable.
- Return `APPROVED` only for the explicitly tested scope; list untested tiers separately.
- Prefer fixing the root query, migration, region, or authorization failure over raising timeouts. When a bounded timeout increase is still required, test and document the maximum.
