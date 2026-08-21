# QuoteFly English and Spanish Localization Plan

Status: In progress
Initial locales: `en-US`, `es-US`
Spanish style: neutral U.S. Spanish for Latin American trade businesses
Core rule: language preference never changes tenant authorization, data visibility, pricing permissions, or customer-document language implicitly.

## Product outcomes

- [x] A signed-out visitor can choose English or Spanish before signup or sign-in.
- [x] Every signed-in user can choose their own workspace language independently of coworkers.
- [x] The preference persists across devices and sessions and updates `<html lang>` immediately.
- [x] Core mobile and desktop workflows are coherent in either language: Home, customers, quotes, products, Activity, team, settings, branding, and notifications.
- [x] Kody understands supported Spanish commands and answers in the signed-in user's language without weakening tenant, role, classification, citation, or confirmation controls.
- [x] Customer-facing quote language is explicit and snapshotted; changing an employee's UI language never rewrites or silently translates a customer quote.
- [x] Dates use the selected language and tenant timezone; timestamps remain UTC in PostgreSQL. Currency remains USD unless a future billing/product decision changes it.
- [x] Tenant-entered customer, product, quote, note, and business text is never automatically translated without a reviewable user action.

## Phase 1 — Locale foundation

- [x] Define supported locale codes as `en-US | es-US`.
- [x] Add `User.preferredLocale` with an additive checked migration and `en-US` fallback.
- [x] Return the preference from the live authenticated session.
- [x] Add a self-only authenticated preference update endpoint; never accept a target user or tenant ID.
- [x] Classify the preference as `C2_CUSTOMER_CONFIDENTIAL` and exclude it from RAG/vector indexing.
- [x] Add the React localization provider and typed English/Spanish dictionaries.
- [x] Resolve signed-out locale from `qf_locale`, then browser language, then `en-US`.
- [x] Reconcile signed-in locale to the server preference and persist deliberate changes locally and server-side.
- [x] Set `document.documentElement.lang` and use locale-aware `Intl` helpers.
- [x] Add dictionary parity and missing-key tests.

Acceptance:

- Invalid locales return a stable 400 error code.
- One user cannot update another user's preference.
- Two users in one tenant can use different languages without affecting each other.
- Language changes do not alter tenant IDs, roles, record assignment, prices, costs, or AI budgets.

## Phase 2 — Core workspace localization

- [x] Translate shared shell navigation, mobile header, sidebar, bottom navigation, search, loading, empty, error, confirmation, toast, pagination, and accessibility labels.
- [x] Translate Home and Activity first so the daily operational surface is coherent.
- [x] Translate customers, quick customer creation, customer detail, archive/delete/restore/merge, and search/filter states.
- [x] Translate quote builder, quote desk, quote lists, review/send confirmation, and recovery states.
- [x] Translate products/starter catalog, team/users, My info, settings, branding, analytics, billing, and setup.
- [x] Centralize role, lifecycle, status, unit, trade, and job-state labels; do not expose raw enum values such as `SENT_TO_CUSTOMER`.
- [ ] Translate stable API errors by code while preserving safe English fallback text for compatibility.

Acceptance:

- No mixed-language core workflow at 360, 390, 768, 1280, and 1440 pixels.
- All touch targets remain at least 44 by 44 pixels.
- Long Spanish labels do not clip, overlap, or create horizontal scrolling.
- Screen-reader names, focus order, live announcements, and validation messages work in both languages.

## Phase 3 — Kody in Spanish

- [x] Derive response language from the live authenticated user's preference, not from a client-supplied tenant or role.
- [x] Add Spanish deterministic routing for customer add/find, quote draft/prepare-send, product add/find, follow-up, customers without quotes, navigation, pipeline, revenue, and profitability.
- [x] Localize deterministic answers, action labels, confirmations, denials, empty results, safety disclosures, and error recovery.
- [x] Add Spanish prompt-injection, cross-tenant, secret-exfiltration, and out-of-scope phrases.
- [x] Redact Spanish credential labels such as `contraseña`, `clave`, `secreto`, and `autorización` before provider calls.
- [x] Make lexical tokenization Unicode/accent safe and add Spanish stop words and follow-up phrasing without excluding English tenant records.
- [x] Keep structured tool/action enum names internal and language-neutral.
- [ ] Record response locale in content-free AI telemetry when the usage schema is expanded.

