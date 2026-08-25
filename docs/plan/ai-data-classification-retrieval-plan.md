# AI Data Classification, Retrieval, and Tenant-Isolation Plan

The platform-operator catalog, validation, and audit work is tracked separately in [the superuser data governance console plan](./superuser-data-governance-console-plan.md).

Status: Controlled-pilot implementation in progress; production enablement remains gated

Last updated: 2026-08-24

Owners: Product, Engineering, Security, Operations

Target stack: Fastify, Prisma, Neon PostgreSQL, OpenAI API, Vercel, Railway

Related baseline: `docs/architecture/multi-tenant-data-plan.md`

Current implementation baseline: the latest `main` release candidate containing the mobile-navigation and AI-governance work

## 1. Objective

Build a tenant-safe AI data layer that can answer business questions and retrieve relevant workspace context without allowing:

- one tenant to retrieve, infer, embed, summarize, or cite another tenant's data;
- an ordinary member to retrieve owner/admin-only financial or audit data;
- credentials, provider tokens, raw webhook payloads, or authentication data to reach an LLM;
- archived or deleted records to remain discoverable through a stale index;
- model-generated SQL, metadata, or tool arguments to choose the tenant boundary;
- raw prompts, retrieved text, or customer PII to become unbounded operational logs.

The implementation should support two distinct capabilities:

1. Structured insights from verified PostgreSQL queries for totals, rates, dates, margins, pipeline, and operational metrics.
2. Retrieval-augmented generation for unstructured notes, scopes, descriptions, activity details, and future documents.

### How to use this tracker

- Update each work item's `Status` in place; do not mark an item `Completed` without linking or describing its acceptance evidence.
- Add dated entries to the decision/evidence log for approved policy changes, migrations, test runs, provider configuration, and release verdicts.
- If an item is `Blocked`, record the owner, exact blocker, and the evidence needed to unblock it.
- A phase exits only when every item is completed and its stated exit gate has objective evidence.
- Failed or unavailable security, database, provider, or release tests are missing evidence, not passes.
- BCP and deployment remain separately authorized operations under the repository rules.

| Phase | Scope | Status | Exit owner |
|---|---|---|---|
| 0 | Policy and threat-model freeze | In progress | Product + Security |
| 1 | Classification and field-level authorization | In progress | Engineering + Security |
| 2 | AI minimization, audit, and retention | In progress | Engineering + Privacy |
| 3 | Structured insight service | In progress | Engineering + Product |
| 4 | Neon retrieval and RLS hardening | In progress | Engineering + Operations + Security |
| 5 | Insight product UX | In progress | Product + Engineering |
| 6 | Production rollout and operations | In progress | Operations + Product |

## 2. Non-goals

- Do not give the LLM direct database credentials or unrestricted SQL access.
- Do not use vector similarity to calculate authoritative numeric metrics.
- Do not embed secrets, provider tokens, password material, raw webhook payloads, or billing-provider session identifiers.
- Do not make legal-compliance or certification claims from this engineering work.
- Do not retrofit PostgreSQL RLS across every existing table in the first migration.
- Do not add per-user customer assignment until Product explicitly selects assignment-only visibility.

## 3. Current baseline and confirmed gaps

### Existing controls

- Protected requests revalidate the JWT, active user, active tenant, active membership, current role, and `authVersion`.
- Route handlers derive `tenantId` from authenticated server claims for the core customer, quote, product, billing, and AI paths.
- Customer-to-quote and several downstream relations use composite `(id, tenantId)` references.
- Active query helpers consistently include tenant and lifecycle filters.
- Cross-tenant integration tests exist for customers, quotes, products, membership administration, billing, and provider bindings.
- Customer-facing PDF/share tests prevent internal costs and margin data from appearing in outbound documents.
- AI calls occur on the backend, use bounded context, and validate structured output.

### Gaps to close

- Forced PostgreSQL RLS, transaction-local tenant context, and a dedicated non-owner runtime role are implemented for the AI retrieval, audit, index-job, and usage-ledger boundary; production-like Neon migration/role/rollback rehearsal remains.
- A centralized field-classification registry and live-role capability policy govern AI retrieval; remaining non-AI response projection work is tracked in Phase 1.
- New AI usage and retrieval audits are redacted, content-free, and expiration-aware; the dry-run-first retention purge remains unfinished.
- The internal AI-quality summary consumes stored classification/quality metadata instead of reparsing raw prompts.
- Retrieval documents/chunks, lifecycle retirement, transactional index jobs, a retry/lease worker, failed/success audits, full-index FTS preselection, and read-time stale-source rejection are implemented. Representative semantic-scale benchmarks and pgvector remain production scale work.

## 4. Proposed policy decisions

These defaults are recommended and should be recorded in the decision log before Phase 1 exits.

| Decision | Recommended default | Status |
|---|---|---|
| Member access to customers and quotes | All active operational records in their tenant | Approved implementation default |
| Member access to internal costs and margins | Denied | Approved implementation default; full response projection in progress |
| Member access to AI run history | Own redacted summary only | Implemented and database-tested |
| Owner/admin access to AI run history | Redacted audit details; raw prompt only through exceptional audited support path | Redacted access implemented; exceptional raw path remains disabled |
| Provider credentials and raw webhook payloads | Never returned to browser or LLM | Approved implementation default |
| AI structured insights | Fixed server-owned queries only | Approved implementation default |
| RAG storage | Tenant-scoped PostgreSQL retrieval documents/chunks under forced RLS now; pgvector remains the semantic-scale target | Controlled-pilot implementation complete; scale benchmark pending |
| Raw AI prompt retention | 30 days by default | Engineering default; legal/privacy review required before purge or launch |
| Redacted AI operational trace retention | 90 days by default | Implemented for new events; legal/privacy review required |
| Aggregate token/cost telemetry retention | 13 months by default | Proposed; requires Product/legal review |
| Index deletion after source archive/delete | Immediate route retirement plus read-time source/hash revalidation | Implemented for current customer, quote, activity, line-item, and saved-job sources |
| Per-user customer/job assignments | Deferred until explicitly requested | Approved implementation default |

