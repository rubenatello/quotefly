import { useCallback, useEffect, useMemo, useState } from "react";
import { BellRing, ChevronDown, ChevronUp, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  ApiError,
  api,
  type ActivityTaskPriority,
  type FollowUpSettings,
  type FollowUpSettingsStep,
} from "../../lib/api";
import { localizedApiError } from "../../lib/localized-api-error";
import { useUnsavedChangesGuard } from "../../hooks/useUnsavedChangesGuard";
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmModal,
  EmptyState,
  Input,
  LoadingState,
  Select,
} from "../ui";

const MIN_STEPS = 1;
const MAX_STEPS = 6;
const MIN_DELAY_MINUTES = 5;
const MAX_DELAY_MINUTES = 30 * 24 * 60;
const TITLE_MAX_LENGTH = 120;

type DelayUnit = "minutes" | "hours" | "days";
type EditableFollowUpStep = FollowUpSettingsStep & { clientId: string; delayUnit: DelayUnit };

type FollowUpDraft = {
  enabled: boolean;
  steps: EditableFollowUpStep[];
};

function toEditableStep(step: FollowUpSettingsStep): EditableFollowUpStep {
  const delayUnit: DelayUnit = step.delayMinutes % (24 * 60) === 0
    ? "days"
    : step.delayMinutes % 60 === 0
      ? "hours"
      : "minutes";
  return { ...step, clientId: `saved-${step.stepNumber}`, delayUnit };
}

function toDraft(settings: FollowUpSettings): FollowUpDraft {
  return {
    enabled: settings.enabled,
    steps: settings.steps.map(toEditableStep),
  };
}

function draftFingerprint(draft: FollowUpDraft): string {
  return JSON.stringify({
    enabled: draft.enabled,
    steps: draft.steps.map(({ delayMinutes, title, notes, priority }) => ({ delayMinutes, title, notes, priority })),
  });
}

function freshStep(index: number): EditableFollowUpStep {
  return {
    clientId: `new-${Date.now()}-${index}`,
    stepNumber: index + 1,
    delayMinutes: Math.min((index + 1) * 24 * 60, MAX_DELAY_MINUTES),
    title: "",
    notes: null,
    priority: "NORMAL",
    delayUnit: "days",
  };
}

function delayUnitMultiplier(unit: DelayUnit): number {
  if (unit === "days") return 24 * 60;
  if (unit === "hours") return 60;
  return 1;
}

function delayAmount(step: EditableFollowUpStep): number {
  return step.delayMinutes / delayUnitMultiplier(step.delayUnit);
}

function formatDelay(minutes: number, locale: string, t: (key: string, values?: Record<string, unknown>) => string): string {
  if (minutes < 60) return t("admin.followUp.delayMinutes", { count: minutes });
  if (minutes % (24 * 60) === 0) return t("admin.followUp.delayDays", { count: minutes / (24 * 60) });
  if (minutes % 60 === 0) return t("admin.followUp.delayHours", { count: minutes / 60 });
  return new Intl.NumberFormat(locale).format(minutes) + " " + t("admin.followUp.minutesShort");
}

function priorityLabel(priority: ActivityTaskPriority, t: (key: string) => string): string {
  return t(`activity.tasks.priorityValue.${priority.toLowerCase()}`);
}

function validateDraft(draft: FollowUpDraft, t: (key: string, values?: Record<string, unknown>) => string): string | null {
  if (draft.steps.length < MIN_STEPS || draft.steps.length > MAX_STEPS) {
    return t("admin.followUp.errors.stepCount", { min: MIN_STEPS, max: MAX_STEPS });
  }

  for (let index = 0; index < draft.steps.length; index += 1) {
    const step = draft.steps[index];
    if (!step.title.trim()) return t("admin.followUp.errors.titleRequired", { step: index + 1 });
    if (step.title.trim().length > TITLE_MAX_LENGTH) {
      return t("admin.followUp.errors.titleTooLong", { step: index + 1, max: TITLE_MAX_LENGTH });
    }
    if (!Number.isInteger(step.delayMinutes) || step.delayMinutes < MIN_DELAY_MINUTES || step.delayMinutes > MAX_DELAY_MINUTES) {
      return t("admin.followUp.errors.delayRange", { step: index + 1, min: MIN_DELAY_MINUTES, max: MAX_DELAY_MINUTES });
    }
    if (index > 0 && step.delayMinutes <= draft.steps[index - 1].delayMinutes) {
      return t("admin.followUp.errors.delayOrder", { step: index + 1 });
    }
  }

  return null;
}

