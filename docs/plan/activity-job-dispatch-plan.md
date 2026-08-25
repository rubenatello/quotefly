# Activity Center, Jobs, and Dispatch Plan

Status: Phases 0 through 4A, the Job-authority cleanup, calendar, in-app notifications and retention, Kody schedule and quote-review tools, atomic paid-AI ledger, public product story, and default-off QuickBooks containment are committed on `main` at `b72ec1b`; production deployment is not asserted. The current uncommitted workspace adds a provider-safe Phase 4B QuickBooks Invoice foundation plus a focused live-provider Kody evaluation repair. The exact local launch gate and backend, security, UX, and independent Opera reviews pass; external email, SMS, payment, provider enablement, the exact-SHA live-provider rerun, and production rollout remain gated.

Last updated: 2026-08-24

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

Status: Implemented and release-verified on `main`; core database-backed responsive E2E evidence complete

- [x] Rename the existing Follow-up workspace surface to Activity while keeping `/app/follow-up` as a compatible route.
- [x] Put Home and Activity in the mobile bottom navigation.
- [x] Compact phone-width queue rows and keep call, email, and primary quote actions at least 44px.
- [x] Use explicit `Due`, `Added`, and `Updated` time labels. Store API timestamps in UTC and render them in workspace local time.
- [x] Use one prominent Kody action on Home and treat Kody as a modal with focus containment below 1024px.

Exit evidence:

- Frontend build, lint, theme/contrast tests, and mobile Playwright coverage pass.
- 360x800, 390x844, 768x1024, 1280x800, and 1440x900 are visually checked in light and dark themes.

## Phase 1 — Assignable ActivityTask

Status: Implemented on `main` with migrated PostgreSQL, responsive browser evidence, full `verify:ci`, and final security/Opera approval

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
- [x] Read-only Kody task listing and prepare-task confirmation tools.
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

Status: Phase 2A and the Job-authoritative compatibility cleanup are committed and pushed on `main` at `543fc69`; rolling compatibility fields remain intentionally until post-deployment client-drain evidence supports removal

- [x] Centralize quote acceptance in one transactional service.
- [x] Add locked tenant job-number sequence and one-job-per-accepted-quote invariant.
- [x] Add Job API, permissions, UI, audit events, and migration skeleton.
- [x] Add database-backed migration, concurrency, RLS, and member-permission tests.
- [x] Replace remaining legacy quote job-status UI writes with Job-authoritative state while retaining one read-only rolling-compatibility release.

Phase 2 cleanup evidence:

- New accepted-quote Jobs always start `UNSCHEDULED`; old clients may send the legacy Quote `jobStatus`, but the API ignores it and standalone legacy-only writes return `QUOTE_JOB_STATUS_MOVED`.
- Activity and Home use the tenant-scoped Job projection for status, navigation, ordering, and active-job counts; browser drafts and quote mutations no longer carry operational Job state.
- First authoritative Job completion conditionally opens the after-sale follow-up without overwriting manual state, and the additive repair migration is idempotent.
- Exact-candidate `verify:ci` passes with 51 migrations and 177/177 integration tests; focused mobile/desktop Activity coverage passes 3/3; Sentinel approves with no findings and Goldface approves at 98/100.

Add a separate `Job` with:

- tenant-local `jobNumber` from a locked `TenantSequence`
- `tenantId`, `customerId`, unique tenant-scoped `sourceQuoteId`
- status: `UNSCHEDULED`, `SCHEDULED`, `DISPATCHED`, `IN_PROGRESS`, `COMPLETED`, `CANCELED`
- snapshot title, scope, service type, and service address
- assigned member, access instructions, optimistic version
- lifecycle UTC timestamps plus archive/delete timestamps

Acceptance must call one shared transactional service. The unique `(tenantId, sourceQuoteId)` constraint makes concurrent acceptance idempotent. Job execution notes or schedule changes never silently rewrite the accepted quote; a commercial scope/price change uses a quote revision or later change-order flow.

## Phase 3 — Booking and dispatch

