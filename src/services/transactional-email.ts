import type { env as runtimeEnv } from "../config/env";

type RuntimeEnv = typeof runtimeEnv;

type ResendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  idempotencyKey?: string;
};

type PasswordResetEmailInput = {
  to: string;
  resetUrl: string;
};

export type FeatureRequestEmailInput = {
  requestId: string;
  name: string;
  email: string;
  company?: string;
  category: "QUOTING" | "CUSTOMERS" | "MOBILE" | "REPORTING" | "INTEGRATIONS" | "OTHER";
  priority: "NICE_TO_HAVE" | "IMPORTANT" | "BLOCKING";
  title: string;
  details: string;
  source: "PUBLIC" | "WORKSPACE";
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
      ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: env.PASSWORD_RESET_EMAIL_FROM,
      to: [input.to],
      subject: input.subject,
      html: input.html,
      text: input.text,
      ...(input.replyTo ? { reply_to: input.replyTo } : {}),
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

const FEATURE_CATEGORY_LABELS: Record<FeatureRequestEmailInput["category"], string> = {
  QUOTING: "Quoting",
  CUSTOMERS: "Customers",
  MOBILE: "Mobile workflow",
  REPORTING: "Reporting and analytics",
  INTEGRATIONS: "Integrations",
  OTHER: "Other",
};

const FEATURE_PRIORITY_LABELS: Record<FeatureRequestEmailInput["priority"], string> = {
  NICE_TO_HAVE: "Nice to have",
  IMPORTANT: "Important",
  BLOCKING: "Blocking work today",
};

function emailSubjectText(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

export async function sendFeatureRequestEmail(
  env: RuntimeEnv,
  input: FeatureRequestEmailInput,
): Promise<void> {
  const category = FEATURE_CATEGORY_LABELS[input.category];
  const priority = FEATURE_PRIORITY_LABELS[input.priority];
  const company = input.company?.trim() || "Not provided";
  const safe = {
    requestId: escapeHtml(input.requestId),
    name: escapeHtml(input.name),
    email: escapeHtml(input.email),
    company: escapeHtml(company),
    category: escapeHtml(category),
    priority: escapeHtml(priority),
    title: escapeHtml(input.title),
    details: escapeHtml(input.details).replace(/\r?\n/g, "<br />"),
    source: escapeHtml(input.source === "WORKSPACE" ? "Workspace form" : "Public support page"),
  };

  await sendTransactionalEmail(env, {
    to: env.SUPPORT_EMAIL,
    replyTo: input.email,
    idempotencyKey: `feature-request-${input.requestId}`,
    subject: `[Feature request] ${emailSubjectText(input.title)}`,
    text: [
      "New QuoteFly feature request",
      "",
      `Idea: ${input.title}`,
      `Area: ${category}`,
      `Importance: ${priority}`,
      `Submitted from: ${input.source === "WORKSPACE" ? "Workspace form" : "Public support page"}`,
      "",
      input.details,
      "",
      `Name: ${input.name}`,
      `Email: ${input.email}`,
      `Company: ${company}`,
      `Request ID: ${input.requestId}`,
    ].join("\n"),
    html: `
      <div style="background:#f7f4ee;padding:32px 16px;font-family:Arial,sans-serif;color:#0f172a">
        <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:20px;padding:32px">
          <p style="margin:0 0 8px;color:#2f6fd6;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase">QuoteFly product feedback</p>
          <h1 style="margin:0 0 20px;font-size:26px;line-height:1.25">${safe.title}</h1>
          <div style="margin:0 0 24px;padding:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px">
            <p style="margin:0 0 8px"><strong>Area:</strong> ${safe.category}</p>
            <p style="margin:0 0 8px"><strong>Importance:</strong> ${safe.priority}</p>
            <p style="margin:0"><strong>Source:</strong> ${safe.source}</p>
          </div>
          <p style="margin:0 0 8px;font-weight:700">How this would help</p>
          <p style="margin:0 0 24px;color:#475569;line-height:1.65">${safe.details}</p>
          <div style="border-top:1px solid #e2e8f0;padding-top:18px;color:#475569;font-size:14px;line-height:1.6">
            <p style="margin:0"><strong>${safe.name}</strong> · ${safe.company}</p>
            <p style="margin:0"><a href="mailto:${safe.email}" style="color:#2f6fd6">${safe.email}</a></p>
            <p style="margin:8px 0 0;color:#94a3b8;font-size:12px">Request ID: ${safe.requestId}</p>
          </div>
        </div>
      </div>
    `,
  });
}
