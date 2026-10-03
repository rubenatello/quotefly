# QuickBooks API Progress

Last updated: 2026-10-03

Status: Hosted-payment and reconciliation engineering candidate in progress. Owner-confirmed OAuth connection succeeded on isolated staging. User-facing invoice publishing and hosted payments remain disabled there; production provider workflows remain default-off and unavailable to customers.

Current implementation and evidence are tracked in the [September 13 release candidate](quickbooks-release-candidate-2026-09-13.md). Connection proof does not establish invoice, payment, webhook, or recovery behavior against Intuit.

The earlier deployed baseline and preserved release evidence are in the [September 27 checkpoint](quickbooks-checkpoint-2026-09-27.md), following the [September 23 staging ledger](quickbooks-staging-evidence-2026-09-23.md). On October 3, reviewed source `797b218f8db663206d48fc3f70392d46dade3dfa` passed GitHub CI 133: 641 database tests and 197 browser tests, with one existing optional browser skip. The isolated staging API now runs that source; all 739 deployed source files, runtime flags, database role, health, and readiness passed independent checks. Web rollout and worker restoration are tracked in the [October 3 checkpoint](quickbooks-checkpoint-2026-10-03.md). The API retains sandbox and connection-only safeguards. A bounded real sandbox customer/item lookup test previously passed and restored connection-only mode without selecting mappings or publishing records. Worker failure/restart and recovery checks passed, but operational email delivery and actual inbox receipt remain unproven. One isolated Neon point-in-time restore and guarded migration rehearsal passed and its temporary resources were removed; this does not establish production-volume recovery or a restore rehearsal of the later tax-ledger schema.

The [tax review contract](quickbooks-tax-review-contract.md), capture API/UI and preparatory ledger bind exact invoice inputs and retain uncertain provider-attempt evidence. An internal GET-only reader collects bounded, stripped tax facts through the existing credential wrapper. Manager-confirmed addresses, calendar date and line tax intent feed signed review evidence, with a shared publication lock preventing the direct non-tax path from ignoring taxable intent. The deployed API includes these prerequisites and partial provider-identity retention. Runtime migration-history privilege hardening was applied once to isolated staging on October 3 after all three database writers were stopped. The runner and independent postcheck confirmed 99 history rows, 98 completed, one historical rollback, zero unresolved, retained runtime reads and owner migration access, and removed runtime/PUBLIC write and grant escapes. Unrelated data and permissions were unchanged. Taxable invoices remain unavailable: real positive-tax Estimate/Invoice parity, signed webhook delivery and recovery evidence are still required. Keep these engineering prerequisites separate from advertised product capabilities.

October 3 remediation updates dependency security patches and prevents overdue or changed drafts, including invoices for canceled Jobs, from reaching the direct invoice CREATE request. Claim-time issuance avoids a local due-date constraint failure after provider latency. A guarded draft due-date correction lets users recover without bypassing provider or tax-review interlocks. This work passed independent source and exact staging artifact reviews and is deployed to the staging API. It does not authorize production availability or establish real-provider accounting behavior.

## October 3 offline preparation status

The normalized local sandbox-proof bundle at `.codex_tmp/qbo-tax-sandbox-proof-797-20261003` passes 48 plus 8 dependency-free tests and strict TypeScript checking, but remains hard-disabled and frozen. Review found that its old API deployment-ID pin cannot safely identify the new deployment created when OAuth-only mode changes. The executable independently armed shutdown controller, observer, restoration transport, and exact active-deployment stop fallback are also not implemented. The proposed capture-window plan records those requirements at SHA-256 `787c2034d8f662af33ad417e9eace8abac9ec78ae505705448cb94e62b818b58`; the plan supplies no live authority and does not substitute for implementation or independent review.

The currently guarded direct provider path remains explicitly zero-tax. The pure linked-Invoice projection/parity validator in `src/services/quickbooks-tax-invoice-parity.ts` passed eight focused test groups, strict TypeScript and full `npm run verify` at 19:49 UTC under Node 22.23.2 (415 unit tests passed, one existing optional skip, zero failures). Sentinel and Opera approved this bounded feature-branch increment; it was committed and pushed as `1771e32a94b615dee7804542efb49c10f0ddc084`. It is not deployed. Its result may state `projectionMatches` only; publishing authorization and real-provider parity remain false. Provider tax and total must equal the immutable QuoteFly tax and total exactly; mismatches remain blocked pending a separately designed acceptance/revision policy. The prior documentation commit `3bfec4fc5d4b8ee2f3477112f87867a07ec73568` passed CI 134; CI 135 on 1771e32 also passed; its terminal success was independently observed at 20:28 UTC. Browser access remains unavailable, and no provider Estimate or Invoice was created during this preparation.

The internal lifecycle increment reuses `QuickBooksInvoiceOperation` and the shared publication lock. It adds an immutable binding to the reviewed Estimate and its reserved Invoice request identity, an original attempt-token hash for late-result retention, and write-once projection evidence. Tax-bound operations cannot become successful or open the local Invoice in this increment. Direct non-tax publishing, reconciliation and payment-link paths refuse those operations. Webhook processing retains deferred tax invoice identities while draining supported siblings, and manual replay cannot erase that deferred work. The additive migration has been applied only to the isolated local test database. Seven focused lifecycle tests passed, and full `npm run verify:ci` passed at 20:42 UTC on Node 22.23.2, including all 651 database tests across 40 files and 416 main unit tests with no skips. The first run caught an outdated catalog field-count assertion; it now includes the five restricted fields, with schema validation still reporting zero issues. No route or provider dispatch is added.

