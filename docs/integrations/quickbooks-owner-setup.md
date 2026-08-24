# QuickBooks Owner Setup — Provider Workflows Paused

Status: Legacy provider foundation only. Do not enable or market QuickBooks Online connection, invoice push, status refresh, or webhook processing for the current release.

## Current production boundary

- Keep `QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED=false` in every deployed API environment.
- Connect, OAuth callback exchange, invoice push, remote invoice refresh, and enabled webhook processing return stable `503 QUICKBOOKS_PROVIDER_WORKFLOWS_UNAVAILABLE` before any Intuit provider call.
- A correctly signed webhook is validated and then receives retryable `503` while paused; QuoteFly does not acknowledge and discard the event.
- With the release flag false, every invoice-push request returns provider-unavailable `503` first. If the legacy path is explicitly enabled in a controlled future test, taxable pushes return `422 QUICKBOOKS_TAX_SYNC_UNSUPPORTED` rather than omitting tax or asking the user to repair it after creation.
- QuickBooks status, local preview, and disconnect require a current owner/admin membership. Disconnect remains available for local credential cleanup.
- QuickBooks-friendly CSV export remains the supported accounting handoff.

Do not add `QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED=true` to Railway, Render, a local production profile, or any launch checklist. Existing credentials alone do not authorize provider activity.

## Why the legacy workflow is paused

The existing Quote-based push path does not yet have the release controls required for provider-safe production use:

- a durable Invoice-based `PROCESSING` claim before the provider call;
- uncertain-result and crash reconciliation that prevents duplicate invoices;
- a durable webhook inbox/worker before acknowledgement;
- forced tenant RLS and composite tenant integrity across QuickBooks tables;
- approved tax mapping and reconciliation behavior;
- concurrent push, restart, replay, and two-tenant provider tests.

Until that separate Phase 4 slice is complete, do not run an owner connection or invoice-push test against Intuit.

## Safe environment posture

The deployed environment may retain credentials for future development or local credential cleanup, but the kill switch must remain false:

```env
QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED=false
QUICKBOOKS_CLIENT_ID=
QUICKBOOKS_CLIENT_SECRET=
QUICKBOOKS_ENVIRONMENT=production
QUICKBOOKS_REDIRECT_URI=https://api.quotefly.us/v1/integrations/quickbooks/callback
QUICKBOOKS_WEBHOOK_VERIFIER=
```

Before any rollout, inventory whether a live connection or webhook subscription already exists. A rollback to a binary that predates the kill switch can reopen provider calls if credentials remain configured, so rollback must either preserve an equivalent external block or remove/rotate provider credentials first.

## Approved external wording

Current public wording may say:

- `Create an internal QuoteFly invoice record.`
- `Export invoice data in a QuickBooks-friendly CSV.`

Do not claim QuickBooks Online connection, invoice creation, invoice-status refresh, payment reconciliation, tax sync, or webhook automation is available.

## Future enablement gate

Create a new owner setup guide only after the durable provider workflow has migrated, passed security and two-tenant review, completed reconciliation tests, and received explicit production-enable authorization. The paused test checklist is retained at [quickbooks-owner-testing-checklist.md](quickbooks-owner-testing-checklist.md) only as a record of future acceptance work, not as a launch procedure.
