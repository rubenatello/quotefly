# AI Retention and Provider Data-Control Runbook

Owner: security/reliability
Last reviewed: 2026-08-25
Scope: Kody prompt-to-quote, assistant composition, embeddings/retrieval, AI usage traces, retrieval audits, and assistant feedback.

This runbook defines technical controls and release evidence. It does not claim legal compliance or replace counsel's review of customer disclosures, contracts, deletion obligations, or jurisdiction-specific retention requirements.

## Retention policy

| Data | Active window | Expiration action | Retained after minimization |
| --- | ---: | --- | --- |
| Historical `AiUsageEvent.promptText` | None | Set to `NULL` on the next authorized apply run, even when the trace has not otherwise expired | Prompt hash, purpose, classification, model, usage/cost, timestamps, and object links needed for accounting and provenance |
| Redacted AI usage trace fields | Until `retentionExpiresAtUtc` (currently 90 days when created through governance) | Clear redacted prompt, actor email/name snapshots, insight summary/reasons/source labels, risk note, and any legacy raw prompt | Content-free accounting, classification, confidence, source count, and linkage metadata |
| Retrieval audit event | Until `retentionExpiresAtUtc` (currently 90 days) | Soft-archive and clear actor, source references/types, filter summary, and ranking summary | Content-free policy/status/timing/token/cost-adjacent evidence, query hash, and deletion timestamp |
| Assistant feedback | 180 days | Soft-archive and clear the optional free-text note | Rating record, actor/event linkage, timestamps, and deletion timestamp for audited quality accounting |

The service never prints tenant IDs, prompts, feedback notes, customer values, source references, or provider payloads. It uses tenant-bound transactions, an advisory lock, `FOR UPDATE SKIP LOCKED`, a 250-row batch, and a maximum of 5,000 rows per tenant per invocation. Retrying is expected and idempotent.

## Run procedure

1. Run the bounded dry-run. It is the default and performs no updates:

   ```bash
   npm run ai:retention
   ```

2. To rehearse one tenant without exposing its identifier in a ticket or shared log, supply the tenant ID only in the private operator shell:

   ```bash
   npm run ai:retention -- --tenant-id=<tenant-id> --max-rows=500
   ```

3. Record only the aggregate JSON counts, exact commit SHA, runtime role, database environment, operator, and timestamp. Do not paste database URLs, tenant IDs, raw rows, notes, or prompts into release evidence.

4. Apply only during an approved maintenance/release operation. The confirmation token prevents an accidental apply caused by a stray flag:

   ```bash
   npm run ai:retention -- --apply --confirm=MINIMIZE_EXPIRED_AI_DATA
   ```

5. Treat any non-zero `failedTenantCount`, `skippedTenantCount`, or `hasMoreTenantCount` as incomplete. Investigate fixed-code logs, then rerun until a dry-run reports no remaining eligible rows. Do not increase the 5,000-row ceiling to make an incident disappear.

6. For rollback, stop future invocations. Minimized content cannot be reconstructed from application rows; restoration, if contractually and operationally justified, requires an approved database backup restore process. Do not restore expired AI content merely to reverse aggregate counts.

## Provider data-control evidence

OpenAI's official API data-control documentation was rechecked on 2026-08-25: <https://developers.openai.com/api/docs/guides/your-data>.

Verified distinctions:

- OpenAI states API data is not used to train models unless the customer opts in.
- Default abuse-monitoring logs can include customer content and are retained for up to 30 days, subject to the provider's stated exceptions.
- Zero Data Retention (ZDR) and Modified Abuse Monitoring (MAM) require provider approval and organization/project configuration. They are provider-account controls, not application flags.
- `store: false` limits application-state storage for supported requests. It is not evidence that the QuoteFly OpenAI organization or project has ZDR. Never describe `store: false` as “zero retention.”
- Endpoint/model eligibility and limitations can change. Recheck the official endpoint table for every model or endpoint change.

