import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, CircleDashed, LoaderCircle, Sparkles, UserRound } from "lucide-react";
import type { AiProgressEvent, ServiceType } from "../../lib/api";
import { Alert, Badge, Button, Modal, ModalBody, ModalFooter, ModalHeader, ProgressBar, Select, Textarea } from "../ui";

const AI_PROGRESS_STAGES = [
  {
    step: "analyzing_prompt" as const,
    value: 18,
    key: "reading",
  },
  {
    step: "loading_customer_context" as const,
    value: 36,
    key: "customer",
  },
  {
    step: "retrieving_workspace_context" as const,
    value: 58,
    key: "retrieval",
  },
  {
    step: "drafting_quote_patch" as const,
    value: 78,
    key: "drafting",
  },
  {
    step: "reviewing_line_changes" as const,
    value: 88,
    key: "reviewing",
  },
  {
    step: "finalizing_suggestion" as const,
    value: 92,
    key: "finalizing",
  },
];

function buildPromptPlaceholder(serviceType: ServiceType, customerName?: string | null, spanish = false) {
  const lead = customerName?.trim() || "Alan Johnson";

  if (spanish) {
    if (serviceType === "HVAC") return `Ejemplo: Cotización para ${lead}. Agrega diagnóstico, reparación e instalación como líneas separadas con sus precios.`;
    if (serviceType === "ROOFING") return `Ejemplo: Cotización para ${lead}. Reemplaza 1,250 pies cuadrados de techo e incluye retiro, desecho, base e instalación como líneas separadas.`;
    if (serviceType === "PLUMBING") return `Ejemplo: Cotización para ${lead}. Agrega una línea para reparar la tubería y otra para resanar el acceso.`;
    if (serviceType === "FLOORING") return `Ejemplo: Cotización para ${lead}. Instala piso en dos baños y el pasillo con una línea separada por área.`;
    if (serviceType === "GARDENING") return `Ejemplo: Cotización para ${lead}. Agrega reemplazo de césped, aireación y configuración de riego como líneas separadas.`;
    return `Ejemplo: Nueva cotización para ${lead}. Divide el trabajo en líneas facturables separadas con precio por línea.`;
  }

  if (serviceType === "HVAC") {
    return [
      `Example: Quote for ${lead}. Add a priority work fee $75, major AC repair $1,500, and AC unit replacement $4,500 as separate lines.`,
      "",
      `Example: Revise this quote for ${lead}. Keep the repair line, then add a second high-efficiency heat pump replacement option (SEER2/HSPF2) with evaporator coil and thermostat setup.`,
    ].join("\n");
  }

  if (serviceType === "ROOFING") {
    return [
      `Example: New quote for ${lead}. Replace a 1,250 square foot asphalt shingle roof and include tear-off, disposal, underlayment, and installation as separate lines.`,
      "",
      "Example: Draft a Spanish tile roof quote at 20 roofing squares and include underlayment, flashing, and one optional deck repair allowance line.",
    ].join("\n");
  }

  if (serviceType === "PLUMBING") {
    return [
      `Example: Quote for ${lead}. Add one line for burst pipe repair and another line for drywall patch after access.`,
      "",
      "Example: Add separate lines for sewer camera + hydro-jet, plus an alternate trenchless repair line if the blockage persists.",
    ].join("\n");
  }

  if (serviceType === "FLOORING") {
    return [
      `Example: New quote for ${lead}. Install linoleum/LVT in two bathrooms and hallway with separate lines per area.`,
      "",
      "Example: Add separate prep lines for moisture barrier, subfloor leveling allowance, uncoupling membrane, and trim/transition finish.",
    ].join("\n");
  }

  if (serviceType === "GARDENING") {
    return [
      `Example: New quote for ${lead}. Add sod replacement, aeration + overseed, and irrigation controller setup by hydrozone as separate lines.`,
      "",
      "Example: Add pre-emergent + mulch refresh and optional drainage correction allowance if pooling persists.",
    ].join("\n");
  }

  return [
    `Example: New quote for ${lead}. Break the work into separate billable lines with price per line.`,
    "",
    "Example: If there is a fallback option or alternate scope, add it as another line instead of combining everything together.",
  ].join("\n");
}

