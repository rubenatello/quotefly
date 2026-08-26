# QuoteFly Site Improvements

Status: The baseline for this slice is `d20e3e8`, which includes governed Kody RAG and default-off QuickBooks Invoice sync readiness. This candidate adds a sharper responsive homepage product showcase plus answer-first SEO/AEO content and entity wiring. Its full local `npm run verify` gate and focused public browser checks pass. Opera's first review required same-state product-capture density parity and translated invoice guidance; both findings are remediated, and the independent re-review approved this frontend-only slice. Real-device validation and the exact-candidate consumer launch gate remain release residuals. Deployment remains a separate owner-controlled action.

Last reviewed: 2026-08-25

Product baseline: `d20e3e8` (`feat: add governed Kody RAG and invoice sync readiness`)

Cross-area follow-up: the current quote/Kody/privacy/invoice/public-site remediation status, evidence, and unresolved owner/provider gates are maintained in the [QuoteFly Critical Improvements Program](../plan/quotefly-critical-improvements-program.md). This design brief remains the public-site source; the program ledger is authoritative for later release evidence.

## Implementation record

- The homepage and Solutions page now tell the six-stage customer-to-internal-invoice story while preserving quoting as the primary entry point.
- Pricing now describes the available Basic workflow, removes unsupported popularity and future-plan price claims, uses billing-cycle AI language, and states the internal-invoice/QuickBooks/payment boundary directly.
- Kody examples now cover schedule lookup plus prepared booking and dispatch reviews, with explicit no-mutation wording.
- Six real QuoteFly surfaces are captured at standard and Retina desktop/mobile densities from a deterministic fictional tenant, producing twenty-four metadata-stripped WebP assets. The homepage presents them as three keyboard-accessible product stories with two user-selected states each; there is no autoplay. Provenance and regeneration instructions are recorded in [`docs/image-credits.md`](../image-credits.md).
- The homepage now gives search and answer engines a direct product definition, a factual fit-and-boundaries answer block, and connected `WebPage`, `SoftwareApplication`, and primary-image entities. Public copy avoids unsupported autonomous-AI, provider-invoice, payment-collection, route-optimization, and objective-superlative claims.
- Trade pages link to the shared quote-to-job workflow and Basic pricing instead of duplicating thin operational content.
- Legacy QuickBooks provider workflows are default-off in the current candidate; public copy does not market automatic provider invoicing, reconciliation, or payment collection.
- Current public-site evidence includes the web build, lint, i18n `12/12`, 16-route prerender, SEO `10/10`, focused public responsive/Axe/keyboard/reduced-motion coverage `5/5`, and the full local `npm run verify` gate. The opt-in deterministic capture lane passed twice and reproduced identical SHA-256 hashes for all 24 standard/Retina assets generated from the same frozen 2x render. Database-backed launch gates were not rerun because this slice changes only public-site code, deterministic capture fixtures, and checked-in marketing assets.
- `main` now lets one natural Kody request resolve an active visible customer, preserve an estimated labor-hour range, match saved tenant products/services, and hand the Quote Builder separate priced, source-linked lines for review. Missing customer or work details produce a bounded clarification instead of a guessed or silently created record.
- GitHub run `32784331528` proved that the provider secret and isolated database were available, then failed the synthetic Kody quality gate at 4/6: one follow-up response did not preserve the requested total count in the evaluator's accepted form, and one safe quote-draft response was forced into deterministic fallback because no citation had been authorized. The current workspace addresses both cases without relaxing mutation, hidden-field, or citation validation.
- Historical Phase 4B local evidence recorded on 2026-08-25 covered the QuickBooks Invoice slice, but it predates the current `7f75827` program baseline and is not release evidence for the current working tree. Current candidate counts, gate results, residuals, and the independent-review verdict are recorded only in the [QuoteFly Critical Improvements Program](../plan/quotefly-critical-improvements-program.md) after each exact gate finishes.

