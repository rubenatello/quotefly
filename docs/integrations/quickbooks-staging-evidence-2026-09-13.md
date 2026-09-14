# QuickBooks isolated staging acceptance evidence

This run is explicitly authorized by the owner: BCP, isolated staging deployment/migration, and all necessary QuickBooks sandbox testing. Production deployment remains conditional on a green final independent review. See AGENTS.md and the [candidate record](quickbooks-release-candidate-2026-09-13.md).

## Committed baseline and containment

- Candidate: `d30b7573fd498ecfd895d0f3cb2173b2fe3921f7`, pushed to `feature/quickbooks-staging-acceptance-20260913`; [draft PR 9](https://github.com/rubenatello/quotefly/pull/9).
- Local baseline gate: 394 database tests and 155 browser tests passed, one existing optional capture test skipped. Two terminal blank lines were removed before commit; no logic changed in that formatting step.
- Railway metadata confirms production API and production migrations both auto-deploy `main`, with check suites disabled. No merge to `main` is permitted until production review and migration-before-API ordering are established.
- Railway staging API, migrations, and worker have no deployment triggers and auto-deploy disabled. The Vercel staging project has no Git connection. The unique feature branch does not promote production domains.
- Uploads use only tracked commit files. Local secrets, provider links, generated outputs, and test artifacts are excluded.

## Staging migration

- Environment: existing isolated `staging` environment and Neon `staging/quickbooks-sandbox` branch.
- Service: `quotefly-migrations-staging` (`9e8719d6-d7ab-4076-aa18-d9227761ebfd`).
- Deployment: `39ca4cb3-e01d-45df-a800-6879c48619e6`, terminal `SUCCESS`.
- Resolved build: `npm run prisma:generate && npm run build`; start: `npm run prisma:migrate:deploy`; no HTTP health check; restart `NEVER`.
- Sanitized deployment logs at September 14, 2026 02:40:48 UTC confirm `20260913120000_quickbooks_webhook_replay` applied and all migrations successfully applied.
- Railway rejected a proposed legacy config-file-path update before applying it. Existing service-level commands were retained and verified in the new deployment. No retry of the rejected mutation was made.
- Passing `.` explicitly to this Windows Railway CLI caused a local `prefix not found` error before deployment creation. A tracked-only archive extracted outside the repository and `railway up` without a positional path uploaded successfully. Use explicit project/environment/service selectors.

## Staging web build

- Vercel project: `quotefly-staging` (`prj_Yr5wuwSn1I8qYpJONjAIrL5Ivorc`).
- Deployment: `dpl_FN5g2B9W8mZxRhHJSX5GnEWVJhzz`, `Ready`.
- Build metadata records the exact baseline SHA. `--skip-domain` was used; `staging.quotefly.us` was not promoted to this build. The deployment is not a production QuoteFly release.

## Runtime and provider evidence

- Presence-only audit executed inside the existing staging API process through OpenSSH: OAuth-only profile passed; sandbox client credentials and token-encryption key are present, migration-owner URL absent, accounting/worker flags disabled. Webhook verifier is still missing from that runtime.
- Browser connection is now available through the installed Chrome extension. The owner is signed into Intuit and QuoteFly staging.
- Intuit Development webhook settings visibly select CloudEvents, point to the exact staging webhook URL, and currently select all event groups. The verifier remains masked. Narrow subscriptions to supported Invoice, Payment, and RefundReceipt events when the accounting runtime is ready; do not capture verifier values.
- Owner selected Ruben / `rubenatello@gmail.com` for operational alerts and identified existing GitHub monitoring. The existing workflow checks public API health only; QBO heartbeat/backlog/dead-letter coverage and email delivery remain unproven.

## Newly identified tax blocker

Review against Intuit's AST contract found that omitting a sales-line tax code can allow provider-inferred tax even when QuoteFly tax is zero. Opera classified this as `QBO-TAX-01`, High. A bounded fix must explicitly send `NON` on every current non-taxable line and reject canonical readback with nonzero tax or an explicitly incompatible tax code. Returned tax-code omission must be tolerated until provider echo behavior is established; the exact reviewed payload is already HMAC-bound.

The bounded fix now sends `TaxCodeRef: { value: "NON" }` on every sales line. Canonical reconciliation parses optional `TxnTaxDetail.TotalTax` and line `TaxCodeRef`, rejects nonzero tax or an explicit non-`NON` code, and preserves the ledger while marking the operation reconciliation-required. It tolerates omitted echoed tax fields and retains the shared fingerprint; the complete reviewed payload is HMAC-bound. Backend build and all 55 invoice integration tests passed, including multi-line posted payload, positive-tax pre-create blocking, and canonical tax-conflict quarantine. Opera found no further source correction; a fresh complete gate on the committed fix is still required before API/worker accounting rollout.

The independent additive migration above does not enable accounting. The owner wants tax handled appropriately for contractor accounts; the broader structured tax calculation, address/mapping, provenance, and review contract remains an open implementation requirement, not a feature of the non-taxable baseline.

No QuickBooks accounting records have been created or modified in this run. API/worker rollout, signed delivery, payments/refunds/deletions, CDC/recovery, alert delivery, and production-like restore evidence remain incomplete.
