# QuoteFly Development Instructions

## Product Context

QuoteFly is a production-oriented quoting and lightweight CRM tool for blue collar service businesses. The app should stay fast, clear, mobile-friendly, and practical for contractors who need to create, review, send, and track quotes without extra admin work.

Prioritize the core workflow: customer lookup or creation, quote draft, line-item pricing, PDF preview, send/share, follow-up, billing access, and accounting export/sync.

## Tech Stack

- Runtime: Node.js 22+; use Node 22.13+ when possible for current frontend tooling compatibility.
- Backend: TypeScript, Fastify 5, Zod, Pino/Fastify logging.
- Database: PostgreSQL with Prisma ORM and checked-in migrations.
- Frontend: React 19, React Router 7, TypeScript, Vite 8, Tailwind CSS 4, Radix UI primitives, lucide-react icons.
- Auth: local email/password with bcrypt, Fastify JWT, and HttpOnly session cookies for browser sessions.
- Payments: Stripe Checkout, Billing Portal, and signed webhooks.
- AI: OpenAI API through backend services only. Never call OpenAI from the browser.
- SMS: Twilio inbound webhook pipeline, enabled by environment flag.
- Accounting: QuickBooks CSV export plus QuickBooks Online OAuth/API sync.
- Docs/API: Swagger/OpenAPI mounted at `/docs`.
- Target deployment: API on Railway or Render, Postgres on managed PostgreSQL such as Neon/Supabase/Railway, frontend on Vercel.

## Non-Negotiable Rules

- BCP means Build, Commit, and Push. Only run BCP when explicitly asked to "run BCP."
- Do not commit, push, deploy, run destructive database commands, or make irreversible changes unless explicitly requested.
- Keep secrets out of Git. Never commit `.env`, API keys, JWT secrets, Stripe secrets, Twilio credentials, QuickBooks secrets, database URLs, or generated private tokens.
- Treat tenant isolation as a hard security boundary. Every customer, quote, billing, AI usage, activity, and integration query must be scoped by `tenantId` unless it is an intentional superuser path.
- Preserve soft-delete and archive semantics. Most destructive user actions should set `deletedAtUtc` or `archivedAtUtc` instead of physically deleting rows.
- Keep internal costs separate from customer-visible prices. Do not leak `internalCostSubtotal`, unit costs, or margin data in customer-facing PDF/share flows unless explicitly intended.
- Use UTC timestamps in the database. Render local business time in the UI using tenant/user timezone context.

## Verification

Run the full local gate before production handoff or before asking for BCP:

```bash
npm run verify
```

This currently runs backend compile, frontend build, frontend lint, Prisma schema validation, AI parser eval, and root/frontend dependency audits.

CI runs the stricter database-backed gate:

```bash
npm run verify:ci
```

This adds `npm run test:integration`, which requires a migrated PostgreSQL test database. Locally, set `TEST_DATABASE_URL` to a database whose name includes `test`, for example `quotefly_test`. The integration harness intentionally refuses to clean any database without `test` in the database name.

Individual checks:

```bash
npm run build
npm run build:web
npm run lint:web
npm run prisma:validate
npm run test:integration
npm run eval:ai
npm run audit:all
```

Backend integration tests cover the launch-critical auth, tenant isolation, customer, quote, and billing webhook flows. For risky backend changes, extend those tests before broad refactors. Still perform manual smoke checks for signup/signin, onboarding, customer create/update, quote create/update, PDF download, billing access, and QuickBooks/Twilio paths when touched.

## Backend Guidelines

- Keep route handlers thin. Put reusable business logic in `src/services` or `src/lib`.
- Validate all request bodies, params, and query strings with Zod at the route boundary.
- Use Prisma transactions for multi-write workflows such as signup/onboarding, quote creation, revision restore, customer merge, billing webhook processing, and integration sync.
- Prefer idempotent webhook handling. Store provider event IDs before or during processing where possible.
- Keep webhook signature verification mandatory in production paths.
- Use Fastify `request.log` or app logging for operational errors. Do not log secrets, raw tokens, full provider payloads with credentials, or password values.
- Rate-limit auth, AI, public, and webhook-like endpoints based on abuse risk.
- Return stable error shapes: `{ error: string }` plus structured fields when the UI depends on them.
- Do not add background work with `void` unless failure is non-critical and logged or persisted for follow-up.

