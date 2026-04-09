# Multi-Tenant Data Plan (V1.1)

Date: 2026-04-08

## Goal

Keep tenant boundaries strict from day one while keeping the schema easy to evolve.

## Core conventions

- Tenant scope:
  - Every tenant-owned table has `tenantId`.
  - API routes derive tenant context from JWT claims, never from request body.
- Time:
  - Store all time in UTC using PostgreSQL `timestamptz`.
  - Render local time in UI using tenant/user timezone.
  - Tenant default timezone is stored on `Tenant.timezone` (IANA zone, default `UTC`).
- Lifecycle fields:
  - Active records have `deletedAtUtc = null`.
  - Soft-delete sets `deletedAtUtc` to current UTC timestamp.
  - `createdAt` and `updatedAt` remain required for mutation history.

## Naming guidance

For new tables and API contracts, prefer explicit UTC names:

- `createdAtUtc`
- `modifiedAtUtc`
- `deletedAtUtc`

Current schema keeps `createdAt`/`updatedAt` for compatibility, with UTC enforcement at DB type level (`timestamptz`).

## Integrity rules

- Tenant-aware relations use composite references where needed:
  - Quote -> Customer uses `(customerId, tenantId) -> (id, tenantId)`.
  - QuoteDecisionSession -> Quote uses `(quoteId, tenantId) -> (id, tenantId)`.
- Tenant-scoped indexes include `tenantId` and frequently filtered lifecycle fields (`deletedAtUtc`, status, created/received time).

## API guardrails

- Protected routes (`customers`, `quotes`, `tenants`, `branding`) require JWT auth.
- `tenantId` is no longer accepted from client payloads for customer/quote creation.
- Tenant ownership checks are required before mutation.

## Next phase checklist

1. Add repository helpers that automatically append `{ tenantId, deletedAtUtc: null }` filters.
2. Add delete/restore endpoints with soft-delete policy and audit logging.
3. Add integration tests for cross-tenant access attempts.
4. Add Stripe entitlements and role-based authorization (`owner`, `admin`, `staff`).
5. Consider PostgreSQL Row Level Security after auth/session model stabilizes.
