# QuickBooks Owner Setup — Provider Workflows Paused

Status: Engineering candidate only. Do not enable or market QuickBooks Online connection, invoice publishing, hosted payments, payment reconciliation, tax sync, CDC, or webhook automation for the current release.

Authoritative references:

- [Hosted payments and reconciliation acceptance contract](quickbooks-hosted-payments-reconciliation.md)
- [Current API progress and release evidence](quickbooks-api-progress.md)
- [Owner testing checklist](quickbooks-owner-testing-checklist.md)

## Current production boundary

- Keep `QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED=false` in every deployed API environment.
- Do not complete OAuth consent, subscribe Invoice or Payment webhooks, push a provider invoice, retrieve or share a hosted payment link, or record a QuickBooks payment.
- Taxable invoice publishing remains blocked even in a future bounded pilot until a separate tax-mapping contract is approved.
- QuickBooks status and local preview remain owner/admin surfaces; CSV export remains the supported accounting handoff.
- Existing credentials, schema, UI, tests, or an engineering-candidate build do not authorize provider activity.

No sandbox or production provider evidence is claimed by this document.

## Safe environment posture

The deployed environment may retain reserved credentials for development or local cleanup, but the kill switch must remain false:

```env
QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED=false
QUICKBOOKS_CLIENT_ID=
QUICKBOOKS_CLIENT_SECRET=
QUICKBOOKS_ENVIRONMENT=production
QUICKBOOKS_REDIRECT_URI=https://api.quotefly.us/v1/integrations/quickbooks/callback
QUICKBOOKS_WEBHOOK_VERIFIER=
QUICKBOOKS_TOKEN_ENCRYPTION_KEY=
QUICKBOOKS_TOKEN_ENCRYPTION_KEY_PREVIOUS=
```

Keep client secrets, verifier values, token-encryption keys, OAuth tokens, hosted invoice links, and provider identifiers out of Git, browser environment variables, logs, analytics, tickets, and screenshots.

## Owner evidence inventory

Before any separately authorized sandbox run, record dated, sanitized evidence for:

- candidate commit SHA and exact deployed image;
- Intuit app name/environment, callback URI, webhook endpoint, approved scopes, and test company;
- QuickBooks Payments sandbox eligibility and the payment methods approved by the contractor;
- credential owner, rotation date, token-encryption-key generation/rotation plan, and revocation procedure;
- existing QuoteFly connections, realm bindings, webhook subscriptions, pending operations, dead letters, and CDC cursors;
- named monitoring, incident, reconciliation, support, accounting/tax, and release owners;
- production-like migration rehearsal, backup timestamp, restore proof, and forward-fix decision record.

Inventory references must identify secrets by provider-side label or fingerprint only, never by value.

## Sandbox authorization boundary

The checklist in [quickbooks-owner-testing-checklist.md](quickbooks-owner-testing-checklist.md) becomes executable only after the exact candidate passes its automated gate and receives explicit owner authorization for Intuit sandbox mutations. Authorization for sandbox does not authorize production credentials, production OAuth, production webhooks, production migrations, or customer exposure.

## Monitoring required before a sandbox run

Assign alert destinations and owners for:

- oldest eligible webhook age and webhook retry count;
- `DEAD` webhook events and replay outcome;
- `PROCESSING`, `RECONCILING`, and reconciliation-required invoice operations past their budget;
- OAuth callback rejection, token refresh failure, `REVOCATION_PENDING`, orphan credential `PENDING`/`DEAD`, and revocation retry age;
- CDC cursor lag, CDC retries, and dropped-webhook repair outcome;
- provider request latency, timeout, throttling, and error-code rate;
- hosted-link validation rejection and any no-log/no-cache policy violation.

Operational logs and metrics must be content-free: tenant-safe IDs or hashes, request IDs, state, attempt counts, latency, and sanitized error codes only.

## Kill switch and rollback

1. Set `QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED=false` and restart the API to stop provider-capable work.
2. Preserve Invoice, InvoicePayment, InvoiceEvent, QuickBooks operation, webhook, and CDC records; do not delete uncertain state.
3. Pause or remove Intuit webhook subscriptions when provider ingress must stop.
4. Attempt provider token revocation before clearing local tokens. If revocation cannot be confirmed, keep the connection blocked as `REVOCATION_PENDING`, rotate/revoke provider credentials externally, and continue the recorded retry/escalation path.
5. Reconcile every in-flight or uncertain invoice against QuickBooks before any re-enable decision; never retry invoice creation blindly.
6. Prefer a forward fix after the hosted-payment migration. Do not roll back to a binary that predates the provider kill switch or tenant-RLS context while credentials or forced RLS remain active.
7. Restore a database backup only through a rehearsed, owner-approved incident procedure; restoration does not reverse provider-side invoices or payments.

## Approved external wording

Current public wording may say:

- `Create an internal QuoteFly invoice record.`
- `Export invoice data in a QuickBooks-friendly CSV.`
- `Direct QuickBooks integrations are on the roadmap.`

Do not claim QuickBooks Online connection, invoice creation, hosted payment links, customer payment collection, automatic paid status, tax sync, CDC recovery, or webhook automation is available.
