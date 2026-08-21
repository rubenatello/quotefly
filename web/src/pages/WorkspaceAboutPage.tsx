import { BadgeInfo, Building2, Copy, CreditCard, LifeBuoy, ShieldCheck, UserRound } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { AppSession } from "../lib/app-session";
import { SUPPORT_EMAIL } from "../lib/contact";
import { notify } from "../lib/notifications";
import { Badge, Button, Card, CardHeader, PageHeader } from "../components/ui";

function roleLabel(role: string, t: TFunction) {
  const normalized = role.trim().toLowerCase();
  if (normalized === "owner") return t("domain.role.owner");
  if (normalized === "admin") return t("domain.role.admin");
  return t("domain.role.member");
}

function supportDetails(session: AppSession, t: TFunction) {
  return t("myInfo.supportBody", {
    business: session.tenantName,
    tenantId: session.tenantId,
    user: session.fullName,
    userId: session.userId,
    email: session.email,
    role: roleLabel(session.role, t),
    plan: session.effectivePlanName ?? t("myInfo.unavailable"),
  });
}

async function copyText(value: string, successMessage: string, t: TFunction) {
  try {
    await navigator.clipboard.writeText(value);
    notify.success(successMessage);
  } catch {
    notify.error(t("myInfo.copyError"), {
      description: t("myInfo.copyErrorDescription"),
    });
  }
}

export function WorkspaceAboutPage({ session }: { session: AppSession }) {
  const { t } = useTranslation();
  const supportBody = supportDetails(session, t);
  const supportMailto = `mailto:${SUPPORT_EMAIL}?${new URLSearchParams({
    subject: t("myInfo.supportSubject", { business: session.tenantName }),
    body: `${supportBody}\n\n${t("myInfo.supportQuestions")}\n`,
  }).toString()}`;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("myInfo.title")}
        subtitle={t("myInfo.subtitle")}
        mode="actions-only"
        actions={
          <Button icon={<LifeBuoy size={16} />} onClick={() => window.location.assign(supportMailto)}>
            {t("myInfo.contactSupport")}
          </Button>
        }
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <Card variant="elevated" padding="lg">
          <CardHeader
            title={t("myInfo.businessTitle")}
            subtitle={t("myInfo.businessDescription")}
            actions={<span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--qf-info-surface)] text-[var(--qf-info-text)]"><Building2 size={19} /></span>}
          />
          <dl className="mt-5 space-y-4">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">{t("myInfo.businessName")}</dt>
              <dd className="mt-1 text-base font-semibold text-[var(--qf-text)]">{session.tenantName}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">{t("myInfo.tenantId")}</dt>
              <dd className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center">
                <code className="min-w-0 flex-1 break-all rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-3 py-3 text-sm text-[var(--qf-text)]">
                  {session.tenantId}
                </code>
                <Button className="min-h-[44px] sm:min-h-[44px]" variant="outline" icon={<Copy size={15} />} onClick={() => void copyText(session.tenantId, t("myInfo.tenantCopied"), t)}>
                  {t("myInfo.copyTenant")}
                </Button>
              </dd>
              <p className="mt-2 text-xs leading-5 text-[var(--qf-text-muted)]">{t("myInfo.tenantHelp")}</p>
            </div>
          </dl>
        </Card>

        <Card variant="elevated" padding="lg">
          <CardHeader
            title={t("myInfo.accountTitle")}
            subtitle={t("myInfo.accountDescription")}
            actions={<span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--qf-success-surface)] text-[var(--qf-success-text)]"><UserRound size={19} /></span>}
          />
          <dl className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">{t("myInfo.name")}</dt>
              <dd className="mt-1 text-sm font-semibold text-[var(--qf-text)]">{session.fullName}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">{t("myInfo.signInEmail")}</dt>
              <dd className="mt-1 break-all text-sm font-semibold text-[var(--qf-text)]">{session.email}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">{t("myInfo.userId")}</dt>
              <dd className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center">
                <code className="min-w-0 flex-1 break-all rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-3 py-3 text-sm text-[var(--qf-text)]">
                  {session.userId}
                </code>
                <Button variant="outline" icon={<Copy size={15} />} onClick={() => void copyText(session.userId, t("myInfo.userCopied"), t)}>
                  {t("myInfo.copyUser")}
                </Button>
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">{t("myInfo.role")}</dt>
              <dd className="mt-2"><Badge tone={session.role.toLowerCase() === "member" ? "slate" : "blue"}>{roleLabel(session.role, t)}</Badge></dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">{t("myInfo.plan")}</dt>
              <dd className="mt-1 flex items-center gap-2 text-sm font-semibold text-[var(--qf-text)]"><CreditCard size={15} className="text-[var(--qf-link)]" />{session.effectivePlanName ?? t("myInfo.unavailable")}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">{t("myInfo.dataBoundary")}</dt>
              <dd className="mt-1 flex items-center gap-2 text-sm font-semibold text-[var(--qf-text)]"><ShieldCheck size={15} className="text-[var(--qf-success-text)]" />{t("myInfo.tenantScoped")}</dd>
            </div>
          </dl>
        </Card>
      </div>

      <Card padding="lg" className="border-[var(--qf-info-border)] bg-[var(--qf-info-surface)]">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[var(--qf-panel)] text-[var(--qf-info-text)]"><BadgeInfo size={20} /></span>
            <div>
              <h2 className="font-semibold text-[var(--qf-text)]">{t("myInfo.supportReady")}</h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-[var(--qf-text-soft)]">{t("myInfo.supportDescription")}</p>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button variant="outline" icon={<Copy size={15} />} onClick={() => void copyText(supportBody, t("myInfo.detailsCopied"), t)}>{t("myInfo.copyDetails")}</Button>
            <Button icon={<LifeBuoy size={15} />} onClick={() => window.location.assign(supportMailto)}>{t("myInfo.emailSupport", { email: SUPPORT_EMAIL })}</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
