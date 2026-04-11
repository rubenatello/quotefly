# QuickBooks Owner Setup

## Goal

Connect one QuickBooks Online company to one QuoteFly tenant, then push accepted quotes into QuickBooks invoices.

## What Works Now

- tenant-level QuickBooks OAuth connection
- connection status in QuoteFly Admin
- quote-level sync preview
- automatic QuickBooks customer creation when missing
- automatic QuickBooks service item creation when missing
- direct invoice push from accepted QuoteFly quotes
- refresh remote invoice status to see whether the invoice is still open or effectively paid
- webhook endpoint with signature verification
- webhook intake and storage for QuickBooks notifications
- invoice webhook refresh for already-synced invoice ids

## What Is Not Finished Yet

- full webhook-driven payment reconciliation back into QuoteFly
- automatic tax mapping into QuickBooks tax codes
- bulk invoice push
- two-way sync for QuickBooks customer edits
- automatic invoice list import into QuoteFly pipeline

## Intuit Developer Setup

1. Sign in to Intuit Developer and open the QuickBooks app you want QuoteFly to use.
2. Make sure the app has the QuickBooks Online Accounting scope.
3. In the Production keys/OAuth section, add this redirect URI exactly:

```text
https://api.quotefly.us/v1/integrations/quickbooks/callback
```

4. Copy these values:
   - Client ID
   - Client Secret
5. Add this webhook endpoint:

```text
https://api.quotefly.us/v1/integrations/quickbooks/webhook
```

6. Copy the webhook **Verifier Token**.
7. If you plan to use sandbox first, repeat the same redirect URI and webhook endpoint under the Development environment too.

## Railway Env Vars

Add these to the API service in Railway:

```env
QUICKBOOKS_CLIENT_ID=
QUICKBOOKS_CLIENT_SECRET=
QUICKBOOKS_ENVIRONMENT=production
QUICKBOOKS_REDIRECT_URI=https://api.quotefly.us/v1/integrations/quickbooks/callback
QUICKBOOKS_WEBHOOK_VERIFIER=
```

Notes:

- `QUICKBOOKS_WEBHOOK_VERIFIER` is now required for webhook validation.
- without it, the webhook endpoint will reject QuickBooks notifications.

## First Connection Test

1. Deploy the latest API and web app.
2. Sign in as the tenant owner/admin.
3. Open `Admin`.
4. In the `QuickBooks Online` section, click `Connect QuickBooks`.
5. Complete the Intuit consent flow.
6. Confirm Admin shows:
   - company name
   - realm id
   - status `CONNECTED`

## First Invoice Push Test

1. Create a test customer in QuoteFly.
2. Create a quote with real line items.
3. Mark the quote `Won`.
4. Open the quote desk.
5. In the `QuickBooks` section:
   - click `Preview Mapping`
   - review warnings
   - click `Push Invoice`
6. Then click `Refresh Status`.

Expected result:

- customer gets mapped or created in QuickBooks
- service items get mapped or created in QuickBooks
- invoice appears in QuickBooks with the QuoteFly doc number
- QuoteFly shows invoice id, total, balance, and `Open` or `Paid`

## Current Tax Limitation

QuoteFly does **not** yet push tax codes or full QuickBooks tax configuration.

Current rule:

- if the quote has tax, QuoteFly warns the user before push
- user should review the invoice tax settings inside QuickBooks after sync

This is deliberate. QuickBooks tax behavior varies by company configuration, so a half-correct tax sync is worse than a clear review step.

## Recommended Launch Positioning

Use this wording externally for now:

- `QuickBooks Online connection and invoice push available`
- `Invoice/payment status refresh available`
- `Advanced two-way sync and webhook automation coming next`

Do **not** claim:

- fully automatic payment reconciliation
- automatic tax sync
- full accounting sync

## Owner Test Matrix

Run the full owner-side verification flow here:

- [quickbooks-owner-testing-checklist.md](c:\Users\rcazarez\Projects\quotefly\docs\integrations\quickbooks-owner-testing-checklist.md)

## Next Engineering Step After This

1. Add Intuit webhook endpoint and signature verification
2. Subscribe to `Invoice` and `Payment` events
3. Update local invoice sync state automatically when invoices are edited or paid in QuickBooks
