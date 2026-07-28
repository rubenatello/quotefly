# QuoteFly API Documentation

Last updated: 2026-06-10

This document describes the QuoteFly backend API, recommended usage patterns, and production integration practices. The live API is a Fastify service with all application routes mounted under `/v1`. Swagger UI is also available at `/docs` when the API server is running.

## Base URLs

Local development:

```text
API: http://localhost:4000
Docs: http://localhost:4000/docs
Health: http://localhost:4000/v1/health
```

Production should use the configured `API_URL`, for example:

```text
https://api.quotefly.us
```

## Authentication

Most browser clients authenticate with the HttpOnly session cookie set by `POST /v1/auth/signup` or `POST /v1/auth/signin`.

```ts
await fetch("https://api.quotefly.us/v1/auth/me", {
  credentials: "include",
});
```

The API still accepts `Authorization: Bearer <jwt>` for controlled server-to-server or transition use, but the production browser path should not store JWTs in `localStorage`.

Public or provider-callback endpoints:

- `GET /v1/health`
- `GET /v1/ready`
- `POST /v1/auth/signup`
- `POST /v1/auth/signin`
- `POST /v1/auth/logout`
- `POST /v1/billing/webhook`
- `POST /v1/sms/webhook` when Twilio SMS is enabled
- `GET /v1/integrations/quickbooks/callback`
- `POST /v1/integrations/quickbooks/webhook`

## API Conventions

- All request and response bodies are JSON unless noted.
- PDF and CSV endpoints return binary file responses.
- Timestamps are UTC ISO strings.
- Pagination uses `limit` and `offset`. Default limit is usually `25`; max is `100`.
- Errors generally return `{ "error": "message" }`. Validation errors return `{ "error": "Invalid request data.", "issues": [...] }`.
- Tenant scoping comes from the authenticated session claims. Clients should not send `tenantId` except where an endpoint path explicitly includes it.
- Soft delete and archive behavior is intentional. `DELETE` removes records from the active workspace but keeps history where the schema supports it.

## Recommended Client Workflow

1. Sign up or sign in.
2. Let the browser store the HttpOnly `qf_session` cookie. Frontend requests must use `credentials: "include"`.
3. Call `GET /v1/auth/me` after app load to hydrate user, tenant, plan entitlements, and usage.
4. If onboarding is incomplete, call `GET /v1/onboarding/setup`, then `POST /v1/onboarding/setup`.
5. Search customers before creating a new one with `GET /v1/customers?search=...`.
6. Create or reuse a customer.
7. Create a quote manually with `POST /v1/quotes` or draft from text with `POST /v1/quotes/chat-draft`.
8. Use line-item endpoints for precise quote edits.
9. Preview/download PDF with `GET /v1/quotes/:quoteId/pdf`.
10. Record send/share activity with `POST /v1/quotes/:quoteId/outbound-events` where plan entitlements allow it.
11. Mark quote decisions with `POST /v1/quotes/:quoteId/decision` or update status via `PATCH /v1/quotes/:quoteId`.

## Auth

### `POST /v1/auth/signup`

Creates a user, tenant, owner membership, trial subscription state, branding/preset defaults, sets the session cookie, and returns user/tenant metadata.

Body:

```json
{
  "email": "owner@example.com",
  "password": "minimum-8-chars",
  "fullName": "Ruben Cazarez",
  "companyName": "QuoteFly Services",
  "primaryTrade": "ROOFING",
  "logoUrl": "https://example.com/logo.png",
  "generateLogoIfMissing": true
}
```

### `POST /v1/auth/signin`

Sets the session cookie for the first active tenant membership and returns user/tenant metadata.

Body:

```json
{
  "email": "owner@example.com",
  "password": "password"
}
```

### `GET /v1/auth/me`

Returns the current user, tenant, role, superuser flag, entitlements, and monthly usage snapshot.

Best practice: call this once on app boot and after billing or subscription-changing events.

### `POST /v1/auth/logout`

Clears the session cookie. The frontend should also clear non-sensitive local UI metadata such as cached tenant id or display name.

## Health

### `GET /v1/health`

Returns process liveness without querying PostgreSQL.

Example response:

```json
{
  "status": "ok",
  "service": "quotefly-api",
  "timestamp": "2026-06-10T00:00:00.000Z"
}
```

### `GET /v1/ready`

Returns `200` only when the API can query PostgreSQL. Dependency failures return `503` with a stable response that does not expose connection details:

```json
{
  "status": "ready",
  "service": "quotefly-api",
  "timestamp": "2026-06-10T00:00:00.000Z"
}
```

```json
{
  "error": "Service is not ready."
}
```

## Tenants And Branding

### `GET /v1/tenants`

Returns the authenticated user's current tenant.

