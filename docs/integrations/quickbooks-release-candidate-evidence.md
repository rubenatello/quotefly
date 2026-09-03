# QuickBooks Online Release-Candidate Evidence

Last updated: 2026-09-03

Status: active release-candidate qualification. This record separates engineering readiness from owner-operated staging/production actions and Intuit-controlled approvals. It does not authorize a deployment, provider flag change, webhook subscription, sandbox accounting mutation, production mutation, or marketing claim by itself.

## Release identity

The release candidate is the commit that contains the QuickBooks remediation and this evidence record. Record its immutable Git SHA, CI run, API deployment, web deployment, migration job, and reconciliation-worker deployment in the table below after each exists. A passing result for an older SHA is historical evidence only.

| Evidence item | Current result | Release meaning |
| --- | --- | --- |
| Previously deployed staging/API SHA | `1d987c16ec07804a9404c47648d28e0f5ca3be11` | Healthy process, but not an acceptable QuickBooks candidate because the owner-observed OAuth callback failed. |
| Previous exact-SHA CI | Passed for `1d987c16ec07804a9404c47648d28e0f5ca3be11` | Baseline only; it does not validate the remediation. |
| Remediated candidate SHA | The commit containing this record on `agent/consumer-launch-readiness`; resolve it from Git after BCP | Must be the same source revision used by CI, migration rehearsal, API, web, and worker evidence. |
| Remediated `npm run verify` | Required locally and in the exact-SHA launch gate | A worktree pass is supporting evidence; committed CI is authoritative. |
| Remediated database-backed `npm run verify:launch` | Required locally and in exact-SHA CI | A passing worktree run does not replace the committed CI result. |
| Exact-SHA staging OAuth proof | Pending authorized deployment and owner browser action | Must connect the expected sandbox company and stop before setup confirmation in OAuth-only mode. |
| Full accounting sandbox proof | Not started | Requires separate approval for provider mutations, a live worker, signed webhooks, CDC, monitoring, and the owner checklist. |
| Production pilot | Not authorized | Requires the code, staging, operations, owner, and Intuit gates below. |

## Observed staging failure and diagnosis

The owner reached Intuit's sandbox consent screen, selected **Connect**, and returned to QuoteFly staging with the generic `quickbooks_error` notice. Safe staging evidence showed five callback failures on the deployed baseline while liveness, database readiness, and authenticated authorization handoff remained healthy. No OAuth code, state, realm identifier, token, or raw provider response was retained in this record.

The callback's post-token company check used the requested company realm in the Intuit URL, then incorrectly treated `CompanyInfo.Id` as that realm identifier. Intuit returns a realm-local CompanyInfo entity ID (commonly `1`), while the OAuth `realmId` identifies the company in the request path. A valid consent flow could therefore exchange its code and load the correct company, then be rejected locally as a realm mismatch.

The remediation keeps the OAuth callback bound to the signed, one-time, browser-session state and requested realm, validates the CompanyInfo response shape and display name, and no longer compares the realm-local entity ID to the OAuth realm. Focused provider-contract coverage uses a requested realm distinct from `CompanyInfo.Id`.

## Engineering changes under qualification

- Correct CompanyInfo/realm interpretation and classify callback failures with content-free stage and event codes.
- Reject non-canonical signed-state encodings and sanitize token-exchange failures without retaining Intuit response content.
- Serialize OAuth generations tenant-wide so a later manager connection supersedes an older callback safely.
- Revoke or durably queue an issued refresh credential when callback or rotation finalization loses its database fence.
- Require a fresh reconciliation-worker heartbeat before publish or hosted-payment capabilities are reported as available.
- Renew long-running webhook claims and refresh worker health independently during provider work.
- Bound multi-realm webhook ingress, persist realm batches with bounded concurrency, and measure the acknowledgement budget.
- Enforce an approved browser origin for disconnect and return stable, sanitized legacy preview failures.
- Preserve in-progress mapping edits, navigation safety, accessible loading/error behavior, explicit unavailable guidance, and a reachable QuickBooks-friendly CSV export workflow in the workspace UI.
- Count the current invoice-operation ledger in tenant and operator diagnostics, keep provider identifiers redacted, and label the operator metric accurately without breaking the established response shape.
- Keep migration-only database credentials out of API-runtime integration fixtures while preserving the production rejection check.
- Give the atomic signup and quote-acceptance workflows the repository-standard bounded transaction budget under database load.
- Cascade tenant-bound webhook envelopes on hard tenant or connection deletion while preserving genuinely unbound quarantine rows.

## Dated local qualification evidence

The following 2026-09-03 results qualify the executable worktree before BCP. The final authority remains exact-SHA CI and exact-SHA staging evidence:

- The final Docker/Node 24 `npm run verify:launch` passed end to end after all remediation and admin-accuracy changes: the complete CI-equivalent phase passed, and Playwright finished with 133 passed, one intentionally skipped capture-regeneration case, and zero failures in 48.7 minutes.
- Node 24 database-backed integration: 30 files and 369 tests passed with no concurrent process using the test database.
- QuickBooks invoice integration: 62 tests passed twice consecutively; the two previously load-sensitive signup/acceptance cases also passed focused.
- Environment containment: 11 security-boundary integration tests passed with a deliberately present migration-only database credential, which the API-runtime fixture removed before configuration parsing.
- Migration rehearsal: all 86 migrations applied from zero to a newly created, isolated test-named PostgreSQL database.
- Webhook lifecycle: the complete QuickBooks retention file passed 7/7, including hard tenant deletion, hard connection deletion, cross-tenant preservation, and unbound-quarantine preservation.
- The exact worker-to-retention cleanup sequence that originally exposed the foreign-key ordering defect passed 3/3 followed by 5/5 after the cascade migration.
- Renford approved the remediated backend and migration design after the fresh-schema rehearsal. Sentinel approved the security code candidate, and Goldface re-approved the final admin accuracy/mobile correction; all remain subject to exact-SHA confirmation. Harbor and Opera remain gated on the committed candidate and operational evidence.

## Code-readiness gate

These are QuoteFly engineering obligations. They can be completed without claiming that Intuit or the owner has approved production:

- [ ] One scoped, immutable candidate SHA contains only the intended QuickBooks code, tests, UX, and evidence changes.
- [ ] Clean installs, Prisma generation/validation, `npm run verify`, and database-backed `npm run verify:launch` pass for that exact SHA.
- [ ] Fresh-schema migration and a production-like upgrade/RLS/least-privilege rehearsal pass with recorded duration and rollback/forward-fix evidence.
- [ ] Callback, credential cleanup, tenant-wide OAuth serialization, worker health, renewable claims, webhook bounds, CSV export, and paused-provider containment tests pass.
- [ ] API and worker expose or otherwise provide safe evidence that they run the same release SHA.
- [ ] Sentinel, Renford, Goldface, Harbor, and independent Opera approve the exact candidate and evidence.

Passing this section means the software is a production-ready release candidate. It does not mean provider production access is available or safe to advertise.

## Owner-controlled release gate

These require owner or operator access and explicit action; missing evidence here is not a code defect:

- [ ] Authorize and record exact-SHA staging API, web, migration-job, and worker deployments.
- [ ] Confirm masked/presence-only environment setup, least-privileged runtime database credentials, release ordering, and API/worker SHA parity.
- [ ] Complete the OAuth-only browser proof with the dedicated sandbox company; verify expected company, one-time callback, safe replay rejection, and disconnect/revocation.
- [ ] Separately authorize the full accounting sandbox phase and its non-taxable invoice, hosted link, payment, refund/reversal, void, webhook, CDC, timeout, restart, and recovery mutations.
- [ ] Assign alert destinations and owners; prove staging alert delivery for heartbeat, queue age, dead letters, uncertain operations, token/revocation failures, CDC lag, throttling, and release mismatch.
- [ ] Record managed-database backup retention, restore evidence, RPO/RTO, provider kill-switch, reconciliation, and forward-fix rehearsal.
- [ ] Approve support escalation, accounting/tax ownership, legal/privacy wording, pilot tenants, and the final production go/no-go.

## Intuit-controlled or Intuit-dependent gate

These cannot be manufactured by QuoteFly code or specialist approval:

- [ ] The Intuit development/production app has the exact scopes, redirect URI, webhook endpoint, payload format, entity subscriptions, verifier, and separated sandbox/production credentials.
- [ ] A dedicated QuickBooks Online sandbox company and, for hosted payments, an eligible QuickBooks Payments sandbox/merchant account are available.
- [ ] Live sandbox behavior confirms invoice link, payment/refund/reversal, duplicate/out-of-order webhook, dropped-webhook CDC repair, timeout, token rotation, and revocation semantics.
- [ ] Intuit approves the production app and required scopes; QuickBooks Payments eligibility, fees, supported payment methods, settlement, refunds, and disputes are accepted by the owner.

## Marketing and production claim rule

Do not advertise direct QuickBooks Online sync, hosted payment, or automatic reconciliation until the exact candidate passes the code gate, the owner completes the staged sandbox and operations gates, Intuit grants the necessary production access, Opera approves the resulting evidence, and the owner explicitly authorizes a limited production pilot. QuickBooks-friendly CSV export may continue to be described as the currently supported accounting handoff.

## Promotion sequence

1. Stabilize and BCP the scoped candidate.
2. Pass exact-SHA CI and the production-like migration/least-privilege rehearsal.
3. Obtain specialist re-review and independent Opera approval of the exact evidence.
4. Deploy the same SHA to OAuth-only staging and complete the owner browser proof.
5. Under separate mutation authorization, enable the staging worker/webhook runtime and complete the full owner sandbox checklist.
6. Close monitoring, backup/restore, support, and rollback/forward-fix evidence.
7. Obtain Intuit production approval and owner acceptance of payments/settlement obligations.
8. Re-run exact-candidate gates and reviews, then authorize a bounded production pilot before broader enablement or marketing.

Related runbooks:

- [QuickBooks Online sandbox setup](quickbooks-sandbox-setup.md)
- [QuickBooks owner testing checklist](quickbooks-owner-testing-checklist.md)
- [QuickBooks hosted payments and reconciliation](quickbooks-hosted-payments-reconciliation.md)
- [QuickBooks worker operations](quickbooks-worker-operations.md)
- [Infrastructure secret handling](../security/infrastructure-secret-handling.md)
