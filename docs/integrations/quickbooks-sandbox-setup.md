# QuickBooks Online sandbox setup

Status: operator runbook for a separately authorized Intuit sandbox test. This does not authorize production credentials, live accounting data, provider enablement, deployment, or database migration.

Use an Intuit Developer sandbox company for the first end-to-end test. A paid QuickBooks Online subscription or trial is not required for normal development testing, and a real trial company risks writing test customers, invoices, and payments into live books.

## Current QuoteFly staging topology

As of 2026-08-31, the isolated provider test surface is:

- web: `https://staging.quotefly.us`;
- API: `https://api-staging.quotefly.us`;
- OAuth callback: `https://api-staging.quotefly.us/v1/integrations/quickbooks/callback`;
- future webhook endpoint: `https://api-staging.quotefly.us/v1/integrations/quickbooks/webhook`.

DNS, TLS, API liveness, database readiness, trusted-origin CORS, least-privileged runtime login, staging-page `noindex`, and the OAuth authorization handoff have been verified. Public staging signup is disabled outside a short, monitored owner-registration window. The staging API currently permits OAuth/provider connection only. Hosted payments, reconciliation, CDC, and webhook processing remain disabled, and no webhook verifier is configured.

The remaining OAuth proof is an owner action in a real browser: approve the dedicated Intuit sandbox company, return to QuoteFly, verify the expected company, and stop before **Confirm setup**. Do not use a live QuickBooks company.

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
- a public HTTPS webhook endpoint for the later accounting and reconciliation evidence;
- a named evidence owner who can record the candidate SHA and test outcomes.

Do not paste client secrets, token-encryption keys, refresh tokens, webhook verifier values, OAuth codes, or hosted invoice links into Git, tickets, screenshots, chat, or retained logs.

Follow the [infrastructure secret-handling protocol](../security/infrastructure-secret-handling.md) for every staging setup, credential disclosure, and rotation. Never run a provider command that streams raw environment values into a terminal, CI log, agent transcript, or screenshot. Use the provider dashboard's secret editor for writes and its masked-value view for manual review. Run the fixed presence-only audit profile for the active stage:

| Authorized stage | Audit profile | Exact capability posture |
| --- | --- | --- |
| Connection proof | `quickbooks-oauth` | OAuth-only on; reconciliation, CDC, hosted payments, and signed webhook ingress off |
| Accounting and signed-webhook reconciliation | `quickbooks-reconciliation` | Reconciliation and signed webhook ingress on; CDC and hosted payments off |
| Dropped-webhook recovery | `quickbooks-cdc` | Reconciliation, signed webhook ingress, and CDC on; hosted payments off |
| Hosted-payment proof | `quickbooks-hosted-payments` | Reconciliation, signed webhook ingress, CDC, and hosted payments on |
| Full-runtime compatibility alias | `quickbooks` | Identical to `quickbooks-hosted-payments`; retained so existing operator commands remain valid |

Every QuickBooks profile requires `APP_URL` and `API_URL`. When `QUICKBOOKS_ENVIRONMENT=sandbox`, each profile also requires `QUICKBOOKS_SANDBOX_STAGING_ORIGINS`; production-capable profiles do not require that sandbox-only variable when the environment is production. The OAuth-only profile accepts sandbox only and forbids `QUICKBOOKS_WEBHOOK_VERIFIER`. Reconciliation and later profiles require the verifier because signed webhook ingress is active. All profiles emit fixed names, classifications, expectations, and configured/missing status only, never values. They prove only the invoking process environment, not Railway, Vercel, Intuit, or another remote configuration. Do not use a downloaded `.env` file or a provider CLI environment dump as evidence.

Neon and other managed-PostgreSQL rehearsals must also follow the [PostgreSQL 16+ migration-portability protocol](../deployment/postgresql-migration-portability.md). The QuickBooks quarantine-retention role is cluster-wide, so a second database in one branch is an intentional release test, not an interchangeable application database.

## 1. Create the Intuit test environment

1. Sign in to the Intuit Developer Portal.
2. Create or open the QuoteFly QuickBooks Online app.
3. Use the app's **Development** credentials, not Production credentials.
4. Create or select a dedicated QuickBooks Online sandbox company.
5. Add the exact QuoteFly staging callback URL to the app's redirect URI list:

   `https://api-staging.quotefly.us/v1/integrations/quickbooks/callback`

6. Record, but do not enable, the staging webhook endpoint for the later accounting proof:

   `https://api-staging.quotefly.us/v1/integrations/quickbooks/webhook`

7. Before the later accounting proof, select the current **CloudEvents v1.0** payload format and subscribe only to the supported `Invoice`, `Payment`, and `RefundReceipt` entities. Do not send webhooks to OAuth-only staging. QuoteFly reconciles create, update, and void operations for those entities only after the full accounting runtime is separately enabled and verified.

The redirect URI must match exactly. Keep sandbox and production credentials, callback URLs, webhook configuration, realm IDs, and evidence separate.