### `POST /v1/tenants`

Creates another tenant and links the current user as owner. This is currently a lower-priority V1 route; signup is the preferred tenant bootstrap.

Body:

```json
{
  "name": "Company Name",
  "slug": "company-name"
}
```

### `GET /v1/tenants/:tenantId/branding`

Returns tenant timezone and branding settings. The `tenantId` must match the authenticated tenant.

### `PUT /v1/tenants/:tenantId/branding`

Upserts PDF/UI branding and tenant timezone.

Body fields:

- `logoUrl`: URL or data image URL
- `logoPosition`: `left`, `center`, `right`
- `hideQuoteFlyAttribution`: boolean
- `primaryColor`: hex color such as `#1E6FD8`
- `templateId`: `modern`, `professional`, `bold`, `minimal`, `classic`
- `timezone`: IANA timezone string
- `businessProfile`: email, phone, quote message, and address fields
- `componentColors`: optional PDF color overrides

## Onboarding And Presets

### `GET /v1/onboarding/setup`

Returns tenant setup state, branding summary, default pricing profiles, saved work presets, and supported trades.

### `GET /v1/onboarding/presets/recommended?serviceType=ROOFING`

Returns recommended presets for a trade.

Supported service types:

- `HVAC`
- `PLUMBING`
- `FLOORING`
- `ROOFING`
- `GARDENING`
- `CONSTRUCTION`

### `POST /v1/onboarding/setup`

Saves primary trade, logo/color settings, optional square-foot pricing, and selected presets.

### `POST /v1/onboarding/presets`

Creates, updates, or restores a tenant work preset.

Body:

```json
{
  "serviceType": "ROOFING",
  "name": "Remove old shingles",
  "description": "Tear off and haul away existing shingles",
  "category": "LABOR",
  "unitType": "SQ_FT",
  "defaultQuantity": 1,
  "unitCost": 1.25,
  "unitPrice": 2.5
}
```

Preset categories: `LABOR`, `MATERIAL`, `FEE`, `SERVICE`.

Unit types: `FLAT`, `SQ_FT`, `HOUR`, `EACH`.

## Customers

### `GET /v1/customers?limit=25&offset=0&search=alan`

Lists active customers. Search supports name, email, phone, and normalized phone digits.

### `POST /v1/customers`

Creates a customer or returns duplicate candidates.

Body:

```json
{
  "fullName": "Alan Johnson",
  "phone": "818-233-4333",
  "email": "alan@example.com",
  "notes": "Prefers morning calls.",
  "followUpStatus": "NEEDS_FOLLOW_UP"
}
```

If duplicates are found, the API returns `409` with `code: "DUPLICATE_CANDIDATE"` and `matches`. Then retry with one of:

```json
{
  "duplicateAction": "use_existing",
  "duplicateCustomerId": "customer_id"
}
```

```json
{
  "duplicateAction": "merge",
  "duplicateCustomerId": "customer_id"
}
```

Avoid `create_new` when phone matches exist; the API blocks strong phone conflicts.

### `GET /v1/customers/:customerId`

Returns one active customer.

### `PATCH /v1/customers/:customerId`

Updates customer identity, notes, or follow-up status.

Allowed `followUpStatus` values:

- `NEEDS_FOLLOW_UP`
- `FOLLOWED_UP`
- `WON`
- `LOST`

### `GET /v1/customers/:customerId/activity?limit=25&offset=0`

Returns a combined timeline of customer activity, quote revisions, and outbound quote events.

### `POST /v1/customers/:customerId/archive`

Archives the customer and active related quotes.

### `DELETE /v1/customers/:customerId`

Soft-deletes the customer and active related quotes.

## Quotes

Quote statuses:

- `DRAFT`
- `READY_FOR_REVIEW`
- `SENT_TO_CUSTOMER`
- `ACCEPTED`
- `REJECTED`

Job statuses:

- `NOT_STARTED`
- `SCHEDULED`
- `IN_PROGRESS`
- `COMPLETED`

After-sale follow-up statuses:

- `NOT_READY`
- `DUE`
- `COMPLETED`

Line sections:

- `INCLUDED`
- `ALTERNATE`

### `GET /v1/quotes?limit=25&offset=0&status=DRAFT&customerId=...&search=roof`

Lists active quotes with optional status, customer, and search filters.

### `POST /v1/quotes`

Creates a quote, optionally with initial line items. Prefer sending initial line items in this request instead of creating them sequentially after the quote; this reduces latency.

Body:

