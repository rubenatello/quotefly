import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, BriefcaseBusiness, CalendarClock, CheckCircle2, ExternalLink, NotebookPen, Search, Send, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  publishKodyOutcome,
  type KodyBookingReviewDetail,
  type KodyDispatchReviewDetail,
} from "../components/ai/kody-events";
import {
  JobScheduleWorkspace,
  RescheduleModal,
  type AppointmentReloadResult,
  type ScheduleAssignee,
  type ScheduleRange,
} from "../components/jobs/JobScheduleWorkspace";
import { InvoicePanel } from "../components/invoices/InvoicePanel";
import { api, ApiError, type AppointmentNotificationReceipt, type Job, type JobAppointment, type JobAppointmentStatus, type JobNote, type JobScheduleAppointment, type JobStatus, type OrgUserRole } from "../lib/api";
import { localizedApiError } from "../lib/localized-api-error";
import { resolveTenantWallTime, toTenantDateTimeInput, validTimeZone, type TenantWallTimeResolution } from "../lib/tenant-time";
import { cn } from "../lib/utils";
import { publishNotificationsUpdated } from "../lib/notification-display";
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

function validCalendarDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day;
}

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

const APPOINTMENT_RELOAD_PAGE_SIZE = 100;
const APPOINTMENT_RELOAD_CAP = 500;

function isRouteStateRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kodyReviewState(value: unknown, jobId: string | undefined) {
  if (!jobId || !isRouteStateRecord(value)) return { booking: null, dispatch: null, focusReturnId: null };
  const booking = isRouteStateRecord(value.kodyBookingReview)
    && value.kodyBookingReview.jobId === jobId
    && (value.kodyBookingReview.mode === "CREATE" || value.kodyBookingReview.mode === "RESCHEDULE")
    && typeof value.kodyBookingReview.startsAtUtc === "string"
    && typeof value.kodyBookingReview.endsAtUtc === "string"
      ? value.kodyBookingReview as KodyBookingReviewDetail
      : null;
  const dispatch = isRouteStateRecord(value.kodyDispatchReview)
    && value.kodyDispatchReview.jobId === jobId
    && value.kodyDispatchReview.expectedStatus === "SCHEDULED"
    && typeof value.kodyDispatchReview.appointmentId === "string"
    && typeof value.kodyDispatchReview.appointmentVersion === "number"
      ? value.kodyDispatchReview as KodyDispatchReviewDetail
      : null;
  // This is deliberately an allowlisted static id rather than an arbitrary
  // selector from navigation state. Kody's launcher persists in CrmAppLayout.
  const focusReturnId: "kody-launcher" | null = booking?.mode === "RESCHEDULE" && value.kodyFocusReturnId === "kody-launcher"
    ? "kody-launcher"
    : null;
  return { booking, dispatch, focusReturnId };
}

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

function resolvedWallTimeIso(resolution: TenantWallTimeResolution, selectedIndex: number | null) {
  if (resolution.kind === "valid") return resolution.choices[0].iso;
  if (resolution.kind === "ambiguous" && selectedIndex !== null) return resolution.choices[selectedIndex]?.iso ?? null;
  return null;
}

function appointmentActionLabel(status: JobAppointmentStatus, t: ReturnType<typeof useTranslation>["t"]) {
  if (status === "DISPATCHED") return t("jobs.dispatch");
  if (status === "ARRIVED") return t("jobs.markArrived");
  if (status === "COMPLETED") return t("jobs.markComplete");
  if (status === "CANCELED") return t("jobs.cancelBooking");
  return t(`domain.appointmentStatus.${status}`);
}

function appointmentSuccessNotice(
  base: string,
  receipt: AppointmentNotificationReceipt | null,
  t: ReturnType<typeof useTranslation>["t"],
) {
  if (!receipt) return base;
  return `${base} ${t(receipt.createdCount > 0 ? "jobs.inAppNotificationAvailable" : "jobs.noInAppNotificationCreated")}`;
}

