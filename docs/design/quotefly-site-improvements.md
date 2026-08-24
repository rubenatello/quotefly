# QuoteFly Site Improvements

Status: Implemented and independently approved by security, UX, SEO, release operations, and final engineering review in the current local sellability candidate; BCP pending explicit authorization

Last reviewed: 2026-08-23

Product baseline: `543fc69` (`feat: add job operations and harden AI usage`)

## Implementation record

- The homepage and Solutions page now tell the six-stage customer-to-internal-invoice story while preserving quoting as the primary entry point.
- Pricing now describes the available Basic workflow, removes unsupported popularity and future-plan price claims, uses billing-cycle AI language, and states the internal-invoice/QuickBooks/payment boundary directly.
- Kody examples now cover schedule lookup plus prepared booking and dispatch reviews, with explicit no-mutation wording.
- Six real QuoteFly surfaces are captured at desktop and mobile sizes from a deterministic fictional tenant, producing twelve metadata-stripped WebP assets. Provenance and regeneration instructions are recorded in [`docs/image-credits.md`](../image-credits.md).
- Trade pages link to the shared quote-to-job workflow and Basic pricing instead of duplicating thin operational content.
- Legacy QuickBooks provider workflows are default-off in the current candidate; public copy does not market automatic provider invoicing, reconciliation, or payment collection.
- Exact integrated evidence currently includes the database-backed CI gate with `213/213` integration tests, web build, lint, i18n `12/12`, 16-route prerender, SEO `9/9`, capture generation `1/1`, focused public responsive/Axe/keyboard/reduced-motion coverage `4/4`, QuickBooks API/security integration coverage `60/60`, `88/88` executed browser scenarios plus one intentional opt-in capture skip, and the focused member/manager QuickBooks Settings regression `2/2`. Independent security, UX (`97/100`), SEO, release-operations, and final engineering reviews approve the candidate for the next explicitly authorized BCP.

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

## Definition of done

- The public site explains the implemented quote-to-job workflow without unsupported provider claims.
- Every new product claim maps to an implemented, tested application surface.
- The six screenshot subjects use sanitized real UI and have documented provenance and alt text.
- Homepage, Solutions, Pricing, and relevant trade pages use consistent terminology.
- Mobile, desktop, accessibility, SEO, and prerender verification pass on the exact candidate.
- The canonical implementation plan remains the source of truth for feature completion.