The initial prompt-to-quote RAG corpus is intentionally limited to customer notes, quote titles/scopes, quote-line descriptions, customer activity title/detail, and saved product/service names/descriptions. Customer identity resolution, saved pricing, Jobs, appointments, dispatch state, invoices, balances, and totals remain authoritative deterministic database tools. `JobNote`, uploads, provider payloads, access instructions, and financial/provider data are excluded from this pilot; adding field-history RAG later requires a separate purpose, assignment/lifecycle policy, mutation coverage, and source revalidation adapter.

## 5. Data classification standard

### Classifications

| Code | Name | Definition | LLM/RAG rule |
|---|---|---|---|
| C0 | Public | Deliberately published, non-tenant-sensitive content | May be used when relevant |
| C1 | Business internal | Tenant workflow metadata with no direct PII, secret, or internal cost | Tenant-filtered use allowed |
| C2 | Customer confidential | Customer identity, contact data, notes, communications, quote content, and activity | Purpose-limited, minimized, tenant-filtered, and audited |
| C3 | Financial confidential | Internal costs, margins, labor rates, markups, billing/accounting details | Owner/admin plus explicit financial purpose only |
| C4 | Restricted | Credentials, password/reset material, provider tokens, raw webhook payloads, signing/billing session identifiers | Never sent to an LLM or vector index |

### Model and field inventory

| Models/fields | Class | Required handling |
|---|---|---|
| `User.passwordHash`, `User.authVersion` | C4 | Authentication service only; never serialize or retrieve for AI |
| `PasswordResetToken.*` | C4 | Authentication service only; short retention; never log token/hash |
| `QuickBooksConnection.accessTokenEncrypted`, `refreshTokenEncrypted` | C4 | Integration service only; decrypt only immediately before provider call |
| `BillingWebhookEvent.payload`, processing lease fields | C4 | Webhook processor only; keep bounded audit envelope |
| `QuickBooksWebhookEvent.payload` | C4 | Webhook processor only; exclude from AI and general admin APIs |
| Tenant Stripe customer/subscription/checkout/attempt identifiers | C4 | Billing service only; no browser or AI exposure unless a strictly bounded owner billing response requires a non-secret reference |
| Environment secrets and signing material | C4 | Provider/runtime configuration only; never stored in Vite variables or database retrieval tables |
| `TenantBrandAsset.data` | C4 | PDF/branding renderer only; index metadata only if ever needed |
| `TenantUser.role`, membership lifecycle | C3 | Authorization service and owner/admin team UI only |
| `Quote.internalCostSubtotal` | C3 | Owner/admin and explicit financial-insight purpose only |
| `QuoteLineItem.unitCost` | C3 | Owner/admin and explicit financial-insight purpose only |
| `PricingProfile.laborRate`, `materialMarkup` | C3 | Owner/admin and quote-pricing service; use in AI only for explicit drafting/pricing purpose |
| `WorkPreset.unitCost` | C3 | Owner/admin and quote-pricing service; never expose to customer-facing output |
| `AiUsageEvent.estimatedCostUsd` | C3 | Owner/admin/internal operations; customer UI receives percentage/availability only |
| Tenant subscription and billing state | C3 | Owner billing UI and entitlement service; aggregate status only elsewhere |
| QuickBooks maps, invoice IDs, payload snapshots, provider errors | C3 | Owner/admin integration UI; no general RAG |
| `Customer.fullName`, `email`, `phone`, `phoneDigits`, `notes` | C2 | Tenant operational access; minimize contact fields before model calls |
| Tenant branding business email, phone, and address | C2 | Tenant branding/PDF use; no broad insight retrieval |
| `Quote.title`, `scopeText`, `aiPromptText` | C2 | Tenant quote use; redact contact data when full identity is unnecessary |
| Quote line descriptions and customer prices | C2 | Tenant quote use; customer price allowed for quote/pipeline purpose |
| `QuoteRevision.snapshot`, actor identity | C2/C3 | Apply field-level projection because snapshots may contain PII and internal costs |
| `CustomerActivityEvent.detail`, `metadata`, actor identity | C2 | Purpose-limited customer timeline/RAG; sanitize free text |
| `SmsMessage.fromNumber`, `toNumber`, `body`, `externalSid` | C2/C4 | Communications service only by default; body requires explicit communications purpose; SID excluded from AI |
| `QuoteDecisionSession.requesterPhone` | C2 | Quote approval workflow only |
| `QuoteOutboundEvent.destination`, `subject`, `bodyPreview` | C2 | Quote send history only; minimize destination in AI output |
| `AiUsageEvent.promptText`, actor email/name, insight trace | C2/C3 | Redact, expire, restrict by capability, and never use as general RAG corpus |
| `TenantPhoneNumber.e164Number` | C2 | Communications configuration only |
| Tenant/customer/quote IDs | C1 | Internal references; safe only inside the tenant boundary |
| Service type, quote/job status, lifecycle timestamps | C1 | Suitable for tenant-scoped structured insights |
| Aggregate counts, rates, and duration metrics | C1 | Suitable for tenant-scoped structured insights after small-cell review |
| Generic quote templates and sanitized product descriptions | C1 | Suitable for retrieval after tenant and lifecycle filtering |
| Deliberately published marketing content | C0 | General use allowed |

## 6. Authorization and capability policy