function scheduleAppointmentFromJob(
  appointment: JobAppointment,
  job: Job,
  proposedWindow?: { startsAtUtc: string; endsAtUtc: string; timeZone: string },
): JobScheduleAppointment {
  return {
    id: appointment.id,
    jobId: appointment.jobId,
    assignedTenantUserId: appointment.assignedTenantUserId,
    status: appointment.status,
    startsAtUtc: proposedWindow?.startsAtUtc ?? appointment.startsAtUtc,
    endsAtUtc: proposedWindow?.endsAtUtc ?? appointment.endsAtUtc,
    timeZone: proposedWindow?.timeZone ?? appointment.timeZone,
    version: appointment.version,
    assignedTenantUser: appointment.assignedTenantUser,
    job: {
      id: job.id,
      jobNumber: job.jobNumber,
      status: job.status,
      title: job.title,
      serviceAddressSnapshot: job.serviceAddressSnapshot,
      customer: job.customer,
      sourceQuote: { id: job.sourceQuote.id, title: job.sourceQuote.title },
    },
  };
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

function JobSchedulePanel({
  job,
  canManageJobs,
  onReloadLatest,
  kodyBookingReview,
  kodyDispatchReview,
  kodyFocusReturnId,
  onKodyReviewConsumed,
}: {
  job: Job;
  canManageJobs: boolean;
  onReloadLatest: () => void | Promise<void>;
  kodyBookingReview: KodyBookingReviewDetail | null;
  kodyDispatchReview: KodyDispatchReviewDetail | null;
  kodyFocusReturnId: "kody-launcher" | null;
  onKodyReviewConsumed: () => void;
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
  const [appointmentToDispatch, setAppointmentToDispatch] = useState<JobAppointment | null>(null);
  const [appointmentToReschedule, setAppointmentToReschedule] = useState<JobScheduleAppointment | null>(null);
  const [rescheduleInitialInstructions, setRescheduleInitialInstructions] = useState<string | null>(null);
  const [kodyBookingOutcome, setKodyBookingOutcome] = useState<KodyBookingReviewDetail | null>(null);
  const [kodyRescheduleOutcome, setKodyRescheduleOutcome] = useState<KodyBookingReviewDetail | null>(null);
  const [kodyDispatchOutcome, setKodyDispatchOutcome] = useState<KodyDispatchReviewDetail | null>(null);
  const [dispatchReviewError, setDispatchReviewError] = useState<string | null>(null);
  const [kodyReviewRetryAvailable, setKodyReviewRetryAvailable] = useState(false);
  const [kodyReviewAttempt, setKodyReviewAttempt] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [appointmentStale, setAppointmentStale] = useState(false);
  const [startsAt, setStartsAt] = useState(initialTimes.startsAt);
  const [endsAt, setEndsAt] = useState(initialTimes.endsAt);
  const [startChoice, setStartChoice] = useState<number | null>(null);
  const [endChoice, setEndChoice] = useState<number | null>(null);
  const [instructions, setInstructions] = useState("");
  const bookingFormRef = useRef<HTMLFormElement | null>(null);
  const staleAlertRef = useRef<HTMLDivElement | null>(null);
  const rescheduleTriggerRef = useRef<HTMLElement | null>(null);
  const processedKodyReviewRef = useRef<string | null>(null);
  const appointmentRequestGenerationRef = useRef(0);
  const bookingFormId = useMemo(() => `job-booking-form-${job.id}`, [job.id]);

  useEffect(() => {
    if (kodyBookingReview || kodyBookingOutcome) return;
    setStartsAt(initialTimes.startsAt);
    setEndsAt(initialTimes.endsAt);
    setStartChoice(null);
    setEndChoice(null);
  }, [initialTimes.endsAt, initialTimes.startsAt, kodyBookingOutcome, kodyBookingReview]);

  const startResolution = useMemo(() => resolveTenantWallTime(startsAt, timeZone), [startsAt, timeZone]);
  const endResolution = useMemo(() => resolveTenantWallTime(endsAt, timeZone), [endsAt, timeZone]);

  const loadAppointments = useCallback(async () => {
    const generation = appointmentRequestGenerationRef.current + 1;
    appointmentRequestGenerationRef.current = generation;
    setLoading(true);
    setError(null);
    try {
      const response = await api.jobs.appointments.list(job.id, { limit: appointmentLimit, offset: appointmentOffset });
      if (generation !== appointmentRequestGenerationRef.current) return;
      setAppointments(response.items);
      setAppointmentTotal(response.pagination.total);
    } catch (err) {
      if (generation !== appointmentRequestGenerationRef.current) return;
      setError(localizedApiError(err, t, { fallbackKey: "jobs.loadAppointmentsError" }));
    } finally {
      if (generation === appointmentRequestGenerationRef.current) setLoading(false);
    }
  }, [appointmentLimit, appointmentOffset, job.id, t]);

  useEffect(() => {
    void loadAppointments();
    return () => {
      appointmentRequestGenerationRef.current += 1;
    };
  }, [loadAppointments]);

  const loadAppointmentById = useCallback(async (appointmentId: string) => {
    let offset = 0;
    while (offset < APPOINTMENT_RELOAD_CAP) {
      const response = await api.jobs.appointments.list(job.id, {
        limit: APPOINTMENT_RELOAD_PAGE_SIZE,
        offset,
      });
      const match = response.items.find((appointment) => appointment.id === appointmentId);
      if (match) return { kind: "found" as const, appointment: match };
      offset += response.items.length;
      if (offset >= response.pagination.total || response.items.length === 0) return { kind: "missing" as const };
    }
    return { kind: "limit" as const };
  }, [job.id]);

  const createDisabled = !canManageJobs || !job.assignedTenantUserId || job.status === "COMPLETED" || job.status === "CANCELED";
  const formDisabled = saving || createDisabled;

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
    setAppointmentToCancel(null);
    setBookingFormOpen(false);
    await refreshAfterMutation();
  }, [refreshAfterMutation]);

  const openCreateForm = () => {
    setStartsAt(initialTimes.startsAt);
    setEndsAt(initialTimes.endsAt);
    setStartChoice(null);
    setEndChoice(null);
    setInstructions("");
    setActionError(null);
    setAppointmentStale(false);
    setBookingFormOpen((open) => {
      const nextOpen = !open;
      if (nextOpen) focusBookingForm();
      else setKodyBookingOutcome(null);
      return nextOpen;
    });
  };

  const openEditForm = (
    appointment: JobAppointment,
    proposedWindow?: { startsAtUtc: string; endsAtUtc: string; timeZone: string },
  ) => {
    if (appointment.status !== "SCHEDULED") return;
    rescheduleTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRescheduleInitialInstructions(appointment.instructions);
    setAppointmentToReschedule(scheduleAppointmentFromJob(appointment, job, proposedWindow));
  };

  const closeReschedule = () => {
    setAppointmentToReschedule(null);
    setRescheduleInitialInstructions(null);
    setKodyRescheduleOutcome(null);
    window.setTimeout(() => rescheduleTriggerRef.current?.focus(), 0);
  };

  useEffect(() => {
    const reviewKey = kodyBookingReview
      ? `booking:${kodyBookingReview.mode}:${kodyBookingReview.appointmentId ?? kodyBookingReview.jobId}:${kodyBookingReview.startsAtUtc}`
      : kodyDispatchReview
        ? `dispatch:${kodyDispatchReview.appointmentId}:${kodyDispatchReview.appointmentVersion}`
        : null;
    if (!reviewKey || processedKodyReviewRef.current === reviewKey) return;
    processedKodyReviewRef.current = reviewKey;
    let cancelled = false;

    const rejectReview = (message: string) => {
      if (cancelled) return;
      setActionError(message);
      focusStaleRecovery();
    };
    const finishReview = () => {
      if (cancelled) return;
      setKodyReviewRetryAvailable(false);
      onKodyReviewConsumed();
    };

    const prepareReview = async () => {
      try {
        if (kodyBookingReview) {
          if (!canManageJobs) {
            rejectReview(t("jobs.kodyBookingPermission"));
            return;
          }
          if (kodyBookingReview.customerId !== job.customer.id
            || kodyBookingReview.assignedTenantUserId !== job.assignedTenantUserId) {
            rejectReview(t("jobs.kodyReviewChanged"));
            return;
          }
          if (kodyBookingReview.mode === "CREATE") {
            if (cancelled) return;
            const proposedStart = toTenantDateTimeInput(kodyBookingReview.startsAtUtc, timeZone);
            const proposedEnd = toTenantDateTimeInput(kodyBookingReview.endsAtUtc, timeZone);
            const proposedStartResolution = resolveTenantWallTime(proposedStart, timeZone);
            const proposedEndResolution = resolveTenantWallTime(proposedEnd, timeZone);
            const proposedStartChoice = proposedStartResolution.kind === "ambiguous"
              ? proposedStartResolution.choices.findIndex((choice) => choice.iso === kodyBookingReview.startsAtUtc)
              : -1;
            const proposedEndChoice = proposedEndResolution.kind === "ambiguous"
              ? proposedEndResolution.choices.findIndex((choice) => choice.iso === kodyBookingReview.endsAtUtc)
              : -1;
            setStartsAt(proposedStart);
            setEndsAt(proposedEnd);
            setStartChoice(proposedStartChoice >= 0 ? proposedStartChoice : null);
            setEndChoice(proposedEndChoice >= 0 ? proposedEndChoice : null);
            setInstructions("");
            setKodyBookingOutcome(kodyBookingReview);
            setActionError(null);
            setBookingFormOpen(true);
            focusBookingForm();
            finishReview();
            return;
          }
          if (!kodyBookingReview.appointmentId || kodyBookingReview.appointmentVersion === undefined) {
            rejectReview(t("jobs.kodyReviewInvalid"));
            return;
          }
          const located = await loadAppointmentById(kodyBookingReview.appointmentId);
          if (cancelled) return;
          if (located.kind !== "found") {
            rejectReview(located.kind === "limit" ? t("jobs.bookingReloadLimit") : t("jobs.bookingNotFoundAfterReload"));
            return;
          }
          const current = located.appointment;
          if (current.status !== "SCHEDULED" || current.version !== kodyBookingReview.appointmentVersion
            || current.assignedTenantUserId !== kodyBookingReview.assignedTenantUserId) {
            rejectReview(t("jobs.kodyReviewChanged"));
            return;
          }
          setRescheduleInitialInstructions(current.instructions);
          setKodyRescheduleOutcome(kodyBookingReview);
          const focusReturnTarget = kodyFocusReturnId
            ? document.getElementById(kodyFocusReturnId)
            : null;
          rescheduleTriggerRef.current = focusReturnTarget instanceof HTMLElement
            && focusReturnTarget.isConnected
            && !focusReturnTarget.hasAttribute("disabled")
            ? focusReturnTarget
            : null;
          setAppointmentToReschedule(scheduleAppointmentFromJob(current, job, {
            startsAtUtc: kodyBookingReview.startsAtUtc,
            endsAtUtc: kodyBookingReview.endsAtUtc,
            timeZone,
          }));
          finishReview();
          return;
        }

        if (kodyDispatchReview) {
          const located = await loadAppointmentById(kodyDispatchReview.appointmentId);
          if (cancelled) return;
          if (located.kind !== "found") {
            rejectReview(located.kind === "limit" ? t("jobs.bookingReloadLimit") : t("jobs.bookingNotFoundAfterReload"));
            return;
          }
          const current = located.appointment;
          const memberOwnsBooking = current.assignedTenantUser.user.id === session?.userId;
          if ((!canManageJobs && !memberOwnsBooking)
            || current.status !== "SCHEDULED"
            || current.version !== kodyDispatchReview.appointmentVersion
            || current.assignedTenantUserId !== kodyDispatchReview.assignedTenantUserId) {
            rejectReview(t("jobs.kodyDispatchChanged"));
            return;
          }
          setKodyDispatchOutcome(kodyDispatchReview);
          setDispatchReviewError(null);
          setAppointmentToDispatch(current);
          finishReview();
          return;
        }
      } catch (err) {
        processedKodyReviewRef.current = null;
        setKodyReviewRetryAvailable(true);
        rejectReview(localizedApiError(err, t, { fallbackKey: "jobs.loadAppointmentsError" }));
        return;
      }
    };

    void prepareReview();
    return () => {
      cancelled = true;
      if (processedKodyReviewRef.current === reviewKey) {
        processedKodyReviewRef.current = null;
      }
    };
  }, [
    canManageJobs,
    focusBookingForm,
    focusStaleRecovery,
    job,
    kodyBookingReview,
    kodyDispatchReview,
    kodyFocusReturnId,
    kodyReviewAttempt,
    loadAppointmentById,
    onKodyReviewConsumed,
    session?.userId,
    t,
    timeZone,
  ]);

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (formDisabled || !job.assignedTenantUserId) return;
    setNotice(null);
    setActionError(null);
    setAppointmentStale(false);
    if (startResolution.kind === "invalid" || startResolution.kind === "nonexistent" || endResolution.kind === "invalid" || endResolution.kind === "nonexistent") {
      setActionError(t("jobs.invalidOrMissingWallTime"));
      return;
    }
    const startsAtUtc = resolvedWallTimeIso(startResolution, startChoice);
    const endsAtUtc = resolvedWallTimeIso(endResolution, endChoice);
    if (!startsAtUtc || !endsAtUtc) {
      setActionError(t("jobs.chooseAmbiguousTime"));
      return;
    }
    if (new Date(startsAtUtc) >= new Date(endsAtUtc)) {
      setActionError(t("jobs.endAfterStart"));
      return;
    }
    setSaving(true);
    try {
      const assignedTenantUserId = job.assignedTenantUserId;
      if (!assignedTenantUserId) {
        setSaving(false);
        return;
      }
      const response = await api.jobs.appointments.create(job.id, {
        assignedTenantUserId,
        startsAtUtc,
        endsAtUtc,
        timeZone,
        instructions: instructions.trim() || null,
      });
      const notificationReceipt = response.notificationReceipt ?? null;
      publishNotificationsUpdated(notificationReceipt?.createdCount ?? 0);
      setInstructions("");
      setBookingFormOpen(false);
      setNotice(appointmentSuccessNotice(
        kodyBookingOutcome ? t("jobs.kodyBookingSaved") : t("jobs.bookingSaved"),
        notificationReceipt,
        t,
      ));
      if (kodyBookingOutcome) {
        publishKodyOutcome({
          type: "BOOKING_CREATED",
          jobNumber: job.jobNumber,
          customerName: job.customer.fullName,
          startsAtUtc,
          inAppNotificationCreated: (notificationReceipt?.createdCount ?? 0) > 0,
        });
        setKodyBookingOutcome(null);
      }
      await refreshAfterMutation();
    } catch (err) {
      handleAppointmentActionError(err, "jobs.bookingSaveError");
    } finally {
      setSaving(false);
    }
  };

  const updateAppointmentStatus = async (
    appointment: JobAppointment,
    status: JobAppointmentStatus,
    fromKodyDispatchReview = false,
  ) => {
    if (updatingId) return;
    setNotice(null);
    setActionError(null);
    if (fromKodyDispatchReview) setDispatchReviewError(null);
    setAppointmentStale(false);
    setUpdatingId(appointment.id);
    try {
      const response = await api.jobs.appointments.update(job.id, appointment.id, {
        version: appointment.version,
        status,
      });
      const notificationReceipt = response.notificationReceipt ?? null;
      publishNotificationsUpdated(notificationReceipt?.createdCount ?? 0);
      setNotice(appointmentSuccessNotice(
        fromKodyDispatchReview ? t("jobs.kodyDispatchSaved") : t("jobs.bookingSaved"),
        notificationReceipt,
        t,
      ));
      if (fromKodyDispatchReview && status === "DISPATCHED" && kodyDispatchOutcome) {
        publishKodyOutcome({
          type: "BOOKING_DISPATCHED",
          jobNumber: job.jobNumber,
          customerName: job.customer.fullName,
          inAppNotificationCreated: (notificationReceipt?.createdCount ?? 0) > 0,
        });
        setKodyDispatchOutcome(null);
      }
      setAppointmentToDispatch(null);
      await refreshAfterMutation();
    } catch (err) {
      if (fromKodyDispatchReview) {
        setDispatchReviewError(localizedApiError(err, t, { fallbackKey: "jobs.statusUpdateError" }));
      } else {
        handleAppointmentActionError(err, "jobs.statusUpdateError");
      }
    } finally {
      setUpdatingId(null);
    }
  };

  const reloadKodyDispatchReview = async () => {
    if (!appointmentToDispatch || updatingId) return;
    setUpdatingId(appointmentToDispatch.id);
    setDispatchReviewError(null);
    try {
      const located = await loadAppointmentById(appointmentToDispatch.id);
      if (located.kind !== "found") {
        setDispatchReviewError(located.kind === "limit" ? t("jobs.bookingReloadLimit") : t("jobs.bookingNotFoundAfterReload"));
        return;
      }
      const current = located.appointment;
      const memberOwnsBooking = current.assignedTenantUser.user.id === session?.userId;
      if ((!canManageJobs && !memberOwnsBooking) || current.status !== "SCHEDULED") {
        setDispatchReviewError(t("jobs.kodyDispatchChanged"));
        return;
      }
      setAppointmentToDispatch(current);
      setKodyDispatchOutcome((review) => review ? {
        ...review,
        appointmentVersion: current.version,
        startsAtUtc: current.startsAtUtc,
        endsAtUtc: current.endsAtUtc,
        timeZone: current.timeZone,
        assignedTenantUserId: current.assignedTenantUserId,
        assigneeName: current.assignedTenantUser.user.fullName,
      } : review);
    } catch (err) {
      setDispatchReviewError(localizedApiError(err, t, { fallbackKey: "jobs.loadAppointmentsError" }));
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
      const response = await api.jobs.appointments.remove(job.id, appointmentToCancel.id, appointmentToCancel.version);
      const notificationReceipt = response?.notificationReceipt ?? null;
      publishNotificationsUpdated(notificationReceipt?.createdCount ?? 0);
      setNotice(appointmentSuccessNotice(t("jobs.bookingCanceled"), notificationReceipt, t));
      setAppointmentToCancel(null);
      await refreshAfterMutation();
    } catch (err) {
      handleAppointmentActionError(err, "jobs.bookingCancelError", { closeCancelModal: true });
    } finally {
      setUpdatingId(null);
    }
  };

  const reloadAppointmentForReschedule = useCallback(async (
    current: JobScheduleAppointment,
  ): Promise<AppointmentReloadResult> => {
    try {
      let reloadOffset = 0;
      while (reloadOffset < APPOINTMENT_RELOAD_CAP) {
        const response = await api.jobs.appointments.list(job.id, {
          limit: APPOINTMENT_RELOAD_PAGE_SIZE,
          offset: reloadOffset,
        });
        const latest = response.items.find((appointment) => appointment.id === current.id);
        if (latest) {
          if (latest.status !== "SCHEDULED") return { kind: "notScheduled" };
          return {
            kind: "current",
            appointment: {
              id: latest.id,
              jobId: latest.jobId,
              assignedTenantUserId: latest.assignedTenantUserId,
              status: latest.status,
              startsAtUtc: latest.startsAtUtc,
              endsAtUtc: latest.endsAtUtc,
              timeZone: latest.timeZone,
              version: latest.version,
              assignedTenantUser: latest.assignedTenantUser,
              job: current.job,
            },
          };
        }
        reloadOffset += APPOINTMENT_RELOAD_PAGE_SIZE;
        if (reloadOffset >= response.pagination.total) return { kind: "missing" };
      }
      return { kind: "limit" };
    } catch {
      return { kind: "network" };
    }
  }, [job.id]);

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
        <div ref={staleAlertRef} tabIndex={appointmentStale || kodyReviewRetryAvailable ? -1 : undefined} className="mt-4">
          <Alert tone="error" onDismiss={() => {
            setActionError(null);
            setAppointmentStale(false);
            if (kodyReviewRetryAvailable) {
              setKodyReviewRetryAvailable(false);
              onKodyReviewConsumed();
            }
          }}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span>{actionError}</span>
              {kodyReviewRetryAvailable ? (
                <Button type="button" variant="outline" className="min-h-11 shrink-0" onClick={() => {
                  setActionError(null);
                  setKodyReviewRetryAvailable(false);
                  processedKodyReviewRef.current = null;
                  setKodyReviewAttempt((attempt) => attempt + 1);
                }}>
                  {t("jobs.retryKodyReview")}
                </Button>
              ) : appointmentStale ? (
                <Button type="button" variant="outline" className="min-h-11 shrink-0" onClick={() => void reloadLatestBooking()}>
                  {t("jobs.reloadLatestBooking")}
                </Button>
              ) : null}
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
              <article key={appointment.id} data-appointment-id={appointment.id} className="rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)] p-4">
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
                      {canManageJobs && appointment.status === "SCHEDULED" && (
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
        <form id={bookingFormId} ref={bookingFormRef} data-testid="job-booking-form" className="mt-4 rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-4" onSubmit={handleCreate}>
          {kodyBookingOutcome && <Alert tone="info">{t("jobs.kodyBookingReviewNotice")}</Alert>}
          {!job.assignedTenantUserId && <Alert tone="warning">{t("jobs.assignBeforeBooking")}</Alert>}
          {(job.status === "COMPLETED" || job.status === "CANCELED") && <Alert tone="warning">{t("jobs.bookingLocked")}</Alert>}
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <Input
                type="datetime-local"
                label={t("jobs.startTime")}
                value={startsAt}
                onChange={(event) => {
                  setStartsAt(event.target.value);
                  setStartChoice(null);
                }}
                disabled={formDisabled}
              />
              {startResolution.kind === "ambiguous" ? (
                <Select
                  label={t("jobs.startTimeOffset")}
                  value={startChoice === null ? "" : String(startChoice)}
                  onChange={(event) => setStartChoice(event.target.value === "" ? null : Number(event.target.value))}
                  disabled={formDisabled}
                  options={[
                    { value: "", label: t("jobs.chooseTimeOffset") },
                    ...startResolution.choices.map((choice, index) => ({ value: String(index), label: `${choice.zoneName} (${choice.offsetLabel})` })),
                  ]}
                />
              ) : null}
              {(startResolution.kind === "nonexistent" || startResolution.kind === "invalid") && startsAt ? (
                <p className="text-sm text-[var(--qf-danger)]" role="alert">{t("jobs.nonexistentWallTime")}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Input
                type="datetime-local"
                label={t("jobs.endTime")}
                value={endsAt}
                onChange={(event) => {
                  setEndsAt(event.target.value);
                  setEndChoice(null);
                }}
                disabled={formDisabled}
              />
              {endResolution.kind === "ambiguous" ? (
                <Select
                  label={t("jobs.endTimeOffset")}
                  value={endChoice === null ? "" : String(endChoice)}
                  onChange={(event) => setEndChoice(event.target.value === "" ? null : Number(event.target.value))}
                  disabled={formDisabled}
                  options={[
                    { value: "", label: t("jobs.chooseTimeOffset") },
                    ...endResolution.choices.map((choice, index) => ({ value: String(index), label: `${choice.zoneName} (${choice.offsetLabel})` })),
                  ]}
                />
              ) : null}
              {(endResolution.kind === "nonexistent" || endResolution.kind === "invalid") && endsAt ? (
                <p className="text-sm text-[var(--qf-danger)]" role="alert">{t("jobs.nonexistentWallTime")}</p>
              ) : null}
            </div>
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
            <Button type="submit" loading={saving} disabled={formDisabled}>
              {saving ? t("jobs.creatingBooking") : t("jobs.createBooking")}
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
      <ConfirmModal
        open={Boolean(appointmentToDispatch)}
        onClose={() => {
          setAppointmentToDispatch(null);
          setKodyDispatchOutcome(null);
          setDispatchReviewError(null);
        }}
        onConfirm={() => {
          if (appointmentToDispatch) void updateAppointmentStatus(appointmentToDispatch, "DISPATCHED", true);
        }}
        title={t("jobs.kodyDispatchTitle", { customer: job.customer.fullName })}
        description={t("jobs.kodyDispatchDescription")}
        confirmLabel={t("jobs.kodyDispatchConfirm")}
        confirmVariant="primary"
        loading={Boolean(appointmentToDispatch && updatingId === appointmentToDispatch.id)}
      >
        {appointmentToDispatch && (
          <div className="space-y-3">
          {dispatchReviewError && (
            <Alert tone="error">
              <div className="flex flex-col gap-3">
                <span>{dispatchReviewError}</span>
                <Button type="button" variant="outline" className="min-h-11 self-start" onClick={() => void reloadKodyDispatchReview()} disabled={Boolean(updatingId)}>
                  {t("jobs.reloadLatestBooking")}
                </Button>
              </div>
            </Alert>
          )}
          <dl data-testid="kody-dispatch-review" className="space-y-2 rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-3 text-sm">
            <div>
              <dt className="font-medium text-[var(--qf-text)]">{t("jobs.scheduledWindowLabel")}</dt>
              <dd className="mt-1 text-[var(--qf-text-soft)]">{t("jobs.scheduledWindow", {
                start: formatDateTime(appointmentToDispatch.startsAtUtc, i18n.resolvedLanguage, timeZone),
                end: formatDateTime(appointmentToDispatch.endsAtUtc, i18n.resolvedLanguage, timeZone),
              })}</dd>
            </div>
            <div>
              <dt className="font-medium text-[var(--qf-text)]">{t("jobs.assignee")}</dt>
              <dd className="mt-1 text-[var(--qf-text-soft)]">{appointmentToDispatch.assignedTenantUser.user.fullName}</dd>
            </div>
            <div>
              <dt className="font-medium text-[var(--qf-text)]">{t("jobs.serviceAddress")}</dt>
              <dd className="mt-1 text-[var(--qf-text-soft)]">{job.serviceAddressSnapshot || t("jobs.noAddress")}</dd>
            </div>
            <div>
              <dt className="font-medium text-[var(--qf-text)]">{t("jobs.bookingInstructions")}</dt>
              <dd className="mt-1 whitespace-pre-wrap text-[var(--qf-text-soft)]">{appointmentToDispatch.instructions || t("jobs.noBookingInstructions")}</dd>
            </div>
          </dl>
          </div>
        )}
      </ConfirmModal>
      <RescheduleModal
        appointment={appointmentToReschedule}
        timeZone={timeZone}
        editInstructions
        initialInstructions={rescheduleInitialInstructions}
        onClose={closeReschedule}
        onSaved={async ({ startsAtUtc, changed, notificationReceipt }) => {
          setNotice(appointmentSuccessNotice(
            changed
              ? (kodyRescheduleOutcome ? t("jobs.kodyBookingUpdated") : t("jobs.bookingUpdated"))
              : t("jobs.rescheduleNoChanges"),
            notificationReceipt,
            t,
          ));
          if (kodyRescheduleOutcome && changed) {
            publishKodyOutcome({
              type: "BOOKING_RESCHEDULED",
              jobNumber: job.jobNumber,
              customerName: job.customer.fullName,
              startsAtUtc,
              inAppNotificationCreated: (notificationReceipt?.createdCount ?? 0) > 0,
            });
          }
          if (kodyRescheduleOutcome) setKodyRescheduleOutcome(null);
          if (changed) await refreshAfterMutation();
        }}
        onReloadVersion={reloadAppointmentForReschedule}
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
  kodyBookingReview,
  kodyDispatchReview,
  kodyFocusReturnId,
  onKodyReviewConsumed,
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
  kodyBookingReview: KodyBookingReviewDetail | null;
  kodyDispatchReview: KodyDispatchReviewDetail | null;
  kodyFocusReturnId: "kody-launcher" | null;
  onKodyReviewConsumed: () => void;
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
          <Button className="min-h-11" onClick={() => navigate(`/app/quotes/${job.sourceQuoteId}`)}>
            <ExternalLink size={16} />
            {t("jobs.openQuote")}
          </Button>
        </div>
      </div>

      <div className="mt-6">
        <JobSchedulePanel
          job={job}
          canManageJobs={canManageJobs}
          onReloadLatest={onReloadLatest}
          kodyBookingReview={kodyBookingReview}
          kodyDispatchReview={kodyDispatchReview}
          kodyFocusReturnId={kodyFocusReturnId}
          onKodyReviewConsumed={onKodyReviewConsumed}
        />
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
  const location = useLocation();
  const { jobId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { session } = useDashboard();
  const canManageJobs = session?.role === "owner" || session?.role === "admin";
  const workspaceTimeZone = validTimeZone(session?.timezone ?? "UTC");
  const tenantToday = toTenantDateTimeInput(new Date(), workspaceTimeZone).slice(0, 10);
  const workspaceView = searchParams.get("view") === "schedule" ? "schedule" : "jobs";
  const requestedScheduleRange = searchParams.get("range");
  const scheduleRange: ScheduleRange = requestedScheduleRange === "day"
    ? "day"
    : requestedScheduleRange === "next7"
      ? "next7"
      : "week";
  const selectedScheduleDate = validCalendarDate(searchParams.get("date")) ? searchParams.get("date")! : tenantToday;
  const requestedAssignee = searchParams.get("assignee");
  const scheduleAssignee: ScheduleAssignee = canManageJobs
    ? requestedAssignee && requestedAssignee !== "" ? requestedAssignee : "all"
    : "me";
  const kodyReview = useMemo(() => kodyReviewState(location.state, jobId), [jobId, location.state]);
  const consumeKodyReview = useCallback(() => {
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [location.pathname, location.search, navigate]);
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
  const listRequestGenerationRef = useRef(0);
  const detailRequestGenerationRef = useRef(0);

  useEffect(() => {
    if (jobId) return;
    const next = new URLSearchParams(searchParams);
    next.set("view", workspaceView);
    next.set("range", scheduleRange);
    next.set("date", selectedScheduleDate);
    next.set("assignee", scheduleAssignee);
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
  }, [jobId, scheduleAssignee, scheduleRange, searchParams, selectedScheduleDate, setSearchParams, workspaceView]);

  const updateWorkspaceSearch = useCallback((updates: Record<string, string>) => {
    const next = new URLSearchParams(searchParams);
    Object.entries(updates).forEach(([key, value]) => next.set(key, value));
    setSearchParams(next);
  }, [searchParams, setSearchParams]);

  const query = useMemo(() => ({
    status: status === "active" ? undefined : status,
    search: search.trim() || undefined,
    limit,
    offset,
  }), [limit, offset, search, status]);

  const loadJobs = useCallback(async () => {
    const generation = listRequestGenerationRef.current + 1;
    listRequestGenerationRef.current = generation;
    setListLoading(true);
    setListError(null);
    try {
      const response = await api.jobs.list(query);
      if (generation !== listRequestGenerationRef.current) return;
      setJobs(response.items);
      setTotal(response.pagination.total);
    } catch (err) {
      if (generation !== listRequestGenerationRef.current) return;
      setListError(localizedApiError(err, t, { fallbackKey: "jobs.loadError" }));
    } finally {
      if (generation === listRequestGenerationRef.current) setListLoading(false);
    }
  }, [query, t]);

  useEffect(() => {
    if (jobId || workspaceView !== "jobs") return;
    void loadJobs();
  }, [jobId, loadJobs, workspaceView]);

  const loadJob = useCallback(async (id: string) => {
    const generation = detailRequestGenerationRef.current + 1;
    detailRequestGenerationRef.current = generation;
    setDetailLoading(true);
    setDetailError(null);
    setEditError(null);
    setEditStale(false);
    try {
      const response = await api.jobs.get(id);
      if (generation !== detailRequestGenerationRef.current) return;
      setSelectedJob(response.job);
    } catch (err) {
      if (generation !== detailRequestGenerationRef.current) return;
      setSelectedJob(null);
      setDetailError(localizedApiError(err, t, { fallbackKey: "jobs.loadDetailError" }));
    } finally {
      if (generation === detailRequestGenerationRef.current) setDetailLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!jobId) {
      detailRequestGenerationRef.current += 1;
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
        kodyBookingReview={kodyReview.booking}
        kodyDispatchReview={kodyReview.dispatch}
        kodyFocusReturnId={kodyReview.focusReturnId}
        onKodyReviewConsumed={consumeKodyReview}
      />
    );
  }

  return (
    <div className="min-w-0 max-w-full space-y-5 overflow-x-hidden">
      <section className="rounded-3xl border border-[var(--qf-border)] bg-[var(--qf-panel)] p-3 shadow-[var(--qf-shadow-sm)] sm:p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("jobs.workspace")}</p>
            <h1 className="mt-1 font-display text-2xl font-semibold tracking-[-0.03em] text-[var(--qf-text)]">{t("jobs.title")}</h1>
          </div>
          <div className="grid grid-cols-2 gap-2" role="group" aria-label={t("jobs.workspaceViewLabel")}>
            <Button type="button" variant={workspaceView === "schedule" ? "primary" : "outline"} className="min-h-11" aria-pressed={workspaceView === "schedule"} onClick={() => updateWorkspaceSearch({ view: "schedule" })}>
              <CalendarClock size={17} aria-hidden="true" />
              {t("jobs.scheduleView")}
            </Button>
            <Button type="button" variant={workspaceView === "jobs" ? "primary" : "outline"} className="min-h-11" aria-pressed={workspaceView === "jobs"} onClick={() => updateWorkspaceSearch({ view: "jobs" })}>
              <BriefcaseBusiness size={17} aria-hidden="true" />
              {t("jobs.jobsView")}
            </Button>
          </div>
        </div>
      </section>

      {workspaceView === "schedule" ? (
        <JobScheduleWorkspace
          range={scheduleRange}
          selectedDate={selectedScheduleDate}
          assignee={scheduleAssignee}
          canManageJobs={canManageJobs}
          onRangeChange={(range) => updateWorkspaceSearch({ range })}
          onDateChange={(date) => updateWorkspaceSearch({ date })}
          onAssigneeChange={(assignee) => updateWorkspaceSearch({ assignee })}
        />
      ) : (
        <>

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
        </>
      )}
    </div>
  );
}
