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

## Backend-first scope included

- Tenant and customer APIs
- Quote creation API with cost/price separation
- SMS inbound webhook endpoint for quote intake automation
- Prisma schema designed for multi-tenant expansion
