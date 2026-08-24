# QuickBooks API Progress

Last updated: 2026-08-23

Status: Provider foundation present but production workflows paused and unmarketed.

## Current supported accounting workflow

- Create and review an internal QuoteFly invoice from an accepted quote or completed Job.
- Export accounting data through the QuickBooks-friendly CSV workflow.
- Allow current owners/admins to inspect local QuickBooks configuration state or disconnect locally stored credentials.

QuoteFly does not currently offer production QuickBooks Online connection, invoice creation, invoice-status refresh, payment reconciliation, tax sync, or webhook automation.

## Paused provider foundation

The repository contains legacy foundations for OAuth, encrypted token storage, customer/item mapping, Quote-based invoice push, remote status refresh, webhook signature verification, and webhook event records. These paths are not safe enough to enable or market yet.

`QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED=false` is the required release posture:

- provider-capable connect/callback/push/refresh paths fail with stable `503` before provider activity;
- signed webhooks are validated and return retryable `503` without acknowledgement or provider refresh;
- when the legacy provider flag is explicitly enabled in a controlled test, taxable pushes fail with stable `422`; while the release flag is false, push requests return provider-unavailable `503` first;
- current owner/admin membership is required for connection metadata, local preview, disconnect, or provider-capable actions.

## API surface while paused

- `GET /v1/integrations/quickbooks/status` — owner/admin local configuration state.
- `GET /v1/integrations/quickbooks/quotes/:quoteId/sync-preview` — owner/admin local preview only.
- `POST /v1/integrations/quickbooks/disconnect` — owner/admin local credential cleanup.
- `POST /v1/integrations/quickbooks/connect` — stable provider-unavailable `503`.
- `GET /v1/integrations/quickbooks/callback` — stable provider-unavailable `503` before token exchange.
- `POST /v1/integrations/quickbooks/quotes/:quoteId/push-invoice` — stable provider-unavailable `503`; taxable legacy requests remain blocked until the tax contract is approved.
- `GET /v1/integrations/quickbooks/quotes/:quoteId/invoice-status` — stable provider-unavailable `503` before refresh/fetch.
- `POST /v1/integrations/quickbooks/webhook` — signature/body validation followed by retryable provider-unavailable `503`.

## Database foundation and remaining isolation work

Existing records include `QuickBooksConnection`, `QuickBooksCustomerMap`, `QuickBooksItemMap`, `QuickBooksInvoiceSync`, and `QuickBooksWebhookEvent`. Before enablement, the provider release must add forced RLS, composite tenant integrity, and two-tenant runtime-role denial coverage for every table and relation.

## Launch blockers for provider enablement

1. Replace the legacy Quote push with a durable Invoice-based `PROCESSING` claim.
2. Reconcile timeout/crash/unknown provider results without replaying invoice creation.
3. Persist webhooks durably before acknowledgement and process them through a leased retry worker.
4. Add approved tax mapping; do not downgrade tax failure to a warning.
5. Add explicit customer/item mapping review and duplicate protection.
6. Add provider reconciliation, replay, process-restart, concurrent request, role-removal, and tenant-isolation tests.
7. Produce provider inventory, alerts, rollback, credential rotation, and sandbox-to-production evidence.

These are Phase 4 provider-sync requirements, not post-launch enhancements. QuickBooks Desktop remains a separate integration architecture.

## Official references

- [QuickBooks Online OAuth 2.0](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0)
- [QuickBooks Online invoice workflow](https://developer.intuit.com/app/developer/qbo/docs/workflows/create-an-invoice)
- [QuickBooks Online webhooks](https://developer.intuit.com/app/developer/qbo/docs/develop/webhooks)
