# QuickBooks Online Release-Candidate Evidence

Last updated: 2026-09-04

Status: active release-candidate qualification. This record separates engineering readiness from owner-operated staging/production actions and Intuit-controlled approvals. It does not authorize a deployment, provider flag change, webhook subscription, sandbox accounting mutation, production mutation, or marketing claim by itself.

## Release identity

The release candidate is the commit that contains the QuickBooks remediation and this evidence record. Record its immutable Git SHA, CI run, migration job, API deployment and readiness, reconciliation-worker deployment when enabled, and web deployment in the table below after each exists. A passing result for an older SHA is historical evidence only. Because a commit cannot truthfully embed its own identity, the final SHA is bound after BCP by the PR head, exact-SHA CI check, and provider deployment metadata; this tracked record must not pre-check that gate.

| Evidence item | Current result | Release meaning |
| --- | --- | --- |
| Previously deployed staging/API SHA | `1d987c16ec07804a9404c47648d28e0f5ca3be11` | Healthy process, but not an acceptable QuickBooks candidate because the owner-observed OAuth callback failed. |
| Previous exact-SHA CI | Passed for `1d987c16ec07804a9404c47648d28e0f5ca3be11` | Baseline only; it does not validate the remediation. |
| First pushed candidate SHA | `5379c29327c7e4785aae05ec71e86c40f924591a` on `agent/consumer-launch-readiness` | Historical candidate only. Exact-SHA CI exposed one stale-preview recovery race, so this SHA is superseded and must not be promoted. |
| First candidate CI | GitHub Actions run `33807445833`: 132 Playwright tests passed, one intentionally skipped, and one failed twice | Clean install and all 86 migrations passed, but the required launch gate failed. The UI reloaded the refreshed invoice preview and erased the localized version-conflict warning. |
| Superseding candidate implementation SHA | `e02589a41f9400b06f2e0e6dcc825bf917ac4fae` on `agent/consumer-launch-readiness` | Contains the CI race fix, complete programmatic-navigation guard, correct pre-connect guidance, CSV-selection retention fix, environment-audit fix, and rollout-safe per-instance worker parity. The follow-up commits align CI with Node 22, correct the evidence boundaries, and make the database-clock test bound portable without changing production behavior. The immutable branch tip is recorded by PR #5 and its corresponding GitHub check because a commit cannot contain its own SHA. |
| Superseding `npm run verify` | Subsumed by the passing 2026-09-03 worktree `npm run verify:launch` | Supporting local evidence only; committed exact-SHA CI remains authoritative. |
| Remediated database-backed `npm run verify:launch` | Passed on the superseding Docker/Node 24.18.1 worktree: 125 routes inventoried, 13/13 security, 244/244 unit, 379/379 integration, all deterministic evaluations and both dependency audits, then 139 Playwright passed, one intentional capture-regeneration skip, and zero failures | Qualifies the executable worktree; exact-SHA CI and Node 22 evidence remain pending. |
| Superseded Node 22 clock-bound attempts | GitHub Actions runs `33829216372` and `33829369228` each failed with 378/379 integration tests passing | Both exposed the same 1 ms cross-clock assertion error: the test bounded database-observed `TIMESTAMPTZ(3)` values with the independent runner wall clock. The test now samples PostgreSQL `clock_timestamp()` at matching millisecond precision before and after the writes. These failed SHAs must not be promoted. |
| Current hardening worktree | Provisional precommit successor whose immediate base is `9ebbc8dcff142f483beda1bb968617b823003280`; final SHA not yet created | Adds the 88th migration, durable token-refresh failure state, content-free external signals and machine monitors, bounded shutdown, exact API/worker release checks, provider-attempt health, fail-closed frontend status validation, and rate-limit/proxy hardening. It is not immutable evidence until BCP and exact-SHA CI. |
| Current exact-SHA Node 22 CI | Pending BCP | Must clean-install, generate Prisma, apply all 88 checked-in migrations, and pass `npm run verify:launch` on the PR head. |
| Owner-observed staging OAuth proof | Partial pass on staging SHA `fd3832e9bf7cdc88406429d307c9f6049a40d487`: expected sandbox company connected and owner-initiated disconnect retained QuoteFly data | Proves the corrected callback can complete against Intuit sandbox. The owner also observed a reauthorization message before disconnect; replay rejection, revocation recovery, and the final SHA must be revalidated before acceptance. Automation was intentionally unavailable in OAuth-only mode. |
| Final exact-SHA staging OAuth proof | Pending BCP and ordered staging deployment | Must reconnect the expected sandbox company on the final SHA and record one-time callback/replay rejection, disconnect, revocation recovery, readiness, and content-free monitor results. |
| Full accounting sandbox proof | Not started and not authorized | Requires separate explicit approval for sandbox accounting mutations, plus a live same-SHA worker, signed webhooks, CDC, alert delivery, and the owner checklist. |
| Production pilot | Not authorized | Requires the code, staging, operations, owner, and Intuit gates below. |

