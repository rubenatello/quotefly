# QuoteFly Jobs, Booking, Dispatch, and Invoicing Spec

The canonical implementation plan lives at:

- [`docs/plan/activity-job-dispatch-plan.md`](docs/plan/activity-job-dispatch-plan.md)

Keep this root-level file as a stable pointer for planning discussions and future agent runs. Do not duplicate the checklist here; update the canonical plan instead so status, scope, and release gates stay in one place.

## Current status

- Activity, assignable tasks, accepted-quote Jobs, booking, day/week scheduling, dispatch lifecycle, in-app notifications, and Kody schedule review tools are implemented and release-verified.
- The internal QuoteFly invoice ledger and accepted-Quote/completed-Job invoice panels are implemented and release-verified.
- Provider-backed QuickBooks invoice creation, payment handling, refunds/disputes, and webhook reconciliation remain pending in Phase 4.
- Production promotion and provider enablement remain separate operational steps; a committed or CI-approved capability is not automatically deployed.

## Public-site handoff

The approved product-story, claims, and screenshot brief lives at:

- [`docs/design/quotefly-site-improvements.md`](docs/design/quotefly-site-improvements.md)
