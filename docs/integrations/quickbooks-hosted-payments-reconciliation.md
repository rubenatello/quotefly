# QuickBooks Hosted Payments And Reconciliation

Last updated: 2026-09-02

Status: Engineering candidate in progress. QuickBooks provider workflows remain default-off and are not approved for production enablement.

## Product and provider boundary

QuoteFly owns the reviewed customer-to-invoice workflow and its tenant-scoped operational ledger. QuickBooks Online owns the hosted checkout, payment processing, accounting record, and settlement to the contractor.

```text
QuoteFly customer -> accepted quote -> job -> QuoteFly invoice
  -> reviewed QuickBooks customer and item mappings
  -> QuickBooks invoice with online payments enabled
  -> QuickBooks-hosted InvoiceLink
  -> QuickBooks payment/accounting state
  -> QuoteFly reconciliation mirror
```

QuoteFly must never collect, proxy, persist, or log card numbers, CVV values, bank account numbers, or routing numbers. QuickBooks processing fees and merchant eligibility remain controlled by Intuit and the contractor's QuickBooks Payments account.

## Authoritative workflow

### Reviewed mapping

Before publishing, an owner or admin must review and explicitly confirm:

- the QuoteFly customer mapped to an existing QuickBooks customer or a separately reviewed new-customer payload;
- each normalized QuoteFly invoice line mapped to an existing QuickBooks item or a separately reviewed new-item payload;
- the destination QuickBooks company;
- the customer billing email;
- the enabled online payment methods;
- invoice totals, due date, document number, and every line item.

The confirmation must be bound to the exact tenant, invoice version, connection, realm, mappings, payment-method choices, and provider payload. A mapping or invoice change invalidates the review.

### Hosted payment link

The QuickBooks invoice request may enable online payments only when the reviewed customer has a valid billing email and the connected company is eligible. After creation, QuoteFly retrieves the authoritative invoice with `include=invoiceLink` and the centrally pinned `minorversion=36` contract, then stores the returned link as restricted provider data. Any future minor-version change requires a contract-test update and a fresh sandbox evidence run; the provider and hosted-payment feature flags remain default-off until that evidence is attached.

The link must:

- be HTTPS and match an approved Intuit or QuickBooks hostname;
- never enter logs, analytics, Kody/OpenAI prompts, public quote payloads, or referrer headers;
- be returned only to an authorized tenant user or an explicitly scoped customer-share workflow;
- use `Cache-Control: no-store` and `Referrer-Policy: no-referrer` at delivery boundaries.

At rest, a cached link is stored only in a purpose-bound authenticated-encryption envelope. Legacy plaintext values are invalidated by migration and must be recovered through canonical reconciliation before they can be presented again.

Publishing opens the internal QuoteFly invoice and records the provider invoice identity. It does not set `sentAtUtc` until QuoteFly actually presents or sends the hosted link.

## One reconciliation service

Webhooks, manual refresh, and CDC recovery are only triggers. They must all call the same authoritative reconciliation service:

1. Resolve the active tenant/connection without exposing encrypted credentials.
2. Fetch the canonical QuickBooks invoice and applicable payment records with bounded timeouts.
3. Validate provider response schemas and verify invoice identity, tenant marker, customer, currency, totals, and reviewed fingerprint.
4. Quarantine drift or an ambiguous provider result as reconciliation-required.
5. In one short tenant-RLS transaction, upsert provider payment applications, update the QuoteFly invoice balance/status, and append idempotent invoice events.
6. Commit before marking the trigger processed.

External provider calls must remain outside database transactions. Invoice creation is never blindly retried; a timeout or unknown mutation result enters reconciliation before any replacement attempt.

## Webhook durability

The public webhook route must:

1. Enforce the body-size limit.
2. Verify `intuit-signature` against the exact raw body.
3. Validate the supported `eventNotifications` envelope.
4. Resolve known realms through a minimal non-secret routing record.
5. Insert or deduplicate each supported entity notification transactionally.
6. Return `2xx` only after durable persistence.

