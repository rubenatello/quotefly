# QuoteFly Superuser Data Governance Console Plan

Status: implementation in progress

Owner: QuoteFly engineering

Security posture: read-only control plane until step-up authentication and approval controls are available

Related: [AI data classification and retrieval plan](./ai-data-classification-retrieval-plan.md)

## Outcome

Give explicitly allowlisted QuoteFly operators a responsive console that can inspect platform health, tenant metadata, the reviewed data-classification catalog, role permissions, AI model usage, schema drift, validation history, and operator audit history without exposing raw tenant records or credentials.

The first release is intentionally not a database editor. Tenant mutation, arbitrary SQL, raw row browsing, C3/C4 content access, policy weakening, credential access, and impersonation remain disabled. Those capabilities require a separate design with phishing-resistant step-up authentication, reason capture, time-bound grants, approval policy, immutable audit evidence, and incident-response procedures.

## Security boundaries

- Every endpoint requires a valid session, a live non-deleted membership, and a current email in `SUPERUSER_EMAILS`.
- Superuser status never comes from a request body, URL, client claim, or tenant role alone.
- Tenant listings contain metadata and aggregate counts only. They exclude owner email, customer data, provider identifiers, credentials, raw prompts, quote contents, and financial row detail.
- Catalog views expose schema metadata and classification policy, not database values.
- Validation runs are deterministic and content-free. They store schema hashes, counts, issue codes, policy version, actor, request ID, and time.
- Operator reads and validation runs create audit events. Search text is not copied into audit metadata.
- New models and scalar fields fail closed until reviewed. Unreviewed data is C4/review-required and cannot become RAG eligible.
- C3 financial data and C4 restricted data are never vector eligible in the initial policy.
- Tenant-scoped AI retrieval must independently filter by authenticated `tenantId`; the console does not bypass that data plane.

## Trackable delivery phases

### SGA-0 — Threat model and operating policy

- [x] Define the console as a separate platform control plane.
- [x] Document the initial read-only boundary.
- [x] Define C0–C4 classification and AI purpose policy.
- [x] Prohibit unrestricted SQL, raw rows, credentials, impersonation, and unaudited mutation.
- [ ] Owner approval for operator identities and emergency-access process.
- [ ] Add phishing-resistant MFA/step-up authentication before any mutation is enabled.
- [ ] Define retention and alerting for operator audit records.

### SGA-1 — Schema catalog and drift validation

- [x] Inventory every current Prisma model and scalar field.
- [x] Assign model defaults, field overrides, tenant scope, purpose, and required access.
- [x] Maintain an explicit RAG allowlist.
- [x] Compute deterministic live-schema and reviewed-baseline SHA-256 fingerprints.
- [x] Fail validation on unreviewed models, fields, invalid overrides, or forbidden RAG classifications.
- [x] Warn when reviewed models or fields disappear.
- [x] Add a pure validator for V2 drift regression tests.
- [ ] Extend drift detection to flag scalar type/nullability/default changes, not only names.

### SGA-2 — Audited control-plane API

- [x] Add platform summary endpoint.
- [x] Add bounded tenant metadata list with lifecycle/search/pagination.
- [x] Add filtered data-classification catalog endpoint.
- [x] Add workspace/operator permission matrix endpoint.
- [x] Add rate-limited validation-run endpoint and bounded history.
- [x] Add bounded operator audit history.
- [x] Persist actor, request ID, target hash when needed, bounded metadata, and timestamp.
- [ ] Add an alert destination for failed validation and suspicious operator access.
- [x] Audit legacy AI-quality summary and tenant-spend reads.

### SGA-3 — Responsive operator console

- [x] Overview: platform/AI totals, observed models, live drift status, mutation boundary.
- [x] Tenants: searchable metadata and aggregate counts, no raw tenant content.
- [x] Data Explorer: model/field/classification/RAG/access filters and compact mobile cards.
- [x] Permissions: owner/admin/member capability matrix plus operator-denied capabilities.
- [x] Validation: manual rerun, hashes, issues, history, and clear pass/fail state.
- [x] Audit: actor/action/time/target metadata without sensitive payloads.
- [x] Link existing AI Quality console.
- [x] Verify 390px mobile usability, 44px targets, and no horizontal page overflow.

### SGA-4 — Future guarded operations (not authorized in this release)