## Observed staging failure and diagnosis

The owner reached Intuit's sandbox consent screen, selected **Connect**, and returned to QuoteFly staging with the generic `quickbooks_error` notice. Safe staging evidence showed five callback failures on the deployed baseline while liveness, database readiness, and authenticated authorization handoff remained healthy. No OAuth code, state, realm identifier, token, or raw provider response was retained in this record.

The callback's post-token company check used the requested company realm in the Intuit URL, then incorrectly treated `CompanyInfo.Id` as that realm identifier. Intuit returns a realm-local CompanyInfo entity ID (commonly `1`), while the OAuth `realmId` identifies the company in the request path. A valid consent flow could therefore exchange its code and load the correct company, then be rejected locally as a realm mismatch.

This distinction is consistent with Intuit's published contracts: the maintained [OAuth client documents `realm_id` as the QBO Realm/Company ID](https://github.com/intuit/oauth-pythonclient/blob/master/intuitlib/client.py), while the [CompanyInfo SDK contract defines `CompanyInfo.Id` as the identifier of that Intuit entity object](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/75d7858e-4449-a7c0-c8a7-32d6ca525b16.htm). Intuit's OAuth sample uses the callback realm to address the company API; it does not establish that every returned entity `Id` must equal the realm.

The remediation keeps the OAuth callback bound to the signed, one-time, browser-session state and requested realm, validates the CompanyInfo response shape and display name, and no longer compares the realm-local entity ID to the OAuth realm. Focused provider-contract coverage uses a requested realm distinct from `CompanyInfo.Id`.

## Engineering changes under qualification

- Correct CompanyInfo/realm interpretation and classify callback failures with content-free stage and event codes.
- Reject non-canonical signed-state encodings and sanitize token-exchange failures without retaining Intuit response content.
- Serialize OAuth generations tenant-wide so a later manager connection supersedes an older callback safely.
- Revoke or durably queue an issued refresh credential when callback or rotation finalization loses its database fence.
- Require a fresh reconciliation-worker heartbeat before publish or hosted-payment capabilities are reported as available.
- Mirror heartbeat writes per process during rolling overlap, require every fresh live worker to match the API release SHA, and keep stale/terminal rows out of serving capacity.
- Renew long-running webhook claims and refresh worker health independently during provider work.
- Bound multi-realm webhook ingress, persist realm batches with bounded concurrency, and measure the acknowledgement budget.
- Enforce an approved browser origin for disconnect and return stable, sanitized legacy preview failures.
- Preserve in-progress mapping edits across local, shell, mobile, notification, Kody, and logout navigation; retain actionable version-conflict errors; keep unavailable guidance accurate before connection; and remove successfully archived/deleted quotes from QuickBooks CSV selection.
- Count the current invoice-operation ledger in tenant and operator diagnostics, keep provider identifiers redacted, and label the operator metric accurately without breaking the established response shape.
- Keep migration-only database credentials out of API-runtime integration fixtures while preserving the production rejection check.
- Provide fixed, value-redacting environment-audit profiles for OAuth-only, reconciliation, CDC, and hosted-payment stages; retain `quickbooks` only as the full-stage compatibility alias.
- Give the atomic signup and quote-acceptance workflows the repository-standard bounded transaction budget under database load.
- Cascade tenant-bound webhook envelopes on hard tenant or connection deletion while preserving genuinely unbound quarantine rows.
- Bound worker-heartbeat observation tests with the authoritative PostgreSQL clock at the column's millisecond precision instead of comparing database timestamps to an independent CI runner clock.

