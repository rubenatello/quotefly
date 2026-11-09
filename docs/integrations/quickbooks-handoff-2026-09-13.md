# QuickBooks evening handoff — September 13, 2026

Owner requested BCP, a progress benchmark, and a stop for the night. Resume tomorrow evening from the commit containing this document. Do not interpret the pause as completion or production approval.

## Progress benchmark

| Area | Evidence and current state |
| --- | --- |
| Connection | Real isolated staging OAuth connection to the dedicated Intuit sandbox verified. API token-encryption key and development webhook verifier confirmed present without retrieving their values. |
| Invoice integration source | Reviewed publishing, immutable review binding, tenant isolation, uncertain-outcome protection, customer/item pagination, canonical refresh, deletion safety, and durable webhook recovery implemented and tested. Real accounting acceptance remains pending. |
| Worker | Dedicated minimum-secret parser and safe import bootstrap implemented. A clean independent local artifact passed restricted-role RLS startup, STARTING → RUNNING, and a zero-provider cycle. Hosted Linux shutdown/startup evidence remains pending. |
| Monitoring | Separate durable operations monitor implemented and reviewed, including fixed-recipient alerts, retry leases, escalation/recovery, forced-RLS tenant metrics, and cadence safeguards. Hosted migration, runtime, and actual delivery remain pending. |
| Tax | Current staging invoice contract explicitly sends NON and blocks positive QuoteFly tax. The owner has not accepted a non-tax-only public release. Structured tax inputs and provider-calculated Estimate → linked Invoice proof are still to build and validate. |
| Product UI | OAuth-only mode clearly identifies intentionally disabled accounting capabilities. Recovery and mapping controls have desktop/mobile tests. |
| SEO/AEO | QuickBooks public page, prerendered metadata, internal links, sitemap, and answers exist with truthful unavailable/staging wording. Do not advertise the direct integration as launched. |
| Production | Not approved or deployed. Real provider, tax, operational, restore, and final candidate evidence remain required. |

### Verification completed tonight

- Full `npm run verify:launch`: **exit 0**.
- Main unit suite: **275 passed**; other security/configuration/SEO/evaluation stages also passed.
- Database integration: **406 passed across 34 files**.
- Browser: **156 passed**, **one existing optional marketing capture-generation test skipped**; 13.6 minutes for browser stage.
- Backend/frontend builds, lint, Prisma validation, security checks, AI evaluations, and both dependency audits passed.
- Frozen 82-file raw source manifest: `70a05a62eef69fbd92fb0348e90b31df5a58c0758e278119c229678e7240bd8f`.
- Post-gate formatting removed 30 spaces from 15 blank lines in the new reconciliation runtime file. Emitted JavaScript is byte-identical. Adjusted raw manifest: `324d4db6608269d84eabac5fc52d6d48ad93e08f864e3844c9fd6ce9749f432a`. Git storage also normalizes CRLF to LF; the commit-source proof records that separately.
- Opera approved the bounded source candidate for isolated staging BCP/migration/API/web/worker/monitor evidence collection. This is explicitly **not production approval**. The only accepted Low source finding is the duplicated 120-second CDC overlap constant; the runbook and deterministic cadence test cover its synchronization requirement.
- Opera independently approved the formatting-only delta: all 81 other source files are unchanged, all 82 adjusted hashes match, and independent transpilation emits identical JavaScript. The completed full gate remains applicable; no second full gate is required for this whitespace-only correction.

Local ignored evidence retained: `.codex_tmp/combined-launch-passed.log`, `qbo-combined-gated-manifest.json`, `qbo-combined-manifest.json`, `qbo-runtime-format-proof.json`, `qbo-worker-clean-artifact-proof.json`, and `qbo-committed-source-proof.json` after BCP. Failed runs remain preserved separately. Do not publish raw test or provider logs without sanitization.

## Git and deployed state at pause

