# QuoteFly API Documentation

Last updated: 2026-08-22

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

Legacy quote job statuses:

- `NOT_STARTED`
- `SCHEDULED`
- `IN_PROGRESS`
- `COMPLETED`

Operational job execution state lives on `/v1/jobs` after a quote is accepted.

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

Updates quote metadata, totals, commercial lifecycle status, or after-sale follow-up status. At least one field is required.

`jobStatus` remains readable on Quote responses for one compatibility release, but it is no longer writable. Job scheduling, dispatch, progress, and completion are authoritative on the linked `Job`. A standalone attempt to write `jobStatus` returns `409 QUOTE_JOB_STATUS_MOVED`. Older quote-sheet clients may continue sending `quote.jobStatus`; the server accepts and ignores that field.

`GET /v1/workspace/follow-up` likewise exposes a one-release flat `jobStatus` compatibility projection alongside the nested `job.status`. Both values are derived from the active authoritative `Job`; stale legacy `Quote.jobStatus` data is never used as Job state or accepted as Job write authority.

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

Restores the commercial quote content from a revision snapshot. Requires a plan with quote version history. Historical job/dispatch and after-sale operational fields are ignored. Restoring an accepted snapshot creates or returns the single linked, initially `UNSCHEDULED` Job.

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

## Jobs, Booking, And Dispatch

Accepted quotes create separate job records. The quote remains the customer-approved commercial record; the job owns assignment, schedule, dispatch state, access instructions, and internal execution notes.

Every newly created Job begins as `UNSCHEDULED`, including quotes that carry a legacy Quote `jobStatus`. When the first authoritative Job reaches `COMPLETED`, the source accepted quote moves from after-sale `NOT_READY` to `DUE` with a due time seven days after Job completion. Existing manual `DUE` or `COMPLETED` follow-up state is never overwritten.

Job statuses:

- `UNSCHEDULED`
- `SCHEDULED`
- `DISPATCHED`
- `IN_PROGRESS`
- `COMPLETED`
- `CANCELED`

Appointment statuses:

- `SCHEDULED`
- `DISPATCHED`
- `ARRIVED`
- `COMPLETED`
- `CANCELED`

### `GET /v1/jobs?limit=25&offset=0&status=SCHEDULED&mine=true&search=roof`

Lists visible jobs for the authenticated tenant. Owners/admins can view all visible tenant jobs; members only see self-assigned work linked to records they are allowed to access.

Supported query parameters:

- `limit`, `offset`
- `mine=true|false`
- `status`
- `customerId`
- `assignedTenantUserId` for owners/admins
- `search` across job number, title, customer, and source quote title

### `GET /v1/jobs/:jobId`

Returns one visible job with customer, source quote, assignment, accepted scope snapshot, service address snapshot, and lifecycle timestamps.

### `GET /v1/jobs/schedule?fromUtc=...&toUtc=...&mine=false&limit=25&offset=0`

Lists a compact projection of visible job appointments across jobs for a bounded schedule window. The maximum schedule window is 35 days. Owners/admins can view all visible tenant appointments; members only see appointments attached to jobs they are allowed to access. `fromUtc` and `toUtc` must be ISO 8601 date-times with an explicit offset (`Z` or `+/-HH:MM`); offsetless local date-times are rejected.

The schedule projection contains the appointment identity, assignee, status, start/end, timezone, optimistic version, and minimized job/customer/source-quote identity. It intentionally excludes booking instructions, creator identity, soft-delete fields, audit timestamps, and appointment lifecycle timestamps. Use the job appointment list/detail workflow when those fields are required.

Supported query parameters:

- `fromUtc`, `toUtc`
- `mine=true|false`
- `assignedTenantUserId` for owners/admins
- `limit`, `offset` (`offset` is capped at `1000`)

### `PATCH /v1/jobs/:jobId`

Updates job assignment and dispatch access instructions. Requires owner/admin permissions and the current optimistic `version`.

