---
name: quotefly-seo-sweep
description: Audit and improve QuoteFly SEO and answer engine optimization (AEO) across technical search, public content, AI-search visibility, citation readiness, crawlability, structured data, snippets, and measurement. Use for SEO/AEO sweeps, marketing routes, sitemap or robots changes, canonical and social metadata, prerendering, Core Web Vitals, search-indexing regressions, AI answer-engine discoverability, or agent accessibility; do not use for authenticated product UX except index-control boundaries.
---

# QuoteFly SEO and AEO Sweep

Improve conventional-search and AI answer-engine discoverability with verifiable, customer-honest changes. AEO extends sound SEO; it does not replace it.

For AI-search, citation-readiness, crawler-policy, or answerability work, read [references/answer-engine-optimization.md](references/answer-engine-optimization.md) before acting.

## Audit the current surface

1. Read the public routes in `web/src/App.tsx`, `web/index.html`, `web/src/lib/seo.ts`, `web/public/robots.txt`, and `web/public/sitemap.xml`.
2. Determine what bots and social crawlers receive before JavaScript executes. Treat client-side metadata updates as insufficient for crawlers that do not render the SPA.
3. Verify every referenced public asset exists, every canonical is absolute and unique, and authenticated/internal routes cannot be indexed.
4. Compare sitemap entries with intended public routes and confirm redirects, not-found behavior, and trailing-slash policy.
5. Validate structured data against visible content, current pricing, and actual product capabilities. Remove unverifiable claims.
6. Map high-intent customer questions to canonical public pages. Confirm that raw HTML gives a clear, direct account of what QuoteFly is, who it serves, what it can and cannot do, current pricing, and the next useful action.
7. Audit search and answer-engine crawler access separately from model-training crawler policy. Flag accidental blocks or privacy conflicts; do not change training consent without explicit owner authorization.
8. Check entity consistency across visible copy, Organization/SoftwareApplication data, contact details, plan naming, supported trades, and verified external profiles. Do not add unsupported `sameAs`, review, rating, customer, or performance claims.

## Prioritize work

Fix issues in this order:

1. Crawl/index failures, broken canonicals, missing assets, accidental private-route indexing, or invalid structured data.
2. Route-specific server-visible titles, descriptions, Open Graph/Twitter tags, and canonical URLs. Recommend prerendering or SSR when the SPA shell prevents reliable route-specific previews or indexing.
3. Clear answer-first summaries, differentiated first-party content, verifiable claims, entity consistency, and descriptive internal links that help both people and retrieval systems understand the product.
4. Semantic headings, accessible content and controls, sitemap/robots alignment, and useful trade-specific landing content.
5. Core Web Vitals and bundle/image/font improvements supported by measurement.

Avoid keyword stuffing, query-variation or location doorway pages, fabricated testimonials, fake locations, hidden text, inauthentic mentions, scaled commodity content, or unsupported ranking/citation promises. Do not add special AI markup or files merely because a third-party checklist recommends them. Never expose customer or quote data for SEO or AEO.

## Verify changes

Run `npm run build:web`, `npm run lint:web`, and the public-page Playwright tests. Inspect the built HTML and public assets. For route-level metadata and answers, verify the raw HTTP response or prerendered output rather than relying only on the post-hydration DOM. Validate that structured data matches visible claims and that crawler directives produce the intended search-versus-training policy. Record unavailable Search Console, Bing Webmaster, AI-referral analytics, crawler-log, citation, or field-performance evidence instead of inferring success.

Return findings with priority, evidence, affected URL, discovery channel (traditional search, AI answer engine, or browser agent), recommended owner, and acceptance check. Send completed SEO/AEO work to Opera for independent review.
