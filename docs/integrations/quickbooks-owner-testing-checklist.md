# QuickBooks Owner Testing Checklist — Paused

Status: Not a current production or launch checklist. `QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED` must remain `false` until a separate durable provider-sync release is approved.

## Current release acceptance

- [x] Provider workflows default off.
- [x] Owner/admin authorization is revalidated from current membership state.
- [x] Connect, callback, push, refresh/fetch, and a correctly signed nonempty webhook make zero provider calls while paused.
- [x] Paused provider routes return stable retryable `503 QUICKBOOKS_PROVIDER_WORKFLOWS_UNAVAILABLE`.
- [x] The paused release returns provider-unavailable `503` before invoice validation; the explicitly enabled legacy test path separately fails taxable pushes closed with `422 QUICKBOOKS_TAX_SYNC_UNSUPPORTED`.
- [x] The removed legacy `force` body field is rejected.
- [x] Public product and Pricing copy do not claim QuickBooks invoice creation or reconciliation.

Do not enable Invoice or Payment webhook subscriptions, complete OAuth consent, push an invoice, or record a provider payment as part of the current launch.

## Required future provider release

Before this checklist can become executable, the provider slice must add and independently verify:

1. A durable Invoice-based `PROCESSING` claim and idempotent request identity before any Intuit mutation.
2. Explicit handling for provider timeout, crash-after-create, and unknown result reconciliation.
3. A durable webhook inbox/lease/retry worker before acknowledging callbacks.
4. Forced RLS and composite tenant foreign keys for QuickBooks connection, mapping, sync, and webhook records.
5. Approved tax mapping; taxable invoices must remain blocked until then.
6. Duplicate-customer and duplicate-item review instead of blind exact-name creation.
7. Concurrent push, retry, process-restart, webhook replay, cross-tenant, role-removal, and rollback tests.
8. A production inventory of provider credentials, connections, webhook subscriptions, alert destinations, and an approved credential-safe rollback procedure.

## Future owner verification outline

Only after the requirements above are release-approved:

- Connect one sanitized test tenant to a dedicated QuickBooks sandbox.
- Verify customer and item mapping through an explicit review surface.
- Create one non-taxable invoice through the durable claim path and prove an idempotent retry creates no duplicate.
- Simulate provider timeout and process restart, then reconcile the uncertain result without replaying the mutation.
- Persist a signed webhook before acknowledgement, replay it, and prove one durable outcome.
- Verify a removed/downgraded member cannot view provider metadata or act.
- Keep taxable creation blocked until the tax contract is separately approved.

Passing this future outline still does not authorize production enablement; that remains an explicit owner and release-operations decision.
