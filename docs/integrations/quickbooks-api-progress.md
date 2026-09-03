# QuickBooks API Progress

Last updated: 2026-09-03

Status: Hosted-payment and reconciliation engineering candidate in progress. Provider workflows remain default-off, unavailable to customers, and unapproved for sandbox or production enablement.

The acceptance contract is [QuickBooks Hosted Payments And Reconciliation](quickbooks-hosted-payments-reconciliation.md). That contract defines the authoritative workflow, security boundary, state projection, recovery behavior, and evidence required before enablement.

## Current supported accounting workflow

- Create and review an internal QuoteFly invoice from an accepted quote or completed Job.
- Export accounting data through the QuickBooks-friendly CSV workflow.
- Allow current owners/admins to inspect local QuickBooks configuration state or disconnect locally stored credentials.

QuoteFly does not currently offer customer-available QuickBooks Online connection, invoice creation, hosted-payment delivery, invoice/payment reconciliation, tax sync, or webhook automation. No Intuit sandbox result, QuickBooks Payments eligibility, production app approval, or production provider operation is claimed.

## Engineering candidate

The repository contains a default-off candidate for:

- OAuth connection state and encrypted token storage;
- explicit customer and item mappings;
- signed, bounded webhook ingestion for both legacy Intuit envelopes and CloudEvents v1.0;
- an Invoice-owned durable publish claim with deterministic provider request identity;
- unknown-result quarantine and read-only reconciliation;
- restricted hosted invoice-link storage;
- terminal-state and disconnect/reconnect invalidation for cached hosted invoice links;
- purpose-bound AES-256-GCM encryption for cached hosted invoice links, with current/previous-key rotation support and fail-closed legacy invalidation;
- an explicit `NEEDS_REAUTH` lifecycle when Intuit rejects a refresh credential, without treating ordinary company-permission failures as credential loss;
- a durable webhook inbox state machine, CDC cursor, realm-routing record, and revocation-pending state;
- tenant-composite relationships and forced RLS for tenant-owned QuickBooks records;
- projection into QuoteFly's internal Invoice and InvoicePayment ledger.

Presence in the schema or code is not availability. The candidate must pass the exact automated, migration, sandbox, security, operational, and independent-review evidence below before the provider flag may be changed.

The current worktree includes automated provider-shaped coverage for bounded
`RefundReceipt` reads, webhook and CDC recognition, partial/full ledger
projection, payment-deletion recovery, idempotent replay, and fail-closed ambiguous linkage. This is local
test evidence only: it does not prove how a live Intuit sandbox company links a
refund receipt, payment, and invoice, and it does not satisfy the owner-managed
sandbox refund/reversal checkbox below.

`QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED=false` remains the required release posture:

- provider-capable connect, callback, publish, refresh, reconciliation, and webhook-processing paths must make no Intuit call while paused;
- taxable invoice publishing remains blocked until a separate tax-mapping contract is approved;
- the legacy Quote-based invoice-write route remains retired;
- current owner/admin membership is required for provider configuration or mutations;
- QuickBooks-friendly CSV remains the supported external accounting handoff.

## Enablement gates

### Automated candidate evidence

- [ ] Fresh-schema migration, Prisma validation, `npm run verify`, and database-backed `npm run verify:launch` pass on one exact committed SHA.
- [ ] Two-tenant runtime-role denial covers every tenant-owned QuickBooks table, relationship, route, worker, and replay path.
- [ ] Invoice publish, deterministic replay, timeout/crash quarantine, exact-fingerprint reconciliation, and concurrent serialization create no duplicate provider invoice.
- [ ] A signed webhook is committed before acknowledgement, then processed through lease, retry/backoff, dead-letter, and idempotent replay behavior.
- [ ] Webhook, manual refresh, and CDC call the same authoritative reconciliation service.
- [ ] Unpaid, partial, paid, refund, reversal, payment deletion, multi-invoice payment, void, duplicate, delayed, and out-of-order provider changes project correctly.
- [ ] Hosted invoice links pass approved-host validation and never enter logs, analytics, AI prompts, public quote payloads, or cacheable responses.
- [ ] Paid/void invoices and disconnect/reconnect transitions clear cached hosted links and require a fresh canonical reconciliation before re-exposure.
- [ ] OAuth state replay, callback realm mismatch, refresh-token race, disconnect, token revocation, and `REVOCATION_PENDING` recovery fail closed.
- [ ] Provider request timeouts, bounded read retries, `Retry-After`, queue limits, and content-free telemetry are covered.
- [ ] Sentinel reviews the complete provider/payment boundary and Opera independently approves the exact candidate.

