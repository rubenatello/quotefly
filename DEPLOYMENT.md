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
| `RATE_LIMIT_REDIS_URL` | Required for multiple API replicas | No | private Railway Redis URL | Shared Fastify rate-limit counters; use `rediss://` when the provider requires TLS |
| `RATE_LIMIT_REQUIRE_SHARED_STORE` | Recommended for production scale-out | No | `false` for one replica | Set `true` before adding a second API replica so startup fails closed without Redis |
| `JWT_SECRET` | Required | No | 32+ char random secret | Unique per environment; rotate through provider env |
| `APP_URL` | Required | No | `https://staging.quotefly.us` | Production web URL, for redirects and CORS inputs |
| `API_URL` | Required | No | `https://api-staging.quotefly.us` | Production API URL |
| `CORS_ALLOWED_ORIGINS` | Required | No | `https://staging.quotefly.us` | Comma-separated exact web origins |
| `QUOTEFLY_RELEASE_SHA` | Optional | No | exact 40-character Git SHA | Explicit release identity for non-Git deploys; Railway/Render Git deploys use their provider-injected commit SHA automatically. API and QuickBooks worker values must match |
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
| `OPENAI_ASSISTANT_TIMEOUT_MS` | Optional | No | `12000` | Fail closed to deterministic Kody output when provider composition is slow |
| `OPENAI_EMBEDDING_MODEL` | Optional | No | `text-embedding-3-small` | Keep consistent with indexed RAG chunks; changing it requires reindexing |
| `OPENAI_EMBEDDING_COST_PER_1M_USD` | Optional | No | `0.02` | Estimated input cost used for tenant AI spend metering; keep aligned with the configured embedding model |
| `AI_RAG_ROLLOUT_MODE` | Required for production RAG | No | `off` | Global kill switch: `off`, `shadow_allowlist`, `allowlist`, or `all`; production defaults to `off` |
| `AI_RAG_TENANT_ALLOWLIST` | Required for pilot mode | No | comma-separated tenant ids | Used with `shadow_allowlist` or `allowlist`; never put customer data in this value |
| `ENABLE_AI_INDEX_WORKER` | Optional | No | `false` | Keep false until all canonical mutation paths have transactional enqueue coverage and staging race tests pass |
| `AI_INDEX_INLINE_REFRESH` | Optional | No | `true` | Keep true during worker warm-up; set false on the API only after the queue drains and freshness smoke tests pass |
| `QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED` | Required | No | `false` | Global provider kill switch. Keep `false` in every release environment; schema/code presence and configured credentials do not authorize enablement |
| `QUICKBOOKS_CLIENT_ID` / `QUICKBOOKS_CLIENT_SECRET` | Provider setup | No | Intuit sandbox app | Direct sync stays off-sale until sandbox passes |
| `QUICKBOOKS_REDIRECT_URI` | Provider setup | No | `https://api-staging.quotefly.us/v1/integrations/quickbooks/callback` | Must match Intuit app exactly |
| `QUICKBOOKS_WEBHOOK_VERIFIER` | Provider setup | No | sandbox verifier | Required before enabling webhooks |
| `QUICKBOOKS_ENVIRONMENT` | Required if configured | No | `sandbox` | Use `production` only after Intuit production approval |
| `QUICKBOOKS_TOKEN_ENCRYPTION_KEY` | Required if configured | No | independent 32+ char random secret | Must differ from `JWT_SECRET`; encrypts newly stored OAuth tokens |
| `QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS` | Rotation only | No | prior encryption secret | Keep only while old token ciphertext is being refreshed; must differ from current and JWT keys |
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
- For Railway, connect the `quotefly-migrations` service to this repository's `main` branch and set its custom config-file path to `/railway.migrations.json`. That service is a one-shot process with no HTTP healthcheck and a `NEVER` restart policy. Keep GitHub autodeploy disabled until migration-before-API ordering is automated; deploy it manually before redeploying the API candidate.
- Process liveness: `GET /v1/health`.
- Deployment readiness: `GET /v1/ready` (returns `200` only when PostgreSQL responds).
- Keep the API service region physically close to the managed Postgres region. For Railway + Neon, choose matching or nearest available US regions before optimizing code.
- Use the Neon pooled connection string for API runtime traffic and a direct connection only for Prisma CLI/migration work.
- A single API replica can use the bounded in-memory rate-limit store. Before adding another replica, provision Railway Redis in the same region, set `RATE_LIMIT_REDIS_URL`, set `RATE_LIMIT_REQUIRE_SHARED_STORE=true`, and confirm `/v1/ready` includes a successful Redis ping.
- After the RLS migration creates the `NOLOGIN` role, set a generated password with the Neon owner connection, enable `LOGIN`, and use that role only in Railway's pooled `DATABASE_URL`. Keep the owner URL as `DIRECT_DATABASE_URL` only in the separate release/migration job. Never use `neondb_owner`, `postgres`, or another table owner as the running API role; Neon documents that owner/superuser-style roles can bypass RLS.
- Disable Neon scale-to-zero, or set a production-safe suspend timeout, before selling accounts that expect mobile-app-like response times.

