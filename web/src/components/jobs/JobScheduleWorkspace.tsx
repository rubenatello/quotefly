import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { CalendarClock, ChevronLeft, ChevronRight, Clock3, ExternalLink, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { formatDateTime, useDashboard } from "../dashboard/DashboardContext";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Input,
  LoadingState,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Select,
  Textarea,
} from "../ui";
import {
  api,
  ApiError,
  type JobScheduleAppointment,
  type OrganizationUser,
  type AppointmentNotificationReceipt,
} from "../../lib/api";
import { localizedApiError } from "../../lib/localized-api-error";
import {
  resolveTenantWallTime,
  tenantWallTimeToIso,
  toTenantDateTimeInput,
  validTimeZone,
  type TenantWallTimeResolution,
} from "../../lib/tenant-time";
import { cn } from "../../lib/utils";
import { publishNotificationsUpdated } from "../../lib/notification-display";

export type ScheduleRange = "day" | "week" | "next7";
export type ScheduleAssignee = "all" | "me" | string;

type ScheduleWorkspaceProps = {
  range: ScheduleRange;
  selectedDate: string;
  assignee: ScheduleAssignee;
  canManageJobs: boolean;
  onRangeChange: (range: ScheduleRange) => void;
  onDateChange: (date: string) => void;
  onAssigneeChange: (assignee: ScheduleAssignee) => void;
};

type CalendarEventLayout = {
  appointment: JobScheduleAppointment;
  lane: number;
  laneCount: number;
  topPercent: number;
  heightPercent: number;
};

export type AppointmentReloadResult =
  | { kind: "current" | "outside"; appointment: JobScheduleAppointment }
  | { kind: "notScheduled" | "missing" | "network" | "limit" };

const FETCH_PAGE_SIZE = 100;
const CALENDAR_ITEM_CAP = 500;
const MIN_EVENT_HEIGHT_PX = 1;
const MIN_EVENT_HIT_TARGET_PX = 44;

function appointmentTone(status: JobScheduleAppointment["status"]): "blue" | "emerald" | "red" | "purple" {
  if (status === "COMPLETED") return "emerald";
  if (status === "CANCELED") return "red";
  if (status === "DISPATCHED" || status === "ARRIVED") return "blue";
  return "purple";
}

function addDateDays(dateValue: string, days: number) {
  const [year, month, day] = dateValue.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
}

function weekStart(dateValue: string) {
  const [year, month, day] = dateValue.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return addDateDays(dateValue, weekday === 0 ? -6 : 1 - weekday);
}

function dateRange(selectedDate: string, range: ScheduleRange) {
  const startDate = range === "week" ? weekStart(selectedDate) : selectedDate;
  return Array.from({ length: range === "day" ? 1 : 7 }, (_, index) => addDateDays(startDate, index));
}

function scheduleBounds(selectedDate: string, range: ScheduleRange, timeZone: string) {
  const days = dateRange(selectedDate, range);
  const fromUtc = tenantWallTimeToIso(`${days[0]}T00:00`, timeZone);
  const toUtc = tenantWallTimeToIso(`${addDateDays(days[days.length - 1], 1)}T00:00`, timeZone);
  return fromUtc && toUtc ? { fromUtc, toUtc } : null;
}

function formatCalendarDate(dateValue: string, locale: string | undefined, options: Intl.DateTimeFormatOptions) {
  const [year, month, day] = dateValue.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
}

function timeOfDayMinutes(value: string, timeZone: string) {
  const local = toTenantDateTimeInput(value, timeZone);
  const [hour, minute] = local.slice(11).split(":").map(Number);
  return hour * 60 + minute;
}

function overlapsDay(appointment: JobScheduleAppointment, dateValue: string, timeZone: string) {
  const from = tenantWallTimeToIso(`${dateValue}T00:00`, timeZone);
  const to = tenantWallTimeToIso(`${addDateDays(dateValue, 1)}T00:00`, timeZone);
  if (!from || !to) return false;
  return new Date(appointment.startsAtUtc) < new Date(to) && new Date(appointment.endsAtUtc) > new Date(from);
}

function appointmentsForDay(items: JobScheduleAppointment[], dateValue: string, timeZone: string) {
  return items
    .filter((appointment) => overlapsDay(appointment, dateValue, timeZone))
    .sort((left, right) => left.startsAtUtc.localeCompare(right.startsAtUtc));
}