- [ ] Adopt phishing-resistant MFA and recent step-up claims.
- [ ] Add reason/ticket capture and time-bound authorization.
- [ ] Require dual approval for destructive or cross-tenant data access.
- [ ] Define narrowly typed operations instead of arbitrary SQL.
- [ ] Add dry-run previews, idempotency, soft-delete, rollback, and before/after hashes.
- [ ] Add customer-visible support-access disclosure and revocation where appropriate.
- [ ] Exercise emergency access and incident response before enabling production mutations.

### SGA-5 — Retrieval/data-plane hardening

- [ ] Add PostgreSQL RLS defense in depth for tenant-scoped retrieval tables.
- [ ] Use a least-privileged runtime DB role in Neon; keep migration role separate.
- [ ] Add tenant-scoped embeddings with composite tenant/source constraints.
- [ ] Add asynchronous re-indexing with idempotency and deletion propagation.
- [ ] Add policy-version invalidation and re-index controls.
- [ ] Prove cross-tenant zero-result behavior under malicious identifiers and concurrency.

## QA matrix

| ID | Test | Expected result |
|---|---|---|
| AUTH-01 | Unauthenticated control-plane request | `401`; no data and no validation write |
| AUTH-02 | Authenticated non-superuser request | stable `403 SUPERUSER_REQUIRED` |
| AUTH-03 | Allowlisted user whose live membership is deleted | rejected before handler |
| AUTH-04 | Client forges role/email/tenant parameters | ignored; server session and live membership win |
| TENANT-01 | List active/deleted/all tenants | correct bounded metadata and totals only |
| TENANT-02 | Search using a unique owner/customer/provider value | no response field leaks that value |
| TENANT-03 | Search audit event | records `searchApplied`, never the query text |
| CATALOG-01 | Current generated Prisma schema | live and baseline hashes match; status `PASSED` |
| CATALOG-02 | Add a V2 model | `UNREVIEWED_MODEL`; validation `FAILED` |
| CATALOG-03 | Add a scalar field to a reviewed model | `UNREVIEWED_FIELD`; validation `FAILED` |
| CATALOG-04 | Mark C3/C4 field RAG eligible | `RAG_CLASSIFICATION_FORBIDDEN`; validation `FAILED` |
| CATALOG-05 | Credential, token, binary, webhook payload fields | C4 and RAG excluded |
| VALID-01 | Superuser reruns validation | persisted run plus same-transaction audit event |
| VALID-02 | Repeated validation | stable hashes for unchanged generated client |
| VALID-03 | More than rate limit | `429`; no extra validation record |
| AUDIT-01 | View summary/catalog/tenants/permissions/history | bounded audit event for each action |
| AUDIT-02 | Audit response | no secrets, raw prompts, quote/customer contents, or raw search |
| UI-01 | 390×844 viewport | readable cards/tabs, 44px controls, no page overflow |
| UI-02 | Keyboard-only navigation | visible focus and logical tab order |
| UI-03 | Failed validation | issue code/model/field is readable; no sensitive values |
| DB-01 | Fresh PostgreSQL with all migrations | migrations apply and focused integration suite passes |
| DB-02 | Delete actor user | audit/validation evidence survives with nullable actor reference |

## Release evidence log

| Date | Candidate | Evidence | Result |
|---|---|---|---|
| 2026-08-11 | main release candidate | Generated Prisma catalog: 28 models, 376 scalar fields; hashes match | Passed |
| 2026-08-11 | main release candidate | Backend TypeScript compile after control-plane API | Passed |
| 2026-08-11 | main release candidate | Unit suite 31/31, including V2 model/field drift and C4 RAG exclusion | Passed |
| 2026-08-11 | main release candidate | Fresh PostgreSQL 16, all 32 migrations, AI governance plus control-plane integration 4/4 | Passed |
| 2026-08-11 | main release candidate | Frontend production build, lint, SEO 6/6, 390×844 operator console Playwright 1/1 | Passed |

## Definition of done for the read-only release

The release is ready for a candidate build only when all SGA-1, SGA-2, and SGA-3 items are complete; the current-schema validator passes; authorization, tenant-metadata, audit, and validation integration tests pass on a freshly migrated PostgreSQL database; frontend build/lint/mobile checks pass; and an independent security review records no unresolved P0/P1 finding for the read-only surface.
