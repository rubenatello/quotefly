import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, BriefcaseBusiness, CalendarClock, CheckCircle2, ExternalLink, NotebookPen, Search, Send, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { KodyButton } from "../components/ai/KodyButton";
import { InvoicePanel } from "../components/invoices/InvoicePanel";
import { api, ApiError, type Job, type JobAppointment, type JobAppointmentStatus, type JobNote, type JobScheduleAppointment, type JobStatus, type OrgUserRole } from "../lib/api";
import { localizedApiError } from "../lib/localized-api-error";
import { tenantWallTimeToIso, toTenantDateTimeInput, validTimeZone } from "../lib/tenant-time";
import { cn } from "../lib/utils";
import { formatDateTime, money, useDashboard } from "../components/dashboard/DashboardContext";
import {
  Alert,
  Badge,
  Button,
  ConfirmModal,
  EmptyState,
  Input,
  LoadingState,
  PaginationControls,
  Select,
  Textarea,
  type PageSize,
} from "../components/ui";

const JOB_STATUS_FILTERS: Array<JobStatus | "active"> = [
  "active",
  "UNSCHEDULED",
  "SCHEDULED",
  "DISPATCHED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELED",
];

type JobAssigneeOption = {
  id: string;
  role: OrgUserRole;
  user: {
    fullName: string;
  };
};

function jobStatusTone(status: JobStatus): "blue" | "orange" | "emerald" | "red" | "slate" | "purple" {
  if (status === "COMPLETED") return "emerald";
  if (status === "CANCELED") return "red";
  if (status === "DISPATCHED" || status === "IN_PROGRESS") return "blue";
  if (status === "SCHEDULED") return "purple";
  if (status === "UNSCHEDULED") return "orange";
  return "slate";
}

function appointmentStatusTone(status: JobAppointmentStatus): "blue" | "orange" | "emerald" | "red" | "slate" | "purple" {
  if (status === "COMPLETED") return "emerald";
  if (status === "CANCELED") return "red";
  if (status === "DISPATCHED" || status === "ARRIVED") return "blue";
  if (status === "SCHEDULED") return "purple";
  return "slate";
}

const APPOINTMENT_ACTIONS: Readonly<Record<JobAppointmentStatus, readonly JobAppointmentStatus[]>> = {
  SCHEDULED: ["DISPATCHED", "CANCELED"],
  DISPATCHED: ["ARRIVED", "CANCELED"],
  ARRIVED: ["COMPLETED", "CANCELED"],
  COMPLETED: [],
  CANCELED: [],
};

function defaultAppointmentInputs(timeZone: string) {
  const now = new Date();
  const start = new Date(now.getTime() + 60 * 60 * 1000);
  start.setUTCMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  return {
    startsAt: toTenantDateTimeInput(start, timeZone),
    endsAt: toTenantDateTimeInput(end, timeZone),
  };
}

