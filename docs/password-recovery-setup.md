# Password Recovery Setup

QuoteFly password recovery uses Resend for transactional email and stores only a SHA-256 hash of each random reset token. Links expire after 30 minutes by default, work once, and revoke all existing browser sessions when the password changes.

## Provider setup

1. Create or open the QuoteFly Resend account.
2. Add and verify the root domain `quotefly.us` so the sender can be `support@quotefly.us`.
3. Add the SPF and DKIM records Resend supplies to the authoritative DNS provider.
4. Wait until the domain reports `verified` in Resend.
5. Create an API key limited to sending email from the verified domain when the provider plan supports that restriction.

The verified domain must exactly match the sender domain. Verifying only a subdomain such as `updates.quotefly.us` will not authorize `support@quotefly.us`. Resend generally recommends a subdomain to isolate sending reputation, but QuoteFly uses the root-domain support identity for a recognizable customer-facing sender. See the official [domain setup guide](https://resend.com/docs/dashboard/domains/introduction), [domain-matching guidance](https://resend.com/docs/knowledge-base/403-error-domain-mismatch), and [send-email API reference](https://resend.com/docs/api-reference/emails/send-email).

## Railway variables

Set these only on the API service in the production environment:

```text
RESEND_API_KEY=<backend-only secret>
PASSWORD_RESET_EMAIL_FROM=QuoteFly <support@quotefly.us>
PASSWORD_RESET_TOKEN_TTL_MINUTES=30
```

Do not add the API key to Vercel, a `VITE_` variable, `.env.example`, screenshots, logs, or Git.

`APP_URL` must be the canonical HTTPS frontend origin because the API builds reset links from this configured value rather than the incoming request host.

## Release order

1. Add and verify `quotefly.us` in Resend.
2. Create a sending-only Resend API key restricted to `quotefly.us`, then add both required Railway variables in the same update.
3. Run the candidate verification gate.
4. Deploy the API so the password-recovery migration runs before traffic.
5. Deploy the matching web build.
6. Confirm `/v1/ready` returns `200`.

If the email provider is not configured, the forgot-password endpoint returns a provider-wide `503` without checking whether the submitted account exists.

## Production smoke test

Use a controlled QuoteFly account and a unique new password:

1. Open **Sign In**, select **Forgot password?**, and submit the account email.
2. Confirm the UI always shows the generic non-enumerating response.
3. Confirm one branded email arrives and the URL uses the canonical `https://www.quotefly.us/reset-password` origin.
4. Set and confirm a new password on mobile and desktop.
5. Confirm the link cannot be reused.
6. Confirm an older signed-in browser session receives `401` and returns to sign in.
7. Confirm the old password fails and the new password succeeds.
8. Confirm the password-changed notification arrives without including the password.

Do not test password recovery with a password that has been pasted into chat, tickets, logs, or source control.

## Security behavior

- Forgot-password responses do not reveal whether an email belongs to an account.
- Requests are rate-limited by IP and active accounts have a 10-minute delivery cooldown.
- Tokens contain 256 bits of randomness and only their SHA-256 hashes are stored.
- Tokens expire, are single use, and previous outstanding tokens are invalidated after a replacement is delivered.
- Reset attempts perform bounded bcrypt work and are rate-limited.
- Password changes increment the user's authentication version, invalidating existing session cookies.
- The reset token is carried in the URL fragment so it is not sent to the web server, and the reset page uses a no-referrer policy and removes the token from browser history after success.
