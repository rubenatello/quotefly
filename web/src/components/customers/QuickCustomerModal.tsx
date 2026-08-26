import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Badge, Button, ConfirmModal, Input, Modal, ModalBody, ModalFooter, ModalHeader, Textarea } from "../ui";
import { ApiError, api, type Customer, type CustomerDuplicateMatch, type QuoteCustomerDraft } from "../../lib/api";
import { localizedApiError } from "../../lib/localized-api-error";
import { formatUsPhoneDisplay, formatUsPhoneInput, normalizeUsPhoneDigits } from "../../lib/phone";

type QuickCustomerIntent = "save" | "quote";
export type QuoteDraftDuplicateErrorCode =
  | "DUPLICATE_CANDIDATE"
  | "STALE_DUPLICATE_TARGET"
  | "USE_EXISTING_REQUIRES_RESTORE"
  | "MERGE_CONTACT_CONFLICT"
  | "PHONE_CONFLICT";

type QuickCustomerModalProps = {
  open: boolean;
  onClose: () => void;
  draftValue?: QuickCustomerForm;
  onDraftChange?: (draft: QuickCustomerForm) => void;
  quoteDraftMatches?: CustomerDuplicateMatch[];
  quoteDraftErrorCode?: QuoteDraftDuplicateErrorCode | null;
  onQuoteDraftReviewChange?: () => void;
  onQuoteDraftStaged?: (draft: QuoteCustomerDraft) => Promise<void> | void;
  onCreated: (result: {
    customer: Customer;
    merged?: boolean;
    restored?: boolean;
    reusedExisting?: boolean;
    intent: QuickCustomerIntent;
  }) => Promise<void> | void;
};

export type QuickCustomerForm = {
  fullName: string;
  phone: string;
  email: string;
  notes: string;
};

const EMPTY_FORM: QuickCustomerForm = {
  fullName: "",
  phone: "",
  email: "",
  notes: "",
};

function normalizePayload(form: QuickCustomerForm) {
  return {
    fullName: form.fullName.trim(),
    phone: formatUsPhoneDisplay(form.phone) || form.phone.trim(),
    email: form.email.trim() || null,
    notes: form.notes.trim() || null,
  };
}

function hasPhoneDuplicateReason(match: CustomerDuplicateMatch) {
  return match.matchReasons.includes("phone");
}

function isInactiveDuplicateMatch(match: CustomerDuplicateMatch) {
  return Boolean(match.archivedAtUtc || match.deletedAtUtc);
}

function preferredDuplicateMatchId(matches: CustomerDuplicateMatch[]) {
  const activePhone = matches.find((match) => hasPhoneDuplicateReason(match) && !isInactiveDuplicateMatch(match));
  if (activePhone) return activePhone.id;

  const phoneMatch = matches.find(hasPhoneDuplicateReason);
  if (phoneMatch) return phoneMatch.id;

  const activeMatch = matches.find((match) => !isInactiveDuplicateMatch(match));
  if (activeMatch) return activeMatch.id;

  return matches[0]?.id ?? null;
}