A leased worker processes persisted events with bounded retry/backoff. Exhausted events enter a dead-letter state with content-safe operational metadata and an alertable metric. Replay must be idempotent.

## State projection

QuoteFly never overwrites invoice totals from QuickBooks. It projects collection state from the canonical QuickBooks balance plus payment/refund evidence:

| Provider state | QuoteFly invoice | QuoteFly payment status |
| --- | --- | --- |
| Balance equals total | `OPEN` | `PENDING` |
| Balance is above zero and below total | `OPEN` | `PARTIALLY_PAID` |
| Balance is zero | `PAID` | `SUCCEEDED` |
| Partial refund or reversal reopens part of the balance | `OPEN` | `PARTIALLY_REFUNDED` |
| Full refund or reversal reopens the full balance | `OPEN` | `REFUNDED` |
| QuickBooks invoice is voided | `VOID` | `CANCELED` |

`paidAtUtc` is present only while the invoice remains fully paid. A reversal or refund that reopens a balance clears it while preserving append-only payment and event history.

## Security and reliability controls

- Every tenant-owned QuickBooks row is protected by tenant scoping, forced RLS, and composite tenant relationships where practical.
- OAuth state is random, hashed at rest, short-lived, browser/user bound where the session model permits, and atomically consumed once.
- OAuth callback company validation fails closed before a realm is persisted.
- Disconnect attempts provider token revocation before local token cleanup. A failed revocation becomes `REVOCATION_PENDING`, blocks provider use, and retries without exposing token material.
- Access-token refresh is serialized per connection to prevent refresh-token rotation races.
- Provider reads use bounded retries only for eligible transient failures and respect `Retry-After` within a fixed budget.
- Provider mutations use deterministic request identity and uncertain-result reconciliation instead of blind retries.
- Queue age, retries, dead letters, reconciliation-required operations, token refresh/revocation failures, and CDC lag produce content-free metrics/log fields.
- Taxable invoice publishing remains blocked until a separately reviewed tax-mapping contract exists.

## Recovery paths

- Manual refresh invokes the authoritative reconciliation service for one invoice.
- CDC overlaps the last successful cursor and feeds changed invoices/payments through the same service.
- Expired webhook leases are reclaimable.
- A dead-letter replay does not create another provider invoice or duplicate a payment application.
- A dropped webhook is repaired by CDC without producing duplicate ledger rows or events.

## Required evidence before enablement

### Automated

- Fresh checked-in migration and Prisma validation.
- Two-tenant runtime-role denial for every tenant-owned QuickBooks table.
- Mapping review/version invalidation and duplicate-create protection.
- Hosted-link retrieval, hostname validation, no-store response, and no sensitive logging.
- Canonical signed webhook, invalid signature, malformed envelope, unknown realm, persist-before-ack, concurrent deduplication, lease expiry, retry, and dead-letter tests.
- Unpaid, partial, paid, multi-invoice payment, partial/full refund, reversal, payment deletion, void, out-of-order event, and idempotent replay tests.
- Manual refresh and CDC prove the same state transition as webhook processing.
- Timeout, throttling, `Retry-After`, refresh race, OAuth replay, callback realm mismatch, and revocation-pending tests.
- `npm run verify` and the database-backed launch gate on the exact candidate.

### Owner-managed sandbox

No sandbox result may be inferred from mocked tests. Record the exact committed SHA and sanitized evidence for:

- OAuth consent and one-time callback behavior;
- reviewed customer/item mapping;
- one non-taxable invoice with ACH/card settings approved by the contractor;
- retrieval and safe presentation of the hosted `InvoiceLink`;
- partial payment, full payment, partial/full refund, reversal, and void;
- duplicate and out-of-order webhook delivery;
- dropped webhook repaired by CDC;
- timeout/restart recovery without duplicate provider invoices;
- token revocation and reconnect;
- provider queue, dead-letter, reconciliation, and CDC metrics.

Provider workflows must remain disabled until this evidence, Sentinel review, and an independent Opera approval are complete. Production enablement, migration application, webhook subscription, OAuth consent, and QuickBooks sandbox mutations require separate owner authorization.
