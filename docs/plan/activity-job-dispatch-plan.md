# Activity Center, Jobs, and Dispatch Plan

Status: Phase 1 implemented, database-backed, and independently approved; pending BCP and deployment authorization

Last updated: 2026-08-20

Owners: Product, Engineering, Security, Operations

## Outcome

Give every QuoteFly user a clear daily work queue, then turn an accepted quote into a separately managed job that can be assigned, scheduled, dispatched, completed, and audited.

The commercial and operational records stay separate:

`Customer -> Quote -> Accepted Quote -> Job -> Appointment / Task / Note`

- A quote remains the customer-approved commercial record.
- A job records execution and dispatch state.
- An activity task records who needs to do what and when.
- An immutable activity event records what actually happened.
- Kody may find, summarize, and prepare actions, but every write uses a normal server-authorized confirmation flow.

## Phase 0 — Workspace UX foundation

Status: Implemented locally; core database-backed responsive E2E evidence complete

- [x] Rename the existing Follow-up workspace surface to Activity while keeping `/app/follow-up` as a compatible route.
- [x] Put Home and Activity in the mobile bottom navigation.
- [x] Compact phone-width queue rows and keep call, email, and primary quote actions at least 44px.
- [x] Use explicit `Due`, `Added`, and `Updated` time labels. Store API timestamps in UTC and render them in workspace local time.
- [x] Use one prominent Kody action on Home and treat Kody as a modal with focus containment below 1024px.

Exit evidence:

- Frontend build, lint, theme/contrast tests, and mobile Playwright coverage pass.
- 360x800, 390x844, 768x1024, 1280x800, and 1440x900 are visually checked in light and dark themes.

## Phase 1 — Assignable ActivityTask

Status: Implemented locally with migrated PostgreSQL, responsive browser evidence, full `verify:ci`, and final security/Opera approval

Add a dedicated `ActivityTask`; do not overload immutable `CustomerActivityEvent` history.

Minimum fields:

- `id`, `tenantId`, `customerId`, optional `quoteId`
- `assignedTenantUserId`, `createdByTenantUserId`, optional `completedByTenantUserId`
- type: `FOLLOW_UP`, `PREPARE_QUOTE`, `SEND_QUOTE`, `CHECK_IN`, `CUSTOM`
- status: `OPEN`, `IN_PROGRESS`, `COMPLETED`, `CANCELED`
- priority: `LOW`, `NORMAL`, `HIGH`, `URGENT`
- bounded `title`, optional bounded `notes`
- `dueAtUtc`, `completedAtUtc`, `canceledAtUtc`
- optional `sourceKey` for automated-task deduplication
- optimistic `version`, `createdAt`, `updatedAt`, `deletedAtUtc`

Implementation checklist:

- [x] Dedicated `ActivityTask` and immutable `ActivityTaskEvent` models.
- [x] Composite tenant/customer/quote/membership integrity, including quote-to-customer consistency.
- [x] Forced RLS and least-privileged runtime grants from the creation migration.
- [x] Tenant-local overdue/today/upcoming windows with 23/25-hour DST tests.
- [x] Strict, idempotent, optimistic-concurrency API mutations and content-minimal audit events.
- [x] Member assignment visibility and reassignment-safe idempotency replay.
- [x] Member-removal protection for active customer, quote, and task assignments.
- [x] Data-governance inventory; task title/notes excluded from RAG/vector indexing.
- [x] My work, Team, and preserved Lead queue UI with 25/50/100 pagination.
- [x] Mobile create, complete, Undo/reopen, light/dark, overflow, and accessibility evidence.
- [x] Home `My day` prefers assigned task summary and safely falls back to derived CRM signals.
- [ ] Read-only Kody task listing and prepare-task confirmation tools.
- [x] Full exact-candidate `verify:ci`, security re-review, and Opera approval.

Database requirements:

- Composite tenant foreign keys for customer, quote, and membership relationships.
- Forced PostgreSQL RLS from the first migration.
- Unique `(tenantId, sourceKey)` when a source key exists.
- Hot indexes for tenant + assignee + status + due date, tenant + customer, tenant + quote, and soft-delete lifecycle.
- Data-governance catalog entries in the same release candidate.

API:

- `GET /v1/activities` with `mine`, status, type, due window, customer, quote, search, `limit`, and `offset`; default 25, max 100.
- `GET /v1/activities/summary` with overdue, today, upcoming, completed, and top-five work.
- `POST /v1/activities`
- `PATCH /v1/activities/:id` with required optimistic version.
- `POST /v1/activities/:id/complete`
- `POST /v1/activities/:id/reopen`
- `DELETE /v1/activities/:id` as a soft delete for owner/admin.

Permissions:

- Owner/admin: see all tenant tasks; assign, reassign, cancel, and manage automation.
- Member: see only self-assigned tasks linked to customers/quotes they are allowed to access.
- Member-created tasks are assigned to the creating member; the browser cannot forge another assignee.
- Tenant-member removal returns `409` while active customer, quote, or activity assignments remain.
- Every mutation revalidates live membership, tenant, assignment, and row version.