## Purpose

Expand QuoteFly's public product story beyond quote creation and follow-up so the site accurately represents the implemented customer-to-job workflow. The next iteration should use sanitized captures of the real application, keep claims inside verified product boundaries, and help a contractor understand how work moves from an accepted quote through scheduling, dispatch, completion, and an internal invoice record.

This brief complements the canonical [Activity Center, Jobs, and Dispatch Plan](../plan/activity-job-dispatch-plan.md) and the stable [Jobs, Booking, Dispatch, and Invoicing Spec](../../quotefly_jobs_booking_dispatch_invoicing_spec.md). The canonical plan remains the authority for implementation status.

## Baseline gap addressed by this iteration

Before this iteration, the public homepage emphasized customer capture, quote drafting, PDF review, and follow-up. That was accurate, but it understated the implemented product:

- Accepted quotes create tenant-numbered Jobs.
- Owners and admins can assign work and create overlap-safe bookings.
- The Jobs workspace provides day, rolling-seven-day, and week schedule views.
- Assigned members can move eligible appointments through dispatch, arrival, and completion.
- Kody can list schedule data and prepare booking or dispatch reviews without silently writing business records.
- Accepted Quotes and completed Jobs can create and display an internal QuoteFly invoice record.
- Confirmed appointment changes can create tenant-scoped in-app team notifications.

The implemented public story now covers that larger workflow without implying that unfinished external-provider capabilities are live.

## Product story to feature

Use this sequence as the primary narrative on the homepage and Solutions page:

1. Capture the customer and price the work.
2. Review and share the quote.
3. Turn an accepted quote into a Job.
4. Assign and schedule the visit.
5. Dispatch, arrive, and complete from the field.
6. Create the internal invoice record and keep the next action visible.

The story should remain practical and contractor-oriented. Prefer concrete workflow language over generic CRM or AI claims.

## Claims approved for public use

- "Turn an accepted quote into a job without re-entering the customer or scope."
- "See scheduled work by day or week."
- "Assign, book, reschedule, dispatch, arrive, complete, or cancel eligible visits."
- "Keep assigned field users focused on their own visible work."
- "Ask Kody to show a schedule or prepare a booking or dispatch review."
- "Ask Kody to prepare a quote review from a customer, trade, job, product, service, and expected labor time."
- "Kody can match active visible customers and saved products or services, then place separate priced lines in the Quote Builder for review."
- "Review every Kody-prepared action before the normal QuoteFly workflow makes a change."
- "Create an internal invoice record from an accepted quote or completed job."
- "Give eligible teammates an in-app update after confirmed appointment changes."
- "Use QuoteFly in English or Spanish across the implemented application surfaces."

## Claims that remain out of scope

Do not claim or imply any of the following until their corresponding implementation and release evidence exist:

- Customer or technician SMS/email notifications.
- Automatic booking, dispatch, or customer-facing action by Kody.
- Drag-and-drop calendar scheduling.
- Payment collection or stored payment instruments in QuoteFly.
- Automatic creation or reconciliation of QuickBooks invoices.
- Refund, dispute, or payment-webhook reconciliation.
- Provider delivery guarantees or customer notification status.
- Autonomous AI decisions about tenant, role, assignee, pricing, or authorization.

Use "internal invoice record" where needed to distinguish the current capability from provider-backed invoicing and payment collection.

## Homepage changes

### 1. Broaden the hero support copy

Keep quoting as the entry point, but connect it to the work that follows. The hero should make clear that QuoteFly helps move a service job from customer request through quote, schedule, and completion.

The primary CTA should continue to start the trial. The secondary CTA should jump to the product story rather than a generic feature list.

### 2. Replace the three-step quote-only story

Replace or expand the current customer/price/review sequence with the six-step product story above. On small screens, use a readable vertical sequence; on desktop, use a compact progression with clear state changes.

### 3. Expand the real-product showcase

