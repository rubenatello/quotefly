# QuickBooks operational monitor

This candidate adds a separate default-off process. It does not activate accounting workflows or send customer email. The sole recipient is the deployment-configured operations address. The owner identified rubenatello@gmail.com as the intended alert destination; provider configuration and actual delivery remain separate evidence.

## Deployment boundary

Use `railway.quickbooks-monitor.json` and `npm run start:quickbooks-monitor` for a separate staging service. Do not attach the API's shared environment group. The process imports neither dotenv nor the global API environment. Set only:

| Name | Purpose |
| --- | --- |
| `NODE_ENV` | `production` for hosted runtime role enforcement |
| `DATABASE_URL` | Least-privileged runtime connection for this environment |
| `RESEND_API_KEY` | This environment's sending credential |
| `PASSWORD_RESET_EMAIL_FROM` | Existing verified transactional sender |
| `QUICKBOOKS_ALERT_EMAIL` | Fixed operational recipient |
| `QUICKBOOKS_MONITOR_ENVIRONMENT_LABEL` | `staging` or `production` |
| `QUICKBOOKS_MONITOR_ENABLED` | Explicit `true`; source default is false |
| `QUICKBOOKS_MONITOR_EXPECT_RECONCILIATION` | Explicit expected worker state |
| `QUICKBOOKS_MONITOR_EXPECT_CDC` | Explicit expected recovery state; requires expected reconciliation |

The monitor rejects migration credentials, JWT, provider credentials, token keys, Redis credentials, and other secret/token/password-like environment entries. It needs no QuickBooks client secret, access token, encryption key, webhook verifier, or API access. Use `npm run infra:variables:audit -- --profile quickbooks-monitor` for presence-only evidence in the monitor process. Never print host environment values.

Apply the additive `20260920120000_quickbooks_operational_monitor` migration using the isolated migration job before starting the process. Two global tables store fixed codes, bounded counts/ages, incident transitions, hashes, and delivery leases. They hold no tenant/customer/invoice identifiers, provider payloads, recipient address, token values, or arbitrary error text. They deliberately have no tenant RLS because they contain platform aggregates; runtime grants are SELECT/INSERT/UPDATE, with no DELETE. Existing tenant metric reads continue through forced RLS, one tenant transaction at a time. Rollback stops this service; leave the additive tables intact for later review. Do not delete delivery history as a rollback step.

## Sampling and thresholds

Every 60 seconds, scan all active tenants using 100-record keyset pages and concurrency four. Pages are reduced into bounded-memory aggregate counts and maximum ages. A scan failure never becomes a healthy sample. Tenant-null unknown-realm quarantine events are excluded from this tenant-bound operational aggregate; quarantine investigation/retention remains a separate operational responsibility. This is a live scan rather than a database snapshot; changes during pagination are observed on a following cycle. The private control plane reuses the same tenant metric extraction.

| Signal | Rule |
| --- | --- |
| Expected reconciliation heartbeat missing, not RUNNING, or older than 180 seconds | Immediate critical |
| Outstanding webhook, required reconciliation, token refresh/reauthorization problem, pending credential revocation | Warning after age exceeds 5 minutes; critical after age exceeds 15 minutes |
| Dead webhook, terminal CDC, dead connection/orphan revocation | Immediate critical |
| CDC recovery age | Same 5/15-minute thresholds after subtracting the intentional two-minute cursor overlap; only when CDC is expected. The private control plane retains its original raw lag metric. |

Token failures also retain a durable first-observed condition time; repeated refresh attempts updating the connection timestamp cannot postpone alerts. Two absent/healthy observations clear that condition time.

Warnings need two observations separated by at least 30 seconds. Recovery needs two healthy observations. Critical conditions open immediately. Concurrent evaluators serialize state/outbox transitions using a database advisory transaction lock; identical or older samples cannot advance the streak. One OPEN/ESCALATE/RECOVER is queued per incident, with a reminder no more often than every 24 hours while failing. Severity stays critical for that incident until full recovery, preventing repeated escalation after a transient healthy sample.

## Delivery and recovery