Member assignment is deliberately consistent across linked records. Before assigning a job to a member, assign the linked customer and source quote to that same member. A job with any active appointment cannot be reassigned or unassigned; cancel or complete its active bookings first. To move booked work to another member: cancel the booking, align the customer and source-quote assignments, update the job assignment, and then create a new booking for the new assignee.

Body:

```json
{
  "version": 3,
  "assignedTenantUserId": "tenant_user_id",
  "accessInstructions": "Gate code 4321. Park on the right side."
}
```

### `GET /v1/jobs/:jobId/appointments?limit=25&offset=0`

Lists bookings for one visible job.

### `POST /v1/jobs/:jobId/appointments`

Creates an overlap-safe booking for the job's assigned member. Requires owner/admin permissions. `startsAtUtc` and `endsAtUtc` must be ISO 8601 date-times with an explicit offset (`Z` or `+/-HH:MM`); the API normalizes and stores the instant in UTC. It also stores the IANA `timeZone` used to create the booking. Appointment duration cannot exceed 14 days. Content-minimal in-app notifications are committed atomically with the appointment event; no email, SMS, external provider, or background delivery worker is used in this release.

Body:

```json
{
  "assignedTenantUserId": "tenant_user_id",
  "startsAtUtc": "2026-08-21T16:00:00.000Z",
  "endsAtUtc": "2026-08-21T18:00:00.000Z",
  "timeZone": "America/Los_Angeles",
  "instructions": "Bring ladder and confirm access on arrival."
}
```

Successful creation returns `201` with `{ appointment, notificationReceipt: { kind: "BOOKED", createdCount } }`. `createdCount` may be zero when the actor is the only active recipient or another candidate cannot currently view the linked Job.

### `PATCH /v1/jobs/:jobId/appointments/:appointmentId`

Updates a booking with optimistic concurrency. Each request is one of two command shapes:

- A **status-only** change containing `version` and `status`. No schedule, assignment, or instruction fields may accompany a status change.
- A manager edit. Rescheduling is allowed only while the current appointment status is `SCHEDULED` and must submit `startsAtUtc`, `endsAtUtc`, and `timeZone` together. Both timestamps require an explicit ISO 8601 offset. Instructions may be edited by an owner/admin.

Assigned members can only perform status-only forward progress on their own booking; they cannot cancel, reschedule, reassign, or edit instructions. Status transitions are restricted to the dispatch flow:

- `SCHEDULED -> DISPATCHED -> ARRIVED -> COMPLETED`
- `SCHEDULED`, `DISPATCHED`, and `ARRIVED` may transition to `CANCELED`

Body:

```json
{
  "version": 2,
  "status": "DISPATCHED"
}
```

Reschedule body:

```json
{
  "version": 2,
  "startsAtUtc": "2026-08-22T09:00:00-07:00",
  "endsAtUtc": "2026-08-22T11:00:00-07:00",
  "timeZone": "America/Los_Angeles",
  "instructions": "Use the west gate."
}
```

Successful status, schedule, or assignment changes return `{ appointment, notificationReceipt }`. The receipt is `{ kind, createdCount }` for `RESCHEDULED`, `DISPATCHED`, `ARRIVED`, `COMPLETED`, or `CANCELED`; an instructions-only edit returns `notificationReceipt: null`.

Stable scheduling conflict codes include:

- `JOB_APPOINTMENT_OVERLAP` (`409`) with the conflicting appointment ID and UTC start/end.
- `JOB_APPOINTMENT_STALE_VERSION` (`409`) when optimistic concurrency loses a race.
- `JOB_APPOINTMENT_RESCHEDULE_NOT_ALLOWED` (`409`) when the current appointment is no longer `SCHEDULED`.
- `JOB_ACTIVE_APPOINTMENTS_REASSIGN_CONFLICT` (`409`) when a job assignment change would strand active bookings.
- `JOB_APPOINTMENT_ASSIGNEE_MISMATCH` (`409`) when a booking assignee does not match the job assignee.
- `JOB_ASSIGNEE_RECORD_SCOPE_MISMATCH` (`409`) when the linked customer and source quote are not assigned to the proposed job assignee.

