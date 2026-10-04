# QuickBooks security-record retention

Last updated: 2026-09-13
Status: default-off engineering candidate; this document is a technical retention control, not legal advice or a substitute for customer-contract, tax, accounting, backup, or jurisdictional retention requirements.

QuickBooks credentials, OAuth replay state, and webhook envelopes are restricted provider data. QuoteFly does not retain raw OAuth state values, card details, bank details, or raw unknown-realm webhook content.

| Record | Terminal condition | Retention | Why |
| --- | --- | --- | --- |
| `QuickBooksOAuthState` | consumed or expired | 7 days after `consumedAtUtc` or `expiresAtUtc` | A short replay/incident-investigation window for a short-lived, hashed state; the original state is never stored. |
| `QuickBooksWebhookEvent` | `PROCESSED` | 30 days after `processedAtUtc` | Limited idempotency, support, and duplicate-delivery diagnosis window. |
| `QuickBooksWebhookEvent` | `DEAD` | 90 days after `deadAtUtc` | Gives the operations owner time to investigate and replay/remediate a dead letter. |
| unbound webhook quarantine | still `RECEIVED` with `QUICKBOOKS_REALM_UNBOUND` | 7 days after `receivedAtUtc` | Allows a newly bound legitimate realm to adopt a minimal envelope without allowing indefinite storage for an unrecognized company. |
| `QuickBooksWebhookReplay` | accepted recovery command | No automatic expiry in this candidate; survives inbox retention | Preserves immutable owner/admin authorization evidence and command idempotency after the webhook envelope expires. An owner-approved audit retention/disposal policy remains required for launch. |

`RECEIVED`, `PROCESSING`, and retryable `FAILED` events are not automatically removed. They need an explicit operational outcome first. Retention is deletion of terminal records, not a substitute for provider/accounting retention requirements.

## Replay audit classification and access

Every `QuickBooksWebhookReplay` scalar is explicitly classified `C4_RESTRICTED`, with required tenant scope and restricted-system access in the governance catalog. This includes internal audit/tenant/event IDs, the actor membership ID, the hashed idempotency command, fixed recovery reason and prior failure code, prior attempt count, and timestamp. All fields are excluded from AI source adapters, embeddings/RAG, and analytics. Content-free metadata still links an authorization actor to a recovery action and is not public marketing or AI context.

The recovery API independently checks the current owner/admin membership, active user/session and tenant, and explicitly selects only its documented operational response. Forced tenant RLS and a composite actor/tenant foreign key protect the stored audit. Runtime can select and append audit records but cannot update or delete them. No provider realm/entity ID, raw command key, token, webhook payload, or freeform failure text belongs in this table. Its original event reference deliberately has no inbox foreign key, so deleting an expired envelope does not remove audit evidence or break command idempotency.

The terminal-envelope retention worker does not delete replay audits. The owner must document an appropriate audit retention period and controlled disposal process before customer launch, including account deletion and backups; no retention period or destructive cleanup is inferred from this candidate's schema.

## Execution boundary

`runQuickBooksRetentionForTenant` operates only inside a forced-RLS tenant transaction, takes a per-tenant advisory lock, and deletes at most 100 rows per tenant invocation. The QuickBooks reconciliation worker scans at most one 50-tenant keyset page per tick. Incomplete cycles continue on the next bounded tick; the hourly retention interval starts after the complete tenant cycle. Each cadence has its own cursor so webhook, revocation, CDC, and retention work cannot starve one another.

Unknown-realm quarantine is intentionally **not** exposed to a tenant scan. Once per hourly retention cadence, the worker invokes a fixed PostgreSQL `SECURITY DEFINER` function owned by a dedicated `NOLOGIN`, `NOBYPASSRLS` role. The function has no caller-controlled cutoff or limit, takes a global advisory lock, and deletes at most 100 rows that are still unbound, `RECEIVED`, marked `QUICKBOOKS_REALM_UNBOUND`, content-minimal, and older than seven days. Separate role-specific RLS policies constrain both its candidate read and delete. The application role receives only `EXECUTE` and the deleted-row count; it cannot enumerate quarantined realms or payloads.

Signed ingress retains the narrower realm-exact cleanup as defense in depth. It does not replace the scheduled global control, so a one-off unknown realm is still removed after the retention window without needing another webhook.

The worker remains behind the existing `QUICKBOOKS_RECONCILIATION_WORKER_ENABLED` and `QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED` default-off gates. It logs counts and hashes only; no OAuth state, webhook payload, token, payment link, customer, or provider identifier is emitted.

## Release evidence

- Apply the checked-in retention migration through the isolated migration role; the runtime uses only `quotefly_runtime`.
- Prove runtime-role deletion cannot see or delete another tenant's records.
- Prove a retention run removes only records past the stated terminal cutoff, obeys its 100-row bound, and reports remaining work.
- Prove a scheduled global quarantine run removes expired rows across multiple unbound realms without new ingress, respects its 100-row cap, and leaves current, adopted, tenant-bound, and non-quarantine records intact and inaccessible to the runtime role.
- Keep owner-managed sandbox/replay evidence and any legal retention decision outside this implementation document.