## Dated local qualification evidence

The following 2026-09-03 results qualified the executable worktree before the first BCP. They remain useful regression evidence but do not qualify the superseding worktree or replace exact-SHA CI and staging evidence:

- The Docker/Node 24 `npm run verify:launch` passed end to end before the first BCP: the complete CI-equivalent phase passed, and Playwright finished with 133 passed, one intentionally skipped capture-regeneration case, and zero failures in 48.7 minutes.
- Node 24 database-backed integration: 30 files and 369 tests passed with no concurrent process using the test database.
- QuickBooks invoice integration: 62 tests passed twice consecutively; the two previously load-sensitive signup/acceptance cases also passed focused.
- Environment containment: 11 security-boundary integration tests passed with a deliberately present migration-only database credential, which the API-runtime fixture removed before configuration parsing.
- Migration rehearsal: all 86 migrations applied from zero to a newly created, isolated test-named PostgreSQL database.
- Webhook lifecycle: the complete QuickBooks retention file passed 7/7, including hard tenant deletion, hard connection deletion, cross-tenant preservation, and unbound-quarantine preservation.
- The exact worker-to-retention cleanup sequence that originally exposed the foreign-key ordering defect passed 3/3 followed by 5/5 after the cascade migration.
- The first exact-SHA CI then reproduced a timing-dependent frontend defect that the local run did not expose. Automated review also found a singleton-worker parity race plus three UX/recovery gaps. Those findings required the later remediation and invalidated earlier provisional specialist approvals until all specialists and Opera review the superseding exact SHA.

Pre-BCP focused evidence for the superseding worktree on 2026-09-03:

