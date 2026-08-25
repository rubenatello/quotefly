# QuoteFly Image Credits

The optimized website derivatives under `web/public/images/solutions` come from user-provided Unsplash downloads. Keep this record with the assets so their original source and photographer remain traceable.

| Website asset | Photographer | Original source |
| --- | --- | --- |
| `construction-framing.jpg` | Josh Olalde | [Unsplash photo X1P1_EDNnok](https://unsplash.com/photos/X1P1_EDNnok) |
| `electrical-service.jpg` | Emmanuel Ikwuegbu | [Unsplash photo -0-kl1BjvFc](https://unsplash.com/photos/-0-kl1BjvFc) |
| `carpentry-measurement.jpg` | Valentina Giarre | [Unsplash photo cfNchb3VAI8](https://unsplash.com/photos/cfNchb3VAI8) |
| `contractor-tools.jpg` | Bermix Studio | [Unsplash photo iwz5tmhjl7o](https://unsplash.com/photos/iwz5tmhjl7o) |
| `construction-silhouette.jpg` | Jason Richard | [Unsplash photo rFEpX_HK0FQ](https://unsplash.com/photos/rFEpX_HK0FQ) |

The original downloads remain outside the repository. The checked-in files are resized, metadata-stripped JPEG derivatives for QuoteFly's public marketing site.

## QuoteFly product captures

The WebP files under `web/public/images/product` are first-party captures of the real QuoteFly web interface. They do not use third-party photography and require no external attribution.

The current product-proof set covers six operational surfaces with two responsive densities: desktop `1440x900` (`v1`) and `2880x1800` (`v2`), plus mobile `390x844` (`v1`) and `780x1688` (`v2`):

- Activity and My Day
- Jobs schedule
- Job detail
- Kody schedule review
- Internal invoice ledger
- In-app notification center

Every capture is generated from the deterministic fictional workspace **Cedar & Stone Home Services**. The intercepted fixture uses fictional customers and teammates, fixed timestamps, and no provider calls. It contains no production data, live customer contact details, internal costs, margins, credentials, or external account identifiers.

Regeneration is deliberately opt-in and does not run in the normal E2E suite:

The opt-in regeneration lane requires Python 3 with Pillow available to the capture environment. Set `PYTHON` when the desired interpreter is not available as `python`. The normal application build and checked-in asset validation do not require Python or Pillow.

```powershell
$env:UPDATE_MARKETING_PRODUCT_CAPTURES='1'
npx playwright test --config playwright.marketing-captures.config.ts
```

The capture test records the interface at device scale factor 2, writes temporary PNGs under the ignored `test-results` directory, then `scripts/optimize-product-captures.py` creates metadata-free WebP assets. The responsive `<picture>` sources let standard-density screens use the compact `v1` files while Retina-class screens select the sharper `v2` files. The checked-in SEO test enforces exact dimensions, budgets of 225 KB/600 KB for desktop `v1`/`v2`, budgets of 95 KB/260 KB for mobile `v1`/`v2`, and the absence of EXIF, XMP, and ICC chunks.
