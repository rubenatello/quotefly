# QuickBooks hosted checkout and payment-status acceptance

Owner-selected workflow, November 8, 2026 Pacific: the customer uses **Pay invoice** on a delivered QuoteFly invoice, QuickBooks hosts payment entry and processing, and QuoteFly mirrors the linked invoice's collection state. Quote acceptance remains distinct from invoice payment. Production availability is not approved.

## Current evidence

- Source checkpoint `6d3d04e` passed local `verify:launch`: 427 unit tests, 675 database tests, 197 browser tests and one existing optional browser skip.
- Exact-source remote CI 141 failed before tests because the web lockfile is incomplete on Linux. A successor must pass a clean Linux install and fresh CI.
- The isolated staging API answers health/readiness, but still runs the older guarded source. Reconciliation and monitor workers have no current deployment.
- The owner is signed in to the dedicated US QuickBooks sandbox. Its Accounting/Payments feature labels and development webhook selections are configuration observations, not payment or delivery proof.
- The saved checkpoint's link endpoint is for authenticated managers. The new candidate adds a manager-generated customer invoice PDF containing a vetted QuickBooks Pay button; it remains undeployed and requires the new candidate's tests and reviews.
- The owner's expired staging local trial was extended by seven days through a separately reviewed, audited, one-use transaction. Independent postchecks and the owner's successful refresh verified access; no Stripe or production state changed. This does not supply provider checkout evidence.

## Accounting-sync proof in sandbox

Before a provider write, require corrected supported payment flags, exact-source independent review, green gates, migration rehearsal and staging migration, exact deployed source/runtime checks, synthetic fixture/tenant/realm binding, a ready reconciliation worker and a bounded restoration plan. Never retrieve secrets or replay an uncertain provider CREATE.

Use the preserved valid non-tax fixture for the first diagnostic; keep tax publishing blocked. Keep hosted payments disabled and explicitly request ACH, card, PayPal and Affirm off. Verify the canonical provider identity, amount, tax, methods and delivery state without exposing raw provider payloads. Use a controlled synthetic recipient and do not send an invoice email.

| Scenario | Required observation | Evidence status |
| --- | --- | --- |
| Reviewed invoice publish | Exactly one provider invoice; correct immutable mapping/totals; durable provider identity | Pending |
| Partial recorded payment | Canonical linked payment and positive balance; QuoteFly shows partially paid | Pending |
| Full recorded payment | Canonical linked payments explain zero balance; QuoteFly shows paid | Pending |
| Refund, reversal or payment deletion | Canonical evidence reopens the appropriate balance; history remains intact | Pending |
| Signed event delivery | Valid signature, durable inbox, worker projection and duplicate suppression | Pending |
| Missed or delayed notification | Manual refresh/CDC repairs state without a duplicate payment or invoice | Pending |
| Connection or transport failure | Actionable stale/error state; uncertain CREATE is not retried | Pending |
| End of test window | Same-source guarded configuration restored; all expected synthetic deltas explained | Pending |

## Customer checkout proof

Intuit's [sandbox Pay Now guidance](https://help.developer.intuit.com/s/question/0D5TR00000VIQey0AH/can-you-have-a-pay-now-button-on-invoices-generated-in-the-sandbox-account) says invoice payment options are unsupported in sandbox. Recording a sandbox Payment can prove accounting reconciliation, but cannot prove hosted checkout, processing or settlement. A missing InvoiceLink must remain unavailable/quarantined; do not invent one or bypass its checks.

A real hosted checkout test remains pending a provider-supported environment, eligible merchant, Intuit app approval and the exact-candidate production release gate. Any limited live test needs a concrete reviewed recipient, amount and recovery plan before requesting final owner action. This document authorizes no live charge.

The customer delivery surface must expose only the intended invoice and current authorized payment action, keep internal costs and provider credentials private, and apply no-store/no-referrer protections. Verify mobile and keyboard use, partial/paid/unavailable states, tenant isolation and share/delivery revocation behavior where applicable. A manager-only link test does not satisfy this customer acceptance criterion.
