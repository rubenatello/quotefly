---
name: quotefly-production-loop
description: Coordinate QuoteFly product work across SEO, UX, backend, security, release operations, implementation, verification, and independent review. Use for multi-area features, production-readiness work, launch preparation, or any change that benefits from several specialist perspectives.
---

# QuoteFly Production Loop

Use this workflow to turn a broad QuoteFly request into a reviewed, tested release candidate. Keep the root agent responsible for scope, integration, user communication, and the final decision.

## 1. Establish the candidate

1. Read `AGENTS.md` and inspect the current branch, latest commit, and worktree status.
2. Preserve unrelated user changes and untracked files.
3. Confirm the requested outcome and identify the smallest coherent implementation slice.
4. Never commit, push, deploy, migrate production data, or change provider state unless the user explicitly authorizes that action. BCP only means build, commit, and push when the user explicitly says `run BCP`.

## 2. Select specialist lanes

Delegate only independent, bounded work that improves speed or confidence:

- Sweep: public SEO, crawlability, structured data, content architecture, and search performance.
- Goldface: mobile and desktop UX, accessibility, visual consistency, loading/error states, and frontend reliability.
- Renford: API latency, Prisma/PostgreSQL behavior, backend architecture, and infrastructure integrity.
- Sentinel: authentication, authorization, tenant isolation, privacy, payments, providers, dependencies, and deployment security.
- Harbor: CI, migrations, observability, rollback, release evidence, and production operations.
- Rook: narrow remediation with explicit files and acceptance criteria only.
- Opera: independent senior review after implementation and verification; Opera must remain read-only.

Do not delegate skill instructions or ambiguous architecture and security decisions. The root agent reads applicable skills and integrates specialist evidence.

## 3. Implement from evidence

1. Convert specialist findings into a short prioritized plan.
2. Resolve Critical and High risks before polish. Address Medium risks that affect the requested release scope.
3. Reuse project primitives and established contracts before adding new abstractions.
4. Add or update tests for changed behavior, especially tenant isolation, authorization, migrations, mobile layouts, SEO output, and provider state machines.
5. Keep claims factual. Do not add invented customer proof, performance claims, or compliance guarantees.

## 4. Verify proportionally

Run focused checks while iterating, then the repository gate before handoff:

```bash
npm run verify
```

For database-backed or launch-critical changes, use an isolated migrated test database and run:

```bash
npm run verify:ci
```

For an exact production candidate, run the documented launch gate when available. A missing required gate is missing evidence, not a pass.

For frontend work, visually inspect representative mobile and desktop widths, keyboard focus, reduced motion, dark/light themes when applicable, loading/error states, and 44px mobile targets. For public pages, inspect built HTML rather than relying only on client rendering.

## 5. Obtain independent review

After implementation and gates are complete, give Opera the exact diff, test evidence, and known operational dependencies. Opera must not edit the work it reviews.

- `APPROVED`: no unresolved Critical, High, or release-blocking Medium findings.
- `CHANGES_REQUIRED`: route bounded fixes to Rook and systemic fixes to the owning specialist, rerun affected gates, and request a new review.
- `BLOCKED_MISSING_EVIDENCE`: obtain the missing evidence before presenting the candidate as ready.

## 6. Hand off clearly

Lead with the outcome, list material files and verification, disclose remaining owner/provider actions, and distinguish code readiness from deployment readiness. Do not imply a commit, push, migration, or deployment occurred unless it actually succeeded.