function layoutDay(
  items: JobScheduleAppointment[],
  dateValue: string,
  timeZone: string,
  startMinute: number,
  endMinute: number,
  gridHeight: number,
): CalendarEventLayout[] {
  const dayItems = appointmentsForDay(items, dateValue, timeZone);
  const lanes: number[] = [];
  const duration = Math.max(1, endMinute - startMinute);
  const hitTargetMinutes = (MIN_EVENT_HIT_TARGET_PX / gridHeight) * duration;
  const assigned = dayItems.map((appointment) => {
    const localStart = toTenantDateTimeInput(appointment.startsAtUtc, timeZone);
    const localEnd = toTenantDateTimeInput(appointment.endsAtUtc, timeZone);
    const start = localStart.slice(0, 10) < dateValue
      ? startMinute
      : Math.max(startMinute, timeOfDayMinutes(appointment.startsAtUtc, timeZone));
    const end = localEnd.slice(0, 10) > dateValue
      ? endMinute
      : Math.min(endMinute, timeOfDayMinutes(appointment.endsAtUtc, timeZone));
    const visualEnd = Math.max(start, end);
    const hitCenter = start + (visualEnd - start) / 2;
    const hitStart = hitCenter - hitTargetMinutes / 2;
    const hitEnd = hitCenter + hitTargetMinutes / 2;
    const lane = lanes.findIndex((laneEnd) => laneEnd <= hitStart);
    const nextLane = lane === -1 ? lanes.length : lane;
    lanes[nextLane] = hitEnd;
    return { appointment, lane: nextLane, start, end };
  });
  const laneCount = Math.max(1, lanes.length);
  return assigned.map(({ appointment, lane, start, end }) => ({
    appointment,
    lane,
    laneCount,
    topPercent: ((start - startMinute) / duration) * 100,
    heightPercent: Math.max((MIN_EVENT_HEIGHT_PX / gridHeight) * 100, ((Math.max(start, end) - start) / duration) * 100),
  }));
}

function resolutionChoice(
  resolution: TenantWallTimeResolution,
  selectedIndex: number | null,
): string | null {
  if (resolution.kind === "valid") return resolution.choices[0].iso;
  if (resolution.kind === "ambiguous" && selectedIndex !== null) return resolution.choices[selectedIndex]?.iso ?? null;
  return null;
}

