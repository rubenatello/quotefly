import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ArchiveRestore, BadgeCheck, CircleDot, ClipboardList, FilePlus2, FileText, Mail, MessageSquare, Phone, PhoneCall, Search, Send, Wrench, XCircle } from "lucide-react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Alert, Button, Card, ConfirmModal, EmptyState, Input, LoadingState, Modal, ModalBody, ModalFooter, ModalHeader, PageHeader, PaginationControls, Select, Textarea, type PageSize } from "../components/ui";
import { useDashboard, formatDateTime } from "../components/dashboard/DashboardContext";
import { KodyButton } from "../components/ai/KodyButton";
import { publishKodyOutcome } from "../components/ai/kody-events";
import { usePageView } from "../lib/analytics";
import { api, type Customer, type CustomerActivityEvent, type CustomerLifecycle, type CustomerLostReason, type CustomerQuoteSummary, type OrganizationUser, type SupportedLocale } from "../lib/api";
import { localizedApiError } from "../lib/localized-api-error";
import { formatUsPhoneDisplay, formatUsPhoneInput, normalizeUsPhoneDigits, toPhoneHrefValue } from "../lib/phone";
import { QuickCustomerModal, type QuickCustomerForm } from "../components/customers/QuickCustomerModal";
import { notify } from "../lib/notifications";
import i18n from "../i18n/i18n";
import { useLocale } from "../i18n";
import {
  CustomerLifecycleModal,
  type CustomerLifecycleMode,
} from "../components/customers/CustomerLifecycleModal";
import { customerLostReasonLabel } from "../components/customers/customer-lifecycle-labels";

type CustomerStage = "NEW" | "CONTACTED" | "READY" | "SENT" | "WON" | "LOST";

type CustomerRow = {
  customer: Customer;
  latestQuote: CustomerQuoteSummary | null;
  stage: CustomerStage;
};

type CustomerRetentionAction =
  | { type: "archive" | "delete" | "restore"; row: CustomerRow }
  | null;

function customerQuoteBlockedMessage(customer: Pick<Customer, "archivedAtUtc" | "deletedAtUtc" | "followUpStatus">): string | null {
  if (customer.archivedAtUtc || customer.deletedAtUtc) return i18n.t("customers.restoreBeforeQuote");
  if (customer.followUpStatus === "LOST") return i18n.t("customers.lifecycle.reopenBeforeQuote");
  return null;
}

function roleLabelForAssignment(role: OrganizationUser["role"]): string {
  return i18n.t(`domain.role.${role}`);
}

const CUSTOMER_STAGE_ORDER: CustomerStage[] = ["NEW", "CONTACTED", "READY", "SENT", "WON", "LOST"];
const ACTIVITY_PAGE_SIZE = 5;

function stageLabel(stage: CustomerStage) {
  return i18n.t(`domain.customerStage.${stage}`);
}

function stageDarkClass(stage: CustomerStage) {
  if (stage === "NEW") return "border-slate-700 bg-slate-700 text-white";
  if (stage === "CONTACTED") return "border-[var(--qf-info-strong)] bg-[var(--qf-info-strong)] text-white";
  if (stage === "READY") return "border-[var(--qf-warning-strong)] bg-[var(--qf-warning-strong)] text-white";
  if (stage === "SENT") return "border-[#2b7aa5] bg-[#2b7aa5] text-white";
  if (stage === "LOST") return "border-[var(--qf-danger-strong)] bg-[var(--qf-danger-strong)] text-white";
  return "border-[var(--qf-success-strong)] bg-[var(--qf-success-strong)] text-white";
}

function stageSoftClass(stage: CustomerStage) {
  if (stage === "NEW") return "border-slate-200 bg-slate-100 text-slate-700";
  if (stage === "CONTACTED") return "border-blue-200 bg-blue-50 text-blue-700";
  if (stage === "READY") return "border-amber-200 bg-amber-50 text-amber-700";
  if (stage === "SENT") return "border-sky-200 bg-sky-50 text-sky-700";
  if (stage === "LOST") return "border-red-200 bg-red-50 text-red-700";
  return "border-emerald-200 bg-emerald-50 text-emerald-700";
}

function stageInitial(stage: CustomerStage) {
  if (stage === "NEW") return "N";
  if (stage === "CONTACTED") return "C";
  if (stage === "READY") return "R";
  if (stage === "SENT") return "S";
  if (stage === "WON") return "W";
  return "L";
}

function stageIcon(stage: CustomerStage) {
  if (stage === "NEW") return <CircleDot size={12} strokeWidth={2.2} />;
  if (stage === "CONTACTED") return <PhoneCall size={12} strokeWidth={2.2} />;
  if (stage === "READY") return <FileText size={12} strokeWidth={2.2} />;
  if (stage === "SENT") return <Send size={12} strokeWidth={2.2} />;
  if (stage === "WON") return <BadgeCheck size={12} strokeWidth={2.2} />;
  return <XCircle size={12} strokeWidth={2.2} />;
}

function quoteNumber(quoteId: string) {
  return `QF-${quoteId.slice(0, 8).toUpperCase()}`;
}

function formatQuoteTotal(value: number | string) {
  return new Intl.NumberFormat(i18n.resolvedLanguage, { style: "currency", currency: "USD" }).format(Number(value));
}

function formatQuoteStatus(status: CustomerQuoteSummary["status"]) {
  return i18n.t(`domain.quoteStatus.${status}`);
}

function yearInTimeZone(date: Date, locale: SupportedLocale, timeZone?: string | null): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

function customerUpdatedLabel(
  updatedAt: string,
  locale: SupportedLocale,
  timeZone?: string | null,
  now = new Date(),
) {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return formatDateTime(updatedAt, locale, timeZone);

  const includeYear = yearInTimeZone(date, locale, timeZone) !== yearInTimeZone(now, locale, timeZone);

  return i18n.getFixedT(locale)("customers.updated", { date: new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: includeYear ? "numeric" : undefined,
    ...(timeZone ? { timeZone } : {}),
  }).format(date) });
}

function stageGuidance(stage: CustomerStage, hasQuote: boolean) {
  if (stage === "NEW") return hasQuote ? i18n.t("customers.guidance.newStarted") : i18n.t("customers.guidance.newNeeds");
  if (stage === "CONTACTED") return i18n.t("customers.guidance.contacted");
  if (stage === "READY") return i18n.t("customers.guidance.ready");
  if (stage === "SENT") return i18n.t("customers.guidance.sent");
  if (stage === "WON") return i18n.t("customers.guidance.won");
  return i18n.t("customers.guidance.lost");
}

function customerInitials(fullName: string) {
  return fullName
    .split(" ")
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function openDialer(phone: string) {
  window.location.assign(`tel:${toPhoneHrefValue(phone)}`);
}

function openTextComposer(phone: string) {
  window.location.assign(`sms:${toPhoneHrefValue(phone)}`);
}

function isRouteStateRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readKodyCustomerDraft(value: unknown): QuickCustomerForm | null {
  if (!isRouteStateRecord(value) || !isRouteStateRecord(value.kodyCustomerDraft)) return null;
  const draft = value.kodyCustomerDraft;
  if (
    typeof draft.fullName !== "string" || draft.fullName.length > 120
    || typeof draft.phone !== "string" || draft.phone.length > 40
    || typeof draft.email !== "string" || draft.email.length > 320
    || typeof draft.notes !== "string" || draft.notes.length > 5_000
  ) return null;
  return {
    fullName: draft.fullName.trim(),
    phone: formatUsPhoneInput(draft.phone),
    email: draft.email.trim(),
    notes: draft.notes.trim(),
  };
}

function StageFilterButton({
  stage,
  count,
  active,
  onClick,
}: {
  stage: CustomerStage | "ALL";
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  const label = stage === "ALL" ? i18n.t("domain.customerStage.ALL") : stageLabel(stage);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex min-h-[48px] min-w-[126px] shrink-0 snap-start items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition sm:min-h-[44px] ${
        active
          ? "border-quotefly-blue bg-quotefly-blue text-white shadow-sm"
          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
      }`}
      aria-pressed={active}
      aria-label={i18n.t("customers.filterButtonAria", { label, count })}
    >
      <span
        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold ${
          active
            ? "border-white/20 bg-white/10 text-white"
            : stage === "ALL"
              ? "border-slate-200 bg-slate-100 text-slate-600"
              : stageDarkClass(stage)
        }`}
      >
        {stage === "ALL" ? "A" : stageInitial(stage)}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`truncate text-[11px] font-semibold uppercase tracking-[0.12em] ${active ? "text-white" : "text-slate-500"}`}>
          {label}
        </p>
        <p className={`mt-0.5 text-sm font-bold ${active ? "text-white" : "text-slate-950"}`}>{count}</p>
      </div>
    </button>
  );
}

