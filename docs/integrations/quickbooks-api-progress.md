# QuickBooks API Progress

**Last updated:** `2026-04-10`

## Objective

Track exactly what QuoteFly already supports for QuickBooks, what is partially implemented, and what is still missing before we can market the integration more aggressively.

## Current Status

### Implemented now

- QuickBooks Online OAuth 2.0 tenant connection
- QuickBooks Online disconnect
- encrypted token storage
- automatic access-token refresh
- Admin connection status UI
- quote-level sync preview
- QuickBooks customer lookup by display name
- QuickBooks customer creation when missing
- QuickBooks item lookup by name
- QuickBooks service item creation when missing
- direct invoice push from accepted/won quotes
- remote invoice status refresh
- QuickBooks-friendly CSV export fallback

### Current supported workflow

1. Tenant owner/admin connects a QuickBooks Online company.
2. User marks a quote as `Won`.
3. User opens the quote desk and previews QuickBooks mapping.
4. QuoteFly resolves or creates:
   - customer
   - service items
5. QuoteFly creates an invoice in QuickBooks Online.
6. User refreshes invoice status from QuoteFly.

## API Surface

### Admin / connection

- `GET /v1/integrations/quickbooks/status`
- `POST /v1/integrations/quickbooks/connect`
- `GET /v1/integrations/quickbooks/callback`
- `POST /v1/integrations/quickbooks/disconnect`

### Quote sync

- `GET /v1/integrations/quickbooks/quotes/:quoteId/sync-preview`
- `POST /v1/integrations/quickbooks/quotes/:quoteId/push-invoice`
- `GET /v1/integrations/quickbooks/quotes/:quoteId/invoice-status`

## Current Database Coverage

### `QuickBooksConnection`

Stores tenant-level QuickBooks Online connection details:

- realm id
- company name
- encrypted access token
- encrypted refresh token
- connection state
- sync and webhook timestamps
- last error

### `QuickBooksCustomerMap`

Maps QuoteFly customer ids to QuickBooks customer ids.

### `QuickBooksItemMap`

Maps QuoteFly line-item keys to QuickBooks item ids.

### `QuickBooksInvoiceSync`

Stores per-quote sync state:

- QuickBooks invoice id
- QuickBooks doc number
- request id
- sync status
- payload snapshot
- last error

### `QuickBooksWebhookEvent`

Reserved for webhook replay, verification, and debugging.

## Current Product Behavior

### What we can honestly say today

- QuoteFly connects to QuickBooks Online
- accepted quotes can be pushed into QuickBooks invoices
- QuoteFly can refresh invoice balance status from QuickBooks
- QuoteFly still offers CSV fallback if a tenant prefers import

### What we should not claim yet

- full two-way accounting sync
- automatic payment reconciliation into the CRM
- automatic tax sync into QuickBooks tax codes
- full invoice list import back into QuoteFly
- QuickBooks Desktop support

## Known Limitations

### Tax

Quoted tax is not mapped into QuickBooks tax settings yet.

Current behavior:

- QuoteFly warns before invoice push if the quote includes tax
- user should verify tax inside QuickBooks after sync

### Customer matching

Current matching strategy:

- use saved customer map first
- fallback to exact display-name lookup
- create customer if missing and allowed

This is safe enough for launch but not strong enough for duplicate-heavy books.

### Item matching

Current matching strategy:

- use saved item map first
- fallback to exact item-name lookup
- create service item if missing and allowed

This is good for v1 but still needs user-controlled mapping tools later.

### Payment visibility

Current invoice payment visibility is refresh-based, not webhook-based.

That means:

- user can see current balance when they ask for it
- QuoteFly is not yet passively updated the moment a payment is recorded in QuickBooks

## Immediate Next Steps

### Launch-critical

1. Add webhook verification and processing for QuickBooks Online
2. Subscribe to invoice and payment changes
3. Update `QuickBooksInvoiceSync` automatically when invoices are edited or paid
4. Add visible local invoice state in QuoteFly UI

### Post-launch but important

1. Add explicit customer matching review
2. Add explicit item mapping review
3. Add bulk invoice push
4. Add invoice list and payment summary views inside the CRM

## Desktop Reality Check

QuickBooks Desktop is **not** the same integration problem.

QuickBooks Online:

- OAuth 2.0
- REST APIs
- webhooks
- cloud-first flow

QuickBooks Desktop:

- Windows-only integration path
- QuickBooks Desktop SDK or Web Connector
- qbXML request/response model
- no QuickBooks Online OAuth flow
- no QuickBooks Online webhook model

Desktop support needs a separate compatibility layer and operational model. See:

- `docs/integrations/quickbooks-online-desktop-architecture.md`

## Official References

- QuickBooks Online OAuth 2.0:
  - https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0
- QuickBooks Online invoice workflow:
  - https://developer.intuit.com/app/developer/qbo/docs/workflows/create-an-invoice
- QuickBooks Online query syntax:
  - https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/data-queries
- QuickBooks Online webhooks:
  - https://developer.intuit.com/app/developer/qbo/docs/develop/webhooks