- Backend TypeScript build, Prisma generation, and Prisma schema validation passed.
- A fresh PostgreSQL 16 database applied all 87 migrations, including the additive per-instance worker-heartbeat mirror.
- The expanded per-instance heartbeat file passed 12/12, covering database-observed freshness, future-timestamp containment, lower-timestamp recovery, rolling overlap, missing/mismatched/stopping workers, 101-live-instance overflow and recovery, a 2,000-row terminal fleet with fixed-shape response work, legacy runtime writes, privileges, indexes, and retention.
- The final focused invoice runtime heartbeat/release subset passed 3/3 with 60 unrelated cases skipped, including a matching current worker overlapping an old-SHA stopping worker, zero provider calls while unavailable, and recovery after the old process becomes terminal. An earlier broader five-case runtime run also passed.
- Frontend production build and lint passed after the navigation, stale-warning, CSV-retention, and pre-connect-guidance remediation.
- The focused security suite passed 13/13 after adding value-redacting, fail-closed progressive QuickBooks environment profiles and enforcing the migration-before-API staging sequence in release runbooks.
- The final focused Chromium gate passed 8/8 with zero failures or skips in 158.0 seconds on one worker against an isolated 87-migration database and fresh ports. It covered the original stale-preview warning race, shared workspace coordination, accepted quote/job navigation, one history traversal with two dirty guards, command/notification/Kody/dashboard/logout handoffs, CSV-selection retention after successful versus failed lifecycle actions, and both pre-connection and connected guidance states. The preserved output directory is `test-results/qbo-final-eight-20260903165201680`; no failure artifacts were produced.
- Sentinel's remediated preflight found no Critical, High, or Medium code-security finding and closed the prior Low tenant-telemetry exposure. Renford approved the backend fleet/readiness boundary, Harbor approved the progressive environment profiles and migration-before-API runbooks, and Goldface approved the remediated frontend. Every specialist still requires a formal verdict on the final immutable SHA and its complete gates.
- Goldface approved the remediated pre-BCP frontend after the focused eight-case pass, with no remaining Critical, High, or Medium UX/accessibility/reliability finding.
- The first complete superseding-worktree launch attempt stopped in the unit phase with 243/244 passing because `WorkerHeartbeatInstance.observedAtUtc` was absent from the mandatory reviewed data-governance baseline. The bounded remediation classified it as C1 platform-internal operational data, retained fail-closed schema drift behavior, added direct assertions for the observation timestamp, release SHA, and restricted instance hash, and passed the focused governance file 4/4 plus backend compilation. The complete gate was restarted from the beginning after that correction.
- The next complete launch attempt reached Playwright with every preceding stage green, including 379/379 integration tests, then finished with 136 passed, one intentional skip, and three failures. Artifacts showed that sign-out and mobile-tab tests had not acknowledged the new intentional draft-leave confirmation; the Kody failure revealed a real same-route UX regression in which an in-place review handoff displayed a false leave warning.
- The bounded correction made sign-out and mobile navigation explicitly confirm `Keep draft and leave`, while an `OPEN_QUOTE_DRAFT` already on `/app/build` now preserves its path/query/hash, replaces only location state, and enters the existing merge/replace/keep review without weakening true cross-route guards. The four affected scenarios passed three consecutive times each (12/12), the complementary cross-route exact-once/focus guard passed 1/1, and frontend lint, production build, and diff checks passed. Goldface's focused re-review approved the behavior with no blocking UX or accessibility finding.
- The final Docker/Node 24.18.1 `npm run verify:launch` exited zero on 2026-09-03 using an unused isolated Redis logical database and the migrated 87-migration test database. It passed backend compilation; 125/125 route inventory; production web build, 16-route prerender, 12/12 i18n and 12/12 SEO checks; lint; Prisma validation; 13/13 security checks; 244/244 unit tests; 30 integration files and 379/379 tests in 342.28 seconds; parser 18/18, assistant 101/101, and retrieval 12/12 evaluations; root and web dependency audits; and Playwright with 139 passed, one intentional capture-regeneration skip, and zero failures in 28.1 minutes. No provider credentials or provider network calls were used. The immutable SHA, clean-install Node 22 CI result, and formal exact-SHA reviews remain pending.
- Two subsequent exact-SHA Node 22 attempts each reached the integration suite and passed 378/379 tests before the same worker-heartbeat assertion observed the database clock exactly 1 ms beyond the runner-clock upper bound. The scoped test correction samples `clock_timestamp()::timestamptz(3)` immediately before and after all affected writes. The complete 12-test heartbeat file then passed four captured focused repetitions in the isolated Node 22.13.1/PostgreSQL 16 environment; the replacement exact-SHA full gate remains authoritative.

### 2026-09-04 successor hardening evidence

This evidence qualifies the mutable worktree only and must be repeated or confirmed by exact-SHA CI after BCP:

- The owner completed an Intuit sandbox connection for the expected `Quotefly Sandbox` company on staging SHA `fd3832e9bf7cdc88406429d307c9f6049a40d487`, then completed the bounded disconnect flow with QuoteFly data retained. The OAuth-only readiness warning was expected because reconciliation, CDC, hosted payments, and signed webhooks were intentionally disabled. The final candidate still needs the complete replay/disconnect/revocation sequence.
- Renford approved the shared webhook eligibility predicate, signal-writer propagation, bounded response cleanup, worker/database behavior, and focused backend evidence. Goldface approved the fail-closed connection-verification normalization and final rendered QBO states after 28/28 focused assertions and 14/14 QBO Playwright scenarios. Sentinel found no unresolved Critical, High, or Medium security finding after the proxy, global monitor-quota, release-identity, signal, and migration-readiness remediation. Harbor found no remaining code or runbook blocker and approved proceeding to BCP. These are precommit verdicts and must be confirmed for the immutable SHA.
- The content-free operational monitor and worker failure integration subset passed 16/16. The complete invoice integration file passed 64/64, including terminal reconciliation signaling.
- Security regression coverage passed with `@fastify/rate-limit` 11.2.0: constrained Railway proxy trust, attacker-controlled forwarded-header rejection, IPv6 `/64` normalization, bearer-before-limiter ordering, one global six-request QBO monitor quota, empty fail-closed `503` on rate-limit storage failure, and a live Redis two-replica shared bucket. The expanded pretest suite passed 76/76 assertions and the focused security suite passed 14/14.
- Release identity now treats Railway/Render metadata as authoritative, rejects conflicting or malformed provider identities with fixed value-free startup errors, and reserves the manual SHA for non-Git deployments. `/v1/ready` explicitly probes the new `QuickBooksConnection.tokenRefreshFailureStartedAtUtc` column so a missed 88th migration fails closed.
- The final pre-BCP local `npm run verify:launch` exited zero on 2026-09-04 against a fresh 88-migration PostgreSQL 16 database and live disposable Redis. It passed backend compilation; 127/127 route inventory; production web build, 16-route prerender, 12/12 i18n and 12/12 SEO checks; lint; Prisma validation; 14/14 security checks; the 76-assertion pretest hook including a two-replica Redis quota proof; 244/244 unit tests; 31 integration files and 398/398 database-backed tests in 520.77 seconds; parser 18/18, assistant 101/101, and retrieval 12/12 evaluations; both dependency audits; and Playwright with 143 passed, one intentional capture-regeneration skip, and zero failures in 24.2 minutes. No provider credentials, live tenants, or provider network calls were used. The immutable SHA and its clean-install Node 22 CI result remain authoritative.
- A new isolated PostgreSQL 16 database applied all 88 checked-in migrations from zero, including `20260904143000_add_quickbooks_token_refresh_failure_started`; an immediate second deploy reported no pending migrations. The new migration is a nullable timestamp addition with SHA-256 `3bd32e0782285f2dec4c814a2ad1e79f27b5d8d0d153e240d5ab58169654c91c`.
- A separate PostgreSQL 16.14 rehearsal cloned the preserved nonempty 87-migration synthetic database into `quotefly_qbo_migration88_20260904_evidence_test`, then applied only migration 88. The ledger advanced from 87/87 active/distinct successful migrations with zero unresolved rows to 88/88 with zero unresolved rows; a second deploy reported no pending migrations. The two existing sandbox QuickBooks connections, six webhook envelopes, 13 total seeded rows, table counts, per-connection fingerprints, and aggregate data fingerprint were unchanged. The new nullable `TIMESTAMPTZ(3)` column existed with no default and was `NULL` for both existing connections. The migration file and Prisma ledger checksums both equal `3bd32e0782285f2dec4c814a2ad1e79f27b5d8d0d153e240d5ab58169654c91c`; Prisma reported the schema current and candidate `/v1/ready` returned `200`. The source dump remained unchanged. Managed-provider backup retention, restore ownership, RPO, and RTO remain owner-controlled gates.
- PR #5 currently reports historical success for CI and the intended `Vercel – quotefly-web` project at base SHA `9ebbc8d`; a second `Vercel – quotefly` context is an obsolete root-project integration and is not release evidence. The final PR head must pass CI and `quotefly-web`; the obsolete context should be disconnected or explicitly ignored by the owner before branch-protection rules are introduced.
- The public staging baseline currently returns `200` for API liveness, database readiness, and the noindex web app, while the new QBO monitor route returns `404`. That accurately proves the current hardening worktree is not deployed yet; it must become an authenticated empty `204`/`503` route only after the ordered exact-SHA staging rollout.
- Railway staging discovery found that the migration and API services were previously deployed by CLI upload and currently have no Git source binding. Because that path does not receive `RAILWAY_GIT_COMMIT_SHA`, the exact candidate must use GitHub-connected, autodeploy-off services on `agent/consumer-launch-readiness`, with **Deploy Latest Commit** in migration-then-API order. The existing QuickBooks worker remains undeployed and off for OAuth-only validation. The authoritative web artifact is the exact-SHA `quotefly-web` Git preview; the staging domain must be moved to that project only after API readiness passes.

