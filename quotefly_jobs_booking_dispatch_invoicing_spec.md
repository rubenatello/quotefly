# QuoteFly Jobs, Booking, Dispatch, and Invoicing Spec

The canonical implementation plan lives at:

- [`docs/plan/activity-job-dispatch-plan.md`](docs/plan/activity-job-dispatch-plan.md)

The current cross-area safety and completeness ledger lives at:

- [`docs/plan/quotefly-critical-improvements-program.md`](docs/plan/quotefly-critical-improvements-program.md)

Keep this root-level file as a stable pointer for planning discussions and future agent runs. Do not duplicate the checklist here; update the canonical plan instead so status, scope, and release gates stay in one place.

## Current status

- Activity, assignable tasks, accepted-quote Jobs, booking, day/week scheduling, dispatch lifecycle, in-app notifications, notification retention, and Kody schedule and quote-review tools are implemented on `main` at `b72ec1b`.
- The internal QuoteFly invoice ledger and accepted-Quote/completed-Job invoice panels are implemented and release-verified on that same product baseline.
- The public quote-to-job story, twelve sanitized first-party product captures, default-off legacy QuickBooks containment, and the review-only Kody prompt-to-quote contract are included in that `main` baseline. The exact-sha CI launch gate is green; the separate live-provider Kody evaluation failed 4/6 and the current workspace contains a focused remediation pending an exact-sha rerun.
- Historical Phase 4B work added durable Invoice-owned QuickBooks publish claims, stable provider request IDs, immutable realm/exact-payload review binding, expired-claim recovery, exact-fingerprint unknown-result quarantine/reconciliation, tenant RLS, and a review-first English/Spanish UI. Its earlier local counts and review record are superseded and must not be used as evidence for the current candidate. Current migration, route, integration, browser, provider, and Opera evidence lives only in the [critical improvements program](docs/plan/quotefly-critical-improvements-program.md) after the exact working tree finishes its gates. Provider workflows remain default-off; payment handling, refunds/disputes, payment webhooks, live-provider evaluation, and production enablement remain pending.
- Production promotion and provider enablement remain separate operational steps; a committed or CI-approved capability is not automatically deployed.

## Public-site handoff

The approved product-story, claims, and screenshot brief lives at:

- [`docs/design/quotefly-site-improvements.md`](docs/design/quotefly-site-improvements.md)
