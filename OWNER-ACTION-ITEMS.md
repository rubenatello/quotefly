# QuoteFly -- Owner Action Items

## Launch Window

Target launch status: `ASAP readiness review` (original target: `2026-05-01`)

Reference plans:

- `docs/plan/launch-improvement-tracker-2026-05-01.md`
- `docs/plan/subscription-tiers.md`

## Immediate Launch Blockers

These are the owner-side items that still matter most before launch:

1. Confirm inbound and outbound delivery for the newly created `support@quotefly.us` and `info@quotefly.us` shared mailboxes
2. Confirm `quotefly.us`, `www.quotefly.us`, and `api.quotefly.us` are resolving correctly in production
3. Confirm Stripe production products, prices, and webhook destination are correct
4. Confirm Railway and Vercel env vars match production values
5. Keep direct QuickBooks provider workflows disabled; test only the supported QuickBooks-friendly CSV handoff
6. Review final legal/support copy before public launch
7. Verify quote board desktop column headers align with row values after latest UI fix
8. Run `node scripts/tier-unit-economics.mjs` and confirm AI budget caps before launch pricing is finalized

## 1. Environment Variables

Use a local `.env` only for local development. Configure staging and production values in Railway/Vercel; never copy the production database URL into the development environment.

```env
# Required — already should exist
DATABASE_URL=postgresql://...
JWT_SECRET=your-secure-random-secret

# Optional — enables AI-powered Chat-to-Quote via OpenAI
OPENAI_API_KEY=sk-...your-openai-api-key...
OPENAI_MODEL=gpt-4o-mini   # default if omitted

# Reserved provider foundation — do not enable for the current release
QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED=false
QUICKBOOKS_CLIENT_ID=...
QUICKBOOKS_CLIENT_SECRET=...
QUICKBOOKS_ENVIRONMENT=production
QUICKBOOKS_REDIRECT_URI=https://api.quotefly.us/v1/integrations/quickbooks/callback
QUICKBOOKS_WEBHOOK_VERIFIER=...
```

### Getting your OpenAI API key
1. Go to https://platform.openai.com/api-keys
2. Create a new secret key
3. Add it to `.env` as `OPENAI_API_KEY`
4. The AI service gracefully falls back to the regex parser if the key is missing
5. Set `OPENAI_API_KEY` and `OPENAI_MODEL` in Railway for production API runtime
6. Do not put the OpenAI secret in Vercel frontend env vars; QuoteFly calls OpenAI from the API layer only

### QuickBooks app setup
1. Keep `QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED=false` in every release environment.
2. Do not complete OAuth consent, subscribe provider webhooks, push invoices, or market direct QuickBooks Online sync for this release.
3. Inventory any retained provider credentials or connections because rolling back to a pre-containment binary could reopen provider calls.
4. Use the QuickBooks-friendly CSV export as the supported handoff.
5. Current containment runbook: `docs/integrations/quickbooks-owner-setup.md`
6. Authoritative provider status: `docs/integrations/quickbooks-api-progress.md`
7. Online/Desktop architecture is long-term context only: `docs/integrations/quickbooks-online-desktop-architecture.md`

### AI Models Approved for Production

| Setting | Approved model | Cost (input/output per 1M tokens) | Purpose |
|---------|----------------|-----------------------------------|---------|
| `OPENAI_MODEL` | `gpt-4o-mini` (default) | $0.15 / $0.60 | Chat-to-Quote and assistant composition |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` (default) | $0.02 / $0.00 | Grounded retrieval embeddings |

Do not set a different production model until it has been added to the governed pricing catalog and environment validation.

## 2. Database Migration

For local development against a dedicated development database:

```bash
npx prisma migrate dev
npx prisma generate
```

For staging and production, use checked-in migrations only:

```bash
npm run prisma:migrate:deploy
```

Follow `docs/billing-integrity-rollout.md` for the current billing migration. Do not run `migrate dev`, reconciliation, or ad-hoc SQL against production.

## 3. Public Pages and App Fallback

Public marketing routes are prerendered as route-specific HTML so search engines receive unique titles, descriptions, canonical URLs, headings, and structured data without running JavaScript.

Only `/app` and `/app/*` use the authenticated React app shell fallback. Those responses are marked `noindex`. Unknown routes use the static noindex `404.html`; they must not rewrite to the marketing homepage.

The checked-in `web/vercel.json` contains the production routing and indexing headers. Do not replace it with a catch-all rewrite.

## 4. New App Routes

| Route | View | Description |
|-------|------|-------------|
| `/` | Landing | Marketing homepage |
| `/pricing` | Pricing | Plan comparison |
| `/solutions` | Solutions | Use cases |
| `/about` | About | Team/mission |
| `/app` | Pipeline | Lead pipeline + stats (dashboard home) |
| `/app/build` | Quote Builder | AI Chat-to-Quote + forms + customer creation |
| `/app/quotes` | Quote Desk | Quote editing, line items, send actions |
| `/app/quotes/:id` | Quote Desk | Direct link to specific quote |
| `/app/history` | History | Revision history + communication log |
| `/app/branding` | Branding | Tenant branding settings |
| `/app/admin` | Admin | Admin panel |

## 5. Mobile Bottom Tab Bar

The app now features a fixed bottom navigation bar on mobile (`lg:hidden`) with 5 tabs:
- **Pipeline** → `/app`
- **Build** → `/app/build`
- **Quotes** → `/app/quotes`
- **History** → `/app/history`
- **More** → `/app/admin`

## 6. New UI Component Library

All new views use shared UI primitives from `web/src/components/ui/index.tsx`:
- `Button`, `Input`, `Select`, `Textarea` — all with 44px min touch targets
- `Card`, `CardHeader`, `Badge`, `Alert`, `EmptyState`, `Skeleton`, `Spinner`, `PageHeader`
- Use these for any new UI to maintain consistency

## 7. Analytics

Client-side analytics are buffered and will POST to `/v1/analytics/events` when you implement the endpoint. Currently events log to `console.debug` in development.

## 8. Build & Deploy

```bash
# Frontend build
cd web && npm run build

# Backend type-check
npx tsc --noEmit

# Full dev
npm run dev
```

### Railway Production Commands

Run checked-in schema migrations first from an isolated release job, using the privileged `DIRECT_DATABASE_URL`:

```bash
npm run prisma:migrate:deploy
```

Only after that job succeeds, use this as the Railway start command for the API service. The runtime service should have only the least-privileged `DATABASE_URL`:

```bash
npm run start:prod
```

`start:prod` starts the API; it does not run Prisma migrations. Keeping migrations in the isolated release job makes their ownership and outcome explicit.

## 9. Cost Estimation (AI Usage)

Each Chat-to-Quote AI call uses ~500-800 tokens. At `gpt-4o-mini` pricing:
- **Basic plan** (30 AI quotes/month): still effectively pennies per month
- **Professional plan** (300 AI quotes/month): still very low cost for normal usage
- **Enterprise plan** (800 AI quotes/month): materially higher than the other tiers, but still manageable if prompts and outputs stay disciplined

The existing regex parser continues to work as a free fallback.

## 10. QuickBooks CSV Export

- Use `App > Build > Quote List` to select one or more quotes.
- Click **Export QuickBooks CSV** to download invoice-style rows.
- Import guide: `docs/integrations/quickbooks-csv-import.md`

