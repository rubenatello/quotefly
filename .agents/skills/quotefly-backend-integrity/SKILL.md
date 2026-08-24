---
name: quotefly-backend-integrity
description: Design, diagnose, review, and improve QuoteFly backend integrity across Fastify APIs, Prisma/PostgreSQL schema, migrations, query latency, transactions, integrations, and infrastructure assumptions. Use for Renford work involving API performance, tenant-scoped data access, database design, indexes, concurrency, idempotency, service boundaries, health checks, or backend production readiness.
---

# QuoteFly Backend Integrity

Protect correctness and tenant boundaries before optimizing latency.

## Diagnose with evidence

1. Read `AGENTS.md`, `prisma/schema.prisma`, all relevant migrations, route handlers, services, tests, and deployment assumptions.
2. Trace requests from Zod validation through auth, tenant scoping, Prisma queries, external calls, and response serialization.
3. Measure or explain the expected query/request pattern before changing performance code. Avoid unsupported latency claims.
4. Inspect query filters and relation writes for `tenantId`, active/archive/delete state, pagination, ordering, indexes, and cross-tenant identifiers.

## Design changes

- Keep handlers thin and move reusable behavior into `src/services` or `src/lib`.
- Use Zod at every route boundary and stable customer-safe error shapes.
- Use transactions for cohesive multi-write invariants, but keep network/provider calls outside long transactions.
- Make webhooks and retries idempotent with provider event IDs and persisted state.
- Add indexes from demonstrated hot filters, joins, ordering, or uniqueness needs; review generated migration SQL.
- Prefer composite tenant constraints where they materially prevent cross-tenant relations.
- Preserve UTC persistence, soft deletion, archives, internal costs, and provider-secret boundaries.
- Consider connection limits, timeouts, backpressure, rate limits, retry policy, structured logs, and rollback behavior.

Do not run destructive database commands or apply production migrations. Do not alter the schema without a checked-in Prisma migration and an explicit data/backfill plan when existing rows are affected.

## Verify

Add or update integration tests for tenant isolation and changed invariants. Run `npm run build`, `npm run prisma:validate`, and `npm run test:integration` against a dedicated database whose name contains `test`. Run `npm run verify` before handoff; require `npm run verify:launch` for consumer release. If measurement needs production-like data, provide a safe benchmark/query-plan procedure and mark the result blocked until it is run.

Return the baseline, change rationale, migration/index effects, failure modes, test evidence, and remaining infrastructure assumptions. Send the result to Opera.
