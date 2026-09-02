# PostgreSQL migration portability

QuoteFly requires PostgreSQL 16 or newer. Release evidence must include migration deployment with a managed, non-superuser owner; a local `postgres` superuser run is necessary but not sufficient.

## Cluster-wide retention role

`quotefly_quarantine_retention` is a cluster-wide NOLOGIN role used only as the owner of the bounded QuickBooks quarantine-purge function. It must remain:

- `NOSUPERUSER`, `NOBYPASSRLS`, `NOLOGIN`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`, and `NOREPLICATION`;
- a member of no other role;
- assumable by no runtime role;
- granted only to the trusted migration owner with `ADMIN=true`, `SET=false`, and `INHERIT=false` between migrations.

Function-owner migrations may temporarily set the migration owner's `SET` membership to true, perform the owner transfer, and immediately restore `SET=false`. Runtime services never receive this membership.

## Intentional migration-history correction

The original `20260827163000`, `20260827163500`, and `20260828123000` SQL requested role changes that a managed PostgreSQL owner may not perform and fully revoked the creator's PostgreSQL 16 administrative membership. Their checked-in SQL is intentionally corrected so a fresh second database in the same cluster can migrate without superuser access. `20260831194500_harden_quickbooks_retention_role_portability` reasserts the safe role and membership state for databases that already applied the originals.

Databases that previously applied those migrations retain their original Prisma checksums. Treat that checksum divergence as a reviewed exception tied to this document and the additive repair migration; do not edit any other applied migration.

If the additive repair fails because a provider will not allow the managed owner to restore `ADMIN=true, SET=false, INHERIT=false`, stop. A provider-privileged operator must grant that exact bounded membership. Do not grant `SET`, `INHERIT`, login, superuser, or bypass-RLS capability.

Use `prisma migrate resolve --rolled-back 20260827163000_add_quickbooks_global_quarantine_retention` only on a disposable/test database where that migration is recorded as failed. Never resolve it on a database where it succeeded, and never use `resolve` to conceal drift.

## Required evidence

Before release:

1. Run all migrations on a fresh database with a non-superuser managed owner.
2. Run them on a second database in the same PostgreSQL cluster so the retention role already exists.
3. Verify all role flags, outgoing memberships, and the one bounded incoming migration-owner membership.
4. Verify function ownership, PUBLIC revocation, runtime EXECUTE only, schema CREATE revocation, exact table privileges, and bounded purge behavior in the second database.
5. Preserve only sanitized database name, branch ID, migration names, statuses, counts, and role booleans as evidence.
