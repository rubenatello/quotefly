---
name: quotefly-security-review
description: Perform threat-aware security, privacy, dependency, provider, deployment, and compliance-readiness reviews for QuoteFly. Use for authentication or authorization changes, tenant-scoped data access, cookies and privacy controls, Stripe/Twilio/QuickBooks/OpenAI integrations, webhook or OAuth work, dependency vulnerabilities, database or CI/CD changes, production incidents, pre-launch audits, and recurring security reviews.
---

# QuoteFly Security Review

Review QuoteFly as a multi-tenant SaaS that stores sensitive customer, quote, pricing, billing, and integration data. Prefer evidence-backed findings and safe verification over checklist-only reassurance.

## Required context

Read `AGENTS.md` first. For a broad review, also read:

- `references/quotefly-threat-model.md` for assets, trust boundaries, and stack-specific checks.
- `references/research-and-compliance.md` for source requirements and compliance boundaries.

For a narrow review, read the reference that covers the affected surface. Inspect the actual diff, call path, schema, tests, runtime configuration, and provider boundary before reaching a verdict.

## Review workflow

1. Define the review target.
   - Record branch/SHA, diff base, environments, providers, data types, and whether production evidence is in scope.
   - Separate code review, configuration review, production posture, and legal readiness. Missing access in one category must not erase findings in another.

2. Build the attack story.
   - Identify attacker, asset, entry point, trust boundary, required privileges, exploit path, and impact.
   - Consider unauthenticated attackers, ordinary tenant members, tenant owners, compromised provider accounts, malicious webhook senders, dependency compromise, and accidental operator error.

3. Trace enforcement end to end.
   - Follow browser input through validation, authentication, live authorization, tenant-scoped database access, external calls, persistence, logging, and response serialization.
   - Verify denial behavior and exceptional conditions, not only the success path.

4. Run safe, relevant checks.
   - Prefer `rg`, targeted tests, `npm run test:security`, `npm run audit:all`, and a dedicated test database for `npm run test:integration` or `npm run verify:ci`.
   - Never weaken the test-database name guard, use production credentials, or run active exploitation against production.
   - Treat a failed or unavailable required gate as missing evidence, not a pass.

5. Research time-sensitive claims.
   - Browse current primary sources for dependency advisories, standards, provider requirements, cookie/privacy rules, and regulatory thresholds.
   - State the exact version/date and link the source. Do not rely on search snippets or unsourced memory for current claims.

6. Report and decide.
   - Lead with actionable findings ordered by severity.
   - End with one verdict: `APPROVED`, `CHANGES_REQUIRED`, or `BLOCKED_MISSING_EVIDENCE`.

## Finding contract

For each finding provide:

- Severity: Critical, High, Medium, or Low.
- Confidence: High, Medium, or Low.
- Evidence: exact file/line, symbol, command output, test, or passive runtime observation.
- Exploit or failure path: the shortest realistic sequence.
- Impact: affected tenants, data, money, availability, or legal commitments.
- Remediation: the smallest fix that closes the trust-boundary failure.
- Verification: a regression test or operational check.
- Source: authoritative link when the claim is time-sensitive or provider-specific.

Severity guidance:

- Critical: practical cross-tenant or admin takeover, secret or payment compromise, remote code execution, or broad sensitive-data exposure.
- High: exploitable authentication/authorization bypass, serious webhook/OAuth failure, stored injection, or likely material data exposure.
- Medium: meaningful defense gap requiring additional conditions, missing detection, risky default, or incomplete privacy control.
- Low: bounded hardening with limited direct exploitability.

Do not inflate severity. Keep confirmed vulnerabilities, plausible hypotheses, and forward-looking recommendations in separate sections.

## Approval standard

Approve only when:

- applicable tenant, auth, provider, security, and dependency tests pass;
- no unresolved Critical or High finding remains;
- security-sensitive failures deny safely and return stable public errors;
- secrets and internal costs do not cross public or customer-facing boundaries;
- privacy/cookie behavior matches published claims; and
- missing operational or legal evidence is explicitly recorded as residual risk.

Never describe QuoteFly as “secure,” “compliant,” “certified,” or “penetration tested” without a defined scope and supporting evidence.