### `DELETE /v1/jobs/:jobId/appointments/:appointmentId`

Soft-cancels a booking. Requires owner/admin permissions and the current `version`.

Body:

```json
{
  "version": 2
}
```

Successful deletion returns `200` with `{ appointmentId, notificationReceipt: { kind: "CANCELED", createdCount } }` after the soft-cancel, Job event, and notification rows commit atomically.

## In-App Job Notifications

Job appointment mutations create content-minimal in-app notifications in the same database transaction as their immutable Job event. Supported kinds are `BOOKED`, `RESCHEDULED`, `DISPATCHED`, `ARRIVED`, `COMPLETED`, and `CANCELED`. Recipients are derived on the server from active appointment assignment and original booking creator membership, with the actor and duplicates excluded. Browser input can never choose a recipient.

Notification storage excludes customer contact details, addresses, instructions, notes, job scope, message bodies, free-form prose, and provider data. All endpoints use the authenticated live membership, forced tenant RLS, current Job visibility policy, and `Cache-Control: private, no-store`. A notification is hidden if its recipient no longer has access to the linked Job.

### `GET /v1/notifications?filter=all&limit=25&cursor=...`

Returns newest-first visible notifications. `filter` is `all` or `unread`; `limit` is capped at `100`; `cursor` is an opaque keyset cursor returned as `page.nextCursor`. This `GET` is read-only. New rows remain `AVAILABLE` until the recipient explicitly marks them read; that command records `DELIVERED` and `readAtUtc` together.

### `GET /v1/notifications/summary`

Returns `{ unreadCount, totalCount, latestCreatedAtUtc }` for visible notifications belonging to the authenticated recipient.

### `POST /v1/notifications/:notificationId/read`

Marks one visible recipient notification read. The command is idempotent and accepts no recipient or tenant identity. Inaccessible, cross-recipient, and cross-tenant IDs all return the same `404 NOTIFICATION_NOT_FOUND` response.

### `POST /v1/notifications/read-all`

Marks visible unread notifications through a server-owned transaction cutoff and returns `{ updatedCount, cutoffAtUtc }`. Notification producers and read-all serialize on a transaction-scoped tenant/recipient lock; the cutoff comes from the database clock only after the read-all transaction owns that lock. A producer that owns the lock first is included after it commits. A producer that obtains the lock after read-all remains unread, even if its transaction began earlier.

Release operations must apply the checked migration before the API change and drain every pre-lock API/worker process before claiming this cutoff guarantee. During a mixed-version window, an older appointment writer can still bypass the recipient lock. For application rollback, drain the new writers before reverting and leave the additive table/migration in place; do not drop the notification table or its retained rows as part of an application rollback.

Notification inbox retention is automated as a tenant-scoped soft archive: read rows become eligible 90 days after `readAtUtc`, while never-read rows remain available for 365 days after `createdAt`. The run-once worker is dry-run by default; an apply run additionally requires `ENABLE_NOTIFICATION_RETENTION_WORKER=true` and the `--apply` argument. It uses only the least-privileged runtime `DATABASE_URL`, forced tenant RLS, a tenant advisory lock, 250-row `SKIP LOCKED` batches, and a maximum of 5,000 rows per tenant/run. Logs contain aggregate counts only. Archived rows disappear from list, unread, pagination, and summary responses, but their content-minimal source rows remain for audit and backup compatibility. Runtime `DELETE` and `TRUNCATE` stay revoked; any future physical purge requires a separate backed-up, explicitly authorized policy and migration.

### `GET /v1/jobs/:jobId/notes?limit=25&offset=0`

Lists internal job notes. Notes are tenant-confidential execution data and are not shown on customer PDFs.

### `POST /v1/jobs/:jobId/notes`

Adds an internal job note.

Body:

```json
{
  "body": "Crew completed prep work; return tomorrow for finish coat."
}
```

### `DELETE /v1/jobs/:jobId/notes/:noteId`

Soft-deletes a note. The note creator or an owner/admin can remove it.

## Kody Schedule, Booking, And Dispatch Assistance

### `POST /v1/ai/assistant`

Kody supports deterministic schedule queries and reviewed booking/dispatch preparation through the existing authenticated assistant endpoint. These tools do not call an LLM, consume AI credits, or write a Job, appointment, or Job event.

Example request:

```json
{
  "message": "Show my schedule tomorrow",
  "tool": "LIST_SCHEDULE",
  "context": {
    "currentPage": "jobs",
    "jobId": "optional-visible-job-id",
    "appointmentId": "optional-visible-appointment-id"
  }
}
```

Supported deterministic tools:

- `LIST_SCHEDULE` returns a bounded tenant-local day, Monday-aligned week, or rolling next-seven-day schedule. Its `OPEN_SCHEDULE` handoff carries `range: "day" | "week" | "next7"` and the exact tenant-local start date, so a rolling window is not realigned to Monday. Members are always restricted to their own assigned work, even if the prompt or client context asks for another assignee. Owners/admins may query all visible tenant appointments or explicitly request their own schedule.
- `PREPARE_BOOKING` is available only to owners/admins with assignment-management permission. It resolves one visible active Job and assignee and returns an `OPEN_BOOKING_REVIEW` action. Missing duration, ambiguous targets, nonexistent DST wall times, and unresolved AM/PM input fail closed. DST folds return explicit offset choices.
- `PREPARE_DISPATCH` resolves one visible `SCHEDULED` appointment and returns an `OPEN_DISPATCH_REVIEW` action. Assigned members may prepare dispatch only for their own appointment; owners/admins may use the wider visible scope.

Assistant schedule results intentionally exclude service addresses, booking instructions, customer contact details, quote content, prices, costs, margins, provider identifiers, and deleted/archived records. Tenant, role, capabilities, assignment, and data classification always come from live authenticated server state, never from the prompt or browser payload.

Booking and dispatch actions are review handoffs, not mutations. The Jobs workspace refetches the current authorized record, validates the expected assignment/status/version, and uses the normal versioned Jobs appointment endpoint for the final write. Kody reports success only after that endpoint succeeds. The appointment endpoint atomically creates any eligible in-app technician/booking-creator notification; it never notifies the customer or calls email, SMS, AI, or another external provider.

Deterministic tools remain available when the tenant has reached its paid Kody limit because they make no provider call, create no usage reservation, and record zero AI credits. Provider-backed drafting and analysis use the atomic paid-AI usage contract below and fail closed when capacity or accounting is unavailable.

## Atomic Paid-AI Usage Contract

Every OpenAI request is made through the backend provider gateway. The gateway disables implicit provider retries and requires a committed tenant-period reservation before each provider call. Database transactions remain short and never span the external request. Successful calls settle their observed token cost; a provider-started timeout, missing usage report, or other uncertain result is conservatively charged at its precomputed ceiling and is never automatically replayed.

Paid user operations require an `Idempotency-Key` header containing 16–191 ASCII letters, digits, `.`, `_`, `:`, or `-`. This applies to provider-backed `POST /v1/ai/assistant` requests, `POST /v1/ai/business-insights`, `POST /v1/quotes/ai-suggest`, and the provider-capable internal AI quality test. Deterministic Kody tools do not require the header. Keys are hashed and unique per tenant and operation kind across billing period boundaries; request bodies and provider output are not retained for replay.

