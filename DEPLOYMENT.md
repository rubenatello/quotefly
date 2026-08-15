# QuoteFly Deployment Runbook

Target stack: Vercel for `web`, Railway or Render for the API, managed Postgres, Stripe test/sandbox for beta, QuickBooks/Twilio/OpenAI configured only when explicitly enabled.

## Stack

- API: Node 22, Fastify, Prisma, PostgreSQL, HttpOnly JWT session cookie, Stripe, OpenAI, QuickBooks, optional Twilio webhook.
- Web: React 19, Vite, TypeScript, Tailwind CSS, React Router.
- Tests: TypeScript build, Vite build, ESLint, Prisma validate, Vitest integration, Playwright launch smoke.

## Required Local Verification

Install dependencies first:

```powershell
npm ci
npm --prefix web ci
npm run prisma:generate
```

Run baseline verification:

```powershell
npm run verify
```

Run launch verification only against a dedicated test database:

```powershell
$env:TEST_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/quotefly_test?schema=public"
npm run verify:launch
```

`verify:launch` refuses to run E2E unless `TEST_DATABASE_URL` is set and the database name contains `test`.

## Environment Matrix

| Variable | API | Web | Staging Example | Production Notes |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | Required | No | pooled Neon URL using `quotefly_runtime` | API-only runtime role; must not own tables or have `BYPASSRLS` |
| `DIRECT_DATABASE_URL` | No (release job only) | No | direct Neon URL using migration owner | Isolated release/migration commands only; never add to the API service, web app, or browser |
| `JWT_SECRET` | Required | No | 32+ char random secret | Unique per environment; rotate through provider env |
| `APP_URL` | Required | No | `https://staging.quotefly.us` | Production web URL, for redirects and CORS inputs |
| `API_URL` | Required | No | `https://api-staging.quotefly.us` | Production API URL |
| `CORS_ALLOWED_ORIGINS` | Required | No | `https://staging.quotefly.us` | Comma-separated exact web origins |
| `SESSION_COOKIE_NAME` | Required | No | `qf_session` | Keep stable unless rotating sessions |
| `SESSION_COOKIE_DOMAIN` | Optional | No | empty | Prefer host-only for `api.quotefly.us`; use `.quotefly.us` only when sharing across API hostnames |
| `SESSION_COOKIE_SAME_SITE` | Required | No | `lax` | Production default: `lax` for same-site `app.quotefly.us` + `api.quotefly.us` |
| `VITE_API_BASE_URL` | No | Required | `https://api-staging.quotefly.us` | Only public web env needed for API routing |
| `STRIPE_SECRET_KEY` | Required for billing | No | Stripe test key | Use live key only after webhook smoke passes |
| `STRIPE_WEBHOOK_SECRET` | Required for billing | No | Stripe test webhook secret | Webhook endpoint: `/v1/billing/webhook` |
| `STRIPE_PRICE_ID_STARTER` | Required for sellable Basic | No | Basic test price ID | Must be an active USD `$29` recurring monthly Price |
| `STRIPE_COUPON_ID_BASIC_FIRST_MONTH_HALF_OFF` | Required for sellable Basic | No | Basic test coupon ID | Must be a valid `once`, `50%` coupon; QuoteFly applies it only to eligible first-time subscriptions |
| `STRIPE_PRICE_ID_PROFESSIONAL` | Optional | No | test placeholder | Keep off-sale until enabled |
| `STRIPE_PRICE_ID_ENTERPRISE` | Optional | No | test placeholder | Keep off-sale until enabled |
| `RESEND_API_KEY` | Required | No | Resend test/staging key | Backend-only; verify the production sending domain before launch |
| `PASSWORD_RESET_EMAIL_FROM` | Required | No | `QuoteFly <support@quotefly.us>` | Must use a verified sender identity paired with `RESEND_API_KEY` |
| `PASSWORD_RESET_TOKEN_TTL_MINUTES` | Optional | No | `30` | Keep between 10 and 60 minutes |
| `SUPPORT_EMAIL` | Required | No | `support@quotefly.us` | Confirm the monitored inbox receives account and billing requests |
| `OPENAI_API_KEY` | Required for AI | No | staging key or empty | Empty disables real provider calls; AI stays beta |
| `OPENAI_MODEL` | Optional | No | `gpt-4o-mini` | Track quality and spend before launch expansion |
| `OPENAI_EMBEDDING_MODEL` | Optional | No | `text-embedding-3-small` | Keep consistent with indexed RAG chunks; changing it requires reindexing |
| `OPENAI_EMBEDDING_COST_PER_1M_USD` | Optional | No | `0.02` | Estimated input cost used for tenant AI spend metering; keep aligned with the configured embedding model |
| `ENABLE_AI_INDEX_WORKER` | Optional | No | `false` | Keep false until all canonical mutation paths have transactional enqueue coverage and staging race tests pass |
| `AI_INDEX_INLINE_REFRESH` | Optional | No | `true` | Keep true during worker warm-up; set false on the API only after the queue drains and freshness smoke tests pass |
| `QUICKBOOKS_CLIENT_ID` / `QUICKBOOKS_CLIENT_SECRET` | Provider setup | No | Intuit sandbox app | Direct sync stays off-sale until sandbox passes |
| `QUICKBOOKS_REDIRECT_URI` | Provider setup | No | `https://api-staging.quotefly.us/v1/integrations/quickbooks/callback` | Must match Intuit app exactly |
| `QUICKBOOKS_WEBHOOK_VERIFIER` | Provider setup | No | sandbox verifier | Required before enabling webhooks |
| `QUICKBOOKS_ENVIRONMENT` | Required if configured | No | `sandbox` | Use `production` only after Intuit production approval |
| `ENABLE_TWILIO_SMS` | Optional | No | `false` | Must remain false in production until sender authorization is implemented |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Provider setup | No | Twilio test credentials | Required only when SMS provider is enabled |
| `TWILIO_WEBHOOK_AUTH_TOKEN` | Provider setup | No | random secret | Required for webhook validation |
| `SUPERUSER_EMAILS` | Optional | No | owner emails | Restrict internal admin/AI quality access |