### Synthetic nonempty upgrade rehearsal

The isolated PostgreSQL 16 rehearsal on 2026-09-03 passed for the current migration contents atop `5379c29327c7e4785aae05ec71e86c40f924591a`. The base worktree at `1d987c16ec07804a9404c47648d28e0f5ca3be11` applied 84/84 migrations in 19.331 seconds, then seeded two tenants, two QuickBooks connections, four tenant-bound webhook events, two unbound quarantine events, and one legacy singleton worker heartbeat. `pg_dump` completed in 1.566 seconds; the 381,528-byte dump with SHA-256 `ee3e0ff6bf48736c798ad50471c81909688240c212429f358ffca22ba9d218e8` restored in 8.366 seconds.

The restored nonempty database applied all three candidate migrations in 34.643 seconds and finished at 87 applied, zero failed, and no pending migrations. A second deploy reported no pending work. Pre/post fingerprints for the seeded tables were identical. A rollback transaction proved that connection and tenant hard-deletion cascades remove only the intended tenant-bound envelopes while both unbound quarantine rows remain, then restored all original counts. The heartbeat mirror backfilled the legacy row, clamped its future timestamp to database observation time, normalized its release SHA, and preserved rolling compatibility when a legacy singleton write produced distinct old-stopped and new-running instance rows.

Runtime checks used the actual non-owner `quotefly_runtime` login: all 11 QuickBooks tenant tables had enabled and forced RLS; each tenant saw only its own connection and two bound events; an unset tenant saw zero rows; cross-tenant update affected zero, cross-tenant insert was denied, the bounded quarantine allowlist succeeded, and an out-of-list quarantine insert was denied. The runtime role could select the content-free heartbeat mirror and execute only its bounded cleanup function, while direct insert, update, delete, and truncate were denied. Production-mode `/v1/health` and `/v1/ready` each returned 200, including under the synthetic OAuth-only sandbox profile; preserved API logs contain zero provider-endpoint matches.

This evidence is bound to these SHA-256 migration contents and must be rerun if any hash changes before the immutable candidate is committed:

- `20260903162000_batch_quickbooks_webhook_quarantine`: `41971bc3f58b03b8e5d8f6dee8beb05535a8a130094fa80003be0a961e83a99a`
- `20260903172500_cascade_quickbooks_webhook_tenant_data`: `4f3aacc4c5b4893944a839f8ad2a41b671d62d4b25aea75cbc302cf7b03f2314`
- `20260903190000_add_worker_heartbeat_instance_mirror`: `1e3cf066d06502a399c1ab27ca65cd6bfb74ac1f64171f2a9bd9f0ed02b0be5e`

**Operational limitation:** this is a synthetic upgrade/restore, cascade, trigger, least-privilege, RLS, and runtime-readiness pass, not production operations approval. The six-event dataset is not an owner-provided sanitized production-like snapshot and does not establish managed-backup retention, RPO, or RTO. A deliberately held reader caused the `20260903162000` policy DDL to wait 24.376 seconds for an `AccessExclusiveLock`; 51 of 70 samples observed one waiter blocked by one reader. Before any staging or production migration, inspect and drain long transactions, quiesce QuickBooks worker/API ingress as the rollout permits, define a bounded lock/abort threshold, run migration-before-API, and prefer a forward fix. Do not reverse the forced-RLS/cascade boundary or route an unverified older API.

