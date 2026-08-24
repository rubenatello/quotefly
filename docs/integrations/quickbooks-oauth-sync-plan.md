# QuickBooks OAuth And Sync Plan

> **Superseded provider design — workflows paused (2026-08-23).** This document describes a legacy/future architecture, not a current launch procedure. Keep `QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED=false` and use [quickbooks-api-progress.md](quickbooks-api-progress.md) as the authoritative release boundary. QuickBooks-friendly CSV export is the only supported QuickBooks handoff until the durable provider-sync phase is separately approved.

## Goal

Move QuoteFly from CSV-only QuickBooks support to a tenant-linked QuickBooks Online integration that can push quotes into invoices safely.

## V1 Integration Scope

The repository's legacy provider foundation covers:

- tenant-level QuickBooks Online connection
- OAuth 2.0 connect and disconnect flow
- encrypted token storage
- admin status visibility
- quote sync preview
- automatic QuickBooks customer creation when missing
- automatic QuickBooks service item creation when missing
- direct invoice push for accepted quotes
- remote invoice balance refresh
- data model for customer, item, invoice, and webhook tracking

Still not complete:

- webhook signature verification and processing
- webhook-driven payment status updates
- direct tax-code/tax-line mapping
- bulk invoice push

## Tenant Model

One QuoteFly tenant links to one QuickBooks company.

Key identifier:

- `realmId`: QuickBooks company identifier returned during OAuth callback

## Data Model

### `QuickBooksConnection`

Stores:

- `tenantId`
- `realmId`
- `environment`
- `companyName`
- `status`
- encrypted access token
- encrypted refresh token
- token expiry timestamps
- last sync / webhook / error metadata

### `QuickBooksCustomerMap`

Maps QuoteFly customers to QuickBooks customer ids.

### `QuickBooksItemMap`

Maps QuoteFly line descriptions or preset-derived keys to QuickBooks item ids.

### `QuickBooksInvoiceSync`

Tracks invoice push attempts per quote:

- quote id
- QuickBooks invoice id
- status
- request id
- payload snapshot
- last error

### `QuickBooksWebhookEvent`

Stores raw webhook events by `realmId` and `webhookEventId` for replay/debugging.

## Backend Routes

### `GET /v1/integrations/quickbooks/status`

Returns:

- whether QuickBooks is configured on the backend
- redirect URI
- current tenant connection summary
- counts for customer maps, item maps, and invoice sync records

### `POST /v1/integrations/quickbooks/connect`

Returns an Intuit authorization URL for the current tenant.

Rules:

- authenticated
- owner/admin only
- requires QuickBooks client id and secret in env

### `GET /v1/integrations/quickbooks/callback`

OAuth callback endpoint.

Responsibilities:

- validate signed state
- exchange authorization code for tokens
- fetch QuickBooks company info
- upsert tenant connection
- redirect back to `/app/admin`

### `POST /v1/integrations/quickbooks/disconnect`

Marks the connection as disconnected and clears stored tokens.

## Planned Invoice Push Flow

### QuoteFly side

1. User selects a quote
2. QuoteFly loads tenant connection
3. QuoteFly refreshes access token if needed
4. QuoteFly resolves or creates:
   - QuickBooks customer
   - QuickBooks item mappings
5. QuoteFly posts invoice payload to QuickBooks
6. QuoteFly stores sync result in `QuickBooksInvoiceSync`

### Mapping rules

#### Customer

Preferred mapping:

- existing `QuickBooksCustomerMap`

Fallback:

- exact customer lookup in QuickBooks by display name
- create customer if no safe match exists

#### Item / service line

Preferred mapping:

- existing `QuickBooksItemMap`

Fallback:

- work preset `catalogKey`
- normalized line description

If no safe item exists, QuoteFly should create a service item or require user mapping confirmation.

## Recommended Sync API Contract

### `POST /v1/integrations/quickbooks/quotes/:quoteId/push-invoice`

Suggested request:

```json
{
  "createCustomerIfMissing": true,
  "createItemsIfMissing": true
}
```

Suggested response:

```json
{
  "sync": {
    "status": "SYNCED",
    "quickBooksInvoiceId": "123",
    "quickBooksDocNumber": "QF-QUOTE-1001"
  }
}
```

### `GET /v1/integrations/quickbooks/quotes/:quoteId/sync-preview`

Use before push to inspect:

- resolved customer mapping
- unresolved item mappings
- proposed invoice payload
- warnings

## Admin UI Expectations

The Admin page should show:

- connected/not connected
- environment
- redirect URI
- company name
- realm id
- last sync / last webhook / last token refresh
- connect / reconnect / disconnect actions

## Required Env Vars

```env
QUICKBOOKS_CLIENT_ID=
QUICKBOOKS_CLIENT_SECRET=
QUICKBOOKS_ENVIRONMENT=production
QUICKBOOKS_REDIRECT_URI=https://api.quotefly.us/v1/integrations/quickbooks/callback
QUICKBOOKS_WEBHOOK_VERIFIER=
```

## Future Enablement Recommendation

Do not enable these workflows for the current public launch. For a future provider release:

1. Keep CSV export as the supported handoff.
2. Add a durable Invoice-based processing claim, uncertain-result reconciliation, forced tenant RLS, and a durable webhook inbox/worker.
3. Add approved tax mapping and deterministic customer/item review.
4. Complete sandbox, concurrency, restart, two-tenant, rollback, and production-readiness evidence.

Only a separate reviewed release may change `QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED` to `true`. With the current release flag set to `false`, invoice push returns provider-unavailable `503` before payload-specific tax validation; the legacy enabled test path separately rejects taxable pushes with `422`.
