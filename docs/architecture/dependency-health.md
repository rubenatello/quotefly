# Dependency Health Snapshot

## 2026-07-27 launch gate

- Root and frontend packages were refreshed within supported release lines.
- `@fastify/static` is pinned to patched version 10.1.2 while `@fastify/swagger-ui` catches up to the new transitive release.
- `brace-expansion` advisory `GHSA-mh99-v99m-4gvg` is explicitly accepted only for the legacy release nested under ESLint development tooling. That code is not installed in the production bundle; a forced cross-major override breaks ESLint's expected CommonJS API.
- React Router advisory `GHSA-qwww-vcr4-c8h2` is explicitly accepted only because QuoteFly is a client-side Vite SPA and does not use React Server Components or server actions, the affected execution path. Remove this exception when a compatible patched `react-router-dom` release is available.
- Disposition `DEP-ESBUILD-2026-01` accepts `esbuild` advisory `GHSA-g7r4-m6w7-qqqr` only for Web's exact development-only `node_modules/esbuild` 0.27.7 node installed through `tsx` 4.21.0. QuoteFly invokes `tsx` solely to transform the build-time public prerender and SEO tests; it never calls esbuild's affected Windows HTTP development-server API. There is no compatible patched esbuild release in `tsx`'s `~0.27.0` range, so forcing an override would violate the dependent package's declared compatibility. Remove this exception as soon as `tsx` supports a patched esbuild, if `tsx` is removed, or immediately if this node becomes production-installed or any QuoteFly script starts esbuild's serving API.
- `npm run audit:all` audits both dependency trees and fails on every advisory except the three documented, unreachable paths above.

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