Create a server-owned capability layer. Route handlers and retrieval services must consume capabilities rather than repeatedly comparing arbitrary role strings.

### Proposed capabilities

- `viewCustomerPii`
- `viewTenantQuotes`
- `viewInternalCosts`
- `viewMargins`
- `viewAiRunSummary`
- `viewAiRawPrompt`
- `useAiQuoteDrafting`
- `useAiBusinessInsights`
- `manageAiSettings`
- `viewBilling`
- `manageBilling`
- `manageIntegrations`
- `manageTeam`

### Proposed role matrix

| Capability | Owner | Admin | Member |
|---|---:|---:|---:|
| View tenant customers/quotes | Yes | Yes | Yes |
| View customer contact data | Yes | Yes | Yes |
| View internal costs/margins | Yes | Yes | No |
| Use AI quote drafting | Yes | Yes | Yes |
| Use non-financial AI insights | Yes | Yes | Yes |
| Use financial AI insights | Yes | Yes | No |
| View redacted AI audit | Yes | Yes | Own runs only |
| View raw AI prompt | Exceptional audited path only | No | No |
| Manage AI settings | Yes | Yes | No |
| Manage team/billing/integrations | Existing owner/admin policy | Existing owner/admin policy | No |

### Access context contract

Every retrieval operation receives an immutable server-created context:

```ts
type AccessContext = {
  tenantId: string;
  userId: string;
  role: "owner" | "admin" | "member";
  capabilities: ReadonlySet<Capability>;
  requestId: string;
};
```

Rules:

- Construct it only after live membership revalidation.
- Never accept it from request JSON, query parameters, tool arguments, model output, or provider metadata.
- Do not expose a generic `tenantId` override.
- Recompute it after role changes; do not rely on stale JWT roles.

## 7. Retrieval architecture

### Request flow

1. Authenticate and revalidate live membership.
2. Build `AccessContext` and select an explicit `AiPurpose`.
3. Validate the user question/tool arguments with Zod.
4. Route to a fixed structured insight or an approved RAG retrieval path.
5. Apply tenant, lifecycle, classification, role, purpose, date, and result-count filters.
6. Redact fields before prompt construction.
7. Revalidate source records after vector lookup.
8. Call the model with bounded context and source labels.
9. Validate structured model output.
10. Record a content-free retrieval audit envelope.
11. Return the answer with source citations and a human-review notice where appropriate.

### Structured insight tools

The model may request only fixed tools with bounded schemas. The server fills the tenant context.

- `getPipelineSummary(dateRange)`
- `getQuoteConversion(dateRange, serviceType?)`
- `getRevenueSummary(dateRange, serviceType?)`
- `getMarginSummary(dateRange, serviceType?)` — requires `viewMargins`
- `getQuoteAging(status?, dateRange)`
- `getFollowUpWorkload(dateRange?)`
- `getCustomerTimeline(customerId, limit)`
- `getQuoteContext(quoteId)`
- `getPricingBenchmarks(serviceType, dateRange)` — separate customer prices from internal costs

Each tool must:

- use parameterized Prisma or `Prisma.sql` queries;
- add `tenantId` and lifecycle predicates inside the query;
- enforce a bounded date window and row limit;
- return normalized numbers and explicit units;
- include source record IDs/date range for verification;
- exclude C3 fields unless the purpose and capability both allow them;
- return stable denial/error codes without leaking record existence across tenants.

### RAG scope

Initial eligible sources:

- customer notes;
- quote titles and scopes;
- quote line descriptions without internal cost;
- customer activity title/detail;
- sanitized saved-product descriptions;
- future tenant-uploaded procedure or service documents.

Initial excluded sources:

- credentials, password/reset data, and session information;
- customer phone/email unless an explicit customer-contact task needs them;
- internal costs, margins, labor rates, and markups;
- SMS bodies and outbound message bodies;
- raw AI prompt history;
- billing/provider IDs, tokens, and raw webhook payloads;
- unrestricted revision snapshots or QuickBooks payload snapshots.

## 8. Proposed database changes

### Extend AI usage events

Make raw prompt retention explicit:

- make `AiUsageEvent.promptText` nullable after a safe backfill/deployment sequence;
- add `promptRedacted`;
- add `promptHash`;
- add `purpose`;
- add `classification`;
- add `retentionExpiresAtUtc`;
- add `sourceCount`;
- add `retrievalAuditEventId` when relevant.

Do not drop existing data in the first migration. Backfill classification and expiry, deploy compatible code, verify, then run a separately authorized purge job.

### `AiRetrievalAuditEvent`

Required fields:

- `id`, `tenantId`, `actorUserId`;
- `requestId`, `purpose`, `model`;
- `maxClassification`, `sourceTypes`, `sourceIds` or hashed source references;
- `resultCount`, `inputTokenCount`, `outputTokenCount`;
- `queryHash`, `policyVersion`, `status`, `denialCode`;
- `createdAt`, `retentionExpiresAtUtc`, `deletedAtUtc`.

Never store raw retrieved text, raw prompts, customer contact details, or model provider credentials in the audit envelope.

### `AiKnowledgeChunk`

Required fields:

- `id`, `tenantId`;
- `sourceType`, `sourceId`, `sourceVersion`, `chunkIndex`;
- `classification`, `allowedRoles`, `serviceType`;
- optional `customerId`, `quoteId`;
- `contentHash`, `embeddingModel`, `embeddingDimensions`;
- pgvector `embedding`;
- `createdAt`, `updatedAt`, `archivedAtUtc`, `deletedAtUtc`.

Prefer not to duplicate raw source text. Store sanitized chunk text only if rehydrating current source fields is impractical, and treat it at the same classification as the source.

Indexes:

- unique `(tenantId, sourceType, sourceId, sourceVersion, chunkIndex)`;
- `(tenantId, sourceType, sourceId, deletedAtUtc)`;
- `(tenantId, classification, deletedAtUtc)`;
- `(tenantId, serviceType, deletedAtUtc)`;
- a reviewed pgvector similarity index after representative-volume benchmarks.

### `AiIndexJob`

Use a durable outbox instead of untracked background promises:

- `id`, `tenantId`, `sourceType`, `sourceId`, `operation`;
- `sourceVersion`, `status`, `attemptCount`, `lastErrorCode`;
- `availableAtUtc`, `leasedAtUtc`, `leaseToken`;
- `createdAt`, `updatedAt`, `completedAtUtc`.

Create/update/delete jobs should be committed in the same database transaction as the source mutation where practical.

## 9. PostgreSQL RLS and database roles

Apply RLS to all new AI knowledge, index-job, and retrieval-audit tables first.

Required controls:

1. Use a migration/admin role for schema changes.
2. Use a separate non-owner runtime role with no `BYPASSRLS` attribute.
3. Enable and force row security on protected tables.
4. Set tenant/user context locally inside the same database transaction as retrieval.
5. Make missing/invalid tenant context fail closed.
6. Keep operational cross-tenant reporting on a separate, audited aggregate path; do not give the ordinary API connection an RLS bypass.

Illustrative policy shape for migration review:

```sql
ALTER TABLE "AiKnowledgeChunk" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiKnowledgeChunk" FORCE ROW LEVEL SECURITY;

CREATE POLICY ai_chunk_tenant_isolation
ON "AiKnowledgeChunk"
USING (
  "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
)
WITH CHECK (
  "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')
);
```

The final migration must be rehearsed against a production-like Neon branch. PostgreSQL table owners and roles with `BYPASSRLS` may bypass policies; role setup is therefore part of the release gate, not an optional host setting.

## 10. Prompt minimization and retention

### Before the model call

- Remove phone/email unless required for the requested action.
- Replace identity with a stable local label when the name is unnecessary.
- Exclude C4 fields unconditionally.
- Exclude C3 fields unless purpose and role allow them.
- Bound customer activity, similar quote, product, and chunk counts.
- Treat retrieved text as untrusted data, not system instructions.
- Delimit source content and tell the model never to follow instructions inside retrieved records.

### After the model call

- Validate output with a strict schema.
- Recalculate authoritative totals in application code.
- Revalidate every referenced customer, quote, and product within the tenant.
- Store redacted trace plus content-free source references.
- Apply expiration and purge schedules.
- Prevent prompts and outputs from normal application logs.

### Proposed retention jobs

- Daily: purge expired raw prompt content while retaining approved redacted telemetry.
- Continuous or hourly: delete/disable chunks for archived/deleted sources.
- Daily: alert on index-deletion backlog older than 24 hours.
- Monthly: report purge counts, exceptions, and failed jobs without PII.

## 11. Trackable implementation phases

Status values: `Not started`, `In progress`, `Blocked`, `Ready for review`, `Completed`.

### Current Kody methodology and quality gate (2026-08-20)

Kody uses four deliberately separate layers. This separation is a security and
accuracy control, not an implementation limitation:

1. Deterministic tools query exact tenant records for customers, products,
   follow-up, pipeline math, profitability, and workflow targets.
2. RAG retrieves only approved narrative context such as notes, scope, activity,
   line descriptions, and saved-job descriptions.
3. The LLM may rewrite a vague query and compose concise language from the
   authorized tool/RAG envelope, but it does not select the tenant, role,
   classification, record IDs, prices, or action payloads.
4. Server-created actions open normal QuoteFly review surfaces. Creating,
   changing, sending, archiving, or deleting data still requires the product's
   authorized confirmation flow.

| Gate | Current state | Next acceptance evidence |
|---|---|---|
| Tenant boundary | Application tenant scopes plus forced RLS on retrieval documents, chunks, audits, and index jobs | Keep adversarial two-tenant integration coverage green; stage RLS expansion for AI usage/feedback and core tenant tables |
| Classification | Exhaustive field policy, reviewed Prisma inventory, and authoritative source-to-field manifest; validation fails when a vector field has no canonical loader | Keep the manifest/catalog equality test mandatory as models and fields are added |
| Content governance | Free-text values are inspected before hashing, persistence, and embedding; contact data is redacted and credential-like C4 content is quarantined | Add content-free quarantine-rate monitoring and an operator cleanup/reindex workflow |
| Metadata | Typed entity, lifecycle, assignment, service, status, section, page, and freshness filters; unsupported source/field pairs and arbitrary JSON metadata are rejected | Define a separate size-limited typed schema before adding file/page ingestion metadata |
| Retrieval | Token-aware overlap, tenant-scoped embedding reuse, hybrid ranking, current-source hash revalidation, citations | Benchmark recall beyond the newest candidate window and move vector search into PostgreSQL/pgvector when representative data justifies it |
| Grounding | Structured JSON output, explicit authorized citation markers, deterministic fallback, and rejection of unsupported numeric/date claims | Expand the adversarial corpus and measure grounded-answer fallback/acceptance rates |
| Workflow routing | Typed review-only tools for customers, product search, quotes, send preparation, follow-up, and analytics | Add bounded server-revalidated entity anchors for multi-turn references such as "her" and "send it" |
| Cost control | Tenant monthly accounting and request limits | Add atomic tenant-month provider-cost reservation/settlement before claiming a strict hard cap under concurrency |
| Retention | Expiry timestamps and immediate logical exclusion | Add idempotent scheduled purge with dry-run/apply evidence and documented backup expiry |
| Rollout | Async index queue/worker exists; inline refresh remains the safe default | Run production-like Neon worker/backfill/rollback rehearsal, then enable async indexing with queue-age alerts |

