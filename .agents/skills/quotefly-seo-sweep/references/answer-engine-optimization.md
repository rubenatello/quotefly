# Answer Engine Optimization

Use this reference when work concerns AI-search visibility, citations, answerability, crawler access, or agent-friendly public pages.

## Operating model

AEO makes accurate public content easy for retrieval systems to find, understand, verify, quote, and link. It is an extension of technical SEO and useful content, not a guarantee of inclusion in an AI answer.

Evaluate QuoteFly across four layers:

1. **Retrieval eligibility:** the canonical URL is crawlable, indexable, internally linked, returns a useful status, and exposes its important content in raw or prerendered HTML.
2. **Answerability:** the page directly answers its primary customer intent in plain language, then supplies useful detail, limitations, and a next step. Do not mechanically "chunk" copy or manufacture FAQs for bots.
3. **Trust and citation readiness:** product, pricing, workflow, company, and comparison claims are specific, current, visible, and supported by first-party evidence. Dates, ownership, contact information, and limitations should be clear where relevant.
4. **Entity and agent comprehension:** names, plan details, capabilities, and relationships remain consistent across copy, metadata, structured data, navigation, and verified external profiles. Semantic HTML, accessible names, real links, and predictable controls should also work for browser agents and assistive technology.

## QuoteFly questions worth answering

Map genuine buyer questions to the smallest set of strong canonical pages. Examples include:

- What is QuoteFly, and which contractors is it for?
- How does a customer request become a reviewed quote, Job, scheduled visit, and internal invoice record?
- What does Kody draft, what data can it use, and what still requires human confirmation?
- What is included in Basic, what does it cost, and what is not yet supported?
- How do customer-visible price, internal cost, PDFs, roles, integrations, privacy, and data controls work?
- How does QuoteFly support a specific trade without claiming unsupported specialization or outcomes?

Prefer one authoritative page per intent with descriptive internal links. Create a new page only when it adds differentiated, durable value for a real buyer, not to target a query permutation.

## Crawler and consent boundaries

Audit crawler policy by purpose:

- Search indexing and AI-search retrieval may use different user agents. For ChatGPT search visibility, check `OAI-SearchBot` access and referral tracking separately from `GPTBot`.
- Model-training controls such as `GPTBot` or `Google-Extended` express a different policy choice from search discovery. Never broaden training access without explicit owner authorization.
- `noindex`, snippet controls, robots rules, authentication, CDN/firewall behavior, and raw response content must agree. A crawler blocked from a page may be unable to read its page-level directives.
- Treat `llms.txt` and similar AI-specific files as experimental. Do not present them as a ranking requirement or substitute for crawlable canonical pages, structured data, sitemaps, and internal links.

Re-check current first-party documentation before changing crawler behavior because user agents and product policies evolve:

- Google generative-AI search guidance: https://developers.google.com/search/docs/fundamentals/ai-optimization-guide
- OpenAI publisher and developer guidance: https://help.openai.com/en/articles/12627856-publishers-and-developers-faq
- Bing structured-data guidance: https://www.bing.com/webmasters/help/marking-up-your-site-with-structured-data-3a93e731
- Schema.org vocabulary: https://schema.org/

## Structured data and content rules

- Use supported schema types that truthfully describe the visible page. Structured data is a consistency layer, not hidden AEO copy.
- Keep Organization, WebSite, SoftwareApplication, offer, contact, logo, and URL identifiers stable where those types are appropriate.
- Do not add FAQPage, review, aggregate rating, comparison, or `sameAs` data without visible content and verified facts. Do not promise a rich result or AI citation.
- Ensure the answer survives JavaScript-disabled inspection when it is essential to the page's discovery intent.
- Prefer original product evidence: accurate screenshots, documented workflows, transparent limits, maintained pricing, and clearly labeled roadmap items. Avoid generic advice that any competitor could publish unchanged.

## Measurement and evidence

Separate eligibility, visibility, traffic, and conversion:

- Verify crawl/index eligibility with raw responses, robots rules, sitemaps, canonical checks, Search Console, and Bing Webmaster evidence when available.
- Measure query/page impressions and clicks with first-party webmaster data. Track identifiable AI referrals, including `utm_source=chatgpt.com`, without collecting quote or customer PII.
- Use server logs only when access is authorized and sensitive data can be excluded.
- Record observed citations with query, engine, locale, date, cited URL, and result context. A spot check is evidence of one observation, not a ranking guarantee.
- Report missing access as an evidence gap. Never invent traffic, citation share, rankings, conversions, or competitor performance.