function addLocalDays(dateValue: string, days: number) {
  const [year, month, day] = dateValue.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function scheduleWindow(timeZone: string, range: "today" | "week") {
  const today = toTenantDateTimeInput(new Date(), timeZone).slice(0, 10);
  const endDate = addLocalDays(today, range === "today" ? 1 : 7);
  const fromUtc = tenantWallTimeToIso(`${today}T00:00`, timeZone);
  const toUtc = tenantWallTimeToIso(`${endDate}T00:00`, timeZone);
  return fromUtc && toUtc ? { fromUtc, toUtc } : null;
}

function appointmentActionLabel(status: JobAppointmentStatus, t: ReturnType<typeof useTranslation>["t"]) {
  if (status === "DISPATCHED") return t("jobs.dispatch");
  if (status === "ARRIVED") return t("jobs.markArrived");
  if (status === "COMPLETED") return t("jobs.markComplete");
  if (status === "CANCELED") return t("jobs.cancelBooking");
  return t(`domain.appointmentStatus.${status}`);
}

function useJobDateFormatter() {
  const { i18n } = useTranslation();
  const { session } = useDashboard();
  const timezone = session?.timezone ?? "UTC";
  return useCallback(
    (value: string | null | undefined) => value ? formatDateTime(value, i18n.resolvedLanguage, timezone) : "—",
    [i18n.resolvedLanguage, timezone],
  );
}

function JobCard({
  job,
  active,
  onOpen,
  onOpenQuote,
}: {
  job: Job;
  active: boolean;
  onOpen: (job: Job) => void;
  onOpenQuote: (job: Job) => void;
}) {
  const { t, i18n } = useTranslation();
  const formatDate = useJobDateFormatter();
  const assigneeName = job.assignedTenantUser?.user.fullName ?? t("jobs.unassigned");

  return (
    <article
      className={cn(
        "rounded-2xl border bg-[var(--qf-panel)] p-4 shadow-[var(--qf-shadow-sm)] transition-colors",
        active ? "border-[var(--qf-focus)] ring-2 ring-[var(--qf-focus)]/25" : "border-[var(--qf-border)]",
      )}
    >
      <div className="flex flex-col gap-3 lg:grid lg:grid-cols-[minmax(0,1.4fr)_minmax(180px,.7fr)_minmax(170px,.6fr)_auto] lg:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-[var(--qf-panel-muted)] px-2.5 py-1 text-xs font-semibold text-[var(--qf-text)]">
              {t("jobs.jobNumber", { number: job.jobNumber })}
            </span>
            <Badge tone={jobStatusTone(job.status)}>{t(`domain.jobStatus.${job.status}`)}</Badge>
          </div>
          <h2 className="mt-2 truncate text-base font-semibold text-[var(--qf-text)]">{job.customer.fullName}</h2>
          <p className="mt-1 line-clamp-2 text-sm text-[var(--qf-text-soft)]">{job.title}</p>
        </div>
        <div className="min-w-0 text-sm">
          <p className="text-xs uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("jobs.assignee")}</p>
          <p className="mt-1 truncate font-medium text-[var(--qf-text)]">{assigneeName}</p>
          <p className="mt-1 text-xs text-[var(--qf-text-muted)]">{t("jobs.updated", { date: formatDate(job.updatedAt) })}</p>
        </div>
        <div className="min-w-0 text-sm">
          <p className="text-xs uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("jobs.sourceQuote")}</p>
          <p className="mt-1 truncate font-medium text-[var(--qf-text)]">{job.sourceQuote.title}</p>
          <p className="mt-1 text-xs text-[var(--qf-text-muted)]">
            {t("jobs.acceptedTotal")} · {money(job.sourceQuote.totalAmount, i18n.resolvedLanguage)}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
          <Button variant="outline" className="min-h-11" onClick={() => onOpenQuote(job)}>
            <ExternalLink size={15} />
            {t("jobs.openQuote")}
          </Button>
          <Button className="min-h-11" onClick={() => onOpen(job)}>
            {t("jobs.openJob")}
          </Button>
        </div>
      </div>
    </article>
  );
}

function JobScheduleOverview() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { session } = useDashboard();
  const timeZone = validTimeZone(session?.timezone ?? "UTC");
  const [range, setRange] = useState<"today" | "week">("week");
  const [items, setItems] = useState<JobScheduleAppointment[]>([]);
  const [limit, setLimit] = useState<PageSize>(25);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const window = useMemo(() => scheduleWindow(timeZone, range), [range, timeZone]);

  const loadSchedule = useCallback(async () => {
    if (!window) {
      setError(t("jobs.invalidWallTime"));
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await api.jobs.schedule({
        fromUtc: window.fromUtc,
        toUtc: window.toUtc,
        limit,
        offset,
      });
      setItems(response.items);
      setTotal(response.pagination.total);
    } catch (err) {
      setError(localizedApiError(err, t, { fallbackKey: "jobs.loadScheduleError" }));
    } finally {
      setLoading(false);
    }
  }, [limit, offset, t, window]);

  useEffect(() => {
    void loadSchedule();
  }, [loadSchedule]);

  return (
    <section className="rounded-3xl border border-[var(--qf-border)] bg-[var(--qf-panel)] p-4 shadow-[var(--qf-shadow-sm)] sm:p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("jobs.scheduleEyebrow")}</p>
          <h2 className="mt-1 flex items-center gap-2 text-lg font-semibold text-[var(--qf-text)]">
            <CalendarClock size={18} />
            {t("jobs.scheduleBoardTitle")}
          </h2>
          <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{t("jobs.scheduleBoardDescription")}</p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex">
          {(["today", "week"] as const).map((option) => (
            <Button
              key={option}
              type="button"
              variant={range === option ? "primary" : "outline"}
              className="min-h-11"
              aria-pressed={range === option}
              onClick={() => {
                setRange(option);
                setOffset(0);
              }}
            >
              {t(`jobs.scheduleRange.${option}`)}
            </Button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        {loading ? (
          <LoadingState title={t("jobs.loadingSchedule")} />
        ) : error ? (
          <Alert tone="error" onDismiss={() => setError(null)}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span>{error}</span>
              <Button type="button" variant="outline" className="min-h-11 shrink-0" onClick={() => void loadSchedule()}>
                {t("jobs.retry")}
              </Button>
            </div>
          </Alert>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<CalendarClock size={22} />}
            title={t("jobs.noSchedule")}
            description={t("jobs.noScheduleDescription")}
          />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {items.map((appointment) => (
              <button
                key={appointment.id}
                type="button"
                className="min-h-11 rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-4 text-left transition hover:border-[var(--qf-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]"
                onClick={() => navigate(`/app/jobs/${appointment.job.id}`)}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={appointmentStatusTone(appointment.status)}>
                    {t(`domain.appointmentStatus.${appointment.status}`)}
                  </Badge>
                  <span className="text-xs font-semibold text-[var(--qf-text-muted)]">
                    {t("jobs.jobNumber", { number: appointment.job.jobNumber })}
                  </span>
                </div>
                <p className="mt-2 font-semibold text-[var(--qf-text)]">{appointment.job.customer.fullName}</p>
                <p className="mt-1 line-clamp-1 text-sm text-[var(--qf-text-soft)]">{appointment.job.title}</p>
                <p className="mt-2 text-xs text-[var(--qf-text-soft)]">
                  {t("jobs.appointmentAssignedTo", { name: appointment.assignedTenantUser.user.fullName })}
                </p>
                <p className="mt-1 line-clamp-2 text-xs text-[var(--qf-text-muted)]">
                  {t("jobs.scheduleAddress", { address: appointment.job.serviceAddressSnapshot || t("jobs.noAddress") })}
                </p>
                <p className="mt-2 text-xs text-[var(--qf-text-muted)]">
                  {t("jobs.scheduledWindow", {
                    start: formatDateTime(appointment.startsAtUtc, i18n.resolvedLanguage, timeZone),
                    end: formatDateTime(appointment.endsAtUtc, i18n.resolvedLanguage, timeZone),
                  })}
                </p>
              </button>
            ))}
          </div>
        )}
        {total > 0 && (
          <div className="mt-4">
            <PaginationControls
              limit={limit}
              offset={offset}
              total={total}
              loading={loading}
              itemLabel={t("jobs.appointmentItemLabel")}
              onLimitChange={(nextLimit) => {
                setLimit(nextLimit);
                setOffset(0);
              }}
              onOffsetChange={setOffset}
            />
          </div>
        )}
      </div>
    </section>
  );
}

function JobSchedulePanel({
  job,
  canManageJobs,
  onReloadLatest,
}: {
  job: Job;
  canManageJobs: boolean;
  onReloadLatest: () => void | Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const { session } = useDashboard();
  const timeZone = validTimeZone(session?.timezone ?? "UTC");
  const initialTimes = useMemo(() => defaultAppointmentInputs(timeZone), [timeZone]);
  const [appointments, setAppointments] = useState<JobAppointment[]>([]);
  const [appointmentLimit, setAppointmentLimit] = useState<PageSize>(25);
  const [appointmentOffset, setAppointmentOffset] = useState(0);
  const [appointmentTotal, setAppointmentTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [bookingFormOpen, setBookingFormOpen] = useState(false);
  const [appointmentToCancel, setAppointmentToCancel] = useState<JobAppointment | null>(null);
  const [editingAppointment, setEditingAppointment] = useState<JobAppointment | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [appointmentStale, setAppointmentStale] = useState(false);
  const [startsAt, setStartsAt] = useState(initialTimes.startsAt);
  const [endsAt, setEndsAt] = useState(initialTimes.endsAt);
  const [instructions, setInstructions] = useState("");
  const bookingFormRef = useRef<HTMLFormElement | null>(null);
  const staleAlertRef = useRef<HTMLDivElement | null>(null);
  const bookingFormId = useMemo(() => `job-booking-form-${job.id}`, [job.id]);

  useEffect(() => {
    setStartsAt(initialTimes.startsAt);
    setEndsAt(initialTimes.endsAt);
  }, [initialTimes.endsAt, initialTimes.startsAt]);

  const loadAppointments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.jobs.appointments.list(job.id, { limit: appointmentLimit, offset: appointmentOffset });
      setAppointments(response.items);
      setAppointmentTotal(response.pagination.total);
    } catch (err) {
      setError(localizedApiError(err, t, { fallbackKey: "jobs.loadAppointmentsError" }));
    } finally {
      setLoading(false);
    }
  }, [appointmentLimit, appointmentOffset, job.id, t]);

  useEffect(() => {
    void loadAppointments();
  }, [loadAppointments]);

  const createDisabled = !canManageJobs || !job.assignedTenantUserId || job.status === "COMPLETED" || job.status === "CANCELED";
  const formDisabled = saving || (!editingAppointment && createDisabled);

  const refreshAfterMutation = useCallback(async () => {
    await loadAppointments();
    void onReloadLatest();
  }, [loadAppointments, onReloadLatest]);

  const focusBookingForm = useCallback(() => {
    window.setTimeout(() => {
      const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
      bookingFormRef.current?.scrollIntoView({ behavior, block: "start" });
      bookingFormRef.current?.querySelector<HTMLElement>("input, textarea, select, button")?.focus();
    }, 0);
  }, []);

  const focusStaleRecovery = useCallback(() => {
    window.setTimeout(() => {
      const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
      staleAlertRef.current?.scrollIntoView({ behavior, block: "center" });
      staleAlertRef.current?.focus();
    }, 0);
  }, []);

  const handleAppointmentActionError = useCallback((err: unknown, fallbackKey: string, options?: { closeCancelModal?: boolean }) => {
    const stale = err instanceof ApiError && err.code === "JOB_APPOINTMENT_STALE_VERSION";
    setAppointmentStale(stale);
    setActionError(localizedApiError(err, t, { fallbackKey }));
    if (stale) {
      if (options?.closeCancelModal) setAppointmentToCancel(null);
      focusStaleRecovery();
    }
  }, [focusStaleRecovery, t]);

  const reloadLatestBooking = useCallback(async () => {
    setAppointmentStale(false);
    setActionError(null);
    setEditingAppointment(null);
    setAppointmentToCancel(null);
    setBookingFormOpen(false);
    await refreshAfterMutation();
  }, [refreshAfterMutation]);

  const openCreateForm = () => {
    setEditingAppointment(null);
    setStartsAt(initialTimes.startsAt);
    setEndsAt(initialTimes.endsAt);
    setInstructions("");
    setActionError(null);
    setAppointmentStale(false);
    setBookingFormOpen((open) => {
      const nextOpen = !open;
      if (nextOpen) focusBookingForm();
      return nextOpen;
    });
  };

  const openEditForm = (appointment: JobAppointment) => {
    setEditingAppointment(appointment);
    setStartsAt(toTenantDateTimeInput(appointment.startsAtUtc, timeZone));
    setEndsAt(toTenantDateTimeInput(appointment.endsAtUtc, timeZone));
    setInstructions(appointment.instructions ?? "");
    setActionError(null);
    setAppointmentStale(false);
    setBookingFormOpen(true);
    focusBookingForm();
  };

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (formDisabled || (!editingAppointment && !job.assignedTenantUserId)) return;
    setNotice(null);
    setActionError(null);
    setAppointmentStale(false);
    const startsAtUtc = tenantWallTimeToIso(startsAt, timeZone);
    const endsAtUtc = tenantWallTimeToIso(endsAt, timeZone);
    if (!startsAtUtc || !endsAtUtc) {
      setActionError(t("jobs.invalidWallTime"));
      return;
    }
    if (new Date(startsAtUtc) >= new Date(endsAtUtc)) {
      setActionError(t("jobs.endAfterStart"));
      return;
    }
    setSaving(true);
    try {
      if (editingAppointment) {
        await api.jobs.appointments.update(job.id, editingAppointment.id, {
          version: editingAppointment.version,
          startsAtUtc,
          endsAtUtc,
          timeZone,
          instructions: instructions.trim() || null,
        });
      } else {
        const assignedTenantUserId = job.assignedTenantUserId;
        if (!assignedTenantUserId) {
          setSaving(false);
          return;
        }
        await api.jobs.appointments.create(job.id, {
          assignedTenantUserId,
          startsAtUtc,
          endsAtUtc,
          timeZone,
          instructions: instructions.trim() || null,
        });
      }
      setInstructions("");
      setBookingFormOpen(false);
      setEditingAppointment(null);
      setNotice(editingAppointment ? t("jobs.bookingUpdated") : t("jobs.bookingSaved"));
      await refreshAfterMutation();
    } catch (err) {
      handleAppointmentActionError(err, "jobs.bookingSaveError");
    } finally {
      setSaving(false);
    }
  };

  const updateAppointmentStatus = async (appointment: JobAppointment, status: JobAppointmentStatus) => {
    if (updatingId) return;
    setNotice(null);
    setActionError(null);
    setAppointmentStale(false);
    setUpdatingId(appointment.id);
    try {
      await api.jobs.appointments.update(job.id, appointment.id, {
        version: appointment.version,
        status,
      });
      setNotice(t("jobs.bookingSaved"));
      await refreshAfterMutation();
    } catch (err) {
      handleAppointmentActionError(err, "jobs.statusUpdateError");
    } finally {
      setUpdatingId(null);
    }
  };

  const cancelAppointment = async () => {
    if (!appointmentToCancel || updatingId) return;
    setNotice(null);
    setActionError(null);
    setAppointmentStale(false);
    setUpdatingId(appointmentToCancel.id);
    try {
      await api.jobs.appointments.remove(job.id, appointmentToCancel.id, appointmentToCancel.version);
      setNotice(t("jobs.bookingCanceled"));
      setAppointmentToCancel(null);
      await refreshAfterMutation();
    } catch (err) {
      handleAppointmentActionError(err, "jobs.bookingCancelError", { closeCancelModal: true });
    } finally {
      setUpdatingId(null);
    }
  };

  return (
    <section className="rounded-2xl border border-[var(--qf-border)] p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--qf-text)]">
            <CalendarClock size={17} />
            {t("jobs.scheduleTitle")}
          </h2>
          <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{t("jobs.scheduleDescription")}</p>
          <p className="mt-1 text-xs text-[var(--qf-text-muted)]">{t("jobs.timeZone", { timeZone })}</p>
        </div>
        <Badge tone="slate" className="self-start">
          {t("jobs.bookingCount", { count: appointmentTotal })}
        </Badge>
      </div>

      {notice && <div className="mt-4"><Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert></div>}
      {actionError && (
        <div ref={staleAlertRef} tabIndex={appointmentStale ? -1 : undefined} className="mt-4">
          <Alert tone="error" onDismiss={() => {
            setActionError(null);
            setAppointmentStale(false);
          }}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span>{actionError}</span>
              {appointmentStale && (
                <Button type="button" variant="outline" className="min-h-11 shrink-0" onClick={() => void reloadLatestBooking()}>
                  {t("jobs.reloadLatestBooking")}
                </Button>
              )}
            </div>
          </Alert>
        </div>
      )}

      <div className="mt-4 space-y-3">
        {loading ? (
          <LoadingState title={t("jobs.loadingAppointments")} />
        ) : error ? (
          <Alert tone="error" onDismiss={() => setError(null)}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span>{error}</span>
              <Button type="button" variant="outline" className="min-h-11 shrink-0" onClick={() => void loadAppointments()}>
                {t("jobs.retry")}
              </Button>
            </div>
          </Alert>
        ) : appointments.length === 0 ? (
          <EmptyState
            icon={<CalendarClock size={22} />}
            title={t("jobs.noAppointments")}
            description={t("jobs.noAppointmentsDescription")}
          />
        ) : (
          appointments.map((appointment) => {
            const actions = APPOINTMENT_ACTIONS[appointment.status];
            const visibleActions = canManageJobs
              ? actions
              : appointment.assignedTenantUser.user.id === session?.userId
                ? actions.filter((status) => status !== "CANCELED")
                : [];
            return (
              <article key={appointment.id} className="rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)] p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={appointmentStatusTone(appointment.status)}>
                        {t(`domain.appointmentStatus.${appointment.status}`)}
                      </Badge>
                      <span className="text-xs text-[var(--qf-text-muted)]">
                        {t("jobs.version", { version: appointment.version })}
                      </span>
                    </div>
                    <p className="mt-2 font-medium text-[var(--qf-text)]">
                      {t("jobs.scheduledWindow", {
                        start: formatDateTime(appointment.startsAtUtc, i18n.resolvedLanguage, timeZone),
                        end: formatDateTime(appointment.endsAtUtc, i18n.resolvedLanguage, timeZone),
                      })}
                    </p>
                    <p className="mt-1 text-sm text-[var(--qf-text-soft)]">
                      {t("jobs.appointmentAssignedTo", { name: appointment.assignedTenantUser.user.fullName })}
                    </p>
                    <p className="mt-1 text-xs text-[var(--qf-text-muted)]">
                      {t("jobs.appointmentCreatedBy", { name: appointment.createdByTenantUser.user.fullName })}
                    </p>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-[var(--qf-text-soft)]">
                      {appointment.instructions || t("jobs.noBookingInstructions")}
                    </p>
                  </div>
                  {visibleActions.length > 0 && (
                    <div className="grid gap-2 sm:flex sm:flex-wrap sm:justify-end">
                      {canManageJobs && !["COMPLETED", "CANCELED"].includes(appointment.status) && (
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          disabled={Boolean(updatingId) || saving}
                          onClick={() => openEditForm(appointment)}
                        >
                          <CalendarClock size={15} />
                          {t("jobs.editBooking")}
                        </Button>
                      )}
                      {visibleActions.map((status) => (
                        <Button
                          key={status}
                          type="button"
                          variant={status === "CANCELED" ? "outline" : "primary"}
                          className="min-h-11"
                          loading={updatingId === appointment.id}
                          disabled={Boolean(updatingId)}
                          onClick={() => {
                            if (status === "CANCELED") {
                              setAppointmentToCancel(appointment);
                              return;
                            }
                            void updateAppointmentStatus(appointment, status);
                          }}
                        >
                          {status === "CANCELED" ? <Trash2 size={15} /> : status === "DISPATCHED" ? <Send size={15} /> : <CheckCircle2 size={15} />}
                          {updatingId === appointment.id ? t("jobs.updatingBooking") : appointmentActionLabel(status, t)}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              </article>
            );
          })
        )}
      </div>
      {appointmentTotal > 0 && (
        <div className="mt-4">
          <PaginationControls
            limit={appointmentLimit}
            offset={appointmentOffset}
            total={appointmentTotal}
            loading={loading}
            itemLabel={t("jobs.appointmentItemLabel")}
            onLimitChange={(nextLimit) => {
              setAppointmentLimit(nextLimit);
              setAppointmentOffset(0);
            }}
            onOffsetChange={setAppointmentOffset}
          />
        </div>
      )}

      {canManageJobs && (
        <div className="mt-4">
          <Button
            type="button"
            variant={bookingFormOpen ? "outline" : "primary"}
            className="min-h-11"
            disabled={createDisabled && !bookingFormOpen}
            aria-expanded={bookingFormOpen}
            aria-controls={bookingFormId}
            onClick={openCreateForm}
          >
            <CalendarClock size={16} />
            {bookingFormOpen ? t("jobs.hideBookingForm") : t("jobs.showBookingForm")}
          </Button>
        </div>
      )}

      {canManageJobs && bookingFormOpen && (
        <form id={bookingFormId} ref={bookingFormRef} className="mt-4 rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-4" onSubmit={handleCreate}>
          {!job.assignedTenantUserId && <Alert tone="warning">{t("jobs.assignBeforeBooking")}</Alert>}
          {(job.status === "COMPLETED" || job.status === "CANCELED") && <Alert tone="warning">{t("jobs.bookingLocked")}</Alert>}
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <Input
              type="datetime-local"
              label={t("jobs.startTime")}
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
              disabled={formDisabled}
            />
            <Input
              type="datetime-local"
              label={t("jobs.endTime")}
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
              disabled={formDisabled}
            />
            <div className="md:col-span-2">
              <Textarea
                label={t("jobs.bookingInstructions")}
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                maxLength={2000}
                disabled={formDisabled}
                placeholder={t("jobs.bookingInstructionsPlaceholder")}
              />
            </div>
          </div>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:justify-end">
            {editingAppointment && (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={saving}
                onClick={() => {
                  setEditingAppointment(null);
                  setAppointmentStale(false);
                  setActionError(null);
                  setBookingFormOpen(false);
                }}
              >
                {t("jobs.cancelEditBooking")}
              </Button>
            )}
            <Button type="submit" loading={saving} disabled={formDisabled}>
              {saving
                ? editingAppointment ? t("jobs.updatingBooking") : t("jobs.creatingBooking")
                : editingAppointment ? t("jobs.updateBooking") : t("jobs.createBooking")}
            </Button>
          </div>
        </form>
      )}

      <ConfirmModal
        open={Boolean(appointmentToCancel)}
        onClose={() => setAppointmentToCancel(null)}
        onConfirm={() => void cancelAppointment()}
        title={t("jobs.cancelBookingTitle")}
        description={t("jobs.cancelBookingDescription")}
        confirmLabel={t("jobs.cancelBookingConfirm")}
        confirmVariant="warning"
        loading={Boolean(appointmentToCancel && updatingId === appointmentToCancel.id)}
      />
    </section>
  );
}

function JobNotesPanel({ job }: { job: Job }) {
  const { t } = useTranslation();
  const { session } = useDashboard();
  const [notes, setNotes] = useState<JobNote[]>([]);
  const [noteLimit, setNoteLimit] = useState<PageSize>(25);
  const [noteOffset, setNoteOffset] = useState(0);
  const [noteTotal, setNoteTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [noteToDelete, setNoteToDelete] = useState<JobNote | null>(null);
  const [body, setBody] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const formatDate = useJobDateFormatter();

  const loadNotes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.jobs.notes.list(job.id, { limit: noteLimit, offset: noteOffset });
      setNotes(response.items);
      setNoteTotal(response.pagination.total);
    } catch (err) {
      setError(localizedApiError(err, t, { fallbackKey: "jobs.loadNotesError" }));
    } finally {
      setLoading(false);
    }
  }, [job.id, noteLimit, noteOffset, t]);

  useEffect(() => {
    void loadNotes();
  }, [loadNotes]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setNotice(null);
    setActionError(null);
    try {
      const response = await api.jobs.notes.create(job.id, { body: trimmed });
      if (noteOffset === 0) {
        setNotes((current) => [response.note, ...current].slice(0, noteLimit));
      } else {
        setNoteOffset(0);
      }
      setNoteTotal((total) => total + 1);
      setBody("");
      setNotice(t("jobs.noteSaved"));
    } catch (err) {
      setActionError(localizedApiError(err, t, { fallbackKey: "jobs.noteSaveError" }));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (note: JobNote) => {
    if (deletingId) return;
    setDeletingId(note.id);
    setNotice(null);
    setActionError(null);
    try {
      await api.jobs.notes.remove(job.id, note.id);
      setNotes((current) => current.filter((item) => item.id !== note.id));
      setNoteTotal((total) => Math.max(0, total - 1));
    } catch (err) {
      setActionError(localizedApiError(err, t, { fallbackKey: "jobs.noteDeleteError" }));
    } finally {
      setDeletingId(null);
    }
  };

  const canDeleteNote = (note: JobNote) =>
    session?.role === "owner" || session?.role === "admin" || note.createdByTenantUser.user.id === session?.userId;

  return (
    <section className="rounded-2xl border border-[var(--qf-border)] p-4">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--qf-text)]">
          <NotebookPen size={17} />
          {t("jobs.notesTitle")}
        </h2>
        <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{t("jobs.notesDescription")}</p>
      </div>

      {notice && <div className="mt-4"><Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert></div>}
      {actionError && <div className="mt-4"><Alert tone="error" onDismiss={() => setActionError(null)}>{actionError}</Alert></div>}

      <form className="mt-4 rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-4" onSubmit={handleSubmit}>
        <Textarea
          label={t("jobs.noteBody")}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          maxLength={4000}
          disabled={saving}
          placeholder={t("jobs.notePlaceholder")}
        />
        <div className="mt-3 flex justify-end">
          <Button type="submit" loading={saving} disabled={!body.trim() || saving}>
            {saving ? t("jobs.addingNote") : t("jobs.addNote")}
          </Button>
        </div>
      </form>

      <div className="mt-4 space-y-3">
        {loading ? (
          <LoadingState title={t("jobs.loadingNotes")} />
        ) : error ? (
          <Alert tone="error" onDismiss={() => setError(null)}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span>{error}</span>
              <Button type="button" variant="outline" className="min-h-11 shrink-0" onClick={() => void loadNotes()}>
                {t("jobs.retry")}
              </Button>
            </div>
          </Alert>
        ) : notes.length === 0 ? (
          <EmptyState
            icon={<NotebookPen size={22} />}
            title={t("jobs.noNotes")}
            description={t("jobs.noNotesDescription")}
          />
        ) : (
          notes.map((note) => (
            <article key={note.id} className="rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)] p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="whitespace-pre-wrap text-sm leading-6 text-[var(--qf-text)]">{note.body}</p>
                  <p className="mt-3 text-xs text-[var(--qf-text-muted)]">
                    {t("jobs.noteBy", { name: note.createdByTenantUser.user.fullName })} · {formatDate(note.createdAt)}
                  </p>
                </div>
                {canDeleteNote(note) && (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 shrink-0"
                    loading={deletingId === note.id}
                    disabled={Boolean(deletingId)}
                    onClick={() => setNoteToDelete(note)}
                  >
                    <Trash2 size={15} />
                    {t("jobs.deleteNote")}
                  </Button>
                )}
              </div>
            </article>
          ))
        )}
      </div>
      {noteTotal > 0 && (
        <div className="mt-4">
          <PaginationControls
            limit={noteLimit}
            offset={noteOffset}
            total={noteTotal}
            loading={loading}
            itemLabel={t("jobs.noteItemLabel")}
            onLimitChange={(nextLimit) => {
              setNoteLimit(nextLimit);
              setNoteOffset(0);
            }}
            onOffsetChange={setNoteOffset}
          />
        </div>
      )}
      <ConfirmModal
        open={Boolean(noteToDelete)}
        onClose={() => setNoteToDelete(null)}
        onConfirm={() => {
          if (!noteToDelete) return;
          void handleDelete(noteToDelete);
          setNoteToDelete(null);
        }}
        title={t("jobs.deleteNoteTitle")}
        description={t("jobs.deleteNoteDescription")}
        confirmLabel={t("jobs.deleteNoteConfirm")}
        loading={Boolean(noteToDelete && deletingId === noteToDelete.id)}
      />
    </section>
  );
}

function JobDetail({
  job,
  canManageJobs,
  assignees,
  assigneesLoading,
  editSaving,
  editError,
  editStale,
  onSave,
  onReloadLatest,
}: {
  job: Job;
  canManageJobs: boolean;
  assignees: JobAssigneeOption[];
  assigneesLoading: boolean;
  editSaving: boolean;
  editError: string | null;
  editStale: boolean;
  onSave: (payload: { assignedTenantUserId: string | null; accessInstructions: string | null }) => Promise<void>;
  onReloadLatest: () => void | Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const formatDate = useJobDateFormatter();
  const assigneeName = job.assignedTenantUser?.user.fullName ?? t("jobs.unassigned");
  const [assignedTenantUserId, setAssignedTenantUserId] = useState(job.assignedTenantUserId ?? "");
  const [accessInstructions, setAccessInstructions] = useState(job.accessInstructions ?? "");

  const assigneeOptions = useMemo(() => {
    const options = [
      { value: "", label: t("jobs.unassigned") },
      ...assignees.map((assignee) => ({
        value: assignee.id,
        label: `${assignee.user.fullName} · ${t(`domain.role.${assignee.role}`)}`,
      })),
    ];
    if (
      job.assignedTenantUser &&
      !options.some((option) => option.value === job.assignedTenantUser?.id)
    ) {
      options.push({
        value: job.assignedTenantUser.id,
        label: `${job.assignedTenantUser.user.fullName} · ${t(`domain.role.${job.assignedTenantUser.role}`)}`,
      });
    }
    return options;
  }, [assignees, job.assignedTenantUser, t]);

  const changed =
    assignedTenantUserId !== (job.assignedTenantUserId ?? "") ||
    accessInstructions.trim() !== (job.accessInstructions ?? "");

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!changed || editSaving) return;
    await onSave({
      assignedTenantUserId: assignedTenantUserId || null,
      accessInstructions: accessInstructions.trim() || null,
    });
  };

  return (
    <section className="rounded-3xl border border-[var(--qf-border)] bg-[var(--qf-panel)] p-4 shadow-[var(--qf-shadow-sm)] sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <Button variant="ghost" className="mb-3 min-h-11 px-0" onClick={() => navigate("/app/jobs")}>
            <ArrowLeft size={16} />
            {t("jobs.backToJobs")}
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-[var(--qf-panel-muted)] px-3 py-1.5 text-sm font-semibold text-[var(--qf-text)]">
              {t("jobs.jobNumber", { number: job.jobNumber })}
            </span>
            <Badge tone={jobStatusTone(job.status)}>{t(`domain.jobStatus.${job.status}`)}</Badge>
          </div>
          <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-[var(--qf-text)]">{job.customer.fullName}</h1>
          <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{job.title}</p>
        </div>
        <div className="grid gap-2 sm:flex sm:flex-wrap sm:justify-end">
          <KodyButton
            showLabel
            tool="PRIORITIZE_MY_DAY"
            prompt={t("kody.quick.prioritizeDay.prompt")}
            context={{ currentPage: "dashboard" }}
            label={t("kody.quick.prioritizeDay.label")}
            className="min-h-11"
          />
          <Button className="min-h-11" onClick={() => navigate(`/app/quotes/${job.sourceQuoteId}`)}>
            <ExternalLink size={16} />
            {t("jobs.openQuote")}
          </Button>
        </div>
      </div>

      <div className="mt-6">
        <JobSchedulePanel job={job} canManageJobs={canManageJobs} onReloadLatest={onReloadLatest} />
      </div>

      <div className="mt-6 grid gap-3 md:grid-cols-3">
        <div className="rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-4">
          <p className="text-xs uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("jobs.acceptedTotal")}</p>
          <p className="mt-2 text-xl font-semibold text-[var(--qf-text)]">{money(job.sourceQuote.totalAmount, i18n.resolvedLanguage)}</p>
          <p className="mt-1 text-xs text-[var(--qf-text-muted)]">{t("jobs.acceptedAt", { date: formatDate(job.acceptedAtUtc) })}</p>
        </div>
        <div className="rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-4">
          <p className="text-xs uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("jobs.assignee")}</p>
          <p className="mt-2 text-base font-semibold text-[var(--qf-text)]">{assigneeName}</p>
          <p className="mt-1 text-xs text-[var(--qf-text-muted)]">{t("jobs.updated", { date: formatDate(job.updatedAt) })}</p>
        </div>
        <div className="rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-4">
          <p className="text-xs uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("jobs.sourceQuote")}</p>
          <p className="mt-2 truncate text-base font-semibold text-[var(--qf-text)]">{job.sourceQuote.title}</p>
          <p className="mt-1 text-xs text-[var(--qf-text-muted)]">{t(`domain.quoteStatus.${job.sourceQuote.status}`)}</p>
        </div>
      </div>

      <div className="mt-6">
        <InvoicePanel
          key={`job:${job.id}`}
          jobId={job.id}
          sourceLabel={t("jobs.jobNumber", { number: job.jobNumber })}
          sourceAmount={job.sourceQuote.totalAmount}
          canCreate={canManageJobs}
          createBlockedReason={job.status === "COMPLETED" ? null : t("invoices.completeJobFirst")}
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(260px,.45fr)]">
        <div className="rounded-2xl border border-[var(--qf-border)] p-4">
          <h2 className="text-sm font-semibold text-[var(--qf-text)]">{t("jobs.scope")}</h2>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[var(--qf-text-soft)]">{job.scopeSnapshot}</p>
        </div>
        <div className="space-y-4">
          <div className="rounded-2xl border border-[var(--qf-border)] p-4">
            <h2 className="text-sm font-semibold text-[var(--qf-text)]">{t("jobs.instructions")}</h2>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[var(--qf-text-soft)]">
              {job.accessInstructions || t("jobs.noInstructions")}
            </p>
          </div>
          <div className="rounded-2xl border border-[var(--qf-border)] p-4">
            <h2 className="text-sm font-semibold text-[var(--qf-text)]">{t("jobs.details")}</h2>
            <dl className="mt-2 space-y-2 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-[var(--qf-text-muted)]">{t("jobs.status")}</dt>
                <dd className="font-medium text-[var(--qf-text)]">{t(`domain.jobStatus.${job.status}`)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-[var(--qf-text-muted)]">{t("jobs.serviceType")}</dt>
                <dd className="font-medium text-[var(--qf-text)]">{t(`domain.trade.${job.serviceType}`)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-[var(--qf-text-muted)]">{t("jobs.serviceAddress")}</dt>
                <dd className="text-right font-medium text-[var(--qf-text)]">{job.serviceAddressSnapshot || t("jobs.noAddress")}</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>

      {canManageJobs && (
        <form className="mt-6 rounded-2xl border border-[var(--qf-border)] p-4" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-[var(--qf-text)]">{t("jobs.manageTitle")}</h2>
              <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{t("jobs.manageDescription")}</p>
            </div>
            <Badge tone="slate">{t("jobs.version", { version: job.version })}</Badge>
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(220px,.35fr)_minmax(0,1fr)]">
            <Select
              label={t("jobs.assignee")}
              value={assignedTenantUserId}
              onChange={(event) => setAssignedTenantUserId(event.target.value)}
              disabled={assigneesLoading || editSaving}
              options={assigneeOptions}
            />
            <label className="space-y-1">
              <span className="block text-xs font-medium text-[var(--qf-text-soft)]">{t("jobs.instructions")}</span>
              <textarea
                className="min-h-[112px] w-full rounded-lg border border-[var(--qf-border)] bg-[var(--qf-panel)] px-3 py-2 text-sm text-[var(--qf-text)] outline-none transition hover:border-[var(--qf-border-strong)] focus:border-[var(--qf-focus)] focus:ring-4 focus:ring-[var(--qf-focus-ring)] disabled:cursor-not-allowed disabled:bg-[var(--qf-panel-muted)] disabled:text-[var(--qf-text-muted)]"
                value={accessInstructions}
                onChange={(event) => setAccessInstructions(event.target.value)}
                maxLength={2000}
                disabled={editSaving}
                placeholder={t("jobs.instructionsPlaceholder")}
              />
            </label>
          </div>
          {editError && (
            <div className="mt-4">
              <Alert tone="error">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <span>{editError}</span>
                  {editStale && (
                    <Button type="button" variant="outline" className="min-h-11 shrink-0" onClick={onReloadLatest}>
                      {t("jobs.reloadLatest")}
                    </Button>
                  )}
                </div>
              </Alert>
            </div>
          )}
          <div className="mt-4 flex justify-end">
            <Button type="submit" loading={editSaving} disabled={!changed || editSaving}>
              {editSaving ? t("jobs.saving") : t("jobs.save")}
            </Button>
          </div>
        </form>
      )}

      <div className="mt-6">
        <JobNotesPanel job={job} />
      </div>
    </section>
  );
}

export function JobsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { jobId } = useParams();
  const { session } = useDashboard();
  const canManageJobs = session?.role === "owner" || session?.role === "admin";
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [status, setStatus] = useState<JobStatus | "active">("active");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState<PageSize>(25);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editStale, setEditStale] = useState(false);
  const [assignees, setAssignees] = useState<JobAssigneeOption[]>([]);
  const [assigneesLoading, setAssigneesLoading] = useState(false);

  const query = useMemo(() => ({
    status: status === "active" ? undefined : status,
    search: search.trim() || undefined,
    limit,
    offset,
  }), [limit, offset, search, status]);

  const loadJobs = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const response = await api.jobs.list(query);
      setJobs(response.items);
      setTotal(response.pagination.total);
    } catch (err) {
      setListError(localizedApiError(err, t, { fallbackKey: "jobs.loadError" }));
    } finally {
      setListLoading(false);
    }
  }, [query, t]);

  useEffect(() => {
    if (jobId) return;
    void loadJobs();
  }, [jobId, loadJobs]);

  const loadJob = useCallback(async (id: string) => {
    setDetailLoading(true);
    setDetailError(null);
    setEditError(null);
    setEditStale(false);
    try {
      const response = await api.jobs.get(id);
      setSelectedJob(response.job);
    } catch (err) {
      setSelectedJob(null);
      setDetailError(localizedApiError(err, t, { fallbackKey: "jobs.loadDetailError" }));
    } finally {
      setDetailLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!jobId) {
      setSelectedJob(null);
      return;
    }
    void loadJob(jobId);
  }, [jobId, loadJob]);

  useEffect(() => {
    if (!canManageJobs || !jobId) return;
    let cancelled = false;
    setAssigneesLoading(true);
    api.org.users.list({ limit: 100, offset: 0 })
      .then((response) => {
        if (!cancelled) {
          setAssignees(response.members.map((member) => ({
            id: member.id,
            role: member.role,
            user: { fullName: member.user.fullName },
          })));
        }
      })
      .catch((err) => {
        if (!cancelled) setEditError(localizedApiError(err, t, { fallbackKey: "jobs.assigneesLoadError" }));
      })
      .finally(() => {
        if (!cancelled) setAssigneesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canManageJobs, jobId, t]);

  const handleSaveJob = useCallback(async (payload: { assignedTenantUserId: string | null; accessInstructions: string | null }) => {
    if (!selectedJob) return;
    setEditSaving(true);
    setEditError(null);
    setEditStale(false);
    try {
      const response = await api.jobs.update(selectedJob.id, {
        version: selectedJob.version,
        assignedTenantUserId: payload.assignedTenantUserId,
        accessInstructions: payload.accessInstructions,
      });
      setSelectedJob(response.job);
      setJobs((current) => current.map((job) => job.id === response.job.id ? response.job : job));
    } catch (err) {
      if (err instanceof ApiError && err.code === "JOB_STALE_VERSION") {
        setEditStale(true);
      }
      setEditError(localizedApiError(err, t, { fallbackKey: "jobs.saveError" }));
    } finally {
      setEditSaving(false);
    }
  }, [selectedJob, t]);

  const handleStatusChange = (nextStatus: JobStatus | "active") => {
    setStatus(nextStatus);
    setOffset(0);
  };

  if (jobId) {
    if (detailLoading) {
      return <LoadingState title={t("jobs.loadingDetail")} />;
    }
    if (detailError || !selectedJob) {
      return (
        <EmptyState
          icon={<BriefcaseBusiness size={24} />}
          title={t("jobs.loadDetailError")}
          description={detailError ?? t("jobs.loadDetailError")}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="outline" onClick={() => navigate("/app/jobs")}>{t("jobs.backToJobs")}</Button>
              {jobId && <Button onClick={() => void loadJob(jobId)}>{t("jobs.retry")}</Button>}
            </div>
          }
        />
      );
    }
    return (
      <JobDetail
        key={`${selectedJob.id}:${selectedJob.version}`}
        job={selectedJob}
        canManageJobs={canManageJobs}
        assignees={assignees}
        assigneesLoading={assigneesLoading}
        editSaving={editSaving}
        editError={editError}
        editStale={editStale}
        onSave={handleSaveJob}
        onReloadLatest={() => loadJob(selectedJob.id)}
      />
    );
  }

  return (
    <div className="space-y-5">
      <JobScheduleOverview />

      <section className="rounded-3xl border border-[var(--qf-border)] bg-[var(--qf-panel)] shadow-[var(--qf-shadow-sm)]">
        <div className="border-b border-[var(--qf-border)] p-4 sm:p-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("jobs.workspace")}</p>
              <h2 className="mt-1 text-lg font-semibold text-[var(--qf-text)]">{t("jobs.list")}</h2>
              <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{t("jobs.count", { count: total })}</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-[minmax(220px,1fr)_180px] lg:min-w-[520px]">
              <label className="relative block">
                <span className="sr-only">{t("jobs.searchLabel")}</span>
                <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--qf-text-muted)]" size={16} />
                <input
                  className="min-h-11 w-full rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] pl-10 pr-3 text-sm text-[var(--qf-text)] outline-none transition focus:border-[var(--qf-focus)] focus:ring-2 focus:ring-[var(--qf-focus)]/25"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setOffset(0);
                  }}
                  placeholder={t("jobs.searchPlaceholder")}
                />
              </label>
              <Select
                label={t("jobs.status")}
                value={status}
                onChange={(event) => handleStatusChange(event.target.value as JobStatus | "active")}
                options={JOB_STATUS_FILTERS.map((filter) => ({
                  value: filter,
                  label: t(`jobs.filters.${filter}`),
                }))}
              />
            </div>
          </div>
        </div>

        <div className="space-y-3 p-4 sm:p-5">
          {listLoading ? (
            <LoadingState title={t("jobs.loading")} />
          ) : listError ? (
            <EmptyState
              icon={<BriefcaseBusiness size={24} />}
              title={t("jobs.loadError")}
              description={listError}
              action={<Button onClick={() => void loadJobs()}>{t("jobs.retry")}</Button>}
            />
          ) : jobs.length === 0 ? (
            <EmptyState
              icon={<BriefcaseBusiness size={24} />}
              title={search ? t("jobs.noMatches") : t("jobs.empty")}
              description={search ? t("jobs.noMatchesDescription") : t("jobs.emptyDescription")}
            />
          ) : (
            jobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                active={job.id === jobId}
                onOpen={(item) => navigate(`/app/jobs/${item.id}`)}
                onOpenQuote={(item) => navigate(`/app/quotes/${item.sourceQuoteId}`)}
              />
            ))
          )}
        </div>
      </section>

      <PaginationControls
        limit={limit}
        offset={offset}
        total={total}
        loading={listLoading}
        itemLabel={t("jobs.itemLabel")}
        onLimitChange={(nextLimit) => {
          setLimit(nextLimit);
          setOffset(0);
        }}
        onOffsetChange={setOffset}
      />
    </div>
  );
}
