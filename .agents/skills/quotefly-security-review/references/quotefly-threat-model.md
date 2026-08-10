# QuoteFly threat model and review surfaces

## Protected assets

- Credentials, password hashes, session cookies, JWT signing material, and live membership/role state.
- Tenant-scoped customers, contact details, addresses, notes, quotes, PDFs, activity history, AI usage, and accounting data.
- Internal unit costs, margins, pricing defaults, and other data that must not appear in customer-facing responses or PDFs.
- Stripe, Twilio, QuickBooks, OpenAI, database, hosting, DNS, CI/CD, and GitHub credentials or identifiers.
- Billing state, webhook event history, OAuth state/tokens, migrations, backups, and audit evidence.

## Trust boundaries

- Public browser to React application and Fastify API.
- Authenticated user to tenant membership and role authorization.
- API to PostgreSQL through Prisma.
- Public PDF/share endpoints to customer-visible quote data.
- API to Stripe, Twilio, QuickBooks, and OpenAI.
- Provider callbacks/webhooks to internal writes and billing/accounting state.
- GitHub/CI build pipeline to Railway/Vercel and production secrets.
- Browser storage, cookies, optional analytics, and third-party scripts.

## Mandatory review areas

### Authentication and sessions

- Bound password input before bcrypt work; use a supported cost and non-enumerating failures.
- Confirm login/signup/reset rate limits and constant-work behavior for absent users.
- Verify HttpOnly, Secure, Path, lifetime, and appropriate SameSite settings.
- Revalidate live user, tenant, and role state on protected requests; do not trust stale JWT roles alone.
- Require explicit CSRF defenses before cross-site cookies (`SameSite=None`) or unsafe cross-origin state changes.
- Review logout, password/role changes, account deletion, token expiry, and session invalidation.

### Authorization and tenant isolation

- Scope every customer, quote, membership, AI usage, billing, integration, activity, export, and search query by `tenantId`.
- Verify tenant scope inside transactions, nested writes, relation connects, aggregates, raw SQL, caches, retries, and background work.
- Do not authorize from client-supplied tenant IDs or provider metadata without binding them to server-side state.
- Test horizontal and vertical access with two tenants and multiple roles, including archived/deleted users and tenants.
- Preserve soft-delete semantics and exclude archived/deleted rows from active authorization.

### Inputs, outputs, and documents

- Validate bodies, params, queries, headers, and provider payloads with strict schemas and bounded sizes.
- Check injection, XSS, SSRF, open redirect, path traversal, prototype pollution, CSV formula injection, and unsafe deserialization.
- Ensure public share/PDF/email/SMS flows never expose internal costs, tenant-only notes, provider errors, or secrets.
- Treat quote text, filenames, URLs, AI prompts, and imported/exported CSV data as attacker-controlled.
- Return stable public errors while logging safe operational context without PII or credentials.

### Providers and AI

- Stripe: verify signatures against the raw body, preserve timestamp tolerance, store event IDs, make handlers idempotent, and bind customer/subscription ownership to the tenant.
- Twilio: validate the exact externally visible URL and all parameters with the official SDK; tolerate new parameters; require HTTPS in production.
- QuickBooks: verify OAuth state, tenant/realm binding, callback role, token storage, webhook verifier, idempotency, and disconnect/revocation behavior.
- OpenAI: call only from the backend, minimize customer data, prevent browser key exposure, bound prompts/output, validate structured output, and define retention/disclosure behavior.
- Keep external API calls outside long database transactions where practical; persist pending/success/failure states safely.

### Platform, database, and delivery

- Lock CORS to intended origins and review Helmet/CSP/HSTS/frame/referrer/permissions policies.
- Enforce strong production secrets and non-localhost URLs through environment validation.
- Apply migrations before traffic, use readiness checks for schema compatibility, and review migration SQL and rollback constraints.
- Verify database least privilege, encrypted transport, backups, restore evidence, retention, and tenant-focused indexes/constraints.
- Protect branches and environments; limit production deploy authority; pin or review CI actions; keep secrets environment-scoped.
- Track direct and transitive dependencies, lockfiles, install scripts, advisories, runtime support windows, and remediation evidence.
- Require monitoring and alerts for auth abuse, provider/webhook failures, unexpected 5xx rates, readiness, migration failures, and suspicious cross-tenant denials.

### Privacy and lifecycle

- Maintain a data inventory, purpose, lawful/contractual basis, subprocessor, retention period, deletion/export path, and owner for each data class.
- Verify the privacy policy, cookie policy, product behavior, and provider configuration tell the same story.
- Do not load non-essential analytics or tracking until valid consent where required; offer a clear reject choice and reversible preferences.
- Minimize data sent to providers and define support access, incident response, breach notification, and data-subject/customer request procedures.
- Treat “compliance” as scoped readiness. Eligibility thresholds, jurisdictions, contracts, and counsel determine actual obligations.
