# QuoteFly Critical Improvements Program

Status: Critical safety tranche complete; broader program in progress
Program baseline: `7f75827112b4d6c8794c683af3bbaf488cb90a71` (`origin/main`, 2026-08-25)
Owner: Product and Engineering
Release rule: Code completion is not production proof. Provider, database-role, device, and rollout evidence remain explicit gates.

## Objective

Raise QuoteFly from a strong release candidate to a production-proven quoting and lightweight operations product. The program prioritizes a foolproof customer-to-quote workflow, authoritative pricing, safe tenant-aware Kody tools, controlled RAG rollout, complete operational boundaries, differentiated public pages, and evidence-backed SEO/AEO claims.

## Baseline scores

| Surface | Baseline | Target |
| --- | ---: | ---: |
| Public website | 83/100 | 92/100 |
| Landing page | 89/100 | 94/100 |
| Solutions page | 84/100 | 92/100 |
| Services/features page | 70/100 | 92/100 |
| About page | 82/100 | 90/100 |
| Kody and connected workflows | 79/100 | 92/100 |
| Deterministic Kody tools | 88/100 | 95/100 |
| Provider-backed Kody quality | 64/100 | 90/100 |
| RAG readiness | 73/100 | 90/100 |
| Quote workflow integrity | 83/100 | 95/100 |
| Jobs, scheduling, dispatch, and invoice lifecycle | 76/100 | 90/100 |
| Tenant isolation and live authorization | 94/100 | 97/100 |
| AI security, privacy, and operations | 82/100 | 94/100 |

Targets are engineering-quality goals, not ranking, citation, latency, or conversion guarantees.

## Program rules

- A Kody action remains review-only until a user confirms it in the normal product workflow.
- Customer-visible prices require authoritative provenance or an explicit unresolved-pricing state.
- Jobs, appointments, invoices, balances, and lifecycle state use deterministic database tools before general narrative RAG.
- Every tenant record query is scoped by live tenant, role, assignment, lifecycle, and purpose where applicable.
- Public claims require a claim-to-test mapping and must describe current behavior and boundaries.
- Production RAG remains `off` or `shadow_allowlist` until the rollout gates in this document pass.
- BCP, deployment, provider enablement, and production migration remain separately authorized actions.

## Phase 1 — Quote correctness and bounded provider behavior

| ID | Work item | Status | Acceptance evidence |
| --- | --- | --- | --- |
| QF-001 | Consolidate Kody quote drafting and Quote Builder AI behind one typed preparation boundary | In progress | Customer resolution, catalog grounding, optional provider enhancement, provenance, and review handoff share one contract; duplicate orchestration is removed or explicitly deprecated |
| QF-002 | Bound all quote provider calls | Complete | Every quote-route provider start shares one deadline and a two-call maximum with per-call timeout. Route-time retrieval is provider-free lexical retrieval and inline embedding refresh remains an index-job responsibility; deterministic fallback and focused coverage pass |
| QF-003 | Add price provenance and unresolved-pricing safety | Complete | AI responses and durable quote lines carry typed provenance; unmatched work is zero-priced and requires review; tenant presets retain immutable source snapshots; defensive frontend review gate passes |
| QF-004 | Cover inspection and unknown-damage prompts | Complete | Canonical inspection prompt preserves the `3–4` range, returns assumptions, marks price unresolved, totals zero, and performs no write in database-backed integration coverage |
| QF-005 | End missing-idempotency compatibility paths | Planned | Measured current-client adoption; missing/malformed keys return 400; replay and payload-conflict tests pass |

## Phase 2 — Complete the canonical Kody workflow