The stopped/preserved rehearsal container is `quotefly-qbo-upgrade-rehearsal-pg`; the dump and value-free API logs are preserved outside the repository under `C:\Users\rcazarez\Projects\quotefly-qbo-upgrade-rehearsal-artifacts-20260903`. These local artifacts are supporting evidence and are not release inputs.

## Mapping visibility decision

QuoteFly already persists tenant-specific customer mappings, item mappings, connection state, and the immutable invoice-operation/reconciliation ledger. The invoice review surface is the authoritative place to select and confirm the exact QuickBooks customer and item targets used for one publish.

A post-validation owner/admin view should expose a paginated, tenant-scoped, read-only inventory of those mappings and their health alongside a versioned description of QuoteFly-to-Intuit field transforms. Canonical transforms must remain typed, reviewed code rather than mutable database rules that could silently change accounting output. Operator-wide diagnostics must remain aggregate and redacted: no tokens, realm or provider entity identifiers, customer/company data, billing email, provider payload/error content, or hosted invoice links. This visibility is a recommended follow-on for supportability; it is not a substitute for OAuth, publish, reconciliation, and owner sandbox evidence and is not an RC blocker unless staging proves the existing invoice review diagnostics insufficient.

## Code-readiness gate

These are QuoteFly engineering obligations. They can be completed without claiming that Intuit or the owner has approved production:

- [ ] The final immutable implementation SHA contains only the intended QuickBooks code, tests, UX, release configuration, and evidence changes; bind it after BCP using the PR head, exact-SHA CI, and deployment metadata rather than a self-referential SHA in this commit.
- [ ] Clean installs, Prisma generation/validation, `npm run verify`, and database-backed `npm run verify:launch` pass for that exact SHA.
- [ ] Fresh-schema migration and synthetic nonempty upgrade/RLS/least-privilege/forward-fix evidence cover all 88 migrations, including the additive token-refresh failure timestamp; the 87-migration rehearsal above remains valid historical evidence but does not qualify the new migration.
- [x] Callback, credential cleanup, tenant-wide OAuth serialization, worker health, renewable claims, webhook bounds, CSV export, and paused-provider containment tests pass.
- [x] API and worker expose safe, redacted evidence that they run the same release SHA and fail readiness when parity is absent.
- [ ] Sentinel, Renford, Goldface, Harbor, and independent Opera approve the exact candidate and evidence.

Passing this section means the software is a production-ready release candidate. It does not mean provider production access is available or safe to advertise.

## Owner-controlled release gate

These require owner or operator access and explicit action; missing evidence here is not a code defect:

- [ ] Authorize and record the ordered exact-SHA staging rollout: migration job, API, API readiness, worker when enabled, then web. OAuth-only keeps the worker off and still deploys web only after API readiness.
- [ ] Confirm masked/presence-only environment setup, least-privileged runtime database credentials, release ordering, and API/worker SHA parity.
- [ ] Complete the OAuth-only browser proof with the dedicated sandbox company; verify expected company, one-time callback, safe replay rejection, and disconnect/revocation.
- [ ] Separately authorize the full accounting sandbox phase and its non-taxable invoice, hosted link, payment, refund/reversal, void, webhook, CDC, timeout, restart, and recovery mutations.
- [ ] Assign alert destinations and owners; prove staging alert delivery for heartbeat, queue age, dead letters, uncertain operations, token/revocation failures, CDC lag, throttling, and release mismatch.
- [ ] Record managed-database backup retention, restore evidence, RPO/RTO, provider kill-switch, reconciliation, and forward-fix rehearsal.
- [ ] Approve support escalation, accounting/tax ownership, legal/privacy wording, pilot tenants, and the final production go/no-go.

