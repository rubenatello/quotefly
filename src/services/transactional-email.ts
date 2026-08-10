import type { env as runtimeEnv } from "../config/env";

type RuntimeEnv = typeof runtimeEnv;

type ResendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

type PasswordResetEmailInput = {
  to: string;
  resetUrl: string;
};

const RESEND_EMAILS_ENDPOINT = "https://api.resend.com/emails";
const EMAIL_REQUEST_TIMEOUT_MS = 8_000;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function isTransactionalEmailConfigured(env: RuntimeEnv): boolean {
  return Boolean(env.RESEND_API_KEY && env.PASSWORD_RESET_EMAIL_FROM.trim());
}

async function sendTransactionalEmail(env: RuntimeEnv, input: ResendEmailInput): Promise<void> {
  if (!isTransactionalEmailConfigured(env)) {
    throw new Error("Transactional email is not configured.");
  }

  const response = await fetch(RESEND_EMAILS_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "User-Agent": "quotefly-api/1.0",
    },
    body: JSON.stringify({
      from: env.PASSWORD_RESET_EMAIL_FROM,
      to: [input.to],
      subject: input.subject,
      html: input.html,
      text: input.text,
    }),
    signal: AbortSignal.timeout(EMAIL_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Transactional email provider returned status ${response.status}.`);
  }
}

export async function sendPasswordResetEmail(
  env: RuntimeEnv,
  input: PasswordResetEmailInput,
): Promise<void> {
  const resetUrl = escapeHtml(input.resetUrl);

  await sendTransactionalEmail(env, {
    to: input.to,
    subject: "Reset your QuoteFly password",
    text: [
      "We received a request to reset your QuoteFly password.",
      "",
      `Reset your password: ${input.resetUrl}`,
      "",
      `This link expires in ${env.PASSWORD_RESET_TOKEN_TTL_MINUTES} minutes and can only be used once.`,
      "If you did not request this, you can ignore this email. Your password has not changed.",
    ].join("\n"),
    html: `
      <div style="background:#f7f4ee;padding:32px 16px;font-family:Arial,sans-serif;color:#0f172a">
        <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:20px;padding:32px">
          <p style="margin:0 0 8px;color:#2f6fd6;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase">QuoteFly account security</p>
          <h1 style="margin:0 0 16px;font-size:26px;line-height:1.2">Reset your password</h1>
          <p style="margin:0 0 24px;color:#475569;line-height:1.6">We received a request to reset your QuoteFly password.</p>
          <a href="${resetUrl}" style="display:inline-block;background:#2f6fd6;color:#ffffff;text-decoration:none;font-weight:700;padding:13px 20px;border-radius:10px">Choose a new password</a>
          <p style="margin:24px 0 0;color:#64748b;font-size:13px;line-height:1.6">This link expires in ${env.PASSWORD_RESET_TOKEN_TTL_MINUTES} minutes and can only be used once. If you did not request this, you can ignore this email.</p>
        </div>
      </div>
    `,
  });
}

export async function sendPasswordChangedEmail(env: RuntimeEnv, to: string): Promise<void> {
  await sendTransactionalEmail(env, {
    to,
    subject: "Your QuoteFly password was changed",
    text: [
      "Your QuoteFly password was changed successfully.",
      "",
      "All existing QuoteFly sessions were signed out.",
      "If you did not make this change, contact QuoteFly support immediately.",
    ].join("\n"),
    html: `
      <div style="background:#f7f4ee;padding:32px 16px;font-family:Arial,sans-serif;color:#0f172a">
        <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:20px;padding:32px">
          <p style="margin:0 0 8px;color:#2f6fd6;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase">QuoteFly account security</p>
          <h1 style="margin:0 0 16px;font-size:26px;line-height:1.2">Password changed</h1>
          <p style="margin:0 0 12px;color:#475569;line-height:1.6">Your QuoteFly password was changed successfully, and all existing sessions were signed out.</p>
          <p style="margin:0;color:#64748b;font-size:13px;line-height:1.6">If you did not make this change, contact QuoteFly support immediately.</p>
        </div>
      </div>
    `,
  });
}
