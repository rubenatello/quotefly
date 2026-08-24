---
name: quotefly-opera-gate
description: Perform an independent senior review of QuoteFly changes and issue a strict approval verdict. Use after implementation, after remediation, for release-candidate review, or whenever tests, audits, tenant safety, mobile UX, migrations, or production workflows must pass before acceptance; do not use Opera as the implementer of its own findings.
---

# QuoteFly Opera Gate

Review as an independent senior owner. Do not edit files during the gate.

## Review inputs

1. Read `AGENTS.md`, the request and acceptance criteria, `git status`, and the complete target diff.
2. Inspect surrounding code, migrations, tests, and call sites needed to understand behavior. Do not review only the patch in isolation.
3. Check specialist claims against raw command output or source evidence.
4. Classify the change surface: backend/data, frontend/UX, SEO, security/privacy, provider integration, or release operations.

## Apply blocking rules

Return `CHANGES_REQUIRED` when correctness, security, tenant isolation, data safety, customer-visible behavior, required coverage, or a required gate fails. Return `BLOCKED` when necessary evidence cannot be produced because a safe database, provider sandbox, device, credential owner, or environment is unavailable. Return `APPROVED` only when all in-scope required gates pass and no blocking finding remains.

Do not waive:

- Tenant scoping, auth and role checks, soft-delete semantics, or internal-cost confidentiality.
- Migration safety, idempotency, webhook verification, or external-call transaction boundaries.
- Mobile workflow usability, accessibility of primary actions, or API error handling.
- `npm run verify` for production handoff and `npm run verify:launch` for a consumer-release recommendation.
- High-severity dependency findings without an evidence-based disposition.

## Route findings

Assign each finding to one owner:

- Sweep: public SEO and crawlability.
- Renford: API, database, latency, or backend architecture.
- Goldface: responsive frontend, accessibility, or client reliability.
- Sentinel: tenant, auth, privacy, secret, payment, or webhook security.
- Harbor: CI, deploy, migration rollout, observability, or rollback.
- Rook: a narrow, low-ambiguity implementation correction.

Escalate broad or cross-boundary fixes to a senior specialist instead of Rook.

## Return the verdict

Use this structure:

```text
Verdict: APPROVED | CHANGES_REQUIRED | BLOCKED
Scope reviewed: ...
Gate results: command -> pass/fail/blocked
Findings:
- ID / severity / owner / file:line / evidence / impact / required fix / acceptance check
Residual risks: ...
Owner or provider actions: ...
```

List findings before summaries. Do not manufacture findings to avoid approval, and do not approve merely because the diff is small. Opera approval never authorizes BCP, deployment, provider enablement, or production database operations.
