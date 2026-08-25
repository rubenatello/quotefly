# QuoteFly Jobs, Booking, Dispatch, and Invoicing Spec

The canonical implementation plan lives at:

- [`docs/plan/activity-job-dispatch-plan.md`](docs/plan/activity-job-dispatch-plan.md)

Keep this root-level file as a stable pointer for planning discussions and future agent runs. Do not duplicate the checklist here; update the canonical plan instead so status, scope, and release gates stay in one place.

## Current status

- Activity, assignable tasks, accepted-quote Jobs, booking, day/week scheduling, dispatch lifecycle, in-app notifications, notification retention, and Kody schedule and quote-review tools are implemented on `main` at `b72ec1b`.
- The internal QuoteFly invoice ledger and accepted-Quote/completed-Job invoice panels are implemented and release-verified on that same product baseline.
- The public quote-to-job story, twelve sanitized first-party product captures, default-off legacy QuickBooks containment, and the review-only Kody prompt-to-quote contract are included in that `main` baseline. The exact-sha CI launch gate is green; the separate live-provider Kody evaluation failed 4/6 and the current workspace contains a focused remediation pending an exact-sha rerun.
- The current uncommitted Phase 4B candidate adds durable Invoice-owned QuickBooks publish claims, stable provider request IDs, immutable realm/exact-payload review binding, expired-claim recovery, exact-fingerprint unknown-result quarantine/reconciliation, tenant RLS, and a review-first English/Spanish UI. Its exact local launch gate passes with all 58 migrations, 116 inventoried routes, 240/240 integration tests, and 92 executed browser scenarios plus one intentional capture skip; focused QuickBooks Invoice coverage passes 18/18, backend/security/UX specialists approve it, and Opera independently approves it with no release-blocking findings. Provider workflows remain default-off. Provider payment handling, refunds/disputes, payment webhooks, the exact-SHA live-provider Kody rerun, and production enablement remain pending.
- Production promotion and provider enablement remain separate operational steps; a committed or CI-approved capability is not automatically deployed.

## Public-site handoff

The approved product-story, claims, and screenshot brief lives at:

- [`docs/design/quotefly-site-improvements.md`](docs/design/quotefly-site-improvements.md)
