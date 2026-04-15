# Launch Improvement Tracker (Target: 2026-05-01)

Last updated: 2026-04-15
Owner: Product + Engineering

## Current Implementation Status

- AI limiting is enforced by monthly per-tenant spend cap (primary guardrail).
- Current enforced caps in code: Starter `$0.60`, Professional `$11.00`, Enterprise `$56.00`.
- Workspace UI shows AI budget usage progress (USD), not credit count.
- 50% / 70% / 90% AI budget stage warnings are surfaced in usage hints.
- Remaining prompt estimate uses blended average prompt cost (`$0.001615`).
- DELETE APIs now send a safe JSON payload to prevent empty-body JSON parser failures.
- Mobile quote AI action is icon-only (no border/fill) with a 44px tap target; desktop keeps labeled AI button.
- Quote board desktop header/row now reuse one shared grid column definition to prevent drift.
- Shared UI primitives now enforce 44px mobile touch targets for `Button` (`sm`, `md`), `Input`, and `Select`.
- Shared dismiss/close controls in alert and modal headers now use 44px mobile tap targets.
- Core quote workflow custom controls now enforce 44px minimum in mobile tabs/stage toggles and line-row quick actions.
- AI usage UI now hides dollar spend from customers and shows `% used` plus estimated prompts remaining.
- Customer-facing AI limit error copy now uses "AI requests"/"AI usage" wording instead of "AI credits."
- Additional quote workflow controls now enforce 44px minimum in customer lookup, quote-sheet details toggle, and AI starter prompt chips.
- Customer pipeline stage filters and quote history filter chips/select now enforce 44px mobile targets.
- Saved-job picker cards and customer lookup result rows now enforce 44px mobile targets in quote workflows.
- Quote creation latency reduced by batching initial line items into the `POST /quotes` request (instead of per-line sequential API calls).
- Quick-customer create flows now refresh only customer datasets (not full dashboard `loadAll`) to reduce perceived submit delay.
- Customer duplicate protection now checks both phone and email on create/update with normalized email matching and tenant-scoped conflict guards.
- Quote mutation refresh path now skips unnecessary outbound-log fetches and runs history refresh as non-blocking follow-up work.
- Duplicate full-page dashboard reloads were removed from Customers/Quotes/Analytics mounts; key quote/customer mutation flows now use targeted refreshes instead of `loadAll`.
- Duplicate customer workflow now supports `Use Existing` (fast/no-write path), defaults phone matches to existing-record flow, and keeps merge updates to non-empty incoming profile fields while restoring archived matches.
- Customer create/update duplicate checks now persist `phoneDigits` and use indexed tenant-scoped phone-digit lookups (no runtime regex fallback path).
- Customer create/merge activity logging now batches events with `createMany` to reduce transaction round-trips.
- Quote create preflight now runs monthly-limit count, customer validation, and actor resolution in parallel to reduce request latency.
- Quick customer modal now closes immediately after successful API create and runs `onCreated` follow-up work asynchronously (non-blocking UX).
- Marketing SEO pass updated core metadata, keyword targeting, canonical handling, and landing-page FAQ schema for contractor quoting/estimating search terms.
- AI quote parser now uses typo-tolerant trade/preset matching and weighted trade scoring to reduce misclassification on misspelled prompts.
- AI quality gate script added for repeatable scoring before deploy (`npm run eval:ai`, optional live-model mode `npm run eval:ai:model`).
- AI prompt-remaining estimate now adapts to each tenant's observed per-run AI spend (with conservative safety buffer) so larger prompts reduce remaining estimate sooner.
- Internal superuser AI quality console added (`/app/internal/admin/ai-quality`) with server-side superuser gating via `SUPERUSER_EMAILS`.
- AI model context is now compacted/truncated to a safe budget before calls to protect latency and token spend.
- Quote Builder and Quote Desk line-sheet grids now switch to desktop mode at `xl+` with tighter columns and wider safety margins to prevent field overlap on small desktop/tablet widths.
- Quote line section chips now support compact labels (`Incl` / `Alt`) at constrained widths to prevent control collision.
- Quote board now keeps card layout until `xl` and only uses dense desktop table columns at larger widths.
- Workspace topbar search CTA minimum width is now responsive to reduce header squeeze on smaller desktop widths.
- Customers, Pipeline, and Analytics dense row/table layouts now switch at `xl+` with adjusted column widths to reduce small-desktop/tablet crowding.
- Branding page mobile rendering pass shipped: timezone controls now wrap safely, template browsing has dedicated mobile nav buttons, and preview header/meta blocks stack cleanly on narrow screens.
- AI suggest flow now has a strict guardrail retry and hard no-op rejection so the modal does not report success without concrete quote mutations.
- Internal superuser AI quality dashboard now includes trade-level quality breakdown plus no-patch/low-confidence/fallback runtime signal rates.
- Quote Builder AI apply flow now performs customer-list refresh asynchronously so modal close and sheet updates are not blocked by a full customer reload.