## Phase 2 — Accepted Quote to Job

Status: Planned after Phase 1 evidence

- [ ] Centralize quote acceptance in one transactional service.
- [ ] Add locked tenant job-number sequence and one-job-per-accepted-quote invariant.
- [ ] Add Job API, permissions, UI, audit events, and migration tests.

Add a separate `Job` with:

- tenant-local `jobNumber` from a locked `TenantSequence`
- `tenantId`, `customerId`, unique tenant-scoped `sourceQuoteId`
- status: `UNSCHEDULED`, `SCHEDULED`, `DISPATCHED`, `IN_PROGRESS`, `COMPLETED`, `CANCELED`
- snapshot title, scope, service type, and service address
- assigned member, access instructions, optimistic version
- lifecycle UTC timestamps plus archive/delete timestamps

Acceptance must call one shared transactional service. The unique `(tenantId, sourceQuoteId)` constraint makes concurrent acceptance idempotent. Job execution notes or schedule changes never silently rewrite the accepted quote; a commercial scope/price change uses a quote revision or later change-order flow.

## Phase 3 — Booking and dispatch

Status: Planned after Job state-machine evidence

- [ ] Add job appointments, notes, and immutable events.
- [ ] Add overlap-safe booking and day/week schedule UI.
- [ ] Add dispatch/arrival/completion state transitions and assigned-member mobile views.
- [ ] Add durable notification outbox before enabling optional email/SMS delivery.

Add `JobAppointment`, `JobNote`, and immutable `JobEvent`.

Appointments store:

- tenant/job/assigned-member references
- `startsAtUtc`, `endsAtUtc`, and the IANA timezone used to create the booking
- status plus dispatch, arrival, and completion UTC timestamps
- bounded instructions, optimistic version, and soft-delete fields

Prevent double booking with a transaction-level advisory lock on tenant + assignee, followed by an overlap query and insert. Email/SMS providers never run inside the booking transaction. Notifications begin in-app; external delivery later uses a durable tenant-scoped outbox with retry and idempotency.

## Phase 4 — Invoicing and payments

Status: Partial accounting export exists; QuoteFly invoice ledger is not implemented

- [x] QuickBooks CSV export and QuickBooks Online connection/sync foundation.
- [ ] Add a durable PROCESSING claim and uncertain-result reconciliation before exposing concurrent Jobs-to-QuickBooks invoice creation.
- [ ] Add QuoteFly invoice/payment-status ledger linked to Job and accepted Quote.
- [ ] Keep provider payment handling in Stripe/Square/QuickBooks; QuoteFly stores only provider-safe identifiers and status.
- [ ] Add webhook idempotency, refunds/disputes policy, tenant permissions, and reconciliation tests.

## Kody contract

Initial tools are structured database queries, not RAG:

- `LIST_MY_ACTIVITIES`
- `LIST_SCHEDULE`
- `PREPARE_ACTIVITY`
- `PREPARE_BOOKING`
- `PREPARE_DISPATCH`

Rules:

- Tenant, role, capabilities, assignment, and classifications come only from authenticated server state.
- The model never writes SQL and never selects a tenant.
- Narrative task/job fields start excluded from vector indexing.
- Prepare tools return a typed preview and confirmation action; normal API endpoints perform the write after reauthorization.
- The model cannot claim an action happened until the confirmed API result is recorded.

## Classification defaults

- C1: IDs, workflow state, assignment metadata, non-sensitive timestamps.
- C2: task titles/notes, job scope, service address, schedule, instructions, and customer communications.
- C3: internal costs, margins, profitability, and labor-rate analysis.
- C4: provider identifiers, idempotency credentials, secrets, and authorization material; never sent to an LLM or vector index.

## Required QA and release gates

- Cross-tenant guessed task/job/appointment IDs fail at PostgreSQL RLS and at the API.
- Members cannot see or mutate another member's assigned work.
- Forged tenant, role, assignee, and classification values are ignored or rejected.
- Concurrent completion is idempotent; stale versions return `409`.
- Soft-deleted rows disappear from all normal list, summary, search, and Kody paths.
- Pagination defaults to 25 and remains stable at 25/50/100.
- Accepted-quote concurrency creates exactly one job and one job number.
- Appointment overlap races, DST boundaries, and timezone conversion are covered.
- Kody prompt-injection tests prove it cannot escape the authenticated tenant or assignment scope.
- Kody previews create zero rows before user confirmation.
- Fresh-schema migrations, integration tests, security review, responsive Playwright, and Opera approval pass on the exact candidate.

## Release sequence

1. Phase 1 schema, RLS, governance, service, API, and integration tests.
2. Activity Center API/UI plus the Home `My day` summary.
3. Read-only Kody activity tools, then preview/confirm task creation.
4. Phase 2 Job model and accepted-quote service.
5. Phase 3 schedule/dispatch UI and conflict enforcement.
6. Durable notifications and optional provider integrations only after consent, deliverability, and retention policies are approved.

Migrations run through the isolated Railway migration service with `DIRECT_DATABASE_URL`; the long-running API retains only the least-privileged pooled runtime URL.
