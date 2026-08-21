import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, Check, ChevronRight, ClipboardList, Pencil, Plus, RotateCcw, Search, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Alert,
  Badge,
  Button,
  ConfirmModal,
  EmptyState,
  Input,
  LoadingState,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  PaginationControls,
  Select,
  Textarea,
  type PageSize,
} from "../ui";
import {
  ApiError,
  api,
  type ActivityTask,
  type ActivityTaskDueFilter,
  type ActivityTaskInput,
  type ActivityTaskPriority,
  type ActivityTaskType,
  type Customer,
  type OrganizationUser,
} from "../../lib/api";
import { notify } from "../../lib/notifications";
import { localizedApiError } from "../../lib/localized-api-error";
import { formatTenantDateTime, tenantWallTimeToIso, toTenantDateTimeInput } from "../../lib/tenant-time";

type TaskForm = {
  customerId: string;
  quoteId: string;
  assignedTenantUserId: string;
  type: ActivityTaskType;
  priority: ActivityTaskPriority;
  title: string;
  notes: string;
  dueLocal: string;
};

export type ActivityTaskDraft = {
  customerId: string;
  customerName: string;
  quoteId?: string | null;
  quoteTitle?: string | null;
  type: ActivityTaskType;
  priority: ActivityTaskPriority;
  title: string;
  dueAtUtc: string;
};

const TYPE_VALUES: ActivityTaskType[] = ["FOLLOW_UP", "PREPARE_QUOTE", "SEND_QUOTE", "CHECK_IN", "CUSTOM"];
const PRIORITY_VALUES: ActivityTaskPriority[] = ["LOW", "NORMAL", "HIGH", "URGENT"];
const FILTER_VALUES: ActivityTaskDueFilter[] = ["active", "overdue", "today", "upcoming", "completed"];

function typeLabel(value: ActivityTaskType, t: TFunction) {
  if (value === "FOLLOW_UP") return t("activity.tasks.type.followUp");
  if (value === "PREPARE_QUOTE") return t("activity.tasks.type.prepareQuote");
  if (value === "SEND_QUOTE") return t("activity.tasks.type.sendQuote");
  if (value === "CHECK_IN") return t("activity.tasks.type.checkIn");
  if (value === "CUSTOM") return t("activity.tasks.type.custom");
  return t("activity.tasks.type.fallback");
}

function priorityLabel(value: ActivityTaskPriority, t: TFunction) {
  return t(`activity.tasks.priorityValue.${value.toLowerCase()}`);
}

function filterLabel(value: ActivityTaskDueFilter, t: TFunction) {
  return t(`activity.tasks.filter.${value}`);
}

function initialForm(timezone: string, assignedTenantUserId: string): TaskForm {
  const due = new Date(Date.now() + 60 * 60 * 1000);
  due.setMinutes(Math.ceil(due.getMinutes() / 15) * 15, 0, 0);
  return {
    customerId: "",
    quoteId: "",
    assignedTenantUserId,
    type: "FOLLOW_UP",
    priority: "NORMAL",
    title: "",
    notes: "",
    dueLocal: toTenantDateTimeInput(due, timezone),
  };
}