export function QuickCustomerModal({
  open,
  onClose,
  draftValue,
  onDraftChange,
  quoteDraftMatches,
  quoteDraftErrorCode,
  onQuoteDraftReviewChange,
  onQuoteDraftStaged,
  onCreated,
}: QuickCustomerModalProps) {
  const { t } = useTranslation();
  const [internalForm, setInternalForm] = useState<QuickCustomerForm>(EMPTY_FORM);
  const form = draftValue ?? internalForm;
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [intent, setIntent] = useState<QuickCustomerIntent>("save");
  const [matches, setMatches] = useState<CustomerDuplicateMatch[]>([]);
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);

  const phoneConflictExists = useMemo(
    () => matches.some((match) => hasPhoneDuplicateReason(match)),
    [matches],
  );
  const selectedMatch = useMemo(
    () => matches.find((match) => match.id === selectedMatchId) ?? null,
    [matches, selectedMatchId],
  );
  const selectedMatchInactive = Boolean(selectedMatch && isInactiveDuplicateMatch(selectedMatch));
  const dirty = Object.values(form).some((value) => value.trim().length > 0);

  useEffect(() => {
    if (!open || (!quoteDraftErrorCode && !quoteDraftMatches?.length)) return;
    // Duplicate matches returned by the atomic quote command must stay in the
    // quote-staging path even after this component has remounted during draft
    // recovery. Otherwise the duplicate buttons can fall back to a standalone
    // customer write and break the customer-plus-quote transaction boundary.
    setIntent("quote");
    const currentMatches = quoteDraftMatches ?? [];
    setMatches(currentMatches);
    setSelectedMatchId((currentSelection) => (
      currentSelection && currentMatches.some((match) => match.id === currentSelection)
        ? currentSelection
        : preferredDuplicateMatchId(currentMatches)
    ));
    const reviewError = (() => {
      switch (quoteDraftErrorCode) {
        case "STALE_DUPLICATE_TARGET":
          return t("customers.quick.changed");
        case "USE_EXISTING_REQUIRES_RESTORE":
          return t("customers.quick.restoreRequired");
        case "MERGE_CONTACT_CONFLICT":
          return t("customers.quick.contactConflict");
        case "PHONE_CONFLICT":
          return currentMatches.length > 0
            ? t("customers.quick.phoneConflict")
            : t("customers.quick.phoneConflictRestricted");
        default:
          return null;
      }
    })();
    setError(reviewError);
  }, [open, quoteDraftErrorCode, quoteDraftMatches, t]);

  function updateForm(updater: (current: QuickCustomerForm) => QuickCustomerForm) {
    const next = updater(form);
    if (
      next.fullName !== form.fullName ||
      next.phone !== form.phone ||
      next.email !== form.email
    ) {
      setMatches([]);
      setSelectedMatchId(null);
      setError(null);
      onQuoteDraftReviewChange?.();
    }
    if (draftValue === undefined) setInternalForm(next);
    onDraftChange?.(next);
  }

  function resetState() {
    setInternalForm(EMPTY_FORM);
    onDraftChange?.(EMPTY_FORM);
    setError(null);
    setSaving(false);
    setIntent("save");
    setMatches([]);
    setSelectedMatchId(null);
    setDiscardConfirmOpen(false);
  }

  function completeAndCloseModal() {
    resetState();
    onClose();
  }

  function closeModal() {
    if (dirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    completeAndCloseModal();
  }

  async function createCustomer(
    mode: QuickCustomerIntent,
    duplicateAction?: "merge" | "create_new" | "use_existing",
  ) {
    const payload = normalizePayload(form);
    if (!payload.fullName || !payload.phone) {
      setError(t("customers.quick.required"));
      return;
    }
    if (!normalizeUsPhoneDigits(payload.phone)) {
      setError(t("customers.quick.invalidPhone"));
      return;
    }

    setSaving(true);
    setError(null);
    setIntent(mode);

    try {
      if (mode === "quote" && onQuoteDraftStaged) {
        const selectedPhone = selectedMatch
          ? formatUsPhoneDisplay(selectedMatch.phone) || selectedMatch.phone
          : payload.phone;
        const effectivePayload = duplicateAction === "use_existing" && selectedMatch
          ? {
              ...payload,
              fullName: selectedMatch.fullName,
              phone: selectedPhone,
              email: selectedMatch.email,
            }
          : payload;
        await onQuoteDraftStaged({
          ...effectivePayload,
          duplicateAction,
          duplicateCustomerId: duplicateAction ? selectedMatchId ?? undefined : undefined,
        });
        setMatches([]);
        setSelectedMatchId(null);
        setDiscardConfirmOpen(false);
        onClose();
        return;
      }
      const result = await api.customers.create({
        ...payload,
        duplicateAction,
        duplicateCustomerId:
          duplicateAction === "merge" || duplicateAction === "use_existing"
            ? selectedMatchId ?? undefined
            : undefined,
      });
      const createdResult = {
        customer: result.customer,
        merged: result.merged,
        restored: result.restored,
        reusedExisting: result.reusedExisting,
        intent: mode,
      };
      completeAndCloseModal();
      void Promise.resolve(onCreated(createdResult)).catch((callbackError) => {
        console.error("[quick-customer-modal] onCreated callback failed", callbackError);
      });
    } catch (err) {
      if (err instanceof ApiError) {
        const details = err.details as { code?: string; matches?: CustomerDuplicateMatch[] } | undefined;
        if (
          (details?.code === "DUPLICATE_CANDIDATE" || details?.code === "STALE_DUPLICATE_TARGET") &&
          Array.isArray(details.matches) &&
          details.matches.length > 0
        ) {
          setMatches(details.matches);
          setSelectedMatchId(preferredDuplicateMatchId(details.matches));
          if (details.code === "STALE_DUPLICATE_TARGET") {
            setError(t("customers.quick.changed"));
          }
          setSaving(false);
          return;
        }
        setError(localizedApiError(err, t, {
          fallbackKey: "customers.quick.createError",
          statusKeys: { 400: "apiErrors.invalidRequest" },
        }));
      } else {
        setError(localizedApiError(err, t, { fallbackKey: "customers.quick.createError" }));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
    <Modal open={open} onClose={closeModal} closeOnBackdrop={!discardConfirmOpen} size="lg" ariaLabel={t("customers.quick.title")}>
      <ModalHeader
        title={t("customers.quick.title")}
        description={t("customers.quick.description")}
        onClose={closeModal}
      />
      <ModalBody className="space-y-4">
        {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label={t("customers.quick.fullName")}
            placeholder="Alan Johnson"
            value={form.fullName}
            onChange={(event) => updateForm((prev) => ({ ...prev, fullName: event.target.value }))}
            disabled={saving}
          />
          <Input
            label={t("customers.quick.phone")}
            type="tel"
            placeholder="(818) 233-4333"
            value={form.phone}
            onChange={(event) =>
              updateForm((prev) => ({ ...prev, phone: formatUsPhoneInput(event.target.value) }))
            }
            disabled={saving}
          />
        </div>

        <Input
          label={t("customers.quick.email")}
          type="email"
          placeholder={t("customers.quick.optional")}
          value={form.email}
          onChange={(event) => updateForm((prev) => ({ ...prev, email: event.target.value }))}
          disabled={saving}
        />

        <Textarea
          label={t("customers.quick.notes")}
          rows={4}
          placeholder={t("customers.quick.notesPlaceholder")}
          value={form.notes}
          onChange={(event) => updateForm((prev) => ({ ...prev, notes: event.target.value }))}
          disabled={saving}
        />

        {matches.length > 0 ? (
          <div className="space-y-3 rounded-2xl border border-[var(--qf-warning-border)] bg-[var(--qf-warning-surface)] p-4">
            <div>
              <p className="text-sm font-semibold text-[var(--qf-warning-text)]">
                {phoneConflictExists ? t("customers.quick.phoneDuplicate") : t("customers.quick.emailDuplicate")}
              </p>
              <p className="mt-1 text-xs text-[var(--qf-warning-text)]">
                {phoneConflictExists
                  ? t("customers.quick.phoneDuplicateHelp")
                  : t("customers.quick.emailDuplicateHelp")}
              </p>
            </div>
            <div className="space-y-2">
              {matches.map((match) => (
                <label
                  key={match.id}
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-3 transition ${
                    selectedMatchId === match.id
                      ? "border-[var(--qf-warning-border)] bg-[var(--qf-panel)] ring-2 ring-[var(--qf-focus-ring)]"
                      : "border-[var(--qf-warning-border)] bg-[var(--qf-panel)]"
                  }`}
                >
                  <input
                    type="radio"
                    name="duplicateCustomer"
                    className="mt-1"
                    checked={selectedMatchId === match.id}
                    onChange={() => {
                      setSelectedMatchId(match.id);
                      setError(null);
                      onQuoteDraftReviewChange?.();
                    }}
                    disabled={saving}
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-[var(--qf-text)]">{match.fullName}</p>
                    <p className="mt-1 text-xs text-[var(--qf-text-soft)]">{formatUsPhoneDisplay(match.phone)}</p>
                    <p className="mt-1 truncate text-xs text-[var(--qf-text-muted)]">{match.email ?? t("customers.quick.noEmail")}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {match.matchReasons.map((reason) => (
                        <Badge key={`${match.id}-${reason}`} tone={reason === "phone" ? "red" : "amber"}>
                          {reason === "phone" ? t("customers.quick.phoneMatch") : t("customers.quick.emailMatch")}
                        </Badge>
                      ))}
                      {match.archivedAtUtc ? <Badge tone="slate">{t("customers.quick.archived")}</Badge> : null}
                      {match.deletedAtUtc ? <Badge tone="slate">{t("customers.quick.deleted")}</Badge> : null}
                    </div>
                  </div>
                </label>
              ))}
            </div>
            {selectedMatchInactive ? (
              <p className="rounded-lg border border-[var(--qf-border-strong)] bg-[var(--qf-panel)] px-3 py-2 text-xs text-[var(--qf-text-soft)]">
                {t("customers.quick.inactiveHelp")}
              </p>
            ) : null}
          </div>
        ) : null}
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={closeModal} disabled={saving}>
          {t("common.cancel")}
        </Button>
        {matches.length > 0 ? (
          <>
            <Button
              onClick={() => void createCustomer(intent, "use_existing")}
              loading={saving}
              disabled={saving || !selectedMatchId || selectedMatchInactive}
            >
              {t("customers.quick.useExisting")}
            </Button>
            <Button
              variant="outline"
              onClick={() => void createCustomer(intent, "merge")}
              disabled={saving || !selectedMatchId}
            >
              {t("customers.quick.merge")}
            </Button>
            <Button
              variant="outline"
              onClick={() => void createCustomer(intent, "create_new")}
              disabled={saving || phoneConflictExists}
            >
              {t("customers.quick.saveNew")}
            </Button>
          </>
        ) : (
          <>
            {intent === "save" ? (
              <Button variant="outline" onClick={() => void createCustomer("save")} disabled={saving}>
                {t("customers.quick.saveCustomer")}
              </Button>
            ) : null}
            <Button onClick={() => void createCustomer("quote")} loading={saving} disabled={saving}>
              {t("customers.quick.saveQuote")}
            </Button>
          </>
        )}
      </ModalFooter>
    </Modal>
    <ConfirmModal
      open={discardConfirmOpen}
      onClose={() => setDiscardConfirmOpen(false)}
      onConfirm={completeAndCloseModal}
      title={t("customers.quick.discardTitle")}
      description={t("customers.quick.discardDescription")}
      confirmLabel={t("customers.quick.discard")}
      confirmVariant="warning"
    />
    </>
  );
}
