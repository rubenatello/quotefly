# QuoteFly-owned QuickBooks monitoring

This addition implements a platform-superuser Integration Health panel and a small
standalone watchdog. It does not enable accounting, configure any provider, send
real email, purchase a service, or establish production readiness merely by existing.
The previously validated staging candidate is `6239f742f04b2815082c0fc7f108727a3e916258`;
this successor needs its own gates, review, and authorized deployment.

## Owner budget decision — September 8, 2026

The owner selected an operational email address outside `quotefly.us` and explicitly
declined any additional paid server or hosting. Keep that private address in the
notification configuration/evidence, not public source. The dedicated paid watchdog
host proposal is withdrawn. Do not purchase a host, activate a paid plan, or continue
asking for paid-host approval. The standalone implementation below is an optional
deployment mode, not an immutable requirement for QuickBooks integration.

The no-new-hosting alternative under qualification is the existing public
repository's standard GitHub Actions runner and GitHub-native incident notifications.
It is not configured or delivery-verified merely by being proposed:

- Before an attended accounting sandbox test, run a bounded, manually dispatched
  monitor for that environment, polling the API and both authenticated QBO warning/
  critical endpoints once per minute. Keep the owner present and stop accounting
  test actions if monitoring stops. Never use a healthy public API probe alone as
  evidence of QBO health.
- For a later production pilot, a five-minute scheduled probe can cover persisted
  operational conditions. The existing thirty-minute public-health workflow is not
  a complete QBO monitor and must not be represented as one.
- Use a dedicated environment-scoped monitor bearer, fixed API origins, no redirects,
  minimal workflow permissions, trusted reviewed code, and content-free incident/
  recovery notifications. Do not move application, QBO, or database credentials into
  GitHub. Keep incident state bounded and deduplicated; test escalation and recovery.
- Before adding a monitor secret, protect the production default branch and restrict
  its environment secret to that branch. Pin reviewed actions to full commit SHAs
  (or remove action dependencies), scope the bearer to the probe step, and reject
  untrusted/manual branch dispatches. A staging-only attended run needs its own
  approved protected-ref/environment boundary; do not expose production secrets.
- Identify automation incidents by a restricted label and expected bot identity,
  not title alone: ordinary users can open same-title issues in the public repository.
  Test that an untrusted same-title issue cannot suppress or resolve a real incident.
  Authenticate canonical issue state with a domain-separated HMAC under the dedicated
  monitor bearer; the shared Actions bot identity alone is not workflow provenance.
  Preserve a first-clean marker and require two consecutive completed clean probe
  cycles started at least 60 seconds apart within the same workflow run/attempt
  before recovery; any unhealthy cycle or new run resets it. Assign/mention the responder on
  trusted incident, escalation, recovery, and canary notifications.
- Verify that GitHub notifications actually reach the owner-selected verified email
  address, including a canary and failure/recovery receipt. An issue, mention, or
  successful workflow does not itself prove email delivery. If direct mail is needed,
  use a dedicated restricted sending key on the existing provider; never copy the
  application's email key into CI.
- GitHub schedules can be delayed/dropped and public schedules can disable after
  inactivity. There is no continuous signal receiver, durable mail outbox, guaranteed
  detection latency, or redundant responder in this alternative. A daily canary
  needs an explicitly assigned owner who notices its absence. Document and obtain
  acceptance of these limitations before relying on unattended production monitoring.
  Also obtain acceptance of sanitized public incident metadata and GitHub being both
  scheduler and notification provider. Record actual scheduling delay over a documented
  observation window during the controlled pilot; seven days is a recommended baseline
  before broad unattended rollout, not a gate to attended sandbox testing. Historical
  observations cannot guarantee future latency. Refusing paid hosting is not acceptance
  of these risks or of GitHub's lack of a detection-time SLA.