### Phase 0 — Policy and threat-model freeze

| ID | Work item | Owner | Status | Acceptance evidence |
|---|---|---|---|---|
| AIDR-001 | Approve classification names and field inventory | Product + Security | Ready for review | Typed registry and completeness test added; broader field-inventory review remains |
| AIDR-002 | Approve role/capability defaults | Product | Completed | Owner/admin/member policy recorded; member raw-prompt and financial capabilities denied |
| AIDR-003 | Approve initial AI purposes and excluded sources | Product + Engineering | Completed | Purpose registry and excluded-source rules are typed and recorded |
| AIDR-004 | Approve retention defaults | Product + Legal/Privacy | Ready for review | 30/90-day engineering defaults implemented without destructive purge; legal/privacy sign-off remains |
| AIDR-005 | Record attack stories | Security | In progress | Cross-tenant source binding/reads, stale-role demotion, malicious member, PII/secret sentinel, and historical-raw-prompt cases tested; injection/stale-index cases remain |

Exit gate: all policy choices are explicit; no implementation depends on ambiguous member visibility or retention.

### Phase 1 — Classification and field-level authorization

| ID | Work item | Owner | Status | Acceptance evidence |
|---|---|---|---|---|
| AIDR-101 | Add data-classification registry and exhaustive type checks | Engineering | Completed | `AI_RETRIEVABLE_FIELD_POLICY` is exhaustive over the declared field union; unit test passes |
| AIDR-102 | Add centralized capability policy from live membership role | Engineering | Completed | Live-membership access context and owner/admin/member unit matrix pass |
| AIDR-103 | Add response projectors for quotes, lines, products, AI traces, and analytics | Engineering | In progress | AI trace projector complete; quote/product financial projection remains |
| AIDR-104 | Replace repeated role-string checks on affected routes | Engineering | In progress | AI-run route consumes capabilities; remaining sensitive routes still need conversion |
| AIDR-105 | Add stable denial codes and audit-safe logging | Engineering | Not started | No PII/provider errors in denied responses/logs |
| AIDR-106 | Update frontend contracts and hide disallowed financial controls | Engineering | In progress | AI-run contract/UI uses redacted prompt; financial controls remain |

Exit gate: field-level authorization passes two-tenant and three-role integration tests.

### Phase 2 — AI data minimization, audit, and retention

| ID | Work item | Owner | Status | Acceptance evidence |
|---|---|---|---|---|
| AIDR-201 | Add additive AI usage/audit schema migration | Engineering | Completed | Current candidate contains 58 checked-in migrations; fresh/disposable PostgreSQL migration evidence is part of the exact release gate |
| AIDR-202 | Add deterministic prompt redaction and hashing | Engineering | Completed | US/international contacts, provider secrets, bearer/JWT/cloud keys, PEM material, labeled/URL secrets, high-entropy tokens, known values, hashes, and truncation have focused tests |
| AIDR-203 | Stop returning raw prompts to ordinary quote AI-run endpoints | Engineering | Completed | Member/owner/admin and historical-raw/cross-tenant integration cases pass |
| AIDR-204 | Store derived trade/quality metadata at write time | Engineering | Completed | New events store `serviceType`; internal quality summary no longer selects or parses raw prompts |
| AIDR-205 | Add retrieval audit service | Engineering | Completed | Quote AI and Kody RAG write tenant-scoped content-free success/failure envelopes with hashed refs, classifications, stable failure codes, stage timings, result counts, and embedding input-token telemetry |
| AIDR-208 | Add bounded Kody conversation context | Engineering | Completed | Browser submits at most four prior user/tool turns; server strictly validates, trims, re-redacts, and never persists them as a raw transcript or trusts them for authorization |
| AIDR-206 | Add retention purge command in dry-run/apply modes | Engineering + Operations | Not started | Dry-run report, exact target guard, idempotency, and apply test |
| AIDR-207 | Update privacy/data-handling copy after review | Product + Legal/Privacy | Not started | Product behavior and published copy agree |

Exit gate: new AI calls are minimized, redacted, auditable, and expiration-aware; historical deletion remains an explicitly authorized operation.

### Phase 3 — Structured insight service

| ID | Work item | Owner | Status | Acceptance evidence |
|---|---|---|---|---|
| AIDR-301 | Create server-owned insight tool registry | Engineering | Completed | Fixed typed Kody tools; no arbitrary SQL/tool names |
| AIDR-302 | Implement pipeline/conversion/aging/follow-up tools | Engineering | In progress | Pipeline, follow-up, no-quote, and scenario tools implemented; broader date-boundary fixture coverage remains |
| AIDR-303 | Implement revenue/pricing/margin tools with capability gates | Engineering | Completed | Profitability is server-calculated and C3 capability-gated; members receive a denial path |
| AIDR-304 | Add source envelopes and deterministic calculations | Engineering | Completed | Authoritative totals are calculated by tenant-scoped server queries and returned with citations |
| AIDR-305 | Add insight eval dataset | Engineering | Not started | Accuracy, refusal, insufficient-data, and injection cases meet threshold |

Exit gate: numeric insights are reproducible from cited PostgreSQL results and cannot cross tenant/role boundaries.

### Phase 4 — PostgreSQL retrieval and pgvector scale hardening

