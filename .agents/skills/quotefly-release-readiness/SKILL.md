---
name: quotefly-release-readiness
description: Assess and improve QuoteFly release operations, CI gates, deployment configuration, migration rollout, health and readiness checks, observability, rollback, provider setup, and launch evidence. Use for Harbor work involving staging or production readiness, Vercel/Railway/Render/Postgres deployment, environment matrices, incident preparedness, release checklists, or go/no-go decisions; never deploy unless explicitly authorized.
---

# QuoteFly Release Readiness

Produce evidence for a safe, reversible consumer release.

## Inspect release state

1. Read `AGENTS.md`, `.github/workflows/ci.yml`, `DEPLOYMENT.md`, `FEATURE_READINESS.md`, `OWNER-ACTION-ITEMS.md`, package scripts, migrations, health routes, and provider flags.
2. Confirm CI runs from clean installs, generates Prisma, applies migrations to a test database, and executes the same launch gate expected locally.
3. Separate liveness, readiness, and dependency health. Verify logs expose actionable context without secrets or PII.
4. Review migration ordering, backups, forward-fix strategy, release sequencing, rollback compatibility, and provider disable switches.
5. Verify production environment requirements without printing secret values.

## Apply the release gate

Require:

- `npm run verify` for production handoff.
- `npm run verify:launch` against a migrated PostgreSQL database whose name contains `test` for consumer-release recommendation.
- A staging smoke of health, auth/session restore, customer creation, quote creation/editing, PDF, send log, billing path, and touched providers.
- Mobile device or clearly labeled emulation evidence for the core workflow.
- Confirmed DNS, support mailbox, legal review, production Stripe setup, backups, monitoring, and owner-managed provider configuration as applicable.

Mark the release `NO-GO` when a required gate fails. Mark it `BLOCKED` when external evidence is missing. Do not convert missing provider, legal, DNS, database, or device evidence into an engineering pass.

Do not deploy, push, run production migrations, change DNS, enable providers, or run BCP unless the user explicitly authorizes the action.

## Return evidence

Return `GO`, `NO-GO`, or `BLOCKED`, followed by gate results, migration/rollback notes, observability gaps, owner actions, and the fastest safe next sequence. Harbor supplies release evidence; Opera issues the independent engineering approval.