- Working branch: `feature/quickbooks-staging-acceptance-20260913`.
- Draft PR: https://github.com/rubenatello/quotefly/pull/9.
- `origin/main` fetched tonight and remains `1d987c16ec07804a9404c47648d28e0f5ca3be11`.
- Prior committed integration baseline: `d30b757`; non-tax correction: `9545836eccfe92183fe4b97140915dac520716d3`.
- The new BCP saves the worker, monitor, OAuth-state canonical encoding fix, UI clarification, tests, and this handoff. Its remote CI result must be checked tomorrow; the earlier CI success covers `9545836`, not this new commit.
- Old-machine stash remains preserved and untouched. Environment files remain ignored and uncommitted.
- Latest deployed staging API/web are still **9545836**, not the newly saved candidate.
- Railway API deployment: `8a8c5caf-03a4-4b93-b066-fae80fd74b98`, SUCCESS. Staging health and readiness returned HTTP 200 tonight.
- Vercel staging deployment: `dpl_9PRT4LPCRNmDKbTUdNvQRNnSAdNE`, READY and promoted within the isolated staging project.
- Replay migration deployment: `39ca4cb3-e01d-45df-a800-6879c48619e6`, SUCCESS. The **new monitor migration has not been deployed**.
- No reconciliation worker or monitor deployment was started tonight. The local clean-artifact proof worker was stopped. No QuickBooks accounting record was created or modified.
- Synthetic QuoteFly staging data exists: customer “QBO Sandbox Acceptance 20260914,” a reusable service item, and quote “QuickBooks sandbox acceptance 20260914,” two non-taxable lines totaling USD 300. Preview excluded internal costs/margins. No outbound message was sent.

## Hosted configuration prepared but not deployed

Railway project `f65fe09e-0222-406f-9d6c-37d601fb5658`; isolated staging environment `90d918bf-8432-4cf5-89e0-6166cb46468c` (not a fork).

| Service | ID | Pause state |
| --- | --- | --- |
| API | `9ba83b3f-2c86-4d78-bf5e-755a83257b06` | OAuth-only; verifier and encryption key present; CDC/payments/reconciliation disabled. |
| Migration job | `9e8719d6-d7ab-4076-aa18-d9227761ebfd` | Existing isolated migration service; monitor migration pending. |
| Reconciliation worker | `b490b0dd-f815-4da0-8b01-88e6dce09506` | Secret references prepared with deployment deferred. Unneeded verifier reference cleared; API verifier untouched. Worker flags must match its dedicated profile before startup. |
| Monitor | `81eaca59-fb57-4479-a9b7-452dfd0906b5` | New empty staging-only service, no source/deployment. Monitor disabled, expected reconciliation/CDC false. References only staging runtime DB, Resend key, verified sender; operations recipient configured as `rubenatello@gmail.com`. |

The monitor containment query confirmed exactly one service instance in staging. No production service was changed. Monitor start is `npm run start:quickbooks-monitor`; worker start is `npm run start:quickbooks-reconciliation`. Both build with Prisma generation and backend compilation. Verify resolved deployment commands and health-check settings before accepting either runtime.

Vercel staging project: `prj_Yr5wuwSn1I8qYpJONjAIrL5Ivorc`, scope `rubenatellos-projects`. Neon staging branch: `br-morning-term-an11u2jo`, `staging/quickbooks-sandbox`, project `still-smoke-65596366`.

Intuit development webhook configuration is saved with CloudEvents, exact staging endpoint, and only Invoice, Payment, and RefundReceipt subscriptions. Signed delivery is not yet proven.

## Owner task pending

Railway already has email/in-app notification rules for failed deployments and crashed/OOM processes. Its account page showed an empty email field, so delivery cannot be assumed. The owner was given these steps; do not repeat the request if already completed:

1. Open https://railway.com/account.
2. Set Email to `rubenatello@gmail.com` and click Update Info.
3. Complete any verification email and report completion.

The Railway account browser tab was left as a handoff. Inbox receipt of later monitor OPEN/RECOVER messages and an independent platform failure alert will need owner confirmation. No alert test email was sent tonight.

## Resume sequence