Never commit production secrets. Keep all production values in Vercel, Railway, Render, Stripe, Intuit, Twilio, and OpenAI provider settings.

### Stripe Basic offer setup

Before deploying the `$29` billing contract:

1. Create a new active Stripe Price for `USD $29.00`, recurring every month. Stripe Prices are immutable, so do not reuse the former `$19` Price.
2. Create a Stripe Coupon for `50%` off with duration `once`. Leave it unrestricted or restrict it to the same Basic Product used by the `$29` Price.
3. Set `STRIPE_PRICE_ID_STARTER` to the new Price ID and `STRIPE_COUPON_ID_BASIC_FIRST_MONTH_HALF_OFF` to the Coupon ID on the Railway API service before deploying the code.
4. In Stripe test mode, start Checkout once during an active QuoteFly trial and once after expiration. Confirm the first paid invoice is discounted to `$14.50`, later invoices are `$29.00`, and no promotion-code field is shown.

The API verifies the Price amount, currency, cadence, Coupon percentage, one-time duration, validity, and Product restriction before creating a new Checkout Session. A mismatch fails closed with a generic `503` and a sanitized configuration code in API logs.

## API Deploy

Railway/Render settings:

- Runtime: Node 22.
- Root directory: repository root.
- Build command: `npm ci && npm run prisma:generate && npm run build`.
- Start command: `npm run start:prod` (runtime only; production env validation rejects any `DIRECT_DATABASE_URL`).
- Run `npm run prisma:migrate:deploy` from a dedicated release job or CI environment that has `DIRECT_DATABASE_URL`. Do not add the owner URL to the Railway API service variables. Railway pre-deploy commands run separately, but inherit the service environment, so a separate migration service/job or deployment workflow is required for true credential separation.
- Process liveness: `GET /v1/health`.
- Deployment readiness: `GET /v1/ready` (returns `200` only when PostgreSQL responds).
- Keep the API service region physically close to the managed Postgres region. For Railway + Neon, choose matching or nearest available US regions before optimizing code.
- Use the Neon pooled connection string for API runtime traffic and a direct connection only for Prisma CLI/migration work.
- After the RLS migration creates the `NOLOGIN` role, set a generated password with the Neon owner connection, enable `LOGIN`, and use that role only in Railway's pooled `DATABASE_URL`. Keep the owner URL as `DIRECT_DATABASE_URL` only in the separate release/migration job. Never use `neondb_owner`, `postgres`, or another table owner as the running API role; Neon documents that owner/superuser-style roles can bypass RLS.
- Disable Neon scale-to-zero, or set a production-safe suspend timeout, before selling accounts that expect mobile-app-like response times.

`start:prod` never runs migrations, and production startup fails if `DIRECT_DATABASE_URL` is present. A deployment must run `npm run prisma:migrate:deploy` successfully in the isolated migration job before routing the new API release.

This forced-RLS migration is forward-only: the previous API does not set `app.tenant_id`. Rehearse the migration on a Neon branch, confirm the new API and quote workflows, and use a forward fix or temporarily disable AI retrieval if rollback is needed. Do not roll the API back behind migration `20260813170000` and assume AI index/audit writes will continue.

Before routing traffic, `/v1/ready` must confirm enabled and forced RLS on `AiRetrievalDocument`, `AiRetrievalChunk`, `AiRetrievalAuditEvent`, and `AiIndexJob`. If Railway starts with the owner URL or the migration/policy is absent, production environment validation/readiness must fail closed.

The async AI indexer is a separate Railway worker process using `npm run start:ai-index-worker` and the same non-owner `quotefly_runtime` database role. Start with one replica. Keep `ENABLE_AI_INDEX_WORKER=false` until Customer, Quote, QuoteLineItem, CustomerActivityEvent, and WorkPreset mutation coverage has passed database-backed enqueue, deletion, coalescing, and stale-lease tests. The API continues request-time retrieval refresh while the worker is disabled, so this is an expand-only rollout rather than a freshness cutover.

