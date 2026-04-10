# QuoteFly

Backend-first QuoteFly scaffold focused on low-cost deployment and fast iteration.

## Selected stack

- Backend/API server: Fastify + TypeScript
- Data: PostgreSQL + Prisma
- Payments: Stripe
- SMS: Twilio webhook pipeline
- Frontend: React + TypeScript + React Compiler + Vite + Tailwind CSS v4
- API docs: OpenAPI/Swagger at /docs

## Quick start

1. Install dependencies:

```bash
npm install
npm --prefix web install
```

2. Configure environment:

- Duplicate .env.example to .env
- Set DATABASE_URL and provider keys
- Duplicate web/.env.example to web/.env

3. Generate Prisma client and run migrations:

```bash
npm run prisma:generate
npm run prisma:migrate
```

4. Run API:

```bash
npm run dev
```

This command starts the backend and API process (same server).

5. Run the mobile-first UI preview:

```bash
npm run dev:web
```

6. Open app and docs:

- UI: http://localhost:5173
- API docs: http://localhost:4000/docs

## Running both during development

Use two terminals:

Terminal A:

```bash
npm run dev:api
```

Terminal B:

```bash
npm run dev:web
```

Optional mobile device testing on your local network:

```bash
npm run dev:web:host
```

## Development Servers

- Backend/API server: http://localhost:4000
- API health endpoint: http://localhost:4000/v1/health
- API docs: http://localhost:4000/docs
- Frontend app: http://localhost:5173

## Tailwind CSS

Tailwind v4 is enabled in the frontend using the Vite plugin.

- Plugin setup: web/vite.config.ts
- Tailwind import: web/src/index.css

Use Tailwind utility classes directly in React components.

## Notes

- Vite frontend reads API URL from web/.env or defaults to http://localhost:4000
- Create web/.env from web/.env.example when needed

## Environment Variables

### Backend (.env)

- `DATABASE_URL`: Postgres connection string
- `PORT`: API port (default `4000`)
- `NODE_ENV`: `development` | `test` | `production`
- `JWT_SECRET`: at least 32 characters
- `STRIPE_SECRET_KEY`: Stripe secret key (`sk_test_...` or `sk_live_...`)
- `STRIPE_WEBHOOK_SECRET`: Stripe webhook signing secret (`whsec_...`)
- `STRIPE_PRICE_ID_STARTER`: Stripe starter plan price id (`price_...`)
- `STRIPE_PRICE_ID_PROFESSIONAL`: Stripe professional plan price id (`price_...`)
- `STRIPE_PRICE_ID_ENTERPRISE`: Stripe enterprise plan price id (`price_...`)
- `APP_URL`: frontend URL (e.g. `http://localhost:5173`, `https://quotefly.us`)
- `API_URL`: API URL (e.g. `http://localhost:4000`, `https://api.quotefly.us`)
- `ENABLE_TWILIO_SMS`: set `true` to enable Twilio SMS webhook routes (default `false`)
- `TWILIO_ACCOUNT_SID`: optional for SMS features
- `TWILIO_AUTH_TOKEN`: optional for SMS features
- `TWILIO_WEBHOOK_AUTH_TOKEN`: optional webhook verification token

### Frontend (web/.env)

- `VITE_API_BASE_URL`: backend API origin
- `VITE_STRIPE_PUBLISHABLE_KEY`: Stripe publishable key (`pk_test_...` or `pk_live_...`)

## Billing Tiers

- Tier definitions and Stripe mapping:
  - `docs/plan/subscription-tiers.md`

## Accounting Export

- QuickBooks-friendly invoice CSV export guide:
  - `docs/integrations/quickbooks-csv-import.md`

## Backend-first scope included

- Tenant and customer APIs
- Quote creation API with cost/price separation
- SMS inbound webhook endpoint for quote intake automation
- Prisma schema designed for multi-tenant expansion
