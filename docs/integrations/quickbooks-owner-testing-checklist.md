# QuickBooks Owner Testing Checklist

**Goal:** verify the QuickBooks Online connection, invoice push path, and the new webhook intake path from a real tenant.

## 1. Intuit App Configuration

In your Intuit Developer app:

1. Confirm the QuickBooks Online Accounting scope is enabled.
2. Confirm this callback URL is registered exactly:

```text
https://api.quotefly.us/v1/integrations/quickbooks/callback
```

3. Add this webhook endpoint:

```text
https://api.quotefly.us/v1/integrations/quickbooks/webhook
```

4. In the Webhooks area, copy the **Verifier Token**.

## 2. Railway Environment Variables

Confirm these exist in Railway for the API service:

```env
QUICKBOOKS_CLIENT_ID=
QUICKBOOKS_CLIENT_SECRET=
QUICKBOOKS_ENVIRONMENT=production
QUICKBOOKS_REDIRECT_URI=https://api.quotefly.us/v1/integrations/quickbooks/callback
QUICKBOOKS_WEBHOOK_VERIFIER=
```

Set `QUICKBOOKS_WEBHOOK_VERIFIER` to the exact Intuit webhook verifier token.

## 3. Webhook Event Selection

For launch, enable these QuickBooks Online webhook entities:

1. `Invoice`
2. `Payment`

That gives us the event stream we need for invoice-change and payment-status work.

## 4. First Connection Test

1. Sign in as the tenant owner.
2. Open `Admin`.
3. In `QuickBooks Online`, click `Connect QuickBooks`.
4. Complete OAuth consent.
5. Confirm QuoteFly shows:
   - company name
   - realm id
   - connected status

## 5. First Invoice Push Test

1. Create a test customer in QuoteFly.
2. Create a quote with at least 2 line items.
3. Mark the quote `Won`.
4. Open the quote desk.
5. Click:
   - `Preview Mapping`
   - `Push Invoice`
   - `Refresh Status`
6. In QuickBooks Online, confirm:
   - customer was found or created correctly
   - service items were found or created correctly
   - invoice exists with the QuoteFly doc number
   - total looks correct

## 6. Duplicate-Safety Test

Run one test where the QuickBooks company already has:

1. a customer with a similar name
2. a service item with a similar name

Confirm whether QuoteFly:

1. matches correctly
2. creates an unwanted duplicate
3. needs a manual mapping review screen next

This is the most important real-world quality check left.

## 7. Tax Warning Test

1. Create a quote in QuoteFly with tax.
2. Push that quote to QuickBooks.
3. Confirm QuoteFly shows the warning.
4. In QuickBooks, confirm whether tax still needs manual review.

Current expected result:

- QuoteFly warns correctly
- QuickBooks tax still needs manual confirmation

## 8. Webhook Intake Test

After webhooks are configured:

1. Edit an invoice directly inside QuickBooks Online.
2. Wait a few minutes.
3. Confirm the API remains healthy.
4. Confirm the QuickBooks connection in QuoteFly still shows as connected.

For now, the main success condition is that the webhook is accepted and stored safely.

## 9. Payment Refresh Test

1. Record a payment in QuickBooks Online for a pushed invoice.
2. In QuoteFly, use `Refresh Status` on that quote.
3. Confirm:
   - balance updates correctly
   - paid/open state reflects the QBO invoice

Current rule:

- automatic webhook-driven payment reconciliation is **not finished yet**
- manual refresh should still show the current balance correctly

## 10. Report Back

After running the above, report:

1. Did OAuth connect successfully?
2. Did invoice push succeed?
3. Did customer matching behave correctly?
4. Did item matching behave correctly?
5. Did tax need manual repair?
6. Did manual refresh show payment status correctly?
7. Did QuickBooks create any duplicates?

That result set is what we need to raise confidence from “implemented” to “production-trustworthy.”