| ID | Work item | Owner | Status | Acceptance evidence |
|---|---|---|---|---|
| AIDR-401 | Validate Neon extension, runtime role, and production-like branch plan | Operations + Engineering | Not started | Extension/role/RLS preflight evidence |
| AIDR-402 | Add retrieval document/chunk storage and index-job migration | Engineering | Completed | Tenant-scoped document/chunk, retrieval-audit, index-job, and atomic AI usage/reservation tables exist with checked-in migrations |
| AIDR-403 | Add forced RLS policies and transaction tenant context | Engineering + Security | In progress | Migration, non-owner runtime role, `SET LOCAL` transaction context, readiness probe, and fail-closed integration coverage implemented locally; production-like Neon role/migration rehearsal remains |
| AIDR-404 | Build deterministic sanitizer/chunker | Engineering | Completed | Stable field/content hashes, policy version, bounded chunks, and C4 rejection are implemented |
| AIDR-405 | Build idempotent indexing worker | Engineering | In progress | Retry/lease/coalescing/stale-fence worker and transactional mutation jobs exist; dedicated staging worker, heartbeat/alerts, and complete endpoint mutation matrix remain |
| AIDR-406 | Build tenant/role/classification-filtered retrieval query | Engineering | In progress | Full eligible-index PostgreSQL FTS refs are unioned with preferred refs and a bounded recent semantic cohort, then live-authorized before content load; older semantic-only recall still requires pgvector |
| AIDR-407 | Revalidate vector results against current source rows | Engineering | Completed | Read-time tenant/lifecycle/content-hash revalidation rejects stale, archived, deleted, or directly changed sources |
| AIDR-408 | Benchmark exact versus approximate index behavior | Engineering | In progress | Regression proves an exact lexical source older than the recent 200-chunk cohort is found; representative semantic recall/latency and `EXPLAIN ANALYZE` evidence remain |

Exit gate: RAG retrieval passes database RLS, application tenant scope, lifecycle, role, classification, and stale-source tests.

### Phase 5 — AI insight product UX

| ID | Work item | Owner | Status | Acceptance evidence |
|---|---|---|---|---|
| AIDR-501 | Add explicit insight surfaces and purpose-specific prompts | Product + Engineering | In progress | Kody routes only to approved tools and review-only quote drafting; remaining purpose UX polish continues |
| AIDR-502 | Display source citations and freshness | Engineering | In progress | Kody and Quote Builder display approved source labels; record deep links and freshness remain |
| AIDR-503 | Display confidence/insufficient-data states | Product + Engineering | In progress | Confidence and empty-state language exist; broader task evals remain |
| AIDR-504 | Add mobile layout and accessibility coverage | Engineering | In progress | Mobile assistant coverage exists; real-device end-to-end smoke remains |
| AIDR-505 | Add user feedback and correction loop | Product + Engineering | Not started | Feedback ties to audit ID without copying sensitive prompt text |

Exit gate: the UX clearly distinguishes verified metrics, retrieved sources, model explanation, and unavailable/denied data.

### Phase 6 — Production rollout and operations

| ID | Work item | Owner | Status | Acceptance evidence |
|---|---|---|---|---|
| AIDR-601 | Add global and per-tenant feature flags | Engineering | In progress | RAG has production-default-off `off`, `shadow_allowlist`, `allowlist`, and `all` modes plus a tenant-id allowlist; independent structured-insight control remains |
| AIDR-602 | Rehearse migrations and RLS on a production-like Neon branch | Operations | Not started | Duration, locks, role behavior, rollback evidence |
| AIDR-603 | Run shadow retrieval without model exposure | Engineering + Security | In progress | Shadow mode indexes/retrieves allowlisted tenants, retains content-free cost/audit evidence, and strips excerpts/citations before composition; staging execution remains |
| AIDR-604 | Pilot with internal tenant | Product + Engineering | Not started | Signed QA checklist and no unresolved Critical/High findings |
| AIDR-605 | Pilot with selected beta tenants | Product | Not started | Consent/disclosure, feedback, spend, latency, denial review |
| AIDR-606 | Enable alerts and support runbook | Operations | Not started | On-call destination, thresholds, incident/kill-switch steps |
| AIDR-607 | Run exact-candidate release gate | Engineering | Not started | `npm run verify:launch` plus production smoke evidence |

Exit gate: rollout is reversible, monitored, tenant-bounded, privacy-reviewed, and supported operationally.

## 12. QA test matrix

### Test fixtures

Create at least:

- Tenant Alpha: owner, admin, member, active/deleted member.
- Tenant Beta: owner, admin, member.
- Matching customer/quote/product phrases in both tenants, with Beta deliberately more semantically similar.
- Active, archived, and deleted customers/quotes/chunks.
- Financial sentinel values unique to each tenant.
- PII sentinels for name, email, phone, notes, SMS, and addresses.
- Restricted sentinels shaped like access tokens, reset hashes, Stripe IDs, and webhook secrets.
- Prompt-injection text inside customer notes and uploaded content.

### Authentication and tenant isolation

| Test ID | Scenario | Expected result |
|---|---|---|
| TEN-001 | Unauthenticated insight/retrieval request | 401; no query/model call |
| TEN-002 | Deleted user, tenant, or membership | 401; no query/model call |
| TEN-003 | Stale JWT role after demotion | Live role wins; capability denied |
| TEN-004 | Client supplies another `tenantId` | Field rejected or ignored; server tenant used |
| TEN-005 | Cross-tenant customer/quote/source ID | Stable 404/denial without existence leak |
| TEN-006 | Raw SQL insight query | Parameterized and includes hard tenant predicate |
| TEN-007 | Same source phrase exists in two tenants | Only current tenant source is returned/cited |

### Role and field projection

| Test ID | Scenario | Expected result |
|---|---|---|
| RBAC-001 | Member lists quotes/products | No unit costs, internal subtotals, or margins in JSON |
| RBAC-002 | Member requests margin insight | 403 stable capability denial; no model call |
| RBAC-003 | Admin requests approved margin insight | Tenant-only C3 aggregate returned and audited |
| RBAC-004 | Member requests another actor's AI run | Denied or redacted according to policy |
| RBAC-005 | Owner uses exceptional raw-prompt path | Disabled by default; when enabled, explicit reason and audit required |
| RBAC-006 | Frontend inspects API response | Disallowed fields are absent, not merely hidden with CSS |

