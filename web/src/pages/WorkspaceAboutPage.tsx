import { BadgeInfo, Building2, Copy, CreditCard, LifeBuoy, ShieldCheck, UserRound } from "lucide-react";
import type { AppSession } from "../lib/app-session";
import { SUPPORT_EMAIL } from "../lib/contact";
import { notify } from "../lib/notifications";
import { Badge, Button, Card, CardHeader, PageHeader } from "../components/ui";

function roleLabel(role: string) {
  const normalized = role.trim().toLowerCase();
  if (normalized === "owner") return "Owner";
  if (normalized === "admin") return "Admin";
  return "Member";
}

function supportDetails(session: AppSession) {
  return [
    "QuoteFly support details",
    `Business: ${session.tenantName}`,
    `Tenant ID: ${session.tenantId}`,
    `User: ${session.fullName}`,
    `User ID: ${session.userId}`,
    `Account email: ${session.email}`,
    `Role: ${roleLabel(session.role)}`,
    `Plan: ${session.effectivePlanName ?? "Not available"}`,
  ].join("\n");
}

async function copyText(value: string, successMessage: string) {
  try {
    await navigator.clipboard.writeText(value);
    notify.success(successMessage);
  } catch {
    notify.error("Could not copy to your clipboard", {
      description: "Select the value manually, or check this browser's clipboard permission.",
    });
  }
}

export function WorkspaceAboutPage({ session }: { session: AppSession }) {
  const supportBody = supportDetails(session);
  const supportMailto = `mailto:${SUPPORT_EMAIL}?${new URLSearchParams({
    subject: `QuoteFly support request — ${session.tenantName}`,
    body: `${supportBody}\n\nPage or feature:\nDevice and browser:\nWhat happened:\n`,
  }).toString()}`;

  return (
    <div className="space-y-5">
      <PageHeader
        title="My info"
        subtitle="Your account, business, access, and plan details in one place."
        mode="actions-only"
        actions={
          <Button icon={<LifeBuoy size={16} />} onClick={() => window.location.assign(supportMailto)}>
            Contact support
          </Button>
        }
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <Card variant="elevated" padding="lg">
          <CardHeader
            title="Business"
            subtitle="The company and isolated QuoteFly workspace tied to your account."
            actions={<span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--qf-info-surface)] text-[var(--qf-info-text)]"><Building2 size={19} /></span>}
          />
          <dl className="mt-5 space-y-4">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">Business name</dt>
              <dd className="mt-1 text-base font-semibold text-[var(--qf-text)]">{session.tenantName}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">Tenant ID</dt>
              <dd className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center">
                <code className="min-w-0 flex-1 break-all rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-3 py-3 text-sm text-[var(--qf-text)]">
                  {session.tenantId}
                </code>
                <Button variant="outline" icon={<Copy size={15} />} onClick={() => void copyText(session.tenantId, "Tenant ID copied")}>
                  Copy tenant ID
                </Button>
              </dd>
              <p className="mt-2 text-xs leading-5 text-[var(--qf-text-muted)]">Safe to include in a QuoteFly support ticket. Never send passwords, API keys, or payment details.</p>
            </div>
          </dl>
        </Card>

        <Card variant="elevated" padding="lg">
          <CardHeader
            title="Account"
            subtitle="The user identity, role, and plan currently signed in."
            actions={<span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--qf-success-surface)] text-[var(--qf-success-text)]"><UserRound size={19} /></span>}
          />
          <dl className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">Name</dt>
              <dd className="mt-1 text-sm font-semibold text-[var(--qf-text)]">{session.fullName}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">Sign-in email</dt>
              <dd className="mt-1 break-all text-sm font-semibold text-[var(--qf-text)]">{session.email}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">User ID</dt>
              <dd className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center">
                <code className="min-w-0 flex-1 break-all rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-3 py-3 text-sm text-[var(--qf-text)]">
                  {session.userId}
                </code>
                <Button variant="outline" icon={<Copy size={15} />} onClick={() => void copyText(session.userId, "User ID copied")}>
                  Copy user ID
                </Button>
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">Role</dt>
              <dd className="mt-2"><Badge tone={roleLabel(session.role) === "Member" ? "slate" : "blue"}>{roleLabel(session.role)}</Badge></dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">Plan</dt>
              <dd className="mt-1 flex items-center gap-2 text-sm font-semibold text-[var(--qf-text)]"><CreditCard size={15} className="text-[var(--qf-link)]" />{session.effectivePlanName ?? "Not available"}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">Data boundary</dt>
              <dd className="mt-1 flex items-center gap-2 text-sm font-semibold text-[var(--qf-text)]"><ShieldCheck size={15} className="text-[var(--qf-success-text)]" />Tenant scoped</dd>
            </div>
          </dl>
        </Card>
      </div>

      <Card padding="lg" className="border-[var(--qf-info-border)] bg-[var(--qf-info-surface)]">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[var(--qf-panel)] text-[var(--qf-info-text)]"><BadgeInfo size={20} /></span>
            <div>
              <h2 className="font-semibold text-[var(--qf-text)]">Support-ready info</h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-[var(--qf-text-soft)]">Copy these details into a ticket so QuoteFly can locate your account and workspace faster.</p>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button variant="outline" icon={<Copy size={15} />} onClick={() => void copyText(supportBody, "Support details copied")}>Copy support details</Button>
            <Button icon={<LifeBuoy size={15} />} onClick={() => window.location.assign(supportMailto)}>Email {SUPPORT_EMAIL}</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
