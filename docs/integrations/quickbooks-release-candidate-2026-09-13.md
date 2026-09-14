# QuickBooks integration release candidate — September 13, 2026

Status: verified engineering candidate, authorized for isolated staging and sandbox acceptance testing; not a production release. Base commit: `1d987c16ec07804a9404c47648d28e0f5ca3be11`; commit and deployment results are recorded separately after execution. This evidence record itself grants no permission; the owner's September 13 authorization below and AGENTS.md define the permitted actions.

## Owner authorization

After the blocked handoff, the owner explicitly authorized BCP, isolated staging deployment and migration, and all necessary QuickBooks sandbox testing. The owner also requested persistent AGENTS.md authorization for BCP and production deployments conditional on a green independent final review. Production remains gated on the exact candidate's required provider and operational evidence; `BLOCKED_MISSING_EVIDENCE` is not approval. Earlier references to pending authorization in this document describe the historical handoff and are superseded by this section. The documented staging rollout can now proceed without renewed permission for the same actions.

The prior verified candidate used the 54-file changed/new source manifest digest `b9e838bacc9c102db0a27bf579bf548ce6e026d93a61ea0008e5a3c01316a3f7`, recorded in the ignored local `.codex_tmp/qbo-candidate-manifest.json`. Markdown evidence is excluded from that digest so results can be recorded after execution. A local manifest does not substitute for the required committed release candidate.

## Continued goal work

The owner renewed the goal after the first local candidate passed. The working tree now also contains parent-first lifecycle/webhook locking with locked binding revalidation, full canonical invoice refresh after accounting operations, and paginated customer/item lookup. The final continued candidate is frozen at 61 changed/new source files with manifest digest `466f0d3bec51b2599125eb997d93fa5425cfada6a3fc9d8070aa6efb7a912022`. A fresh fetch confirms the base remains current with GitHub `main` (zero commits ahead or behind).

The preceding 60-file candidate (`11d445ecb96f4c415b8947658ffda0aa512fa067df358ff767664c44e2953976`) passed `verify:ci`, including 394/394 database tests. Its browser attempt was stopped after an old version-conflict fixture returned inconsistent preview and canonical invoice versions; the app correctly refused the second publish review. Three older selectors also referenced previously untranslated keys. The test now supplies the complete canonical invoice, proves publication stays closed while versions disagree, and reloads after the simulated saved invoice catches up. All original version and mapping-binding assertions remain. Seventeen focused cases passed initially, and the corrected remaining case passed separately. Evidence is retained in `.codex_tmp/goal-launch-before-fixture-fix.log` and `.codex_tmp/qbo-stale-preview-fixture-failure/`.

Focused lock/credential/replay checks pass 49/49. The 14 deletion tests include two-client deadlock regressions, stale-binding quarantine, and disconnect waiting on the previous audit actor. Backend lookup pagination passes 25 unit tests (five new). Four invoice freshness browser regressions and the existing explicit retry test pass. Six lookup browser tests also pass, including customer/item matches beyond position 25, delayed-query responses, failed/empty pages, keyboard focus, legacy responses, and canonical payment-link refresh. Synthetic lookup screenshots were inspected at 390px and 1280px.

The final 61-file candidate passed **`npm run verify:launch`, exit 0**: **394/394 database-backed tests across 33 files**, **155 browser tests passed**, and one existing optional marketing screenshot-regeneration test skipped. All build, lint, schema, route inventory, security, unit, AI evaluation, and dependency-audit stages passed. No required test failed or was waived. The browser stage took 14.2 minutes. Exact local evidence: `.codex_tmp/run-verify_launch.log` and `.codex_tmp/goal-final-launch-console.log`. Source remained frozen throughout this successful run; only Markdown evidence was updated.

Before committing, the staged whitespace gate detected one extra terminal blank line in each of `src/services/quickbooks-webhook-processing.ts` and `tests/integration/quickbooks-webhook-processing.test.ts`. Removing those two blank lines changes the raw 61-file manifest digest to `a5cfc0cf8af19ffb2224e5fdeca54eea67e31ea7193c4039e32451eca9d3ba5d` without changing executable code or assertions. The original tested manifest is retained as `.codex_tmp/qbo-candidate-manifest-tested.json`; the staged whitespace gate passes. The owner's authorization changes affect Markdown only.

## Supported candidate scope

An owner/admin reviews an internal invoice, maps it to existing QuickBooks Online customers and items, and explicitly publishes it. QuickBooks owns payment processing and settlement. QuoteFly stores encrypted credentials and eligible hosted links, and reconciles provider accounting state into its tenant-scoped ledger. The candidate supports non-taxable USD invoices. Customer/item creation, sales-tax publishing, general two-way accounting synchronization, and QuickBooks Desktop integration are not supported by this contract. The owner has not yet confirmed the first public tax scope.

The initial OAuth-only staging connection is owner-confirmed: the supplied settings screen shows Quotefly Sandbox, Connection verified, accounting permission granted, company binding active, and encrypted credentials available. This does not establish accounting or payment behavior. Hosted invoice publishing, payments, signed webhook processing, reconciliation, and CDC remain disabled on that staging surface.