A short transaction claims a delivery using FOR UPDATE SKIP LOCKED and a 30-second lease. The 8-second Resend request runs outside the transaction. Each claim can mark up to 16 exhausted queue heads terminal while looking for a later eligible delivery, so a single expired head does not delay the next alert. If that bounded cleanup limit is reached, scanning resumes on the following monitor cycle. Failed/ambiguous delivery retries the original timestamp, numeric snapshot, recipient configuration, and deterministic idempotency key. Retry delays are bounded exponential backoff (1 minute to 1 hour), at most 12 attempts, and never beyond 23 hours after the first attempt. Resend retains idempotency keys for 24 hours; its request payload must remain identical. See [Resend's official idempotency contract](https://resend.com/docs/dashboard/emails/idempotency-keys).

If the configured recipient/sender/environment changes, payload validation fails, the attempt limit is exhausted, or the safe retry window expires, the row becomes TERMINAL. Exceptions and provider bodies are discarded; only fixed failure codes persist. Do not reset TERMINAL records or blindly resend an old key after the provider retention window. Confirm provider delivery and correct configuration first; a still-active incident produces its next distinct daily reminder. A reminder is explicitly a new notification, not an assertion that an earlier ambiguous notification failed.

The monitor writes its own `quickbooks-operational-monitor` heartbeat and bounded terminal-delivery count. Its own outage, database outage, or inability to reach Resend needs an independent platform/monitoring alert. A running process or green GitHub build does not prove monitor health or delivery. Configure and verify the external destination before production acceptance. No such external platform alert has been established by this local implementation.

## Required isolated staging evidence

1. Confirm migration success, runtime role, both monitor table permissions, narrow presence audit, verified sender, and fixed recipient without displaying secret values.
2. Start the monitor against the isolated staging database with the actual expected worker flags.
3. Stop only the isolated QuickBooks reconciliation worker for more than three minutes. Confirm one WORKER_HEARTBEAT OPEN delivery reaches the intended inbox and one durable SENT record exists.
4. Restart that worker. After two healthy monitor observations, confirm one RECOVER email and SENT record. Observe at least ten further minutes without duplicate OPEN/RECOVER notifications.
5. Verify a sandbox dead-letter or other synthetic failure creates the expected bounded alert; verify retry/lease recovery without introducing real customer records.
6. Stop the monitor itself and prove the independent platform alert reaches its owner. Validate database/provider outage handling and restore the service.
7. Record sanitized times, codes, counts, provider message receipt, migration and rollback evidence. Local tests and an accepted Resend request alone do not prove inbox receipt or production readiness.

No real email, provider workflow enablement, deployment, or hosted migration is performed by local tests. Test data uses a dedicated database whose name includes `test` and injected email delivery.

## Local implementation evidence (September 13, 2026)

- Isolated branch `feature/quickbooks-operational-monitor`, based on `9545836`; no root working-tree changes or hosted mutations.
- Own root/web dependency installations, generated Prisma client, and PostgreSQL `quotefly_monitor_test` on the local task container. All 86 migrations applied locally; after adding the durable condition timestamp, its additive column change was applied locally and the final complete monitor migration was executed successfully in a new transaction-local probe schema and rolled back.
- `npm run verify`: passed, including backend/web builds, lint, schema, security, complete unit/eval gates, and both dependency audits.
- Initial focused database suite: 16 passed (9 monitor and 7 private control-plane cases); the remediated monitor suite below supersedes its 9 monitor cases. Coverage includes concurrent state transitions, warnings/recovery/reminders, token failure aging, lease expiry, stable resend identity, retry-window termination, changed-recipient quarantine, no runtime DELETE, and a 205-tenant forced-RLS scan.
- Initial direct monitor and governance unit run: 10 passed, superseded by 11 after review. Presence-only profile probes accepted the narrow synthetic profile and rejected inherited JWT and disabled-monitor profiles.
- No actual email, QuickBooks provider request, sandbox record, deployment, hosted migration, or platform alert test occurred in these tests. Consumer-release evidence remains incomplete until the staging and independent-outage checks above pass.


## Independent review remediation

Opera identified that raw CDC cursor age includes the intentional two-minute replay overlap. Monitor classification now subtracts that overlap while retaining the private control plane's existing raw metric contract. A deterministic time-series test samples 30 seconds out of phase with normal five-minute polls, proves no OPEN notifications during healthy cycles, and then proves warning, escalation, and recovery for a stalled cursor.

Monitor environment validation now rejects public/private and other common database credential URL aliases while allowing nonsecret Railway metadata. Delivery claiming skips up to 16 exhausted queue heads per transaction; a test proves a later reminder sends during the same cycle. Tenant-null quarantine exclusion is documented above. These changes do not alter QuickBooks accounting or CDC provider behavior.

After remediation, the backend build passed, all 11 focused monitor database cases passed, and all 11 direct monitor/governance unit cases passed. The full `npm run verify` evidence above precedes these review fixes; the combined release candidate must receive its required full gate after integration.

Opera approved the remediated source for merge and isolated staging evidence. The 18-file source manifest before integration was `983d06f32d9e726d693b0c61ceccd85d9e75ec5a249c9a6045aff49da14f0133` (sorted paths, lowercase raw-byte SHA-256 plus two spaces and path, LF-separated, no terminal newline). Root verified this exact digest before copying the files. The monitor's 120-second overlap constant must remain synchronized with `quickbooks-cdc.ts`; cadence changes require rerunning the healthy-cadence alert regression.
