# QuickBooks Online And Desktop Architecture

**Last updated:** `2026-04-10`

## Why This Matters

If QuoteFly wants to compete seriously in contractor software, QuickBooks compatibility cannot stop at CSV export.

But QuickBooks Online and QuickBooks Desktop are different integration platforms:

- QuickBooks Online is OAuth + REST + webhooks
- QuickBooks Desktop is SDK / Web Connector + qbXML + Windows-hosted synchronization

If we pretend they are the same, we will either overfit the schema to Online or build a Desktop path that fights the current model.

## What Intuit’s Platforms Imply

### QuickBooks Online

Officially documented path:

- OAuth 2.0 authorization
- QuickBooks Online Accounting scope
- REST requests against company `realmId`
- webhook notifications for supported entities like `Invoice`, `Payment`, `Customer`, and `Item`

### QuickBooks Desktop

Officially documented path:

- QuickBooks Web Connector or Desktop SDK
- qbXML request / response flow
- local desktop QuickBooks instance involved in the sync cycle
- SOAP/web service model if using Web Connector

**Inference based on Intuit’s Desktop/Web Connector docs:** Desktop support is not just another API toggle. It needs a Windows-aware sync path and a provider-specific session model.

## Current Schema Assessment

### What is good already

The current models give us a strong base for accounting sync state:

- `QuickBooksCustomerMap`
- `QuickBooksItemMap`
- `QuickBooksInvoiceSync`
- `QuickBooksWebhookEvent`

These concepts are useful for both Online and Desktop.

### What is too QuickBooks Online-specific

`QuickBooksConnection` is currently designed around QuickBooks Online:

- `realmId`
- OAuth token storage
- access-token expiry
- refresh-token rotation
- webhook timestamps

That is valid for QBO launch, but it is not the right permanent shape for dual Online/Desktop support.

## Recommended Schema Direction

### Do not rush a production migration now

Current recommendation:

- keep the existing QBO schema for launch
- do **not** try to force Desktop into the same record immediately

That would create nullable-field sprawl and a messy provider model before Desktop implementation even starts.

### Recommended next-generation model

Before Desktop support begins, introduce a provider-neutral accounting layer:

#### 1. `AccountingConnection`

Generic connection record:

- `id`
- `tenantId`
- `provider`
  - `QUICKBOOKS_ONLINE`
  - `QUICKBOOKS_DESKTOP`
- `status`
- `displayName`
- `connectedAtUtc`
- `lastSyncAtUtc`
- `lastError`
- `createdAt`
- `updatedAt`
- `deletedAtUtc`

#### 2. `QuickBooksOnlineConnection`

Provider-specific child record:

- `accountingConnectionId`
- `realmId`
- `environment`
- encrypted access token
- encrypted refresh token
- token expiry timestamps
- webhook timestamps

#### 3. `QuickBooksDesktopConnection`

Provider-specific child record:

- `accountingConnectionId`
- `desktopCompanyFileLabel`
- `desktopCompanyFileId`
- `desktopOwnerId`
- `webConnectorUsername`
- encrypted `webConnectorPassword`
- `lastWebConnectorSyncAtUtc`
- `desktopSdkVersion`
- `hostedBridgeStatus`

#### 4. Generic maps stay provider-neutral

Rename or evolve:

- `QuickBooksCustomerMap` -> `AccountingCustomerMap`
- `QuickBooksItemMap` -> `AccountingItemMap`
- `QuickBooksInvoiceSync` -> `AccountingInvoiceSync`

Each should reference `accountingConnectionId`.

That gives us one sync concept across providers while preserving provider-specific connection details.

## Recommended API Direction

### Near-term

Keep the current QuickBooks Online routes:

- `/v1/integrations/quickbooks/...`

That is fine for launch.

### Before Desktop support starts

Introduce provider-aware route structure:

- `/v1/integrations/accounting/connections`
- `/v1/integrations/accounting/quickbooks-online/...`
- `/v1/integrations/accounting/quickbooks-desktop/...`

This avoids stuffing Desktop concepts into Online-only handlers.

## Recommended UI/Layout Direction

### Admin

Current Admin section is acceptable for QBO.

Before Desktop:

- convert `QuickBooks Online` block into `Accounting Integrations`
- allow provider cards:
  - QuickBooks Online
  - QuickBooks Desktop
- show one active primary accounting connection per tenant

### Quote Desk

Current quote desk sync card is acceptable, but the label should evolve from:

- `QuickBooks`

to:

- `Accounting Sync`

and then show the connected provider:

- `QuickBooks Online`
- `QuickBooks Desktop`

### Invoice Status

The layout should stay provider-neutral:

- synced / failed / pending
- invoice id / doc number
- balance
- paid/open
- last sync

That UI will work for both providers if the data contract is normalized.

## Desktop-Specific Product Reality

QuickBooks Desktop support is possible, but it is materially heavier than QuickBooks Online.

### Operational implications

Desktop support likely requires one of these models:

1. customer installs and configures QuickBooks Web Connector locally
2. QuoteFly exposes a SOAP endpoint for Web Connector
3. QuoteFly runs a Windows-aware bridge/agent strategy for Desktop sync

That means Desktop is not just a backend feature. It has support, onboarding, and environment requirements.

### Product implication

Desktop should likely be:

- Professional+ or Enterprise-only
- explicitly labeled as a separate setup path

## Recommended Rollout Order

### Phase 1

Finish QuickBooks Online properly:

1. webhook verification
2. invoice/payment updates back into QuoteFly
3. customer/item mapping review UI
4. invoice sync history view

### Phase 2

Refactor connection model to provider-neutral accounting schema.

### Phase 3

Build QuickBooks Desktop pilot:

1. Desktop connection record
2. Web Connector or bridge proof of concept
3. qbXML invoice sync
4. customer + item mapping for Desktop company files

## Recommendation

### Immediate answer

No urgent schema migration is required **right now** to keep the launch moving.

### Strategic answer

Yes, the long-term schema **does** need to become provider-neutral before we add QuickBooks Desktop.

The correct move is:

- launch with the current QBO-specific foundation
- document the provider-neutral evolution now
- refactor before Desktop implementation starts

That preserves momentum without creating a short-sighted schema trap.

## Official References

- QuickBooks Online OAuth 2.0:
  - https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0
- QuickBooks Online webhooks:
  - https://developer.intuit.com/app/developer/qbo/docs/develop/webhooks
- QuickBooks Online invoice workflow:
  - https://developer.intuit.com/app/developer/qbo/docs/workflows/create-an-invoice
- QuickBooks Desktop Web Connector Programmer’s Guide:
  - https://static.developer.intuit.com/qbSDK-current/doc/pdf/QBWC_proguide.pdf
- QuickBooks Desktop SDK Programmer’s Guide:
  - https://static.developer.intuit.com/resources/QBSDK_ProGuide.pdf