function draftCustomerOption(draft: ActivityTaskDraft, nowIso: string): Customer {
  return {
    id: draft.customerId,
    tenantId: "",
    fullName: draft.customerName,
    phone: "",
    email: null,
    notes: null,
    preferredLocale: null,
    followUpStatus: "NEEDS_FOLLOW_UP",
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

function priorityTone(priority: ActivityTaskPriority): "slate" | "blue" | "orange" | "red" {
  if (priority === "URGENT") return "red";
  if (priority === "HIGH") return "orange";
  if (priority === "LOW") return "slate";
  return "blue";
}

function editableFormFingerprint(form: TaskForm): string {
  return JSON.stringify({
    customerId: form.customerId,
    quoteId: form.quoteId,
    type: form.type,
    priority: form.priority,
    title: form.title,
    notes: form.notes,
    dueLocal: form.dueLocal,
  });
}

function dueTone(task: ActivityTask): "slate" | "orange" | "red" | "emerald" {
  if (task.status === "COMPLETED") return "emerald";
  if (task.status === "CANCELED") return "slate";
  if (new Date(task.dueAtUtc).getTime() < Date.now()) return "red";
  return "orange";
}

function dueLabel(task: ActivityTask, timezone: string, t: TFunction, locale: string): string {
  if (task.status === "COMPLETED") {
    return t("activity.tasks.completedAt", { date: formatTenantDateTime(task.completedAtUtc ?? task.dueAtUtc, timezone, locale) });
  }
  if (task.status === "CANCELED") {
    return t("activity.tasks.canceledAt", { date: formatTenantDateTime(task.canceledAtUtc ?? task.dueAtUtc, timezone, locale) });
  }

  const dueTime = new Date(task.dueAtUtc).getTime();
  if (dueTime < Date.now()) {
    return t("activity.tasks.overdueAt", { date: formatTenantDateTime(task.dueAtUtc, timezone, locale) });
  }

  const dueDate = toTenantDateTimeInput(task.dueAtUtc, timezone).slice(0, 10);
  const today = toTenantDateTimeInput(new Date(), timezone).slice(0, 10);
  if (dueDate === today) {
    const dueTimeOnly = new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(task.dueAtUtc));
    return t("activity.tasks.dueToday", { time: dueTimeOnly });
  }

  return t("activity.tasks.upcomingAt", { date: formatTenantDateTime(task.dueAtUtc, timezone, locale) });
}

function TaskEditor({
  open,
  task,
  draft,
  timezone,
  currentUserId,
  canManage,
  saving,
  onClose,
  onSaved,
  onReloadLatest,
}: {
  open: boolean;
  task: ActivityTask | null;
  draft?: ActivityTaskDraft | null;
  timezone: string;
  currentUserId: string;
  canManage: boolean;
  saving: boolean;
  onClose: () => void;
  onSaved: (task: ActivityTask) => void;
  onReloadLatest: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<TaskForm>(() => initialForm(timezone, ""));
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [members, setMembers] = useState<OrganizationUser[]>([]);
  const [customerSearch, setCustomerSearch] = useState("");
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [baselineFingerprint, setBaselineFingerprint] = useState("");
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [quotes, setQuotes] = useState<Array<{ id: string; title: string }>>([]);
  const requestIdRef = useRef(0);
  const submittingRef = useRef(false);
  const commandRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const busy = saving || submitting;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setStale(false);
    setDiscardConfirmOpen(false);
    commandRef.current = null;
    setCustomerSearch("");
    if (task) {
      const nextForm: TaskForm = {
        customerId: task.customerId,
        quoteId: task.quoteId ?? "",
        assignedTenantUserId: task.assignedTenantUserId,
        type: task.type,
        priority: task.priority,
        title: task.title,
        notes: task.notes ?? "",
        dueLocal: toTenantDateTimeInput(task.dueAtUtc, timezone),
      };
      setForm(nextForm);
      setBaselineFingerprint(editableFormFingerprint(nextForm));
      setCustomers([task.customer as Customer]);
      setQuotes(task.quote ? [{ id: task.quote.id, title: task.quote.title }] : []);
    } else if (draft) {
      const nextForm: TaskForm = {
        customerId: draft.customerId,
        quoteId: draft.quoteId ?? "",
        assignedTenantUserId: "",
        type: draft.type,
        priority: draft.priority,
        title: draft.title,
        notes: "",
        dueLocal: toTenantDateTimeInput(draft.dueAtUtc, timezone),
      };
      const nowIso = new Date().toISOString();
      setForm(nextForm);
      setBaselineFingerprint(editableFormFingerprint(nextForm));
      setCustomers([draftCustomerOption(draft, nowIso)]);
      setQuotes(draft.quoteId && draft.quoteTitle ? [{ id: draft.quoteId, title: draft.quoteTitle }] : []);
    } else {
      const nextForm = initialForm(timezone, "");
      setForm(nextForm);
      setBaselineFingerprint(editableFormFingerprint(nextForm));
      setQuotes([]);
    }
  }, [draft, open, task, timezone]);

  useEffect(() => {
    if (!open || (task && !canManage)) return;
    const timeoutId = window.setTimeout(async () => {
      const requestId = ++requestIdRef.current;
      setLoadingOptions(true);
      try {
        const [customerResult, memberResult] = await Promise.all([
          task || draft
            ? Promise.resolve(null)
            : api.customers.list({ lifecycle: "active", search: customerSearch.trim() || undefined, limit: 100 }),
          canManage ? api.org.users.list({ limit: 100 }) : Promise.resolve(null),
        ]);
        if (requestId !== requestIdRef.current) return;
        if (customerResult) setCustomers(customerResult.customers);
        const loadedMembers = memberResult?.members ?? [];
        setMembers(loadedMembers);
        const currentMembership = !task
          ? loadedMembers.find((member) => member.user.id === currentUserId)
          : null;
        if (currentMembership && !task) {
          setForm((current) => current.assignedTenantUserId
            ? current
            : { ...current, assignedTenantUserId: currentMembership.id });
        }
      } catch (loadError) {
        if (requestId === requestIdRef.current) {
          setError(localizedApiError(loadError, t, {
            fallbackKey: "activity.tasks.optionsError",
            statusKeys: { 400: "apiErrors.invalidRequest" },
          }));
        }
      } finally {
        if (requestId === requestIdRef.current) setLoadingOptions(false);
      }
    }, 200);
    return () => window.clearTimeout(timeoutId);
  }, [canManage, currentUserId, customerSearch, draft, open, t, task]);

  useEffect(() => {
    if (!open || task || draft || !form.customerId) {
      if (!task && !draft) setQuotes([]);
      return;
    }
    let live = true;
    void api.customers.get(form.customerId).then((result) => {
      if (!live) return;
      setQuotes(result.quotes.map((quote) => ({ id: quote.id, title: quote.title })));
      setForm((current) => ({ ...current, quoteId: "" }));
    }).catch(() => {
      if (live) setQuotes([]);
    });
    return () => {
      live = false;
    };
  }, [draft, form.customerId, open, task]);

  async function submit() {
    if (submittingRef.current) return;
    setError(null);
    setStale(false);
    const dueAtUtc = tenantWallTimeToIso(form.dueLocal, timezone);
    if (!form.customerId || !form.title.trim() || !dueAtUtc) {
      setError(t("activity.tasks.chooseRequired"));
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      if (task) {
        const body = {
          version: task.version,
          assignedTenantUserId: canManage ? form.assignedTenantUserId : undefined,
          type: form.type,
          priority: form.priority,
          title: form.title.trim(),
          notes: form.notes.trim() || null,
          dueAtUtc,
        };
        const fingerprint = JSON.stringify({ operation: "update", taskId: task.id, body });
        if (commandRef.current?.fingerprint !== fingerprint) {
          commandRef.current = { fingerprint, key: `qf-ui-${crypto.randomUUID()}` };
        }
        const result = await api.activities.update(task.id, body, commandRef.current.key);
        onSaved(result.task);
      } else {
        const body: ActivityTaskInput = {
          customerId: form.customerId,
          quoteId: form.quoteId || null,
          assignedTenantUserId: canManage ? form.assignedTenantUserId || undefined : undefined,
          type: form.type,
          priority: form.priority,
          title: form.title.trim(),
          notes: form.notes.trim() || null,
          dueAtUtc,
        };
        const fingerprint = JSON.stringify({ operation: "create", body });
        if (commandRef.current?.fingerprint !== fingerprint) {
          commandRef.current = { fingerprint, key: `qf-ui-${crypto.randomUUID()}` };
        }
        const result = await api.activities.create(body, commandRef.current.key);
        onSaved(result.task);
      }
    } catch (saveError) {
      if (saveError instanceof ApiError && saveError.status === 409 && saveError.code === "ACTIVITY_STALE_VERSION") {
        setStale(true);
      }
      setError(localizedApiError(saveError, t, {
        fallbackKey: "activity.tasks.saveError",
        statusKeys: { 400: "apiErrors.invalidRequest" },
      }));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function reloadLatest() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onReloadLatest();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const memberOptions = members.map((member) => ({ value: member.id, label: `${member.user.fullName} · ${member.role}` }));
  const customerOptions = customers.map((customer) => ({ value: customer.id, label: customer.fullName }));
  const quoteOptions = [{ value: "", label: t("activity.tasks.noLinkedQuote") }, ...quotes.map((quote) => ({ value: quote.id, label: quote.title }))];
  const typeOptions = TYPE_VALUES.map((value) => ({ value, label: typeLabel(value, t) }));
  const priorityOptions = PRIORITY_VALUES.map((value) => ({ value, label: priorityLabel(value, t) }));
  const selfMembershipId = members.find((member) => member.user.id === currentUserId)?.id ?? "";
  const assignmentDirty = canManage
    ? task
      ? form.assignedTenantUserId !== task.assignedTenantUserId
      : Boolean(form.assignedTenantUserId && selfMembershipId && form.assignedTenantUserId !== selfMembershipId)
    : false;
  const dirty = assignmentDirty || (baselineFingerprint.length > 0 && editableFormFingerprint(form) !== baselineFingerprint);

  function requestClose() {
    if (busy) return;
    if (dirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    onClose();
  }

  return (
    <>
    <Modal open={open} onClose={busy ? () => undefined : requestClose} closeOnBackdrop={!busy} size="lg" ariaLabel={task ? t("activity.tasks.editAria") : t("activity.tasks.createAria")}>
      <ModalHeader
        title={task ? t("activity.tasks.edit") : t("activity.tasks.add")}
        description={t("activity.tasks.editorDescription")}
        onClose={busy ? undefined : requestClose}
      />
      <ModalBody>
        <div className="space-y-4" aria-busy={busy}>
          {error ? (
            <Alert tone="error" onDismiss={stale ? undefined : () => setError(null)}>
              <span className="flex flex-wrap items-center gap-3">
                <span>{error}</span>
                {stale ? (
                  <Button size="sm" variant="outline" onClick={() => void reloadLatest()} loading={submitting}>
                    {t("activity.tasks.reloadLatest")}
                  </Button>
                ) : null}
              </span>
            </Alert>
          ) : null}
          {!task ? (
            <>
              <Input
                label={t("activity.tasks.findCustomer")}
                icon={<Search size={16} aria-hidden="true" />}
                value={customerSearch}
                onChange={(event) => setCustomerSearch(event.target.value)}
                placeholder={t("activity.tasks.findCustomerPlaceholder")}
              />
              <Select
                label={t("activity.tasks.customer")}
                value={form.customerId}
                disabled={loadingOptions}
                options={[{ value: "", label: loadingOptions ? t("activity.tasks.loadingCustomers") : t("activity.tasks.chooseCustomer") }, ...customerOptions]}
                onChange={(event) => setForm((current) => ({ ...current, customerId: event.target.value }))}
              />
              <Select
                label={t("activity.tasks.linkedQuote")}
                value={form.quoteId}
                disabled={!form.customerId}
                options={quoteOptions}
                onChange={(event) => setForm((current) => ({ ...current, quoteId: event.target.value }))}
              />
            </>
          ) : (
            <div className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">{t("activity.tasks.customer")}</p>
              <p className="mt-1 text-sm font-semibold text-[var(--qf-text)]">{task.customer.fullName}</p>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Select
              label={t("activity.tasks.taskType")}
              value={form.type}
              options={typeOptions}
              onChange={(event) => setForm((current) => ({ ...current, type: event.target.value as ActivityTaskType }))}
            />
            <Select
              label={t("activity.tasks.priority")}
              value={form.priority}
              options={priorityOptions}
              onChange={(event) => setForm((current) => ({ ...current, priority: event.target.value as ActivityTaskPriority }))}
            />
          </div>
          <Input
            label={t("activity.tasks.taskTitle")}
            value={form.title}
            maxLength={160}
            onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
            placeholder={t("activity.tasks.taskTitlePlaceholder")}
          />
          <Textarea
            label={t("activity.tasks.notes")}
            value={form.notes}
            maxLength={2000}
            rows={4}
            onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
            placeholder={t("activity.tasks.notesPlaceholder")}
          />
          <Input
            label={t("activity.tasks.dueDate", { timezone })}
            type="datetime-local"
            value={form.dueLocal}
            onChange={(event) => setForm((current) => ({ ...current, dueLocal: event.target.value }))}
          />
          {canManage ? (
            <Select
              label={t("activity.tasks.assignedToLabel")}
              value={form.assignedTenantUserId}
              options={memberOptions.length > 0 ? memberOptions : [{ value: "", label: loadingOptions ? t("activity.tasks.loadingTeam") : t("activity.tasks.assignToMe") }]}
              onChange={(event) => setForm((current) => ({ ...current, assignedTenantUserId: event.target.value }))}
            />
          ) : (
            <div className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">{t("activity.tasks.assignedToLabel")}</p>
              <p className="mt-1 text-sm font-semibold text-[var(--qf-text)]">{t("activity.tasks.you")}</p>
            </div>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="outline" onClick={requestClose} disabled={busy}>{t("activity.tasks.cancel")}</Button>
        <Button onClick={() => void submit()} loading={submitting} disabled={saving}>{task ? t("activity.tasks.saveChanges") : t("activity.tasks.add")}</Button>
      </ModalFooter>
    </Modal>
    <ConfirmModal
      open={discardConfirmOpen}
      onClose={() => setDiscardConfirmOpen(false)}
      onConfirm={() => {
        setDiscardConfirmOpen(false);
        onClose();
      }}
      title={t("activity.tasks.discardTitle")}
      description={t("activity.tasks.discardDescription")}
      confirmLabel={t("activity.tasks.discard")}
      confirmVariant="warning"
    />
    </>
  );
}

export function ActivityTaskPanel({
  mine,
  canManage,
  currentUserId,
  timezone,
  navigateToQuote,
  initialTaskId,
  initialDraft,
}: {
  mine: boolean;
  canManage: boolean;
  currentUserId: string;
  timezone: string;
  navigateToQuote: (quoteId: string) => void;
  initialTaskId?: string;
  initialDraft?: ActivityTaskDraft | null;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en-US";
  const [items, setItems] = useState<ActivityTask[]>([]);
  const [counts, setCounts] = useState({ overdue: 0, today: 0, upcoming: 0, completed: 0 });
  const [filter, setFilter] = useState<ActivityTaskDueFilter>("active");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [limit, setLimit] = useState<PageSize>(25);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorTask, setEditorTask] = useState<ActivityTask | null>(null);
  const [editorDraft, setEditorDraft] = useState<ActivityTaskDraft | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [removeTask, setRemoveTask] = useState<ActivityTask | null>(null);
  const requestIdRef = useRef(0);
  const openedInitialTaskRef = useRef<string | null>(null);
  const openedInitialDraftRef = useRef<string | null>(null);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
      setOffset(0);
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [search]);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const [listResult, summaryResult] = await Promise.all([
        api.activities.list({ mine, due: filter, search: debouncedSearch || undefined, limit, offset }),
        api.activities.summary({ mine }),
      ]);
      if (requestId !== requestIdRef.current) return;
      setItems(listResult.items);
      setTotal(listResult.pagination.total);
      setCounts(summaryResult.counts);
    } catch (loadError) {
      if (requestId !== requestIdRef.current) return;
      setError(localizedApiError(loadError, t, { fallbackKey: "activity.tasks.unavailable" }));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [debouncedSearch, filter, limit, mine, offset, t]);

  useEffect(() => {
    setOffset(0);
  }, [mine]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!initialTaskId || loading || openedInitialTaskRef.current === initialTaskId) return;
    const task = items.find((item) => item.id === initialTaskId);
    if (!task) return;
    openedInitialTaskRef.current = initialTaskId;
    setEditorTask(task);
    setEditorOpen(true);
  }, [initialTaskId, items, loading]);

  useEffect(() => {
    if (!initialDraft) return;
    const fingerprint = JSON.stringify(initialDraft);
    if (openedInitialDraftRef.current === fingerprint) return;
    openedInitialDraftRef.current = fingerprint;
    setEditorTask(null);
    setEditorDraft(initialDraft);
    setEditorOpen(true);
  }, [initialDraft]);

  async function complete(task: ActivityTask) {
    setSaving(true);
    try {
      const result = await api.activities.complete(task.id, task.version);
      await load();
      notify.success(t("activity.tasks.completedNotice"), {
        description: task.title,
        action: {
          label: t("activity.tasks.undo"),
          onClick: () => {
            void api.activities.reopen(result.task.id, result.task.version)
              .then(async () => {
                await load();
                notify.success(t("activity.tasks.undoNotice"));
              })
              .catch((reopenError) => notify.error(localizedApiError(reopenError, t, {
                fallbackKey: "activity.tasks.reopenError",
                statusKeys: { 400: "apiErrors.invalidRequest" },
              })));
          },
        },
      });
    } catch (saveError) {
      notify.error(localizedApiError(saveError, t, {
        fallbackKey: "activity.tasks.completeError",
        statusKeys: { 400: "apiErrors.invalidRequest" },
      }));
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function reopen(task: ActivityTask) {
    setSaving(true);
    try {
      await api.activities.reopen(task.id, task.version);
      notify.success(t("activity.tasks.reopenedNotice"));
      await load();
    } catch (saveError) {
      notify.error(localizedApiError(saveError, t, {
        fallbackKey: "activity.tasks.reopenError",
        statusKeys: { 400: "apiErrors.invalidRequest" },
      }));
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!removeTask) return;
    setSaving(true);
    try {
      await api.activities.remove(removeTask.id, removeTask.version);
      notify.success(t("activity.tasks.removedNotice"));
      setRemoveTask(null);
      await load();
    } catch (saveError) {
      notify.error(localizedApiError(saveError, t, {
        fallbackKey: "activity.tasks.removeError",
        statusKeys: { 400: "apiErrors.invalidRequest" },
      }));
      await load();
    } finally {
      setSaving(false);
    }
  }

  const filterOptions = FILTER_VALUES.map((value) => ({ value, label: filterLabel(value, t) }));
  const metricFilters = useMemo(() => [
    { label: t("activity.tasks.filter.overdue"), value: counts.overdue, filter: "overdue" as const, tone: "red" as const },
    { label: t("activity.tasks.filter.today"), value: counts.today, filter: "today" as const, tone: "orange" as const },
    { label: t("activity.tasks.filter.upcoming"), value: counts.upcoming, filter: "upcoming" as const, tone: "blue" as const },
    { label: t("activity.tasks.filter.completed"), value: counts.completed, filter: "completed" as const, tone: "emerald" as const },
  ], [counts, t]);

  return (
    <section aria-label={mine ? t("activity.tasks.myTasks") : t("activity.tasks.teamTasks")} className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {metricFilters.map((metric) => (
          <button
            key={metric.filter}
            type="button"
            onClick={() => {
              setFilter(metric.filter);
              setOffset(0);
            }}
            className={`min-h-[76px] rounded-xl border px-3 py-3 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] ${filter === metric.filter ? "border-[var(--qf-info-border)] bg-[var(--qf-selected)]" : "border-[var(--qf-border)] bg-[var(--qf-panel)] hover:bg-[var(--qf-interactive-hover)]"}`}
            aria-pressed={filter === metric.filter}
          >
            <span className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">{metric.label}</span>
            <span className="mt-1 block text-2xl font-bold text-[var(--qf-text)]">{loading ? "—" : metric.value}</span>
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)] shadow-[var(--qf-shadow-sm)]">
        <div className="flex flex-col gap-3 border-b border-[var(--qf-border)] px-4 py-4 sm:flex-row sm:items-end sm:justify-between sm:px-5">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{mine ? t("activity.tasks.myWork") : t("activity.tasks.teamWork")}</p>
            <h2 className="mt-1 text-lg font-semibold text-[var(--qf-text)]">{t("activity.tasks.heading")}</h2>
            <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{t("activity.tasks.description")}</p>
          </div>
          <div className="grid gap-2 sm:flex sm:items-end">
            <Select
              label={t("activity.tasks.show")}
              value={filter}
              options={filterOptions}
              onChange={(event) => {
                setFilter(event.target.value as ActivityTaskDueFilter);
                setOffset(0);
              }}
            />
            <Button
              icon={<Plus size={17} aria-hidden="true" />}
              onClick={() => {
                setEditorTask(null);
                setEditorDraft(null);
                setEditorOpen(true);
              }}
            >
              {t("activity.tasks.add")}
            </Button>
          </div>
        </div>

        <div className="border-b border-[var(--qf-border)] px-4 py-3 sm:px-5">
          <Input
            aria-label={t("activity.tasks.searchLabel")}
            icon={<Search size={16} aria-hidden="true" />}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("activity.tasks.searchPlaceholder")}
          />
        </div>

        {error ? (
          <div className="p-4 sm:p-5">
            <EmptyState
              title={t("activity.tasks.unavailable")}
              description={`${error} ${t("activity.tasks.unchanged")}`}
              action={<Button variant="outline" onClick={() => void load()}>{t("home.tryAgain")}</Button>}
            />
          </div>
        ) : loading ? (
          <div className="p-4 sm:p-5">
            <LoadingState title={t("activity.tasks.loading")} description={t("activity.tasks.loadingDescription")} rows={5} />
          </div>
        ) : items.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState
              icon={<ClipboardList size={18} aria-hidden="true" />}
              title={debouncedSearch ? t("activity.tasks.noMatches") : filter === "completed" ? t("activity.tasks.noCompleted") : t("activity.tasks.noTasks")}
              description={debouncedSearch ? t("activity.tasks.broadenSearch") : t("activity.tasks.emptyDescription")}
              action={!debouncedSearch && filter !== "completed" ? <Button onClick={() => {
                setEditorTask(null);
                setEditorDraft(null);
                setEditorOpen(true);
              }}>{t("activity.tasks.add")}</Button> : undefined}
            />
          </div>
        ) : (
          <div className="divide-y divide-[var(--qf-border)]">
            {items.map((task) => (
              <article key={task.id} className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={priorityTone(task.priority)}>{priorityLabel(task.priority, t)}</Badge>
                    <Badge tone={dueTone(task)} icon={<CalendarClock size={12} aria-hidden="true" />}>
                      {dueLabel(task, timezone, t, locale)}
                    </Badge>
                    <span className="text-xs font-medium text-[var(--qf-text-muted)]">{typeLabel(task.type, t)}</span>
                  </div>
                  <h3 className="mt-2 text-sm font-semibold text-[var(--qf-text)] sm:text-base">{task.title}</h3>
                  <p className="mt-1 text-sm text-[var(--qf-text-soft)]">
                    {task.customer.fullName} · {t("activity.tasks.assignedTo", { name: task.assignedTenantUser.user.fullName })}
                  </p>
                  {task.notes ? <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--qf-text-muted)]">{task.notes}</p> : null}
                </div>
                <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
                  {task.quote ? (
                    <Button className="min-h-11 sm:min-h-11" variant="outline" size="sm" icon={<ChevronRight size={16} aria-hidden="true" />} onClick={() => navigateToQuote(task.quote!.id)}>
                      {t("activity.tasks.quote")}
                    </Button>
                  ) : null}
                  {task.status === "COMPLETED" || task.status === "CANCELED" ? (
                    <Button className="min-h-11 sm:min-h-11" variant="outline" size="sm" icon={<RotateCcw size={16} aria-hidden="true" />} onClick={() => void reopen(task)} disabled={saving}>
                      {t("activity.tasks.reopen")}
                    </Button>
                  ) : (
                    <Button className="min-h-11 sm:min-h-11" size="sm" icon={<Check size={16} aria-hidden="true" />} onClick={() => void complete(task)} disabled={saving}>
                      {t("activity.tasks.complete")}
                    </Button>
                  )}
                  {task.status === "OPEN" || task.status === "IN_PROGRESS" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-11 sm:min-h-11"
                      icon={<Pencil size={16} aria-hidden="true" />}
                      onClick={() => {
                        setEditorTask(task);
                        setEditorDraft(null);
                        setEditorOpen(true);
                      }}
                    >
                      {t("activity.tasks.editAction")}
                    </Button>
                  ) : null}
                  {canManage ? (
                    <Button className="min-h-11 sm:min-h-11" variant="ghost" size="sm" icon={<Trash2 size={16} aria-hidden="true" />} onClick={() => setRemoveTask(task)}>
                      {t("activity.tasks.remove")}
                    </Button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}

        <div className="border-t border-[var(--qf-border)] p-4 sm:p-5">
          <PaginationControls
            limit={limit}
            offset={offset}
            total={total}
            loading={loading}
            itemLabel={t("activity.tasks.records")}
            onLimitChange={(nextLimit) => {
              setLimit(nextLimit);
              setOffset(0);
            }}
            onOffsetChange={setOffset}
          />
        </div>
      </div>

      <TaskEditor
        open={editorOpen}
        task={editorTask}
        draft={editorDraft}
        timezone={timezone}
        currentUserId={currentUserId}
        canManage={canManage}
        saving={saving}
        onClose={() => {
          setEditorOpen(false);
          setEditorTask(null);
          setEditorDraft(null);
        }}
        onSaved={(savedTask) => {
          setEditorOpen(false);
          setEditorTask(null);
          setEditorDraft(null);
          notify.success(editorTask ? t("activity.tasks.updatedNotice") : t("activity.tasks.addedNotice"), { description: savedTask.title });
          void load();
        }}
        onReloadLatest={async () => {
          await load();
          setEditorOpen(false);
          setEditorTask(null);
          setEditorDraft(null);
          notify.warning(t("activity.tasks.latestLoaded"), { description: t("activity.tasks.latestLoadedDescription") });
        }}
      />

      <ConfirmModal
        open={Boolean(removeTask)}
        onClose={() => setRemoveTask(null)}
        onConfirm={() => void remove()}
        title={t("activity.tasks.removeTitle")}
        description={t("activity.tasks.removeDescription")}
        confirmLabel={t("activity.tasks.removeConfirm")}
        loading={saving}
      />
    </section>
  );
}
