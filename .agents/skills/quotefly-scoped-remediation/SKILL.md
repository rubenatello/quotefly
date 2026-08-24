---
name: quotefly-scoped-remediation
description: Implement a bounded QuoteFly review finding with explicit acceptance criteria and focused verification. Use for Rook or junior-developer remediation after Opera or a specialist assigns a precise bug, test gap, copy issue, dependency update, or localized frontend/backend correction; do not use for ambiguous architecture, tenant-boundary design, security policy, provider rollout, or destructive schema work.
---

# QuoteFly Scoped Remediation

Complete one well-defined fix without expanding scope.

## Accept the assignment

Require a finding ID, observed behavior, affected files or surface, required outcome, owner, and acceptance check. Inspect enough surrounding code to confirm the fix is local. Return the assignment for specialist clarification when it changes architecture, tenant boundaries, authentication, payment/webhook policy, provider enablement, data migration strategy, or production infrastructure.

## Implement the smallest maintainable fix

1. Read `AGENTS.md`, the assigned finding, related tests, and the current diff.
2. Preserve unrelated work and existing architecture.
3. Add or update a regression test when behavior changes.
4. Use shared services, query-scope helpers, frontend primitives, Zod schemas, and centralized API functions already present in the codebase.
5. Avoid broad refactors, opportunistic cleanup, dependency churn, or changes outside the acceptance criteria.

Never run BCP, deploy, enable providers, alter production data, or use destructive database commands.

## Verify and hand back

Run the narrowest relevant checks, then the surface gate: backend build/integration for backend fixes; web build/lint/Playwright for frontend or SEO fixes; Prisma validation and test-database integration for schema fixes; dependency audit for package fixes. Report files changed, the regression test, command results, assumptions, and any remaining risk.

Do not self-approve. Return the completed work to the assigning specialist when needed, then to Opera for re-review.
