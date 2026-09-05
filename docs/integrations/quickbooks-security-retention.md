# QuickBooks security-record retention

Last updated: 2026-08-27
Status: default-off engineering candidate; this document is a technical retention control, not legal advice or a substitute for customer-contract, tax, accounting, backup, or jurisdictional retention requirements.

QuickBooks credentials, OAuth replay state, and webhook envelopes are restricted provider data. QuoteFly does not retain raw OAuth state values, card details, bank details, or raw unknown-realm webhook content.

| Record | Terminal condition | Retention | Why |
| --- | --- | --- | --- |
| `QuickBooksOAuthState` | consumed or expired | 7 days after `consumedAtUtc` or `expiresAtUtc` | A short replay/incident-investigation window for a short-lived, hashed state; the original state is never stored. |
| `QuickBooksWebhookEvent` | `PROCESSED` | 30 days after `processedAtUtc` | Limited idempotency, support, and duplicate-delivery diagnosis window. |
| `QuickBooksWebhookEvent` | `DEAD` | 90 days after `deadAtUtc` | Gives the operations owner time to investigate and replay/remediate a dead letter. |
| unbound webhook quarantine | still `RECEIVED` with `QUICKBOOKS_REALM_UNBOUND` | 7 days after `receivedAtUtc` | Allows a newly bound legitimate realm to adopt a minimal envelope without allowing indefinite storage for an unrecognized company. |

`RECEIVED`, `PROCESSING`, and retryable `FAILED` events are not automatically removed. They need an explicit operational outcome first. Retention is deletion of terminal records, not a substitute for provider/accounting retention requirements.

Hard deletion of a tenant or QuickBooks connection cascades its tenant-bound webhook envelopes so provider data cannot become indefinite tenantless quarantine. Genuine unknown-realm quarantine rows are already unbound and are unaffected by those cascades.

## Execution boundary

`runQuickBooksRetentionForTenant` operates only inside a forced-RLS tenant transaction, takes a per-tenant advisory lock, and deletes at most 100 rows per tenant invocation. The QuickBooks reconciliation worker scans at most one 50-tenant keyset page on its hourly retention cadence; each cadence has its own cursor so webhook, revocation, CDC, and retention work cannot starve one another.

Unknown-realm quarantine is intentionally **not** exposed to a tenant scan. Once per hourly retention cadence, the worker invokes a fixed PostgreSQL `SECURITY DEFINER` function owned by a dedicated `NOLOGIN`, `NOBYPASSRLS` role. The function has no caller-controlled cutoff or limit, takes a global advisory lock, and deletes at most 100 rows that are still unbound, `RECEIVED`, marked `QUICKBOOKS_REALM_UNBOUND`, content-minimal, and older than seven days. Separate role-specific RLS policies constrain both its candidate read and delete. The application role receives only `EXECUTE` and the deleted-row count; it cannot enumerate quarantined realms or payloads.

Signed ingress retains the narrower realm-exact cleanup as defense in depth. It does not replace the scheduled global control, so a one-off unknown realm is still removed after the retention window without needing another webhook.

The worker remains behind the existing `QUICKBOOKS_RECONCILIATION_WORKER_ENABLED` and `QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED` default-off gates. It logs counts and hashes only; no OAuth state, webhook payload, token, payment link, customer, or provider identifier is emitted.

## Release evidence

- Apply the checked-in retention migration through the isolated migration role; the runtime uses only `quotefly_runtime`.
- Prove runtime-role deletion cannot see or delete another tenant's records.
- Prove a retention run removes only records past the stated terminal cutoff, obeys its 100-row bound, and reports remaining work.
- Prove a scheduled global quarantine run removes expired rows across multiple unbound realms without new ingress, respects its 100-row cap, and leaves current, adopted, tenant-bound, and non-quarantine records intact and inaccessible to the runtime role.
- Keep owner-managed sandbox/replay evidence and any legal retention decision outside this implementation document.
