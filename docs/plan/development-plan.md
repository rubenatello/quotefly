# Development Plan (Backend-first)

**🎯 MVP Goal:** Sellable, operational multi-tenant SaaS for contractor quotes with proven acquisition and retention.

**🔍 SEO Strategy:** Marketing website + in-app shareable quotes (public preview links, Open Graph metadata).

## Sprint 0 (this week)

- Finalize schema and tenant model
- Stand up API with health, tenant, customer, quote, sms webhook routes
- Add OpenAPI docs and environment setup
- **Tenant row-level security (RLS)** — Enforce data isolation at database level
- **Landing page UI** — Add public routes (/, /pricing, /about, /solutions) alongside protected /app routes
- **Trial schema** — Add trialStartsAt, trialEndsAt fields to Tenant model

## Sprint 1

- Add authentication and role-based access
- Build quote line-items CRUD and quote versioning
- Add PDF generation service and secure customer delivery links

## Sprint 2

- Implement SMS reply flow:
  - Reply 1 sends quote to customer
  - Reply 2 requests revision
- Add Stripe subscription gates and webhook handlers
- Add observability (structured logs + error tracking)

## Sprint 3

- Mobile-first frontend in Next.js + Tailwind
- **Onboarding flow for 14-day free trial:**
  - Trade selection and base pricing setup
  - Trial countdown + upgrade-to-pay flow
  - Payment collection (Stripe) on day 14 or earlier
- Follow-up reminders and customer communication log

## Sprint 4

- QuickBooks Online integration foundation:
  - OAuth setup
  - customer and invoice sync mapping
  - retry-safe webhook/event pipeline

## SEO & Acquisition (concurrent, starts Sprint 1)

### Marketing Pages (same web app)
- Landing page (`/`) — Hero, pain points, benefits
- Pricing page (`/pricing`) — Transparent pricing, trial CTA
- Solutions page (`/solutions`) — By trade (HVAC, Plumbing, etc.)
- About us (`/about`) — Team, mission, why QuoteFly
- Blog/knowledge base (linked from nav)

### In-App SEO
- Public quote preview links (no authentication required)
- Open Graph meta tags + share buttons (social signals)
- Structured data markup (schema.org LocalBusiness)
- Quote-specific meta descriptions for search preview

### Content Targets
- High-value: "HVAC quote software", "Contractor quoting tool", "Free trial quoting software"
- Long-tail: "How to write faster quotes", "Free quote template for [trade]"
- Authority: Blog posts on industry-specific workflows, trial benefits
