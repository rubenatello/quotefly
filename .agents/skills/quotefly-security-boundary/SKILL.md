---
name: quotefly-security-boundary
description: Review and harden QuoteFly security and privacy boundaries. Use for Sentinel work involving tenant isolation, authentication and authorization, cookies and CSRF, CORS, secrets, PII, billing, AI data, QuickBooks or Twilio integrations, webhook signatures, dependency vulnerabilities, public share/PDF exposure, or security-sensitive schema and API changes.
---

# QuoteFly Security Boundary

Treat every tenant boundary and provider boundary as hostile until verified.

## Trace the boundary

1. Read `AGENTS.md`, affected routes/services, Prisma relations, env validation, client API calls, tests, and deployment configuration.
2. Identify the actor, tenant, resource, required role, accepted input, sensitive output, provider trust boundary, and audit trail for each path.
3. Verify `tenantId` scoping on reads, writes, nested relations, counts, aggregates, exports, PDFs, AI usage, activities, and integrations.
4. Verify HttpOnly cookie settings, credentialed CORS, CSRF assumptions, session invalidation, rate limits, password handling, and production secret validation.
5. Verify webhook signatures against raw bodies, idempotent event handling, replay behavior, and safe logging.

## Apply hard rules

- Never log or expose passwords, tokens, provider secrets, raw credentials, or customer-sensitive payloads.
- Never rely on a client-supplied tenant identifier when authenticated claims provide the boundary.
- Never enable `SameSite=None` without explicit CSRF protection and secure cookies.
- Never leak internal costs or margin in customer-facing routes, PDFs, exports, or share flows.
- Never dismiss a dependency advisory solely because it is transitive; trace reachability and provide a documented disposition or upgrade.
- Preserve soft-delete/archive rules and intentional superuser checks.

Use non-destructive verification. Do not probe production, rotate credentials, enable providers, or modify live data without explicit authorization.

## Verify and report

Add negative tests for unauthenticated, wrong-role, cross-tenant, replay, malformed-signature, and sensitive-field cases relevant to the change. Run `npm run audit:all`, backend compilation, and the affected integration/E2E tests. Report findings by severity with source-to-sink evidence, realistic impact, owner, required fix, and acceptance check. Distinguish confirmed vulnerabilities from hardening opportunities. Send all blocking findings to Opera and the appropriate implementation owner.