function CustomerPipelineFilterStrip({
  totalCount,
  stageCounts,
  stageFilter,
  onChange,
}: {
  totalCount: number;
  stageCounts: Record<CustomerStage, number>;
  stageFilter: CustomerStage | "ALL";
  onChange: (stage: CustomerStage | "ALL") => void;
}) {
  return (
    <div className="space-y-2">
      <div className="qf-horizontal-filter-strip flex snap-x snap-mandatory items-center gap-2 overflow-x-auto pb-2" role="group" aria-label={i18n.t("customers.filterAria")}>
        <StageFilterButton stage="ALL" count={totalCount} active={stageFilter === "ALL"} onClick={() => onChange("ALL")} />
        {CUSTOMER_STAGE_ORDER.map((stage) => (
          <StageFilterButton key={stage} stage={stage} count={stageCounts[stage]} active={stageFilter === stage} onClick={() => onChange(stage)} />
        ))}
      </div>
      <p className="px-1 text-xs text-[var(--qf-text-muted)]">{i18n.t("customers.filterHint")}</p>
    </div>
  );
}

function CustomerDesktopRow({
  row,
  locale,
  timeZone,
  onOpenQuote,
  onStartQuote,
  onCallCustomer,
  onTextCustomer,
  onOpenActivity,
}: {
  row: CustomerRow;
  locale: SupportedLocale;
  timeZone?: string | null;
  onOpenQuote: (quoteId: string) => void;
  onStartQuote: (customerId: string) => void;
  onCallCustomer: (phone: string) => void;
  onTextCustomer: (phone: string) => void;
  onOpenActivity: (customerId: string) => void;
}) {
  const { customer, latestQuote, stage } = row;
  const quoteBlockedMessage = customerQuoteBlockedMessage(customer);
  const canQuote = quoteBlockedMessage === null;

  return (
    <div className="hidden min-h-[86px] grid-cols-[minmax(220px,1.25fr)_minmax(220px,1fr)_minmax(190px,0.9fr)_150px_190px] items-center gap-5 border-l-2 border-transparent px-5 py-3 transition xl:grid hover:border-quotefly-blue hover:bg-slate-50/80 2xl:grid-cols-[minmax(260px,1.35fr)_minmax(250px,1fr)_minmax(220px,0.9fr)_160px_200px]">
      <button
        type="button"
        onClick={() => onOpenActivity(customer.id)}
        className="group/customer min-w-0 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-quotefly-blue"
        aria-label={i18n.t("customers.openDetails", { name: customer.fullName })}
      >
        <div className="flex items-center gap-3">
          <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-sm font-bold text-slate-700 ring-1 ring-slate-200 transition group-hover/customer:bg-white group-hover/customer:text-quotefly-blue">
            {customerInitials(customer.fullName)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-slate-950 group-hover/customer:text-quotefly-blue">{customer.fullName}</p>
            <p className="mt-1 truncate text-xs text-slate-500">{customerUpdatedLabel(customer.updatedAt, locale, timeZone)} · {i18n.t("customers.viewDetails")}</p>
          </div>
        </div>
      </button>

      <div className="min-w-0 space-y-1.5 text-sm">
        <div className="flex min-w-0 items-center gap-2 text-slate-700">
          <Phone size={14} className="shrink-0 text-slate-400" aria-hidden="true" />
          <span className="truncate font-medium">{formatUsPhoneDisplay(customer.phone)}</span>
        </div>
        <div className="flex min-w-0 items-center gap-2 text-slate-600">
          <Mail size={14} className="shrink-0 text-slate-400" aria-hidden="true" />
          <span className={`truncate ${customer.email ? "" : "text-slate-400"}`}>{customer.email ?? i18n.t("customers.noEmail")}</span>
        </div>
      </div>

      <div className="min-w-0">
        {latestQuote ? (
          <button
            type="button"
            onClick={() => onOpenQuote(latestQuote.id)}
            className="block min-w-0 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-quotefly-blue"
            aria-label={i18n.t("customers.openQuote", { title: latestQuote.title })}
          >
            <span className="block truncate text-sm font-semibold text-slate-900 hover:text-quotefly-blue">{latestQuote.title}</span>
            <span className="mt-1 block truncate text-xs font-medium text-slate-500">{quoteNumber(latestQuote.id)}</span>
          </button>
        ) : (
          <div>
            <p className="text-sm font-semibold text-slate-700">{i18n.t("customers.noQuote")}</p>
            <p className="mt-1 text-xs text-slate-500">{i18n.t("customers.readyEstimate")}</p>
          </div>
        )}
      </div>

      <div className="min-w-0">
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${stageSoftClass(stage)}`}>
          {stageIcon(stage)}
          {stageLabel(stage)}
        </span>
        <p className="mt-1.5 truncate text-xs text-slate-500">{stageGuidance(stage, Boolean(latestQuote))}</p>
      </div>

      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" icon={<Phone size={15} />} onClick={() => onCallCustomer(customer.phone)} aria-label={i18n.t("customers.callName", { name: customer.fullName })} title={i18n.t("customers.callName", { name: customer.fullName })} />
        <Button size="sm" variant="ghost" icon={<MessageSquare size={15} />} onClick={() => onTextCustomer(customer.phone)} aria-label={i18n.t("customers.textName", { name: customer.fullName })} title={i18n.t("customers.textName", { name: customer.fullName })} />
        <Button
          size="sm"
          variant="primary"
          icon={<FilePlus2 size={14} />}
          className="whitespace-nowrap"
          onClick={() => onStartQuote(customer.id)}
          disabled={!canQuote}
          title={canQuote ? i18n.t("customers.openQuote", { title: customer.fullName }) : quoteBlockedMessage ?? undefined}
        >
          {i18n.t("customers.newQuote")}
        </Button>
      </div>
    </div>
  );
}

function CustomerMobileCard({
  row,
  locale,
  timeZone,
  onOpenQuote,
  onStartQuote,
  onCallCustomer,
  onTextCustomer,
  onOpenActivity,
}: {
  row: CustomerRow;
  locale: SupportedLocale;
  timeZone?: string | null;
  onOpenQuote: (quoteId: string) => void;
  onStartQuote: (customerId: string) => void;
  onCallCustomer: (phone: string) => void;
  onTextCustomer: (phone: string) => void;
  onOpenActivity: (customerId: string) => void;
}) {
  const { customer, latestQuote, stage } = row;
  const quoteBlockedMessage = customerQuoteBlockedMessage(customer);
  const canQuote = quoteBlockedMessage === null;
  const quoteBlockDescriptionId = `customer-${customer.id}-quote-blocked`;

  return (
    <article className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_6px_18px_rgba(15,23,42,0.045)] xl:hidden">
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={() => onOpenActivity(customer.id)}
          className="flex min-h-[44px] min-w-0 items-center gap-3 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-quotefly-blue"
          aria-label={i18n.t("customers.openDetails", { name: customer.fullName })}
        >
          <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-sm font-bold text-slate-700 ring-1 ring-slate-200">
            {customerInitials(customer.fullName)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-base font-bold text-slate-950">{customer.fullName}</p>
            <p className="mt-1 text-xs text-slate-500">{customerUpdatedLabel(customer.updatedAt, locale, timeZone)} · {i18n.t("customers.viewDetails")}</p>
          </div>
        </button>
        <div className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${stageSoftClass(stage)}`}>
          {stageIcon(stage)}
          {stageLabel(stage)}
        </div>
      </div>

      <div className="space-y-2 rounded-xl bg-slate-50 px-3.5 py-3 text-sm">
        <div className="flex min-w-0 items-center gap-2.5 text-slate-700">
          <Phone size={15} className="shrink-0 text-slate-400" aria-hidden="true" />
          <span className="truncate font-medium">{formatUsPhoneDisplay(customer.phone)}</span>
        </div>
        <div className="flex min-w-0 items-center gap-2.5 text-slate-600">
          <Mail size={15} className="shrink-0 text-slate-400" aria-hidden="true" />
          <span className={`truncate ${customer.email ? "" : "text-slate-400"}`}>{customer.email ?? i18n.t("customers.noEmail")}</span>
        </div>
      </div>

      <div className="flex items-start justify-between gap-3 border-t border-slate-100 pt-3 text-sm text-slate-700">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">{i18n.t("customers.latestQuote")}</p>
          {latestQuote ? (
            <button
              type="button"
              className="mt-1 block max-w-full truncate rounded text-left font-semibold text-slate-900 hover:text-quotefly-blue focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-quotefly-blue"
              onClick={() => onOpenQuote(latestQuote.id)}
            >
              {latestQuote.title}
            </button>
          ) : (
            <p className="mt-1 truncate font-semibold text-slate-900">{i18n.t("customers.noQuote")}</p>
          )}
          <p className="mt-1 text-xs text-slate-500">{stageGuidance(stage, Boolean(latestQuote))}</p>
        </div>
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-500">{latestQuote ? quoteNumber(latestQuote.id) : i18n.t("customers.readyStart")}</span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Button fullWidth size="sm" variant="outline" icon={<Phone size={14} />} onClick={() => onCallCustomer(customer.phone)}>
          {i18n.t("customers.call")}
        </Button>
        <Button fullWidth size="sm" variant="outline" icon={<MessageSquare size={14} />} onClick={() => onTextCustomer(customer.phone)}>
          {i18n.t("customers.text")}
        </Button>
        <Button
          fullWidth
          size="sm"
          variant="primary"
          icon={<FilePlus2 size={14} />}
          onClick={() => onStartQuote(customer.id)}
          disabled={!canQuote}
          aria-describedby={!canQuote ? quoteBlockDescriptionId : undefined}
          title={canQuote ? i18n.t("customers.openQuote", { title: customer.fullName }) : quoteBlockedMessage ?? undefined}
        >
          {i18n.t("customers.newQuote")}
        </Button>
      </div>
      {!canQuote ? (
        <p id={quoteBlockDescriptionId} className="text-xs font-medium text-[var(--qf-danger-strong)]">
          {quoteBlockedMessage}
        </p>
      ) : null}
    </article>
  );
}