The existing Activity, mobile dashboard, and Kody follow-up captures establish product credibility. Add a second group showing operational work:

- Jobs schedule.
- Job detail with booking or dispatch controls.
- Kody booking or dispatch review.
- Invoice panel.
- Notification center.

Each figure must identify the surface, explain the user outcome, and state that it uses sanitized demo data.

### 4. Expand Kody examples

Add truthful deterministic examples alongside customer lookup, quote drafting, follow-up, and pipeline math:

- "What is on my schedule today?"
- "Prepare a visit for the Smith job tomorrow at 9 a.m."
- "Prepare my next visit for dispatch."

The response copy must clearly distinguish a result or prepared review from a completed mutation.

### 5. Clarify the invoice boundary

Show the internal invoice panel as the final step in the current workflow. Pair it with concise copy explaining that external sending, payment collection, and QuickBooks invoice creation remain separate provider actions.

### 6. Make the Kody quote example concrete

Use a real review-only example such as:

> Kody, I need a plumbing quote for faucet replacement for Maria Lopez. It should take about 3–4 hours depending on damage or inspection. Please prepare the quote for review.

The product behavior behind this example must remain explicit:

- Resolve an active customer visible to the current user by exact or bounded name, email, or phone search.
- Prefer an exact email or phone over an exact name, and an exact name over a partial name. If more than one customer matches, show contact-differentiated review choices.
- If no customer matches, ask for any name or phone required by the confirmed Add Customer flow. Once the required details are present, prefill that normal flow and link the created customer only after confirmation.
- Ask for the customer or work details when either is missing, and retain the prior quote request for the user's reply.
- Match active tenant products/services across the bounded catalog, not only a short alphabetical prefix.
- Put the requested job, product, service, and labor allowance into separate editable line items when they are distinct.
- Carry the saved product/service reference and customer price into the builder. Internal cost remains permission-gated and is revalidated on the server.
- Open one minimal Quote Builder review state. Do not automatically launch a second AI drafting pass. If an unsaved builder draft already exists, offer explicit merge, replace, or keep choices.
- Never create, update, restore, archive, save, or send a Customer or Quote from the AI suggestion step.

## Solutions and trade-page changes

- Extend the general Solutions workflow through Jobs and internal invoicing.
- Add contextual links from trade pages to the shared schedule/dispatch section rather than duplicating large blocks of identical copy.
- Keep trade-specific examples focused on workflow differences, not unsupported product variations.
- Link back to Pricing and the primary trial CTA after each substantial workflow section.
- Avoid generating thin location or trade pages solely for keyword coverage.

## Screenshot plan

Capture the real application with a dedicated sanitized demo tenant. Never capture production customer data, real contact information, addresses, provider identifiers, tokens, margins, or internal costs.

| Surface | Story | Desktop target | Mobile target |
| --- | --- | --- | --- |
| Activity / My day | Know what needs attention | 1440 x 900 | 390 x 844 |
| Jobs schedule | See and filter booked work | 1440 x 900 | 390 x 844 |
| Job detail | Review booking and lifecycle actions | 1280 x 900 | 390 x 844 |
| Kody schedule review | Prepare, review, then confirm | 1280 x 900 | 390 x 844 |
| Invoice panel | Create and review an internal invoice | 1280 x 900 | 390 x 844 |
| Notification center | See confirmed in-app team updates | 1280 x 900 | 390 x 844 |

Capture requirements:

- Use realistic but fictional names, job numbers, amounts, and addresses.
- Show meaningful populated states rather than empty dashboards.
- Capture light mode for primary marketing figures; add dark mode only when it materially demonstrates the product.
- Keep browser chrome out of final assets unless device context is intentional.
- Export responsive WebP derivatives, strip metadata, record source/ownership in `docs/image-credits.md`, and preserve a reproducible capture note outside production secrets.
- Write specific alt text describing the visible task and state, not decorative marketing prose.

