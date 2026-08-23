# Stripe billing integrity rollout

The item-period reconciliation is an explicit production release gate. Application startup, migrations, CI, and BCP never run it because it reads live Stripe state and can update tenant billing snapshots and content-free AI accounting totals.

## Required order

1. Back up PostgreSQL and prove the backup can be restored. Rehearse the migration against a recent production-like clone and record migration duration and lock behavior.
2. Run a read-only database preflight for duplicate non-null Stripe customer, subscription, and checkout-session IDs. Stop on any duplicate; the migration intentionally never chooses a tenant automatically.
3. Apply the checked-in additive migration. The old API may remain briefly: it ignores the new nullable Stripe period-start column, and the legacy AI-event trigger self-binds its immutable tenant under forced RLS. Do not start the new paid-AI code yet.
4. Pause Stripe webhook ingress, stop/drain every old API instance and AI index worker, and prove no old billing or AI process remains. Old webhook code can update the period end without its matching start, so no old binary may run during or after reconciliation.
5. Using the new release artifact against the migrated database and matching Stripe environment, run the full read-only preflight:

   ```bash
   npm run billing:reconcile-periods
   ```

   The command checks every `active` row (including orphan rows with a missing subscription or plan) and every Stripe-bound `trialing` row, not only rows with a missing start. Customer-only local trials with no Stripe subscription remain an explicit exception. It compares both subscription-item bounds, exact Stripe trial bounds when trialing, and authoritative period totals. Linked ledger events are attributed by their root reservation period even if settlement crosses renewal; only unlinked rolling-era events use `createdAt`. Dry-run exits nonzero for drift, unresolved provider bindings, or active target-period AI holds. Its JSON contains only internal tenant/subscription IDs, counts, exact bounded `needsUpdate` targets, and bounded unresolved reasons—never secrets or customer PII.
6. Review every entry in `needsUpdate` and `unresolved`, plus the configured price IDs. Then explicitly reconcile:

   ```bash
   npm run billing:reconcile-periods -- --apply
   ```

   Provider reads use four workers, a ten-second timeout, and two Stripe network retries. Each subscription must match the stored customer, subscription, status, plan price, and optional tenant metadata. Each tenant update and usage-period rebuild is one serializable transaction; trial reconciliation also writes the exact provider trial start/end. An active reservation already attributed to the target period makes only that candidate fail with `active_ai_reservation`; wait for the bounded hold to settle/reap, then rerun. Old-period requests do not delay renewal and remain attributed to their original period.
7. Run the dry-run again. A zero exit code, `needsUpdateCount: 0`, `unresolvedCount: 0`, and empty `needsUpdate`/`unresolved` arrays are mandatory. The classified outcome counts must equal `candidateCount`. Post-apply dry-run recognizes already-synchronized billing/trial bounds and counters, so it is the promotion proof rather than another mutation request.
8. Start only the new API and AI worker. Verify database readiness and that paid/trial session usage reports the Stripe/trial period source. A legacy paid row is labeled reconciliation-pending and paid provider work fails closed with `AI_USAGE_ACCOUNTING_UNAVAILABLE`; do not promote while any such tenant remains.
9. Send a signed test webhook, verify the durable inbox reaches `SUCCEEDED`, confirm both period bounds and current usage totals remain synchronized, then resume webhook and normal API ingress. Access revocations commit without waiting for usage aggregation. Same-cycle target-period work may defer only an aggregate rebuild; the post-drain command remains the readiness authority. Monitor failed/stuck webhook events and accounting-reconciliation errors through the release window.

Never point the command at a different Stripe mode than the database, and never bypass an unresolved report by fabricating a period.

Paid periods are the Stripe item `[current_period_start,current_period_end)`; trials use `[trialStartsAtUtc,trialEndsAtUtc)`. The system never derives a start by subtracting a month from an end because anchors and prorations make that unsafe. The billing migration also reduces historical webhook payloads to a bounded audit envelope and adds the per-tenant Stripe event watermark used by webhook compare-and-set updates. The envelope excludes customer contact fields and full provider payloads.

Historical payload redaction cannot be reversed without a backup, and index/table updates may take locks. After reconciliation, rolling back to old billing/webhook code is unsafe because it cannot maintain the paired start. If the new API must be rolled back, first pause webhook and paid-AI ingress; preserve the additive schema and content-free ledger for a forward fix. Restore the verified backup only under the incident plan. BCP/CI may build and publish code, but it is not authorization to run this production migration, reconciliation, ingress pause, or promotion sequence.