### Classification and minimization

| Test ID | Scenario | Expected result |
|---|---|---|
| CLASS-001 | Classification registry completeness | CI fails for any unclassified retrievable field |
| CLASS-002 | Restricted sentinel in source | Never appears in prompt, chunk, embedding input, audit, log, or response |
| CLASS-003 | Contact data unnecessary for insight | Phone/email redacted before model call |
| CLASS-004 | Explicit quote-contact action | Only required contact fields included and audited |
| CLASS-005 | Internal cost requested by member | Excluded before prompt construction and denied |

### RLS and vector retrieval

| Test ID | Scenario | Expected result |
|---|---|---|
| RLS-001 | Query protected table without `app.tenant_id` | No rows/write denied |
| RLS-002 | Tenant Alpha context queries shared table | Alpha rows only |
| RLS-003 | Runtime role attempts policy bypass | Permission denied; role has no owner/BYPASSRLS privileges |
| RLS-004 | Insert chunk with mismatched tenant context | `WITH CHECK` denial |
| RAG-001 | Beta chunk is highest similarity for Alpha question | Beta chunk never enters candidate/source list |
| RAG-002 | Source archived/deleted before job completes | Retrieval excludes immediately; worker deletes chunk |
| RAG-003 | Source content/version changes | Old chunk rejected; replacement queued/indexed |
| RAG-004 | Vector result references missing source | Result discarded and stale-index metric emitted |
| RAG-005 | Retrieved note contains prompt injection | Treated as quoted data; cannot change tools, tenant, role, or system policy |
| RAG-006 | Approximate index with restrictive filters | Meets documented recall threshold or falls back to exact search |

### Structured insights and correctness

| Test ID | Scenario | Expected result |
|---|---|---|
| INS-001 | Win-rate question | Matches direct fixture calculation and date boundaries |
| INS-002 | Revenue/margin question | Authoritative totals calculated by application/SQL, not model |
| INS-003 | Empty or insufficient dataset | Explicit insufficient-data result; no invented trend |
| INS-004 | Archived/deleted records | Excluded according to metric definition |
| INS-005 | Timezone/date boundary | UTC storage and tenant-local display agree |
| INS-006 | Alternative quote lines | Metric definition consistently includes/excludes alternates |

### Retention, audit, and deletion

| Test ID | Scenario | Expected result |
|---|---|---|
| RET-001 | Raw prompt reaches expiry | Dry-run reports it; apply removes raw content idempotently |
| RET-002 | Redacted trace remains | Contains no configured PII/restricted sentinel |
| RET-003 | Customer/quote deletion | Index job created and retrieval immediately excludes source |
| RET-004 | Purge command targets non-test DB without apply authorization | Refuses mutation |
| AUD-001 | Successful retrieval | Audit records purpose/classification/source refs/counts only |
| AUD-002 | Denied retrieval | Audit records denial code without requested sensitive values |
| AUD-003 | Model/provider failure | Stable customer error; safe operational context logged |

### Product and mobile UX

| Test ID | Scenario | Expected result |
|---|---|---|
| UX-001 | Answer contains sources | Each citation opens an authorized current tenant record |
| UX-002 | Source becomes inaccessible | Citation is not rendered and answer is refreshed/invalidated |
| UX-003 | Member asks financial question | Clear permission message without leaking values |
| UX-004 | Mobile insight flow | No overflow; keyboard-safe actions; 44px targets |
| UX-005 | Screen reader | Purpose, confidence, source count, and denial are announced |
| UX-006 | Slow/provider failure | Progress, cancellation, retry, and retained user input behave correctly |

## 13. Verification commands and release evidence

Minimum local checks for every phase:

```bash
npm run build
npm run build:web
npm run lint:web
npm run prisma:validate
npm run test:security
npm run test:unit
npm run eval:ai
npm run audit:all
```

Database-backed release-candidate gate:

```bash
npm run verify:ci
npm run verify:launch
```

Additional required evidence:

- migrated disposable PostgreSQL integration run;
- RLS tests executed using the real non-owner runtime role;
- production-like Neon branch migration rehearsal;
- vector recall/latency benchmark with representative tenant sizes;
- prompt/classification eval corpus with restricted and PII sentinels;
- exact candidate SHA recorded for every deploy;
- manual iPhone and Android insight-flow smoke test;
- independent security review with no unresolved Critical/High finding.

## 14. Observability and alerts

Record metrics without raw prompts, retrieved text, customer contact data, or provider secrets:

- retrieval count/latency by purpose and model;
- denied retrieval count by stable denial code;
- source count and max classification distribution;
- stale vector result count;
- indexing queue depth, age, retry count, and deletion backlog;
- prompt/output token count and estimated cost;
- model/schema validation failures;
- RLS-denied operation count;
- cross-tenant boundary test status in CI;
- raw-prompt purge count and oldest overdue expiry.

Required alerts:

- readiness/migration failure;
- any indexing deletion backlog older than 24 hours;
- repeated RLS or authorization denials above baseline;
- unexpected retrieval with C4 classification;
- AI spend threshold breach;
- provider failure-rate/latency threshold breach;
- purge job failure or overdue raw-prompt expiry.

## 15. Rollout and rollback

### Rollout

1. Land additive classification/capability code with features disabled.
2. Add response projections and role tests.
3. Apply additive AI audit/retention migration.
4. Deploy dual-compatible code and backfill classification/expiry.
5. Enable structured insights for the internal tenant.
6. Rehearse pgvector/RLS migration on a Neon branch.
7. Deploy vector/indexing infrastructure with customer-facing RAG disabled.
8. Run shadow retrieval and inspect only content-free audit evidence.
9. Enable selected beta tenants.
10. Expand only after QA, security, privacy, cost, and support gates pass.

