import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Modal, ModalBody, ModalFooter, ModalHeader, Select, Textarea } from "../ui";
import type { Customer, CustomerLostReason } from "../../lib/api";
import { customerLostReasonLabel } from "./customer-lifecycle-labels";

export type CustomerLifecycleMode = "mark-lost" | "reopen";

const LOST_REASONS: readonly CustomerLostReason[] = [
  "PRICE",
  "NO_RESPONSE",
  "COMPETITOR",
  "TIMING",
  "NOT_A_FIT",
  "CUSTOMER_CANCELED",
  "OTHER",
];

export function CustomerLifecycleModal({
  mode,
  customer,
  open,
  saving,
  error,
  followUpAutomationEnabled,
  onClose,
  onMarkLost,
  onReopen,
}: {
  mode: CustomerLifecycleMode;
  customer: Customer | null;
  open: boolean;
  saving: boolean;
  error: string | null;
  followUpAutomationEnabled: boolean | null;
  onClose: () => void;
  onMarkLost: (input: { reason: CustomerLostReason; notes: string | null }) => void;
  onReopen: (input: { startFollowUpSequence: boolean }) => void;
}) {
  const { t } = useTranslation();
  const descriptionId = useId();
  const [reason, setReason] = useState<CustomerLostReason | "">("");
  const [notes, setNotes] = useState("");
  const [reopenChoice, setReopenChoice] = useState<"schedule" | "without-schedule" | "">("");

  if (!customer) return null;
  const manualTaskCount = customer.summary?.openManualTaskCount ?? 0;
  const isMarkLost = mode === "mark-lost";
  const otherReasonNeedsNotes = reason === "OTHER" && !notes.trim();
  const followUpAutomationUnavailable = followUpAutomationEnabled !== true;

  return (
    <Modal
      open={open}
      onClose={saving ? () => undefined : onClose}
      closeOnBackdrop={!saving}
      size="md"
      panelClassName="customer-lifecycle-dialog"
      ariaLabel={isMarkLost ? t("customers.lifecycle.markLostTitle") : t("customers.lifecycle.reopenTitle")}
    >
      <ModalHeader
        title={isMarkLost ? t("customers.lifecycle.markLostTitle") : t("customers.lifecycle.reopenTitle")}
        description={t(isMarkLost ? "customers.lifecycle.markLostDescription" : "customers.lifecycle.reopenDescription", { name: customer.fullName })}
        onClose={saving ? undefined : onClose}
      />
      <ModalBody>
        <div className="space-y-4" aria-busy={saving} aria-describedby={descriptionId}>
          <p id={descriptionId} className="text-sm text-[var(--qf-text-soft)]">
            {t(isMarkLost ? "customers.lifecycle.markLostEffect" : "customers.lifecycle.reopenEffect")}
          </p>
          {error ? <Alert tone="error">{error}</Alert> : null}
          {manualTaskCount > 0 ? (
            <Alert tone="warning">
              {t("customers.lifecycle.manualTasksRemain", { count: manualTaskCount })}
            </Alert>
          ) : null}

          {isMarkLost ? (
            <>
              <Select
                label={t("customers.lifecycle.reasonLabel")}
                value={reason}
                required
                aria-required="true"
                disabled={saving}
                options={[
                  { value: "", label: t("customers.lifecycle.reasonPlaceholder"), disabled: true },
                  ...LOST_REASONS.map((value) => ({ value, label: customerLostReasonLabel(value, t) })),
                ]}
                onChange={(event) => setReason(event.target.value as CustomerLostReason | "")}
              />
              <p className="text-xs text-[var(--qf-text-muted)]">{t("customers.lifecycle.reasonRequired")}</p>
              <div>
                <Textarea
                  label={t("customers.lifecycle.notesLabel")}
                  value={notes}
                  rows={4}
                  maxLength={1_000}
                  disabled={saving}
                  placeholder={t("customers.lifecycle.notesPlaceholder")}
                  onChange={(event) => setNotes(event.target.value)}
                />
                <p className="mt-1 text-right text-xs text-[var(--qf-text-muted)]">
                  {t("customers.lifecycle.notesCount", { count: notes.length })}
                </p>
                {reason === "OTHER" ? (
                  <p className={`mt-1 text-xs ${otherReasonNeedsNotes ? "text-[var(--qf-danger-strong)]" : "text-[var(--qf-text-muted)]"}`}>
                    {t("customers.lifecycle.otherNotesRequired")}
                  </p>
                ) : null}
              </div>
            </>
          ) : (
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold text-[var(--qf-text)]">{t("customers.lifecycle.reopenChoice")}</legend>
              <p className="text-xs text-[var(--qf-text-muted)]">{t("customers.lifecycle.reopenChoiceRequired")}</p>
              <div className="space-y-2" role="radiogroup" aria-required="true" aria-label={t("customers.lifecycle.reopenChoice")}>
              {(["schedule", "without-schedule"] as const).map((choice) => (
                <label
                  key={choice}
                  className={`flex min-h-11 items-start gap-3 rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-3 py-3 text-sm text-[var(--qf-text)] focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--qf-focus)] ${choice === "schedule" && followUpAutomationUnavailable ? "cursor-not-allowed opacity-65" : "cursor-pointer"}`}
                >
                  <input
                    type="radio"
                    name="customer-reopen-choice"
                    value={choice}
                    checked={reopenChoice === choice}
                    disabled={saving || (choice === "schedule" && followUpAutomationUnavailable)}
                    required
                    onChange={() => setReopenChoice(choice)}
                    className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--qf-brand-blue)]"
                  />
                  <span>
                    <span className="block font-semibold">{t(`customers.lifecycle.${choice === "schedule" ? "reopenWithSchedule" : "reopenWithoutSchedule"}`)}</span>
                    <span className="mt-1 block text-xs text-[var(--qf-text-muted)]">
                      {choice === "schedule" && followUpAutomationUnavailable
                        ? t(followUpAutomationEnabled === null
                          ? "customers.lifecycle.reopenAutomationChecking"
                          : "customers.lifecycle.reopenAutomationUnavailable")
                        : t(`customers.lifecycle.${choice === "schedule" ? "reopenWithScheduleDescription" : "reopenWithoutScheduleDescription"}`)}
                    </span>
                  </span>
                </label>
              ))}
              </div>
              {followUpAutomationEnabled === false ? (
                <a
                  href="/app/settings?section=follow-up"
                  className="inline-flex min-h-11 items-center rounded-lg text-sm font-semibold text-[var(--qf-link)] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]"
                >
                  {t("customers.lifecycle.openFollowUpSettings")}
                </a>
              ) : null}
            </fieldset>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>{t("common.cancel")}</Button>
        {isMarkLost ? (
          <Button
            variant="danger"
            loading={saving}
            disabled={!reason || otherReasonNeedsNotes || saving}
            onClick={() => reason && onMarkLost({ reason, notes: notes.trim() || null })}
          >
            {manualTaskCount > 0 ? t("customers.lifecycle.markLostKeepTasks") : t("customers.lifecycle.markLostConfirm")}
          </Button>
        ) : (
          <Button
            loading={saving}
            disabled={!reopenChoice || saving}
            onClick={() => reopenChoice && onReopen({ startFollowUpSequence: reopenChoice === "schedule" })}
          >
            {t("customers.lifecycle.reopenConfirm")}
          </Button>
        )}
      </ModalFooter>
    </Modal>
  );
}
