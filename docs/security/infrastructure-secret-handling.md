# Infrastructure secret handling

This is QuoteFly's authoritative protocol for credentials, tokens, database URLs, encryption keys, webhook verifiers, and provider configuration in local development, CI, Neon, Railway, Vercel, Intuit, Stripe, OpenAI, Twilio, Resend, and any later provider.

## Evidence boundary

Never read, print, export, paste, screenshot, attach, or retain raw secret values. This includes provider CLI variable dumps, `.env` downloads, shell history, CI logs, tickets, chat, agent transcripts, browser recordings, and analytics.

Use a provider's secret editor for writes and its masked view for manual confirmation. Use `npm run infra:variables:audit -- --profile <fixed-profile>` only for local process evidence; run it with `--help` for the closed profile list, including the role-isolated QuickBooks signal profiles. Its fixed JSON report proves configured/missing presence for that process only; it does not prove a remote provider's configuration and must not be used to retrieve values.

## If disclosure is suspected or confirmed

Treat any raw-value disclosure as a compromise, even if the recipient is trusted or the value was a sandbox value.

1. Disable the affected provider workflow in the affected environment. Do not change unrelated environments.
2. Revoke or rotate the affected credential at its issuer. Rotate independently for every environment; never copy a production value into staging or vice versa.
3. Update the secret manager/runtime configuration, restart or redeploy the affected service, and remove the old value from every runtime that could still use it.
4. Invalidate affected sessions, API tokens, OAuth grants, webhook credentials, encryption-protected tokens, or provider connections as appropriate to the disclosed material.
5. Verify safely with a fixed-profile presence audit, masked provider confirmation, health/readiness checks, and sanitized provider evidence. Do not re-read the secret to verify it.
6. Remove recoverable artifacts such as local downloads, terminal captures, CI artifacts, screenshots, tickets, and logs using the approved retention/incident procedure.
7. Record a sanitized timeline: environment, provider, credential label/fingerprint, exposure window, affected systems, disable/rotation/restart/invalidation times, evidence owner, and remaining risk. Do not record the raw value.
8. Escalate to security, legal/privacy, support, and customer-notification owners when applicable. Follow contractual, regulatory, and customer-notification obligations; do not make an unsupported claim that notification is unnecessary.

## QuickBooks-specific escalation

For a QuickBooks client secret, webhook verifier, OAuth token, callback code/state, or token-encryption-key disclosure, immediately disable `QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED` for the affected environment. Revoke affected QuickBooks connections and provider tokens before re-enabling workflows. A token-encryption-key exposure additionally requires treating every connection encrypted by that key as affected: revoke/disconnect it, invalidate the stored ciphertext path, issue a new independent key, and reconnect through fresh OAuth consent. Do not rely on token ciphertext rotation alone after key exposure.

Keep `QUICKBOOKS_PROVIDER_WORKFLOWS_ENABLED=false` until the issuer-side revocation, runtime restart, connection state, and safe verification evidence are complete.

The QuickBooks API and worker signal-source tokens are monitoring credentials,
not Intuit or accounting credentials. If either is disclosed, remove the
affected sink pair from that backend runtime, rotate the token at the log
provider, restore only its matching API or worker pair, and prove a sanitized
canary delivery. Do not copy one runtime's source token into the other. A signal
token disclosure alone does not require revoking customer OAuth grants, but it
does require treating alerts from that source as untrusted until rotation and
canary evidence are complete.