function AutomaticScheduleSwitch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={t("admin.followUp.toggleLabel")}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex min-h-11 w-[68px] shrink-0 items-center rounded-full border p-1 transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] disabled:cursor-not-allowed disabled:opacity-60 ${
        checked
          ? "border-[var(--qf-action-primary)] bg-[var(--qf-action-primary)]"
          : "border-[var(--qf-border-strong)] bg-[var(--qf-panel-muted)]"
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-8 w-8 rounded-full bg-white shadow-sm transition-transform motion-reduce:transition-none ${checked ? "translate-x-6" : "translate-x-0"}`}
      />
    </button>
  );
}

export function FollowUpSettingsPanel({
  canManage,
  onDirtyChange,
}: {
  canManage: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en-US";
  const [settings, setSettings] = useState<FollowUpSettings | null>(null);
  const [draft, setDraft] = useState<FollowUpDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [staleVersion, setStaleVersion] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);

  const dirty = Boolean(settings && draft && draftFingerprint(draft) !== draftFingerprint(toDraft(settings)));
  const validationError = draft ? validateDraft(draft, t) : null;
  const { navigationPromptOpen, cancelNavigation, continueNavigation } = useUnsavedChangesGuard(dirty && !saving, {
    historyPrompt: t("admin.followUp.leavePrompt"),
  });

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const load = useCallback(async (replaceDraft: boolean) => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await api.followUpSettings.get();
      setSettings(result.followUpSettings);
      if (replaceDraft) setDraft(toDraft(result.followUpSettings));
      setStaleVersion(false);
    } catch (error) {
      setLoadError(localizedApiError(error, t, { fallbackKey: "admin.followUp.errors.load" }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load(true);
  }, [load]);

  const cadenceSummary = useMemo(() => {
    if (!draft) return "";
    return draft.steps.map((step) => formatDelay(step.delayMinutes, locale, t)).join(" · ");
  }, [draft, locale, t]);

  function updateStep(clientId: string, patch: Partial<EditableFollowUpStep>) {
    setDraft((current) => current ? {
      ...current,
      steps: current.steps.map((step) => step.clientId === clientId ? { ...step, ...patch } : step),
    } : current);
    setSavedNotice(false);
    setSaveError(null);
  }

  function moveStep(index: number, direction: -1 | 1) {
    setDraft((current) => {
      if (!current) return current;
      const destination = index + direction;
      if (destination < 0 || destination >= current.steps.length) return current;
      const steps = [...current.steps];
      const delaySlots = steps.map((step) => ({ delayMinutes: step.delayMinutes, delayUnit: step.delayUnit }));
      [steps[index], steps[destination]] = [steps[destination], steps[index]];
      return {
        ...current,
        steps: steps.map((step, stepIndex) => ({
          ...step,
          stepNumber: stepIndex + 1,
          ...delaySlots[stepIndex],
        })),
      };
    });
    setSavedNotice(false);
  }

  function removeStep(clientId: string) {
    setDraft((current) => current ? {
      ...current,
      steps: current.steps
        .filter((step) => step.clientId !== clientId)
        .map((step, index) => ({ ...step, stepNumber: index + 1 })),
    } : current);
    setSavedNotice(false);
  }

  function addStep() {
    setDraft((current) => {
      if (!current || current.steps.length >= MAX_STEPS) return current;
      const previousDelay = current.steps.at(-1)?.delayMinutes ?? 0;
      const step = freshStep(current.steps.length);
      step.delayMinutes = Math.min(Math.max(previousDelay + 24 * 60, MIN_DELAY_MINUTES), MAX_DELAY_MINUTES);
      return { ...current, steps: [...current.steps, step] };
    });
    setSavedNotice(false);
  }

  async function save() {
    if (!settings || !draft || !canManage || validationError) return;
    setSaving(true);
    setSaveError(null);
    setSavedNotice(false);
    try {
      const result = await api.followUpSettings.update({
        version: settings.version,
        enabled: draft.enabled,
        steps: draft.steps.map((step, index) => ({
          stepNumber: index + 1,
          delayMinutes: step.delayMinutes,
          title: step.title.trim(),
          notes: step.notes?.trim() || null,
          priority: step.priority,
        })),
      });
      setSettings(result.followUpSettings);
      setDraft(toDraft(result.followUpSettings));
      setStaleVersion(false);
      setSavedNotice(true);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.code === "FOLLOW_UP_SETTINGS_STALE_VERSION") {
        setStaleVersion(true);
        setSaveError(t("admin.followUp.errors.stale"));
      } else {
        setSaveError(localizedApiError(error, t, { fallbackKey: "admin.followUp.errors.save" }));
      }
    } finally {
      setSaving(false);
    }
  }

  function resetDraft() {
    if (!settings) return;
    setDraft(toDraft(settings));
    setSaveError(null);
    setStaleVersion(false);
    setSavedNotice(false);
  }

  if (loading && !settings) {
    return <LoadingState title={t("admin.followUp.loading")} description={t("admin.followUp.loadingDescription")} rows={3} />;
  }

  if (!settings || !draft) {
    return (
      <EmptyState
        icon={<BellRing size={20} aria-hidden="true" />}
        title={t("admin.followUp.unavailable")}
        description={loadError ?? t("admin.followUp.errors.load")}
        action={<Button type="button" variant="outline" onClick={() => void load(true)}>{t("admin.followUp.retry")}</Button>}
      />
    );
  }

  const priorityOptions: Array<{ value: ActivityTaskPriority; label: string }> = (["LOW", "NORMAL", "HIGH", "URGENT"] as const)
    .map((priority) => ({ value: priority, label: priorityLabel(priority, t) }));

  return (
    <div className="space-y-4">
      {!canManage ? (
        <Alert tone="info">{t("admin.followUp.readOnly")}</Alert>
      ) : null}
      {saveError ? (
        <Alert tone={staleVersion ? "warning" : "error"}>{saveError}</Alert>
      ) : null}
      {savedNotice ? <Alert tone="success">{t("admin.followUp.saved")}</Alert> : null}

      <Card variant="blue" padding="lg">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-semibold text-[var(--qf-text)]">{t("admin.followUp.toggleTitle")}</h3>
              <Badge tone={draft.enabled ? "emerald" : "slate"}>
                {draft.enabled ? t("admin.followUp.enabled") : t("admin.followUp.disabled")}
              </Badge>
              {dirty ? <Badge tone="amber">{t("admin.followUp.unsaved")}</Badge> : null}
            </div>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-[var(--qf-text-soft)]">{t("admin.followUp.toggleDescription")}</p>
          </div>
          <AutomaticScheduleSwitch
            checked={draft.enabled}
            disabled={!canManage || saving}
            onChange={(enabled) => {
              setDraft((current) => current ? { ...current, enabled } : current);
              setSavedNotice(false);
              setSaveError(null);
            }}
          />
        </div>
      </Card>

      <Alert tone="info">{t("admin.followUp.futureOnly")}</Alert>

      <Card variant="default" padding="lg">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("admin.followUp.cadenceLabel")}</p>
            <p className="mt-2 text-base font-semibold text-[var(--qf-text)]">{cadenceSummary}</p>
            <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{t("admin.followUp.cadenceDescription", { count: draft.steps.length })}</p>
          </div>
          <Badge tone="blue">{t("admin.followUp.stepCount", { count: draft.steps.length })}</Badge>
        </div>

        <details className="mt-5 rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] px-4">
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 py-3 text-sm font-semibold text-[var(--qf-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]">
            <span>{t("admin.followUp.editSteps")}</span>
            <span className="text-xs font-medium text-[var(--qf-text-muted)]">{t("admin.followUp.editStepsHint")}</span>
          </summary>

          <div className="space-y-3 border-t border-[var(--qf-border)] py-4">
            {draft.steps.map((step, index) => (
              <fieldset key={step.clientId} disabled={!canManage || saving} className="rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] p-4 disabled:opacity-75">
                <legend className="px-2 text-sm font-semibold text-[var(--qf-text)]">{t("admin.followUp.stepTitle", { step: index + 1 })}</legend>
                <div className="grid gap-3 lg:grid-cols-[260px_minmax(220px,1fr)_170px_auto] lg:items-end">
                  <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-2">
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      label={t("admin.followUp.delayLabel")}
                      value={delayAmount(step)}
                      onChange={(event) => updateStep(step.clientId, {
                        delayMinutes: Number(event.target.value) * delayUnitMultiplier(step.delayUnit),
                      })}
                    />
                    <Select
                      label={t("admin.followUp.delayUnitLabel")}
                      value={step.delayUnit}
                      options={([
                        { value: "minutes", label: t("admin.followUp.units.minutes") },
                        { value: "hours", label: t("admin.followUp.units.hours") },
                        { value: "days", label: t("admin.followUp.units.days") },
                      ] satisfies Array<{ value: DelayUnit; label: string }>)}
                      onChange={(event) => {
                        const nextUnit = event.target.value as DelayUnit;
                        updateStep(step.clientId, {
                          delayUnit: nextUnit,
                          delayMinutes: delayAmount(step) * delayUnitMultiplier(nextUnit),
                        });
                      }}
                    />
                  </div>
                  <Input
                    label={t("admin.followUp.taskTitleLabel")}
                    value={step.title}
                    maxLength={TITLE_MAX_LENGTH}
                    onChange={(event) => updateStep(step.clientId, { title: event.target.value })}
                  />
                  <Select
                    label={t("admin.followUp.priorityLabel")}
                    value={step.priority}
                    options={priorityOptions}
                    onChange={(event) => updateStep(step.clientId, { priority: event.target.value as ActivityTaskPriority })}
                  />
                  <div className="grid grid-cols-3 gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label={t("admin.followUp.moveUp", { step: index + 1 })}
                      title={t("admin.followUp.moveUp", { step: index + 1 })}
                      disabled={!canManage || saving || index === 0}
                      onClick={() => moveStep(index, -1)}
                      className="min-h-11 px-0"
                    >
                      <ChevronUp size={17} aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label={t("admin.followUp.moveDown", { step: index + 1 })}
                      title={t("admin.followUp.moveDown", { step: index + 1 })}
                      disabled={!canManage || saving || index === draft.steps.length - 1}
                      onClick={() => moveStep(index, 1)}
                      className="min-h-11 px-0"
                    >
                      <ChevronDown size={17} aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={t("admin.followUp.removeStep", { step: index + 1 })}
                      title={t("admin.followUp.removeStep", { step: index + 1 })}
                      disabled={!canManage || saving || draft.steps.length <= MIN_STEPS}
                      onClick={() => removeStep(step.clientId)}
                      className="min-h-11 px-0 text-red-600"
                    >
                      <Trash2 size={17} aria-hidden="true" />
                    </Button>
                  </div>
                </div>
                <p className="mt-2 text-xs text-[var(--qf-text-muted)]">{t("admin.followUp.delayHelp", { delay: formatDelay(step.delayMinutes, locale, t) })}</p>
              </fieldset>
            ))}

            {canManage ? (
              <Button
                type="button"
                variant="outline"
                icon={<Plus size={17} aria-hidden="true" />}
                onClick={addStep}
                disabled={saving || draft.steps.length >= MAX_STEPS}
              >
                {t("admin.followUp.addStep")}
              </Button>
            ) : null}
          </div>
        </details>
      </Card>

      {validationError ? <Alert tone="warning">{validationError}</Alert> : null}

      {canManage ? (
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {staleVersion ? (
            <Button type="button" variant="outline" onClick={() => void load(true)} disabled={saving}>
              {t("admin.followUp.reloadLatest")}
            </Button>
          ) : null}
          <Button type="button" variant="outline" icon={<RotateCcw size={17} aria-hidden="true" />} onClick={resetDraft} disabled={!dirty || saving}>
            {t("admin.followUp.reset")}
          </Button>
          <Button type="button" icon={<Save size={17} aria-hidden="true" />} onClick={() => void save()} loading={saving} disabled={!dirty || Boolean(validationError)}>
            {t("admin.followUp.save")}
          </Button>
        </div>
      ) : null}

      <ConfirmModal
        open={navigationPromptOpen}
        onClose={cancelNavigation}
        onConfirm={continueNavigation}
        title={t("admin.followUp.leaveTitle")}
        description={t("admin.followUp.leaveDescription")}
        confirmLabel={t("admin.followUp.leaveConfirm")}
        confirmVariant="warning"
      />
    </div>
  );
}
