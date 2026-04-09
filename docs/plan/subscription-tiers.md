# QuoteFly SaaS Subscription Tiers

This document defines the three paid SaaS tiers and the Stripe product/price mapping.

## Tier Structure

### Starter (`starter`)

- Price: `$29/month`
- Intended buyer: solo operators and early-stage contractors
- Core limits:
  - Up to 600 quotes/month
  - Up to 3 team members
  - 30-day quote history
- Included capabilities:
  - SMS job capture
  - Auto-pricing from base rates
  - Branded PDF quote generation
  - Email support

### Professional (`professional`)

- Price: `$79/month`
- Intended buyer: growing contractor teams
- Core limits:
  - Up to 5,000 quotes/month
  - Up to 10 team members
  - 180-day quote history
- Included capabilities:
  - Everything in Starter
  - Advanced analytics and reporting
  - Customer communication log
  - Quote versioning and history
  - Multi-trade support
  - Priority email and chat support

### Enterprise (`enterprise`)

- Price: `$399/month`
- Intended buyer: larger operations requiring governance and integration
- Core limits:
  - Unlimited quotes
  - Unlimited team members
  - Full historical access
- Included capabilities:
  - Everything in Professional
  - QuickBooks Online integration
  - API access
  - Custom branding and integration support
  - Dedicated account manager
  - SLA and priority support
  - Audit logs

## Stripe Product Setup

Create three recurring monthly Prices in Stripe:

- `QuoteFly Starter Monthly` -> `STRIPE_PRICE_ID_STARTER`
- `QuoteFly Professional Monthly` -> `STRIPE_PRICE_ID_PROFESSIONAL`
- `QuoteFly Enterprise Monthly` -> `STRIPE_PRICE_ID_ENTERPRISE`

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
