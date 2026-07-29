# Stripe billing integrity rollout

The item-period reconciliation is an explicit release gate. It is never run by application startup, a migration, or CI because it reads live Stripe state and may update tenant billing snapshots.

## Required order

1. Back up PostgreSQL and prove the backup can be restored. Rehearse the migration against a recent production-like clone and record migration duration and lock behavior.
2. Run a read-only database preflight for duplicate non-null Stripe customer, subscription, and checkout-session IDs. Stop if any duplicate exists; the migration intentionally aborts rather than choosing a tenant automatically.
3. Run the reconciliation preflight against the target database and matching Stripe environment:

   ```bash
   npm run billing:reconcile-periods
   ```

   Dry-run exits nonzero when any active/trialing paid-plan tenant still has a Stripe subscription ID but no period. Its JSON report contains only internal tenant IDs, Stripe subscription IDs, counts, and bounded error categories—no secrets or customer PII.
4. Review the candidate IDs and configured price IDs. Then explicitly reconcile:

   ```bash
   npm run billing:reconcile-periods -- --apply
   ```

   Provider reads use four workers, a ten-second request timeout, and two Stripe network retries. Each subscription must belong to the tenant's stored Stripe customer; when Stripe tenant metadata is present, it must match the tenant ID. Updates are conditional on those bindings, the tenant still referencing the same subscription, and the period still being absent.
5. Run the dry-run again. A zero exit code and `unresolvedCount: 0` are mandatory. Any unresolved ID is a release blocker requiring manual Stripe/tenant-state investigation.
6. Pause or drain Stripe webhook ingress and stop the old API instances. Do not allow old and new billing code to process webhooks concurrently during this migration.
7. Apply the checked-in migration as a release step, then start only the new API build. Resume the Stripe webhook endpoint after readiness is healthy.
8. Send a signed test webhook, verify the durable inbox reaches `SUCCEEDED`, confirm paid access, and monitor failed or stuck `PROCESSING` events before continuing rollout.

Never point the command at a different Stripe mode than the database, and never bypass an unresolved report by manually fabricating a period.

The billing migration also reduces historical webhook payloads to a bounded audit envelope and adds the per-tenant Stripe event watermark used by webhook compare-and-set updates. The envelope intentionally excludes customer contact fields and full provider payloads.

The historical payload redaction cannot be reversed without a backup, and the index/table updates may take locks. After the migration, rolling the API back to the old billing code is not webhook-safe. Pause webhook ingress and prefer a forward fix; restore the verified backup only under the incident plan.
