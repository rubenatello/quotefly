# In-app notification retention

QuoteFly keeps active in-app notifications long enough for field teams to review operational changes without retaining an unlimited inbox.

## Policy

- Read notifications are soft-archived 90 days after `readAtUtc`.
- Never-read notifications are soft-archived 365 days after `createdAt`.
- The unread duration must remain longer than the read duration. Runtime validation enforces a minimum of 30 read days and 180 unread days.
- Soft archive removes rows from notification lists, unread counts, summaries, and keyset pagination. It does not delete the content-minimal source row, Job event, appointment, or audit hashes.
- Runtime `DELETE` and `TRUNCATE` remain revoked. Physical deletion is outside this policy and requires a separate backup-expiry, tenant-export, legal, and incident-recovery review.

## Scheduled service

Run `start:notification-retention` as a daily run-once service using only the production `quotefly_runtime` `DATABASE_URL`. Do not provide `DIRECT_DATABASE_URL`. The owner must create a dedicated Railway cron service, set that service's **Config File Path** to `/railway.notification-retention.json`, and configure it to run once daily. Before enabling the cron, verify the resolved deployment details show `npm run start:notification-retention -- --apply` and restart policy `NEVER`; if they show the root API command, stop and correct the config binding.

Railway Config as Code is not the long-term control plane for legacy services after December 1, 2026. Track migration of this service to Railway's supported configuration mechanism before that date, while preserving the same run-once command, least-privileged connection, and no-restart behavior.

The command is safe by default:

```bash
npm run start:notification-retention
```

This produces a content-free dry-run summary and changes no rows. Review `failedTenantCount`, `skippedTenantCount`, and `hasMoreTenantCount` before enabling apply.

The explicit scheduled apply command is:

```bash
ENABLE_NOTIFICATION_RETENTION_WORKER=true npm run start:notification-retention -- --apply
```

The worker enumerates active tenants, binds forced RLS separately for each tenant, and uses a transaction advisory lock plus `FOR UPDATE SKIP LOCKED`. Each database update is capped at 250 rows and each tenant is capped at 5,000 rows per run. A nonzero failed-tenant count or remaining eligible work makes an apply run exit nonzero so the scheduler alerts rather than silently falling behind. Logs contain aggregate counts only and never tenant IDs, customer names, Job titles, addresses, or message content.

## Rollout and rollback

1. Apply the additive retention index migration before scheduling the worker.
2. Run and retain one production dry-run report.
3. Bind the service Config File Path to `/railway.notification-retention.json`, verify the resolved run-once command and `NEVER` restart policy, then enable the daily schedule with the least-privileged runtime connection.
4. Require an alert on nonzero exit, failed tenants, or sustained `hasMoreTenantCount`.
5. Verify notification list and unread summaries after the first apply.

Application rollback does not require restoring archived rows: the schema and archived rows are additive and compatible with older readers that already filter `archivedAtUtc`. Disable the scheduled worker during an incident, preserve the rows, and forward-fix. Do not null `archivedAtUtc` or physically delete rows as a rollback shortcut.

## Compatibility bridge retirement

The first release must retain the missing-AI-idempotency fallback, the flat/read-only `jobStatus` projection, and the legacy AI usage-event trigger. Remove them only in a later release after:

- the new web/API has served production for at least 14 days;
- compatibility telemetry is zero for seven consecutive days on every affected paid endpoint;
- each paid endpoint has a verified keyed success;
- all cached old web sessions are considered drained;
- every old API and AI worker binary is stopped;
- Stripe-period reconciliation completes with no unresolved tenant; and
- no unlinked positive-credit AI event appears after the recorded new-API start.

Removing the Quote column or historical revision field is not part of that bridge cleanup and requires a separate backed-up deprecation phase.
