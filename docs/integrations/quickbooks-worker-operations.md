# QuickBooks reconciliation worker operations

Status: deployment and monitoring contract for staging evidence and a future separately approved production pilot. This file does not authorize a Railway service, provider flag, migration, or production operation.

The QuickBooks reconciliation worker is a separate long-running process. The API can durably persist a signed webhook without processing it, so an API-only deployment must never be presented as automatic reconciliation or CDC recovery.

## Railway service contract

Create one private worker service from the same commit SHA and repository build as the API. Bind its service configuration to `/railway.quickbooks-reconciliation.json` and confirm Railway resolves:

- build: `npm run prisma:generate && npm run build`;
- start: `npm run start:quickbooks-reconciliation`;
- HTTP health check: none;
- restart: `ON_FAILURE`, at most three retries.

Railway's legacy Config as Code path is deprecated and its documentation identifies a December 1, 2026 cutoff. Before creating or changing the service, confirm whether the current Railway project requires the equivalent settings in the dashboard or current configuration workflow. Never assume the file was applied merely because it exists in Git.

Reference: [Railway Config as Code](https://docs.railway.com/config-as-code).

## Runtime boundary

The worker receives only the least-privileged runtime `DATABASE_URL`; never give it `DIRECT_DATABASE_URL` or a migration-owner credential. Configure the same environment and provider boundary as the API:

- `NODE_ENV=production`;
- matching `QUICKBOOKS_ENVIRONMENT`;
- development credentials for sandbox or separately approved production credentials;
- exact webhook verifier;
- the exact same `QUICKBOOKS_TOKEN_ENCRYPTION_KEY` and intentionally managed `QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS` values as the API for this environment; these keys remain independent from `JWT_SECRET`;
- `QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED=true`;
- `QUICKBOOKS_OAUTH_ONLY_MODE=false`;
- `QUICKBOOKS_RECONCILIATION_WORKER_ENABLED=true`;
- `QUICKBOOKS_CDC_WORKER_ENABLED=false` for the first connection/reconciliation stage;
- `QUICKBOOKS_HOSTED_PAYMENTS_ENABLED=false` until InvoiceLink and payment eligibility evidence is approved.

Before starting the first accounting worker, run `npm run infra:variables:audit -- --profile quickbooks-reconciliation` in the configured process environment. Use `quickbooks-cdc` only for the separately authorized CDC phase and `quickbooks-hosted-payments` only for the hosted-payment phase. The `quickbooks` profile is a compatibility alias for that same complete final stage. These checks report presence and expected booleans without emitting values; they do not prove the remote provider configuration.

The API and worker must run the same checked-in migrations and exact candidate SHA. Git-based Railway and Render deployments use the provider-injected commit SHA automatically and must leave `QUOTEFLY_RELEASE_SHA` absent. Non-Git/image deployments must set the same full 40-character `QUOTEFLY_RELEASE_SHA` on both processes. A conflicting valid manual and provider identity fails closed instead of masking the running provider commit. The worker includes this non-secret identity in `WorkerHeartbeat.metrics`, and the authenticated QuickBooks status response reports API/worker identity and match state. When the API has a release identity, a missing or mismatched worker identity makes reconciliation readiness fail closed. The worker has no HTTP server; process supervision is liveness, while its content-free structured heartbeat is the operational readiness signal.

`WorkerHeartbeat` remains the compatibility singleton written by every worker version. A database trigger mirrors each write into `WorkerHeartbeatInstance`, keyed by worker and a one-way process reference hash, so an overlapping old worker cannot be hidden by whichever process wrote the singleton last. The mirror records `observedAtUtc` with PostgreSQL `clock_timestamp()`; worker-supplied future timestamps therefore cannot extend readiness. PostgreSQL reduces the fleet to fixed-shape counts, release identity, and at most one representative metrics object before returning it to the API. Fleet readiness requires at least one fresh `STARTING` or `RUNNING` instance, fails closed above the fixed ceiling of 100 fresh live instances, and requires every fresh `STARTING`, `RUNNING`, or `STOPPING` instance to report the API's exact release SHA. `STOPPING` by itself is not capacity. Fresh mismatch or missing identity fails closed until that instance stops or its database observation ages out. Tenant-manager status exposes only status, readiness, the database-observed heartbeat time, and a release-match boolean. Detailed aggregate counts, exact release SHAs, and representative content-free metrics remain in the audited superuser control plane; process reference hashes are never selected or serialized.

The hourly retention pass invokes a database-owned cleanup with no caller-controlled arguments. It deletes at most 100 per-instance heartbeat rows whose database observation is older than 30 days per invocation. The runtime role has `SELECT` on the mirror and `EXECUTE` on that fixed cleanup only; direct mirror insert, update, delete, truncate, and trigger-function execution remain denied. Runtime writes to the legacy singleton continue to invoke the security-definer mirror during rolling deployment.

## Required monitoring

Send alerts to a named destination and owner for:

- required worker-capacity loss: warn immediately; treat an absent, `STOPPING`-only, terminal-only, overflowed, or release-mismatched fleet as critical immediately, and treat a last `STARTING`/`RUNNING` database observation as critical once it is three minutes old;
- oldest eligible webhook or reconciliation work older than five minutes (warning) or fifteen minutes (critical);
- any dead-letter transition and a separate tenant-safe count of outstanding dead letters;
- repeated sanitized failure codes, provider timeouts, throttling, and restart loops;
- token refresh, orphan revocation, or `REVOCATION_PENDING` failures;
- CDC cursor lag or recovery failure after CDC is enabled;
- retention cadence failure;
- per-instance heartbeat retention failure or a sustained unexpected fleet-size increase;
- worker/API SHA or environment mismatch.

The heartbeat's `dead` value is a per-tick transition count, not an outstanding inventory. Do not use it as the only dead-letter alert. External monitor responses, external QBO signal payloads, and persisted operational heartbeat metrics must remain content-free: bounded counts, ages, states, latency, and fixed normalized outcomes only; never include tokens, provider/customer data, raw failure text, identifiers, hashes, callback queries, or hosted invoice links. Existing access-controlled local worker diagnostics may contain a one-way tenant reference, normalized failure code, or error class; never forward the global log stream to the QBO signal sink.

The API exposes two content-free machine monitors at
`GET /v1/internal/quickbooks/monitor/warning` and
`GET /v1/internal/quickbooks/monitor/critical`. Configure an independent,
random, 32-character-or-longer `QUICKBOOKS_MONITOR_BEARER` on the API and send
it only as `Authorization: Bearer <token>`; query authentication is rejected.
Never provision this bearer to the worker, migration job, or web runtime.
Both endpoints return an empty `204` when healthy or an empty `503` when their
tier is unhealthy, unconfigured, or cannot be evaluated. Authentication and
rate-limit failures are also empty (`401` and `429` respectively), and every
response is `Cache-Control: no-store`. Poll both at most once per minute. After
bearer authentication, both endpoints and all API replicas share one global
six-request-per-minute quota; source addresses and forwarded headers do not
create additional buckets.

The warning monitor trips when eligible webhook, reconciliation, pending
revocation, orphan revocation, or unresolved token-refresh inventory reaches
five minutes, or when an overdue CDC cursor reaches ten minutes. The critical
monitor trips at fifteen minutes for that general inventory or twenty minutes
for overdue CDC. Worker-capacity loss warns immediately. A required fleet that
is absent, `STOPPING`-only, terminal-only, overflowed, or release-mismatched is
critical immediately; a last `STARTING`/`RUNNING` database observation that
merely becomes stale is critical once it is three minutes old. Dead letters,
dead revocations, reauthorization-required token failures, and terminal CDC
recovery are also immediately critical. OAuth-only mode deliberately does not require a
worker heartbeat; reconciliation and CDC phases do. A warning response also
remains unhealthy for every critical condition.

The worker writes one JSON object per log line and persists its latest bounded
metrics in `WorkerHeartbeat.metrics`. The authenticated superuser control-plane
summary also exposes tenant-aggregated, content-free current inventory for:

- outstanding and dead webhook events plus oldest outstanding age;
- reconciliation-required operations plus oldest age;
- CDC cursor, terminal, overdue, and maximum-lag counts;
- pending and terminal-dead connection revocations plus oldest pending age;
- pending and dead orphan token revocations plus oldest pending age; and
- unresolved token-refresh failures, reauthorization-required connections, and
  the oldest unresolved refresh-failure age.

OAuth callback and token-refresh terminal logs use closed, content-free fields
(`eventCode`, stage, and outcome). Alert routing may key on those fixed codes,
but must not copy callback queries, provider error prose, tenant or realm
identifiers, company/customer data, tokens, or hosted invoice links into an
incident destination.

An optional QBO-only HTTPS sink can send those terminal and worker-health signals to a dedicated
Better Stack-compatible log source. Configure
`QUICKBOOKS_API_SIGNAL_INGEST_URL` with
`QUICKBOOKS_API_SIGNAL_SOURCE_TOKEN` on the API, and the separate
`QUICKBOOKS_WORKER_SIGNAL_INGEST_URL` with
`QUICKBOOKS_WORKER_SIGNAL_SOURCE_TOKEN` on the reconciliation worker. Never
place either token in a `VITE_` variable or give either runtime the other
runtime's token. `QUICKBOOKS_SIGNAL_INGEST_TIMEOUT_MS` defaults to 1250 ms and
is bounded to 250–3000 ms. Terminal events contain only the fixed schema,
message, runtime role, severity, event code, outcome, and exactly one closed
stage field. Provider-health events add only five-minute rolling actual Intuit
HTTP-attempt, failure, throttle, timeout, slow (at least eight seconds),
degraded-union, and maximum-duration counts. Every retry is a separate attempt;
database-only work and webhook work that needs no Intuit request add zero. A
`2xx` transport followed by invalid provider JSON remains a transport success;
the durable backlog, failure, and dead-letter monitors cover that semantic
failure. The closed sink retains the legacy `providerWorkflowCount` field name
for compatibility, but that value now counts outbound HTTP attempts, not whole
workflows. Retention alerts contain only a fixed transition or reminder code and
outcome. Raw failure codes, error names, identifiers, hashes, URLs, provider
text, and generic errors are rejected from the external schema.
The sink does not forward Pino globally and cannot change OAuth, worker, or
accounting outcomes. Delivery, queue, and schema failures produce only a fixed
content-free local failure signal; shutdown waits at most three seconds for
already-started deliveries.

Every `STARTING`, `RUNNING`, and `STOPPING` worker heartbeat carries the closed
`quotefly.quickbooks-worker-operational/v1` object. It records the worker's
`sandbox` or `production` environment, the rolling five-minute provider window,
and retention startup time, last successful pass, unresolved-failure state, and
consecutive failed-pass count. The provider tier warns on any throttle, timeout,
or call lasting at least eight seconds. It is critical for three combined
throttles/timeouts in five minutes or when at least 25 percent of ten or more
calls are failed or slow, counting a failed-and-slow call once. Provider
summaries/transitions are emitted at most once per minute. A current retention
failure is critical; before the first pass, missing success warns after five
minutes and is critical after fifteen, while established cadence warns after 75
minutes and is critical after 90. Retention transitions are minute-limited and
unhealthy reminders are emitted no more often than every fifteen minutes.
The API reads fresh fleet topology and heartbeat metrics in one repeatable
database snapshot. It sums provider-window counters across every fresh live
instance, takes the fleet maximum duration, and evaluates provider thresholds
once; retention and environment health remain conservative worst-instance
checks. Terminal instances are excluded from the active five-minute window.

Before enabling autonomous reconciliation, run the presence-only audits in the
correct configured process environments:

```bash
npm run infra:variables:audit -- --profile quickbooks-signals-api
npm run infra:variables:audit -- --profile quickbooks-signals-worker
```

The API signal profile also requires presence of the independent
`QUICKBOOKS_MONITOR_BEARER`; it never prints that bearer or either source token.

Then send one safe invalid-state OAuth callback to the API source and induce one
bounded worker token-refresh test condition using only the disposable sandbox.
Record the source names, fixed event codes, UTC receipt/acknowledgment times, and
successful alert delivery. Do not record source tokens, ingest URLs, request
queries, identifiers, provider prose, or payload screenshots containing
secrets. A local delivery-failure log proves fail-open accounting behavior, not
external alert delivery.

### Warning, critical, and recovery canary

Run this canary only in isolated staging against the disposable QuickBooks
sandbox. Do not create, change, or delete an accounting record. Route the worker
through an approved non-mutating provider test stub or controlled egress fault
that returns only synthetic status/delay behavior; never flood Intuit to induce
rate limiting.

1. Record the exact candidate SHA, staging environment, named alert destination,
   and UTC start time. Confirm both machine monitor endpoints return empty `204`
   and the worker/API environment comparison passes.
2. Warning: inject one synthetic `429`, timeout, or at-least-eight-second result
   for a non-mutating provider read. Within the next minute, require the fixed
   `QUICKBOOKS_PROVIDER_HEALTH_WARNING` event and the warning destination. Record
   only the fixed event code and UTC receipt/acknowledgment times.
3. Critical: within one five-minute window inject three combined synthetic
   `429`/timeout results, or degrade at least three of ten non-mutating reads.
   Require `QUICKBOOKS_PROVIDER_HEALTH_CRITICAL`, the critical destination, and
   an empty `503` from the applicable critical monitor.
4. Recovery: remove the fault, allow the final degraded observation to age out
   of the five-minute window, and wait no more than one additional emission
   minute. Require `QUICKBOOKS_PROVIDER_HEALTH_RECOVERED` and both monitors back
   to empty `204` after all other inventory is healthy.
5. Retention: use the staging test harness to make one retention invocation fail
   before data deletion begins. Require the fixed
   `QUICKBOOKS_RETENTION_HEALTH_CRITICAL` transition, then restore the harness
   and run a successful no-op retention pass. After the one-minute transition
   bound, require `QUICKBOOKS_RETENTION_HEALTH_RECOVERED`. Do not weaken the
   database role or alter production retention schedules for this canary.
6. Remove the stub/fault, rerun both presence-only signal audits, and retain the
   content-free alert acknowledgments with the staging evidence. Never retain
   bearer/source tokens, ingest URLs, raw requests, identifiers, or screenshots
   of secret-bearing configuration.

Reference: [Better Stack HTTP log ingestion](https://betterstack.com/docs/logs/ingesting-data/http/logs/).

These repository controls provide machine-readable signals; they do not create
an external dashboard, page an owner, or prove alert delivery. A named alert
destination, thresholds, runbook links, and a successful staging test page are
still mandatory before enabling provider workflows.

## Staged sandbox sequence

1. Pass the exact candidate's database-backed launch gate and independent reviews.
2. Deploy checked-in migrations to an isolated staging database through the migration job.
3. Start the API from the same SHA with the `quickbooks-reconciliation` posture; keep CDC and hosted payments off.
4. Confirm API liveness and database-backed readiness before starting the worker.
5. Start the worker from that same SHA, then require a fresh heartbeat, API/worker release parity, and successful alert delivery.
6. Deploy or route the web app to that ready API only after the worker gate passes.
7. Connect the dedicated sandbox company, confirm setup, review customer/item mappings, and publish one non-taxable USD test invoice.
8. Prove signed CloudEvents delivery is persisted before `2xx`, processed once, and visible in the canonical invoice state.
9. Move to `quickbooks-cdc` only for the authorized dropped-webhook recovery test; restart the API, confirm readiness, then restart the same-SHA worker and confirm its heartbeat before continuing.
10. Move to `quickbooks-hosted-payments` only after sandbox eligibility, reviewed payment choices, webhook processing, and reconciliation evidence pass; repeat API readiness and worker parity checks before exposing the phase in the web app.
11. Turn the provider features back off after the bounded test unless a separate pilot approval says otherwise.

Use [QuickBooks Online sandbox setup](quickbooks-sandbox-setup.md) and [QuickBooks owner testing checklist](quickbooks-owner-testing-checklist.md) for the complete test record.

## Emergency stop and recovery

1. Scale the worker to zero first.
2. Disable reconciliation and CDC flags, then provider workflows, on both API and worker configurations as the incident requires.
3. Do not leave an `ON_FAILURE` worker running with required flags false; it intentionally exits nonzero and will enter restart churn.
4. Preserve webhook inbox, operations, invoice/payment ledger, CDC cursor, revocation, and audit records. Do not delete uncertain state or blindly repeat provider mutations.
5. Revoke or rotate provider credentials through the documented procedure when compromise or realm confusion is suspected.
6. Reconcile every uncertain invoice against QuickBooks before re-enable.
7. Prefer a forward fix across the QuickBooks forced-RLS/migration boundary.

Re-enable only after heartbeat, backlog, dead-letter inventory, provider reachability, realm binding, runtime RLS, alert delivery, and the original incident condition are verified.