function activityTone(item: CustomerActivityEvent): "slate" | "blue" | "orange" | "emerald" | "red" {
  if (item.sourceType === "quote_outbound") return "orange";
  if (item.eventType === "CUSTOMER_LOST") return "red";
  if (item.eventType === "ACCEPTED" || item.eventType === "WON" || item.eventType === "RESTORED" || item.eventType === "CUSTOMER_REOPENED") return "emerald";
  if (item.eventType === "ARCHIVED" || item.eventType === "REJECTED") return "slate";
  return "blue";
}

function activityIcon(item: CustomerActivityEvent): ReactNode {
  if (item.sourceType === "quote_outbound") {
    if (item.channel === "SMS_APP") return <MessageSquare size={14} strokeWidth={2.2} />;
    if (item.channel === "COPY") return <ClipboardList size={14} strokeWidth={2.2} />;
    return <Send size={14} strokeWidth={2.2} />;
  }

  if (item.sourceType === "quote_revision") {
    if (item.eventType === "CREATED") return <FilePlus2 size={14} strokeWidth={2.2} />;
    if (item.eventType === "STATUS_CHANGED" || item.eventType === "DECISION") return <Send size={14} strokeWidth={2.2} />;
    if (item.eventType === "LINE_ITEM_CHANGED") return <Wrench size={14} strokeWidth={2.2} />;
    return <ClipboardList size={14} strokeWidth={2.2} />;
  }
  if (item.eventType === "STATUS_CHANGED") return <PhoneCall size={14} strokeWidth={2.2} />;
  if (item.eventType === "NOTES_ADDED" || item.eventType === "NOTES_UPDATED" || item.eventType === "NOTES_CLEARED") {
    return <FileText size={14} strokeWidth={2.2} />;
  }
  if (item.eventType === "ARCHIVED") return <CircleDot size={14} strokeWidth={2.2} />;
  return <ClipboardList size={14} strokeWidth={2.2} />;
}

function activityActorLabel(item: CustomerActivityEvent): string {
  return item.actorName?.trim() || item.actorEmail?.trim() || i18n.t("customers.unassigned");
}

function activityDisplay(
  item: CustomerActivityEvent,
  customerName: string,
  t: TFunction,
): { title: string; detail: string } {
  if (item.sourceType === "quote_outbound") {
    const titleKey = item.channel === "EMAIL_APP"
      ? "customers.activity.event.outboundEmail"
      : item.channel === "SMS_APP"
        ? "customers.activity.event.outboundText"
        : item.channel === "NATIVE_SHARE"
          ? "customers.activity.event.outboundShare"
          : "customers.activity.event.outboundCopy";
    return {
      title: t(titleKey),
      detail: item.quoteId && item.quoteTitle
        ? t("customers.activity.quoteReference", { number: quoteNumber(item.quoteId), title: item.quoteTitle })
        : t("customers.activity.recorded"),
    };
  }

  if (item.sourceType === "quote_revision") {
    const titleKey = item.eventType === "CREATED"
      ? "customers.activity.event.quoteDrafted"
      : item.eventType === "LINE_ITEM_CHANGED"
        ? "customers.activity.event.quoteLinesUpdated"
        : item.eventType === "DECISION"
          ? "customers.activity.event.quoteDecisionUpdated"
          : item.eventType === "STATUS_CHANGED"
            ? "customers.activity.event.quoteStatusUpdated"
            : "customers.activity.event.quoteUpdated";
    return {
      title: t(titleKey),
      detail: item.quoteId && item.quoteTitle
        ? t("customers.activity.quoteReference", { number: quoteNumber(item.quoteId), title: item.quoteTitle })
        : t("customers.activity.recorded"),
    };
  }

  const eventTitleKey: Record<string, string> = {
    CREATED: "customers.activity.event.customerAdded",
    UPDATED: "customers.activity.event.customerUpdated",
    STATUS_CHANGED: "customers.activity.event.statusUpdated",
    NOTES_ADDED: "customers.activity.event.notesAdded",
    NOTES_UPDATED: "customers.activity.event.notesUpdated",
    NOTES_CLEARED: "customers.activity.event.notesCleared",
    DOCUMENT_LANGUAGE_UPDATED: "customers.activity.event.documentLanguageUpdated",
    ARCHIVED: "customers.activity.event.customerArchived",
    DELETED: "customers.activity.event.customerDeleted",
    RESTORED: "customers.activity.event.customerRestored",
    MERGED: "customers.activity.event.customerMerged",
    CUSTOMER_LOST: "customers.activity.event.customerLost",
    CUSTOMER_REOPENED: "customers.activity.event.customerReopened",
  };
  const detailKey: Record<string, string> = {
    CREATED: "customers.activity.detail.customerAdded",
    UPDATED: "customers.activity.detail.customerUpdated",
    STATUS_CHANGED: "customers.activity.detail.statusUpdated",
    NOTES_CLEARED: "customers.activity.detail.notesCleared",
    DOCUMENT_LANGUAGE_UPDATED: "customers.activity.detail.documentLanguageUpdated",
    ARCHIVED: "customers.activity.detail.customerArchived",
    DELETED: "customers.activity.detail.customerDeleted",
    RESTORED: "customers.activity.detail.customerRestored",
    MERGED: "customers.activity.detail.customerMerged",
  };

  if (item.eventType === "CUSTOMER_LOST") {
    const reason = item.metadata?.reason;
    const notes = item.metadata?.notes;
    const reasonLabel = typeof reason === "string"
      ? customerLostReasonLabel(reason as CustomerLostReason, t)
      : t("customers.lifecycle.reasons.OTHER");
    return {
      title: t(eventTitleKey.CUSTOMER_LOST),
      detail: typeof notes === "string" && notes.trim()
        ? t("customers.activity.detail.customerLostWithNotes", { reason: reasonLabel, notes })
        : t("customers.activity.detail.customerLost", { reason: reasonLabel }),
    };
  }
  if (item.eventType === "CUSTOMER_REOPENED") {
    return {
      title: t(eventTitleKey.CUSTOMER_REOPENED),
      detail: item.metadata?.startedFollowUpSequence === true
        ? t("customers.activity.detail.customerReopenedWithSchedule")
        : t("customers.activity.detail.customerReopenedWithoutSchedule"),
    };
  }

  const isUserAuthoredNote = item.eventType === "NOTES_ADDED" || item.eventType === "NOTES_UPDATED";
  return {
    title: t(eventTitleKey[item.eventType] ?? "customers.activity.event.recorded"),
    // Customer notes are tenant-authored content and must remain verbatim. All
    // other known event prose is generated from stable codes, never translated
    // by guessing at stored English sentences.
    detail: isUserAuthoredNote
      ? (item.detail || t("customers.activity.recorded"))
      : detailKey[item.eventType]
        ? t(detailKey[item.eventType], { name: customerName })
        : t("customers.activity.recorded"),
  };
}

function localizedCustomerError(error: unknown, t: TFunction, fallbackKey: string): string {
  return localizedApiError(error, t, {
    fallbackKey,
    codeKeys: {
      ASSIGNEE_INACTIVE: "customers.errors.assigneeInactive",
      ACTIVE_ACTIVITY_TASKS: "customers.errors.activeTasks",
      CUSTOMER_ALREADY_LOST: "customers.lifecycle.errors.alreadyLost",
      CUSTOMER_NOT_LOST: "customers.lifecycle.errors.notLost",
      CUSTOMER_LIFECYCLE_STALE_VERSION: "customers.lifecycle.errors.stale",
      CUSTOMER_LIFECYCLE_COMMAND_REQUIRED: "customers.lifecycle.errors.commandRequired",
      CUSTOMER_HAS_ACTIVE_JOBS: "customers.lifecycle.errors.activeJobs",
      CUSTOMER_LOST_OTHER_NOTES_REQUIRED: "customers.lifecycle.errors.otherNotesRequired",
    },
  });
}