Before enabling or changing provider-backed Kody in production, attach content-free evidence for all of the following:

- [ ] OpenAI organization ID and project ID are recorded in the private secrets/evidence system, not Git or ordinary logs.
- [ ] A provider admin captured the Data Controls screen with the organization and project retention selections and verification date. Redact API keys, billing details, membership emails, and unrelated projects.
- [ ] The evidence explicitly says one of `default abuse monitoring`, `MAM`, or `ZDR`; it does not infer the setting from code.
- [ ] The selected chat and embedding endpoint/model combinations are eligible under the documented provider control.
- [ ] QuoteFly's provider gateway remains backend-only, uses the intended project API key, and does not expose provider credentials to Vite/browser configuration.
- [ ] All applicable stateful API requests set `store: false`; a code search and focused provider test are attached. Stateless endpoint behavior is checked against current provider docs.
- [ ] Prompt minimization/redaction and structured-output rejection tests pass on the exact candidate SHA.
- [ ] `eval:assistant:provider` and the synthetic provider-backed quality workflow pass on the exact candidate SHA; artifact access and retention are restricted.
- [ ] The privacy notice and customer contract language describe actual configured behavior and the provider subprocessors. Qualified counsel owns the legal conclusion.
- [ ] The evidence has an owner and recheck date. Recheck on provider/model/endpoint/project changes and at least quarterly.

## Content-free provider fallback diagnostics

Assistant composition fallbacks emit one JSON object containing only:

- `event=ai_assistant_provider_fallback`
- a validated request ID or `unavailable`
- `provider=openai`
- the configured model identifier
- one fixed failure code: `PROVIDER_CALL_FAILED`, `PROVIDER_OUTPUT_INVALID_JSON`, or `PROVIDER_OUTPUT_REJECTED`

Do not add prompt text, deterministic/provider answers, customer or tenant identifiers, exception messages/stacks, source snippets, feedback notes, or request bodies. Alert on rates by fixed failure code and model. Use the request ID to locate the separately access-controlled application trace.

## Forced-RLS prerequisite and deferral

Do not force RLS on `AiUsageEvent` or `AiAssistantFeedback` in the current compatibility window.

Two prerequisites are unresolved:

1. The legacy `quotefly_bridge_legacy_ai_usage_event` is an `AFTER INSERT` trigger designed to repair usage inserts made without `app.tenant_id`. Forced RLS would reject such an insert before the trigger runs. Retire the fallback after the compatibility window, or replace it with a reviewed fail-closed write path that sets tenant context before insert.
2. The audited superuser AI-quality control plane intentionally reads feedback/usage across tenants. Forced RLS would hide those records unless the control plane uses a distinct least-privileged audited database role/function or performs bounded tenant-context iteration without accepting caller-controlled tenant scope.

After both prerequisites have integration tests, add a dedicated migration that enables and forces RLS, grants the runtime role only the required statements, adds exact tenant policies to both tables, registers both tables in `FORCED_TENANT_RLS_TABLES`, and proves:

- no tenant context sees no tenant rows;
- tenant A cannot read or mutate tenant B;
- normal usage reservation/finalization and feedback submission still work;
- compatibility retries remain idempotent;
- superuser default output keeps feedback notes redacted and explicit note reveal remains audited.

## Incident handling

- Disable provider-backed composition/retrieval with existing rollout flags when leakage, unexplained cross-tenant retrieval, or provider-account uncertainty is suspected. Deterministic quote drafting remains the fail-closed path.
- Preserve content-free usage, reservation, audit, and fixed-code failure records. Do not copy sensitive rows into chat, tickets, or ad hoc files.
- Escalate suspected customer-data disclosure through the incident owner. Determine affected tenants, provider request window, model/endpoint, configured provider retention control, and legal notification obligations with qualified counsel.
- After containment, rerun tenant isolation, prompt minimization, provider boundary, retrieval authorization, and exact-SHA provider quality tests before re-enabling the rollout.
