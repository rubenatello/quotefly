import { useMemo, useState } from "react";
import { Alert, Badge, Button, ConfirmModal, Input, Modal, ModalBody, ModalFooter, ModalHeader, Textarea } from "../ui";
import { ApiError, api, type Customer, type CustomerDuplicateMatch } from "../../lib/api";
import { formatUsPhoneDisplay, formatUsPhoneInput, normalizeUsPhoneDigits } from "../../lib/phone";

type QuickCustomerIntent = "save" | "quote";

type QuickCustomerModalProps = {
  open: boolean;
  onClose: () => void;
  draftValue?: QuickCustomerForm;
  onDraftChange?: (draft: QuickCustomerForm) => void;
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

export function QuickCustomerModal({ open, onClose, draftValue, onDraftChange, onCreated }: QuickCustomerModalProps) {
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
      setError("Full name and phone are required.");
      return;
    }
    if (!normalizeUsPhoneDigits(payload.phone)) {
      setError("Enter a valid 10-digit US phone number.");
      return;
    }

    setSaving(true);
    setError(null);
    setIntent(mode);

    try {
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
            setError("Customer details changed after the duplicate warning. Review the refreshed matches before continuing.");
          }
          setSaving(false);
          return;
        }
        setError(err.message);
      } else {
        setError("Failed creating customer.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
    <Modal open={open} onClose={closeModal} closeOnBackdrop={!discardConfirmOpen} size="lg" ariaLabel="Add customer fast">
      <ModalHeader
        title="Add customer fast"
        description="Create a customer without leaving the board. Save only, or save and jump straight into a quote."
        onClose={closeModal}
      />
      <ModalBody className="space-y-4">
        {error ? <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert> : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Full name"
            placeholder="Alan Johnson"
            value={form.fullName}
            onChange={(event) => updateForm((prev) => ({ ...prev, fullName: event.target.value }))}
            disabled={saving}
          />
          <Input
            label="Phone"
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
          label="Email"
          type="email"
          placeholder="Optional"
          value={form.email}
          onChange={(event) => updateForm((prev) => ({ ...prev, email: event.target.value }))}
          disabled={saving}
        />

        <Textarea
          label="Customer notes"
          rows={4}
          placeholder="Internal notes, property details, concerns, preferences, or follow-up context for your team and AI."
          value={form.notes}
          onChange={(event) => updateForm((prev) => ({ ...prev, notes: event.target.value }))}
          disabled={saving}
        />

        {matches.length > 0 ? (
          <div className="space-y-3 rounded-2xl border border-[var(--qf-warning-border)] bg-[var(--qf-warning-surface)] p-4">
            <div>
              <p className="text-sm font-semibold text-[var(--qf-warning-text)]">
                {phoneConflictExists ? "Exact phone match found" : "Possible email duplicate found"}
              </p>
              <p className="mt-1 text-xs text-[var(--qf-warning-text)]">
                {phoneConflictExists
                  ? "Use Existing is the fastest path and is the default recommendation. Add as New is disabled for exact phone matches."
                  : "Email-only matches are a softer warning. You can use existing, merge updates, or add as new."}
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
                    onChange={() => setSelectedMatchId(match.id)}
                    disabled={saving}
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-[var(--qf-text)]">{match.fullName}</p>
                    <p className="mt-1 text-xs text-[var(--qf-text-soft)]">{formatUsPhoneDisplay(match.phone)}</p>
                    <p className="mt-1 truncate text-xs text-[var(--qf-text-muted)]">{match.email ?? "No email"}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {match.matchReasons.map((reason) => (
                        <Badge key={`${match.id}-${reason}`} tone={reason === "phone" ? "red" : "amber"}>
                          {reason === "phone" ? "Phone match" : "Email match"}
                        </Badge>
                      ))}
                      {match.archivedAtUtc ? <Badge tone="slate">Archived</Badge> : null}
                      {match.deletedAtUtc ? <Badge tone="slate">Deleted</Badge> : null}
                    </div>
                  </div>
                </label>
              ))}
            </div>
            {selectedMatchInactive ? (
              <p className="rounded-lg border border-[var(--qf-border-strong)] bg-[var(--qf-panel)] px-3 py-2 text-xs text-[var(--qf-text-soft)]">
                Selected record is inactive. Choose <span className="font-semibold">Merge Selected</span> to restore the customer. Retained quotes stay archived or deleted and are not restored automatically.
              </p>
            ) : null}
          </div>
        ) : null}
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={closeModal} disabled={saving}>
          Cancel
        </Button>
        {matches.length > 0 ? (
          <>
            <Button
              onClick={() => void createCustomer(intent, "use_existing")}
              loading={saving}
              disabled={saving || !selectedMatchId || selectedMatchInactive}
            >
              Use Existing
            </Button>
            <Button
              variant="outline"
              onClick={() => void createCustomer(intent, "merge")}
              disabled={saving || !selectedMatchId}
            >
              Merge Selected
            </Button>
            <Button
              variant="outline"
              onClick={() => void createCustomer(intent, "create_new")}
              disabled={saving || phoneConflictExists}
            >
              Save as New
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={() => void createCustomer("save")} disabled={saving}>
              Save Customer
            </Button>
            <Button onClick={() => void createCustomer("quote")} loading={saving} disabled={saving}>
              Save + Build Quote
            </Button>
          </>
        )}
      </ModalFooter>
    </Modal>
    <ConfirmModal
      open={discardConfirmOpen}
      onClose={() => setDiscardConfirmOpen(false)}
      onConfirm={completeAndCloseModal}
      title="Discard unsaved customer?"
      description="The customer details entered in this window will be lost."
      confirmLabel="Discard changes"
      confirmVariant="warning"
    />
    </>
  );
}
