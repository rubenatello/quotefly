# QuickBooks staging continuation — September 23, 2026

Resume candidate: `98c75753d0931433b284ae7f190a2ceea978e113`, branch `feature/quickbooks-staging-acceptance-20260913`, draft PR #9. Fresh fetch confirmed unchanged `origin/main` at `1d987c16ec07804a9404c47648d28e0f5ca3be11` and a clean worktree at resumption. Exact-commit GitHub CI run 115 (`34804967612`) completed successfully. The prior local launch gate and formatting-equivalence proof remain applicable.

Opera independently rereviewed the committed migration and runtime boundary: APPROVED for the bounded isolated staging rollout, with fresh provider-state checks required. This does not approve production or invoice publishing before hosted operational prerequisites.

## Fresh preflight

- Railway authentication works. The owner confirmed `rubenatello@gmail.com` is saved and verified for the account's operational notifications. Actual delivery remains a separate test.
- Existing API deployment remains `8a8c5caf-03a4-4b93-b066-fae80fd74b98` (9545836), SUCCESS.
- Environment `90d918bf-8432-4cf5-89e0-6166cb46468c` is staging, with no source environment. The new monitor has exactly one service instance there and no existing deployment/source.
- Migration and worker service commands match the prior reviewed setup. Migration is a one-shot command with no HTTP health check; the worker uses its dedicated start command.
- Running API presence-only audit confirms sandbox credentials/key/verifier present, migration-owner URL absent, OAuth-only mode true, and reconciliation/CDC/payments false. The old OAuth audit profile still flags the intentionally configured verifier; its overall result is not claimed as passing.
- Read-only database proof confirms forced RLS and actual restricted `quotefly_runtime`, with neither monitor table present before migration.
- The staging browser session expired; the owner was asked to sign into the existing account. No password was retrieved or requested in chat.

## Artifact and rollout tracking

The first archive used Windows Git's CRLF export conversion. Its upload began before the asynchronous archive-verification process had returned; verification then identified byte differences. The deployment (`1d09343a-5707-4fa8-8a06-8a64cf8c568e`) was explicitly cancelled and subsequently reported REMOVED. The read-only database proof still showed both monitor tables absent. Future dependent operations must wait for the archive command's final exit before uploading.

A fresh `git -c core.autocrlf=false archive` was fully verified before upload: all 82 committed source hashes match `f434118d41cad2bbb09945267eee474588a01f91b717eaebf7d9b8776eeaf025`, and no environment files are present. The archive lives outside the workspace at the ignored local temporary path ending `quotefly-staging-98c7575-lf-20260923`.

- Corrected migration deployment: `9092bc82-7999-4573-9212-490fa0f19b19`; completion pending at this checkpoint.
- Matching Vercel staging build: `dpl_FoJDB7wSsZV4kexAAg7yvC7Hn7fJ`, READY, not yet promoted. This uses only the isolated `quotefly-staging` project.
- Worker-only flags prepared with deployment deferred: provider and reconciliation true, OAuth-only false, CDC false. API flags remain unchanged.

No production deployment, accounting write, or real-provider acceptance claim is made by this checkpoint. Continue the sequence in the September 13 handoff, recording actual results below as they become available.

## Migration and API/web completed

- Corrected migration deployment reached SUCCESS. Sanitized logs at 17:21:29–17:21:30 UTC identify the monitor migration and confirm all migrations successfully applied.
- API deployment `5ff4eab8-9de7-4565-9541-1aabc3fd88f2` reached SUCCESS with `npm start` and `/v1/ready`. Both staging health/readiness probes returned HTTP 200.
- Vercel staging deployment `dpl_FoJDB7wSsZV4kexAAg7yvC7Hn7fJ` was promoted successfully within the staging project.
- Hosted read-only proof passed: actual restricted runtime role; all 34 expected tenant tables have enabled and forced RLS; both monitor tables allow SELECT/INSERT/UPDATE and deny DELETE. Both worker heartbeats were absent before startup, as expected.
- Complete active-tenant pre-start scan found one connected sandbox company, zero setup-confirmed companies, zero outstanding/dead webhooks, zero reconciliation-required operations, zero connection/orphan revocations, and zero scheduled/claim-candidate work. Counts do not assert token validity or accounting permission. Local sanitized evidence: `.codex_tmp/qbo-hosted-prestart-20260923.json`.
- Fresh Sentinel resumption check passed: current root/web registry audits have zero advisories, policy exceptions remain empty, and 23 focused worker/monitor boundary tests passed. No reviewed source/config changes were made.
- Reconciliation worker deployment `1db63ef4-29be-4ecc-8b68-8eb5d00a265d` and monitor deployment `9a321c7e-0339-47ea-b83e-a6db8ebbeee1` are building at this checkpoint. Resolved starts are their dedicated commands, with no HTTP health checks. Monitor is enabled with reconciliation/CDC expectation false during initial startup; expectation will change only for the controlled worker monitoring test.

## Worker configuration and monitor diagnosis

- Railway marked the initial worker deployment successful, but the application correctly refused legacy unrelated Stripe/Resend credentials in its restricted environment. A temporary fixed-message diagnostic start identified configuration failure without emitting values. The worker-only unused credentials were cleared, NODE_ENV set to production, and the dedicated worker command restored. A redeploy reused the prior command manifest; a fresh archive upload was required to apply the service command change.
- Worker deployment `6a45cdc0-e715-456e-9e6a-f6a36e82fb2e` runs the reviewed 98c7575 artifact. Presence-only worker profile and actual runtime RLS/grant checks pass. Persisted RUNNING heartbeats began at 17:37:13 UTC and remain fresh. Workflow invocation counts include no-op tenant scans; they are not provider request counts.
- Initial monitor deployment ran successfully with worker expectation false. Deployment `cc26fe77-26a1-4eef-ada3-074d25ee5151` enables the reconciliation expectation; CDC remains false. Fixed presence evidence confirms the verified recipient and staging label.
- The new monitor has intermittent FAILED cycles. Successful samples scan 11 active tenants, queue zero alerts and report zero terminal deliveries. A read-only diagnostic localized a failure to `loadQuickBooksOperationalHealth`: Prisma P2028 after approximately 4.8 seconds. Transaction timeout remediation and hosted verification remain pending. The SSH diagnostic projects only the monitor's expected environment keys because injected SSH configuration is outside the daemon profile.
- No controlled worker stop, OPEN/RECOVER alert delivery, inbox receipt, or quiet-window acceptance has yet been completed. The worker remains running during monitor diagnosis. No invoice publishing or production deployment occurred.

## Tax capability preflight checkpoint

Four source files add an unexposed, read-only company/preferences capability helper and its unit gate. It validates the company binding before reading preferences and returns only fixed prerequisite booleans/reason codes. It always reports automated tax calculation as unproven. No route, schema, workflow flag, or accounting write is enabled.

Independent backend and Opera reviews approved this bounded checkpoint for BCP to the staging branch. Full local `npm run verify` passed, including 289 unit tests, build, lint, schema, security checks, evaluations, and dependency audits. An earlier attempt failed because Docker/Redis was stopped; after starting the dedicated test services the complete gate passed. The old Redis port was unavailable, so a separate isolated Redis container uses local port 16379.

Actual sandbox company-country/address and preference representation still need a sanitized read-only fixture before any caller uses the helper. Exact-commit remote CI remains required after push. Hosted services remain on 98c7575; this review is not production or tax-calculation approval.