## Database Guidelines

- Add Prisma migrations for schema changes and review generated SQL before launch.
- Index tenant-scoped list, search, and lifecycle fields used in hot paths.
- Use composite tenant constraints for cross-tenant safety, for example `[id, tenantId]` relations where practical.
- Keep provider IDs unique only at the correct scope. Global uniqueness is fine for Stripe customer/subscription IDs and external webhook IDs when provider semantics allow it.
- Avoid long transactions around external API calls. Persist pending state, call the provider, then persist success/failure when practical.

## Frontend Guidelines

- Build the actual workspace experience first. Avoid marketing-page patterns inside app surfaces.
- Keep the app ergonomic for field use: dense but readable layouts, 44px mobile tap targets, clear primary actions, and no fragile hover-only workflows.
- Use existing shared primitives in `web/src/components/ui` before adding custom controls.
- Use lucide icons for icon buttons when available.
- Keep cards for repeated records, modals, and framed tools. Avoid nested cards and decorative layout noise.
- Keep React state stable. Address `react-hooks/exhaustive-deps` warnings instead of suppressing them unless there is a documented reason.
- Keep API calls centralized in `web/src/lib/api.ts` until a generated/shared API contract is introduced.
- Handle API errors with user-actionable messages and avoid exposing internal provider errors directly.

## Security And Privacy

- Browser auth uses an HttpOnly session cookie. Frontend API calls must use `credentials: "include"` and must not store JWTs in `localStorage`.
- Enforce strong production `JWT_SECRET` and non-localhost `APP_URL`/`API_URL` through env validation.
- Keep CORS locked to production app origins. Do not use wildcard CORS in production.
- Keep `SESSION_COOKIE_SAME_SITE=lax` for same-site web/API deployments when possible. If cross-site cookies become necessary, add explicit CSRF protection before using `SameSite=None`.
- Use Helmet and rate limits by default. Revisit CSP before final public launch if inline assets/scripts change.
- Do not expose OpenAI, Stripe secret, Twilio auth, QuickBooks client secret, or database credentials to Vite env vars.
- Treat quote/customer data as sensitive small-business data. Avoid adding analytics that records PII, quote text, phone numbers, or addresses unless explicitly required and disclosed.

## Deployment Checklist

- API:
  - Build with `npm install`, `npm run prisma:generate`, and `npm run build`.
  - Start with `npm run start:prod` so `prisma migrate deploy` runs before `node dist/server.js`.
  - Configure health check at `/v1/health`.
  - Set production env vars in the host, not in files.
- Frontend:
  - Build from `web` with `npm run build`.
  - Set `VITE_API_BASE_URL` to the production API origin.
  - Keep SPA fallback configured through `web/vercel.json`.
- Database:
  - Use managed PostgreSQL with backups enabled.
  - Confirm migration deploy succeeds against a staging or production-like database before public launch.
- Providers:
  - Stripe products, prices, webhook secret, and webhook URL must match production.
  - OpenAI key and model must be configured on the API runtime only.
  - QuickBooks redirect URI and webhook verifier must match production URLs.
  - Twilio webhook routes should stay disabled unless credentials and signature validation are configured.

## Current Launch Risks To Track

- No automated backend or end-to-end test suite yet.
- Frontend lint has React hook dependency warnings in dashboard and quote workflow files.
- Add explicit CSRF protection if deployment requires `SESSION_COOKIE_SAME_SITE=none`.
- Production launch still depends on owner-managed provider setup: domain/DNS, Stripe live prices/webhooks, OpenAI key, QuickBooks app approval/config, support inbox, and legal copy review.
- Run real device smoke tests for the full customer-to-quote-to-send workflow on mobile before public launch.