## Engineering changes

- Definite invoice publication rejections can be retried only after a new review, explicit confirmation, and distinct command key. Prior attempt history remains. Unknown outcomes cannot authorize a second create.
- Publish and manual reconciliation revalidate current manager membership rather than trusting stale cookie roles.
- Multi-invoice webhook processing checkpoints individual outcomes. Failed siblings do not discard successful work; bounded retries end in recoverable dead letters.
- Signed Invoice Delete and canonical not-found responses invalidate cached links and fence concurrent reconciliation, including operations whose initial reconciliation fields are null. A set-based transaction drains deletion backlogs without per-event database round trips. Existing financial history remains; deletion never invents a void or refund. Unlinkable RefundReceipt deletion requires manual review.
- Managers can page through bounded content-free recovery events and explicitly queue supported dead letters with an idempotent command and structured reason. Tenant-validated cursors keep older events reachable, and the warning includes manual-review events. An additive audit table retains actor, reason, prior failure classification, attempt count, and command hash after inbox retention. Runtime access is insert/read only and tenant-isolated.
- Worker pagination advances each bounded tick until a scan cycle finishes, then observes its normal interval.
- The full browser gate exposed an existing lazy-loaded assistant startup race. Pending open intent is now consumed once, preserves focus, and is cleared across identity boundaries. Both deterministic startup/isolation regressions and all five unchanged AI accounting browser tests pass.
- Browser test startup clears inherited provider credentials and uses only a dedicated test database and synthetic fixtures.
- `/integrations/quickbooks` has prerendered HTML, canonical metadata, sitemap inclusion, descriptive internal links, breadcrumbs, and visible scope/availability answers. It advertises CSV availability accurately and does not claim the direct integration has launched.

## Automated evidence

All database tests use a task-created local PostgreSQL 16 database named `quotefly_test`; shared-rate-limit tests use local Redis 7. No existing hosted database is cleaned or test-mutated. Fresh baseline migrations and the additive replay migration applied successfully (85 migrations total).

- The first frozen `npm run verify:launch` run passed all `verify:ci` stages, including 389/389 database-backed tests across 33 files. Browser results were 142 passed, one optional capture-generation test skipped, and one failure caused by the existing assistant startup race. That race has been fixed and all seven focused tests pass; the subsequent complete gate passed on the final candidate, as recorded below.
- Focused webhook processing: 7/7 passed.
- Focused deletion safety: 9/9 passed. A signed delivery of 500 notifications plus 125 historical deletion events invalidated and audited 625 distinct operations using one invalidation statement and at most 20 total database queries. Local acknowledgement took 682 ms; this is informational local evidence, not hosted latency proof.
- Focused replay recovery: 16/16 passed, including runtime-role tenant denial, immutable audit grants, composite relationship isolation, concurrent replay, retention, disabled/unsupported behavior, and reachability beyond the first page. Foreign, expired, replayed, or moved cursor anchors are rejected without tenant disclosure.
- Worker scheduling: 4/4 unit tests passed.
- Invoice retry browser test passed at 390px, covering fresh review, distinct command identity, explicit confirmation, dirty-review blocking, unsafe retry suppression, and keyboard focus restoration.
- Recovery browser tests: 11/11 passed, including desktop/mobile accessibility, manager and OAuth-only boundaries, uncertain response handling, explicit recovery reasons, manual-only warnings, pagination, and stale-cursor recovery.
- Public page: frontend build, lint, 13 SEO tests, mobile layout, degraded-session navigation, and desktop/mobile Axe checks passed.
- Root and web dependency audits pass without advisory exceptions after the Vitest and js-yaml updates.
- Final frozen candidate: `npm run verify:launch` **PASS**, exit 0. All build, lint, Prisma, route inventory, security, unit, AI evaluation, and dependency-audit stages passed; **389/389 database-backed tests across 33 files** and **145 browser tests passed**. One optional marketing capture-regeneration test was skipped by its existing configuration; no required browser test failed or was waived. The full browser stage took 12.5 minutes.
- The prior 54-file source manifest matched that verified candidate with zero mismatches. Its preserved local log is `.codex_tmp/launch-before-continuation.log`; prior failure evidence remains in `.codex_tmp/launch-before-kody-fix.log` and `.codex_tmp/qbo-kody-startup-failure/`. These ignored artifacts are local evidence, not committed release evidence.
- Independent Opera final verdict: **BLOCKED_MISSING_EVIDENCE** for consumer release. The reviewer found no unresolved blocking source defect, verified all 54 manifest files, and accepted the final local gate evidence. Production approval is withheld for the external gates below; this is not an engineering approval to advertise direct integration as available.

## Independent review outcome

Opera reviewed the frozen candidate after implementation and verification without editing it. The remaining consumer-release blockers are real Intuit accounting evidence (High), provider approval/payment eligibility and accepted public scope (High), production-like migration/restore evidence (Medium), and operational ownership/alert delivery (Medium). The current public page is suitable for indexing with its explicit unavailable/candidate wording. Availability claims require the external gates and production pilot to pass first.

