# QuoteFly SaaS Subscription Tiers

This document defines the three paid SaaS tiers and the Stripe product/price mapping.

## Tier Structure

### Starter (`starter`)

- Price: `$19/month`
- Launch availability: `Sellable now`
- Intended buyer: solo operators and early-stage contractors
- Core limits:
  - Up to 600 quotes/month
  - Up to 7 team members
  - 30-day quote history
- Included capabilities:
  - AI-assisted quote credits (30 per month)
  - Fast customer intake and lead pipeline
  - Branded PDF quote generation
  - QuickBooks-friendly invoice CSV export
  - Email support

### Professional (`professional`)

- Price: `$59/month`
- Launch availability: `Visible, not sellable yet`
- Intended buyer: growing contractor teams
- Core limits:
  - Up to 5,000 quotes/month
  - Up to 15 team members
  - 180-day quote history
- Included capabilities:
  - Everything in Starter
  - AI-assisted quote credits (300 per month)
  - Advanced analytics and reporting
  - Customer communication log
  - Quote versioning and history
  - Multi-trade support
  - Priority email and chat support

### Enterprise (`enterprise`)

- Price: `$249/month`
- Launch availability: `Visible, not sellable yet`
- Intended buyer: larger operations requiring governance and integration
- Core limits:
  - Unlimited quotes
  - Unlimited team members
  - Full historical access
- Included capabilities:
  - Everything in Professional
  - AI-assisted quote credits (800 per month)
  - QuickBooks-friendly export workflow with direct sync roadmap
  - API access
  - Custom branding and integration support
  - Dedicated account manager
  - SLA and priority support
  - Audit logs

## AI Usage Notes

- AI is metered by prompt usage, not by quotes sent.
- Each AI draft or AI revision consumes `1` AI credit.
- Manual quote edits do not consume AI credits.

## Stripe Product Setup

Create three recurring monthly Prices in Stripe:

- `QuoteFly Starter Monthly` -> `STRIPE_PRICE_ID_STARTER`
- `QuoteFly Professional Monthly` -> `STRIPE_PRICE_ID_PROFESSIONAL`
- `QuoteFly Enterprise Monthly` -> `STRIPE_PRICE_ID_ENTERPRISE`

Current launch posture:

- `Starter` is the only plan sold at launch.
- `Professional` and `Enterprise` may stay visible in the app and on the pricing page, but checkout remains off until those workflows are hardened.

Recommended metadata on each Stripe Product:

- `app_plan_code`: `starter` | `professional` | `enterprise`
- `app_plan_name`: display name
- `billing_interval`: `monthly`

## Environment Variable Mapping

Backend (`.env` and Railway):

- `STRIPE_PRICE_ID_STARTER=price_...`
- `STRIPE_PRICE_ID_PROFESSIONAL=price_...`
- `STRIPE_PRICE_ID_ENTERPRISE=price_...`

## Webhook Billing State (planned)

Use Stripe webhooks to keep tenant access in sync:

- `checkout.session.completed`
- `checkout.session.expired`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`
