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

The API and worker must run the same checked-in migrations and exact candidate SHA. Git-based Railway and Render deployments use the provider-injected commit SHA automatically; non-Git/image deployments must set the same full 40-character `QUOTEFLY_RELEASE_SHA` on both processes. The worker includes this non-secret identity in `WorkerHeartbeat.metrics`, and the authenticated QuickBooks status response reports API/worker identity and match state. When the API has a release identity, a missing or mismatched worker identity makes reconciliation readiness fail closed. The worker has no HTTP server; process supervision is liveness, while its content-free structured heartbeat is the operational readiness signal.

`WorkerHeartbeat` remains the compatibility singleton written by every worker version. A database trigger mirrors each write into `WorkerHeartbeatInstance`, keyed by worker and a one-way process reference hash, so an overlapping old worker cannot be hidden by whichever process wrote the singleton last. The mirror records `observedAtUtc` with PostgreSQL `clock_timestamp()`; worker-supplied future timestamps therefore cannot extend readiness. PostgreSQL reduces the fleet to fixed-shape counts, release identity, and at most one representative metrics object before returning it to the API. Fleet readiness requires at least one fresh `STARTING` or `RUNNING` instance, fails closed above the fixed ceiling of 100 fresh live instances, and requires every fresh `STARTING`, `RUNNING`, or `STOPPING` instance to report the API's exact release SHA. `STOPPING` by itself is not capacity. Fresh mismatch or missing identity fails closed until that instance stops or its database observation ages out. Tenant-manager status exposes only status, readiness, the database-observed heartbeat time, and a release-match boolean. Detailed aggregate counts, exact release SHAs, and representative content-free metrics remain in the audited superuser control plane; process reference hashes are never selected or serialized.

The hourly retention pass invokes a database-owned cleanup with no caller-controlled arguments. It deletes at most 100 per-instance heartbeat rows whose database observation is older than 30 days per invocation. The runtime role has `SELECT` on the mirror and `EXECUTE` on that fixed cleanup only; direct mirror insert, update, delete, truncate, and trigger-function execution remain denied. Runtime writes to the legacy singleton continue to invoke the security-definer mirror during rolling deployment.

## Required monitoring

Send alerts to a named destination and owner for:

- no `QuickBooks reconciliation worker heartbeat` for more than three minutes;
- oldest eligible webhook or reconciliation work older than five minutes (warning) or fifteen minutes (critical);
- any dead-letter transition and a separate tenant-safe count of outstanding dead letters;
- repeated sanitized failure codes, provider timeouts, throttling, and restart loops;
- token refresh, orphan revocation, or `REVOCATION_PENDING` failures;
- CDC cursor lag or recovery failure after CDC is enabled;
- retention cadence failure;
- per-instance heartbeat retention failure or a sustained unexpected fleet-size increase;
- worker/API SHA or environment mismatch.

The heartbeat's `dead` value is a per-tick transition count, not an outstanding inventory. Do not use it as the only dead-letter alert. Metrics and logs must remain content-free: bounded counts, age, status, request/correlation IDs, latency, and sanitized failure codes only—never tokens, realm IDs, company/customer data, raw provider payloads, callback query strings, or hosted invoice links.

The worker writes one JSON object per log line and persists its latest bounded
metrics in `WorkerHeartbeat.metrics`. The authenticated superuser control-plane
summary also exposes tenant-aggregated, content-free current inventory for:

- outstanding and dead webhook events plus oldest outstanding age;
- reconciliation-required operations plus oldest age;
- CDC cursor, terminal, overdue, and maximum-lag counts;
- pending and terminal-dead connection revocations plus oldest pending age;
- pending and dead orphan token revocations plus oldest pending age.

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