### Migration rehearsal evidence

- [ ] Restore a recent sanitized production-like backup into an isolated branch and record source snapshot time, candidate SHA, migration start/end time, row counts, and outcome.
- [ ] Apply every checked-in migration through the isolated migration job using `DIRECT_DATABASE_URL`; never give that credential to the API runtime.
- [ ] Measure the Invoice billing-email backfill and QuickBooks index/foreign-key/RLS changes for lock duration and table impact.
- [ ] Start the candidate API with the non-owner `quotefly_runtime` role and verify health, readiness, auth, customer, quote, Job, Invoice, CSV, QuickBooks-paused behavior, and two-tenant denial.
- [ ] Prove the candidate API sets tenant RLS context for every QuickBooks path before routing traffic.
- [ ] Record a verified backup restore and forward-fix rehearsal. Do not roll the API back behind this migration after forced RLS is active.

### Owner-managed sandbox evidence

- [ ] Intuit sandbox app, exact HTTPS callback, webhook verifier, dedicated sandbox company, and QuickBooks Payments test eligibility are recorded without storing secrets in Git.
- [ ] One sanitized, explicitly approved internal tenant completes OAuth and one-time callback behavior.
- [ ] Reviewed customer/item mapping and one non-taxable invoice complete without blind customer/item creation.
- [ ] The hosted invoice link is retrieved and presented safely, then partial payment, full payment, refund/reversal, and void states reconcile.
- [ ] Duplicate and out-of-order webhooks, worker restart, dropped webhook repaired by CDC, and provider timeout produce one durable outcome.
- [ ] Disconnect revokes tokens, a simulated revocation failure becomes `REVOCATION_PENDING`, and reconnect cannot cross company/realm boundaries.
- [ ] Queue age, retries, dead letters, reconciliation-required records, token failures, CDC lag, and provider latency are visible to named alert owners.

### Production operations evidence

- [ ] Intuit production app approval, QuickBooks Payments merchant eligibility, fee ownership, supported payment methods, and contractor bank settlement are owner-confirmed.
- [ ] Credential, connection, realm, webhook subscription, and token-encryption-key inventories are current.
- [ ] Alert destinations, support owner, incident severity, replay authority, and reconciliation escalation are named.
- [ ] A credential-safe kill switch, token revocation, webhook disablement, forward-fix, and backup restore procedure is rehearsed.
- [ ] Public and in-product wording remains unavailable/coming soon until an explicitly authorized production pilot succeeds.

## Migration risks to carry into review

The committed migration `20260827120000_add_quickbooks_hosted_payment_reconciliation` is additive but coordinated:

- it enables and forces RLS on existing QuickBooks tables, so a binary that does not set `app.tenant_id` for those paths cannot safely run after migration;
- it backfills `Invoice.billingEmailSnapshot`, changes the InvoicePayment provider-application uniqueness rule, and adds indexes/foreign keys that require production-like lock and data-shape rehearsal;
- `QuickBooksRealmBinding` is intentionally a minimal non-secret routing table with forced tenant RLS plus a transaction-local, realm-exact webhook lookup policy; it must never accumulate tokens, company names, customer data, or public API exposure;
- stored hosted invoice links are restricted provider data and require no-log, no-cache, retention, backup, and incident handling evidence;
- migration `20260828180000_invalidate_stale_quickbooks_invoice_links` clears pre-existing cached links and provider generations once so the hardened lifecycle begins from a fresh canonical reconciliation;
- migration `20260902173500_add_quickbooks_reauth_connection_event` adds the reconnect audit event, expands the encrypted hosted-link envelope column, and invalidates pre-encryption cached links for canonical recovery;
- webhook lease/state invariants and OAuth user/membership binding must be proven at the service and database-backed test layers before enablement.

## Official references

- [QuickBooks Online OAuth 2.0](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0)
- [QuickBooks Online invoice workflow](https://developer.intuit.com/app/developer/qbo/docs/workflows/create-an-invoice)
- [QuickBooks Online webhooks](https://developer.intuit.com/app/developer/qbo/docs/develop/webhooks)
- [Intuit RefundReceipt entity reference](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippphpdevkitv3/entities/files/IPPRefundReceipt.html)