1. Read this handoff and the current Git status; check the BCP commit and its GitHub CI. Preserve the stash and environment files. Do not blindly pull over local edits.
2. Confirm the formatting-only review acknowledgment and commit-source equivalence. Create a clean tracked-only archive of the saved SHA outside the repository, with no `.env` files or inherited local dependencies.
3. Deploy the additive `20260920120000_quickbooks_operational_monitor` migration through the isolated staging migration job. Verify completion before deploying consumers. Keep the API/web OAuth-only initially.
4. Deploy matching API/web source; check liveness, database readiness, login/session restore, and truthful connection-only UI. Promote only within the staging Vercel project.
5. Before starting the worker, record content-free due webhook, reconciliation-required, connection/orphan revocation, and active sandbox connection counts. Enabled worker startup can refresh/revoke credentials or perform canonical reads for existing work; do not claim zero provider work without evidence. Use the prepared ignored `qbo-hosted-runtime-proof.cjs` helper only after reviewing its final scope.
6. Start the worker with its minimum profile, provider/reconciliation true, OAuth-only false, CDC false; keep API accounting writes disabled. Prove actual hosted runtime role, forced RLS, heartbeat, and Linux SIGTERM → STOPPED behavior. Restore the worker afterward.
7. Deploy/enable the separate monitor with truthful expected-worker flags. Verify monitor table SELECT/INSERT/UPDATE and no DELETE, narrow environment presence, fixed sender/recipient, and bounded durable alert state. Prove one OPEN and one RECOVER email, inbox receipt, ten quiet minutes without duplicates, and independent platform alert delivery for monitor failure. Preserve ambiguous/terminal delivery history.
8. Only after the operational prerequisites pass, enable the bounded API accounting phase, confirm setup, review mappings, and publish the synthetic USD 300 NON invoice. Verify canonical QuickBooks state and real signed webhook delivery. Then exercise payments/refunds/deletion, duplicate/out-of-order events, worker restart, CDC recovery, token rotation/disconnect, and recovery controls in explicit isolated phases.
9. Build and validate the tax contract below. Keep unsupported capabilities and public availability claims disabled.
10. Production requires the final independent exact-candidate gate, provider approval/eligibility, production-like restore evidence, operational delivery, and a reviewed ordered rollout. **Do not merge PR #9 to main:** production Railway API/migration integrations currently auto-deploy main concurrently, without safe migration ordering.

Railway CLI on this machine: use `railway up` **without a positional `.`**, from the clean archive, with explicit project/environment/service selectors. The Windows CLI rejected the explicit-dot form. Use GraphQL query files rather than shell-embedded quoted documents. Do not retry rejected legacy config-path mutations; service-level commands are already prepared. Never retrieve provider variables or download environment files; use in-process presence-only audit profiles.

## Tax design preserved for next implementation

The current Quote stores only aggregate `taxAmount`; Customer has no structured address and Job has an unstructured service-address string. Existing canonical invoice fingerprints omit tax, address, and linked-transaction evidence. This is insufficient for production automated tax.

The read-only backend review recommends a separate default-off, staging-only Estimate → linked Invoice proof, using a dedicated accepted synthetic Invoice with immutable lines/version and reviewed customer/item mappings. Enforce sandbox environment, approved staging origins, an explicit tenant allowlist, live manager authorization, and an HMAC-bound review covering invoice version, mappings, connection, address, line TAX intent, and provider capabilities. Preserve the current live positive-tax blocker.

Use durable tenant-scoped operation state before any provider mutation, distinct stable request IDs for Estimate and Invoice, collision-resistant document numbers/markers, and query-before-create recovery. Persist returned provider identities before canonical reads. Estimate uncertainty must prevent Invoice creation; any ambiguous write, expired lease, tax/address/link mismatch, or persistence failure requires reconciliation, never blind recreate. Require positive provider-computed tax and exact subtotal/tax/total parity between canonical Estimate and linked Invoice.

Read CompanyInfo/Preferences first; require US company, active sales tax, estimates enabled, valid structured synthetic shipping address, USD, and reviewed TAX line mappings. The sandbox tax setup currently shows an unconfigured sample address; no tax setup was saved. The separate Intuit tax calculator is entitlement-gated and unavailable to this app; do not silently add a scope or invent tax rates.

Primary implementation seams: `src/services/quickbooks-invoices.ts` for durable claims/review binding, `src/routes/quickbooks.ts` for current manager revalidation and publish flow, and `src/services/quickbooks.ts` for provider queries/create/fetch. Do not turn the legacy quote preview into an unreviewed writer. A dedicated proof ledger needs composite tenant relations, unique command/provider identity constraints, forced RLS, no runtime DELETE, and content-free canonical evidence. Required tests include concurrency/replay, tenant and demoted-role denial, stale review, provider ambiguity, collision recovery, exact tax/address/link parity, and runtime grants.

This provider mechanics proof would still not complete customer-facing taxable publishing. Production also needs structured business/customer/service addresses, per-line tax intent, tax provenance and review UX, and tax-aware canonical reconciliation, followed by real sandbox evidence and an independent final gate.