| ID | Work item | Status | Acceptance evidence |
| --- | --- | --- | --- |
| QF-101 | Add tenant-configurable trade labels without silent Construction fallback | Planned | At least ten additional trade fixtures preserve the requested trade through quote, Job, catalog, analytics, and retrieval metadata |
| QF-102 | Add deterministic Job search and status tools | Complete | `SEARCH_JOBS` and `GET_JOB_STATUS` are live-role, tenant, assignment, and lifecycle scoped, cap results at eight, omit operationally sensitive notes, and use zero provider budget |
| QF-103 | Add deterministic invoice list and status tools | Complete | `LIST_INVOICES` and `GET_INVOICE_STATUS` scope through accessible Jobs, hide financial values without billing permission, return typed safe actions, and use zero vector/provider budget |
| QF-104 | Add atomic reviewed customer-plus-quote creation | Planned | Duplicate resolution and create/reuse customer plus quote occur under one idempotent reviewed command; failure cannot leave an unintended partial customer |
| QF-105 | Persist catalog provenance | Complete | Quote lines retain typed pricing origin plus immutable tenant-preset id, name, catalog key, version, and source-update snapshots across create, sheet save, line add, revision, and restore paths. Current line quantity, price, and cost remain editable reviewed quote values and are not represented as immutable preset defaults |
| QF-106 | Strengthen catalog match confidence | Planned | Low-confidence matches require confirmation; false-positive corpus covers aliases, single-token collisions, unsupported work, and more than 200 presets |
| QF-107 | Add exact canonical prompt acceptance coverage | Partially complete | Exact inspection/range/no-price/no-write coverage and deterministic customer/job/invoice routing pass; atomic new-customer creation, full ambiguity matrix, and real-device acceptance remain open |

## Phase 3 — Kody frontend resilience

| ID | Work item | Status | Acceptance evidence |
| --- | --- | --- | --- |
| QF-201 | Disclose and paginate bounded search results | Complete | Kody announces totals accessibly, discloses truncation, supports show-more, and keeps visible records aligned with available actions |
| QF-202 | Preserve retry identity after ambiguous failures | Complete | Kody and Quote AI preserve the exact request identity for safe retry while request changes receive a new identity; existing replay/payload-conflict backend checks remain green |
| QF-203 | Add cancellation and ignore-late-result behavior | Complete | Kody and Quote AI cancel superseded requests, ignore late responses, preserve prompt state, and avoid stale-result overwrite |
| QF-204 | Recover unfinished clarification safely | Existing gate; partially complete | Authenticated server recovery and browser plaintext purge tests pass; a dedicated multi-turn clarification recovery acceptance test remains open |
| QF-205 | Maintain field accessibility | Complete in automated gates; real-device evidence remains | Kody totals/disclosure, invoice financial facts, focus visibility, reduced motion, and public Axe coverage are implemented; the full 103-case Playwright suite passed with only the intentional capture-only skip. Real-device evidence remains QF-604 |

## Phase 4 — RAG, privacy, and provider operations

| ID | Work item | Status | Acceptance evidence |
| --- | --- | --- | --- |
| QF-301 | Implement dry-run-first AI retention | Complete | `npm run ai:retention` defaults to dry-run, requires explicit guarded apply, is idempotent, minimizes expired raw prompts/feedback, and is covered by unit/integration tests plus a backup-aware runbook |
| QF-302 | Define and enforce feedback retention | Complete | Feedback expiry, prompt minimization, content-free audit fields, bounded handling, tenant isolation, and idempotent rerun behavior are documented and tested |
| QF-303 | Extend forced-RLS defense in depth | Architecture decision required | Existing runtime service boundaries and cross-tenant tests remain green. Forcing RLS on legacy usage/feedback tables is deferred because the legacy `AFTER INSERT` bridge and audited cross-tenant control-plane reads require an explicit migration design |
| QF-304 | Add request-aware, PII-free provider diagnostics | Complete | Provider fallback diagnostics now emit request correlation, provider/model, and a stable failure class without prompts, customer content, credentials, or raw provider errors; tests pass |
| QF-305 | Record OpenAI project data-control evidence | Owner evidence required | Dated project setting, retention mode, configuration owner, DPA/subprocessor review, and aligned privacy copy; `store:false` is not treated as ZDR evidence |
| QF-306 | Pass exact-SHA provider evaluation | Owner/provider evidence required | All synthetic cases pass on the exact candidate and retain structured/citation/numeric/accounting guards |
| QF-307 | Rehearse production-like Neon RLS and rollback | Planned | Real non-owner runtime role, pooled connection, migration, rollback, stale-source deletion, and kill-switch evidence pass |
| QF-308 | Run shadow and beta pilots | Planned | Approved tenants, disclosure/consent, latency, quality, cost, denial, freshness, feedback, alert delivery, and rollback evidence |
| QF-309 | Add source deep links and freshness | Planned | Every visible citation opens an authorized current record or clearly reports unavailable/stale evidence |

