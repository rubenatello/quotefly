# QuoteFly Development Plan

**Target launch date:** `2026-05-01`  
**Current date:** `2026-04-10`  
**Launch objective:** production-ready mobile-first quoting CRM for contractors with billing, onboarding, PDF quoting, and QuickBooks CSV export working end to end.

## Product Scope For V1

QuoteFly V1 will ship with:

- Multi-tenant auth and tenant isolation
- Mobile-first CRM workspace
- Customer creation and duplicate protection
- Quote builder and quote desk
- AI Chat-to-Quote draft generation
- Saved standard/custom jobs by trade
- Branding with logo, business info, and PDF themes
- Quote PDF download/share flow
- Lead pipeline with won/closed/after-sale stages
- QuickBooks-friendly invoice CSV export
- Stripe subscriptions and plan enforcement

V1 will **not** block launch on:

- Direct QuickBooks OAuth sync
- Yelp or Angi lead ingestion
- Twilio SMS delivery
- Market pricing benchmark network
- Supplier material pricing APIs

## Current State

Already in place:

- Neon Postgres and Prisma schema
- Railway API and Vercel web deployment path
- JWT auth and tester/superuser support
- Public marketing pages and legal/support pages
- Stripe checkout/webhook foundation
- Quote lifecycle and after-sale follow-up stages
- Saved work presets and canonical job naming
- Customer/quote lookup in builder and quote desk
- Branding save fixes and readable PDF contrast logic

Still launch-critical:

- Deterministic production deploy and migration strategy
- Full Stripe billing QA
- Full onboarding QA on mobile
- Real QuickBooks CSV import smoke test
- Seat and AI quota enforcement QA
- Final signed-in UX cleanup on dashboard/admin
- Launch ops checklist and owner-side provisioning

## Critical Path

These are the tasks that must be complete for `2026-05-01`:

1. Production deploy is deterministic
2. Billing works end to end
3. Signup to first quote works cleanly on mobile
4. Quote send/export works without confusion
5. Plan limits are actually enforced
6. Support/legal/domain setup is complete
7. Launch QA is passed on real devices

## Weekly Plan

## Phase 1: Core Hardening
**Dates:** `2026-04-10` to `2026-04-14`

Engineering:

- Finalize signed-in workflow ordering
- Tighten dashboard pipeline rows and lead priority
- Finalize branding save, template behavior, and PDF sender info
- Add deterministic deploy/start strategy for Railway
- Confirm production Prisma migrations are safe on every deploy

Definition of done:

- New user can sign in, complete setup, save branding, create customer, create quote, and open quote desk
- API deploy process is explicit and repeatable

## Phase 2: Billing And Enforcement
**Dates:** `2026-04-15` to `2026-04-19`

Engineering:

- Run live Stripe checkout test for Starter, Professional, Enterprise
- Validate webhook updates and in-app plan refresh
- Validate seat limits by plan
- Validate AI quote limits by plan
- Tighten admin plan/seat messaging

Definition of done:

- Trial and paid tenants land in the correct plan state
- Limits reflect in UI and API behavior, not just copy

## Phase 3: Workflow QA And Launch Polish
**Dates:** `2026-04-20` to `2026-04-24`

Engineering:

- Real QuickBooks CSV import smoke test with mixed quotes
- Mobile QA across setup, pipeline, builder, and quote desk
- Clean remaining rough UI on admin/dashboard/history
- Improve template set so all quote templates feel standard and production-safe
- Add launch-safe monitoring/log review checklist

Definition of done:

- Full contractor workflow succeeds on phone:
  - setup
  - branding
  - customer
  - quote
  - PDF
  - QuickBooks export

## Phase 4: Release Candidate
**Dates:** `2026-04-25` to `2026-04-28`

Engineering:

- Fix only launch-critical defects
- Freeze schema except for bug fixes
- Freeze new feature scope
- Run regression pass on auth, billing, quoting, branding, exports

Business/ops:

- Confirm support inbox
- Confirm domain/canonical redirects
- Confirm production env vars
- Confirm Stripe production products/prices are live

Definition of done:

- Release candidate is stable enough for soft launch

## Phase 5: Soft Launch And Final Cut
**Dates:** `2026-04-29` to `2026-05-01`

Engineering:

- Soft launch with controlled users
- Review logs, webhook events, and customer feedback
- Fix only blocking defects

Business/ops:

- Publish official launch
- Move testimonials and pricing copy to final version

## Engineering Priority Order

This is the order to execute remaining work:

1. Deploy/migration safety
2. Billing QA and limit enforcement
3. Onboarding and mobile workflow polish
4. QuickBooks real import validation
5. Dashboard/admin cleanup
6. Launch analytics and monitoring sanity checks

## Owner-Critical Setup Items

These require owner action and can block launch:

1. Provision `support@quotefly.us`
2. Confirm `quotefly.us` and `api.quotefly.us` are resolving correctly
3. Keep Railway and Vercel env vars in sync with production values
4. Confirm Stripe production prices and webhook destination are correct
5. Confirm legal copy is acceptable for launch
6. Run one real QuickBooks Online import test account if available
7. Approve final testimonials and public copy

## Launch Readiness Checklist

The app is launch-ready only when all of these are true:

- [ ] Signup works in production
- [ ] Login/session restore works in production
- [ ] Onboarding works on phone
- [ ] Branding save works on phone and desktop
- [ ] Quote creation works from AI and manual flow
- [ ] Quote PDF downloads with correct branding and readable colors
- [ ] Email/text/copy actions behave correctly
- [ ] Quote lifecycle updates reflect in pipeline
- [ ] QuickBooks CSV imports cleanly in a real test
- [ ] Stripe checkout and webhook flow are verified
- [ ] Seat limits and AI limits are enforced
- [ ] Support/legal pages are complete
- [ ] Production monitoring/log review path exists

## Scope Freeze Rules

Between `2026-04-25` and `2026-05-01`:

- No new platform integrations
- No schema expansion unless it fixes a launch bug
- No new marketing routes unless they fix conversion or legal gaps
- No deep refactors unless they unblock deploy stability

## Deferred After Launch

These move to post-launch:

- QuickBooks OAuth direct sync
- Regional price benchmark engine
- Yelp/Angi integrations
- Twilio messaging
- Supplier pricing data
- Advanced analytics expansion