function ScheduleAppointmentCard({
  appointment,
  timeZone,
  canReschedule,
  onReschedule,
}: {
  appointment: JobScheduleAppointment;
  timeZone: string;
  canReschedule: boolean;
  onReschedule: (appointment: JobScheduleAppointment) => void;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  return (
    <article className="rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)] p-4 shadow-[var(--qf-shadow-sm)]">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={appointmentTone(appointment.status)}>{t(`domain.appointmentStatus.${appointment.status}`)}</Badge>
        <span className="text-xs font-semibold text-[var(--qf-text-muted)]">
          {t("jobs.jobNumber", { number: appointment.job.jobNumber })}
        </span>
      </div>
      <h3 className="mt-2 font-semibold text-[var(--qf-text)]">{appointment.job.customer.fullName}</h3>
      <p className="mt-1 line-clamp-2 text-sm text-[var(--qf-text-soft)]">{appointment.job.title}</p>
      <dl className="mt-3 space-y-1 text-xs text-[var(--qf-text-muted)]">
        <div className="flex gap-2">
          <Clock3 className="mt-0.5 shrink-0" size={14} aria-hidden="true" />
          <dd>{t("jobs.scheduledWindow", {
            start: formatDateTime(appointment.startsAtUtc, i18n.resolvedLanguage, timeZone),
            end: formatDateTime(appointment.endsAtUtc, i18n.resolvedLanguage, timeZone),
          })}</dd>
        </div>
        <div className="flex gap-2">
          <Users className="mt-0.5 shrink-0" size={14} aria-hidden="true" />
          <dd>{t("jobs.appointmentAssignedTo", { name: appointment.assignedTenantUser.user.fullName })}</dd>
        </div>
      </dl>
      <p className="mt-2 line-clamp-2 text-xs text-[var(--qf-text-muted)]">
        {appointment.job.serviceAddressSnapshot || t("jobs.noAddress")}
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button variant="outline" className="min-h-11" onClick={() => navigate(`/app/jobs/${appointment.job.id}`)}>
          <ExternalLink size={15} />
          {t("jobs.openJob")}
        </Button>
        {canReschedule ? (
          <Button className="min-h-11" onClick={() => onReschedule(appointment)}>
            {t("jobs.reschedule")}
          </Button>
        ) : (
          <span className="flex min-h-11 items-center justify-center rounded-xl bg-[var(--qf-panel-muted)] px-3 text-center text-xs font-medium text-[var(--qf-text-muted)]">
            {t("jobs.scheduleReadOnly")}
          </span>
        )}
      </div>
    </article>
  );
}

export function RescheduleModal({
  appointment,
  timeZone,
  onClose,
  onSaved,
  onReloadVersion,
  editInstructions = false,
  initialInstructions = null,
}: {
  appointment: JobScheduleAppointment | null;
  timeZone: string;
  onClose: () => void;
  onSaved: (savedWindow: {
    startsAtUtc: string;
    endsAtUtc: string;
    /** Derived from the server's returned optimistic-concurrency version. */
    changed: boolean;
    notificationReceipt: AppointmentNotificationReceipt | null;
  }) => Promise<void>;
  onReloadVersion: (appointment: JobScheduleAppointment) => Promise<AppointmentReloadResult>;
  editInstructions?: boolean;
  initialInstructions?: string | null;
}) {
  const { t, i18n } = useTranslation();
  const [current, setCurrent] = useState<JobScheduleAppointment | null>(appointment);
  const [startsAt, setStartsAt] = useState(appointment ? toTenantDateTimeInput(appointment.startsAtUtc, timeZone) : "");
  const [endsAt, setEndsAt] = useState(appointment ? toTenantDateTimeInput(appointment.endsAtUtc, timeZone) : "");
  const [startChoice, setStartChoice] = useState<number | null>(null);
  const [endChoice, setEndChoice] = useState<number | null>(null);
  const [instructions, setInstructions] = useState(initialInstructions ?? "");
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflictWindow, setConflictWindow] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);

  useEffect(() => {
    setCurrent(appointment);
    setStartsAt(appointment ? toTenantDateTimeInput(appointment.startsAtUtc, timeZone) : "");
    setEndsAt(appointment ? toTenantDateTimeInput(appointment.endsAtUtc, timeZone) : "");
    setStartChoice(null);
    setEndChoice(null);
    setInstructions(initialInstructions ?? "");
    setError(null);
    setConflictWindow(null);
    setStale(false);
    setRecoveryNotice(null);
    setRecoveryBlocked(false);
  }, [appointment, initialInstructions, timeZone]);

  const startResolution = useMemo(() => resolveTenantWallTime(startsAt, timeZone), [startsAt, timeZone]);
  const endResolution = useMemo(() => resolveTenantWallTime(endsAt, timeZone), [endsAt, timeZone]);

  useEffect(() => {
    if (!current || startResolution.kind !== "ambiguous") return;
    const match = startResolution.choices.findIndex((choice) => choice.iso === current.startsAtUtc);
    if (match >= 0) setStartChoice(match);
  }, [current, startResolution]);

  useEffect(() => {
    if (!current || endResolution.kind !== "ambiguous") return;
    const match = endResolution.choices.findIndex((choice) => choice.iso === current.endsAtUtc);
    if (match >= 0) setEndChoice(match);
  }, [current, endResolution]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!current || saving || recoveryBlocked) return;
    setError(null);
    setConflictWindow(null);
    setStale(false);
    setRecoveryNotice(null);
    if (startResolution.kind === "invalid" || startResolution.kind === "nonexistent" || endResolution.kind === "invalid" || endResolution.kind === "nonexistent") {
      setError(t("jobs.invalidOrMissingWallTime"));
      return;
    }
    const startsAtUtc = resolutionChoice(startResolution, startChoice);
    const endsAtUtc = resolutionChoice(endResolution, endChoice);
    if (!startsAtUtc || !endsAtUtc) {
      setError(t("jobs.chooseAmbiguousTime"));
      return;
    }
    if (new Date(startsAtUtc) >= new Date(endsAtUtc)) {
      setError(t("jobs.endAfterStart"));
      return;
    }
    setSaving(true);
    try {
      const response = await api.jobs.appointments.update(current.jobId, current.id, {
        version: current.version,
        startsAtUtc,
        endsAtUtc,
        timeZone,
        ...(editInstructions ? { instructions: instructions.trim() || null } : {}),
      });
      publishNotificationsUpdated(response.notificationReceipt?.createdCount ?? 0);
      // The API intentionally returns the current appointment unchanged for a
      // manager no-op. Compare its optimistic-concurrency version rather than
      // inferring a change from a successful PATCH response.
      await onSaved({
        startsAtUtc,
        endsAtUtc,
        changed: response.appointment.version !== current.version,
        notificationReceipt: response.notificationReceipt ?? null,
      });
      onClose();
    } catch (err) {
      setError(localizedApiError(err, t, { fallbackKey: "jobs.bookingSaveError" }));
      if (err instanceof ApiError && err.code === "JOB_APPOINTMENT_STALE_VERSION") setStale(true);
      if (err instanceof ApiError && err.code === "JOB_APPOINTMENT_OVERLAP" && err.details && typeof err.details === "object") {
        const details = err.details as Record<string, unknown>;
        if (typeof details.conflictingStartsAtUtc === "string" && typeof details.conflictingEndsAtUtc === "string") {
          setConflictWindow(t("jobs.conflictingWindow", {
            start: formatDateTime(details.conflictingStartsAtUtc, i18n.resolvedLanguage, timeZone),
            end: formatDateTime(details.conflictingEndsAtUtc, i18n.resolvedLanguage, timeZone),
          }));
        }
      }
    } finally {
      setSaving(false);
    }
  };

  const reloadVersion = async () => {
    if (!current || reloading) return;
    setReloading(true);
    const result = await onReloadVersion(current);
    if (result.kind === "current" || result.kind === "outside") {
      setCurrent(result.appointment);
      setStale(false);
      setError(null);
      setRecoveryBlocked(false);
      setRecoveryNotice(result.kind === "outside" ? t("jobs.bookingMovedOutsideRange") : t("jobs.bookingVersionReloaded"));
    } else if (result.kind === "notScheduled") {
      setStale(false);
      setRecoveryBlocked(true);
      setError(t("jobs.bookingNoLongerScheduled"));
    } else if (result.kind === "missing") {
      setStale(false);
      setRecoveryBlocked(true);
      setError(t("jobs.bookingNotFoundAfterReload"));
    } else if (result.kind === "limit") {
      setError(t("jobs.bookingReloadLimit"));
    } else {
      setError(t("jobs.bookingReloadNetwork"));
    }
    setReloading(false);
  };

  const ambiguousSelect = (
    resolution: TenantWallTimeResolution,
    value: number | null,
    onChange: (value: number | null) => void,
    label: string,
  ) => resolution.kind === "ambiguous" ? (
    <Select
      label={label}
      value={value === null ? "" : String(value)}
      onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
      options={[
        { value: "", label: t("jobs.chooseTimeOffset") },
        ...resolution.choices.map((choice, index) => ({
          value: String(index),
          label: `${choice.zoneName} (${choice.offsetLabel})`,
        })),
      ]}
    />
  ) : null;

  return (
    <Modal open={Boolean(appointment)} onClose={onClose} size="md" closeOnBackdrop={!saving} ariaLabel={t("jobs.rescheduleTitle")}>
      <ModalHeader
        title={t("jobs.rescheduleTitle")}
        description={current ? t("jobs.rescheduleDescription", { customer: current.job.customer.fullName }) : undefined}
        onClose={saving ? undefined : onClose}
      />
      <form onSubmit={handleSubmit}>
        <ModalBody className="space-y-4">
          {current ? (
            <div className="rounded-xl bg-[var(--qf-panel-muted)] p-3 text-sm">
              <p className="font-semibold text-[var(--qf-text)]">{t("jobs.jobNumber", { number: current.job.jobNumber })} — {current.job.title}</p>
              <p className="mt-1 text-[var(--qf-text-soft)]">{current.assignedTenantUser.user.fullName}</p>
              <p className="mt-1 text-xs text-[var(--qf-text-muted)]">{t("jobs.timeZone", { timeZone })}</p>
            </div>
          ) : null}
          <Input
            label={t("jobs.startTime")}
            type="datetime-local"
            value={startsAt}
            onChange={(event) => {
              setStartsAt(event.target.value);
              setStartChoice(null);
            }}
            disabled={saving}
            required
          />
          {ambiguousSelect(startResolution, startChoice, setStartChoice, t("jobs.startTimeOffset"))}
          {(startResolution.kind === "nonexistent" || startResolution.kind === "invalid") && startsAt ? (
            <p className="text-sm text-[var(--qf-danger)]" role="alert">{t("jobs.nonexistentWallTime")}</p>
          ) : null}
          <Input
            label={t("jobs.endTime")}
            type="datetime-local"
            value={endsAt}
            onChange={(event) => {
              setEndsAt(event.target.value);
              setEndChoice(null);
            }}
            disabled={saving}
            required
          />
          {ambiguousSelect(endResolution, endChoice, setEndChoice, t("jobs.endTimeOffset"))}
          {(endResolution.kind === "nonexistent" || endResolution.kind === "invalid") && endsAt ? (
            <p className="text-sm text-[var(--qf-danger)]" role="alert">{t("jobs.nonexistentWallTime")}</p>
          ) : null}
          {editInstructions ? (
            <Textarea
              label={t("jobs.bookingInstructions")}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              maxLength={2000}
              disabled={saving}
              placeholder={t("jobs.bookingInstructionsPlaceholder")}
            />
          ) : null}
          {error ? (
            <Alert tone="error">
              <div className="space-y-2">
                <p>{error}</p>
                {conflictWindow ? <p className="font-medium">{conflictWindow}</p> : null}
                {stale ? (
                  <Button type="button" variant="outline" className="min-h-11" loading={reloading} onClick={() => void reloadVersion()}>
                    {t("jobs.reloadVersionKeepEdits")}
                  </Button>
                ) : null}
              </div>
            </Alert>
          ) : null}
          {recoveryNotice ? <Alert tone="warning">{recoveryNotice}</Alert> : null}
          <p className="text-xs leading-5 text-[var(--qf-text-muted)]">{t("jobs.rescheduleReviewNotice")}</p>
        </ModalBody>
        <ModalFooter>
          <Button type="button" variant="outline" className="min-h-11" disabled={saving} onClick={onClose}>{t("jobs.keepCurrentTime")}</Button>
          <Button type="submit" className="min-h-11" loading={saving} disabled={!current || saving || recoveryBlocked}>{t("jobs.confirmReschedule")}</Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

export function JobScheduleWorkspace({
  range,
  selectedDate,
  assignee,
  canManageJobs,
  onRangeChange,
  onDateChange,
  onAssigneeChange,
}: ScheduleWorkspaceProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { session } = useDashboard();
  const timeZone = validTimeZone(session?.timezone ?? "UTC");
  const [items, setItems] = useState<JobScheduleAppointment[]>([]);
  const [team, setTeam] = useState<OrganizationUser[]>([]);
  const [teamLoading, setTeamLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [incomplete, setIncomplete] = useState(false);
  const [editing, setEditing] = useState<JobScheduleAppointment | null>(null);
  const scheduleRequestRef = useRef(0);
  const rescheduleTriggerRef = useRef<HTMLElement | null>(null);
  const days = useMemo(() => dateRange(selectedDate, range), [range, selectedDate]);
  // A rolling Kody window must retain its exact first day (including a
  // weekend), rather than using the Monday-aligned week-strip.
  const stripDays = days;
  const bounds = useMemo(() => scheduleBounds(selectedDate, range, timeZone), [range, selectedDate, timeZone]);

  useEffect(() => {
    if (!canManageJobs) return;
    let cancelled = false;
    setTeamLoading(true);
    api.org.users.list({ limit: 100, offset: 0 })
      .then((response) => {
        if (!cancelled) setTeam(response.members);
      })
      .catch(() => {
        if (!cancelled) setTeam([]);
      })
      .finally(() => {
        if (!cancelled) setTeamLoading(false);
      });
    return () => { cancelled = true; };
  }, [canManageJobs]);

  const loadSchedule = useCallback(async (): Promise<JobScheduleAppointment[]> => {
    const requestId = ++scheduleRequestRef.current;
    if (!bounds) {
      setError(t("jobs.invalidWallTime"));
      setItems([]);
      setLoading(false);
      return [];
    }
    setLoading(true);
    setError(null);
    setIncomplete(false);
    const queryScope = assignee === "me"
      ? { mine: true }
      : assignee === "all"
        ? {}
        : { assignedTenantUserId: assignee };
    try {
      const first = await api.jobs.schedule({ ...bounds, ...queryScope, limit: FETCH_PAGE_SIZE, offset: 0 });
      if (requestId !== scheduleRequestRef.current) return [];
      if (first.pagination.total > CALENDAR_ITEM_CAP) {
        setItems([]);
        setIncomplete(true);
        return [];
      }
      const collected = [...first.items];
      for (let offset = FETCH_PAGE_SIZE; offset < first.pagination.total; offset += FETCH_PAGE_SIZE) {
        const page = await api.jobs.schedule({ ...bounds, ...queryScope, limit: FETCH_PAGE_SIZE, offset });
        if (requestId !== scheduleRequestRef.current) return [];
        collected.push(...page.items);
      }
      if (collected.length !== first.pagination.total) {
        setItems([]);
        setIncomplete(true);
        return [];
      }
      setItems(collected);
      return collected;
    } catch (err) {
      if (requestId === scheduleRequestRef.current) {
        setItems([]);
        setError(localizedApiError(err, t, { fallbackKey: "jobs.loadScheduleError" }));
      }
      return [];
    } finally {
      if (requestId === scheduleRequestRef.current) setLoading(false);
    }
  }, [assignee, bounds, t]);

  useEffect(() => {
    void loadSchedule();
    return () => {
      scheduleRequestRef.current += 1;
    };
  }, [loadSchedule]);

  const today = toTenantDateTimeInput(new Date(), timeZone).slice(0, 10);
  const selectedItems = useMemo(() => appointmentsForDay(items, selectedDate, timeZone), [items, selectedDate, timeZone]);
  const rangeLabel = range === "day"
    ? formatCalendarDate(selectedDate, i18n.resolvedLanguage, { weekday: "long", month: "long", day: "numeric", year: "numeric" })
    : t("jobs.weekRangeLabel", {
      start: formatCalendarDate(days[0], i18n.resolvedLanguage, { month: "short", day: "numeric" }),
      end: formatCalendarDate(days[days.length - 1], i18n.resolvedLanguage, { month: "short", day: "numeric", year: "numeric" }),
    });

  const timeBounds = useMemo(() => {
    if (items.length === 0) return { start: 7 * 60, end: 18 * 60 };
    if (items.some((item) => toTenantDateTimeInput(item.startsAtUtc, timeZone).slice(0, 10) !== toTenantDateTimeInput(item.endsAtUtc, timeZone).slice(0, 10))) {
      return { start: 0, end: 24 * 60 };
    }
    const starts = items.map((item) => timeOfDayMinutes(item.startsAtUtc, timeZone));
    const ends = items.map((item) => timeOfDayMinutes(item.endsAtUtc, timeZone));
    const start = Math.max(0, Math.min(7 * 60, Math.floor(Math.min(...starts) / 60) * 60));
    const rawEnd = Math.max(18 * 60, Math.ceil(Math.max(...ends) / 60) * 60);
    return { start, end: Math.min(24 * 60, rawEnd <= start ? 24 * 60 : rawEnd) };
  }, [items, timeZone]);
  const hourMarks = useMemo(() => Array.from(
    { length: Math.floor((timeBounds.end - timeBounds.start) / 60) + 1 },
    (_, index) => timeBounds.start + index * 60,
  ), [timeBounds.end, timeBounds.start]);
  const gridHeight = Math.max(660, ((timeBounds.end - timeBounds.start) / 60) * 68);

  const moveDate = (direction: -1 | 1) => onDateChange(addDateDays(selectedDate, direction * (range === "day" ? 1 : 7)));
  const openReschedule = (appointment: JobScheduleAppointment) => {
    if (canManageJobs && appointment.status === "SCHEDULED") {
      rescheduleTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setEditing(appointment);
    }
  };
  const closeReschedule = () => {
    setEditing(null);
    window.setTimeout(() => rescheduleTriggerRef.current?.focus(), 0);
  };

  return (
    <section className="min-w-0 rounded-3xl border border-[var(--qf-border)] bg-[var(--qf-panel)] shadow-[var(--qf-shadow-sm)]">
      <div className="border-b border-[var(--qf-border)] p-4 sm:p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("jobs.scheduleEyebrow")}</p>
            <h2 className="mt-1 flex items-center gap-2 text-lg font-semibold text-[var(--qf-text)]">
              <CalendarClock size={19} aria-hidden="true" />
              {t("jobs.scheduleBoardTitle")}
            </h2>
            <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{t("jobs.scheduleBoardDescription")}</p>
          </div>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end xl:justify-end">
            <div className="grid grid-cols-3 gap-2" role="group" aria-label={t("jobs.scheduleRangeLabel")}>
              {(["day", "week", "next7"] as const).map((option) => (
                <Button key={option} type="button" variant={range === option ? "primary" : "outline"} className="min-h-11" aria-pressed={range === option} onClick={() => onRangeChange(option)}>
                  {t(`jobs.scheduleRange.${option}`)}
                </Button>
              ))}
            </div>
            {canManageJobs ? (
              <Select
                label={t("jobs.scheduleAssignee")}
                value={assignee}
                disabled={teamLoading}
                onChange={(event) => onAssigneeChange(event.target.value)}
                options={[
                  { value: "all", label: t("jobs.allTeam") },
                  { value: "me", label: t("jobs.mySchedule") },
                  ...team.map((member) => ({ value: member.id, label: member.user.fullName })),
                ]}
              />
            ) : (
              <div className="flex min-h-11 items-center rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-3 text-sm font-medium text-[var(--qf-text)]">
                <Users className="mr-2" size={16} aria-hidden="true" />{t("jobs.mySchedule")}
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" className="min-h-11 min-w-11 px-3" aria-label={t("jobs.previousRange")} onClick={() => moveDate(-1)}><ChevronLeft size={18} /></Button>
            <Button type="button" variant="outline" className="min-h-11" onClick={() => onDateChange(today)}>{t("jobs.today")}</Button>
            <Button type="button" variant="outline" className="min-h-11 min-w-11 px-3" aria-label={t("jobs.nextRange")} onClick={() => moveDate(1)}><ChevronRight size={18} /></Button>
          </div>
          <div className="min-w-0 sm:text-right">
            <p className="truncate font-semibold text-[var(--qf-text)]" data-testid="schedule-window">{rangeLabel}</p>
            <p className="mt-0.5 text-xs text-[var(--qf-text-muted)]">{t("jobs.timeZone", { timeZone })}</p>
          </div>
        </div>
      </div>

      <div className="min-w-0 p-4 sm:p-5">
        {notice ? <div className="mb-4"><Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert></div> : null}
        <div className="max-w-full overflow-x-hidden pb-2">
          <div className="max-w-full overflow-x-auto px-1">
            <div className="flex w-max gap-2 md:grid md:w-full md:grid-cols-7" aria-label={t("jobs.chooseScheduleDate")}>
            {stripDays.map((date) => {
            const count = appointmentsForDay(items, date, timeZone).length;
            const selected = date === selectedDate;
            return (
              <button
                key={date}
                type="button"
                aria-pressed={selected}
                aria-current={selected ? "date" : undefined}
                className={cn(
                  "min-h-14 min-w-[68px] rounded-xl border px-2 py-2 text-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--qf-focus)] focus-visible:ring-offset-2 md:min-w-0",
                  selected ? "border-[var(--qf-action-primary)] bg-[var(--qf-action-primary)] text-[var(--qf-action-primary-text)]" : "border-[var(--qf-border)] bg-[var(--qf-panel-muted)] text-[var(--qf-text)] hover:border-[var(--qf-border-strong)]",
                )}
                onClick={() => onDateChange(date)}
              >
                <span className={cn("block text-[11px] uppercase tracking-wide", selected ? "text-[var(--qf-action-primary-text)]" : "text-[var(--qf-text-muted)]")}>{formatCalendarDate(date, i18n.resolvedLanguage, { weekday: "short" })}</span>
                <span className="mt-0.5 block text-sm font-semibold">{formatCalendarDate(date, i18n.resolvedLanguage, { day: "numeric" })}</span>
                <span className="sr-only">{t("jobs.bookingCount", { count })}</span>
              </button>
            );
              })}
            </div>
          </div>
        </div>

        <div className="mt-4">
          {loading ? <LoadingState title={t("jobs.loadingSchedule")} /> : error ? (
            <Alert tone="error">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <span>{error}</span>
                <Button type="button" variant="outline" className="min-h-11" onClick={() => void loadSchedule()}>{t("jobs.retry")}</Button>
              </div>
            </Alert>
          ) : incomplete ? (
            <EmptyState
              icon={<CalendarClock size={22} />}
              title={t("jobs.scheduleTooLarge")}
              description={t("jobs.scheduleTooLargeDescription", { count: CALENDAR_ITEM_CAP })}
            />
          ) : items.length === 0 ? (
            <EmptyState icon={<CalendarClock size={22} />} title={t("jobs.noSchedule")} description={t("jobs.noScheduleDescription")} />
          ) : (
            <>
              <div className="space-y-3 xl:hidden">
                <div>
                  <h3 className="font-semibold text-[var(--qf-text)]">{formatCalendarDate(selectedDate, i18n.resolvedLanguage, { weekday: "long", month: "long", day: "numeric" })}</h3>
                  <p className="mt-1 text-sm text-[var(--qf-text-muted)]" aria-live="polite" aria-atomic="true">{t("jobs.bookingCount", { count: selectedItems.length })}</p>
                </div>
                {selectedItems.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-[var(--qf-border)] p-5 text-sm text-[var(--qf-text-muted)]">{t("jobs.noScheduleForDay")}</div>
                ) : selectedItems.map((appointment) => (
                  <ScheduleAppointmentCard key={appointment.id} appointment={appointment} timeZone={timeZone} canReschedule={canManageJobs && appointment.status === "SCHEDULED"} onReschedule={openReschedule} />
                ))}
              </div>

              <div className="hidden min-w-0 xl:block" data-testid="schedule-week-grid">
                <div className="grid min-w-0 border-b border-[var(--qf-border)]" style={{ gridTemplateColumns: `72px repeat(${days.length}, minmax(0, 1fr))` }}>
                  <div />
                  {days.map((date) => (
                    <button key={date} type="button" aria-current={date === selectedDate ? "date" : undefined} className={cn("min-h-14 border-l border-[var(--qf-border)] px-2 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--qf-focus)]", date === selectedDate && "bg-[var(--qf-focus-ring)]")} onClick={() => onDateChange(date)}>
                      <span className="block text-xs text-[var(--qf-text-muted)]">{formatCalendarDate(date, i18n.resolvedLanguage, { weekday: "short" })}</span>
                      <span className="mt-0.5 block truncate text-sm font-semibold text-[var(--qf-text)]">{formatCalendarDate(date, i18n.resolvedLanguage, { month: "short", day: "numeric" })}</span>
                    </button>
                  ))}
                </div>
                <div className="grid min-w-0" style={{ gridTemplateColumns: `72px repeat(${days.length}, minmax(0, 1fr))`, height: `${gridHeight}px` }}>
                  <div className="relative border-r border-[var(--qf-border)]" aria-hidden="true">
                    {hourMarks.map((minute) => (
                      <span key={minute} className="absolute right-2 -translate-y-1/2 text-[11px] text-[var(--qf-text-muted)]" style={{ top: `${((minute - timeBounds.start) / (timeBounds.end - timeBounds.start)) * 100}%` }}>
                        {new Intl.DateTimeFormat(i18n.resolvedLanguage, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(Date.UTC(2020, 0, 1, 0, minute)))}
                      </span>
                    ))}
                  </div>
                  {days.map((date) => {
                    const layout = layoutDay(items, date, timeZone, timeBounds.start, timeBounds.end, gridHeight);
                    return (
                      <div key={date} className="relative min-w-0 border-r border-[var(--qf-border)] last:border-r-0">
                        {hourMarks.map((minute) => <span key={minute} aria-hidden="true" className="absolute inset-x-0 border-t border-[var(--qf-border)]/70" style={{ top: `${((minute - timeBounds.start) / (timeBounds.end - timeBounds.start)) * 100}%` }} />)}
                        {layout.map(({ appointment, lane, laneCount, topPercent, heightPercent }) => {
                          const canReschedule = canManageJobs && appointment.status === "SCHEDULED";
                          const style: CSSProperties = {
                            top: `${topPercent}%`,
                            height: `${heightPercent}%`,
                            left: `calc(${(lane / laneCount) * 100}% + 2px)`,
                            width: `calc(${100 / laneCount}% - 4px)`,
                          };
                          return (
                            <button
                              key={`${date}:${appointment.id}`}
                              type="button"
                              style={style}
                              className="absolute z-10 rounded-lg border border-[var(--qf-focus)]/40 bg-[var(--qf-focus-ring)] text-left text-[11px] leading-tight text-[var(--qf-text)] shadow-sm outline-none before:absolute before:left-0 before:top-1/2 before:h-11 before:w-full before:-translate-y-1/2 before:content-[''] hover:z-20 hover:border-[var(--qf-focus)] focus-visible:z-30 focus-visible:ring-2 focus-visible:ring-[var(--qf-focus)]"
                              onClick={() => canReschedule ? openReschedule(appointment) : navigate(`/app/jobs/${appointment.job.id}`)}
                              aria-label={t("jobs.calendarEventLabel", {
                                start: formatDateTime(appointment.startsAtUtc, i18n.resolvedLanguage, timeZone),
                                customer: appointment.job.customer.fullName,
                                assignee: appointment.assignedTenantUser.user.fullName,
                                action: canReschedule ? t("jobs.reschedule") : t("jobs.openJob"),
                              })}
                            >
                              <span className="relative block h-full overflow-hidden p-1.5">
                                <span className="block truncate font-semibold">{appointment.job.customer.fullName}</span>
                                <span className="mt-0.5 block truncate text-[var(--qf-text-soft)]">{toTenantDateTimeInput(appointment.startsAtUtc, timeZone).slice(11)} — {appointment.assignedTenantUser.user.fullName}</span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <RescheduleModal
        appointment={editing}
        timeZone={timeZone}
        onClose={closeReschedule}
        onSaved={async ({ changed, notificationReceipt }) => {
          const base = changed ? t("jobs.bookingUpdated") : t("jobs.rescheduleNoChanges");
          setNotice(notificationReceipt
            ? `${base} ${t(notificationReceipt.createdCount > 0 ? "jobs.inAppNotificationAvailable" : "jobs.noInAppNotificationCreated")}`
            : base);
          if (changed) await loadSchedule();
        }}
        onReloadVersion={async (appointment) => {
          try {
            let offset = 0;
            while (offset < CALENDAR_ITEM_CAP) {
              const response = await api.jobs.appointments.list(appointment.jobId, { limit: FETCH_PAGE_SIZE, offset });
              const latest = response.items.find((item) => item.id === appointment.id);
              if (latest) {
                if (latest.status !== "SCHEDULED") return { kind: "notScheduled" };
                const compact: JobScheduleAppointment = {
                  id: latest.id,
                  jobId: latest.jobId,
                  assignedTenantUserId: latest.assignedTenantUserId,
                  status: latest.status,
                  startsAtUtc: latest.startsAtUtc,
                  endsAtUtc: latest.endsAtUtc,
                  timeZone: latest.timeZone,
                  version: latest.version,
                  assignedTenantUser: latest.assignedTenantUser,
                  job: appointment.job,
                };
                const inside = bounds
                  ? new Date(compact.startsAtUtc) < new Date(bounds.toUtc) && new Date(compact.endsAtUtc) > new Date(bounds.fromUtc)
                  : false;
                return { kind: inside ? "current" : "outside", appointment: compact };
              }
              offset += FETCH_PAGE_SIZE;
              if (offset >= response.pagination.total) return { kind: "missing" };
            }
            return { kind: "limit" };
          } catch {
            return { kind: "network" };
          }
        }}
      />
    </section>
  );
}