```json
{
  "customerId": "customer_id",
  "serviceType": "ROOFING",
  "title": "Roof replacement",
  "scopeText": "Remove existing shingles and install new asphalt shingles.",
  "internalCostSubtotal": 4200,
  "customerPriceSubtotal": 8500,
  "taxAmount": 0,
  "lineItems": [
    {
      "description": "Tear off existing shingles",
      "sectionType": "INCLUDED",
      "quantity": 1250,
      "unitCost": 0.75,
      "unitPrice": 1.5
    }
  ]
}
```

### `GET /v1/quotes/:quoteId`

Returns a quote with customer and active line items.

### `PATCH /v1/quotes/:quoteId`

Updates quote metadata, totals, lifecycle status, job status, or after-sale status. At least one field is required.

Best practice: use line-item endpoints for pricing changes when possible so totals and revision history remain consistent.

### `DELETE /v1/quotes/:quoteId`

Soft-deletes the quote and active line items.

### `POST /v1/quotes/:quoteId/archive`

Archives the quote without deleting it.

### `GET /v1/quotes/:quoteId/pdf?download=true`

Returns a generated quote PDF. Use `download=false` for inline browser preview.

Response headers:

- `Content-Type: application/pdf`
- `Cache-Control: no-store`
- `Content-Disposition: attachment|inline`

### `POST /v1/quotes/:quoteId/decision`

Marks a quote sent or ready for revision.

Body:

```json
{
  "decision": "send"
}
```

Allowed decisions: `send`, `revise`.

### `POST /v1/quotes/:quoteId/line-items`

Creates a quote line item and recalculates totals.

### `PATCH /v1/quotes/:quoteId/line-items/:lineItemId`

Updates a line item and recalculates totals.

### `DELETE /v1/quotes/:quoteId/line-items/:lineItemId`

Soft-deletes a line item and recalculates totals.

### `GET /v1/quotes/history?limit=25&offset=0&customerId=...&quoteId=...`

Lists quote revisions. Plan entitlements may restrict version history.

### `GET /v1/quotes/:quoteId/history?limit=25&offset=0`

Lists revisions for one quote.

### `POST /v1/quotes/:quoteId/history/:revisionId/restore`

Restores a quote from a revision snapshot. Requires a plan with quote version history.

### `GET /v1/quotes/:quoteId/outbound-events?limit=25&offset=0`

Lists communication log entries for a quote. Requires communication-log entitlement.

### `POST /v1/quotes/:quoteId/outbound-events`

Records that a quote was prepared for email, SMS, or copied.

Body:

```json
{
  "channel": "EMAIL_APP",
  "destination": "customer@example.com",
  "subject": "Your QuoteFly quote",
  "body": "Message preview..."
}
```

Channels: `EMAIL_APP`, `SMS_APP`, `COPY`.

### `POST /v1/quotes/invoices/export-csv`

Exports one or more accepted/saved quotes into a QuickBooks-friendly invoice CSV.

Body:

```json
{
  "quoteIds": ["quote_id"],
  "dueInDays": 14
}
```

Response: CSV file.

## AI Quote Endpoints

AI is metered by tenant plan limits and monthly spend caps. The backend owns all OpenAI calls; frontend clients never use OpenAI keys directly.

### `POST /v1/quotes/chat-draft`

Parses free-form job text and creates a draft quote.

Body:

```json
{
  "prompt": "New quote for Alan Johnson 818-233-4333. Roof replacement about 1250 square feet.",
  "customerName": "Alan Johnson",
  "customerPhone": "818-233-4333",
  "customerEmail": "alan@example.com"
}
```

### `POST /v1/quotes/ai-suggest`

Returns a streamed newline-delimited JSON response containing progress events and a final quote suggestion. The stream may emit:

- `{ "type": "progress", ... }`
- `{ "type": "complete", "result": ... }`
- `{ "type": "error", "error": "..." }`

Body:

```json
{
  "prompt": "Add permit fee and clarify cleanup.",
  "quoteId": "quote_id",
  "customerId": "customer_id",
  "serviceType": "ROOFING",
  "currentTitle": "Roof replacement",
  "currentScopeText": "Existing scope...",
  "currentLineItems": []
}
```

### `GET /v1/quotes/:quoteId/ai-runs?limit=25&offset=0`

Lists AI usage trace records for a quote.

## Billing

### `POST /v1/billing/checkout-session`

Creates a Stripe Checkout session for a sellable plan. At launch, only the starter/basic plan is sellable.

Body:

```json
{
  "planCode": "starter"
}
```

### `POST /v1/billing/portal-session`

Creates a Stripe Billing Portal session for the current tenant.

### `POST /v1/billing/webhook`

Stripe webhook endpoint. Requires `stripe-signature` header and raw body validation. Do not call this from the frontend.

Supported event types include:

- `checkout.session.completed`
- `checkout.session.expired`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

## Organization Users

### `GET /v1/org/users`

Lists active tenant members and team-member policy.

### `POST /v1/org/users`

