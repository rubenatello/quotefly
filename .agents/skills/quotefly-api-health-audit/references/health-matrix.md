# QuoteFly API health matrix

| Tier | Scope | Where | Permitted checks | Passing evidence |
|---|---|---|---|---|
| 0 | Route inventory | Local/CI | Parse every Fastify method/path declaration | No unmatched declarations; every route assigned a risk class |
| 1 | Public boundary | Production | `GET /health`, `GET /ready`, unauthenticated `GET /auth/me` | 200, 200, 401; no 5xx; bounded latency |
| 2 | Tenant reads | Production with approved test session | Auth/session, bounded customer/quote/product/team/setup/branding GETs | Expected 2xx or explicit plan/role denial; no 5xx or cross-tenant data |
| 2S | Superuser reads | Production with approved superuser session | Bounded control-plane and AI-quality GETs | 200; expected audit records; no raw tenant content in responses/logs |
| 3 | Mutations | Dedicated migrated test database | Integration coverage for POST/PUT/PATCH/DELETE, transactions, retries, archive/delete/restore | `npm run verify:ci` passes; database name guard remains enabled |
| 4 | Providers | Sandbox or mocks | Stripe, Twilio, QuickBooks, Resend, OpenAI callbacks and failures | Signature/auth checks, idempotency, stable errors, no live customer side effects |
| 5 | User journey | Staging or approved production smoke | Sign in through quote PDF/send/follow-up/billing access | Browser/mobile checks pass with request IDs and timings captured |

## Latency interpretation

- Compare browser duration with API `durationMs` and named `auth`, `workspace`, `db`, and `ai` timings.
- Confirm Railway and Neon regions before changing code.
- Treat a cold first request separately from warm samples; record at least three warm requests.
- Investigate any core warm read above 1 second and any request approaching an interactive transaction timeout.
- Use pooled runtime connections for concurrent application traffic and a direct owner connection only in the isolated migration service.

## Production safety

- Never send generated IDs, tenant IDs, emails, phone numbers, quote text, cookies, or response bodies to logs.
- Never infer mutation safety from an HTTP method alone; some GET control-plane reads intentionally create audit events.
- Never weaken authentication to make a probe pass.
- Never point integration cleanup at production or bypass the required `test` database-name guard.
- Keep the migration owner URL absent from the API runtime.
