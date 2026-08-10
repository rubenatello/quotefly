# Dependency Health Snapshot

## 2026-08-10 security refresh

- Refreshed the root and web lockfiles within their existing compatible version ranges.
- Updated React Router to 7.18.2 and removed the temporary `GHSA-qwww-vcr4-c8h2` exception.
- Updated all installed `brace-expansion` nodes to patched releases and removed the temporary `GHSA-mh99-v99m-4gvg` exception.
- Updated the transitive `fast-uri`, `js-yaml`, and `nanoid` nodes to patched releases.
- Updated `tsx` and `esbuild` within their compatible ranges, eliminating the previous `GHSA-g7r4-m6w7-qqqr` disposition.
- Pinned the Stripe SDK to 22.3.2 so this security refresh preserves QuoteFly's reviewed `2026-06-24.dahlia` payment API behavior.
- QuoteFly currently permits no dependency-advisory exceptions; `npm run audit:all` fails on every reported advisory.

## 2026-07-27 launch gate

- Root and frontend packages were refreshed within supported release lines.
- `@fastify/static` is pinned to patched version 10.1.2 while `@fastify/swagger-ui` catches up to the new transitive release.
- Three narrowly scoped advisory dispositions were temporarily accepted for development-only or unreachable paths. All three were retired in the 2026-08-10 refresh after compatible patched releases became available.
- `npm run audit:all` audits both dependency trees and fails on every advisory that is not explicitly dispositioned.

Date: 2026-04-07

## Root project

- Prisma and Prisma Client upgraded to 6.19.3 (latest stable in major v6).
- Reason for staying on v6: v7 requires migration changes and would slow MVP delivery.
- Runtime audit: 0 vulnerabilities.

## Frontend project (web)

- Tailwind CSS v4 installed with @tailwindcss/vite integration.
- @types/node upgraded to 25.5.2.
- Runtime audit: 0 vulnerabilities.

## Known transitive deprecation

- twilio currently depends on scmp@2.1.0 (deprecated notice from upstream).
- This is transitive and controlled by Twilio package maintainers.
- Current action: monitor Twilio releases and update when dependency tree changes.

## Validation status

- Backend build passes.
- Frontend build passes.
- Frontend API health check remains wired to /v1/health.