Status: Phase 3A, the Phase 3B day/week schedule and safe rescheduling workspace, and the Phase 3C durable in-app notification center/retention worker are committed and pushed on `main` at `543fc69`; external email/SMS delivery remains gated

- [x] Add job appointments, notes, and immutable events.
- [x] Add overlap-safe booking API with tenant/member advisory locking.
- [x] Add dispatch, arrival, completion, and cancellation appointment transitions in the API.
- [x] Add job-detail booking, dispatch status, and internal notes UI with assigned-member mobile visibility.
- [x] Add bounded today/next-7-days schedule overview UI backed by `/v1/jobs/schedule`.
- [x] Add full day/week calendar grid and reschedule controls.
- [x] Add a durable in-app notification outbox before enabling optional email/SMS delivery.

Add `JobAppointment`, `JobNote`, and immutable `JobEvent`.

Appointments store:

- tenant/job/assigned-member references
- `startsAtUtc`, `endsAtUtc`, and the IANA timezone used to create the booking
- status plus dispatch, arrival, and completion UTC timestamps
- bounded instructions, optimistic version, and soft-delete fields

Prevent double booking with a transaction-level advisory lock on tenant + assignee, followed by an overlap query and insert. Email/SMS providers never run inside the booking transaction. Notifications begin in-app; external delivery later uses a durable tenant-scoped outbox with retry and idempotency.

Phase 3A release evidence:

- `prisma/migrations/20260821210000_add_job_booking_foundation` creates `JobAppointment` and `JobNote` with forced tenant RLS, runtime grants, tenant/member/job integrity, bounded appointment windows, optimistic versions, soft-delete fields, and content-minimal events.
- `GET/POST/PATCH/DELETE /v1/jobs/:jobId/appointments` and `GET/POST/DELETE /v1/jobs/:jobId/notes` are implemented behind tenant RLS and live membership/assignment checks.
- Appointment create/update/delete synchronizes the parent `Job` operational status and `scheduledAtUtc` from active appointments.
- `GET /v1/jobs/schedule` returns visible appointments across jobs for a bounded schedule window.
- `web/src/pages/JobsPage.tsx` exposes today/next-7-days schedule overview, booking creation, dispatch transitions, cancellation, internal notes, tenant-local time entry, and safe localized API errors in the Jobs workspace.
- Exact-candidate evidence: the jobs integration suite contains 14 tests, focused Jobs browser coverage passes, and the database-backed `verify:ci` gate passes against the migrated disposable database.

Phase 3B release-candidate evidence:

- Jobs and Schedule are separate URL-backed workspace views with tenant-local day/week/date state and manager team filters; members are forced to their own authorized schedule.
- The calendar retrieves every bounded page or refuses to render an incomplete view, uses a phone/tablet agenda and a seven-column desktop time grid, and keeps short overlapping hit targets independently usable.
- Review-based rescheduling is limited to `SCHEDULED` appointments, requires an atomic UTC start/end/timezone tuple, preserves edits through overlap and stale-version recovery, and explicitly resolves DST folds while rejecting nonexistent local times.
- Calendar responses use a compact tenant-scoped projection; lifecycle changes are status-only and dispatched, arrived, completed, or canceled appointments cannot be moved.
- Focused browser coverage passes across 360, 390, 768, 1280, and 1440 pixels with English/Spanish, light/dark, owner/member, keyboard, conflict, stale, DST, completeness-cap, and no-page-overflow assertions.
- Backend Jobs integration passes 21/21; security review reports no findings; Goldface approves the final responsive candidate at 99/100.

Phase 3C release-candidate evidence:

- `prisma/migrations/20260823030000_add_in_app_notification_outbox` creates a content-minimal `NotificationOutbox` with same-tenant and same-Job appointment/event integrity, immutable source identity, forced RLS, least-privileged runtime grants, and universal RAG exclusion.
- Booking, rescheduling, dispatch, arrival, completion, and cancellation create deduplicated recipient notifications in the same transaction as the authoritative appointment mutation and immutable Job event; a notification failure rolls back the business mutation.
- Recipients are derived only from current server state. The actor and duplicate recipients are excluded, and current Job visibility is revalidated for creation, list, unread summary, read, and read-all operations so reassignment cannot leak stale Job or customer context.
- The responsive notification center uses one shared desktop/mobile surface with English/Spanish copy, tenant-local time, keyset pagination, unread filters, authoritative read cutoffs, focus return, reduced-motion handling, 44px phone controls, and race-safe request generations.
- Notification inbox retention soft-archives read rows after 90 days and never-read rows after 365 days through a daily, dry-run-first, tenant-RLS run-once worker. Runtime deletion remains denied; archived rows disappear from the active inbox while content-minimal audit history remains available for backup and incident recovery.
- Appointment and Kody success copy is derived from the confirmed API receipt: an eligible in-app team update may become available, while no customer, email, SMS, AI, or external provider is contacted.
- Fresh-schema evidence applies all 55 migrations, including the additive AI retrieval-audit planner index; exact-candidate `verify:launch` passes with 113 routes, zero unmatched declarations, 210/210 integration tests, and 84/84 browser tests. Focused notification browser coverage passes 2/2, AI-usage hardening passes 5/5, Kody schedule coverage 5/5, and Jobs schedule coverage 1/1 with English/Spanish, light/dark, keyboard, mobile, stale-response, cutoff-race, no-op feedback, and Axe assertions.

## Phase 4 — Invoicing and payments

Status: Partial accounting export exists; Phase 4A invoice/payment ledger, internal API, and responsive Quote/Job workflow are committed and release-verified on `main`. A bounded Phase 4B provider-safe creation/reconciliation foundation is implemented in the current uncommitted workspace and has fresh-schema, concurrency, RLS, API, responsive UI, exact local launch-gate, backend, security, UX, and independent Opera approval. Provider workflows remain default-off; production enablement is not asserted.

- [x] QuickBooks CSV export and QuickBooks Online connection/sync foundation.
- [x] Add tenant-scoped QuoteFly `Invoice`, `InvoicePayment`, and immutable `InvoiceEvent` ledger tables with forced RLS, provider-safe identifiers, and governance classification.
- [x] Add Invoice API/service creation from completed jobs or accepted quotes, including tenant-local invoice numbering, idempotency, member read scope, and immutable event writes.
- [x] Add responsive English/Spanish invoice panels to accepted Quote and completed Job detail, with tenant-local due dates, explicit confirmation, assigned-member read scope, and a clear no-provider/no-charge boundary.
- [x] Add an Invoice-owned durable `PROCESSING` claim, stable Intuit request ID, provider-result quarantine, and explicit reconciliation before exposing QuickBooks invoice creation. Implemented in the current uncommitted Phase 4B candidate; remains default-off and release-gated.
- [ ] Keep provider payment handling in Stripe/Square/QuickBooks; QuoteFly stores only provider-safe identifiers and status.
- [ ] Add webhook idempotency, refunds/disputes policy, tenant permissions, and reconciliation tests.

Current containment and Phase 4B candidate:

- `QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED` defaults off. Connect, callback exchange, provider push, provider refresh, and enabled webhook processing fail with a stable retryable `503` while paused and make no provider calls.
- QuickBooks status, preview, disconnect, and provider-capable routes require a current owner/admin membership; disconnect remains available for local credential cleanup.
- The legacy Quote-to-QuickBooks write route is retired with `410 QUICKBOOKS_LEGACY_QUOTE_PUSH_RETIRED` whenever provider workflows are enabled. The new bounded path starts from an existing QuoteFly `Invoice`, never auto-creates provider customers/items, and blocks unsupported tax/currency or missing mappings before a provider call.
- Focused containment evidence passes `60/60` API/security integration tests, and the exact candidate database-backed gate passes `213/213` integration tests with 113/113 inventoried routes.
- This candidate does not complete Phase 4 payments or authorize provider rollout. Stripe/Square/payment state, refunds/disputes, provider webhooks, provider mapping management, staging evidence, and production enablement remain separate reviewed slices.

Phase 4B workspace evidence:

- Additive migration `20260824220000_add_quickbooks_invoice_operations` applies from a fresh database with forced tenant RLS, composite tenant foreign keys, least-privileged runtime grants, state CHECK constraints, and no runtime delete/truncate privilege.
- `GET .../invoices/:invoiceId/sync-preview` is read-only and omits tenant, provider customer/item, realm, token, hash, and internal-cost data. Owners/admins see exact QuoteFly lines, mapping readiness, and provider document number; members and cross-tenant guesses fail closed.
- `POST .../publish` takes a versioned, idempotency-keyed durable claim before the one provider write. A stable Intuit `requestid` is reused by that operation; concurrent commands produce one claim and one provider call.
- Ambiguous network, timeout, throttling, server, or local-commit outcomes become `RECONCILIATION_REQUIRED`; a later publish is blocked, and `POST .../reconcile` queries the existing provider request by provider invoice ID or deterministic document number without another write.
- The responsive English/Spanish Invoice panel keeps the workflow review-first, shows setup blockers and paused-provider truth, requires line-by-line confirmation before publishing, and offers reconciliation instead of retry when provider state is uncertain.
- Focused migrated-PostgreSQL coverage passes 18/18 Invoice integration cases, including successful replay, concurrent serialization, immutable provider-realm and exact-payload review binding, expired-claim recovery without another create, unknown-result quarantine, exact-fingerprint reconciliation, disconnect-during-refresh containment, cross-Invoice idempotency rejection, manager/tenant boundaries, and runtime-role RLS. QuickBooks responsive browser coverage passes at 320px with safe mapped targets, stale-version recovery, localized Spanish blockers, 44px actions, and no horizontal overflow. The exact local `verify:launch` gate applies all 58 migrations and passes with 116 inventoried routes, zero unmatched declarations, 240/240 integration tests, 92 executed browser scenarios plus one intentional opt-in capture skip, parser evaluation 17/17, assistant evaluation 83/83, retrieval evaluation 12/12, and clean dependency audits. The additive `20260824233000_add_invoice_create_replayed_event` migration repairs already-migrated databases whose PostgreSQL enum predates the idempotent replay state. Goldface, Renford, and Sentinel approve the final UX, backend-integrity, and security candidate; Opera independently approved the Phase 4B provider-invoice slice with no unresolved Critical, High, or release-blocking Medium findings.

Phase 4A release evidence:

- The checked migration adds tenant-scoped numbering plus forced-RLS `Invoice`, `InvoicePayment`, and immutable `InvoiceEvent` records; provider credentials and payment instruments are never stored.
- Every accepted idempotency key is durably bound, including a duplicate-source response, so a later request cannot reuse that key for another customer, quote, or job.
- Public invoice responses omit tenant identifiers, provider identifiers, internal costs, margins, and stored scope narrative. Customer-facing totals are C2 and remain excluded from RAG; payment ledger amounts are C3; provider identifiers are C4.
- Accepted Quote detail and completed Job detail expose the same internal invoice record. Only owners/admins can create it; assigned members receive a read-only view after the normal job/customer/quote authorization checks.
- Creation confirmation states that QuoteFly is not sending, charging, or creating a record in QuickBooks, Stripe, or Square. External delivery remains unavailable until durable provider claims and reconciliation exist.
- Exact-candidate evidence covers all 50 fresh-schema migrations, six Invoice integration cases, runtime-role RLS/immutability, duplicate-source concurrency, English/Spanish UI, 390px mobile layout, dark mode, and assigned-member visibility.
- Full `verify:ci` passes with 109/109 route declarations inventoried, 169/169 integration tests, 72/72 Kody assistant evals, 12/12 retrieval evals, and 13/13 quote-parser evals.

## Kody contract

Implemented tools are structured database queries and reviewed previews, not free-form RAG writes:

- [x] `LIST_MY_ACTIVITIES`
- [x] `PRIORITIZE_MY_DAY`
- [x] `PREPARE_ACTIVITY`
- [x] `LIST_SCHEDULE`
- [x] `PREPARE_BOOKING`
- [x] `PREPARE_DISPATCH`
- [x] `DRAFT_QUOTE` resolves an active assignment-visible customer by authorized context, exact contact, exact name, then partial name; asks for missing new-customer details; retains bounded conversation context; preserves duration ranges; matches the active tenant catalog; and prepares separate priced source-linked Quote Builder lines without creating a Customer or Quote.
- [x] The Quote Builder applies fresh Kody drafts directly and gives occupied drafts explicit merge, replace, or keep choices without automatically starting a second AI request.

Schedule-tool release-candidate evidence:

- All three tools are deterministic and make zero model/provider calls, consume zero AI credits, and create zero Job, appointment, or Job-event rows before the user confirms through the normal Jobs workflow.
- Schedule reads run under tenant RLS with the same live assignment visibility used by Jobs. Members are forced to their own schedule and dispatch scope; booking preparation requires owner/admin assignment-management permission.
- The assistant projection is bounded and excludes addresses, instructions, contacts, quote content, financial data, provider identifiers, and deleted/archived records.
- Booking requires an explicit start and end or duration, rejects nonexistent local times, and presents both UTC-offset choices for a DST fold. Dispatch requires a current visible `SCHEDULED` appointment.
- Rolling next-seven-day results preserve the exact tenant-local start through the typed handoff and schedule URL instead of being realigned to a calendar week; partial 12-hour ranges require an explicit meridiem on both endpoints.
- Browser handoffs refetch and reauthorize current records, preserve review state on stale/permission failures, and submit exactly one normal versioned mutation after confirmation. Kody preview actions create no notification; after a confirmed appointment mutation, Kody reports only the server receipt: an eligible in-app team update may be available, but no customer, email, SMS, or external provider was contacted.
- Assistant integration passes 23/23, routing evaluation passes 83/83, focused EN/ES Kody schedule browser coverage passes 5/5, and the exact-candidate database-backed gate passes 210/210 integration tests plus 84/84 browser tests. Sentinel reports no blocking security findings and Goldface approves the reviewed schedule and notification flows.
- [x] Replace paid Kody's read-then-record usage accounting with an atomic tenant billing-period reservation/settlement ledger. Every raw OpenAI call now passes through a content-free, forced-RLS reservation/provider-call ledger with global tenant idempotency, conservative ambiguous-call charging, immutable audit linkage, and a rolling legacy bridge that avoids double counting. Paid tenants use exact Stripe item bounds, trials use their stored trial bounds, and incomplete paid snapshots fail provider authorization closed until the post-drain reconciliation rebuilds interval totals; a paid start is never inferred from its end. Deterministic zero-provider tools remain available at the paid limit. Fresh-schema evidence covers concurrent near-cap authorization, cross-period replay denial, prior-period reaping, non-UTC bridge behavior, provider-timeout no-replay, RLS/grants/CHECK constraints, reconciliation/proration, and generated-output suppression on accounting failure.

Rules:

- Tenant, role, capabilities, assignment, and classifications come only from authenticated server state.
- The model never writes SQL and never selects a tenant.
- Narrative task/job fields start excluded from vector indexing.
- Prepare tools return a typed preview and confirmation action; normal API endpoints perform the write after reauthorization.
- The model cannot claim an action happened until the confirmed API result is recorded.
- Quote suggestions never create, update, restore, archive, or assign customers. New-customer details enter the existing confirmed customer flow, and final quote creation reauthorizes the customer and rehydrates permission-gated preset cost.
- Kody customer matching uses active tenant and assignment scope for name, email, phone, selected context, activity, retrieval, and returned references.
- A quote handoff carries only bounded typed fields, saved preset references, and customer pricing; the builder applies it once after draft recovery and does not automatically start another paid AI pass.

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
6. Phase 4 internal invoice ledger and reviewed Quote/Job creation workflow.
7. Durable notifications and optional provider integrations only after consent, deliverability, reconciliation, and retention policies are approved.

Migrations run through the isolated Railway migration service with `DIRECT_DATABASE_URL`; the long-running API retains only the least-privileged pooled runtime URL.