## Phase 5 — Jobs, dispatch, and invoicing completeness

| ID | Work item | Status | Acceptance evidence |
| --- | --- | --- | --- |
| QF-401 | Preserve existing accepted-quote Job and overlap-safe scheduling invariants | Ongoing gate | Row locks, composite tenant relations, lifecycle checks, immutable events, and notifications remain green |
| QF-402 | Add immutable invoice line snapshots | Complete | Invoice creation transactionally snapshots included reviewed quote lines, excludes alternates, remains unchanged after source edits, and enforces forced RLS plus runtime select/insert-only privileges (update/delete/truncate are denied) |
| QF-403 | Add issue, send-log, and void commands | Planned | Role, lifecycle, idempotency, audit, customer-visible boundary, and recovery tests pass |
| QF-404 | Add payment recording and reconciliation | Planned | Partial/full payments, balance, duplicate/replay, provider event, failure, and cross-tenant tests pass |
| QF-405 | Define refunds and disputes | Planned | Explicit state machine and accounting/provider reconciliation policy approved before implementation |
| QF-406 | Preserve honest marketing boundaries | Ongoing gate | Public pages continue to say internal invoice records do not themselves collect payment until that changes and is proven |

## Phase 6 — Public website and product evidence

| ID | Work item | Status | Acceptance evidence |
| --- | --- | --- | --- |
| QF-501 | Rebuild `/services` as the definitive features page | Complete | `/services` now presents the complete current workflow, inputs/outputs/limits, honest operational boundaries, semantic sections, contextual links, and responsive real product captures |
| QF-502 | Make `/about` a credible company page | Partially complete | Buyer-facing product definition, mission, audience, evidence, imagery, and AEO/SEO copy are implemented; owner-verified people, origin, ownership/legal facts, and review date remain owner inputs |
| QF-503 | Remove cross-page workflow redundancy | Complete | Landing remains conversion-oriented, Solutions covers trade fit, Services defines capabilities/boundaries, and About establishes product/company purpose with materially differentiated content |
| QF-504 | Standardize premium product captures | Partially complete | Real responsive v1/v2 desktop/mobile captures with intrinsic sizing replace pixelated treatment; deterministic capture automation, AVIF/WebP variants, asset budgets, and visual regression remain open |
| QF-505 | Improve social and shared media | Planned | Route-specific 1200x630 images, route-specific alt text, `twitter:image:alt`, optimized logo/favicon, and asset budgets |
| QF-506 | Add the public canonical Kody proof | Planned | Combined customer lookup, ambiguity, work matching, hours, lines, assumptions, and explicit unsaved review accurately mirror tested product behavior |
| QF-507 | Maintain SEO/AEO technical eligibility | Ongoing gate | Prerender, canonicals, schemas, sitemap, robots, noindex boundaries, raw HTML, and public SEO tests pass |
| QF-508 | Record crawler-policy decision | Owner decision required | Search retrieval and model-training crawler policies are documented separately; no training-access change is inferred |
| QF-509 | Add measurement evidence | Owner/tooling evidence required | Search Console, Bing, field CWV, crawler logs, AI referrals, citations, and conversion observations are reported without PII or invented results |

## Phase 7 — Release evidence and independent review

| ID | Work item | Status | Acceptance evidence |
| --- | --- | --- | --- |
| QF-601 | Keep focused tests green during implementation | Complete | Unit, integration, security, SEO/AEO, accessibility, deterministic AI/retrieval, and full Playwright gates pass; the final Playwright run reported 102 passed and one intentional capture-only skip |
| QF-602 | Pass `npm run verify` | Complete | Exact working tree passed the full repository gate on 2026-08-25 |
| QF-603 | Pass migrated database launch gate | Complete | The exact final working tree passed `npm run verify:launch` on 2026-08-25: all 61 migrations were already applied to the clean guarded PostgreSQL database with 61 finished and zero rolled back, all 249 integration tests passed, and Playwright passed 102/102 runnable tests with one intentional capture-only skip |
| QF-604 | Run real-device workflow smoke | Owner/device evidence required | Customer lookup/create, Kody clarification, quote handoff/save, PDF, share, Job, schedule/dispatch, and invoice record on representative phones |
| QF-605 | Obtain Opera verdict | Complete | Independent Opera re-review returned APPROVED on 2026-08-25 with no unresolved Critical, High, or release-blocking Medium code finding; QF-OP-01 through QF-OP-04 were confirmed remediated |
| QF-606 | BCP/deploy only with explicit authorization | Not authorized | No commit, push, deploy, provider enablement, DNS change, or production migration occurs implicitly |

