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

## September 14 continuation: reviewed OAuth-only rollout

- Exact candidate `9545836eccfe92183fe4b97140915dac520716d3` passed the complete local launch gate: exit 0, 395 database tests across 33 files, 155 browser tests passed, one existing optional capture skipped. GitHub CI run 114 (`34800442305`) also completed successfully.
- Opera approved this exact API/web candidate for isolated OAuth-only staging. Its worker is blocked separately by `QBO-WORKER-ENV-01`: the entry point imports API-wide configuration and would require unrelated billing/mail secrets. A dedicated parser is being implemented; no unrelated secrets were copied into the worker.
- Railway API deployment `8a8c5caf-03a4-4b93-b066-fae80fd74b98` reached `SUCCESS`, uploaded from the tracked-only archive of the exact commit. Start command remains `npm start`; readiness remains `/v1/ready`. Both health and readiness returned HTTP 200.
- Vercel staging deployment `dpl_9PRT4LPCRNmDKbTUdNvQRNnSAdNE` reached `READY` and was successfully promoted within the isolated `quotefly-staging` project. The authenticated staging settings page reloads with the connected sandbox company.
- The owner saved the development webhook verifier in the staging API secret editor. A subsequent presence-only check inside the running API confirmed both verifier and token-encryption key configured, migration-owner URL absent, OAuth-only mode true, and hosted payments/reconciliation/CDC false. The old OAuth-only audit profile classifies verifier presence as forbidden; record individual presence and flag matches rather than claiming that whole profile passes.
- Intuit Development webhook configuration was saved with only Invoice, Payment, and RefundReceipt event groups selected, CloudEvents enabled, and the exact staging endpoint. The verifier remained masked; the Save control became disabled after persistence.
- Staging worker references were prepared without deploying it. The unnecessary verifier reference will be removed to match the reviewed dedicated worker profile. Worker enablement and accounting writes remain pending the new source review.
- Read-only sandbox UI access is working. The sandbox is US QuickBooks Plus with Accounting and Payments listed. Its Sales Tax screen requests migration/setup and shows a sample address; no tax setup was saved and this is not proof of AST API support or payments eligibility.
- The new web build exposed a misleading connection-only readiness message. A bounded follow-up restores explicit disabled-phase wording and hides setup-confirmation guidance in OAuth-only mode, with a browser regression.

As of September 14, 2026 03:15 UTC, no sandbox accounting record has been created or modified. This continuation establishes deployment and credential presence, not signed event delivery or invoice/payment correctness. Consumer/production approval remains blocked on the documented provider, tax, and operational evidence.

## Combined worker and monitor candidate

- The dedicated worker parser, import bootstrap, and artifact environment-file guard remove the API-wide secret dependency without changing the reconciliation loop. Worker configuration preserves credential bytes, rejects unrelated secrets, and validates the approved sandbox origins before loading Prisma. The unnecessary worker verifier reference was cleared with deployment deferred; the API verifier remains configured.
- The independent monitor source was reviewed and integrated with its additive migration, fixed-recipient durable alert outbox, narrow configuration, forced-RLS tenant scans, CDC overlap correction, and retry-window protections. The new staging monitor service is configured but disabled and has no deployment. No production runtime was changed.
- The frozen combined source contains 82 non-documentation files relative to base `1d987c1`, raw-byte manifest `70a05a62eef69fbd92fb0348e90b31df5a58c0758e278119c229678e7240bd8f`. A full launch run exposed a pre-existing noncanonical base64 alias in OAuth state tamper validation; the fix now rejects aliases before decryption and adds a deterministic regression. The new complete gate is running against the frozen corrected source.
- A clean external artifact matched all 82 source hashes, installed its own dependencies, generated Prisma, applied all migrations to a fresh local `quotefly_worker_boot_test`, and built successfully. With synthetic configuration and the real restricted `quotefly_runtime` role, it passed startup RLS assertions, persisted STARTING then RUNNING, and completed a cycle with zero provider work and zero failures. Windows termination did not persist STOPPED; graceful hosted Linux shutdown remains required.
- Staging UI smoke created only synthetic QuoteFly CRM data: one customer, a reusable service item, and a two-line quote totaling USD 300 with zero tax. The customer preview showed the expected total without internal costs or margins. No outbound message or QuickBooks accounting record was created.
- Railway already has email/in-app rules for failed deployments and crashed/OOM processes. The account page showed an empty email field; owner confirmation of the intended address and verification is pending. Native platform alert delivery and monitor OPEN/RECOVER inbox receipt are still unproven.

These checks do not establish taxable invoice support, signed webhook delivery, provider-backed reconciliation, or production readiness. The next bounded rollout must apply the additive monitor migration before starting the reviewed API, worker, and monitor in isolated staging.

The corrected combined candidate completed `npm run verify:launch` with exit 0: 406 database tests across 34 files, 156 browser tests passed, and one existing optional capture-generation test skipped. Browser verification took 13.6 minutes. Backend/frontend builds, lint, Prisma validation, security checks, unit tests, AI evaluation, and dependency audits all passed. The frozen source manifest above remained the release input; local evidence is preserved in `.codex_tmp/combined-launch-passed.log`.

Before the hosted worker starts, record content-free counts for due webhook work, reconciliation-required operations, connection/orphan revocations, and active sandbox connections. Enabled reconciliation can refresh/revoke credentials or perform canonical reads for existing work; do not describe hosted startup as zero-provider unless those queues and outcomes establish it. Keep the API in OAuth-only mode and CDC/hosted payments disabled until the operational evidence permits the next phase.

The staged whitespace check found 15 space-only blank lines in the newly added reconciliation runtime file. Removing those 30 spaces produced byte-identical emitted JavaScript, with no other source change. The formatting-adjusted source manifest is `324d4db6608269d84eabac5fc52d6d48ad93e08f864e3844c9fd6ce9749f432a`; full-gate and clean-artifact evidence above explicitly refer to the preceding `70a05a62` manifest. Git's CRLF-to-LF storage normalization must also be checked when recording the committed artifact.
