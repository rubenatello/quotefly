# Customer Follow-up Automation

## Outcome

QuoteFly should create a reviewable follow-up schedule whenever a customer is added so a new lead cannot disappear into a static customer list. The schedule is stored as normal tenant-scoped activity tasks, appears in the existing work queue, and is available to Kody through deterministic operational retrieval.

This workflow does not send email or SMS automatically. It schedules work for a person and records an explicit outcome when that person completes it.

## Authoritative workflow

1. A customer is created through the customer API, quote intake, Kody's reviewed customer action, or inbound SMS intake.
2. The same database transaction enrolls the customer in the tenant's active default follow-up template.
3. QuoteFly creates one activity task per template step with stable source keys. Replayed or concurrent intake cannot create duplicates.
4. The task assignee is the customer's active assignee, or the authenticated creator when the customer has no assignee. System intake uses truthful system audit attribution.
5. A user completes an automated task with one explicit outcome:
   - `CONTACTED`: records an attempt and successful contact.
   - `NO_RESPONSE`: records an attempt without claiming contact.
   - `SKIPPED`: completes the task without claiming either.
6. The final completed step closes the sequence. Winning, losing, archiving, or deleting the customer cancels remaining automated tasks. Manual tasks retain their explicit lifecycle safeguards.

Arbitrary notes, link clicks, quote edits, and page views never count as customer contact.

## Lost and reopen lifecycle

Customer loss is an explicit CRM decision, not an inference from a rejected quote. Users close a customer through the structured Customers workflow with one required reason: Price, No response, Competitor, Timing, Not a fit, Customer canceled, or Other. Other requires a short note; every reason may include optional internal notes.

The same tenant-scoped transaction records the reason, notes, UTC loss time, acting workspace member, and lifecycle version; cancels only open automatic follow-up tasks; preserves manual tasks for review; writes a coded activity event; and queues the customer for AI-index refresh. A customer with an active job cannot be marked lost until that job is completed or canceled. Rejected quotes close and cancel follow-up for that quote/customer sequence, but do not silently declare the whole customer relationship lost.

Lost customers are excluded defensively from Kody's follow-up and customers-without-quotes queries even if an inconsistent active task survives. They cannot receive a new automatic sequence or start a new quote until explicitly reopened. Reopening clears the current loss fields, preserves the coded history event, records the UTC reopen time, increments the lifecycle version, and requires the user to choose whether to start a fresh automatic sequence. Fresh sequences use sequence-scoped task source keys so a previous canceled cadence cannot block the new enrollment.

Generic customer status edits, duplicate-merge status changes, legacy dashboard selectors, quote transitions, and future service callers may not bypass these commands. Optimistic lifecycle versions, row locks, composite tenant relationships, and the database loss-metadata check keep concurrent and cross-tenant requests fail-closed.

## Default cadence

The starter template creates four follow-up tasks after intake:

| Step | Delay | Default priority | Purpose |
| --- | ---: | --- | --- |
| 1 | 15 minutes | High | Acknowledge and qualify the new lead |
| 2 | 1 day | Normal | Continue the conversation or request missing details |
| 3 | 3 days | Normal | Check the decision timeline and address blockers |
| 4 | 7 days | High | Final scheduled check-in before manual nurture |

Owners and admins may enable or disable automatic enrollment and edit one to six future-customer steps. Template edits do not rewrite existing customer schedules.

## Attention rules

Urgency is derived from each task's due time in the tenant timezone; it is not stored as a second mutable status.

- `URGENT`: explicitly urgent, or more than 24 hours overdue.
- `OVERDUE`: past due by no more than 24 hours.
- `DUE_TODAY`: due during the current tenant-local day.
- `UPCOMING`: due later.
- `NEVER_ATTEMPTED`: an independent customer flag based on contact outcome history.

Customer-level queues return the earliest active automated follow-up per customer and sort by urgency, due time, and stable ID.

## Kody access

Kody must read this workflow through a tenant-scoped structured query shared with the product queue. Rapidly changing due dates and completion states are not vector-indexed.

Supported deterministic questions include:

- Who needs follow-up today?
- Which customers are overdue or urgent?
- Which new customers have never been followed up with?
- Which assigned customers have not been successfully contacted?

The response may include customer name, task identity, due time, attention reason, and contact-history flags. It must not include phone, email, task notes, source keys, or cross-member work the caller cannot access. Each response cites the underlying task, sequence, and customer classification.

## Settings and permissions

The Settings page exposes a focused Follow-up section with:

- an automatic-scheduling toggle;
- a compact cadence summary;
- a collapsed, keyboard-operable step editor;
- a clear “future customers only” notice;
- read-only visibility for members and edit access for owners/admins;
- English and Spanish copy with mobile controls at least 44px high.

## Migration and rollout safety

- The schema migration does not enroll existing customers or create tasks.
- A default template is created lazily on Settings access or the next customer intake.
- Existing-customer enrollment requires a future preview-and-confirm batch workflow.
- New models use composite tenant relationships, forced RLS, least-privilege grants, lifecycle indexes, and database checks.
- Provider calls and background jobs are not required for this workflow.

## Acceptance evidence

- All customer creation paths seed exactly one schedule.
- Concurrent/replayed intake does not duplicate a sequence or task.
- A disabled template creates no schedule.
- Template changes affect future customers only.
- Outcome timestamps match `CONTACTED`, `NO_RESPONSE`, and `SKIPPED` semantics.
- Final-step, won/lost, archive/delete, and reassignment transitions are atomic.
- Cross-tenant relationships and runtime access fail closed.
- Kody counts and citations match the authoritative task query without PII leakage.
- Structured loss captures reason, optional notes, loss time, and actor while keeping free-form loss notes out of activity-event RAG text.
- Marking lost cancels automatic tasks atomically, preserves manual tasks, rejects active jobs, and cannot be bypassed through generic status updates.
- Reopening can create a fresh sequence without source-key collision; stale, cross-tenant, and terminal-customer scheduling attempts fail closed.
- Rejected quotes do not globally mark a customer lost, and Kody excludes Lost/Won customers under every follow-up filter.
- Settings passes desktop/mobile accessibility, permissions, localization, stale-version, and unsaved-change coverage.