## Intuit-controlled or Intuit-dependent gate

These cannot be manufactured by QuoteFly code or specialist approval:

- [ ] The owner completes Intuit's production app details and assessment, including public legal/support URLs, host and launch/connect/disconnect URLs, countries/regions, exact HTTPS redirect URI, and the Accounting scope; Intuit approves the assessment before separate production credentials become available.
- [ ] If QuoteFly relies on webhooks, development and production endpoints/verifiers remain separate, the supported entity subscriptions and payload format match QuoteFly, and sandbox delivery plus the production endpoint satisfy Intuit's webhook requirements.
- [ ] A dedicated QuickBooks Online sandbox company and, for hosted payments, an eligible QuickBooks Payments sandbox/merchant account are available.
- [ ] Live sandbox behavior confirms invoice link, payment/refund/reversal, duplicate/out-of-order webhook, dropped-webhook CDC repair, timeout, token rotation, and revocation semantics.
- [ ] Intuit approves the production Accounting app and required scopes. App Store listing is a separate optional technical/security/marketing review; QuickBooks Payments API access is also separate from Accounting API access. Any hosted-payment claim remains gated on an eligible connected-company merchant account and owner acceptance of fees, settlement, refunds, and disputes.

Provider requirements were rechecked on 2026-09-04 against Intuit's current [production-app publication](https://developer.intuit.com/app/developer/qbo/docs/go-live/publish-app), [redirect URI](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/set-redirect-uri), [webhook configuration](https://developer.intuit.com/app/developer/qbo/docs/develop/webhooks/configure-webhooks), and [Payments scope](https://developer.intuit.com/app/developer/qbpayments/docs/learn/scopes) documentation. Intuit does not document a generic content-free webhook test event; because notifications are change-triggered, proving genuine Intuit delivery is expected to require a benign disposable sandbox entity mutation. That is an operational inference, not a QuoteFly code requirement, and remains outside the current no-accounting-mutation authorization.

## Marketing and production claim rule

Do not advertise direct QuickBooks Online sync, hosted payment, or automatic reconciliation until the exact candidate passes the code gate, the owner completes the staged sandbox and operations gates, Intuit grants the necessary production access, Opera approves the resulting evidence, and the owner explicitly authorizes a limited production pilot. QuickBooks-friendly CSV export may continue to be described as the currently supported accounting handoff.

## Promotion sequence

1. Stabilize and BCP the scoped candidate.
2. Pass exact-SHA CI and the synthetic nonempty migration/RLS/least-privilege/forward-fix rehearsal; retain production-like backup/restore proof for the owner-controlled gate.
3. Obtain specialist re-review and independent Opera approval of the exact evidence.
4. Deploy the same SHA to OAuth-only staging in strict migration-job, API, readiness, worker-off, web order; then complete the owner browser proof.
5. Under separate mutation authorization, advance through `quickbooks-reconciliation`, `quickbooks-cdc`, and `quickbooks-hosted-payments`; for each applicable phase confirm API readiness before starting the same-SHA worker and exposing the phase in web, then complete the full owner sandbox checklist.
6. Close monitoring, backup/restore, support, and rollback/forward-fix evidence.
7. Obtain Intuit production approval and owner acceptance of payments/settlement obligations.
8. Re-run exact-candidate gates and reviews, then authorize a bounded production pilot before broader enablement or marketing.

Related runbooks:

- [QuickBooks Online sandbox setup](quickbooks-sandbox-setup.md)
- [QuickBooks owner testing checklist](quickbooks-owner-testing-checklist.md)
- [QuickBooks hosted payments and reconciliation](quickbooks-hosted-payments-reconciliation.md)
- [QuickBooks worker operations](quickbooks-worker-operations.md)
- [Infrastructure secret handling](../security/infrastructure-secret-handling.md)
