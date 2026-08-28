# QuoteFly Controlled Beta Feature Readiness

Target launch stage: controlled beta for blue-collar contractors. The beta goal is to prove customer intake, manual quote creation, branded PDF output, and follow-up tracking before selling advanced provider-dependent tiers.

## Status Key

- `Ready`: Acceptable for controlled beta with automated coverage or a defined smoke check.
- `Beta`: Usable by selected testers, but needs more hardening, UX polish, or coverage before broader launch.
- `Provider setup required`: Code path exists, but production credentials, webhooks, sandbox validation, or legal/provider review are still required.
- `Engineering candidate — unavailable`: Default-off code/schema may be under review, but no customer, sandbox, or production availability is asserted.
- `Post-launch`: Keep visible only as roadmap, gated, disabled, or internal-only until a later release.

## Readiness Matrix

| Surface | Status | Coverage | Launch Notes | Before Broad Production |
| --- | --- | --- | --- | --- |
| Marketing site | Ready | Playwright public-page smoke for landing, pricing, support, privacy, terms, cookies | Basic is the only purchasable launch plan; Professional and Enterprise stay disabled/coming soon | Final domain, SEO metadata review, support contact verification |
| Auth/session | Ready | Playwright UI signup, reload restore, logout; integration auth tests | Browser auth uses HttpOnly cookie. `qf_token` localStorage storage must remain removed | Verify production cookie/CORS settings on real domains |
| Onboarding/setup | Ready | API signup applies default setup; manual setup save smoke | Supported trades and presets are available for beta users | Add E2E for manual setup customization if setup becomes a primary beta workflow |
| Customers | Ready | Playwright customer create, search, duplicate warning; integration tenant isolation | Archive/delete are retained data paths and should be manually smoked before release handoff | Add full E2E for edit notes/status, archive, delete |
| Quotes | Ready | Playwright manual quote creation through UI; integration quote tenant isolation | Manual quote line math and quote-desk transition are launch-critical | Add E2E for line edit/delete after quote creation |
| Quote desk, PDF, send log | Ready | Playwright quote desk open, PDF API response, browser PDF download, mark sent, seeded send log | Native email/SMS app opening is browser/device dependent; beta path records outbound events where available | Manual smoke on iOS/Android share/email/SMS behavior |
| Analytics | Beta | Manual smoke | Useful for beta visibility, but advanced analytics are plan-gated and not core launch acceptance | Add deterministic analytics fixtures and E2E coverage |
| Branding | Beta | Manual quote/PDF visual smoke | Basic branding works; attribution is gated by plan | Add PDF visual snapshot or manual sign-off checklist |
| Admin/team | Beta | Manual smoke; API integration coverage exists for protected auth surface | Team management is owner/admin gated and constrained by plan limits | Add E2E for add/update/remove team member |
| Billing | Provider setup required | Billing webhook integration test; billing-required UI manual smoke | Stripe test mode can be used for beta. Basic is sellable; advanced tiers remain disabled | Production Stripe price IDs, webhook secret, customer portal, tax/account settings |
| QuickBooks | Engineering candidate — unavailable | CSV/export is supported; default-off hosted-payment candidate requires exact-SHA automated, migration, sandbox, security, and operations evidence | Direct QuickBooks connection, invoice publishing, InvoiceLink delivery, payment reconciliation, CDC, and webhooks remain unavailable. No sandbox or production evidence is claimed; taxable invoices remain blocked | Complete `docs/integrations/quickbooks-hosted-payments-reconciliation.md`, production-like migration/restore rehearsal, Intuit sandbox checklist, alerts/runbooks, Sentinel review, Opera approval, and separate owner authorization |
| Twilio/SMS provider | Provider setup required | Manual smoke only; native SMS app is the beta send path | Twilio inbound webhook is disabled unless `ENABLE_TWILIO_SMS=true` | Twilio credentials, webhook validation, compliance copy, opt-out handling |
| AI quoting/revision | Beta | Parser/assistant/retrieval evals, tenant/RLS retrieval integration, and manual AI prompt smoke | Deterministic customer/catalog/Jobs/dispatch/invoice tools and review-only drafting are available. RAG is production-default-off and limited to a controlled `shadow_allowlist` pilot; users must review every quote before sending | Exact-SHA provider 6/6, OpenAI account/data-control evidence, Neon migration/RLS rehearsal, pilot alerts, signed shadow review, and production-scale FTS/semantic latency evidence before exposure |
| Legal/privacy | Ready | Playwright page smoke | Privacy, data privacy, terms, and cookie policy pages exist | Legal review before public paid launch |
| Internal admin/AI quality | Beta | Manual superuser smoke | Superuser-gated; not tenant-visible | Add audit logging and production access review |

## Launch Acceptance Mapping

Ready features must have either automated coverage or a named manual smoke check. Current automated launch coverage is:

- Public pages and auth modal.
- UI signup, HttpOnly cookie session restore, logout, and no frontend JWT storage.
- Customer create/search/duplicate warning.
- Manual quote creation from customer lookup.
- Quote desk open, PDF response, PDF browser download, quote status update, and send log display.
- Mobile customer and quote surfaces.
- Backend integration tests for tenant isolation, billing webhook verification, and provider-safe auth paths.

Required manual smoke before production handoff:

- Setup page trade/pricing/preset save.
- Customer notes/status edit, archive, and delete.
- Quote line edit/delete after initial creation.
- Billing-required screen and Stripe test checkout.
- Admin team member add/update/remove.
- Branding save and PDF visual output.
- QuickBooks disconnected/configured states and CSV export.
- AI enabled, limit, and provider-error states.
- Kody RAG `off` and internal `shadow_allowlist` states, including zero exposed tenants and separately scoped enabled/out-of-rollout queue health.
- iOS/Android email/SMS/PDF native app behavior.

## Current Launch Decision

QuoteFly is on track for controlled beta when `npm run verify` passes locally and `npm run verify:launch` passes against a dedicated `TEST_DATABASE_URL`. Kody RAG remains a separate controlled-pilot gate: production `off`, then internal `shadow_allowlist`, then exposed `allowlist` only after the evidence in `OWNER-ACTION-ITEMS.md` is complete.

QuickBooks-friendly CSV may remain in the controlled beta, but the hosted-payment candidate is not part of that availability decision. Keep `QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED=false`, keep all live-provider claims out of marketing, and do not infer sandbox readiness from mocked tests or a passing schema migration. A future QuickBooks pilot needs the exact-candidate automated gate, production-like migration/backup/forward-fix rehearsal, Intuit sandbox evidence, payment/refund/CDC recovery evidence, named monitoring and support owners, Sentinel review, independent Opera approval, and explicit owner authorization.

Do not move to broad paid launch until other provider-dependent rows are moved out of `Provider setup required` or deliberately moved to `Post-launch`.