export function QuoteAiPromptModal({
  open,
  onClose,
  serviceType,
  onServiceTypeChange,
  prompt,
  onPromptChange,
  starterPrompts,
  onUseStarterPrompt,
  customerContextText,
  customerContextName,
  customerContextDetails,
  customerContextBadge,
  usageHint,
  usageLimitMessage,
  errorMessage,
  statusMessage,
  progressEvent,
  loading,
  onCancelRequest,
  disabled,
  onSubmit,
  title,
  description,
  submitLabel,
}: {
  open: boolean;
  onClose: () => void;
  serviceType: ServiceType;
  onServiceTypeChange: (value: ServiceType) => void;
  prompt: string;
  onPromptChange: (value: string) => void;
  starterPrompts?: string[];
  onUseStarterPrompt?: (prompt: string) => void;
  customerContextText: string;
  customerContextName?: string | null;
  customerContextDetails?: string | null;
  customerContextBadge?: string | null;
  usageHint?: string | null;
  usageLimitMessage?: string | null;
  errorMessage?: string | null;
  statusMessage?: string | null;
  progressEvent?: AiProgressEvent | null;
  loading?: boolean;
  onCancelRequest?: () => void;
  disabled?: boolean;
  onSubmit: (event: FormEvent) => void | Promise<void>;
  title?: string;
  description?: string;
  submitLabel?: string;
}) {
  const { t, i18n } = useTranslation();
  const resolvedTitle = title ?? t("quoteComponents.aiModal.title");
  const resolvedDescription = description ?? t("quoteComponents.aiModal.description");
  const resolvedSubmitLabel = submitLabel ?? t("quoteComponents.aiModal.apply");
  const [progress, setProgress] = useState(0);
  const [progressIndex, setProgressIndex] = useState(0);
  const [progressLabel, setProgressLabel] = useState(t("quoteComponents.aiModal.waiting"));
  const [progressDetail, setProgressDetail] = useState(t("quoteComponents.aiModal.waitingDetail"));

  useEffect(() => {
    if (!open || !loading) {
      setProgress(0);
      setProgressIndex(0);
      setProgressLabel(t("quoteComponents.aiModal.waiting"));
      setProgressDetail(t("quoteComponents.aiModal.waitingDetail"));
      return;
    }

    setProgressIndex(0);
    setProgress(AI_PROGRESS_STAGES[0].value);
    setProgressLabel(t(`quoteComponents.aiModal.stages.${AI_PROGRESS_STAGES[0].key}.label`));
    setProgressDetail(t(`quoteComponents.aiModal.stages.${AI_PROGRESS_STAGES[0].key}.detail`));

    let index = 0;
    const interval = window.setInterval(() => {
      index += 1;
      if (index >= AI_PROGRESS_STAGES.length) {
        window.clearInterval(interval);
        return;
      }
      setProgressIndex(index);
      setProgress(AI_PROGRESS_STAGES[index].value);
      setProgressLabel(t(`quoteComponents.aiModal.stages.${AI_PROGRESS_STAGES[index].key}.label`));
      setProgressDetail(t(`quoteComponents.aiModal.stages.${AI_PROGRESS_STAGES[index].key}.detail`));
    }, 650);

    return () => window.clearInterval(interval);
  }, [open, loading, t]);

  const canUseStarterPrompts = useMemo(
    () => Boolean(starterPrompts?.length && onUseStarterPrompt),
    [onUseStarterPrompt, starterPrompts],
  );
  const hasAssignedCustomer = Boolean(customerContextName?.trim());
  const promptPlaceholder = useMemo(
    () => buildPromptPlaceholder(serviceType, customerContextName, i18n.resolvedLanguage === "es-US"),
    [customerContextName, i18n.resolvedLanguage, serviceType],
  );
  const activeProgress = progressEvent
    ? {
        value: progressEvent.value,
        label: progressEvent.label,
        detail: progressEvent.detail,
        index: Math.max(
          AI_PROGRESS_STAGES.findIndex((stage) => stage.step === progressEvent.step),
          0,
        ),
        sourceHints: progressEvent.sourceHints ?? [],
        patchCounts: progressEvent.patchCounts,
      }
    : {
        value: progress,
        label: progressLabel,
        detail: progressDetail,
        index: progressIndex,
        sourceHints: [] as string[],
        patchCounts: undefined as { added: number; updated: number; removed: number } | undefined,
      };

  return (
    <Modal open={open} onClose={loading && onCancelRequest ? onCancelRequest : onClose} size="lg" ariaLabel={resolvedTitle}>
      <ModalHeader title={resolvedTitle} description={resolvedDescription} onClose={loading && onCancelRequest ? onCancelRequest : onClose} />
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit}>
        <ModalBody className="space-y-5 bg-[var(--qf-panel-muted)] pb-4">
          <div className="rounded-2xl border border-[var(--qf-info-border)] bg-[var(--qf-panel)] px-4 py-3 shadow-[var(--qf-shadow-sm)]">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--qf-brand-orange-soft)] text-[var(--qf-brand-orange-text)]">
                  <Sparkles size={18} />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("quoteComponents.aiModal.workspace")}</p>
                  <p className="mt-1 text-sm text-[var(--qf-text-soft)]">
                    {t("quoteComponents.aiModal.workspaceDescription")}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 sm:justify-end">
                <Badge tone="orange">{t("quoteComponents.aiModal.meter")}</Badge>
                {usageHint ? <Badge tone="blue">{usageHint}</Badge> : null}
              </div>
            </div>
          </div>

          {usageLimitMessage ? <Alert tone="warning">{usageLimitMessage}</Alert> : null}

          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_200px]">
            <div className="rounded-2xl border border-[var(--qf-info-border)] bg-[var(--qf-panel-subtle)] px-4 py-3.5 shadow-[var(--qf-shadow-sm)]">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-quotefly-blue">{t("quoteComponents.aiModal.customerContext")}</p>
                {customerContextBadge ? <Badge tone="blue">{customerContextBadge}</Badge> : null}
              </div>
              <div className="mt-2.5 flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-quotefly-blue/[0.12] text-quotefly-blue">
                  <UserRound size={18} />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[var(--qf-text)]">
                    {hasAssignedCustomer ? customerContextName : t("quoteComponents.aiModal.noCustomer")}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-[var(--qf-text-soft)]">
                    {hasAssignedCustomer ? customerContextDetails ?? customerContextText : customerContextText}
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-[var(--qf-brand-orange-border)] bg-[var(--qf-brand-orange-soft)] px-4 py-3.5 shadow-[0_10px_24px_rgba(249,105,40,0.08)]">
              <Select
                label={t("quoteBuilder.trade")}
                value={serviceType}
                onChange={(event) => onServiceTypeChange(event.target.value as ServiceType)}
                options={[
                  { value: "HVAC", label: "HVAC" },
                  { value: "PLUMBING", label: "Plumbing" },
                  { value: "FLOORING", label: "Flooring" },
                  { value: "ROOFING", label: "Roofing" },
                  { value: "GARDENING", label: "Gardening" },
                  { value: "CONSTRUCTION", label: "Construction" },
                ]}
                disabled={loading}
              />
            </div>
          </div>

          <div className="rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-4 py-3 shadow-[var(--qf-shadow-sm)]">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("quoteComponents.aiModal.prompt")}</p>
                  <Badge tone="slate">{t("quoteComponents.aiModal.review")}</Badge>
                </div>
                <p className="mt-1 text-sm text-[var(--qf-text-soft)]">
                  {t("quoteComponents.aiModal.contextDescription")}
                </p>
              </div>
              {canUseStarterPrompts ? (
                <div className="grid grid-cols-2 gap-2 sm:min-w-[240px] sm:max-w-[280px]">
                  {starterPrompts!.map((starter, index) => (
                    <button
                      key={`${serviceType}-${index}`}
                      type="button"
                      onClick={() => onUseStarterPrompt?.(starter)}
                      disabled={loading}
                      className="min-h-[44px] rounded-xl border border-quotefly-blue/15 bg-quotefly-blue/[0.08] px-3 py-2 text-left text-xs font-semibold text-quotefly-blue transition hover:border-quotefly-blue/30 hover:bg-quotefly-blue/[0.14] disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-[36px]"
                    >
                      {index === 0 ? t("quoteComponents.aiModal.starter") : t("quoteComponents.aiModal.alternate", { number: index })}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <Textarea
              data-testid="quote-ai-prompt"
              aria-label={t("quoteComponents.aiModal.promptAria")}
              className="mt-4 min-h-[220px] border-[var(--qf-info-border)] bg-[var(--qf-panel)] text-[15px] leading-7 text-[var(--qf-text)] shadow-inner selection:bg-[var(--qf-selected)]"
              rows={9}
              placeholder={promptPlaceholder}
              value={prompt}
              onChange={(event) => onPromptChange(event.target.value)}
              disabled={loading}
            />
          </div>

          {loading ? (
            <div className="rounded-2xl border border-[color:rgba(47,111,214,0.16)] bg-[linear-gradient(135deg,var(--qf-brand-blue-soft),var(--qf-brand-orange-soft))] px-4 py-4 shadow-[0_10px_24px_rgba(47,111,214,0.05)]">
              <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_280px]">
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="blue">{t("quoteComponents.aiModal.working")}</Badge>
                    <Badge tone="orange">{t("quoteComponents.aiModal.tracked")}</Badge>
                  </div>
                  <div>
                    <p className="text-base font-semibold text-[var(--qf-text)]">{activeProgress.label}</p>
                    <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{activeProgress.detail}</p>
                  </div>
                  <ProgressBar value={activeProgress.value} label={t("quoteComponents.aiModal.progress")} hint={`${activeProgress.value}%`} />
                  {activeProgress.sourceHints.length ? (
                    <div className="flex flex-wrap gap-2">
                      {activeProgress.sourceHints.map((hint) => (
                        <Badge key={hint} tone="slate">
                          {hint}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  {activeProgress.patchCounts ? (
                    <div className="flex flex-wrap gap-2">
                      <Badge tone="orange">{t("quoteComponents.aiModal.updated", { count: activeProgress.patchCounts.updated })}</Badge>
                      <Badge tone="blue">{t("quoteComponents.aiModal.added", { count: activeProgress.patchCounts.added })}</Badge>
                      <Badge tone="slate">{t("quoteComponents.aiModal.removed", { count: activeProgress.patchCounts.removed })}</Badge>
                    </div>
                  ) : null}
                  <p className="text-xs font-medium uppercase tracking-[0.16em] text-[var(--qf-text-muted)]">
                    {t("quoteComponents.aiModal.notSending")}
                  </p>
                </div>

                <div className="rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-3 py-3 shadow-[var(--qf-shadow-sm)]">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--qf-text-muted)]">{t("quoteComponents.aiModal.runLog")}</p>
                  <div className="mt-3 space-y-0">
                    {AI_PROGRESS_STAGES.map((stage, index) => {
                      const isComplete = index < activeProgress.index;
                      const isCurrent = index === activeProgress.index;
                      const isLast = index === AI_PROGRESS_STAGES.length - 1;

                      return (
                        <div key={stage.key} className="relative flex gap-3 pb-4 last:pb-0">
                          <div className="relative flex w-6 flex-col items-center">
                            <div
                              className={
                                isComplete
                                  ? "flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 text-white"
                                  : isCurrent
                                    ? "flex h-6 w-6 items-center justify-center rounded-full bg-[var(--qf-brand-orange)] text-[var(--qf-brand-orange-contrast)] shadow-[0_6px_18px_rgba(249,105,40,0.24)]"
                                    : "flex h-6 w-6 items-center justify-center rounded-full border border-[var(--qf-border)] bg-[var(--qf-panel)] text-[var(--qf-text-muted)]"
                              }
                            >
                              {isComplete ? (
                                <CheckCircle2 size={14} />
                              ) : isCurrent ? (
                                <LoaderCircle size={14} className="animate-spin" />
                              ) : (
                                <CircleDashed size={14} />
                              )}
                            </div>
                            {!isLast ? (
                              <span
                                className={
                                  isComplete
                                    ? "mt-1 h-full w-px bg-emerald-300"
                                    : "mt-1 h-full w-px bg-[var(--qf-border)]"
                                }
                              />
                            ) : null}
                          </div>
                          <div className="min-w-0 pt-0.5">
                            <p className={isCurrent ? "text-sm font-semibold text-[var(--qf-text)]" : "text-sm font-medium text-[var(--qf-text-soft)]"}>
                              {t(`quoteComponents.aiModal.stages.${stage.key}.label`)}
                            </p>
                            <p className="mt-0.5 text-xs leading-5 text-[var(--qf-text-muted)]">{t(`quoteComponents.aiModal.stages.${stage.key}.detail`)}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {errorMessage ? (
            <div className="rounded-xl border border-[var(--qf-danger-border)] bg-[var(--qf-danger-surface)] px-3 py-2 text-sm text-[var(--qf-danger-text)]">
              {errorMessage}
            </div>
          ) : null}
          {statusMessage ? (
            <div className="rounded-xl border border-[var(--qf-info-border)] bg-[var(--qf-info-surface)] px-3 py-2 text-sm text-[var(--qf-info-text)]" role="status">
              {statusMessage}
            </div>
          ) : null}
        </ModalBody>

        <ModalFooter className="justify-between gap-3 bg-[var(--qf-panel)]">
          <div className="max-w-[34rem] space-y-1">
            <p className="text-sm text-[var(--qf-text-muted)]">
              {t("quoteComponents.aiModal.footerReview")}
            </p>
            <p className="text-xs text-[var(--qf-text-muted)]">
              {t("quoteComponents.aiModal.footerMeter")}
            </p>
            <p className="text-xs font-medium text-[var(--qf-warning-text)]">
              {t("quoteComponents.aiModal.footerWarning")}
            </p>
          </div>
          <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
            <Button type="button" variant="ghost" onClick={loading && onCancelRequest ? onCancelRequest : onClose}>
              {loading ? t("quoteComponents.aiModal.stop") : t("common.cancel")}
            </Button>
            <Button type="submit" variant="secondary" loading={loading} icon={<Sparkles size={14} />} disabled={disabled}>
              {resolvedSubmitLabel}
            </Button>
          </div>
        </ModalFooter>
      </form>
    </Modal>
  );
}
