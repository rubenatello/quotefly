# QuickBooks OAuth And Sync Plan

## Goal

Move QuoteFly from CSV-only QuickBooks support to a tenant-linked QuickBooks Online integration that can push quotes into invoices safely.

## V1 Integration Scope

Current implemented scope covers:

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

## Launch Recommendation

Before public launch:

1. Ship OAuth connection and status first
2. Keep CSV export as the fallback
3. Add invoice push only after:
   - one sandbox test company works
   - one real production company works
   - customer/item mapping is deterministic

That avoids turning QuickBooks sync into a launch blocker while still building the right foundation.
