# QuoteFly Stack Decision (V1)

## Final choice

- Runtime: Node.js 22+
- Language: TypeScript
- Backend framework: Fastify
- Database: PostgreSQL
- ORM + migrations: Prisma
- Auth for V1: tenant-owner bootstrap, then Clerk or Auth.js in sprint 2
- Billing: Stripe subscriptions
- Messaging: Twilio
- API spec/docs: OpenAPI via @fastify/swagger
- Hosting target: Railway or Render for API + Neon/Supabase for Postgres

## Why this is cost-effective and scalable

- Fastify keeps compute lightweight with low memory overhead.
- PostgreSQL scales from single instance to managed high-availability plans.
- Prisma speeds early development while keeping SQL portability.
- Stripe + Twilio are usage-based and easy to start small.
- API-first design supports future integrations like QuickBooks Online.

## API strength for future integrations

- Resource-based endpoints under /v1
- Stable tenant-scoped IDs
- Clear separation of internal costs vs customer-visible prices
- Webhook architecture suitable for QuickBooks sync, accounting exports, and automation workers

## Related architecture docs

- Multi-tenant schema and UTC timestamp policy: `docs/architecture/multi-tenant-data-plan.md`
