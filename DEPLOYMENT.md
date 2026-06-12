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
| `DATABASE_URL` | Required | No | Managed Postgres staging URL | Use managed Postgres with backups enabled |
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
| `STRIPE_PRICE_ID_STARTER` | Required for sellable Basic | No | Basic test price ID | Basic is the only launch sellable plan |
| `STRIPE_PRICE_ID_PROFESSIONAL` | Optional | No | test placeholder | Keep off-sale until enabled |
| `STRIPE_PRICE_ID_ENTERPRISE` | Optional | No | test placeholder | Keep off-sale until enabled |
| `OPENAI_API_KEY` | Required for AI | No | staging key or empty | Empty disables real provider calls; AI stays beta |
| `OPENAI_MODEL` | Optional | No | `gpt-4o-mini` | Track quality and spend before launch expansion |
| `QUICKBOOKS_CLIENT_ID` / `QUICKBOOKS_CLIENT_SECRET` | Provider setup | No | Intuit sandbox app | Direct sync stays off-sale until sandbox passes |
| `QUICKBOOKS_REDIRECT_URI` | Provider setup | No | `https://api-staging.quotefly.us/v1/integrations/quickbooks/callback` | Must match Intuit app exactly |
| `QUICKBOOKS_WEBHOOK_VERIFIER` | Provider setup | No | sandbox verifier | Required before enabling webhooks |
| `QUICKBOOKS_ENVIRONMENT` | Required if configured | No | `sandbox` | Use `production` only after Intuit production approval |
| `ENABLE_TWILIO_SMS` | Optional | No | `false` | Keep false for beta unless Twilio compliance is ready |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Provider setup | No | Twilio test credentials | Required only when SMS provider is enabled |
| `TWILIO_WEBHOOK_AUTH_TOKEN` | Provider setup | No | random secret | Required for webhook validation |
| `SUPERUSER_EMAILS` | Optional | No | owner emails | Restrict internal admin/AI quality access |

Never commit production secrets. Keep all production values in Vercel, Railway, Render, Stripe, Intuit, Twilio, and OpenAI provider settings.

## API Deploy

Railway/Render settings:

- Runtime: Node 22.
- Root directory: repository root.
- Build command: `npm ci && npm run prisma:generate && npm run build`.
- Start command: `npm run start:prod`.
- Health check: `GET /v1/health`.

`start:prod` runs `prisma migrate deploy` before starting the API. For safer production rollouts, run migrations as a release/predeploy command and start with `node dist/server.js` after migrations succeed.

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
3. Confirm `GET /v1/health` returns OK.
4. Deploy Vercel staging with `VITE_API_BASE_URL` pointed at staging API.
5. Run migrations with `npm run prisma:migrate:deploy`.
6. Run staging smoke checks.
7. Keep Stripe, QuickBooks, Twilio, and OpenAI in test/sandbox modes.

## Production Flow

1. Confirm `main` has passing CI with `verify:launch`.
2. Snapshot or verify backup on production Postgres.
3. Apply production env vars in API provider.
4. Deploy API.
5. Verify health and migrations.
6. Deploy Vercel production with production `VITE_API_BASE_URL`.
7. Run production smoke checks with a beta test account.
8. Enable only the providers that passed sandbox smoke checks.

## Smoke Checks

- Public landing, pricing, support, privacy, terms, and cookie pages load.
- Auth modal opens; beta signup creates a workspace.
- Session restores after reload; logout clears access.
- Create customer, search customer, and verify duplicate warning.
- Create manual quote with one line item.
- Open quote desk, download PDF, mark sent, and verify send log after an outbound event.
- Admin billing screen shows Basic as sellable and Professional/Enterprise as disabled/coming soon.
- QuickBooks shows disconnected or configured state without crashing.
- AI prompt surface shows enabled, limit, or provider-error state clearly.
- Mobile customer and quote pages render without overlapping controls.

## Rollback

- Web rollback: use Vercel deployment rollback.
- API rollback: redeploy the previous Railway/Render release image or commit.
- Database rollback: prefer forward fixes. Do not manually reverse production migrations unless a tested rollback migration and backup restore plan exist.
- Provider rollback: disable affected provider env vars or feature flags first, then redeploy API.

## Provider Setup Notes

- Stripe: configure checkout success/cancel URLs, customer portal, and `/v1/billing/webhook`.
- QuickBooks: configure sandbox app credentials, exact redirect URI, webhook verifier, and realm conflict handling before enabling direct sync.
- Twilio: keep `ENABLE_TWILIO_SMS=false` until compliance, auth validation, and opt-out behavior are production reviewed.
- OpenAI: set spend alerts and review AI quality telemetry before expanding beta access.