For one rolling-client release only, the three public paid endpoints accept a completely absent `Idempotency-Key` from the previously deployed web client. The API synthesizes a unique request-correlated key, still performs the full atomic reservation/settlement/audit workflow, emits `X-QuoteFly-AI-Idempotency-Compatibility: synthesized-request-key`, and records only a content-free server warning. A synthesized key provides no retry deduplication guarantee. An explicitly supplied empty, short, oversized, multi-value, or otherwise malformed key still fails with `400 IDEMPOTENCY_KEY_REQUIRED`; the internal AI quality endpoint remains strict. Do not remove this fallback from the first rollout candidate. Retirement requires at least 14 days on the new web/API, seven consecutive days with zero compatibility hits on all three routes, a normal keyed success on every route, and proof that cached old clients have drained.

Stable failures:

- `400 IDEMPOTENCY_KEY_REQUIRED` when an explicit paid-request key is malformed (and for missing keys once the one-release public compatibility fallback is removed).
- `402 AI_USAGE_LIMIT_REACHED` when completed plus in-progress usage has exhausted the applicable tenant limit. The response may include `renewsAtUtc`.
- `409 AI_USAGE_REQUEST_IN_PROGRESS` when the same request key is active.
- `409 AI_USAGE_REQUEST_ALREADY_PROCESSED` when the key is terminal or is reused with different input.
- `503 AI_USAGE_ACCOUNTING_UNAVAILABLE` when reservation, settlement, pricing validation, or immutable usage-audit persistence cannot be proven. Generated output is suppressed in this state.

Usage periods are half-open billing-cycle intervals. Paid tenants use Stripe subscription-item `[current_period_start,current_period_end)` exactly; active trials use `[trialStartsAtUtc,trialEndsAtUtc)`. QuoteFly never guesses a paid start by subtracting one month from the end, so prorated and anchored cycles retain their provider-authoritative boundaries. Superusers use UTC calendar months. A provider call crossing a boundary settles into the period where its root reserved.

Paid runtime access also requires a stored Stripe customer, Stripe subscription, mapped QuoteFly plan, active status, and unexpired provider period. Orphan `active` rows fail closed and are mandatory reconciliation failures. A local QuoteFly trial remains valid with no Stripe subscription, including the normal customer-only state created when checkout is opened and abandoned. Once a trial has a Stripe subscription ID, its customer and mapped plan binding are mandatory and the reconciliation gate verifies its exact Stripe trial dates.

During the one-release database/client transition, a paid/trial row missing an authoritative start remains readable through the already-backfilled UTC calendar bucket, labeled `periodSource: "UTC_CALENDAR_LEGACY"` and `billingCycleReconciliationPending: true`. Its normal calendar renewal claim is suppressed (the separately stored Stripe end may still be shown), and all paid provider authorization fails closed with `503 AI_USAGE_ACCOUNTING_UNAVAILABLE` until the full Stripe reconciliation command persists both bounds and rebuilds current-period totals. Session and paid-operation usage responses otherwise expose completed, in-progress, effective, and remaining percentages; `activeReservationCount`; `enforcementMode`; `limitReached`; period source; and renewal boundaries. Availability uses effective usage (completed plus active reservations). Raw spend and limit amounts are returned only to roles with internal-cost visibility.

Stripe access revocations commit without waiting for usage aggregation, so cancellation, `past_due`, or another non-entitled state blocks the next protected mutation even while an older AI request is in flight. A delayed renewal does not wait for an active request reserved into the old period; that request remains old-period usage. If active work belongs to the exact target period, webhook synchronization commits the new billing bounds and defers only the aggregate rebuild until the request settles. The post-drain reconciliation command still fails that candidate until its target-period holds clear.

`AiUsagePeriod` and `AiUsageReservation` are C3 financial-confidential, content-free, excluded from RAG/vector indexing, and protected by forced PostgreSQL RLS. Runtime access omits `DELETE` and `TRUNCATE`. During the rolling-deployment compatibility window, a database trigger accounts legacy unlinked `AiUsageEvent` inserts exactly once; new reservation-linked events bypass that bridge to prevent double counting. The trigger must remain in the first rollout because migrations run before old API/worker drain. A later additive migration may remove it only after every old API and AI worker is stopped, exact Stripe-period reconciliation is clean, and no unlinked positive-credit event has appeared since the new API start. Historical unlinked events remain part of reconciliation and are never rewritten into fabricated reservations.