## Content and SEO improvements

- Update homepage and Solutions metadata to reflect contractor job scheduling and dispatch without displacing the core quoting intent.
- Add internal links between the homepage product story, Solutions, relevant trade pages, Pricing, and Support.
- Update sitemap `lastmod` values only when the corresponding public page materially changes.
- Keep FAQ and other structured data identical to visible page content.
- Add prerendered SEO assertions for the new Jobs/schedule/invoicing copy and links.
- Do not publish performance, revenue, customer-count, or conversion claims without a documented source.

## UX and accessibility acceptance

- No horizontal page scrolling at 360, 390, 768, 1280, or 1440 CSS pixels.
- All interactive controls remain keyboard accessible with visible focus.
- Mobile actions remain at least 44 by 44 CSS pixels.
- Product-showcase carousels or strips have an equivalent keyboard interaction and meaningful accessible names.
- Reduced-motion users receive no required information only through animation.
- Text and controls meet WCAG AA contrast in each published theme.
- Images reserve intrinsic dimensions to avoid layout shift and use responsive sources.
- The primary page content remains useful in prerendered HTML.

## Delivery slices

### Slice A — Brief and product proof

- [x] Approve this claims matrix and screenshot list.
- [x] Create the sanitized deterministic tenant fixture and capture the six required surfaces at desktop and mobile sizes.
- [x] Record image provenance, regeneration steps, asset budgets, and alt text.

### Slice B — Homepage story

- [x] Expand the workflow narrative and product showcase.
- [x] Add Jobs/schedule/dispatch Kody examples.
- [x] Update supporting metadata, sitemap date, and SEO assertions.

### Slice C — Solutions and conversion paths

- [x] Extend the Solutions page and relevant trade-page links.
- [x] Align Pricing feature language with the implemented workflow and provider boundaries.
- [x] Review CTA hierarchy and remove repeated, unsupported, or contradictory feature blocks.

### Slice D — Release QA

- [x] Run the web build, lint, i18n, SEO, capture, and focused responsive Playwright suites.
- [x] Review rendered HTML, all twelve mobile/desktop screenshots, keyboard flow, reduced motion, and Axe serious/critical results.
- [x] Obtain independent security, UX, SEO, and claim-accuracy review on the exact frozen candidate.
- [x] Obtain final engineering review on the exact frozen candidate before BCP.

### Slice E — Kody prompt-to-quote review

- [x] Parse the natural customer/trade/work/duration sentence, including a bounded hour range.
- [x] Resolve only active tenant- and assignment-visible customer candidates; make suggestion endpoints review-only.
- [x] Match the bounded active tenant catalog and carry separate priced, source-linked lines into Quote Builder.
- [x] Preserve clarification context and remove the automatic second AI pass from the Kody handoff.
- [x] Add parser, routing, catalog, handoff-normalization, and database-backed acceptance coverage.
- [x] Run the exact-candidate full local gate, specialist source reviews, and independent Opera source verdict.
- [x] Run the exact-`b72ec1b` database-backed launch gate and responsive browser scenarios.
- [ ] Commit the current composer/evaluator repair only after explicit BCP authorization, then rerun the live-provider evaluation on that exact SHA and require 6/6.
- [ ] Run staging/mobile smoke checks and collect owner-operated release evidence.

## Definition of done

- The public site explains the implemented quote-to-job workflow without unsupported provider claims.
- Every new product claim maps to an implemented, tested application surface.
- The six screenshot subjects use sanitized real UI and have documented provenance and alt text.
- Homepage, Solutions, Pricing, and relevant trade pages use consistent terminology.
- Mobile, desktop, accessibility, SEO, and prerender verification pass on the exact candidate.
- The canonical implementation plan remains the source of truth for feature completion.
- The documented Kody sentence produces one customer-linked, priced, editable review draft or a specific clarification; it never silently writes business records.
