# QuickBooks Online sandbox setup

Status: operator runbook for a separately authorized Intuit sandbox test. This does not authorize production credentials, live accounting data, provider enablement, deployment, or database migration.

Use an Intuit Developer sandbox company for the first end-to-end test. A paid QuickBooks Online subscription or trial is not required for normal development testing, and a real trial company risks writing test customers, invoices, and payments into live books.

Official references:

- [Intuit Developer: sandbox environments](https://developer.intuit.com/app/developer/qbo/docs/develop/sandboxes)
- [Intuit Developer: OAuth 2.0](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0)
- [Intuit Developer: webhooks](https://developer.intuit.com/app/developer/qbo/docs/develop/webhooks)
- [Intuit Developer: invoice workflow](https://developer.intuit.com/app/developer/qbo/docs/workflows/create-an-invoice)
- [QuoteFly reconciliation worker operations](quickbooks-worker-operations.md)

## What the owner needs

- an Intuit Developer account;
- a QuickBooks Online app with development credentials;
- one dedicated sandbox company containing sample data only;
- an HTTPS staging web origin and API origin that are not QuoteFly production origins;
- access to the staging provider secret manager and Intuit app settings;
- a public HTTPS webhook endpoint for webhook and reconciliation evidence;
- a named evidence owner who can record the candidate SHA and test outcomes.

Do not paste client secrets, token-encryption keys, refresh tokens, webhook verifier values, OAuth codes, or hosted invoice links into Git, tickets, screenshots, chat, or retained logs.

## 1. Create the Intuit test environment

1. Sign in to the Intuit Developer Portal.
2. Create or open the QuoteFly QuickBooks Online app.
3. Use the app's **Development** credentials, not Production credentials.
4. Create or select a dedicated QuickBooks Online sandbox company.
5. Add the exact QuoteFly staging callback URL to the app's redirect URI list:

   `https://<staging-api-origin>/v1/integrations/quickbooks/callback`

6. Configure the staging webhook endpoint in the Intuit app:

   `https://<staging-api-origin>/v1/integrations/quickbooks/webhook`

7. Select the current **CloudEvents v1.0** payload format and subscribe only to the supported `Invoice`, `Payment`, and `RefundReceipt` entities. QuoteFly reconciles create, update, and void operations for those entities. Delete, merge, and unknown operations are durably quarantined before acknowledgement and never enter the provider-fetch worker because QuoteFly does not yet have an authoritative provider-deletion projection. QuoteFly also accepts Intuit's legacy `eventNotifications` envelope during the provider transition; sandbox evidence must record the selected portal format and prove unsupported operations land in quarantine or the terminal inbox, not the worker queue.

The redirect URI must match exactly. Keep sandbox and production credentials, callback URLs, webhook configuration, realm IDs, and evidence separate.

Unsupported deletion delivery does not block provider enablement: QuoteFly persists and acknowledges it safely without changing the local ledger. A later release must define invoice deletion semantics, update the local ledger atomically, and add sandbox recovery evidence before those events may drive a local financial-state change.

## 2. Configure QuoteFly staging secrets

Set these only in the staging API environment:

```text
QUICKBOOKS_CLIENT_ID=<Intuit development client id>
QUICKBOOKS_CLIENT_SECRET=<Intuit development client secret>
QUICKBOOKS_ENVIRONMENT=sandbox
QUICKBOOKS_SANDBOX_STAGING_ORIGINS=https://<staging-web-origin>,https://<staging-api-origin>
QUICKBOOKS_REDIRECT_URI=https://<staging-api-origin>/v1/integrations/quickbooks/callback
QUICKBOOKS_WEBHOOK_VERIFIER=<Intuit sandbox webhook verifier>
QUICKBOOKS_TOKEN_ENCRYPTION_KEY=<independent random secret of at least 32 characters>
```

Keep provider features off while validating configuration:

```text
QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED=false
QUICKBOOKS_HOSTED_PAYMENTS_ENABLED=false
QUICKBOOKS_RECONCILIATION_WORKER_ENABLED=false
QUICKBOOKS_CDC_WORKER_ENABLED=false
```

Before changing a flag, record approval, exact candidate SHA, migrated staging database, callback/webhook URLs, test company, evidence owner, and rollback owner. The API refuses sandbox workflows on QuoteFly production origins.

## 3. Prepare the exact staging candidate

1. Confirm the exact candidate passes `npm run verify:launch` against a dedicated migrated test database.
2. Apply checked-in migrations to an isolated staging database through the migration job, never through the runtime database credential.
3. Start the API with the least-privileged `quotefly_runtime` database role.
4. Confirm `/v1/health` and `/v1/ready` succeed.
5. Confirm provider logs and access logs do not retain callback query strings or hosted invoice links.
6. Confirm alert destinations exist for OAuth failures, webhook age/retries/dead letters, reconciliation-required operations, token revocation, and CDC lag.

Only then enable the approved staging flags. Start with connection and mapping evidence before hosted payments and workers.

## 4. Connect from QuoteFly

1. Sign in to the staging QuoteFly workspace as its current owner or admin.
2. Open **Settings → Workspace → QuickBooks Online**.
3. Open **Setup guide**, confirm the environment says **Sandbox**, and select **Connect QuickBooks**.
4. On Intuit's authorization screen, choose the dedicated sandbox company and approve accounting access.
5. Confirm Intuit returns to QuoteFly Settings and the expected sandbox company name appears.
6. Review every readiness check. Do not confirm a different or unexpected company.
7. Select **Confirm setup** only when the required checks pass.

Members cannot view or manage provider setup. QuoteFly stores OAuth tokens encrypted on the API; the browser never receives them.

## 5. Run one controlled accounting proof

Use fabricated customer details and a non-taxable USD sample invoice.

1. Create a sample QuoteFly customer, quote, accepted Job, and internal invoice.
2. Open the invoice's QuickBooks review panel.
3. Search the sandbox company and explicitly map the QuoteFly customer to a sandbox QuickBooks customer.
4. Explicitly map every invoice line to an existing sandbox QuickBooks item.
5. Review company, email, totals, due date, line items, and payment-method choices.
6. Publish once and record the resulting QuickBooks document number. Never retry an ambiguous publish blindly.
7. If online payments are eligible and enabled in the sandbox, retrieve the hosted invoice link and confirm it opens only on an approved Intuit/QuickBooks host.
8. Use **Refresh status** or the invoice refresh action and confirm unpaid, partial, paid, refund/reversal, and void projections as the authorized test plan permits.
9. Confirm a duplicate webhook, dropped webhook repaired by CDC, and manual refresh all produce one authoritative ledger outcome.
10. Disconnect and confirm token revocation or the recorded `REVOCATION_PENDING` recovery path.

QuickBooks owns the hosted payment page, payment processing, fees, settlement, and provider accounting record. QuoteFly retrieves the approved link and reconciles status; it does not collect card or bank details.

## Stop conditions

Stop the sandbox run and disable provider workflows if:

- the company name or realm is unexpected;
- a callback can be replayed;
- mapping targets are ambiguous;
- an invoice result is unknown or duplicated;
- a hosted link is not on the approved Intuit/QuickBooks host;
- webhook signatures fail, events are acknowledged before durable persistence, or dead letters are unowned;
- the configured Intuit webhook payload format does not match a recorded signed legacy or CloudEvents test;
- tokens, OAuth query parameters, customer data, or hosted links appear in retained logs;
- tenant isolation, runtime RLS, readiness, or alerting fails.

Follow [QuickBooks owner testing checklist](quickbooks-owner-testing-checklist.md) for the full acceptance evidence. Production use requires separate Intuit production approval/configuration, QuickBooks Payments eligibility, owner authorization, migration approval, provider enablement, and a new Sentinel and Opera review of the exact candidate.