`start:prod` never runs migrations, and production startup fails if `DIRECT_DATABASE_URL` is present. A deployment must run `npm run prisma:migrate:deploy` successfully in the isolated migration job before routing the new API release.

This forced-RLS migration is forward-only: the previous API does not set `app.tenant_id`. Rehearse the migration on a Neon branch, confirm the new API and quote workflows, and use a forward fix or temporarily disable AI retrieval if rollback is needed. Do not roll the API back behind migration `20260813170000` and assume AI index/audit writes will continue.

Before routing traffic, `/v1/ready` must confirm enabled and forced RLS on `AiRetrievalDocument`, `AiRetrievalChunk`, `AiRetrievalAuditEvent`, and `AiIndexJob`. If Railway starts with the owner URL or the migration/policy is absent, production environment validation/readiness must fail closed.

The async AI indexer is a separate Railway worker process using `npm run start:ai-index-worker` and the same non-owner `quotefly_runtime` database role. Start with one replica. Keep `ENABLE_AI_INDEX_WORKER=false` until Customer, Quote, QuoteLineItem, CustomerActivityEvent, and WorkPreset mutation coverage has passed database-backed enqueue, deletion, coalescing, and stale-lease tests. The API continues request-time retrieval refresh while the worker is disabled, so this is an expand-only rollout rather than a freshness cutover.

RAG rollout is independent from Kody's deterministic tools. `AI_RAG_ROLLOUT_MODE=off` prevents governed context refresh, embedding, and retrieval calls while customer lookup, catalog matching, clarification, and review-only quote drafting continue. For the first internal pilot, set `AI_RAG_ROLLOUT_MODE=shadow_allowlist`, add only approved tenant ids to `AI_RAG_TENANT_ALLOWLIST`, keep inline refresh on, and leave the background worker off. Shadow mode runs governed indexing/retrieval and records content-free audit/cost evidence, but strips excerpts and citations before model composition or customer-visible output. Confirm `/v1/internal/control-plane/rag-index` reports the expected mode, enabled active-tenant count, and zero exposed tenants. Move to `allowlist` only after reviewing relevance, leakage, freshness, latency, and spend. Enabling the worker requires an enabled rollout mode; in either allowlist mode it processes only approved tenants. Return to `off` for the immediate kill switch. Environment changes take effect only after the API/worker restarts. Source mutations continue to enqueue freshness jobs while RAG is off or a tenant is outside the allowlist; those jobs are expected to remain pending and are reported separately from the rollout-enabled queue so they do not trigger pilot freshness alerts. Disabling does not purge existing tenant-scoped derived chunks; use the governed purge/reindex workflow for deletion or policy changes.

