import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ChevronDown, Search } from "lucide-react";
import { CallIcon, ClockIcon, CustomerIcon, EmailIcon, QuoteIcon } from "../components/Icons";
import { ActivityTaskPanel, type ActivityTaskDraft } from "../components/activity/ActivityTaskPanel";
import { Alert, Badge, Button, Card, EmptyState, Input, LoadingState, PageHeader, PaginationControls, Select, type PageSize } from "../components/ui";
import { FollowUpPill, QuoteStatusPill } from "../components/dashboard/DashboardUi";
import { formatDateTime, useDashboard, money } from "../components/dashboard/DashboardContext";
import { api, type AfterSaleFollowUpStatus, type JobStatus, type LeadFollowUpStatus, type WorkspaceFollowUpItem } from "../lib/api";
import { usePageView } from "../lib/analytics";
import { resolveActivityTiming } from "../lib/display-format";
import { validTimeZone } from "../lib/tenant-time";

type PipelineLead = WorkspaceFollowUpItem;
type QueueTab = "new" | "quoted" | "closed" | "afterSale" | "recent";
type ActivitySurface = "mine" | "team" | "leads";

const FOLLOW_UP_STATUSES: LeadFollowUpStatus[] = ["NEEDS_FOLLOW_UP", "FOLLOWED_UP", "WON"];
const AFTER_SALE_STATUSES: AfterSaleFollowUpStatus[] = ["NOT_READY", "DUE", "COMPLETED"];

const ACTIVITY_TYPE_VALUES = new Set(["FOLLOW_UP", "PREPARE_QUOTE", "SEND_QUOTE", "CHECK_IN", "CUSTOM"]);
const ACTIVITY_PRIORITY_VALUES = new Set(["LOW", "NORMAL", "HIGH", "URGENT"]);

function getRouteString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseKodyActivityDraftState(state: unknown): ActivityTaskDraft | null {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const draft = (state as { kodyActivityDraft?: unknown }).kodyActivityDraft;
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) return null;
  const record = draft as Record<string, unknown>;
  const customerId = getRouteString(record.customerId);
  const customerName = getRouteString(record.customerName);
  const type = getRouteString(record.type);
  const priority = getRouteString(record.priority);
  const title = getRouteString(record.title);
  const dueAtUtc = getRouteString(record.dueAtUtc);
  if (!customerId || !customerName || !type || !priority || !title || !dueAtUtc) return null;
  if (!ACTIVITY_TYPE_VALUES.has(type) || !ACTIVITY_PRIORITY_VALUES.has(priority)) return null;
  if (Number.isNaN(new Date(dueAtUtc).getTime())) return null;
  return {
    customerId,
    customerName,
    quoteId: getRouteString(record.quoteId),
    quoteTitle: getRouteString(record.quoteTitle),
    type: type as ActivityTaskDraft["type"],
    priority: priority as ActivityTaskDraft["priority"],
    title,
    dueAtUtc,
  };
}

function followUpLabel(status: LeadFollowUpStatus, t: TFunction): string {
  if (status === "NEEDS_FOLLOW_UP") return t("activity.status.needsFollowUp");
  if (status === "FOLLOWED_UP") return t("activity.status.followedUp");
  if (status === "WON") return t("activity.status.won");
  return t("activity.status.lost");
}

function jobStatusLabel(status: JobStatus, t: TFunction): string {
  return t(`domain.jobStatus.${status}`);
}

function jobStatusTone(status: JobStatus): "slate" | "blue" | "emerald" | "amber" {
  if (status === "COMPLETED") return "emerald";
  if (status === "SCHEDULED" || status === "IN_PROGRESS") return "blue";
  if (status === "DISPATCHED") return "amber";
  return "slate";
}

function afterSaleLabel(status: AfterSaleFollowUpStatus, t: TFunction): string {
  if (status === "NOT_READY") return t("activity.status.notReady");
  if (status === "DUE") return t("activity.status.due");
  return t("activity.status.completed");
}