The earlier lock-order finding has been remediated in continued goal work: relevant transactions take tenant and audit-actor locks before connection, binding, event, and operation locks. Renford approved this bounded source review. Sentinel found no confirmed vulnerability in the continuation changes.

Opera independently accepted the final 61-file manifest (zero mismatches), clean whitespace check, and successful complete launch gate. No unresolved Critical, High, or release-blocking Medium source defect was found. The final consumer-release verdict remains **BLOCKED_MISSING_EVIDENCE** for real Intuit accounting tests (QBO-GATE-01, High), accepted scope and provider approval/payment eligibility (QBO-GATE-02, High), and production-like migration/restore, alert ownership/delivery, and committed-SHA traceability (QBO-GATE-03, Medium). The source candidate is suitable for a staging evidence run. The owner has now authorized staging BCP, deployment, migrations, and sandbox provider testing separately; production still requires its green final gate.

## Remaining release evidence and owner inputs

The earlier lock-order concern is covered by the new deterministic concurrency tests and parent-first locking. Real sandbox concurrency, delivery, and recovery evidence is still required; local tests do not establish hosted provider behavior.

1. Confirm whether the first public release is explicitly limited to non-taxable USD invoices or requires US sales-tax support. Do not advertise tax sync without a separate implemented and verified contract.
2. Name the support/alert owner and destination for worker failures, queue age, dead letters, reconciliation-required records, token failures, CDC lag, and provider latency. Prove delivery and escalation.
3. Prepare a concrete staging deployment with matching API/worker build and an isolated migration job. Configure the webhook verifier through the provider secret manager and audit presence only; preserve the existing staging encryption key. Keep production untouched.
4. With explicit sandbox accounting authorization, verify reviewed mappings, one invoice, hosted-link eligibility, partial/full payment, refund/reversal, void/deletion, duplicate/out-of-order delivery, worker restart, missed-webhook CDC recovery, token rotation, disconnect, and recovery controls against the dedicated Intuit sandbox company.
5. Rehearse the candidate upgrade and forward fix against an approved sanitized production-like snapshot using the least-privileged runtime role. Fresh local migrations are not backup/restore or production-volume lock evidence.
6. Obtain Intuit production app approval and owner-confirmed QuickBooks Payments eligibility, fee ownership, supported methods, and settlement behavior. Complete device smoke testing and independent release approval on the exact committed candidate.
7. Only after an authorized production pilot succeeds, change public availability copy and remove the candidate limitations that have actually been resolved.

Operational steps remain in [sandbox setup](quickbooks-sandbox-setup.md), [owner testing](quickbooks-owner-testing-checklist.md), and [worker operations](quickbooks-worker-operations.md). Follow [secret handling](../security/infrastructure-secret-handling.md); record presence and results only, never raw credentials or hosted invoice links.

## Proposed isolated staging rollout

This is the authorized staging sequence; execution evidence is recorded separately:

1. Commit and push this verified candidate under the owner's explicit `run BCP` authorization and record the resulting SHA. Use a staging-only branch and verify automatic deployment triggers before pushing. Deploy only that SHA to the existing staging web/API and the separate QuickBooks worker; preserve production configuration until its green final gate.
2. Use the existing Neon `staging/quickbooks-sandbox` branch. Run the isolated migration job with its migration credential, including `20260913120000_quickbooks_webhook_replay`; the API and worker receive only the runtime role. Confirm the replay table's forced tenant RLS and insert/read-only runtime grants through readiness and focused smoke evidence.
3. Keep the existing sandbox company, callback `https://api-staging.quotefly.us/v1/integrations/quickbooks/callback`, and staging encryption key. Add the Intuit webhook verifier through the staging secret editor; verify presence only. Use `https://api-staging.quotefly.us/v1/integrations/quickbooks/webhook` for the reviewed signed-delivery test.
4. After an alert owner/destination is supplied and delivery is proven, enable the authorized accounting phase on API and worker: provider workflows on, OAuth-only mode off, reconciliation on, CDC and hosted payments initially off. Confirm health, database readiness, matching build identity, and worker heartbeat before an invoice write.
5. In the dedicated Intuit sandbox, use fabricated details and existing customer/item mappings for one reviewed non-taxable USD invoice. Record provider outcomes without tokens, raw payloads, or payment links. Enable CDC and eligible hosted-payment checks only for their explicitly authorized test phases.
6. On a stop condition, scale the worker to zero first and disable the affected provider flags. Preserve uncertain operations and ledger history; do not delete records or blindly republish. The additive audit migration remains in place, with a reviewed forward fix preferred over a destructive rollback.

Staging success is required evidence for a later production decision; it does not change the public page to an available integration automatically.

## Read-only staging recheck

On September 13, 2026 at approximately 23:33 UTC, the existing staging web root, API `/v1/health`, and API `/v1/ready` each returned HTTP 200. The local verified candidate still matched all 61 source-manifest entries with zero mismatches. These checks establish existing staging reachability and unchanged local source only; they do not establish deployment of this candidate, worker readiness, webhook verification, or accounting behavior. No hosted settings, migrations, provider records, or deployment state were changed during this check. Authorization was pending at that point and was subsequently granted as recorded above.