## Performance Operations

Baseline production targets:

- `/v1/health`: p95 under 500ms from US clients.
- `/v1/ready`: p95 under 750ms when the database is warm.
- Customers and quotes list endpoints: p95 under 1.5s for beta tenants.
- Kody first visible response/progress: under 500ms; complete simple lookup/summary under 5s; complete quote drafting under 15s.

API responses include `X-Request-Id`. Non-production responses also include `Server-Timing`; production keeps detailed timings in structured API logs instead of browser-visible headers.

When latency is reported:

1. Check Railway API logs for `Slow API request completed.` and compare `auth`, `workspace`, `db`, and `ai` timings.
2. Confirm Railway API region and Neon database region are colocated or nearest available.
3. Confirm production Neon compute is not waking from scale-to-zero during active use.
4. Confirm API runtime uses the pooled Neon connection string, while migrations use a direct connection.
5. Compare `/v1/health` and `/v1/ready`; if health is fast but ready is slow, prioritize database/connection tuning.
6. For Kody, separate retrieval/query time from OpenAI provider time using the request timing fields.

## Web Deploy

Vercel settings:

- Root directory: `web`.
- Install command: `npm ci`.
- Build command: `npm run build`.
- Output directory: `dist`.
- Environment: `VITE_API_BASE_URL=https://api-staging.quotefly.us` for staging, then production API URL for production.

The web app must not receive backend secrets. `VITE_*` values are public.

## Staging Flow

1. Provision staging Postgres and set API env vars.
2. Deploy API to Railway/Render staging.
3. Confirm `GET /v1/health` returns OK and `GET /v1/ready` reports database readiness.
4. Deploy Vercel staging with `VITE_API_BASE_URL` pointed at staging API.
5. Rehearse migrations with `npm run prisma:migrate:deploy` and follow any feature-specific rollout document, including `docs/billing-integrity-rollout.md`.
6. Run staging smoke checks.
7. Keep Stripe, QuickBooks, Twilio, and OpenAI in test/sandbox modes.

## Production Flow

1. Confirm `main` has passing CI with `verify:launch`.
2. Snapshot or verify backup on production Postgres.
3. Apply production env vars in API provider.
4. Follow `docs/billing-integrity-rollout.md` before deploying the current billing migration; its coordinated webhook/API cutover replaces a normal rolling deploy.
5. Verify health, readiness, migrations, webhook processing, and paid access.
6. Verify the Resend sending domain and complete a real password-reset delivery smoke test.
7. Deploy Vercel production with production `VITE_API_BASE_URL`.
8. Run `npm run seo:sitemap:live` after the Vercel deployment and confirm Search Console has the stable `https://www.quotefly.us/sitemap.xml` URL submitted.
9. Run production smoke checks with a beta test account.
10. Enable only the providers that passed sandbox smoke checks.

## Smoke Checks

- Public landing, pricing, support, privacy, terms, and cookie pages load.
- Auth modal opens; beta signup creates a workspace.
- Session restores after reload; logout clears access.
- Create customer, search customer, and verify duplicate warning.
- Create manual quote with one line item.
- Open quote desk, download PDF, mark sent, and verify send log after an outbound event.
- Admin billing screen shows Basic at `$29/month` with a 20-day trial and Professional/Enterprise as disabled/coming soon.
- An active trial can start Stripe Checkout, retains its promised remaining trial, receives the automatic one-time 50% first-paid-month discount, and activates after a signed webhook.
- A canceled checkout resumes, and past-due billing can open the portal on a mobile viewport.
- Forgot-password delivers through the verified sender and the single-use reset link succeeds.
- QuickBooks shows disconnected or configured state without crashing.
- AI prompt surface shows enabled, limit, or provider-error state clearly.
- Mobile customer and quote pages render without overlapping controls.

## Rollback

- Web rollback: use Vercel deployment rollback.
- API rollback: normally redeploy the previous Railway/Render release image or commit. After the current billing migration, old billing code is not webhook-safe; pause Stripe webhook ingress and use a forward fix or verified backup restore plan.
- Database rollback: prefer forward fixes. Do not manually reverse production migrations unless a tested rollback migration and backup restore plan exist.
- Provider rollback: disable affected provider env vars or feature flags first, then redeploy API.

## Provider Setup Notes

- Stripe: configure checkout success/cancel URLs, customer portal, and `/v1/billing/webhook`.
- QuickBooks: configure sandbox app credentials, exact redirect URI, webhook verifier, and realm conflict handling before enabling direct sync.
- Twilio: production startup rejects `ENABLE_TWILIO_SMS=true` until sender authorization is implemented; keep it false until compliance, authorization, and opt-out behavior are production reviewed.
- OpenAI: set spend alerts and review AI quality telemetry before expanding beta access.
