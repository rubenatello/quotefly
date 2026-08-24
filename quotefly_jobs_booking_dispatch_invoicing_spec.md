# QuoteFly Jobs, Booking, Dispatch, and Invoicing Spec

The canonical implementation plan lives at:

- [`docs/plan/activity-job-dispatch-plan.md`](docs/plan/activity-job-dispatch-plan.md)

Keep this root-level file as a stable pointer for planning discussions and future agent runs. Do not duplicate the checklist here; update the canonical plan instead so status, scope, and release gates stay in one place.

## Current status

- Activity, assignable tasks, accepted-quote Jobs, booking, day/week scheduling, dispatch lifecycle, in-app notifications, notification retention, and Kody schedule review tools are implemented on `main` at `8ceecb1`.
- The internal QuoteFly invoice ledger and accepted-Quote/completed-Job invoice panels are implemented and release-verified on that same product baseline.
- The public quote-to-job story, twelve sanitized first-party product captures, and default-off legacy QuickBooks containment are included in that `main` baseline. The current uncommitted workspace adds a review-only Kody prompt-to-quote contract: prioritized active-visible customer resolution or clarification, bounded tenant-catalog matching, preserved duration ranges, separate priced source-linked lines, and one minimal Quote Builder handoff with explicit merge/replace/keep handling for an existing draft. The full local gate and independent source review pass; exact-candidate database, browser, live-provider, staging, and owner-operated release evidence remain pending.
- Durable QuickBooks invoice claims/reconciliation, provider payment handling, refunds/disputes, and payment webhooks remain pending in Phase 4.
- Production promotion and provider enablement remain separate operational steps; a committed or CI-approved capability is not automatically deployed.

## Public-site handoff

The approved product-story, claims, and screenshot brief lives at:

- [`docs/design/quotefly-site-improvements.md`](docs/design/quotefly-site-improvements.md)