Inline refresh is deliberately bounded to 16 prioritized sources with concurrency four: the selected customer, four recent activities, the explicitly selected quote and up to 12 lines, then up to four saved products/services as capacity permits. It does not scan recent tenant-wide quotes. Tenant-wide exact-term recall uses PostgreSQL FTS reference preselection before live authorization; semantic-only recall remains bounded to the newest 200 compatible chunks until pgvector benchmarks justify the scale migration.

Before any provider-backed pilot, record dated evidence for the dedicated OpenAI project/key, its configured data-control/retention posture, data-sharing setting, intended region, and provider agreement/subprocessor review. Keep the key server-only and do not treat code configuration as evidence of provider-account settings.

## Performance Operations

Baseline production targets:

- `/v1/health`: p95 under 500ms from US clients.
- `/v1/ready`: p95 under 750ms when the database is warm.
- GitHub's `Production API read health` workflow probes liveness, readiness, and the unauthenticated session boundary three times every 30 minutes. It fails any probe over 2.5 seconds, retains a sanitized report for 14 days, and opens one deduplicated GitHub incident until the probe recovers.
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

## QuickBooks Hosted-Payment Candidate

The hosted-payment and reconciliation work is an engineering candidate, not an available integration. Keep `QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED=false`; do not complete OAuth, subscribe provider webhooks, create an Intuit invoice, retrieve or share an InvoiceLink, or run sandbox mutations without separate owner authorization. Taxable invoice publishing remains blocked.

The authoritative acceptance contract is [docs/integrations/quickbooks-hosted-payments-reconciliation.md](docs/integrations/quickbooks-hosted-payments-reconciliation.md). Current product and API truth is recorded in [docs/integrations/quickbooks-api-progress.md](docs/integrations/quickbooks-api-progress.md).

### Coordinated migration rehearsal

The `20260827120000_add_quickbooks_hosted_payment_reconciliation` migration enables forced RLS on existing QuickBooks tables. It is not backward-compatible with an API binary that queries those tables without setting `app.tenant_id`.

Before any sandbox or production rollout:

- [ ] Restore a recent sanitized production-like backup into an isolated database branch and record its source timestamp.
- [ ] Record the exact candidate SHA, full ordered migration list, migration start/end time, row counts, lock/availability observations, and result.
- [ ] Apply migrations only through the isolated job using `DIRECT_DATABASE_URL`; start the API separately with the non-owner pooled `quotefly_runtime` URL.
- [ ] Measure the Invoice billing-email backfill, InvoicePayment unique-index replacement, QuickBooks foreign-key replacements, realm-binding backfill, new indexes, and forced-RLS activation.
- [ ] Verify `/v1/health`, `/v1/ready`, auth/session, customer, quote, Job, Invoice, CSV, and paused QuickBooks behavior after migration.
- [ ] Prove two-tenant runtime-role denial for every tenant-owned QuickBooks table and intended access to the minimal non-secret realm-routing table.
- [ ] Rehearse backup restore and a forward fix. Do not route an older API binary after the forced-RLS migration unless its compatibility is independently proven.

### Monitoring and recovery gate

Before an authorized sandbox run, assign alert owners, destinations, thresholds, severity, and escalation for:

- oldest eligible webhook age, retry count, lease expiry, and `DEAD` events;
- invoice operations stuck in `PROCESSING`, `RECONCILING`, or reconciliation-required states;
- token refresh failures, `REVOCATION_PENDING`, and revocation retry age;
- CDC cursor lag, CDC failures, and dropped-webhook repair outcome;
- provider latency, timeout, throttling, `Retry-After`, and sanitized failure-code rate;
- hosted-link hostname validation and no-log/no-cache boundary violations.

Webhook acknowledgement must follow durable persistence. Webhook, manual refresh, and CDC must invoke the same authoritative reconciliation service. A dead-letter replay or CDC repair must never create another provider invoice or duplicate a payment application.

### QuickBooks provider rollback