function customerInitials(fullName: string) {
  return fullName
    .split(" ")
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function tenantDateKey(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: validTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function compactDateTime(value: string, t: TFunction, locale: string, timeZone: string) {
  const date = new Date(value);
  const today = new Date();
  if (Number.isNaN(date.getTime())) return t("home.time.recently");
  const resolvedTimeZone = validTimeZone(timeZone);
  const sameDay = tenantDateKey(date, resolvedTimeZone) === tenantDateKey(today, resolvedTimeZone);
  if (sameDay) {
    return t("activity.todayAt", {
      time: new Intl.DateTimeFormat(locale, {
        timeZone: resolvedTimeZone,
        hour: "numeric",
        minute: "2-digit",
      }).format(date),
    });
  }
  return new Intl.DateTimeFormat(locale, {
    timeZone: resolvedTimeZone,
    month: "short",
    day: "numeric",
  }).format(date);
}

function nextActionLabel(lead: PipelineLead, actionKind: QueueActionKind, t: TFunction) {
  if (actionKind === "job") return lead.job
    ? t("activity.action.openJobNumber", { number: lead.job.jobNumber })
    : t("activity.action.jobUnavailable");
  if (actionKind === "after_sale") return t("activity.action.askReview");
  if (!lead.quoteId) return t("activity.action.draftFirst");
  return t("activity.action.followUp");
}

function sectionToneBadge(tone: "blue" | "orange" | "emerald" | "slate") {
  return tone === "orange" ? "orange" : tone === "emerald" ? "emerald" : tone === "slate" ? "slate" : "blue";
}

type QueueActionKind = "follow_up" | "job" | "after_sale" | "none";

type QueueConfig = {
  key: QueueTab;
  label: string;
  title: string;
  subtitle: string;
  count: number;
  actionKind: QueueActionKind;
  tone: "blue" | "orange" | "emerald" | "slate";
  emptyTitle: string;
  emptyDescription: string;
};

function LifecyclePill({ label, tone }: { label: string; tone: "slate" | "blue" | "emerald" | "amber" }) {
  const toneClass =
    tone === "blue"
      ? "border-[var(--qf-info-border)] bg-[var(--qf-info-surface)] text-[var(--qf-info-text)]"
      : tone === "emerald"
        ? "border-[var(--qf-success-border)] bg-[var(--qf-success-surface)] text-[var(--qf-success-text)]"
        : tone === "amber"
          ? "border-[var(--qf-warning-border)] bg-[var(--qf-warning-surface)] text-[var(--qf-warning-text)]"
          : "border-[var(--qf-border)] bg-[var(--qf-panel-muted)] text-[var(--qf-text-soft)]";

  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${toneClass}`}>{label}</span>;
}

function MetricTile({
  label,
  value,
  tone,
  currency = false,
}: {
  label: string;
  value: number | string;
  tone: "blue" | "orange" | "emerald" | "slate";
  currency?: boolean;
}) {
  const toneClass =
    tone === "blue"
      ? "bg-[var(--qf-action-primary)] text-[var(--qf-action-primary-text)]"
      : tone === "orange"
        ? "bg-[var(--qf-action-secondary)] text-[var(--qf-action-secondary-text)]"
      : tone === "emerald"
          ? "bg-[var(--qf-success-strong)] text-white"
          : "bg-slate-800 text-white";

  return (
    <div data-testid="follow-up-metric" className={`min-w-0 rounded-xl px-3 py-3 sm:px-4 ${toneClass}`}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em]">{label}</p>
      <p className="mt-2 truncate text-xl font-bold tracking-tight sm:text-2xl">{currency && typeof value === "number" ? money(value) : value}</p>
    </div>
  );
}

function UtilityRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-3 py-3">
      <div className="inline-flex items-center gap-2 text-sm text-[var(--qf-text-soft)]">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--qf-panel-muted)] text-[var(--qf-link)]">{icon}</span>
        <span>{label}</span>
      </div>
      <span className="text-sm font-semibold text-[var(--qf-text)]">{value}</span>
    </div>
  );
}

function QueueTabs({
  tabs,
  activeTab,
  onChange,
}: {
  tabs: QueueConfig[];
  activeTab: QueueTab;
  onChange: (tab: QueueTab) => void;
}) {
  return (
    <div data-testid="follow-up-queue-tabs" className="grid w-full grid-cols-3 gap-2 sm:flex sm:flex-wrap">
      {tabs.map((tab) => {
        const active = tab.key === activeTab;
        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => onChange(tab.key)}
            className={`inline-flex min-h-[44px] min-w-0 items-center justify-center gap-1.5 rounded-xl border px-1.5 py-2 text-[11px] font-medium transition sm:min-h-[36px] sm:flex-none sm:rounded-full sm:px-3 sm:py-1.5 sm:text-sm ${
              active
                ? "border-[var(--qf-info-border)] bg-[var(--qf-selected)] text-[var(--qf-link)]"
                : "border-[var(--qf-border)] bg-[var(--qf-panel)] text-[var(--qf-text-soft)] hover:border-[var(--qf-border-strong)] hover:bg-[var(--qf-interactive-hover)]"
            }`}
            aria-pressed={active}
          >
            <span className="truncate">{tab.label}</span>
            <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold sm:px-2 sm:text-[11px] ${active ? "bg-[var(--qf-panel)] text-[var(--qf-link)]" : "bg-[var(--qf-panel-muted)] text-[var(--qf-text-muted)]"}`}>
              {tab.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function QueueActions({
  lead,
  actionKind,
  saving,
  mobile = false,
  onNavigateToQuote,
  onNavigateToBuilder,
  onNavigateToJob,
  onUpdateFollowUp,
  onUpdateQuoteLifecycle,
  includePrimary = true,
}: {
  lead: PipelineLead;
  actionKind: QueueActionKind;
  saving: boolean;
  mobile?: boolean;
  onNavigateToQuote: (quoteId: string) => void;
  onNavigateToBuilder: (customerId: string) => void;
  onNavigateToJob: (jobId: string) => void;
  onUpdateFollowUp?: (customerId: string, followUpStatus: LeadFollowUpStatus) => void;
  onUpdateQuoteLifecycle?: (
    quoteId: string,
    patch: { afterSaleFollowUpStatus: AfterSaleFollowUpStatus },
  ) => void;
  includePrimary?: boolean;
}) {
  const { t } = useTranslation();
  const selectClassName = mobile ? "min-w-0 w-full" : "w-full min-w-[150px] sm:w-auto";
  const followUpOptions = FOLLOW_UP_STATUSES.map((status) => ({ value: status, label: followUpLabel(status, t) }));
  const afterSaleOptions = AFTER_SALE_STATUSES.map((status) => ({ value: status, label: afterSaleLabel(status, t) }));
  const job = actionKind === "job" ? lead.job : undefined;
  const lostWithoutQuote = lead.followUpStatus === "LOST" && !lead.quoteId;

  return (
    <div className={mobile ? "grid grid-cols-1 gap-2 min-[420px]:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]" : "mt-2 flex flex-col gap-2 sm:flex-row sm:items-center xl:mt-0 xl:flex-col xl:items-end"}>
      {includePrimary ? (
        <Button
          size="sm"
          variant={job ? "primary" : lead.quoteId ? "outline" : "primary"}
          className="min-h-11 w-full sm:w-auto"
          disabled={(actionKind === "job" && !lead.job) || lostWithoutQuote}
          title={lostWithoutQuote ? t("customers.lifecycle.reopenBeforeQuote") : undefined}
          aria-label={job
            ? t("activity.openJobLabel", { number: job.jobNumber })
            : undefined}
          onClick={() => job
            ? onNavigateToJob(job.id)
            : lead.quoteId
              ? onNavigateToQuote(lead.quoteId)
              : onNavigateToBuilder(lead.customerId)}
        >
          {job ? t("activity.openJob") : actionKind === "job" ? t("activity.jobUnavailable") : lead.quoteId ? t("activity.openQuote") : t("activity.draftQuote")}
        </Button>
      ) : null}

      {actionKind === "follow_up" ? (
        lead.followUpStatus === "LOST" ? (
          <p className="max-w-[220px] text-xs font-medium leading-5 text-[var(--qf-danger-strong)]">
            {t("customers.lifecycle.reopenBeforeStatusChange")}
          </p>
        ) : (
          <Select
            aria-label={t("activity.updateFollowUp", { name: lead.customerName })}
            value={lead.followUpStatus}
            disabled={saving}
            onChange={(event) => onUpdateFollowUp?.(lead.customerId, event.target.value as LeadFollowUpStatus)}
            options={followUpOptions}
            className={selectClassName}
          />
        )
      ) : actionKind === "after_sale" ? (
        <Select
          aria-label={t("activity.updateAfterSale", { name: lead.customerName })}
          value={lead.afterSaleFollowUpStatus ?? "DUE"}
          disabled={saving || !lead.quoteId}
          onChange={(event) =>
            lead.quoteId && onUpdateQuoteLifecycle?.(lead.quoteId, { afterSaleFollowUpStatus: event.target.value as AfterSaleFollowUpStatus })
          }
          options={afterSaleOptions}
          className={selectClassName}
        />
      ) : null}
    </div>
  );
}

function QueueRow({
  lead,
  index,
  actionKind,
  saving,
  activeQuoteId,
  onNavigateToQuote,
  onNavigateToBuilder,
  onNavigateToJob,
  onUpdateFollowUp,
  onUpdateQuoteLifecycle,
}: {
  lead: PipelineLead;
  index: number;
  actionKind: QueueActionKind;
  saving: boolean;
  activeQuoteId?: string | null;
  onNavigateToQuote: (quoteId: string) => void;
  onNavigateToBuilder: (customerId: string) => void;
  onNavigateToJob: (jobId: string) => void;
  onUpdateFollowUp?: (customerId: string, followUpStatus: LeadFollowUpStatus) => void;
  onUpdateQuoteLifecycle?: (
    quoteId: string,
    patch: { afterSaleFollowUpStatus: AfterSaleFollowUpStatus },
  ) => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en-US";
  const { session } = useDashboard();
  const timeZone = session?.timezone ?? "UTC";
  const { kind: activityKind, atUtc: activityAtUtc } = resolveActivityTiming(lead);
  const timingLabel = lead.afterSaleFollowUpDueAtUtc
    ? t("activity.dueAt", { date: compactDateTime(lead.afterSaleFollowUpDueAtUtc, t, locale, timeZone) })
    : t(activityKind === "ADDED" ? "activity.addedAt" : "activity.updatedAt", { date: compactDateTime(activityAtUtc, t, locale, timeZone) });
  const lostWithoutQuote = lead.followUpStatus === "LOST" && !lead.quoteId;
  const renderStatusPills = () => (
    <>
      <FollowUpPill status={lead.followUpStatus} compact />
      {lead.status ? <QuoteStatusPill status={lead.status} compact /> : <LifecyclePill label={t("activity.noQuotePill")} tone="slate" />}
      {actionKind === "job" && lead.job ? (
        <LifecyclePill label={jobStatusLabel(lead.job.status, t)} tone={jobStatusTone(lead.job.status)} />
      ) : null}
      {actionKind === "after_sale" && lead.afterSaleFollowUpStatus ? (
        <LifecyclePill label={afterSaleLabel(lead.afterSaleFollowUpStatus, t)} tone={lead.afterSaleFollowUpStatus === "COMPLETED" ? "emerald" : "amber"} />
      ) : null}
    </>
  );

  return (
    <article data-testid="follow-up-queue-row" className={`transition hover:bg-[var(--qf-interactive-hover)] ${lead.quoteId && lead.quoteId === activeQuoteId ? "bg-[var(--qf-selected)]" : ""}`}>
      <div className="p-3.5 2xl:hidden">
        <div className="flex min-w-0 items-start gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--qf-panel-muted)] text-sm font-semibold text-[var(--qf-text-soft)]">
            {customerInitials(lead.customerName)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <p className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--qf-text)]">{lead.customerName}</p>
              <span className="shrink-0 rounded-full bg-[var(--qf-panel-muted)] px-2 py-0.5 text-[10px] font-semibold text-[var(--qf-text-muted)]">#{index + 1}</span>
            </div>
            <p className="mt-1 truncate text-xs text-[var(--qf-text-muted)]">
              {lead.quoteTitle ?? nextActionLabel(lead, actionKind, t)}
            </p>
            <p className="mt-1 text-[11px] font-medium text-[var(--qf-text-soft)] sm:hidden">{timingLabel}</p>
            {actionKind === "job" && lead.job ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-semibold text-[var(--qf-text-soft)]">
                  {t("activity.jobNumber", { number: lead.job.jobNumber })}
                </span>
                <LifecyclePill label={jobStatusLabel(lead.job.status, t)} tone={jobStatusTone(lead.job.status)} />
              </div>
            ) : null}
          </div>
          <span className="hidden shrink-0 text-right text-xs font-medium text-[var(--qf-text-soft)] sm:block">{timingLabel}</span>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <a
            href={`tel:${lead.phone}`}
            aria-label={t("activity.call", { name: lead.customerName })}
            title={t("activity.call", { name: lead.phone })}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] text-[var(--qf-text-soft)] hover:border-[var(--qf-border-strong)] hover:text-[var(--qf-link)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]"
          >
            <CallIcon size={15} />
          </a>
          {lead.email ? (
            <a
              href={`mailto:${lead.email}`}
              aria-label={t("activity.email", { name: lead.customerName })}
              title={t("activity.email", { name: lead.email })}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] text-[var(--qf-text-soft)] hover:border-[var(--qf-border-strong)] hover:text-[var(--qf-link)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]"
            >
              <EmailIcon size={15} />
            </a>
          ) : null}
          <Button
            size="sm"
            variant={actionKind === "job" && lead.job ? "primary" : lead.quoteId ? "outline" : "primary"}
            className="min-h-11 min-w-0 flex-1"
            disabled={(actionKind === "job" && !lead.job) || lostWithoutQuote}
            title={lostWithoutQuote ? t("customers.lifecycle.reopenBeforeQuote") : undefined}
            aria-label={actionKind === "job" && lead.job
              ? t("activity.openJobLabel", { number: lead.job.jobNumber })
              : actionKind === "job"
                ? t("activity.jobUnavailable")
              : lead.quoteId
                ? t("activity.openQuote")
                : t("activity.action.draftFirst")}
            onClick={() => actionKind === "job" && lead.job
              ? onNavigateToJob(lead.job.id)
              : lead.quoteId
                ? onNavigateToQuote(lead.quoteId)
                : onNavigateToBuilder(lead.customerId)}
          >
            {actionKind === "job"
              ? lead.job ? t("activity.openJob") : t("activity.jobUnavailable")
              : lead.quoteId
                ? `${t("activity.openQuote")}${lead.totalAmount !== undefined ? ` · ${money(lead.totalAmount)}` : ""}`
                : t("activity.action.draftFirst")}
          </Button>
        </div>

        <details className="group mt-2 rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)]">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-3 text-xs font-semibold text-[var(--qf-text-soft)] marker:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]">
            <span>{t("activity.detailsStatus")}</span>
            <ChevronDown size={16} className="motion-safe:transition-transform motion-safe:group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="border-t border-[var(--qf-border)] p-3">
            <div className="mb-3 flex flex-wrap items-center gap-2">{renderStatusPills()}</div>
            <QueueActions
              lead={lead}
              actionKind={actionKind}
              saving={saving}
              mobile
              includePrimary={false}
              onNavigateToQuote={onNavigateToQuote}
              onNavigateToBuilder={onNavigateToBuilder}
              onNavigateToJob={onNavigateToJob}
              onUpdateFollowUp={onUpdateFollowUp}
              onUpdateQuoteLifecycle={onUpdateQuoteLifecycle}
            />
          </div>
        </details>
      </div>

      <div className="hidden gap-3 px-4 py-3 2xl:grid 2xl:grid-cols-[minmax(0,2.1fr)_minmax(0,1fr)_190px_140px_160px] 2xl:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-[var(--qf-panel-muted)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--qf-text-muted)]">{index + 1}</span>
            <span className="text-xs text-[var(--qf-text-muted)]">{t("activity.created", { date: formatDateTime(lead.createdAt, locale, timeZone) })}</span>
          </div>
          <div className="mt-1.5 flex items-start gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--qf-panel-muted)] text-sm font-semibold text-[var(--qf-text-soft)]">{customerInitials(lead.customerName)}</span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-[var(--qf-text)]">{lead.customerName}</p>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--qf-text-soft)]">
                <span className="inline-flex items-center gap-1"><CallIcon size={12} />{lead.phone}</span>
                {lead.email ? <span className="inline-flex items-center gap-1"><EmailIcon size={12} />{lead.email}</span> : null}
              </div>
            </div>
          </div>
        </div>

        <div className="min-w-0">
          {lead.quoteTitle ? (
            <>
              <p className="truncate text-sm font-medium text-[var(--qf-text)]">{lead.quoteTitle}</p>
              <p className="mt-1 text-xs text-[var(--qf-text-muted)]">{lead.totalAmount !== undefined ? money(lead.totalAmount) : t("activity.noTotal")}</p>
            </>
          ) : (
            <p className="text-sm text-[var(--qf-text-muted)]">{t("activity.noQuote")}</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">{renderStatusPills()}</div>

        <div className="space-y-1 text-xs text-[var(--qf-text-muted)]">
          <p>{timingLabel}</p>
          <p className="font-medium text-[var(--qf-text-soft)]">{nextActionLabel(lead, actionKind, t)}</p>
        </div>

        <QueueActions
          lead={lead}
          actionKind={actionKind}
          saving={saving}
          onNavigateToQuote={onNavigateToQuote}
          onNavigateToBuilder={onNavigateToBuilder}
          onNavigateToJob={onNavigateToJob}
          onUpdateFollowUp={onUpdateFollowUp}
          onUpdateQuoteLifecycle={onUpdateQuoteLifecycle}
        />
      </div>
    </article>
  );
}

export function PipelineView() {
  usePageView("pipeline");
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const {
    session,
    saving,
    error,
    notice,
    setError,
    setNotice,
    updateLeadFollowUpStatus,
    updateQuoteLifecycle,
    navigateToQuote,
    navigateToBuilder,
    selectedQuoteId,
  } = useDashboard();
  const canManageAssignments = session?.role === "owner" || session?.role === "admin";
  const kodyActivityDraft = useMemo(() => parseKodyActivityDraftState(location.state), [location.state]);
  const [activitySurface, setActivitySurface] = useState<ActivitySurface>("mine");
  const [activeTab, setActiveTab] = useState<QueueTab>("new");
  const [queueItems, setQueueItems] = useState<PipelineLead[]>([]);
  const [recentLeads, setRecentLeads] = useState<PipelineLead[]>([]);
  const [queueSearch, setQueueSearch] = useState("");
  const [debouncedQueueSearch, setDebouncedQueueSearch] = useState("");
  const [queuePage, setQueuePage] = useState(1);
  const [queuePageSize, setQueuePageSize] = useState<PageSize>(25);
  const [queueTotal, setQueueTotal] = useState(0);
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueLoadError, setQueueLoadError] = useState<string | null>(null);
  const [queueTotals, setQueueTotals] = useState({ newLeads: 0, quotedLeads: 0, closedLeads: 0, afterSaleLeads: 0, recentLeads: 0 });
  const [queueMetrics, setQueueMetrics] = useState({ acceptedRevenue: 0, monthlyQuotes: 0 });
  const queueRequestIdRef = useRef(0);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedQueueSearch(queueSearch.trim());
      setQueuePage(1);
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [queueSearch]);

  const loadQueuePage = useCallback(async () => {
    const requestId = ++queueRequestIdRef.current;
    setQueueLoading(true);
    setQueueLoadError(null);
    try {
      const [result, recentResult] = await Promise.all([
        api.workspace.followUp({
          queue: activeTab,
          search: debouncedQueueSearch || undefined,
          limit: queuePageSize,
          offset: (queuePage - 1) * queuePageSize,
        }),
        activeTab === "recent" && !debouncedQueueSearch
          ? Promise.resolve(null)
          : api.workspace.followUp({ queue: "recent", limit: 4 }),
      ]);
      if (requestId !== queueRequestIdRef.current) return;
      setQueueItems(result.items);
      setQueueTotal(result.pagination.total);
      setQueueTotals(result.totals);
      setQueueMetrics(result.metrics);
      setRecentLeads(recentResult?.items ?? (activeTab === "recent" ? result.items.slice(0, 4) : []));
    } catch {
      if (requestId !== queueRequestIdRef.current) return;
      setQueueLoadError(t("activity.unavailableDescription"));
    } finally {
      if (requestId === queueRequestIdRef.current) setQueueLoading(false);
    }
  }, [activeTab, debouncedQueueSearch, queuePage, queuePageSize, t]);

  useEffect(() => {
    void loadQueuePage();
  }, [loadQueuePage]);

  useEffect(() => {
    if (kodyActivityDraft) setActivitySurface("mine");
  }, [kodyActivityDraft]);

  const nextAttentionCount = queueTotals.newLeads + queueTotals.quotedLeads;
  const activeCustomerCount =
    queueTotals.newLeads +
    queueTotals.quotedLeads +
    queueTotals.closedLeads +
    queueTotals.afterSaleLeads;

  const queueTabs = useMemo<QueueConfig[]>(() => [
    {
      key: "new",
      label: t("activity.tabs.new"),
      title: t("activity.tabs.newTitle", { count: queueTotals.newLeads }),
      subtitle: t("activity.tabs.newSubtitle"),
      count: queueTotals.newLeads,
      actionKind: "follow_up",
      tone: "blue",
      emptyTitle: t("activity.empty.newTitle"),
      emptyDescription: t("activity.empty.newDescription"),
    },
    {
      key: "quoted",
      label: t("activity.tabs.quoted"),
      title: t("activity.tabs.quotedTitle", { count: queueTotals.quotedLeads }),
      subtitle: t("activity.tabs.quotedSubtitle"),
      count: queueTotals.quotedLeads,
      actionKind: "follow_up",
      tone: "orange",
      emptyTitle: t("activity.empty.quotedTitle"),
      emptyDescription: t("activity.empty.quotedDescription"),
    },
    {
      key: "closed",
      label: t("activity.tabs.closed"),
      title: t("activity.tabs.closedTitle", { count: queueTotals.closedLeads }),
      subtitle: t("activity.tabs.closedSubtitle"),
      count: queueTotals.closedLeads,
      actionKind: "job",
      tone: "emerald",
      emptyTitle: t("activity.empty.closedTitle"),
      emptyDescription: t("activity.empty.closedDescription"),
    },
    {
      key: "afterSale",
      label: t("activity.tabs.postJob"),
      title: t("activity.tabs.postJobTitle", { count: queueTotals.afterSaleLeads }),
      subtitle: t("activity.tabs.postJobSubtitle"),
      count: queueTotals.afterSaleLeads,
      actionKind: "after_sale",
      tone: "slate",
      emptyTitle: t("activity.empty.postJobTitle"),
      emptyDescription: t("activity.empty.postJobDescription"),
    },
    {
      key: "recent",
      label: t("activity.tabs.recent"),
      title: t("activity.tabs.recentTitle", { count: queueTotals.recentLeads }),
      subtitle: t("activity.tabs.recentSubtitle"),
      count: queueTotals.recentLeads,
      actionKind: "follow_up",
      tone: "blue",
      emptyTitle: t("activity.empty.recentTitle"),
      emptyDescription: t("activity.empty.recentDescription"),
    },
  ], [queueTotals, t]);

  const activeQueue = queueTabs.find((tab) => tab.key === activeTab) ?? queueTabs[0];
  const totalQueuePages = Math.max(1, Math.ceil(queueTotal / queuePageSize));

  useEffect(() => {
    if (queuePage > totalQueuePages) setQueuePage(totalQueuePages);
  }, [queuePage, totalQueuePages]);

  async function updateFollowUp(customerId: string, followUpStatus: LeadFollowUpStatus) {
    await updateLeadFollowUpStatus(customerId, followUpStatus);
    await loadQueuePage();
  }

  async function updateLifecycle(
    quoteId: string,
    patch: { afterSaleFollowUpStatus: AfterSaleFollowUpStatus },
  ) {
    await updateQuoteLifecycle(quoteId, patch);
    await loadQueuePage();
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("activity.title")}
        subtitle={t("activity.subtitle")}
        mode="actions-only"
        actions={selectedQuoteId ? <Button onClick={() => navigateToQuote(selectedQuoteId)}>{t("activity.openActiveQuote")}</Button> : undefined}
      />

      {error && <Alert tone="error" onDismiss={() => setError(null)}>{t("activity.actionError")}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{t("activity.actionSaved")}</Alert>}

      <div
        role="group"
        aria-label={t("activity.views")}
        className={`grid gap-2 rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] p-1.5 shadow-[var(--qf-shadow-sm)] ${canManageAssignments ? "grid-cols-3" : "grid-cols-2"}`}
      >
        {([
          { key: "mine", label: t("activity.myWork") },
          ...(canManageAssignments ? [{ key: "team", label: t("activity.team") } as const] : []),
          { key: "leads", label: t("activity.leadQueue") },
        ] as Array<{ key: ActivitySurface; label: string }>).map((surface) => (
          <button
            key={surface.key}
            type="button"
            aria-pressed={activitySurface === surface.key}
            onClick={() => setActivitySurface(surface.key)}
            className={`min-h-11 rounded-lg px-3 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] ${activitySurface === surface.key ? "bg-[var(--qf-selected)] text-[var(--qf-link)]" : "text-[var(--qf-text-soft)] hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)]"}`}
          >
            {surface.label}
          </button>
        ))}
      </div>

      {activitySurface !== "leads" ? (
        <ActivityTaskPanel
          mine={activitySurface === "mine"}
          canManage={canManageAssignments}
          currentUserId={session?.userId ?? ""}
          timezone={session?.timezone ?? "UTC"}
          navigateToQuote={navigateToQuote}
          initialTaskId={(location.state as { activityTaskId?: string } | null)?.activityTaskId}
          initialDraft={kodyActivityDraft}
        />
      ) : <div className="grid min-w-0 gap-4 2xl:grid-cols-[minmax(0,1.45fr)_320px]">
        <div className="space-y-4">
          <div data-testid="follow-up-metrics" className="grid grid-cols-2 gap-2.5 sm:gap-3 xl:grid-cols-4">
            <MetricTile label={t("activity.metrics.attention")} value={queueLoading ? "—" : nextAttentionCount} tone="orange" />
            <MetricTile label={t("activity.metrics.newLeads")} value={queueLoading ? "—" : queueTotals.newLeads} tone="blue" />
            <MetricTile label={t("activity.metrics.activeWork")} value={queueLoading ? "—" : queueTotals.closedLeads} tone="emerald" />
            <MetricTile label={t("activity.metrics.revenue")} value={queueLoading ? "—" : queueMetrics.acceptedRevenue} tone="slate" currency />
          </div>

          <Card variant="default" padding="md" className="overflow-hidden p-0 sm:p-5">
            <div className="flex flex-col gap-3 border-b border-[var(--qf-border)] p-4 sm:mb-4 sm:p-0 sm:pb-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("activity.queue")}</p>
                <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-[var(--qf-text)]">{activeQueue.title}</h2>
                <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{activeQueue.subtitle}</p>
              </div>
              <div className="min-w-0 max-w-full space-y-3 lg:w-auto">
                <Input
                  aria-label={t("activity.searchLabel")}
                  icon={<Search size={16} aria-hidden="true" />}
                  value={queueSearch}
                  onChange={(event) => setQueueSearch(event.target.value)}
                  placeholder={t("activity.searchPlaceholder")}
                />
                <QueueTabs
                  tabs={queueTabs}
                  activeTab={activeTab}
                  onChange={(tab) => {
                    setActiveTab(tab);
                    setQueuePage(1);
                  }}
                />
              </div>
            </div>

            <div data-testid="follow-up-queue" className="overflow-hidden bg-[var(--qf-panel)] sm:rounded-xl sm:border sm:border-[var(--qf-border)]">
              {queueLoading ? (
                <div className="p-4">
                  <LoadingState
                    title={t("activity.loadingTitle")}
                    description={t("activity.loadingDescription")}
                    variant="cards"
                    rows={5}
                  />
                </div>
              ) : queueLoadError ? (
                <div className="p-4">
                  <EmptyState
                    title={t("activity.unavailableTitle")}
                    description={`${queueLoadError} ${t("activity.unchanged")}`}
                    action={<Button variant="outline" onClick={() => void loadQueuePage()}>{t("home.tryAgain")}</Button>}
                  />
                </div>
              ) : queueItems.length === 0 ? (
                <div className="p-4">
                  <EmptyState
                    title={debouncedQueueSearch ? t("activity.noMatches") : activeQueue.emptyTitle}
                    description={debouncedQueueSearch ? t("activity.noMatchesDescription", { search: debouncedQueueSearch }) : activeQueue.emptyDescription}
                  />
                </div>
              ) : (
                <>
                  <div className="hidden grid-cols-[minmax(0,2.1fr)_minmax(0,1fr)_190px_140px_160px] gap-4 border-b border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--qf-text-muted)] 2xl:grid">
                    <span>{t("activity.columns.lead")}</span>
                    <span>{t("activity.columns.quote")}</span>
                    <span>{t("activity.columns.status")}</span>
                    <span>{t("activity.columns.due")}</span>
                    <span>{t("activity.columns.action")}</span>
                  </div>
                  <div className="divide-y divide-[var(--qf-border)]">
                    {queueItems.map((lead, index) => (
                      <QueueRow
                        key={`${lead.customerId}-${lead.quoteId ?? "row"}`}
                        lead={lead}
                        index={(queuePage - 1) * queuePageSize + index}
                        actionKind={activeQueue.actionKind}
                        saving={saving}
                        activeQuoteId={selectedQuoteId}
                        onNavigateToQuote={navigateToQuote}
                        onNavigateToBuilder={navigateToBuilder}
                        onNavigateToJob={(jobId) => navigate(`/app/jobs/${jobId}`)}
                        onUpdateFollowUp={(customerId, followUpStatus) => void updateFollowUp(customerId, followUpStatus)}
                        onUpdateQuoteLifecycle={(quoteId, patch) => void updateLifecycle(quoteId, patch)}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
            <div className="mt-4 px-4 pb-4 sm:px-0 sm:pb-0">
              <PaginationControls
                limit={queuePageSize}
                offset={(queuePage - 1) * queuePageSize}
                total={queueTotal}
                loading={queueLoading}
                itemLabel={t("activity.records")}
                onLimitChange={(nextLimit) => {
                  setQueuePageSize(nextLimit);
                  setQueuePage(1);
                }}
                onOffsetChange={(nextOffset) => setQueuePage(Math.floor(nextOffset / queuePageSize) + 1)}
              />
            </div>
          </Card>
        </div>

        <div className="hidden space-y-4 2xl:block">
          <Card variant="default" padding="md">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("activity.focus")}</p>
                <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{t("activity.focusDescription")}</p>
              </div>
              <Badge tone={sectionToneBadge(activeQueue.tone)}>{t("activity.activeCount", { count: activeQueue.count })}</Badge>
            </div>
            <div className="mt-3 space-y-2.5">
              <UtilityRow icon={<ClockIcon size={14} />} label={t("activity.needsTouch")} value={String(nextAttentionCount)} />
              <UtilityRow icon={<CustomerIcon size={14} />} label={t("activity.activeCustomers")} value={String(activeCustomerCount)} />
              <UtilityRow icon={<QuoteIcon size={14} />} label={t("activity.quotesThisMonth")} value={String(queueMetrics.monthlyQuotes)} />
            </div>
            <div className="mt-4 grid gap-2">
              <Button fullWidth variant="outline" onClick={() => navigateToBuilder()}>
                {t("activity.startQuote")}
              </Button>
              {selectedQuoteId ? (
                <Button fullWidth onClick={() => navigateToQuote(selectedQuoteId)}>
                  {t("activity.openActiveQuote")}
                </Button>
              ) : null}
            </div>
          </Card>

          <Card variant="default" padding="md">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("activity.recentLeads")}</p>
            <div className="mt-3 space-y-2.5">
              {recentLeads.length > 0 ? (
                recentLeads.map((lead) => (
                  <button
                    key={`${lead.customerId}-${lead.quoteId ?? "recent"}`}
                    type="button"
                    onClick={() => (lead.quoteId ? navigateToQuote(lead.quoteId) : navigateToBuilder(lead.customerId))}
                    disabled={lead.followUpStatus === "LOST" && !lead.quoteId}
                    title={lead.followUpStatus === "LOST" && !lead.quoteId ? t("customers.lifecycle.reopenBeforeQuote") : undefined}
                    className="flex w-full items-start gap-3 rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-3 py-3 text-left transition hover:border-[var(--qf-border-strong)] hover:bg-[var(--qf-interactive-hover)] disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--qf-panel-muted)] text-sm font-semibold text-[var(--qf-text-soft)]">
                      {customerInitials(lead.customerName)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-[var(--qf-text)]">{lead.customerName}</span>
                      <span className="mt-1 block text-xs text-[var(--qf-text-muted)]">
                        {lead.followUpStatus === "LOST" && !lead.quoteId
                          ? t("customers.lifecycle.reopenBeforeQuote")
                          : lead.quoteTitle ?? t("activity.noQuoteYet")}
                      </span>
                    </span>
                  </button>
                ))
              ) : (
                <p className="rounded-[14px] border border-dashed border-[var(--qf-border-strong)] bg-[var(--qf-panel-muted)] px-3 py-3 text-sm text-[var(--qf-text-muted)]">
                  {t("activity.recentLeadsEmpty")}
                </p>
              )}
            </div>
          </Card>
        </div>
      </div>}
    </div>
  );
}