## Invoice Ledger And Internal Invoice API

QuoteFly stores tenant-scoped invoice records for completed jobs or accepted quote snapshots. These endpoints create only QuoteFly-owned ledger records; they do not create Stripe, Square, or QuickBooks provider invoices and do not process payments.

Workspace behavior:

- Accepted Quote detail can create or display its linked internal invoice.
- Completed Job detail can create or display the same linked invoice. Incomplete jobs remain read-only until completion.
- Owners/admins can create invoices. Assigned members can read an invoice only when the linked job, customer, and accepted source quote remain assigned and visible to them.
- The optional due date is chosen in tenant-local calendar time and persisted as UTC.
- The UI confirmation explicitly states that this action does not send the invoice, charge the customer, or create anything in QuickBooks, Stripe, or Square.

Current data foundation:

- `Invoice` links one tenant invoice to one `Job`, one accepted source `Quote`, and one `Customer`.
- `InvoicePayment` stores provider-safe payment status records. Payment processing remains in Stripe, Square, QuickBooks, or another payment provider; QuoteFly does not store card or bank details.
- `InvoiceEvent` is immutable transition/idempotency evidence. Runtime access is SELECT/INSERT only.
- All three tables use forced PostgreSQL RLS and are included in readiness checks.
- Invoice amounts, payment records, and provider identifiers are excluded from RAG/vector indexing until explicit Kody invoice tools are designed and reviewed.

### `GET /v1/invoices?limit=25&offset=0&status=DRAFT&paymentStatus=PENDING&mine=true`

Lists visible tenant invoices. Owners/admins can view all active tenant invoices; members only see invoices tied to jobs, customers, and source quotes assigned to them.

Supported query parameters:

- `limit`, `offset`
- `mine=true|false`
- `status`
- `paymentStatus`
- `customerId`
- `jobId`
- `sourceQuoteId`
- `search` across invoice number, invoice title snapshot, customer name, job title, and source quote title

### `GET /v1/invoices/:invoiceId`

Returns one visible invoice with minimized customer, job, and accepted source quote summaries. Tenant identifiers, provider payment identifiers, internal costs, margins, and stored scope narrative are not included.

### `POST /v1/invoices`

Creates an internal QuoteFly invoice from either an accepted quote or a completed job. Requires owner/admin permissions and an `Idempotency-Key` header. Amounts, title, scope, and document language are copied from the accepted quote/job snapshot; the browser cannot supply invoice amounts.

Body from accepted quote:

```json
{
  "sourceQuoteId": "quote_id",
  "dueAtUtc": "2026-09-01T17:00:00.000Z"
}
```

Body from completed job:

```json
{
  "jobId": "job_id"
}
```

Responses:

- `201` creates a new invoice.
- `200` with `"duplicate": true` replays the same idempotency key or returns the existing active invoice for the same job/source quote.
- `403 INVOICE_FORBIDDEN` for non-manager creation attempts.
- `409 INVOICE_QUOTE_NOT_ACCEPTED` when the source quote is not accepted.
- `409 INVOICE_JOB_NOT_COMPLETED` when creating from a job that is not completed.
- `409 INVOICE_IDEMPOTENCY_KEY_REUSED` when the same idempotency key is reused for a different payload.

Provider invoice creation remains behind the existing QuickBooks routes for now. Before Jobs-to-QuickBooks or Jobs-to-Stripe invoice creation is exposed, add a durable `PROCESSING` claim/reconciliation path so concurrent clicks or uncertain provider timeouts cannot create duplicate external invoices.

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
- Run `npm run prisma:migrate:deploy` from the isolated migration service with `DIRECT_DATABASE_URL` and wait for it to finish successfully before promoting the API. Start the long-running API with `npm run start:prod` using only the least-privileged runtime `DATABASE_URL`; `start:prod` does not run migrations.
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
