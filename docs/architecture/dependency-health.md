# Dependency Health Snapshot

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