Creates or restores a member. Requires owner or admin permissions and plan capacity.

Body:

```json
{
  "email": "crew@example.com",
  "fullName": "Crew Member",
  "password": "temporary-password",
  "role": "member"
}
```

Roles: `owner`, `admin`, `member`.

### `PATCH /v1/org/users/:tenantUserId`

Updates member role. Owner-only.

### `DELETE /v1/org/users/:tenantUserId`

Soft-removes a member. Owner-only. Owners cannot remove their own active membership.

## QuickBooks Integration

### `GET /v1/integrations/quickbooks/status`

Returns QuickBooks configuration status, connection state, redirect URI, webhook URL, and sync counts.

### `POST /v1/integrations/quickbooks/connect`

Returns an Intuit authorization URL. Requires owner or admin role.

### `GET /v1/integrations/quickbooks/callback`

OAuth callback used by Intuit. Verifies signed state, exchanges code, fetches company info, and stores encrypted tokens.

### `POST /v1/integrations/quickbooks/disconnect`

Disconnects QuickBooks and clears stored access/refresh tokens. Requires owner or admin role.

### `GET /v1/integrations/quickbooks/quotes/:quoteId/sync-preview`

Builds a preview of customer, invoice, and line-item payloads before pushing to QuickBooks.

### `POST /v1/integrations/quickbooks/quotes/:quoteId/push-invoice`

Pushes an accepted quote to QuickBooks as an invoice.

Body:

```json
{
  "createCustomerIfMissing": true,
  "createItemsIfMissing": true,
  "dueInDays": 14,
  "force": false
}
```

Best practice: only call this for `ACCEPTED` quotes after previewing warnings.

### `GET /v1/integrations/quickbooks/quotes/:quoteId/invoice-status`

Refreshes the synced invoice status from QuickBooks.

### `POST /v1/integrations/quickbooks/webhook`

QuickBooks webhook receiver. Requires `intuit-signature` header and raw body signature validation. Do not call this from the frontend.

## SMS Webhook

### `POST /v1/sms/webhook`

Twilio inbound SMS webhook. This route is only registered when `ENABLE_TWILIO_SMS=true`.

Best practices:

- Set `TWILIO_WEBHOOK_AUTH_TOKEN` so signatures are validated.
- Use Twilio form-encoded payloads.
- Map each Twilio destination number to a tenant via `TenantPhoneNumber`.
- Keep this disabled in production until a real Twilio number and signature validation are configured.

## Internal Admin

Internal routes require authentication and a superuser email listed in `SUPERUSER_EMAILS`.

### `GET /v1/internal/ai-quality/summary?days=30`

Returns platform-level AI usage, spend, model breakdown, confidence, and quality signals.

### `GET /v1/internal/ai-quality/tenants?days=30&limit=25`

Returns tenant-level AI usage and quality metrics.

## Production Best Practices

### Security

- Use HTTPS only in production.
- Use a unique `JWT_SECRET` of at least 32 characters.
- Keep `APP_URL`, `API_URL`, and `CORS_ALLOWED_ORIGINS` production-only when `NODE_ENV=production`.
- Never expose backend secrets through Vite `VITE_*` variables.
- Use HttpOnly, Secure, SameSite cookies for browser sessions. Keep web and API on same-site production domains when possible, for example `app.quotefly.us` and `api.quotefly.us`.

### Reliability

- Run `npm run verify` before production handoff.
- Use `npm run start:prod` for API startup so Prisma migrations deploy before the server starts.
- Use `/v1/health` for process liveness and `/v1/ready` for deployment readiness.
- Keep provider webhook event IDs persisted for idempotency.
- Avoid external API calls inside long database transactions.

### Data Safety

- Always scope reads and writes by the authenticated tenant.
- Keep internal cost fields out of customer-visible experiences.
- Treat quote prompts, customer notes, phone numbers, addresses, and PDFs as sensitive business data.
- Archive when users expect reversible cleanup; soft delete when users expect removal from active workspace.

### Performance

- Use paginated list endpoints.
- Search before creating customers to avoid duplicates.
- Create quote line items in the initial `POST /v1/quotes` when possible.
- Use targeted refreshes after mutations instead of reloading every dashboard dataset.
- Use CSV export in batches of up to 100 quote IDs.

### Deployment Readiness

Before public launch, verify:

- `GET /v1/health` works on the production API.
- Signup, signin, onboarding, customer creation, quote creation, PDF generation, and quote status changes work against production services.
- Stripe live Checkout and webhook updates tenant subscription state.
- OpenAI key and model are configured on the API host only.
- QuickBooks OAuth callback URL and webhook URL match Intuit production app settings.
- Twilio remains disabled unless signature validation and destination-number mapping are confirmed.
