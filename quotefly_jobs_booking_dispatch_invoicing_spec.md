# QuoteFly Jobs, Booking, Dispatch, and Invoicing Spec

The canonical implementation plan lives at:

- [`docs/plan/activity-job-dispatch-plan.md`](docs/plan/activity-job-dispatch-plan.md)

Keep this root-level file as a stable pointer for planning discussions and future agent runs. Do not duplicate the checklist here; update the canonical plan instead so status, scope, and release gates stay in one place.

## Current status

- Activity, assignable tasks, accepted-quote Jobs, booking, day/week scheduling, dispatch lifecycle, in-app notifications, notification retention, and Kody schedule review tools are implemented and release-verified on `main` at `543fc69`.
- The internal QuoteFly invoice ledger and accepted-Quote/completed-Job invoice panels are implemented and release-verified on that same product baseline.
- The current local sellability candidate expands the public quote-to-job story, adds twelve sanitized first-party product captures, and keeps legacy QuickBooks provider workflows default-off behind live owner/admin authorization. Its exact database-backed gate passes `213/213` integration tests; browser evidence covers `88/88` executed scenarios plus one intentional opt-in capture skip; the focused QuickBooks Settings role regression passes `2/2`. Security, UX, SEO, release-operations, and final engineering reviews approve it for the next explicitly authorized BCP. It has not been committed or pushed yet.
- Durable QuickBooks invoice claims/reconciliation, provider payment handling, refunds/disputes, and payment webhooks remain pending in Phase 4.
- Production promotion and provider enablement remain separate operational steps; a committed or CI-approved capability is not automatically deployed.

## Public-site handoff

The approved product-story, claims, and screenshot brief lives at:

- [`docs/design/quotefly-site-improvements.md`](docs/design/quotefly-site-improvements.md)
