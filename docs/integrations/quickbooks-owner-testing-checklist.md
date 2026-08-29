# QuickBooks Owner Testing Checklist — Paused

Status: Acceptance checklist for a future, separately authorized sandbox run. It is not a production or current launch procedure. Keep `QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED=false` until every prerequisite is approved.

Use this with [QuickBooks Hosted Payments And Reconciliation](quickbooks-hosted-payments-reconciliation.md). Mocked tests, local builds, and schema presence are not Intuit sandbox evidence.

The operator sequence and staging environment variables are documented in [QuickBooks Online sandbox setup](quickbooks-sandbox-setup.md).

The engineering candidate has provider-shaped automated tests for a
`RefundReceipt` that canonically links one payment and one target invoice,
including partial/full projection and ambiguous-link quarantine. Those fixtures
are intentionally listed as automated evidence only. The live sandbox steps
below remain unchecked until Intuit returns and reconciles the same relationship
in an explicitly authorized sandbox run.

## Current release containment

- [x] Provider workflows default off.
- [x] The supported external accounting handoff is QuickBooks-friendly CSV.
- [x] Public product and Pricing copy do not claim QuickBooks invoice creation, hosted payment, or reconciliation.
- [ ] Exact candidate containment tests prove paused connect, callback, publish, refresh, reconcile, and signed webhook paths make zero Intuit calls.
- [ ] Exact candidate confirms taxable invoices remain blocked and the legacy Quote-based provider write remains retired.

Do not execute the sections below until the automated candidate gate, migration rehearsal, Sentinel review, Opera approval, and explicit sandbox authorization are recorded.

## Automated candidate gate

- [ ] Record the exact committed SHA; `npm run verify` and database-backed `npm run verify:launch` pass on that SHA.
- [ ] Fresh migrations and a production-like upgrade rehearsal both pass through the isolated migration job.
- [ ] Every tenant-owned QuickBooks table has forced RLS, composite tenant integrity where practical, and two-tenant runtime-role denial.
- [ ] OAuth state is one-time, short-lived, and live-user/workspace bound; realm changes and replay fail closed.
- [ ] Railway/Render/Vercel/CDN access logs omit or redact query strings on the OAuth callback; confirm test `code`, `state`, `realmId`, customer-search text, and billing email never appear in retained logs.
- [ ] Force a post-exchange authorization/CAS rejection and an immediate revocation timeout; confirm exactly one encrypted orphan-revocation row, no active or overwritten connection, no credential in the response/logs, and a successful worker retry that erases the ciphertext.
- [ ] Exercise a synthetic orphan-revocation terminal failure and confirm the `QUICKBOOKS_ORPHAN_REVOCATION_DEAD` alert reaches the owner without token, realm, customer, or provider-payload data.
- [ ] Refresh-token rotation is serialized; disconnect/revocation and `REVOCATION_PENDING` recovery are covered.
- [ ] Invoice publish uses one durable claim and deterministic provider request identity; concurrent, timeout, crash, and local-commit ambiguity never cause a blind second create.
- [ ] A signed webhook is durably committed before `2xx`, then supports deduplication, lease expiry, bounded retry/backoff, dead-letter, and idempotent replay.
- [ ] Webhook, manual refresh, and CDC use one canonical reconciliation service.
- [ ] Unpaid, partial, paid, partial/full refund, reversal, payment deletion, multi-invoice payment, void, duplicate, delayed, and out-of-order states are covered.
- [ ] Hosted invoice-link hostname, authorization, no-store, no-referrer, no-log, no-analytics, and no-AI boundaries are covered.
- [ ] Provider timeouts, throttling, `Retry-After`, schema validation, queue limits, and sanitized logs/metrics are covered.

## Production-like migration rehearsal

- [ ] Restore a dated sanitized backup into an isolated database branch.
- [ ] Record candidate SHA, source snapshot, migration list, start/end time, affected row counts, and lock/availability observations.
- [ ] Measure the Invoice billing-email backfill, InvoicePayment unique-index replacement, QuickBooks foreign-key replacements, new indexes, realm-binding backfill, and forced-RLS activation.
- [ ] Start the candidate API using only the non-owner `quotefly_runtime` URL and verify `/v1/health` and `/v1/ready`.
- [ ] Smoke auth/session, customer, quote, Job, Invoice, CSV, and paused QuickBooks routes after migration.
- [ ] Verify the runtime role sees only the active tenant across every QuickBooks table and sees the minimal global realm-routing table only through its intended internal path.
- [ ] Rehearse backup restore and the forward-fix path. Record that rollback to an older binary is prohibited after forced RLS unless compatibility is separately proven.

## Explicitly authorized Intuit sandbox run

- [ ] Record sandbox authorization, candidate SHA, app/environment, exact callback URI, webhook endpoint, test company, approved scopes, and evidence owner.
- [ ] Confirm the webhook verifier and independent current token-encryption key are configured server-side only.
- [ ] Connect one sanitized approved internal tenant; prove state replay, expired state, role removal, realm mismatch, and cross-tenant access fail closed.
- [ ] Review customer, item, company, billing email, payment-method choices, totals, due date, and every line before publishing.
- [ ] Create one non-taxable invoice and prove an idempotent replay creates no duplicate.
- [ ] Retrieve and safely present the QuickBooks-hosted invoice link without logging or caching it.
- [ ] Complete partial payment and full payment; verify QuoteFly remains `OPEN` then becomes `PAID` only after canonical provider reconciliation.
- [ ] Complete partial/full refund or reversal and confirm the balance reopens while append-only history remains.
- [ ] Void the provider invoice and confirm the bounded QuoteFly projection.
- [ ] Deliver duplicate and out-of-order Invoice/Payment webhooks and prove one durable ledger outcome.
- [ ] Drop one webhook and prove overlapping CDC repairs it without duplicating payment applications or events.
- [ ] Simulate provider timeout and process restart; reconcile the unknown result without another invoice mutation.
- [ ] Simulate token refresh concurrency and a revocation failure; prove serialized rotation and blocked `REVOCATION_PENDING` recovery.

## Monitoring and support evidence

- [ ] Dashboards expose content-free queue age, retries, dead letters, uncertain operations, token failures, CDC lag, and provider latency/error rate.
- [ ] Every alert has a named person/team, destination, threshold, severity, acknowledgement target, and escalation path.
- [ ] Dead-letter replay and manual reconciliation require an authorized owner/admin and produce an immutable audit event.
- [ ] Support guidance covers duplicate concern, pending reconciliation, payment/refund mismatch, expired link, revoked connection, and provider outage without exposing provider secrets.
- [ ] Accounting/tax owner confirms the pilot is non-taxable; taxable publishing remains blocked.

## Production approval gate

- [ ] Intuit production app approval and QuickBooks Payments merchant eligibility are documented.
- [ ] Contractor accepts Intuit's processing fees, payment-method availability, settlement account, and refund/dispute responsibilities.
- [ ] Production callback, webhook, credential, realm, connection, token-key, alert, backup, and support inventories are approved.
- [ ] Sentinel and Opera approve the exact production candidate after sandbox evidence.
- [ ] Owner explicitly authorizes the production migration, provider configuration, webhook subscription, and limited tenant pilot as separate actions.

Passing this checklist does not itself enable production. Broad availability and marketing require a separate recorded go/no-go after the limited pilot.