## Purpose

Track launch decisions and improvements for:

1. AI budget limits and profitability by tier
2. Mobile AI icon treatment and mobile UI quality
3. Overall UX optimization on mobile and desktop for contractor workflows
4. Launch reliability fixes found during daily usage

## Unit Economics Calculator

Use this before changing AI limits or pricing:

- Script: `scripts/tier-unit-economics.mjs`
- Run: `node scripts/tier-unit-economics.mjs`

Core formulas:

- `Contribution = Price - Stripe - InfraPerTenant - NonAiVariable - AiBudget`
- `AiBudgetMax = Price - Stripe - InfraPerTenant - NonAiVariable - (Price * TargetMargin)`

Current planning assumptions:

- Stripe: `2.9% + $0.30`
- Paying tenants: `25`
- Infra monthly: `$150` -> `$6` allocated per tenant
- Non-AI variable: Starter `$0.50`, Professional `$1.50`, Enterprise `$5.00`
- Margin targets: Starter `58%`, Professional `65%`, Enterprise `70%`

Budget ceiling output from baseline:

- Starter max AI budget: `~$0.63`
- Professional max AI budget: `~$11.14`
- Enterprise max AI budget: `~$56.18`

Launch working caps aligned to baseline:

- Starter: `$0.60`
- Professional: `$11.00`
- Enterprise: `$56.00`

## AI Policy (Launch Direction)

- Primary limit: monthly USD AI budget per tenant.
- Secondary compatibility field: monthly AI credit counters still exist in API payloads for backward compatibility.
- Default runtime model remains `gpt-4o-mini` unless economics are recalculated and approved.
- Re-run economics whenever paying-tenant count or infra cost changes.
- AI quality gate: keep parser/eval score >= `92/100` before deploy; target `95+/100` for launch freeze confidence.

## Mobile/Desktop UX Audit

Active findings:

1. Core contractor flow still needs a structured iPhone/Android smoke pass before launch freeze.
2. Internal API/type naming still includes legacy "credits" fields for compatibility and needs cleanup after launch.
3. Legacy/older surfaces still contain custom non-primitive buttons not covered by this pass.

Completed findings:

1. Mobile AI trigger chrome reduction (icon-only) shipped.
2. Quote board header/row alignment guardrail shipped (shared grid template).
3. Delete quote empty JSON-body issue mitigated in client API layer.
4. Shared UI primitive touch targets hardened to 44px on mobile.
5. Core quote workflow custom mobile controls hardened to 44px where primitives were not used.
6. Mobile action clusters in Builder and Desk simplified (primary actions visible, secondary actions collapsed).
7. Remaining customer-facing backend AI limit fallback copy now avoids legacy "AI credits" wording.
8. Additional launch-critical quote workflow controls hardened to 44px (lookup input/button, sheet details toggle, AI starter prompt chips).
9. Customer pipeline and quote-history filter controls hardened to 44px on mobile.
10. Saved-job picker list cards and customer lookup result rows hardened to 44px on mobile.
11. Transaction latency pass completed for customer/quote creation flows (batched quote line writes + lighter refresh strategy).
12. Route-level duplicate `loadAll()` calls removed and additional quote/customer mutation refreshes switched to targeted datasets.

## Responsive QA Snapshot (2026-04-14)

Scope checked:

1. Shared component primitives (`Button`, `Input`, `Select`, alert dismiss, modal close)
2. Quote Builder core mobile controls
3. Quote Desk core mobile controls
4. Quote board mobile stage controls

Pass:

1. Shared controls in primitives now meet 44px minimum touch target on mobile.
2. Builder/Desk mobile pane tabs now include explicit `min-h-[44px]`.
3. Quote board stage filter pills now include explicit `min-h-[44px]`.
4. Builder mobile line-row quick add/remove icon buttons now use `h-11 w-11`.
5. Quote customer lookup controls now enforce `min-h-[44px]` on mobile.
6. Quote sheet mobile "Show details" toggle now enforces `min-h-[44px]`.
7. AI prompt starter-chip buttons now enforce `min-h-[44px]`.
8. Customer pipeline stage filter controls now enforce `min-h-[44px]`.
9. Quote history mode filter controls now enforce `min-h-[44px]`.
10. Saved-job modal cards and customer lookup result buttons now enforce `min-h-[44px]`.

Open follow-up:

1. Run manual device-width smoke test on iPhone + Android breakpoints to validate interaction comfort and no layout regressions.
2. Plan a cleanup pass for legacy non-primitive custom buttons outside the launch-critical flow.

## Decision Log / Tracker

| Item | Owner | Status | Due | Notes |
|---|---|---|---|---|
| Confirm final AI spend caps by tier from margin targets | Owner | In progress | 2026-04-16 | Current caps: `$0.60 / $11 / $56` |
| Confirm production OpenAI key + runtime model in Railway | Owner | Pending | 2026-04-16 | `OPENAI_API_KEY` required for non-regex runtime |
| Spend-based AI meter + 50/70/90 warnings | Engineering | Completed | 2026-04-14 | Shipped in workspace usage surfaces |
| Mobile AI icon-only treatment in quote actions | Engineering | Completed | 2026-04-14 | Mobile icon-only, desktop labeled CTA |
| Harden DELETE calls against empty JSON body parser error | Engineering | Completed | 2026-04-14 | Safe JSON payload now sent on DELETE mutations |
| Quote workflow table header/row alignment hardening | Engineering | Completed | 2026-04-14 | Shared grid column constant in quote board |
| 44px touch target pass in shared UI primitives | Engineering | Completed | 2026-04-14 | `Button`/`Input`/`Select` + modal/alert controls updated for mobile 44px |
| Simplify mobile quote action cluster | Engineering | Completed | 2026-04-14 | Builder mobile quick actions condensed and Desk secondary actions moved under "More actions" |
| Replace residual "AI credits" wording with "AI budget" | Product + Engineering | Completed | 2026-04-14 | Pricing/admin/subscription docs now use AI budget language |
| Hide AI dollar spend from customer-facing UI | Engineering | Completed | 2026-04-14 | Sidebar/admin/analytics/AI notices now show percent + estimated prompts only |
| Replace remaining backend customer-facing "AI credits" fallback copy | Engineering | Completed | 2026-04-14 | AI limit errors now use "AI requests"/"AI usage" wording |
| Additional quote workflow mobile touch-target hardening | Engineering | Completed | 2026-04-14 | Customer lookup, sheet details toggle, and AI starter chips now enforce 44px minimum |
| Customer pipeline + quote history filter mobile touch-target hardening | Engineering | Completed | 2026-04-14 | Stage chips and history mode filters now enforce 44px minimum |
| Saved-job picker and lookup result list mobile touch-target hardening | Engineering | Completed | 2026-04-14 | Preset picker cards and customer search result rows now enforce 44px minimum |
| Customer/quote creation latency pass | Engineering | Completed | 2026-04-14 | Batched quote line writes in `POST /quotes`; quick-customer callbacks now refresh customers only |
| Customer duplicate-check hardening (phone + email) | Engineering | Completed | 2026-04-14 | Parallel duplicate lookup on create + email conflict guard on update; normalized tenant-scoped matching |
| Duplicate workflow UX+logic pass (Use Existing / strong phone match) | Engineering | Completed | 2026-04-14 | Exact phone matches now default to existing-record path; Add as New disabled on phone match; merge updates apply non-empty fields and restore archived records |
| Marketing SEO optimization (quoting/estimating keywords) | Engineering | Completed | 2026-04-14 | Updated landing/pricing/solutions/about/support metadata, canonical tags, sitemap entries, and added FAQ structured data for target keyword coverage |
| AI typo-tolerant parsing + trade scoring hardening | Engineering | Completed | 2026-04-14 | Added fuzzy token matching for service inference and catalog matching across core trades |
| AI quality gate script (`eval:ai`) | Engineering | Completed | 2026-04-14 | Added repeatable scoring script with typo-heavy cross-trade prompts and pass/fail threshold |
| Dynamic AI prompt-cost estimator by tenant | Engineering | Completed | 2026-04-14 | Remaining-prompt estimate now uses observed monthly spend/run with safety multiplier instead of fixed constant only |
| Internal superuser AI quality console + protected APIs | Engineering | Completed | 2026-04-14 | Added `/v1/internal/ai-quality/*` and `/app/internal/admin/ai-quality`; access restricted by superuser email allowlist |
| AI context token-budget safety guard | Engineering | Completed | 2026-04-14 | AI context now compacts and trims to fixed safety limits before model calls |
| Quote Builder/Desk responsive line-grid hardening (`xl+` desktop tables) | Engineering | Completed | 2026-04-15 | Prevents line/description/qty collision on smaller desktop and tablet widths; adds compact section chip labels |
| Quote board responsive breakpoint tuning (`xl+` desktop table) | Engineering | Completed | 2026-04-15 | Uses card layout on narrower desktop/tablet widths for readability and touch ergonomics |
| Cross-page responsive breakpoint harmonization (Customers/Pipeline/Analytics) | Engineering | Completed | 2026-04-15 | Dense grid rows now activate at `xl+` with smaller `xl` columns and full `2xl` columns for readability |
| Branding page mobile rendering QC pass | Engineering | Completed | 2026-04-15 | Fixed mobile overflow/compression in timezone controls, template navigation row, and customer-preview header/meta layout |
| AI deterministic fallback retry/guardrail pass | Engineering | Completed | 2026-04-15 | `POST /quotes/ai-suggest` now retries once with stricter context and returns explicit error when no concrete patch/scope mutation is produced |
| AI prompt telemetry dashboard pass (per-trade parse quality + failure reasons) | Engineering | Completed | 2026-04-15 | Internal AI summary now returns trade breakdown + quality signal rates (no patch, low confidence, regex fallback) and tenant-level quality rates |
| Quote Builder AI-apply latency micro-optimization | Engineering | Completed | 2026-04-15 | Customer refresh after AI apply is now async (`void loadCustomers()`), reducing perceived apply latency |
| AI run feedback data model + endpoints (thumbs up/down + reason) | Engineering | Not started | 2026-04-20 | Needed to measure real satisfaction and close loop to 95+ |
| Quote mutation refresh latency pass | Engineering | Completed | 2026-04-14 | Removed duplicate outbound-event reloads after mutations and made history refresh async/non-blocking |
| Route/mutation refresh optimization pass | Engineering | Completed | 2026-04-14 | Removed duplicate `loadAll()` on major pages and replaced several mutation full-refreshes with targeted `loadQuotes`/`loadCustomers` calls |
| Customer/quote create latency pass v2 (backend + modal UX) | Engineering | Completed | 2026-04-15 | Indexed-first duplicate checks with persisted `phoneDigits`, batched activity writes, quote-create parallel preflight, and non-blocking quick-customer post-create callbacks |
| Full responsive QA pass (customer -> quote -> send) | Product + Engineering | In progress | 2026-04-26 | Code-level sweep done; device-width run still required |
| Final launch UX polish sweep | Product + Engineering | Not started | 2026-04-29 | Spacing, color contrast, wording cleanup |

## Launch QA Checklist (Core Path)

1. Add customer from quote surfaces (builder, desk, quote board).
2. Create quote with preset + manual lines.
3. Run AI suggestion and verify budget meter updates.
4. Save, preview PDF, and send flow (email/text/native share path).
5. Archive and delete quote (no parser errors).
6. Verify quote board headers align with row values at desktop widths.

## Next 3 Steps (Recommended This Week)

1. Finalize whether Starter stays at `$0.60` or moves to `$0.65` after re-running the economics script with latest tenant-count assumptions.
2. Run the full responsive QA pass across iPhone and Android widths and capture any remaining launch-blocker UI regressions.
3. Confirm production OpenAI key/model in Railway and close remaining owner launch blockers.