See [GitHub runner billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
[schedule limitations](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule),
and [email notification configuration](https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications).
No paid host is necessary to qualify this alternative, but implementation review,
secret provisioning, notification receipt, failure/recovery drills and independent
review remain required. It does not waive Intuit access, accounting/webhook/CDC proof,
backup/restore, or the final release decision. Until qualified, keep the unused
standalone watcher and external signal sink pairs unconfigured.

## GitHub attended implementation — not enabled by source changes

`scripts/quickbooks-github-monitor.mjs` and
`.github/workflows/quickbooks-attended-monitor.yml` implement the attended subset.
There is no schedule, installation, new hosting service, application mutation,
Intuit accounting call, or direct email-provider credential in this workflow. Production
scheduling remains separate, unimplemented work. Local fixtures do not establish
GitHub permissions, hosted execution, email routing, inbox delivery or QBO readiness.

Before its first authorized live dispatch:

1. Register the workflow on the repository's default branch through a separately
   reviewed, authorized change; GitHub requires its presence there before manual
   dispatch from another ref. Do not merge or deploy the entire QBO candidate merely
   to register a monitor. Review the exact candidate and protect the approved ref with required review and
   restricted writes. Configure separate `qbo-monitor-staging` and, only when ready,
   `qbo-monitor-production` GitHub environments restricted to their approved refs.
   Production only accepts `refs/heads/main`; staging cannot receive production secrets.
2. Set environment variable `QBO_MONITOR_APPROVED_REF` to its exact protected branch
   ref. Keep `QBO_MONITOR_ENABLED` absent/false until all setup and risk acceptance
   below is complete. These variables are nonsecret; they are not evidence of actual
   branch protection or owner approval by themselves.
3. Through safe secret editors, provision environment secret `QBO_MONITOR_BEARER`
   paired only with that API runtime's dedicated `QUICKBOOKS_MONITOR_BEARER`. Never
   copy application, database, Intuit, or Resend keys. The monitor bearer is exposed
   only to the attended probe/state-adapter step. The job-scoped GitHub token has
   contents-read/issues-write permissions; pinned checkout/setup actions share that
   job trust boundary, and checkout does not persist credentials. The dedicated bearer
   authenticates state with HMAC-SHA256 and a monitor-specific domain separator;
   no secret value is included in issue bodies, comments or logs.
4. A maintainer pre-creates the environment's `qbo-monitor-staging` or
   `qbo-monitor-production` label. Ordinary public users cannot apply that label.
   The monitor requires exact Actions bot ID/type, label, environment, canonical
   bounded schema and valid MAC; another workflow's unsigned bot issue is rejected.
5. Confirm the named repository owner receives assigned/mentioned issue notifications
   at the selected private mailbox. Obtain acceptance of sanitized public incident
   metadata and the shared GitHub scheduler/notification dependency. Set the enabled
   variable only for the qualified environment and dispatch from its approved ref.
6. With the owner present, use a five-minute canary run; record its exact SHA, UTC
   times, notification receipt, and attended warning/critical/recovery fixture proof.
   Stop accounting testing if the workflow stops or alert persistence fails. Do not
   inject faults into production. No sandbox or production enablement follows from
   a canary alone. Daily absence detection still requires a named human responder.

Dispatch accepts only `staging` or `production`, canonical integer duration 1–240,
and a boolean canary request. It samples immediately and then at least 60 seconds
apart without overlapping or retrying QBO requests. Four bounded requests check
liveness, database readiness, and both authenticated QBO tiers. Unexpected responses,
nonempty QBO bodies, redirects, auth/quota failure or timeout become critical, never
healthy. The workflow is serialized per environment and bounded to 245 minutes.
Healthy public probes alone do not prove accounting health.

One authenticated state issue is reused per environment, open for an incident and
closed only after recovery notification is confirmed. Once observed in a run, its
issue number is pinned; disappearance, unlabeling or replacement stops the run instead
of silently starting healthy. Cross-run deletion still requires human reconciliation.
Warning/critical transitions
notify the owner; continuing incidents remind at most hourly. Requested canaries are
deduplicated for 24 hours. Recovery needs adjacent complete clean cycles in the same
run/attempt, at least 60 and at most 180 seconds apart on a monotonic clock. A new or
retried workflow cannot reuse an aborted run's first-clean observation. A one-cycle
run cannot recover an existing incident. Recovered attended runs can exit successfully;
an unresolved incident or monitor/state/notification failure exits nonzero.

Notification UUID and fixed content are committed in signed pending state before
posting a comment. An ambiguous response fails the run; the next run first reconciles
exact bot-authored content and UUID before resending or clearing pending. Recovery
does not close before that confirmation. Conflicting bot comments, malformed/MAC-invalid
state, duplicate trusted issues, locked issues, bounded pagination overflow or excessive
comment churn fail closed. Public comments never supply health state. This is bounded
GitHub notification reconciliation, not a durable email outbox or inbox receipt proof.

Maintain issue/label permissions and preserve the state issue. After bearer rotation,
old MACs intentionally fail; stop the monitor and reconcile pending notifications
before an explicitly approved state reinitialization. Never automatically overwrite
untrusted state. A GitHub outage, disabled/aborted workflow, deleted state issue or
lost notification can still require manual response; no guaranteed detection SLA is
claimed. Rollback is to stop dispatching and disable the selected environment variable,
preserving its issue and pending notifications. Do not change accounting flags or
webhook verification as a monitoring workaround.

## What lives where

- QuoteFly platform admin: manual, audited, read-only health snapshot; no tenant,
  company, token, provider payload, raw worker metrics, or release identifier output.
  Ordinary tenant admins cannot access the fleet report. Uses the same evaluator as
  the existing warning/critical machine probes, including billing-paused queue rules.
- Standalone watchdog: two authenticated machine probes each minute, closed API and
  worker signal receivers, bounded durable email outbox, daily delivery canary.
  It imports no QuoteFly database, env loader, app server, or external runtime package.
- Independent email provider: Resend sending-access key, one owner-selected recipient,
  one verified-domain sender. This is a separately operated dependency, not a claim
  that alerting can function with no infrastructure costs or maintenance.

No Better Stack subscription is required by this implementation. Hosting and email
quotas/costs depend on the owner-selected accounts. Do not provision a paid host or
activate a plan without owner approval.

## Standalone deployment gates — not completed by local tests

These host/volume/receiver requirements apply if the standalone mode is selected.
They do not mandate buying a server for the no-new-hosting alternative above.

1. Owner selects a host outside the API/database failure domain. Another service
   in the same Railway project/provider does **not** establish provider-outage
   independence. Record provider, region, TLS endpoint, volume, restart policy,
   access restrictions, retention/backup policy, named alert responder plus backup
   escalation, and costs. Use a monitored destination independent of QuoteFly's
   DNS/mail failure domain, not solely a `quotefly.us` mailbox.
2. Run one replica only, including deployments: stop old before starting new;
   no rolling overlap. The two probes share a six-request/minute API quota with
   any other monitoring. Remove duplicate pollers or explicitly budget them.
3. Use HTTPS at the edge; disable body/header/query capture and access logs that
   could retain Authorization. Configure edge flood protection and deny public
   access to the cleartext origin. Builtin socket/header/body limits are not DDoS
   protection. Normal health checks must not depend on email availability.
4. Provision four distinct random secrets (32+ characters, no whitespace) using
   host secret editors: monitor bearer, API source token, worker source token, and
   dedicated Resend sending-access/domain-scoped key. Do not reuse QuoteFly JWT,
   QBO, application-email, encryption, or webhook keys. Never retrieve or record
   existing raw values; use presence-only verification. Receiver's 32-character
   minimum is stronger than the existing emitter's 16-character minimum.
5. Set the nonsecret environment/sender/recipient/durable directory below. Restrict
   the state directory to the service UID (0700 POSIX; owner-only ACL on Windows).
   Parent directories and mounted volume must be trusted, not attacker-writable.
6. Run staging canaries with the owner, verify inbox receipt and recovery, and
   record timestamps/results without tokens or payloads. Provider acceptance alone
   does not prove delivery. Do not set any claim of `deliveryVerified` from a 2xx.
7. Obtain successor specialist/Opera approval and explicit deployment authority.
   QBO accounting/webhook/payment/CDC proof and Intuit production approval remain
   separate gates. OAuth connect/disconnect is not proof of full accounting sync.

## Standalone configuration (names only)

Safe first-rollout order: provision the watchdog HTTPS URL, private volume, and
secrets while the service is stopped; configure API monitor bearer and API sink pair
through host editors; deploy and verify the reviewed API; start one watchdog; then
prove canary, receipt, and recovery with the owner. Configure/start worker emission
only in a separately authorized accounting stage. Do not start a half-configured
watchdog against an API that lacks its monitor bearer and generate false incidents.

| Watchdog setting | Meaning / source |
| --- | --- |
| `WATCHDOG_ENVIRONMENT` | `staging` or `production`; selects a fixed QuoteFly API origin |
| `WATCHDOG_MONITOR_BEARER` | Same dedicated value as API `QUICKBOOKS_MONITOR_BEARER` |
| `WATCHDOG_API_SOURCE_TOKEN` | Same dedicated value as API `QUICKBOOKS_API_SIGNAL_SOURCE_TOKEN` |
| `WATCHDOG_WORKER_SOURCE_TOKEN` | Same dedicated value as worker `QUICKBOOKS_WORKER_SIGNAL_SOURCE_TOKEN` |
| `WATCHDOG_RESEND_API_KEY` | Dedicated sending-only/domain-scoped Resend key |
| `WATCHDOG_EMAIL_FROM` | Single bare email address on verified sending domain |
| `WATCHDOG_EMAIL_TO` | Single bare email address of the named alert responder |
| `WATCHDOG_STATE_DIRECTORY` | Existing absolute private durable directory, container default `/state` |
| `PORT` | 1024–65535; default 8080 |

Set API `QUICKBOOKS_API_SIGNAL_INGEST_URL` to the watchdog HTTPS origin plus
`/signals/api`. Set worker `QUICKBOOKS_WORKER_SIGNAL_INGEST_URL` to the same origin
plus `/signals/worker`. Never place the worker source token on the API or vice versa.
Watchdog owns both receiver credentials but never receives the QBO client secret,
OAuth credentials, JWT, webhook verifier, or database URLs. Worker provisioning does
not authorize enabling worker execution or accounting workflows.

## Standalone build and operation

From the repository root, after local tests and review:

```text
docker build --platform linux/amd64 -f ops/quickbooks-watchdog/Dockerfile -t quotefly-qbo-watchdog:local-proof .
node scripts/quickbooks-watchdog-container-test.mjs quotefly-qbo-watchdog:local-proof
```

The tag above is a local build name, not a production deployment reference. CI builds
and tests the exact Git candidate, labels its SHA, and records its image ID. After
authorized publication, record the registry digest and deploy that immutable digest
bound to the reviewed SHA. A mutable tag alone is not release identity evidence.
The reviewed runtime/dispositions cover Linux amd64; other architectures require
their own exact-image scan and applicability review before deployment.
The Dockerfile-specific deny-by-default context excludes local credentials and all
unneeded workspace files. Base image is digest-pinned; rebuild and review it when a
security update is released. The reviewed runtime is Node 22.23.2; do not use the
superseded Node 22.22.0 image, which predates a Node security release. Global npm,
npx, Corepack, Yarn, and their unused module payload are removed from the runtime.
All inherited setuid/setgid bits are removed because
this service needs only `flock`, never privileged utilities. Require dropped Linux
capabilities, `no-new-privileges`, and a read-only root filesystem with only `/state`
writable on the selected host. The network-isolated container proof exercises these
controls and checks the absence of privileged file modes and runtime node_modules.

CI also downloads checksum-pinned Trivy 0.74.0, saves the exact local image to an
archive, and scans OS and library packages without uploading the image or mounting
the Docker socket. The full report is retained during the job and its SHA-256 is
printed with the archive identity. The checked-in policy rejects stale/malformed
evidence (database older than 36 hours or report older than one hour), missing OS
inventory, and every fixable Critical/High finding. Unfixed findings remain visible
and must match a current exact-CVE/package/version entry in the
[Sentinel disposition record](../security/quickbooks-watchdog-image-dispositions.json).
New, missing, expired, or code-scope-mismatched dispositions fail the gate. The
review is bound to platform, pinned base, and normalized source hashes rather than
an impossible pre-commit image identity: CI labels and creation timestamps change
the image config digest. A zero-fixable result is not a claim of zero vulnerabilities.
No ignore file suppresses findings. Trivy reports the
image configuration digest, which may differ from Docker's OCI manifest digest;
record the archive's config/manifest binding rather than equating the two hashes.
Trivy does not reliably inventory the bundled Node binary: separately check the
runtime against [official Node security releases](https://nodejs.org/en/blog/release/v22.23.0)
and [the supported Node 22 archive](https://nodejs.org/en/download/archive/v22).
Confirm patched runtime versions for the API/worker hosts too before rollout;
rebuilding this standalone image does not update those services.

The final image runs as `node`, has no node_modules and copies only the standalone
compiled graph plus Debian util-linux for its crash-released kernel `flock`. Mount an independently durable `/state` volume with correct UID and
0700 permissions. The service refuses a missing/unwritable/nonprivate directory,
corrupt/oversized state, changed environment/sender/recipient, or a competing process lock.
The volume filesystem must honor `flock`; separate per-replica volumes do not coordinate.
Use the host's secret editor; do not use secret-bearing shell arguments or env dumps.

- `GET /health`: empty 204 liveness, not a claim about the API or alert delivery.
- `GET /ready`: empty 204 only with fresh poll completion, no stale queued delivery,
  healthy storage, and recent email-provider acceptance. Otherwise empty 503.
  This is watchdog readiness, not QBO health. Use liveness for process restarts;
  route readiness failures to an independently operated check/owner inspection.
- `POST /signals/api` and `/signals/worker`: exact role-specific bearer and JSON;
  empty 204 only after normalized signal handling is durably committed. Unknown
  keys/roles/schemas/content types/queries are rejected. Input <=8 KiB; bounded
  authenticated request and active-body budgets. No raw request/error logging.
- SIGTERM/SIGINT: stop accepting and finish the bounded in-flight cycle. Allow at
  least 30 seconds graceful shutdown. Linux kernel releases the process lock on
  exit or SIGKILL; `process.lock` stays on disk and must not be deleted. Always run
  the normal image entrypoint, never the internal `--lock-held` child invocation.
  Direct non-Linux development uses an exclusive file lock with manual crash recovery;
  that fallback is not the production deployment mode.

## Standalone alert semantics and limitations

The authoritative fleet incident is critical for unavailable/unauthorized/rate-limited,
nonempty/malformed probe responses or critical 503; warning for warning 503 with
critical 204. Both must return empty 204 twice consecutively to resolve. Polls do not
retry within a cycle. Existing API evaluator owns all accounting/worker thresholds.

Terminal OAuth/token warnings/errors produce fixed-code notifications, not per-company
incidents. Success for one company cannot clear another company's failure. Pushed
worker recovery/summary events likewise cannot clear fleet health; only authoritative
probes do. Duplicate terminal codes are suppressed for one hour. These bearer-authenticated
internal signals have no event nonce: captured credentials permit replay/spam, so rotate
on suspected exposure. Info signals are accepted but not retained or emailed.

State holds only version/destination binding digest, severity, timestamps, fixed
event codes, random notification IDs, and bounded outbox/reminder data. No customer
data, message bodies, tokens, or email addresses are stored. Up to 128 queued emails,
one send attempt/minute; exponential backoff up to 30 minutes plus jitter on failure.
Retry counter resets on restart, but persisted notification ID/body remains stable.
Messages stop retrying at 23 hours and remain queued for operator recovery; no silent
drop. After five minutes of queued delivery, readiness fails. A severe notification
can be delayed behind older mail; email-only service is not a guaranteed paging SLA.

Email retries use stable idempotency keys and identical bodies. Resend retains keys
for 24 hours; do not blindly resend an expired item or change sender/recipient while
retrying. See [Resend idempotency contract](https://resend.com/docs/dashboard/emails/idempotency-keys)
and [sending API](https://resend.com/docs/api-reference/emails/send-email).

The existing application emitter is intentionally best-effort with a bounded memory
queue: a lost connection/process failure can lose a transient signal. Polling covers
persisted operational conditions, not every past OAuth event. The watchdog does not
replace audit records, durable business queues, platform logs, backup testing, or an
independent monitor of its own host. Daily canary absence must be noticed by the named
responder; email-provider acceptance alone cannot detect bounces or inbox filtering.

## Standalone recovery and rollback

- Never reset state automatically. Production uses a crash-released OS lock; a
  second active process exits 73. Never delete `process.lock` while running because
  that would create a second inode and break mutual exclusion. For the non-Linux
  development fallback only, establish every old process stopped and the exact
  test volume before an operator removes only `watchdog.lock`.
- For corrupt storage/expired deliveries, stop the service, retain a protected copy
  of the closed-schema state, reconcile delivery with the owner/provider, then approve
  a bounded repair or archive-and-fresh-start. Fresh state can repeat alerts; record
  the decision. This document does not authorize destructive state repair.
- For configuration/credential incidents, correct through host editors and verify
  presence only. Review signal sink failure codes in sanitized API/worker logs.
- Rollback: stop the new watcher, preserve its volume, return to the prior exact image
  if its state contract matches. Do not run two pollers. Revert admin/backend code
  independently; no database migration was added. Never disable QBO signature checks
  or enable accounting as a monitoring workaround.
- First release has no prior watchdog image. Rollback-to-absent-service means stop
  the watcher, preserve its volume, and remove only its API/worker signal sink URL
  and token pairs through host editors under explicit configuration authority.
  Record that external alerting is absent; do not change QBO signatures or accounting
  flags. Reintroduce the reviewed watcher with a fresh owner receipt test.

## Standalone required staged proof

Record exact candidate identity and UTC evidence for: unauthorized rejection and
cross-role rejection; authorized signal canary reaching inbox; controlled warning and
critical fixture alerts; two-clean-poll recovery; API outage while watchdog remains
available; mail outage and queued retry without duplicate; restart with retained
outbox; concurrent-start refusal and SIGKILL/restart lock recovery; daily canary receipt; owner acknowledgment.
Also prove protected watchdog-volume snapshot/restore on the selected host, or obtain
explicit owner acceptance of lost outbox/deduplication data and repeat-alert risk.
This does not satisfy the separate application database/Neon backup-restore gate.
CI proves the local image; it does not publish it. Deployment requires an authorized
exact-candidate build/publication with registry digest recorded before rollout.
Use isolated fixtures for fault injection, not production or accounting mutations.
The Integration Health panel intentionally reports delivery verification as unverified
until a separately designed evidence-backed receipt workflow exists.
