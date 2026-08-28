# QuickBooks orphan OAuth credential revocation

## Security invariant

Intuit can issue an access/refresh credential before QuoteFly completes its second authorization and connection-lifecycle check. If membership, tenant lifecycle, connection generation, disconnect intent, or a credential claim changes during that provider exchange, QuoteFly must reject attachment of the new credential.

QuoteFly first attempts immediate revocation. A failed or unknown outcome is written to `QuickBooksOrphanCredentialRevocation`, never to `QuickBooksConnection`. The outbox contains a randomized encrypted refresh credential and a keyed, one-way dedupe identity. It cannot create, reactivate, replace, or update a QuickBooks connection.

If both immediate revocation and durable persistence fail, the OAuth callback redirects with `quickbooks_cleanup_failed` and emits only the sanitized event code `QUICKBOOKS_ORPHAN_REVOCATION_PERSIST_FAILED`. It does not claim the credential was revoked and never returns or logs the credential.

## Retry, fencing, and escalation

- The immediate failed/unknown provider call is attempt 1.
- The existing fair tenant revocation scan claims at most one due orphan row per tenant visit, independently of connection revocation work.
- A claim is fenced by tenant, row id, encrypted-token snapshot, observed attempt generation, and a random claim hash. Expired `PROCESSING` leases can be reclaimed with the same compare-and-swap boundary.
- Backoff starts at two minutes and doubles to a 24-hour cap.
- Provider success atomically marks the row `REVOKED` and immediately erases the encrypted refresh credential.
- Attempt 8 moves the row to `DEAD`, retains the encrypted credential for incident-response revocation, and emits `QUICKBOOKS_ORPHAN_REVOCATION_DEAD` with only attempt count and a sanitized failure code.

`DEAD` is an operator escalation, not proof of provider revocation. This release intentionally does not auto-delete an unresolved encrypted credential because doing so would destroy the only material that can revoke it. A future privileged incident workflow may requeue or explicitly dispose of the record after independent provider-side revocation evidence. `REVOKED` rows contain no credential and remain as tenant-scoped audit evidence until tenant deletion. Tenant deletion cascades both terminal states.

## Database boundary

The table has forced PostgreSQL row-level security keyed to transaction-local `app.tenant_id`. The restricted `quotefly_runtime` role receives only `SELECT`, `INSERT`, and `UPDATE`; `DELETE` and `TRUNCATE` remain revoked. A database check enforces valid token, claim, retry, and terminal-state combinations. The table relates only to its owning tenant, so orphan cleanup cannot traverse into a connection generation.

## Rollout and evidence

Processing uses the existing default-off QuickBooks provider/reconciliation worker gates. Local integration evidence covers post-exchange membership loss with immediate revocation timeout, encrypted idempotent persistence, retry success, concurrent-claim fencing, terminal escalation, sanitized operational logs, and restricted-runtime cross-tenant isolation.

Before enabling in a live Intuit sandbox, capture evidence for:

1. a rejected post-exchange callback whose immediate revoke is synthetically timed out;
2. one pending outbox record without plaintext token material;
3. worker retry success followed by provider-side token rejection;
4. alert delivery for a synthetic terminal `DEAD` record; and
5. runtime-role RLS verification on the migrated, production-like database.

Do not enable the provider workflow based only on mocked provider tests.