1. Set `QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED=false` and restart the API.
2. Preserve provider operations, webhook inbox, CDC cursor, InvoicePayment, and InvoiceEvent history; never delete uncertain state.
3. Pause or remove Intuit webhook subscriptions if provider ingress must stop.
4. Attempt token revocation before local cleanup. If revocation cannot be confirmed, keep the connection blocked as `REVOCATION_PENDING`, rotate or revoke credentials externally, and follow the retry/escalation record.
5. Reconcile every in-flight or uncertain invoice against QuickBooks before re-enabling. Never blindly replay invoice creation.
6. Prefer a forward fix. A database restore does not undo provider-side invoices or payments, and an older binary must not be used after forced RLS without explicit compatibility evidence.

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
2. Snapshot or verify the staging backup, then apply checked-in migrations through the isolated migration job with `npm run prisma:migrate:deploy`; follow any feature-specific rollout document, including `docs/billing-integrity-rollout.md`.
3. Deploy the exact migrated candidate API to Railway/Render staging with only the least-privileged runtime database credential.
4. Confirm `GET /v1/health` returns OK and `GET /v1/ready` reports database readiness before starting any worker or routing the web app to the candidate.
5. Start separately enabled workers from the same exact SHA, then confirm their readiness/heartbeat and API release-parity checks. Keep the QuickBooks worker off for the OAuth-only stage.
6. Deploy Vercel staging with `VITE_API_BASE_URL` pointed at the ready staging API.
7. Run staging smoke checks.
8. Keep Stripe, Twilio, and OpenAI in test/sandbox modes. Keep QuickBooks provider workflows disabled unless a separate owner-authorized sandbox checklist is active.

For an authorized progressive QuickBooks sandbox run, use the fixed presence-only audit profile for the active stage: `quickbooks-oauth`, `quickbooks-reconciliation`, `quickbooks-cdc`, then `quickbooks-hosted-payments`. The legacy `quickbooks` profile intentionally remains an alias for the complete hosted-payments stage. Every QuickBooks stage follows the same ordering: migration job, API, API readiness, worker when that stage enables it, then web. The audit reports names and configured/missing status only; it never emits environment values or proves remote provider configuration.

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
10. Enable only providers that passed their exact-candidate sandbox and operations gates. QuickBooks remains disabled until the hosted-payment acceptance contract, owner checklist, Sentinel review, and independent Opera approval are complete.

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
- QuickBooks shows a disconnected/configured-but-paused state without crashing; QuickBooks-friendly CSV export succeeds. This smoke does not authorize a provider call.
- AI prompt surface shows enabled, limit, or provider-error state clearly.
- Mobile customer and quote pages render without overlapping controls.

## Rollback

- Web rollback: use Vercel deployment rollback.
- API rollback: normally redeploy the previous Railway/Render release image or commit. After the current billing migration, old billing code is not webhook-safe; pause Stripe webhook ingress and use a forward fix or verified backup restore plan.
- Database rollback: prefer forward fixes. Do not manually reverse production migrations unless a tested rollback migration and backup restore plan exist.
- Provider rollback: disable affected provider env vars or feature flags first, then redeploy API. For QuickBooks, also preserve uncertain records, revoke tokens or mark revocation pending, manage the external webhook subscription, and reconcile provider-side state before any re-enable decision.

## Provider Setup Notes

- Stripe: configure checkout success/cancel URLs, customer portal, and `/v1/billing/webhook`.
- QuickBooks: keep provider workflows false. Credentials, an exact redirect URI, a verifier, and realm conflict handling are prerequisites only; direct sync additionally requires the full hosted-payment contract, production-like migration rehearsal, sandbox evidence, monitoring/recovery evidence, security review, independent approval, and explicit owner authorization.
- Twilio: production startup rejects `ENABLE_TWILIO_SMS=true` until sender authorization is implemented; keep it false until compliance, authorization, and opt-out behavior are production reviewed.
- OpenAI: set spend alerts and review AI quality telemetry before expanding beta access.
