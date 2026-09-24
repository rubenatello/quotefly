# QuickBooks checkpoint — September 24, 2026 (UTC)

## Saved baseline and staging recovery

Feature commit `f82c6e8f02f4bc29c7dbdeaebf89ff388571c9da` contains the authenticated internal tax-review assembler and context-bound claim validation. Independent source review approved that exact candidate. Local `verify:ci` passed with 402 unit tests and 561 database tests; GitHub CI run `35938009769` also completed successfully. Main remains unmerged.

The isolated staging migration job `2177175c-881d-4f93-b298-0c650f0cfbfc` applied the context and review-binding migrations, then exited unsuccessfully at its post-migration catalog check. The checker expected 12 context-table constraint rows; PostgreSQL also records the two intentionally deferred constraint triggers there, making 14. This was a checker defect, not a failed SQL migration. Preserve the failed deployment as incident evidence. Do not rerun that one-shot job or perform a down migration.

The independent read-only recovery check at `2026-09-24T00:57:52.515Z` passed: migration history 97 total / 96 completed / one historical rollback / zero unresolved, exact new migration checksums, preserved prior-history digest, 37 forced-RLS tables, 46 tax-operation columns with only 19 runtime-update columns, and the exact 12 ordinary plus two deferred trigger constraints. Both context tables are empty. Existing counts remain 39 customers, six quotes, one job and one internal invoice; provider-operation rows remain empty.

Sentinel and Opera separately approved deploying only the immutable f82 staging API after reviewing this recovery evidence. The later capture endpoint and UI work are outside that deployment approval. OAuth-only mode, reconciliation/CDC disablement and hosted-payment disablement remain mandatory. Production is outside this approval.

That exact API rollout completed as deployment `ab69878b-ba8f-4dac-b3d2-ff20a82bdadc`. All 19 critical deployed source hashes match f82. Runtime checks confirm the sandbox/OAuth-only safeguards, verifier and encryption-key presence, absence of the owner database URL, and the restricted non-superuser/non-bypass runtime role. `/v1/health` and `/v1/ready` returned 200 at `01:07:05.908Z` and `01:07:06.148Z`. A further read-only check at `01:06:13.697Z` passed after restricting the catalog correction to the context tables; the tax-operation boundary query remains unchanged. Frontend, workers and production were not part of this rollout.

## Capture API candidate

The next backend increment implements authenticated manager GET/POST at `/v1/integrations/quickbooks/invoices/:invoiceId/tax-context`. Responses, including errors, are private/no-store. GET supplies display-only invoice details, editable address suggestions and a short-lived purpose-bound form token. POST accepts explicit date, addresses, local line tax intent, expected revision and a UUID command key. It reloads all financial, lifecycle, setup, connection and mapping authority under the publication lock.

The source token uses a separate HKDF/HMAC purpose, strict encoding and lifetime bounds, exact current/previous key IDs and constant-time verification. It contains no addresses, provider IDs or credentials. Live tenant membership and authorization are rechecked inside the transaction. An unchanged command can replay after a lost successful response and token reissue without duplicating context revisions.

The increment makes no provider calls, changes no invoice totals and returns `taxCalculationProven: false` and `publishingAuthorized: false`. Independent Sentinel review approved the frozen six-file increment. Full local `verify:ci` passed at `2026-09-24T01:12:50.713Z`: 406 unit tests and 574 database tests, backend/frontend builds, lint, schema validation, route/security checks, parser evaluations and dependency audits. Final Opera review remains pending at this checkpoint.

## Separate UI work and remaining release evidence

The tax-details form remains in the isolated `feature/quickbooks-tax-capture-20260923` worktree. It is not part of the saved f82 release or the six-file backend increment. Review found and is addressing mobile action-bar overlap, unsaved-navigation coverage, browser Back listener ordering, job-refresh preservation and keyboard focus across overlay handoffs. Do not describe that UI as released until its own tests and final review pass.

Real positive-tax Estimate behavior and linked-Invoice parity, signed webhook delivery/recovery, payment/reconciliation scenarios, successful alert delivery and the complete production gate remain open. Intuit developer sign-in and replacement of the invalid Resend credential still require owner action. Public claims remain limited to functionality actually available; no tax, synchronization or production-readiness claim is authorized by this checkpoint.
