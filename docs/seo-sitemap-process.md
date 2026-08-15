# QuoteFly sitemap process

QuoteFly's public SEO route catalog is the sitemap source of truth. Do not edit `web/public/sitemap.xml` by hand.

## Adding or changing a public page

1. Add the public route to `PUBLIC_ROUTE_PATHS` and its metadata to `PUBLIC_ROUTE_SEO` in `web/src/lib/public-seo-data.ts`.
2. Set `lastModified` to the date of the latest significant customer-visible content, structured-data, or internal-link change. Do not update it for formatting-only edits or simply because a deployment ran.
3. Run `npm run seo:sitemap:generate` if you want to refresh the tracked XML immediately. The Vercel web build also runs this automatically.
4. Run `npm run build:web`. The SEO test fails if the catalog, tracked sitemap, or deployed sitemap differs, or if a private `/app` route enters the sitemap.

The generated sitemap intentionally includes only canonical absolute URLs and accurate `<lastmod>` values. Google ignores sitemap `<priority>` and `<changefreq>` values, so QuoteFly does not generate them.

## Google Search Console

1. Verify the `quotefly.us` Domain property in Search Console.
2. Open **Sitemaps** and submit `https://www.quotefly.us/sitemap.xml` once.
3. Keep that URL stable. Google can refetch it as Vercel publishes updated XML; do not repeatedly resubmit the same unchanged sitemap.
4. Monitor the Sitemaps and Page indexing reports. Use URL Inspection for important new trade landing pages when needed.

Submission is a discovery hint, not a guarantee that every URL will be indexed.

## Release check

After the production Vercel deployment finishes, run:

```bash
npm run seo:sitemap:live
```

This fetches the production sitemap and compares it with the exact release catalog. It fails if production is stale, incomplete, or contains different URLs or dates.

`web/public/robots.txt` must continue to advertise:

```text
Sitemap: https://www.quotefly.us/sitemap.xml
```
