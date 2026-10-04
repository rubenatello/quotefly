# Ordered production release

Production deployment requires independent Opera approval of the exact candidate, passing required gates, and completed provider/recovery evidence. The owner's standing authorization applies when those conditions hold. Isolated staging has separate authorization; its success is evidence for a later production decision.

## Trigger and credential boundaries

Before merging a release into `main`, confirm GitHub autodeploy is disabled on the production API, migration service, and every worker connected to that branch. Concurrent autodeploy of migration and API services does not enforce migration ordering. Leave it disabled until this sequence or a separately reviewed ordered workflow controls releases.

Use `/railway.migrations.json` only on the isolated migration service. It runs once with `DIRECT_DATABASE_URL`, no HTTP healthcheck, and restart policy NEVER. API and worker services must have no migration-owner credential; they use the pooled, least-privileged `quotefly_runtime` role. A pre-deploy command on the API service inherits its variables and does not provide this credential separation.

## Exact candidate sequence

1. Record the full approved SHA, successful exact-SHA CI/launch gate, current production image identities, schema baseline, backup recovery point, and explicit target project/environment/service IDs. Check the actual Node/npm versions against tested versions. Do not infer production approval from an earlier staging verdict.
2. Create one clean LF-normalized `git archive` from that SHA. Verify every tracked file against the Git blobs, exclude secrets, and record an artifact digest. Use this same source artifact for migration, API, and workers. Frontend output must identify the same source SHA. A source archive digest is not a claim of reproducible binary output.
3. Confirm provider write flags are off and workers are quiesced under the reviewed cutover plan. Record only fixed flags, presence checks, IDs, and timing; do not retrieve environment values. Preserve uncertain accounting operations.
4. Upload the artifact to the isolated migration service. Wait for terminal SUCCESS and separately verify ordered migration names/checksums and completion. A successful build or queued deployment is insufficient. Stop on failure.
5. Verify the target database baseline, forced tenant RLS, runtime grants, and absence of owner/BYPASSRLS access. Upload the identical artifact to the API service. Require successful deployment, deployed-source proof, `/v1/health`, `/v1/ready`, and session/core workflow smoke checks.
6. Deploy workers and monitor from the same SHA with provider workflows still disabled. Verify dedicated start commands, expected flags, fresh heartbeats, and alert delivery. Deploy the matching web artifact and confirm its API origin and restored session.
7. Perform the reviewed production pilot and only enable capabilities whose provider, security, operational, and recovery evidence passed. Public availability and tax/payment claims must match the pilot's verified scope.

Use existing authenticated deployment CLIs and secret-manager references. This runbook is sequencing guidance, not an attestation that its steps have run. Record live deployment IDs, source proofs, gate results, and timestamps in the release evidence ledger.

## Failure and recovery

If migration fails, do not deploy the API. Preserve diagnostic evidence and use a reviewed additive forward fix. If the API fails after migration, restore an earlier image only after proving compatibility with the resulting schema. Forced-RLS and billing migrations can make older binaries unsafe. Do not reverse migrations as a routine rollback.

A database restore loses writes after its recovery point and cannot undo QuickBooks invoices or payments. Keep provider work paused and reconcile external state before enabling it again.

Rehearse restoration inside an isolated Neon branch without downloading customer rows or credentials. A child or point-in-time branch of synthetic staging can prove the procedure, role controls, forward migration, and recovery timing for that fixture. It does not prove production backup retention, production-volume lock behavior, or recovery time for real production data. Record those limitations explicitly and retain the production-like recovery gate until its evidence exists.