Acceptance:

- Spanish eval coverage exists for every supported Kody action and matches English authorization behavior.
- Spanish prompts cannot select another tenant, bypass record assignment, expose internal costs to members, or cause unconfirmed writes/sends.
- Kody declines unrelated requests in natural, respectful Spanish.
- English and Spanish answers retain the same citation and numeric-grounding requirements.

## Phase 4 — Customer documents and communications

- [x] Add owner/admin `Tenant.defaultCustomerLocale`.
- [x] Add optional `Customer.preferredLocale`.
- [x] Persist `Quote.documentLocale`, resolved as explicit quote choice → customer preference → tenant default → `en-US`.
- [x] Snapshot document locale in quote revisions and sent-document snapshots with legacy `en-US` fallback.
- [x] Localize PDF headings, totals, dates, metadata, and static footer text while preserving tenant-authored line items and scope exactly.
- [ ] Add English/Spanish built-in email, SMS/share, password reset, and account-security templates.
- [x] Keep custom tenant message templates language-specific; never label an existing English custom template as Spanish.
- [ ] Add an explicit, reviewable translation workflow later for user-authored quote content.

Acceptance:

- PDF preview, downloaded PDF, printed PDF, and sent snapshot use the same selected template and document language.
- Internal unit costs and margins never appear in either language's customer-facing output.
- Previously sent PDFs remain byte-stable after user/tenant language changes.
- Accented names and Spanish punctuation render correctly.

## Phase 5 — Public site, SEO, legal, and onboarding

- [x] Add an accessible language switch before authentication.
- [ ] Translate signup, sign-in, password recovery, onboarding, pricing, and public product pages.
- [ ] Publish Spanish pages under stable `/es/...` URLs rather than changing content at one canonical URL.
- [ ] Add `hreflang` for `en-US`, `es-US`, and `x-default`, localized canonicals, JSON-LD, Open Graph data, sitemap alternates, and correct HTML language.
- [ ] Have Spanish Terms, Privacy, Cookie, billing, consent, and customer-communication copy professionally reviewed before publication.
- [ ] Add bilingual starter-catalog labels and keywords while preserving tenant-owned customized names/descriptions.

## Verification and release evidence

- [x] Backend build, web build, web lint, Prisma validation, dependency/security audits.
- [x] Unit tests for locale resolution, dictionary parity, formatters, plurals, enum labels, templates, and PDF copy.
- [x] Fresh migrated PostgreSQL integration tests for preference ownership, document-locale precedence, snapshot immutability, and cross-tenant denial.
- [x] Kody English/Spanish routing, safety, retrieval, citation, numeric-grounding, and provider-payload tests.
- [ ] Playwright in both languages at 360, 390, 768, 1280, and 1440 pixels, including keyboard and screen-reader semantics.
- [ ] Render and visually inspect all quote templates in Spanish, including long/multipage quotes.
- [x] Run `npm run verify:ci` on the exact candidate.
- [x] Independent Goldface, Sentinel, and Opera review for the authenticated tenant application.
- [ ] Real-device Spanish smoke test for customer → quote → PDF → send → Activity.

### 2026-08-20 authenticated-app release evidence

- `verify:ci`: passed with 147 database-backed integration tests plus build, lint, Prisma, security, AI, retrieval, and dependency gates.
- Playwright: 67/67 passed, including Spanish workspace, customer recovery/timezone, quote workflow/feedback, shared UI, and authenticated error paths.
- Independent scores: Goldface 96/100, Sentinel 97/100, Opera 97/100; authenticated tenant application approved.
- Public `/es` SEO/legal publication, professional legal review, production-like Neon migration rehearsal, and real-device smoke testing remain release-owner follow-ups.

## Explicit non-goals for the first release

- Automatic translation of tenant-authored customer or quote content.
- Inferring language from name, phone number, location, trade, or ethnicity.
- Changing billing currency based on UI language.
- Allowing browser/request locale to override server-side tenant, role, record, classification, or cost visibility rules.