export function CustomersPage() {
  const { t } = useTranslation();
  const { locale } = useLocale();
  usePageView("customers");
  const location = useLocation();
  const navigate = useNavigate();
  const {
    error,
    notice,
    setError,
    setNotice,
    loadCustomers,
    loadQuotes,
    navigateToQuote,
    navigateToBuilder,
    canManageAssignments,
    canManageRecordRetention,
    session,
  } = useDashboard();
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");
  const [stageFilter, setStageFilter] = useState<CustomerStage | "ALL">("ALL");
  const [lifecycleFilter, setLifecycleFilter] = useState<CustomerLifecycle>("active");
  const [customerPage, setCustomerPage] = useState(1);
  const [customerPageSize, setCustomerPageSize] = useState<PageSize>(25);
  const [customerItems, setCustomerItems] = useState<Customer[]>([]);
  const [customerTotal, setCustomerTotal] = useState(0);
  const [customerLoading, setCustomerLoading] = useState(true);
  const [customerLoadError, setCustomerLoadError] = useState<string | null>(null);
  const [lifecycleCounts, setLifecycleCounts] = useState({ active: 0, archived: 0, deleted: 0 });
  const [serverStageCounts, setServerStageCounts] = useState<Record<CustomerStage, number>>({ NEW: 0, CONTACTED: 0, READY: 0, SENT: 0, WON: 0, LOST: 0 });
  const [quickCustomerOpen, setQuickCustomerOpen] = useState(false);
  const [quickCustomerDraft, setQuickCustomerDraft] = useState<QuickCustomerForm>({ fullName: "", phone: "", email: "", notes: "" });
  const [quickCustomerFromKody, setQuickCustomerFromKody] = useState(false);
  const [activityCustomerId, setActivityCustomerId] = useState<string | null>(null);
  const [activityItems, setActivityItems] = useState<CustomerActivityEvent[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [activityPage, setActivityPage] = useState(1);
  const [activityTotal, setActivityTotal] = useState(0);
  const [customerNotesDraft, setCustomerNotesDraft] = useState("");
  const [notesSaving, setNotesSaving] = useState(false);
  const [customerDetailsDraft, setCustomerDetailsDraft] = useState({
    fullName: "",
    phone: "",
    email: "",
    assignedTenantUserId: "",
    preferredLocale: "" as SupportedLocale | "",
  });
  const [workspaceMembers, setWorkspaceMembers] = useState<OrganizationUser[]>([]);
  const [detailsSaving, setDetailsSaving] = useState(false);
  const [detailsFeedback, setDetailsFeedback] = useState<{ tone: "error" | "success"; message: string } | null>(null);
  const [customerRetentionAction, setCustomerRetentionAction] = useState<CustomerRetentionAction>(null);
  const [customerRetentionSaving, setCustomerRetentionSaving] = useState(false);
  const [customerLifecycleMode, setCustomerLifecycleMode] = useState<CustomerLifecycleMode | null>(null);
  const [customerLifecycleSaving, setCustomerLifecycleSaving] = useState(false);
  const [customerLifecycleError, setCustomerLifecycleError] = useState<string | null>(null);
  const [followUpAutomationEnabled, setFollowUpAutomationEnabled] = useState<boolean | null>(null);
  const [discardCustomerChangesOpen, setDiscardCustomerChangesOpen] = useState(false);
  const pendingCustomerCloseActionRef = useRef<(() => void) | null>(null);
  const [selectedCustomerDetail, setSelectedCustomerDetail] = useState<Customer | null>(null);
  const [selectedActivityQuotes, setSelectedActivityQuotes] = useState<CustomerQuoteSummary[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const customerRequestIdRef = useRef(0);
  const activityRequestIdRef = useRef(0);
  const detailRequestIdRef = useRef(0);
  const formatLocalDateTime = useCallback((value: string) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(session?.timezone ? { timeZone: session.timezone } : {}),
    }).format(date);
  }, [locale, session?.timezone]);

  useEffect(() => {
    if (!canManageAssignments) return;
    let mounted = true;
    api.org.users.list({ limit: 100 })
      .then((result) => {
        if (mounted) setWorkspaceMembers(result.members);
      })
      .catch(() => {
        if (mounted) setWorkspaceMembers([]);
      });
    return () => { mounted = false; };
  }, [canManageAssignments]);

  const refreshFollowUpAutomation = useCallback(async () => {
    setFollowUpAutomationEnabled(null);
    try {
      const result = await api.followUpSettings.get();
      setFollowUpAutomationEnabled(result.followUpSettings.enabled);
    } catch {
      setFollowUpAutomationEnabled(false);
    }
  }, []);

  useEffect(() => {
    void refreshFollowUpAutomation();
  }, [refreshFollowUpAutomation]);

  useEffect(() => {
    if (searchParams.get("compose") === "customer") {
      setQuickCustomerOpen(true);
    }
  }, [searchParams]);

  useEffect(() => {
    const draft = readKodyCustomerDraft(location.state);
    if (!draft) return;
    setQuickCustomerDraft(draft);
    setQuickCustomerFromKody(true);
    setQuickCustomerOpen(true);
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [location.pathname, location.search, location.state, navigate]);

  useEffect(() => {
    setActivityPage(1);
  }, [activityCustomerId]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedSearchTerm(searchTerm.trim());
      setCustomerPage(1);
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [searchTerm]);

  const loadCustomerPage = useCallback(async () => {
    const requestId = ++customerRequestIdRef.current;
    setCustomerLoading(true);
    setCustomerLoadError(null);
    try {
      const result = await api.customers.list({
        limit: customerPageSize,
        offset: (customerPage - 1) * customerPageSize,
        search: debouncedSearchTerm || undefined,
        lifecycle: lifecycleFilter,
        stage: stageFilter === "ALL" ? undefined : stageFilter,
      });
      if (requestId !== customerRequestIdRef.current) return;
      setCustomerItems(result.customers);
      setCustomerTotal(result.pagination.total);
      setLifecycleCounts(result.summary.lifecycleCounts);
      setServerStageCounts(result.summary.stageCounts);
      setCustomerLoadError(null);
    } catch (err) {
      if (requestId !== customerRequestIdRef.current) return;
      setCustomerLoadError(localizedCustomerError(err, t, "customers.loadError"));
    } finally {
      if (requestId === customerRequestIdRef.current) setCustomerLoading(false);
    }
  }, [customerPage, customerPageSize, debouncedSearchTerm, lifecycleFilter, stageFilter, t]);

  useEffect(() => {
    void loadCustomerPage();
  }, [loadCustomerPage]);

  const loadCustomerActivity = useCallback(
    async (customerId: string, page: number) => {
      const requestId = ++activityRequestIdRef.current;
      setActivityLoading(true);
      setActivityError(null);
      setActivityItems([]);
      setActivityTotal(0);
      try {
        const result = await api.customers.activity(customerId, {
          limit: ACTIVITY_PAGE_SIZE,
          offset: (page - 1) * ACTIVITY_PAGE_SIZE,
        });
        if (requestId !== activityRequestIdRef.current) return;
        setActivityItems(result.items);
        setActivityTotal(result.pagination.total);
      } catch (err) {
        if (requestId !== activityRequestIdRef.current) return;
        setActivityError(localizedCustomerError(err, t, "customers.errors.activityLoad"));
      } finally {
        if (requestId === activityRequestIdRef.current) setActivityLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    if (!activityCustomerId) {
      activityRequestIdRef.current += 1;
      detailRequestIdRef.current += 1;
      setActivityItems([]);
      setActivityLoading(false);
      setActivityError(null);
      setActivityTotal(0);
      setSelectedCustomerDetail(null);
      setSelectedActivityQuotes([]);
      return;
    }

    void loadCustomerActivity(activityCustomerId, activityPage);
  }, [activityCustomerId, activityPage, loadCustomerActivity]);

  const loadCustomerDetail = useCallback(async (customerId: string) => {
    const requestId = ++detailRequestIdRef.current;
    try {
      const result = await api.customers.get(customerId);
      if (requestId !== detailRequestIdRef.current) return;
      setSelectedCustomerDetail(result.customer);
      setSelectedActivityQuotes(result.quotes);
    } catch (err) {
      if (requestId !== detailRequestIdRef.current) return;
      setError(localizedCustomerError(err, t, "customers.errors.detailsLoad"));
    }
  }, [setError, t]);

  useEffect(() => {
    if (activityCustomerId) void loadCustomerDetail(activityCustomerId);
  }, [activityCustomerId, loadCustomerDetail]);

  function closeQuickCustomerModal() {
    setQuickCustomerOpen(false);
    setQuickCustomerFromKody(false);
    if (searchParams.get("compose") === "customer") {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete("compose");
      setSearchParams(nextParams, { replace: true });
    }
  }

  const customerRows = useMemo(() => {
    return customerItems
      .map((customer) => {
        const latestQuote = customer.summary?.latestQuote ?? null;
        const stage = customer.summary?.stage ?? "NEW";
        return {
          customer,
          latestQuote,
          stage,
        } satisfies CustomerRow;
      })
      .sort((left, right) => new Date(right.customer.updatedAt).getTime() - new Date(left.customer.updatedAt).getTime());
  }, [customerItems]);

  const selectedActivityRow = useMemo(() => {
    if (!activityCustomerId) return null;
    if (selectedCustomerDetail?.id === activityCustomerId) {
      return {
        customer: selectedCustomerDetail,
        latestQuote: selectedCustomerDetail.summary?.latestQuote ?? null,
        stage: selectedCustomerDetail.summary?.stage ?? "NEW",
      } satisfies CustomerRow;
    }
    return customerRows.find((row) => row.customer.id === activityCustomerId) ?? null;
  }, [activityCustomerId, customerRows, selectedCustomerDetail]);

  const openCustomerDetail = useCallback((customerId: string) => {
    const snapshot = customerItems.find((customer) => customer.id === customerId) ?? null;
    activityRequestIdRef.current += 1;
    detailRequestIdRef.current += 1;
    setSelectedCustomerDetail(snapshot);
    setSelectedActivityQuotes([]);
    setActivityItems([]);
    setActivityTotal(0);
    setActivityError(null);
    setActivityCustomerId(customerId);
  }, [customerItems]);

  useEffect(() => {
    if (!isRouteStateRecord(location.state) || typeof location.state.kodyCustomerId !== "string") return;
    openCustomerDetail(location.state.kodyCustomerId);
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [location.pathname, location.search, location.state, navigate, openCustomerDetail]);

  const totalActivityPages = Math.max(1, Math.ceil(activityTotal / ACTIVITY_PAGE_SIZE));
  const totalCustomerPages = Math.max(1, Math.ceil(customerTotal / customerPageSize));
  const selectedCustomerInactive = Boolean(selectedActivityRow?.customer.archivedAtUtc || selectedActivityRow?.customer.deletedAtUtc);

  useEffect(() => {
    if (customerPage > totalCustomerPages) setCustomerPage(totalCustomerPages);
  }, [customerPage, totalCustomerPages]);
  const notesChanged =
    (selectedActivityRow?.customer.notes?.trim() ?? "") !== customerNotesDraft.trim();
  const detailsChanged = Boolean(selectedActivityRow) && (
    selectedActivityRow?.customer.fullName !== customerDetailsDraft.fullName.trim() ||
    selectedActivityRow?.customer.phone !== customerDetailsDraft.phone.trim() ||
    (selectedActivityRow?.customer.email ?? "") !== customerDetailsDraft.email.trim() ||
    (selectedActivityRow?.customer.assignedTenantUserId ?? "") !== customerDetailsDraft.assignedTenantUserId ||
    (selectedActivityRow?.customer.preferredLocale ?? "") !== customerDetailsDraft.preferredLocale
  );

  useEffect(() => {
    setCustomerNotesDraft(selectedActivityRow?.customer.notes ?? "");
  }, [selectedActivityRow?.customer.id, selectedActivityRow?.customer.notes]);

  useEffect(() => {
    setCustomerDetailsDraft({
      fullName: selectedActivityRow?.customer.fullName ?? "",
      phone: selectedActivityRow?.customer.phone ?? "",
      email: selectedActivityRow?.customer.email ?? "",
      assignedTenantUserId: selectedActivityRow?.customer.assignedTenantUserId ?? "",
      preferredLocale: selectedActivityRow?.customer.preferredLocale ?? "",
    });
  }, [selectedActivityRow?.customer.assignedTenantUserId, selectedActivityRow?.customer.email, selectedActivityRow?.customer.fullName, selectedActivityRow?.customer.id, selectedActivityRow?.customer.phone, selectedActivityRow?.customer.preferredLocale]);

  useEffect(() => {
    setDetailsFeedback(null);
  }, [selectedActivityRow?.customer.id]);

  async function saveCustomerDetails() {
    if (!selectedActivityRow || detailsSaving) return;

    const fullName = customerDetailsDraft.fullName.trim();
    const phone = customerDetailsDraft.phone.trim();
    if (!fullName || !phone) {
      setDetailsFeedback({ tone: "error", message: t("customers.quick.required") });
      return;
    }
    if (!normalizeUsPhoneDigits(phone)) {
      setDetailsFeedback({ tone: "error", message: t("customers.quick.invalidPhone") });
      return;
    }

    setDetailsFeedback(null);
    setDetailsSaving(true);
    try {
      await api.customers.update(selectedActivityRow.customer.id, {
        fullName,
        phone,
        email: customerDetailsDraft.email.trim() || null,
        preferredLocale: customerDetailsDraft.preferredLocale || null,
        ...(canManageAssignments ? { assignedTenantUserId: customerDetailsDraft.assignedTenantUserId || null } : {}),
      });
      await Promise.all([loadCustomerPage(), loadCustomers(), loadCustomerDetail(selectedActivityRow.customer.id)]);
      await loadCustomerActivity(selectedActivityRow.customer.id, activityPage);
      setDetailsFeedback({ tone: "success", message: t("customers.saved") });
    } catch (err) {
      setDetailsFeedback({ tone: "error", message: localizedCustomerError(err, t, "customers.errors.save") });
    } finally {
      setDetailsSaving(false);
    }
  }

  async function saveCustomerNotes() {
    if (!selectedActivityRow || notesSaving) return;

    const nextNotes = customerNotesDraft.trim();
    setNotesSaving(true);
    try {
      await api.customers.update(selectedActivityRow.customer.id, {
        notes: nextNotes || null,
      });
      await Promise.all([loadCustomerPage(), loadCustomers(), loadCustomerDetail(selectedActivityRow.customer.id)]);
      await loadCustomerActivity(selectedActivityRow.customer.id, activityPage);
      setNotice(t("customers.saved"));
    } catch (err) {
      setError(localizedCustomerError(err, t, "customers.errors.notesSave"));
    } finally {
      setNotesSaving(false);
    }
  }

  async function confirmCustomerRetentionAction() {
    if (!customerRetentionAction || customerRetentionSaving) return;

    const action = customerRetentionAction;
    setCustomerRetentionSaving(true);
    setError(null);
    try {
      if (action.type === "archive") {
        await api.customers.archive(action.row.customer.id);
        notify.success(t("customers.archivedNotice"), {
          description: t("customers.retention.archiveDescription"),
        });
      } else if (action.type === "delete") {
        await api.customers.delete(action.row.customer.id);
        notify.success(t("customers.deletedNotice"), {
          description: t("customers.retention.deleteDescription"),
        });
      } else {
        await api.customers.restore(action.row.customer.id);
        notify.success(t("customers.restoredNotice"), {
          description: t("customers.retention.restoreDescription"),
        });
      }
      await Promise.all([loadCustomerPage(), loadCustomers(), loadQuotes()]);
      activityRequestIdRef.current += 1;
      detailRequestIdRef.current += 1;
      setActivityCustomerId(null);
      setCustomerRetentionAction(null);
    } catch (err) {
      notify.error(t("customers.errors.retention"), {
        description: localizedCustomerError(err, t, "customers.errors.retention"),
      });
    } finally {
      setCustomerRetentionSaving(false);
    }
  }

  function openCustomerLifecycle(mode: CustomerLifecycleMode) {
    if (!selectedActivityRow || detailsChanged || notesChanged) return;
    if (mode === "reopen") void refreshFollowUpAutomation();
    setCustomerLifecycleError(null);
    setCustomerLifecycleMode(mode);
  }

  async function markSelectedCustomerLost(input: { reason: CustomerLostReason; notes: string | null }) {
    if (!selectedActivityRow || customerLifecycleSaving) return;
    const customerId = selectedActivityRow.customer.id;
    setCustomerLifecycleSaving(true);
    setCustomerLifecycleError(null);
    try {
      const result = await api.customers.markLost(customerId, {
        ...input,
        expectedVersion: selectedActivityRow.customer.lifecycleVersion,
      });
      setSelectedCustomerDetail(result.customer);
      await Promise.all([
        loadCustomerPage(),
        loadCustomers(),
        loadQuotes(),
        loadCustomerDetail(customerId),
        loadCustomerActivity(customerId, 1),
      ]);
      setActivityPage(1);
      setCustomerLifecycleMode(null);
      notify.success(t("customers.lifecycle.markLostNotice"), {
        description: t("customers.lifecycle.markLostNoticeDescription", {
          automaticCount: result.canceledAutomaticTaskCount,
          manualCount: result.openManualTaskCount,
        }),
      });
    } catch (err) {
      setCustomerLifecycleError(localizedCustomerError(err, t, "customers.errors.action"));
    } finally {
      setCustomerLifecycleSaving(false);
    }
  }

  async function reopenSelectedCustomer(input: { startFollowUpSequence: boolean }) {
    if (!selectedActivityRow || customerLifecycleSaving) return;
    const customerId = selectedActivityRow.customer.id;
    setCustomerLifecycleSaving(true);
    setCustomerLifecycleError(null);
    try {
      const result = await api.customers.reopen(customerId, {
        ...input,
        expectedVersion: selectedActivityRow.customer.lifecycleVersion,
      });
      setSelectedCustomerDetail(result.customer);
      await Promise.all([
        loadCustomerPage(),
        loadCustomers(),
        loadCustomerDetail(customerId),
        loadCustomerActivity(customerId, 1),
      ]);
      setActivityPage(1);
      setCustomerLifecycleMode(null);
      notify.success(t("customers.lifecycle.reopenNotice"), {
        description: result.startedFollowUpSequence
          ? t("customers.lifecycle.reopenNoticeWithSchedule", { count: result.createdAutomaticTaskCount })
          : t("customers.lifecycle.reopenNoticeWithoutSchedule"),
      });
    } catch (err) {
      setCustomerLifecycleError(localizedCustomerError(err, t, "customers.errors.action"));
    } finally {
      setCustomerLifecycleSaving(false);
    }
  }

  function finishClosingActivityModal() {
    activityRequestIdRef.current += 1;
    detailRequestIdRef.current += 1;
    setActivityCustomerId(null);
  }

  function closeActivityModal(afterClose?: () => void) {
    if (detailsChanged || notesChanged) {
      pendingCustomerCloseActionRef.current = afterClose ?? null;
      setDiscardCustomerChangesOpen(true);
      return;
    }
    finishClosingActivityModal();
    afterClose?.();
  }

  function discardCustomerChangesAndClose() {
    const afterClose = pendingCustomerCloseActionRef.current;
    pendingCustomerCloseActionRef.current = null;
    setDiscardCustomerChangesOpen(false);
    finishClosingActivityModal();
    afterClose?.();
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("customers.title")}
        subtitle={t("customers.subtitle")}
        mode="actions-only"
        actions={
          <Button onClick={() => setQuickCustomerOpen(true)} disabled={Boolean(customerLoadError)}>{t("customers.add")}</Button>
        }
      />

      {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}
      {notice ? <Alert tone="success" onDismiss={() => setNotice(null)}>{t("customers.saved")}</Alert> : null}

      <div className="flex flex-wrap gap-2" role="group" aria-label={t("customers.filterAria")}>
        {(["active", "archived", "deleted"] as const).map((lifecycle) => (
          <Button
            key={lifecycle}
            size="sm"
            variant={lifecycleFilter === lifecycle ? "primary" : "outline"}
            onClick={() => {
              setLifecycleFilter(lifecycle);
              setCustomerPage(1);
              setStageFilter("ALL");
            }}
          >
            {lifecycle === "active" ? t("customers.status.active") : lifecycle === "archived" ? t("customers.status.archived") : t("customers.status.deleted")} ({lifecycleCounts[lifecycle]})
          </Button>
        ))}
      </div>

      <CustomerPipelineFilterStrip
        totalCount={lifecycleCounts[lifecycleFilter]}
        stageCounts={serverStageCounts}
        stageFilter={stageFilter}
        onChange={(stage) => {
          setStageFilter(stage);
          setCustomerPage(1);
        }}
      />

      <Card variant="elevated" padding="md" className="overflow-hidden">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{t("customers.workspace")}</p>
              <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-600">
                {t("customers.count", { count: customerTotal })}
              </span>
            </div>
            <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-slate-900">{t("customers.list")}</h2>
            <p className="mt-1 max-w-3xl text-sm text-slate-600">{t("customers.listDescription")}</p>
          </div>
          <div className="w-full lg:w-[360px]">
            <label htmlFor="customer-search" className="sr-only">{t("customers.searchLabel")}</label>
            <Input
              id="customer-search"
              icon={<Search size={16} aria-hidden="true" />}
              placeholder={t("customers.searchPlaceholder")}
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
          </div>
        </div>

        <div className="-mx-4 -mb-4 mt-4 border-t border-slate-200 sm:-mx-5 sm:-mb-5">
          {customerLoading ? (
            <div className="p-4">
              <LoadingState
                title={t("customers.loading")}
                description={t("customers.loadingDescription")}
                variant="table"
                rows={5}
              />
            </div>
          ) : customerLoadError ? (
            <div className="p-5">
              <EmptyState
                title={t("customers.loadError")}
                description={customerLoadError}
                action={<Button variant="outline" onClick={() => void loadCustomerPage()}>{t("customers.retry")}</Button>}
              />
            </div>
          ) : customerRows.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title={debouncedSearchTerm || stageFilter !== "ALL" || lifecycleFilter !== "active" ? t("customers.noMatches") : t("customers.empty")}
                description={debouncedSearchTerm || stageFilter !== "ALL" || lifecycleFilter !== "active" ? t("customers.noMatchesDescription") : t("customers.emptyDescription")}
                action={debouncedSearchTerm || stageFilter !== "ALL" || lifecycleFilter !== "active" ? <Button variant="outline" onClick={() => { setSearchTerm(""); setStageFilter("ALL"); setLifecycleFilter("active"); setCustomerPage(1); }}>{t("products.clearFilters")}</Button> : <Button onClick={() => setQuickCustomerOpen(true)}>{t("customers.add")}</Button>}
              />
            </div>
          ) : (
            <>
              <div className="hidden grid-cols-[minmax(220px,1.25fr)_minmax(220px,1fr)_minmax(190px,0.9fr)_150px_190px] gap-5 border-b border-slate-200 bg-slate-50 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-500 xl:grid 2xl:grid-cols-[minmax(260px,1.35fr)_minmax(250px,1fr)_minmax(220px,0.9fr)_160px_200px]">
                <span>{t("customers.columns.customer")}</span>
                <span>{t("customers.columns.contact")}</span>
                <span>{t("customers.columns.latestQuote")}</span>
                <span>{t("customers.columns.stage")}</span>
                <span className="text-right">{t("customers.columns.actions")}</span>
              </div>
              <div className="grid gap-3 bg-slate-50/70 p-3 md:grid-cols-2 xl:block xl:bg-white xl:p-0">
                {customerRows.map((row) => (
                  <div key={row.customer.id} className="xl:border-b xl:border-slate-200 xl:last:border-b-0">
                    <CustomerDesktopRow
                      row={row}
                      locale={locale}
                      timeZone={session?.timezone}
                      onOpenQuote={navigateToQuote}
                      onStartQuote={navigateToBuilder}
                      onCallCustomer={openDialer}
                      onTextCustomer={openTextComposer}
                      onOpenActivity={openCustomerDetail}
                    />
                    <CustomerMobileCard
                      row={row}
                      locale={locale}
                      timeZone={session?.timezone}
                      onOpenQuote={navigateToQuote}
                      onStartQuote={navigateToBuilder}
                      onCallCustomer={openDialer}
                      onTextCustomer={openTextComposer}
                      onOpenActivity={openCustomerDetail}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </Card>

      <PaginationControls
        limit={customerPageSize}
        offset={(customerPage - 1) * customerPageSize}
        total={customerTotal}
        loading={customerLoading}
        itemLabel={t("navigation.customers").toLocaleLowerCase(locale)}
        onLimitChange={(nextLimit) => {
          setCustomerPageSize(nextLimit);
          setCustomerPage(1);
        }}
        onOffsetChange={(nextOffset) => setCustomerPage(Math.floor(nextOffset / customerPageSize) + 1)}
      />

      <QuickCustomerModal
        open={quickCustomerOpen}
        onClose={closeQuickCustomerModal}
        draftValue={quickCustomerDraft}
        onDraftChange={setQuickCustomerDraft}
        onCreated={async ({ customer, merged, restored, reusedExisting, intent }) => {
          void Promise.all([loadCustomerPage(), loadCustomers()]);
          const message = restored ? t("customers.restoredNotice") : t("customers.saved");
          void merged;
          void reusedExisting;
          notify.success(message, { description: customer.fullName });
          if (quickCustomerFromKody) {
            publishKodyOutcome({ type: "CUSTOMER_CREATED", customerName: customer.fullName });
          }
          if (intent === "quote") {
            navigateToBuilder(customer.id);
          }
        }}
      />

      <Modal
        open={Boolean(selectedActivityRow)}
        onClose={closeActivityModal}
        size="lg"
        modal={false}
        closeOnBackdrop={false}
        panelClassName="qf-kody-underlay z-[60]"
        ariaLabel={t("customers.detailsTitle")}
      >
        <ModalHeader
          title={selectedActivityRow ? `${selectedActivityRow.customer.fullName} · ${t("customers.activityTitle")}` : t("customers.activityTitle")}
          description={selectedActivityRow ? t("customers.listDescription") : undefined}
          onClose={closeActivityModal}
        />
        <ModalBody className="space-y-5">
          {selectedActivityRow ? (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("customers.customerSince", { date: "" }).replace(/\s+$/, "")}</p>
                  <p className="mt-1 text-sm font-semibold text-[var(--qf-text)]">{formatLocalDateTime(selectedActivityRow.customer.createdAt)}</p>
                </div>
                <div className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("customers.columns.stage")}</p>
                  <div className="mt-1 flex items-center gap-2">
                    <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full border text-[10px] font-bold ${stageDarkClass(selectedActivityRow.stage)}`}>
                      {stageInitial(selectedActivityRow.stage)}
                    </span>
                    <span className="text-sm font-semibold text-[var(--qf-text)]">{stageLabel(selectedActivityRow.stage)}</span>
                  </div>
                </div>
                <div className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("navigation.quotes")}</p>
                  <p className="mt-1 text-sm font-semibold text-[var(--qf-text)]">{selectedActivityQuotes.length}</p>
                </div>
              </div>

              {selectedCustomerInactive ? (
                <Alert tone="info">
                  {t("customers.retention.restoreDescription")}
                </Alert>
              ) : null}

              {selectedActivityRow.customer.followUpStatus === "LOST" ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-4 text-red-950 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-100">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-red-700 dark:text-red-300">{t("customers.lifecycle.lostSummaryTitle")}</p>
                      <p className="mt-1 text-sm font-semibold">
                        {selectedActivityRow.customer.lostReason
                          ? customerLostReasonLabel(selectedActivityRow.customer.lostReason, t)
                          : t("customers.lifecycle.reasons.OTHER")}
                      </p>
                      <p className="mt-1 text-xs text-red-800/80 dark:text-red-200/80">
                        {t("customers.lifecycle.lostSummaryMeta", {
                          date: selectedActivityRow.customer.lostAtUtc
                            ? formatLocalDateTime(selectedActivityRow.customer.lostAtUtc)
                            : "—",
                          actor: selectedActivityRow.customer.lostByTenantUser?.user.fullName ?? t("customers.lifecycle.systemActor"),
                        })}
                      </p>
                    </div>
                    {!selectedCustomerInactive ? (
                      <Button
                        size="sm"
                        variant="outline"
                        icon={<ArchiveRestore size={15} />}
                        disabled={detailsChanged || notesChanged}
                        title={detailsChanged || notesChanged ? t("customers.lifecycle.saveDraftsFirst") : undefined}
                        onClick={() => openCustomerLifecycle("reopen")}
                      >
                        {t("customers.lifecycle.reopenAction")}
                      </Button>
                    ) : null}
                  </div>
                  {selectedActivityRow.customer.lostReasonNotes ? (
                    <p className="mt-3 whitespace-pre-wrap rounded-lg border border-red-200/80 bg-white/60 px-3 py-2 text-sm text-red-950 dark:border-red-900/60 dark:bg-black/10 dark:text-red-100">
                      {selectedActivityRow.customer.lostReasonNotes}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {(detailsChanged || notesChanged) && !selectedCustomerInactive ? (
                <Alert tone="warning">{t("customers.lifecycle.saveDraftsFirst")}</Alert>
              ) : null}

              <div className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-4 py-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("customers.detailsTitle")}</p>
                    <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{t("customers.listDescription")}</p>
                  </div>
                  <Button size="sm" onClick={() => void saveCustomerDetails()} disabled={!detailsChanged || detailsSaving || selectedCustomerInactive} loading={detailsSaving}>
                    {t("customers.save")}
                  </Button>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1.5 sm:col-span-2">
                    <span className="text-xs font-medium text-[var(--qf-text-soft)]">{t("customers.fullName")}</span>
                    <Input
                      value={customerDetailsDraft.fullName}
                      onChange={(event) => setCustomerDetailsDraft((current) => ({ ...current, fullName: event.target.value }))}
                      disabled={detailsSaving || selectedCustomerInactive}
                    />
                  </label>
                  {canManageAssignments ? (
                    <div className="sm:col-span-2">
                      <Select
                        label={t("customers.assignment")}
                        value={customerDetailsDraft.assignedTenantUserId}
                        onChange={(event) => setCustomerDetailsDraft((current) => ({ ...current, assignedTenantUserId: event.target.value }))}
                        disabled={detailsSaving || selectedCustomerInactive}
                        options={[
                          { value: "", label: t("customers.unassigned") },
                          ...workspaceMembers.map((member) => ({ value: member.id, label: `${member.user.fullName} · ${roleLabelForAssignment(member.role)}` })),
                        ]}
                      />
                      <p className="mt-1.5 text-xs text-[var(--qf-text-muted)]">{t("pages.team.hint")}</p>
                    </div>
                  ) : selectedActivityRow.customer.assignedTenantUser ? (
                    <div className="sm:col-span-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-3 text-sm text-blue-800">
                      {t("customers.assignment")}: {selectedActivityRow.customer.assignedTenantUser.user.fullName}
                    </div>
                  ) : null}
                  <label className="space-y-1.5">
                    <span className="text-xs font-medium text-[var(--qf-text-soft)]">{t("customers.phone")}</span>
                    <Input
                      type="tel"
                      value={customerDetailsDraft.phone}
                      onChange={(event) => setCustomerDetailsDraft((current) => ({ ...current, phone: formatUsPhoneInput(event.target.value) }))}
                      disabled={detailsSaving || selectedCustomerInactive}
                    />
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-xs font-medium text-[var(--qf-text-soft)]">{t("customers.email")}</span>
                    <Input
                      type="email"
                      value={customerDetailsDraft.email}
                      onChange={(event) => setCustomerDetailsDraft((current) => ({ ...current, email: event.target.value }))}
                      disabled={detailsSaving || selectedCustomerInactive}
                    />
                  </label>
                  <div className="sm:col-span-2">
                    <Select
                      label={t("language.label")}
                      value={customerDetailsDraft.preferredLocale}
                      onChange={(event) =>
                        setCustomerDetailsDraft((current) => ({
                          ...current,
                          preferredLocale: event.target.value as SupportedLocale | "",
                        }))
                      }
                      disabled={detailsSaving || selectedCustomerInactive}
                      options={[
                        { value: "", label: t("setup.defaults") },
                        { value: "en-US", label: t("language.english") },
                        { value: "es-US", label: t("language.spanish") },
                      ]}
                    />
                    <p className="mt-1.5 text-xs text-[var(--qf-text-muted)]">
                      {t("customers.documentLanguageDescription")}
                    </p>
                  </div>
                </div>
                {detailsFeedback ? (
                  <div className="mt-3">
                    <Alert tone={detailsFeedback.tone}>{detailsFeedback.message}</Alert>
                  </div>
                ) : null}
              </div>

              <div className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-4 py-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("customers.notes")}</p>
                    <p className="mt-1 text-sm text-[var(--qf-text-soft)]">
                      {t("customers.notesDescription")}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => void saveCustomerNotes()}
                    disabled={!notesChanged || notesSaving || selectedCustomerInactive}
                    loading={notesSaving}
                  >
                    {t("common.save")}
                  </Button>
                </div>
                <div className="mt-3">
                  <Textarea
                    rows={5}
                    placeholder={t("customers.quick.notesPlaceholder")}
                    value={customerNotesDraft}
                    onChange={(event) => setCustomerNotesDraft(event.target.value)}
                    disabled={notesSaving || selectedCustomerInactive}
                  />
                </div>
              </div>

              <div className="overflow-hidden rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)]">
                <div className="flex items-start justify-between gap-3 border-b border-[var(--qf-border)] px-4 py-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("navigation.quotes")}</p>
                    <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{t("quotes.boardDescription")}</p>
                  </div>
                  <Button
                    size="sm"
                    icon={<FilePlus2 size={14} />}
                    disabled={Boolean(selectedActivityRow.customer.archivedAtUtc || selectedActivityRow.customer.deletedAtUtc || selectedActivityRow.customer.followUpStatus === "LOST")}
                    title={selectedActivityRow.customer.followUpStatus === "LOST" ? t("customers.lifecycle.reopenBeforeQuote") : undefined}
                    onClick={() => closeActivityModal(() => navigateToBuilder(selectedActivityRow.customer.id))}
                  >
                    {t("customers.newQuote")}
                  </Button>
                </div>
                {selectedActivityQuotes.length ? (
                  selectedActivityQuotes.map((quote, index) => (
                    <button
                      key={quote.id}
                      type="button"
                      onClick={() => closeActivityModal(() => navigateToQuote(quote.id))}
                      className={`flex min-h-[64px] w-full items-center justify-between gap-4 px-4 py-3 text-left transition hover:bg-[var(--qf-interactive-hover)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--qf-focus)] ${index > 0 ? "border-t border-[var(--qf-border)]" : ""}`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-[var(--qf-text)]">{quote.title}</span>
                        <span className="mt-1 block text-xs text-[var(--qf-text-muted)]">{quoteNumber(quote.id)} · {formatQuoteStatus(quote.status)} · {t("customers.updated", { date: formatLocalDateTime(quote.updatedAt) })}</span>
                      </span>
                      <span className="shrink-0 text-sm font-semibold text-[var(--qf-text)]">{formatQuoteTotal(quote.totalAmount)}</span>
                    </button>
                  ))
                ) : (
                  <div className="px-4 py-5 text-sm text-[var(--qf-text-soft)]">
                    {t("quotes.emptyDescription")}
                  </div>
                )}
              </div>

              <div data-testid="customer-activity-feed" className="overflow-hidden rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)]">
                {activityLoading ? (
                  <div className="p-4">
                    <LoadingState
                      title={t("customers.activity.loading")}
                      description={t("customers.activity.loadingDescription")}
                      variant="list"
                      rows={4}
                    />
                  </div>
                ) : activityError ? (
                  <div className="space-y-3 p-4">
                    <Alert tone="error">{activityError}</Alert>
                    <Button
                      variant="outline"
                      onClick={() => void loadCustomerActivity(selectedActivityRow.customer.id, activityPage)}
                    >
                      {t("customers.retry")}
                    </Button>
                  </div>
                ) : activityItems.length ? (
                  activityItems.map((item, index) => {
                    const tone = activityTone(item);
                    const display = activityDisplay(item, selectedActivityRow.customer.fullName, t);
                    return (
                    <div
                      key={item.id}
                      className={`flex gap-3 px-4 py-4 ${index > 0 ? "border-t border-[var(--qf-border)]" : ""}`}
                    >
                      <span
                        className={`mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                          tone === "blue"
                            ? "bg-[var(--qf-info-strong)] text-white"
                            : tone === "orange"
                              ? "bg-[var(--qf-warning-strong)] text-white"
                              : tone === "emerald"
                                ? "bg-[var(--qf-success-strong)] text-white"
                                : tone === "red"
                                  ? "bg-[var(--qf-danger-strong)] text-white"
                                : "bg-[var(--qf-text-soft)] text-[var(--qf-panel)]"
                        }`}
                      >
                        {activityIcon(item)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          {item.quoteId ? (
                            <button
                              type="button"
                              className="rounded text-left text-sm font-semibold text-[var(--qf-text)] hover:text-quotefly-blue focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]"
                              onClick={() => closeActivityModal(() => navigateToQuote(item.quoteId!))}
                            >
                              {display.title}
                            </button>
                          ) : (
                            <p className="text-sm font-semibold text-[var(--qf-text)]">{display.title}</p>
                          )}
                          <span className="text-xs text-[var(--qf-text-muted)]">{formatLocalDateTime(item.occurredAt)}</span>
                        </div>
                        <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{display.detail}</p>
                        <div className="mt-2 flex items-center justify-between gap-3">
                          {item.quoteId ? (
                            <button
                              type="button"
                              className="text-xs font-semibold text-quotefly-blue hover:underline"
                              onClick={() => closeActivityModal(() => navigateToQuote(item.quoteId!))}
                            >
                              {t("customers.activity.openQuote")}
                            </button>
                          ) : <span />}
                          <span className="text-[11px] font-medium text-[var(--qf-text-muted)]">{t("customers.activity.by", { name: activityActorLabel(item) })}</span>
                        </div>
                      </div>
                    </div>
                  );
                  })
                ) : (
                  <div className="p-4">
                    <EmptyState title={t("customers.activity.empty")} description={t("customers.activity.emptyDescription")} />
                  </div>
                )}
              </div>

              {activityTotal > ACTIVITY_PAGE_SIZE ? (
                <div className="flex flex-col gap-3 rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-[var(--qf-text-muted)]">
                    {t("customers.activity.showing", { from: Math.min((activityPage - 1) * ACTIVITY_PAGE_SIZE + 1, activityTotal), to: Math.min(activityPage * ACTIVITY_PAGE_SIZE, activityTotal), total: activityTotal })}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setActivityPage((current) => Math.max(1, current - 1))}
                      disabled={activityPage === 1 || activityLoading}
                    >
                      {t("common.previous")}
                    </Button>
                    <span className="text-xs font-medium text-[var(--qf-text-soft)]">
                      {t("common.pageOf", { page: activityPage, total: totalActivityPages })}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setActivityPage((current) => Math.min(totalActivityPages, current + 1))}
                      disabled={activityPage >= totalActivityPages || activityLoading}
                    >
                      {t("common.next")}
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </ModalBody>
        {selectedActivityRow ? (
          <ModalFooter className="justify-between">
            <div className="flex w-full flex-wrap gap-2 sm:w-auto">
              {!selectedCustomerInactive ? (
                selectedActivityRow.customer.followUpStatus === "LOST" ? (
                  <Button
                    variant="outline"
                    icon={<ArchiveRestore size={15} />}
                    disabled={detailsChanged || notesChanged}
                    title={detailsChanged || notesChanged ? t("customers.lifecycle.saveDraftsFirst") : undefined}
                    onClick={() => openCustomerLifecycle("reopen")}
                  >
                    {t("customers.lifecycle.reopenAction")}
                  </Button>
                ) : (
                  <Button
                    variant="danger"
                    icon={<XCircle size={15} />}
                    disabled={detailsChanged || notesChanged}
                    title={detailsChanged || notesChanged ? t("customers.lifecycle.saveDraftsFirst") : undefined}
                    onClick={() => openCustomerLifecycle("mark-lost")}
                  >
                    {t("customers.lifecycle.markLostAction")}
                  </Button>
                )
              ) : null}
              {canManageRecordRetention && (selectedActivityRow.customer.archivedAtUtc || selectedActivityRow.customer.deletedAtUtc) ? (
                <Button
                  variant="outline"
                  icon={<ArchiveRestore size={15} />}
                  onClick={() => setCustomerRetentionAction({ type: "restore", row: selectedActivityRow })}
                >
                  {t("customers.retention.restore")}
                </Button>
              ) : canManageRecordRetention ? (
                <>
                  <Button variant="outline" onClick={() => setCustomerRetentionAction({ type: "archive", row: selectedActivityRow })}>
                    {t("customers.retention.archive")}
                  </Button>
                  <Button variant="danger" onClick={() => setCustomerRetentionAction({ type: "delete", row: selectedActivityRow })}>
                    {t("customers.retention.delete")}
                  </Button>
                </>
              ) : null}
            </div>
            <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
              <KodyButton
                label="Kody"
                prompt={`${t("customers.activityTitle")}: ${selectedActivityRow.customer.fullName}. ${t("customers.listDescription")}`}
                tool="SEARCH_CUSTOMERS"
                context={{
                  currentPage: "customers",
                  customerId: selectedActivityRow.customer.id,
                  search: selectedActivityRow.customer.fullName,
                  limit: 1,
                }}
              />
              <Button className="min-w-0 flex-1 sm:flex-none" variant="outline" onClick={() => closeActivityModal()}>
                {t("common.close")}
              </Button>
              <Button
                className="min-w-0 flex-1 sm:flex-none"
                onClick={() => closeActivityModal(() => navigateToBuilder(selectedActivityRow.customer.id))}
                disabled={Boolean(selectedActivityRow.customer.archivedAtUtc || selectedActivityRow.customer.deletedAtUtc || selectedActivityRow.customer.followUpStatus === "LOST")}
                title={selectedActivityRow.customer.archivedAtUtc || selectedActivityRow.customer.deletedAtUtc
                  ? t("customers.restoreBeforeQuote")
                  : selectedActivityRow.customer.followUpStatus === "LOST"
                    ? t("customers.lifecycle.reopenBeforeQuote")
                    : undefined}
              >
                {t("customers.newQuote")}
              </Button>
            </div>
          </ModalFooter>
        ) : null}
      </Modal>

      {customerLifecycleMode ? (
        <CustomerLifecycleModal
          key={`${selectedActivityRow?.customer.id ?? "customer"}-${customerLifecycleMode}`}
          mode={customerLifecycleMode}
          customer={selectedActivityRow?.customer ?? null}
          open
          saving={customerLifecycleSaving}
          error={customerLifecycleError}
          followUpAutomationEnabled={followUpAutomationEnabled}
          onClose={() => {
            if (customerLifecycleSaving) return;
            setCustomerLifecycleMode(null);
            setCustomerLifecycleError(null);
          }}
          onMarkLost={(input) => void markSelectedCustomerLost(input)}
          onReopen={(input) => void reopenSelectedCustomer(input)}
        />
      ) : null}

      <ConfirmModal
        open={discardCustomerChangesOpen}
        onClose={() => {
          pendingCustomerCloseActionRef.current = null;
          setDiscardCustomerChangesOpen(false);
        }}
        onConfirm={discardCustomerChangesAndClose}
        title={t("customers.discardTitle")}
        description={t("customers.discardDescription")}
        confirmLabel={t("customers.discard")}
        confirmVariant="warning"
      />

      <ConfirmModal
        open={Boolean(customerRetentionAction)}
        onClose={() => {
          if (!customerRetentionSaving) setCustomerRetentionAction(null);
        }}
        onConfirm={() => void confirmCustomerRetentionAction()}
        title={
          customerRetentionAction?.type === "archive"
            ? t("customers.retention.archiveTitle")
            : customerRetentionAction?.type === "delete"
              ? t("customers.retention.deleteTitle")
              : t("customers.retention.restoreTitle")
        }
        description={
          customerRetentionAction?.type === "archive"
            ? t("customers.retention.archiveDescription")
            : customerRetentionAction?.type === "delete"
              ? t("customers.retention.deleteDescription")
              : t("customers.retention.restoreDescription")
        }
        confirmLabel={customerRetentionAction?.type === "archive" ? t("customers.retention.archiveConfirm") : customerRetentionAction?.type === "delete" ? t("customers.retention.deleteConfirm") : t("customers.retention.restoreConfirm")}
        loading={customerRetentionSaving}
        confirmVariant={customerRetentionAction?.type === "delete" ? "danger" : customerRetentionAction?.type === "archive" ? "warning" : "primary"}
      />
    </div>
  );
}