## Canonical Kody acceptance scenario

The release suite must cover this intent without relying on a single exact wording:

> Kody, I need a {trade} quote for {job/product/service} for {customer name, phone, or email}. It should take about 3–4 hours depending on damage or inspection. Please prepare the quote for review.

Required behavior:

1. Resolve the live tenant, actor, role, assignment, and feature entitlement.
2. Search customers deterministically by normalized name, email, or phone.
3. Ask one bounded clarification for ambiguity, missing customer details, work, trade, duration, or unresolved pricing.
4. Offer an explicit reviewed new-customer path when no match exists.
5. Match tenant-authorized saved products/services and return separate lines with confidence and provenance.
6. Preserve the 3–4-hour range and inspection/damage assumption.
7. Mark unresolved price as unresolved; never invent authoritative-looking customer pricing.
8. Open an unsaved, unsent Quote Builder review with merge/replace/keep behavior.
9. Perform zero customer, quote, send, booking, dispatch, or invoice mutation before normal confirmation.
10. Preserve idempotency and recovery across timeout, lost response, refresh, and retry without leaking raw prompt data.

## Evidence log

| Date | Evidence | Result |
| --- | --- | --- |
| 2026-08-25 | Exact `origin/main` CI launch gate at `7f75827` | Passed |
| 2026-08-25 | AI parser evaluation | 17/17 passed |
| 2026-08-25 | Assistant intent/context/safety evaluation | 83/83 passed |
| 2026-08-25 | Retrieval evaluation | 12/12 passed |
| 2026-08-25 | Public SEO tests and prerender | 10/10 passed; 16 routes prerendered |
| 2026-08-25 | Public desktop/mobile accessibility audit | No critical, serious, or moderate Axe violations in eight route states |
| 2026-08-25 | Latest provider-backed evidence on prior SHA | Failed 4/6; exact-candidate rerun remains required |
| 2026-08-25 | Clean disposable PostgreSQL migration rehearsal | 61/61 migrations applied; 61 finished, zero rolled back, schema current |
| 2026-08-25 | Full database-backed integration suite on exact working tree | 24/24 files and 249/249 tests passed |
| 2026-08-25 | Full `npm run verify` on exact working tree | Passed: backend, 116-route audit, web build/prerender, lint, Prisma, security, unit, AI, assistant, retrieval, and dependency audits |
| 2026-08-25 | Unit and security aggregate | 187 passed across the diagnostic pretest and main unit/web scripts, one intentional Redis skip; security 5/5 passed |
| 2026-08-25 | Full Playwright workflow and accessibility suite | 102/102 runnable tests passed; one intentional capture-only test skipped |
| 2026-08-25 | Focused draft-cleanup race stress | 5/5 consecutive runs passed; successful cleanup remained the final draft write after delayed autosave |
| 2026-08-25 | Exact final-tree `npm run verify:launch` | Passed end to end: build, route audit, web build/prerender, lint, Prisma, security, unit, 249 integration tests, all deterministic AI evaluations, dependency audits, and 102 runnable Playwright tests |
| 2026-08-25 | Independent Opera quality gate | APPROVED; no unresolved Critical, High, or release-blocking Medium code finding; independent focused rerun passed 18/18 tests |

## Status maintenance

Update this document in the same change that completes an item. Link the test, migration, runbook, screenshot, external run, or owner decision that proves the acceptance criteria. Do not mark a provider, device, production database, legal, crawler-policy, or measurement item complete from code-only evidence.