### Rollback

- Global kill switches independently disable structured insights, indexing, and RAG.
- Stop the indexing worker without disabling core quoting.
- Preserve RLS policies during an application rollback.
- Keep schema migrations additive until the new path is proven.
- Do not automatically restore purged raw prompt content.
- Use forward fixes for RLS/policy issues unless a verified database restore is explicitly authorized.
- Record rollback trigger, owner, exact SHA, migration state, and customer impact.

## 16. Definition of done

This initiative is complete only when:

- every retrievable field has an approved classification;
- every protected response uses a tested capability-aware projection;
- members cannot receive internal costs, margins, or raw prompt histories;
- tenant context comes only from live server-side membership;
- structured metrics are deterministic and reproducible;
- all new AI retrieval/index/audit tables enforce forced RLS with a non-bypass runtime role;
- cross-tenant higher-similarity vector results never enter the candidate set;
- archived/deleted data is immediately excluded and removed from the index within the deletion SLA;
- AI prompts are minimized, redacted, auditable, and expiration-aware;
- source citations are tenant-authorized, current, and user-visible;
- privacy disclosures, retention behavior, and provider configuration agree;
- production monitoring, kill switches, support steps, migration evidence, and rollback evidence exist;
- `npm run verify:launch` passes on the exact release SHA;
- the independent security verdict is `APPROVED` with residual operational/legal risks documented.

## 17. Decision and evidence log

| Date | ID | Decision/evidence | Owner | Status |
|---|---|---|---|---|
| 2026-08-11 | PLAN-001 | Initial data-classification, structured-insight, RAG, RLS, QA, and rollout plan drafted | Engineering | Completed |
| 2026-08-11 | BASE-001 | Live membership revalidation, tenant query helpers, and composite tenant relations confirmed in current code | Engineering | Confirmed |
| 2026-08-11 | BASE-002 | No existing RLS, pgvector migration, central classification registry, or retrieval audit table found | Engineering | Confirmed |
| 2026-08-11 | SRC-001 | OpenAI API data-control and retrieval documentation reviewed | Security | Confirmed |
| 2026-08-11 | SRC-002 | Neon RLS/pgvector and PostgreSQL RLS documentation reviewed | Security | Confirmed |
| 2026-08-11 | DEC-001 | Product authorized implementation of the recommended classification, capability, retrieval, and tenant-isolation plan; legal/privacy retention review remains separate | Product | Confirmed |
| 2026-08-11 | AIDR-IMPL-001 | Added typed field classifications, live-role capabilities, deterministic prompt redaction/hashing, no-new-raw-prompt persistence, and content-free retrieval audits | Engineering | Ready for review |
| 2026-08-11 | AIDR-TEST-001 | Fresh PostgreSQL 16 applied all 31 migrations; AI governance integration passed owner/admin/member projection, stale-role demotion, atomic cross-tenant source rejection, historical raw event/quote exclusion, audit minimization, and cross-tenant 404 | Engineering + Security | Passed |
| 2026-08-11 | AIDR-TEST-002 | AI governance unit tests passed 4/4; backend build and Prisma validation passed | Engineering | Passed |
| 2026-08-13 | AIDR-IMPL-002 | Connected Kody quote previews to governed tenant RAG, added bounded/redacted retrieval excerpts for answer composition, review-only grounded Quote Builder handoff, source chips, embedding spend telemetry, content/model-aware embedding reuse, and read-time source hash/lifecycle revalidation | Engineering + Security | Ready for database-backed review |
| 2026-08-13 | AIDR-TEST-003 | Fresh PostgreSQL 16 applied all 35 migrations; focused Kody and retrieval integration suites passed 16/16, including cross-tenant isolation, role classification, prompt injection containment, direct stale-source rejection, lifecycle retirement, and embedding reuse. Unit 48/48, security 4/4, backend/frontend builds, lint, SEO 6/6, and Prisma validation passed | Engineering + Security | Passed |
| 2026-08-24 | AIDR-IMPL-003 | Added production-default-off global/per-tenant RAG rollout with shadow exposure control, allowlist-aware worker processing, operator-visible rollout counts, full-index FTS reference preselection beyond the recent semantic cohort, bounded concurrent inline refresh, broader C4 credential quarantine, international contact redaction, and content-free failed retrieval audits | Engineering + Security | Ready for exact-candidate review |
| 2026-08-24 | AIDR-TEST-004 | Disposable PostgreSQL applied all 58 candidate migrations; focused retrieval, rollout-env, control-plane, and security-boundary integration passed 33/33; focused governance/rollout unit passed 34/34; retrieval eval passed 12/12. The complete local candidate then passed `verify:launch`: 240/240 integration tests, 92 executed browser tests plus one intentional opt-in capture skip, parser 17/17, assistant 83/83, retrieval 12/12, and clean dependency audits. Exact committed-SHA provider evidence and the production-like Neon rehearsal remain | Engineering | Passed local candidate gate |

## 18. Primary references

- OpenAI API data controls: https://platform.openai.com/docs/guides/your-data
- OpenAI retrieval guide: https://platform.openai.com/docs/guides/retrieval
- Neon Row-Level Security: https://neon.com/docs/guides/row-level-security
- Neon pgvector: https://neon.com/docs/extensions/pgvector
- PostgreSQL Row Security Policies: https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- QuoteFly threat model: `.agents/skills/quotefly-security-review/references/quotefly-threat-model.md`
- QuoteFly multi-tenant baseline: `docs/architecture/multi-tenant-data-plan.md`