Payment deletion is supported as a reconciliation trigger: QuoteFly durably queues the event and, when Intuit confirms that the payment no longer exists, finds the previously linked QuoteFly invoice and rebuilds its collection state from canonical provider evidence. Invoice and RefundReceipt deletion remain unsupported financial mutations; those events fail closed and require operator review instead of silently changing the ledger.

## 2. Configure QuoteFly staging secrets

Set these only in the staging API environment:

```text
QUICKBOOKS_CLIENT_ID=<Intuit development client id>
QUICKBOOKS_CLIENT_SECRET=<Intuit development client secret>
QUICKBOOKS_ENVIRONMENT=sandbox
QUICKBOOKS_SANDBOX_STAGING_ORIGINS=https://<staging-web-origin>,https://<staging-api-origin>
QUICKBOOKS_REDIRECT_URI=https://<staging-api-origin>/v1/integrations/quickbooks/callback
QUICKBOOKS_TOKEN_ENCRYPTION_KEY=<independent random secret of at least 32 characters>
```

Enable only the connection handshake while keeping every accounting workflow off:

```text
QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED=true
QUICKBOOKS_OAUTH_ONLY_MODE=true
QUICKBOOKS_HOSTED_PAYMENTS_ENABLED=false
QUICKBOOKS_RECONCILIATION_WORKER_ENABLED=false
QUICKBOOKS_CDC_WORKER_ENABLED=false
```

`QUICKBOOKS_WEBHOOK_VERIFIER` must remain unset in this profile. OAuth-only mode permits status, connect, callback, and disconnect; it rejects setup confirmation, provider search and mapping, invoice sync, hosted links, webhooks, reconciliation, and CDC with a stable `QUICKBOOKS_OAUTH_ONLY_MODE` response.

After masked configuration review, run the connection-stage check without printing values:

```powershell
npm run infra:variables:audit -- --profile quickbooks-oauth
```

Do not advance directly to the full profile. For each separately authorized phase, change only the documented capability flags and run `quickbooks-reconciliation`, then `quickbooks-cdc`, then `quickbooks-hosted-payments`. The `quickbooks` alias is equivalent to the final hosted-payments profile; it is not an additional phase.

Before changing a flag, record approval, exact candidate SHA, migrated staging database, callback/webhook URLs, test company, evidence owner, and rollback owner. The API refuses sandbox workflows on QuoteFly production origins.

## 3. Prepare the exact staging candidate

1. Confirm the exact candidate passes `npm run verify:launch` against a dedicated migrated test database.
2. Confirm the presence-only audit passes for the authorized stage; for the first proof this is `quickbooks-oauth`.
3. Apply checked-in migrations to an isolated staging database through the migration job, never through the runtime database credential.
4. Start the API from the same exact SHA with the least-privileged `quotefly_runtime` database role.
5. Confirm `/v1/health` and `/v1/ready` succeed before starting a worker or routing the web app to this candidate.
6. For reconciliation and later stages only, start the worker from the same exact SHA, then require a fresh heartbeat and matching API/worker release identity. Keep the worker off for OAuth-only.
7. Deploy the web app from the same exact SHA only after API readiness and, when enabled, worker readiness succeed.
8. Confirm provider logs and access logs do not retain callback query strings or hosted invoice links.
9. Confirm an alert destination exists for OAuth and token-revocation failures. Webhook, reconciliation, and CDC alerts are required before the later accounting proof.
10. Run `node scripts/quickbooks-staging-oauth-smoke.mjs`. It is hard-locked to the approved staging API, creates a disposable staging tenant, verifies the pre-connection fail-closed behavior and Intuit authorization handoff, and never prints credentials, OAuth state, or the authorization URL.

Only then run the connection proof. Mapping, hosted payments, webhooks, and workers remain outside this stage.

## 4. Connect from QuoteFly

1. Ask the staging operator to open a short registration window, create the dedicated test owner, and have the operator disable public registration again. If that owner already exists, sign in normally without reopening registration.
2. Open **Settings → Workspace → QuickBooks Online**.
3. Open **Setup guide**, confirm the environment says **Sandbox**, and select **Connect QuickBooks**.
4. On Intuit's authorization screen, choose the dedicated sandbox company and approve accounting access.
5. Confirm Intuit returns to QuoteFly Settings and the expected sandbox company name appears.
6. Review every readiness check. Do not confirm a different or unexpected company.
7. For the OAuth-only proof, stop before **Confirm setup** and record that the expected company is connected. Setup confirmation belongs to the later reviewed mapping/reconciliation phase.

Members cannot view or manage provider setup. QuoteFly stores OAuth tokens encrypted on the API; the browser never receives them.

## 5. Run one controlled accounting proof

Use fabricated customer details and a non-taxable USD sample invoice.

Advance progressively under the recorded authorization: use `quickbooks-reconciliation` for reviewed mapping, publish, and signed-webhook reconciliation; move to `quickbooks-cdc` only for the approved dropped-webhook repair; move to `quickbooks-hosted-payments` only after reconciliation and payment eligibility evidence pass. At each transition, restart the API, confirm readiness, start or restart the same-SHA worker and confirm its heartbeat, then update the web deployment only if its release changed.

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