A simpler sandbox transport is now being prepared: a separate one-shot staging job while the public staging API stays OAuth-only. An empty job service was created at 20:35 UTC with no source, credentials or deployment; all prior staging and production instances were unchanged. Its first phase will perform tenant-scoped, read-only snapshot readiness checks using existing runtime permissions. No new global discovery privilege is needed. A later Estimate action still requires exact artifact review, current-source and actor checks, enforced isolation/deadlines, one-attempt dispatch and durable recovery evidence. The old API-mode-change bundle remains frozen and unused.

The remaining sequence is to verify that read-only job, resolve the masked monitoring inputs, prove positive-tax Estimate behavior, and implement the trusted tax Invoice dispatcher/reconciler and uncertain-result recovery around the durable lifecycle. Then run real sandbox Invoice, signed webhook, payment/refund/void/delete/CDC and recovery tests. Signed-in browser access is still needed for any provider-console or user-interface checks that cannot be completed through existing APIs. These safeguards do not request new authorization for the already authorized isolated sandbox.

The acceptance contract is [QuickBooks Hosted Payments And Reconciliation](quickbooks-hosted-payments-reconciliation.md). That contract defines the authoritative workflow, security boundary, state projection, recovery behavior, and evidence required before enablement.

The internal lifecycle increment was independently approved by Sentinel and Opera and pushed as `de50673a7f1bfe6567b597e4cd0e7962265159f1`. CI 136 failed four notification-retention setup checks because a prior webhook suite left fixtures behind. Follow-up cleanup removes only fixture-owned records and verifies preservation of pre-existing webhook identities and tenant/connection links. Follow-up product hardening rejects malformed durable Invoice identities with the same bounded grammar as Estimate identities; repeated same-ID retention preserves later recovery evidence unchanged. Sentinel and Opera approved that follow-up, pushed as `c0acb090bde1623a529f3d78a2abe441f418c529`. Local `verify:ci` passed at 21:23 UTC. GitHub CI 137 also passed the exact commit: 652 database tests across 40 files, 416 main unit tests, and 197 browser tests with one existing optional browser skip. Hosted migration and provider dispatch remain unavailable.

The credential-target reader, frozen dispatch descriptor and final create fence were approved by Sentinel and Opera and pushed as `1cb6002fda55b8208f2dfbe7271c444de9c99c46`, tree `03ed2c95c3c26bb14df990914de5d27a5b36124f`. The fence revalidates current manager authority, canonical source, mappings, connection generation, server-derived payload, exact attempt identity and remaining lease budget. Expired PROCESSING duplicates become unknown-result reconciliation without replacement claims. Local `verify:ci` passed at 22:27 UTC: 656 database tests and 416 main unit tests, zero skips, with green build/lint/schema/security/evaluation/audit stages. GitHub CI 138, run `37159080066`, also passed: 656 database tests across 40 files and 197 browser tests, with one existing optional browser skip. This adds no dispatcher, route or provider call.

The first credential-free hosted job failed closed because Docker excluded the required `.gitignore`; its original artifact and removal evidence remain frozen. The separately reviewed `v3-buildfix` package preserves all pinned source after dependency installation, Prisma generation and pruning, then verifies package closure and the Linux engine during the build. Its package manifest is `a0d032e1a684e791177d28909bbc50509aeb7de4cbbc0cce36042cc1c1c8f222`. Phase 1 deployment `678c4cb5-9fd4-45a9-8abe-75ab08d1c5fc` passed the hosted build and emitted the expected database-disabled `SECRET_PROFILE_INVALID` receipt plus an actual process-exit log of 2. One exact removal and independent final observation at 23:10 UTC proved REMOVED, stopped and zero active instances. The gate receipt is `job-buildfix-phase1-terminal-receipt.json`, SHA-256 `de55a4c74d907c9d0a34efc00e4d6bcc4ae6961e35c26430b0f24c419e7e5202`. Database/provider calls, writes and credential reads were zero. Phase 2 database readiness remains disabled pending its separate exact review; Phase 1 does not establish real-provider readiness.

An additional internal recovery helper now degrades expired attempts after manager, auth, invoice source, Estimate or connection-generation drift. It preserves original attempt evidence and late provider identities, leaves active leases untouched, and records one system event under the tenant and publication locks. Fifteen focused database tests passed at 23:03 UTC. Full `verify:ci` passed at 23:12 UTC on Node 22.23.2: 659 database tests across 40 files, 416 main unit tests, zero skips, and green build/lint/schema/security/evaluation/audit stages. Independent backend review approved the two-file source diff; final Opera remains pending at this documentation snapshot. It has no route, worker registration or provider call. Before dispatch is implemented, explicitly control payment options: Intuit documents that US imports can automatically email invoices when company settings, customer email and invoice card/ACH eligibility align. Omitted flags may inherit payment defaults. See the [Intuit Invoice reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/most-commonly-used/invoice). Real non-sending creation and canonical readback still require evidence.

## Current supported accounting workflow

- Create and review an internal QuoteFly invoice from an accepted quote or completed Job.
- Export accounting data through the QuickBooks-friendly CSV workflow.
- Allow current owners/admins to inspect local QuickBooks configuration state or disconnect locally stored credentials.

QuoteFly does not currently offer customer-available QuickBooks Online connection, invoice creation, hosted-payment delivery, invoice/payment reconciliation, tax sync, or webhook automation. The owner verified the sandbox company connection in staging. QuickBooks Payments eligibility, sandbox accounting operations, production app approval, and production provider operations remain unverified.

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
