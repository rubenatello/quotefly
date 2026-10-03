import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError, type InvoiceTaxAddress, type InvoiceTaxContextForm as FormSource, type InvoiceTaxDecisions } from "../../lib/api";
import { Alert, Button, ConfirmModal, Input, LoadingState, Select } from "../ui";

const states = "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" ");
const blankAddress = (): InvoiceTaxAddress => ({ Line1: "", City: "", CountrySubDivisionCode: "", PostalCode: "", Country: "US" });
type Draft = { transactionDate: string; origin: InvoiceTaxAddress; destination: InvoiceTaxAddress; intents: Record<string, string> };
const emptyDraft = (): Draft => ({ transactionDate: "", origin: blankAddress(), destination: blankAddress(), intents: {} });
type Props = {
  invoiceId: string; invoiceVersion: number; reviewFingerprint: string; disabled?: boolean;
  onPendingChange: (pending: boolean) => void; onSavingChange: (saving: boolean) => void; onOpenChange: (open: boolean) => void; onSaved: () => Promise<void>;
};

/** Private, memory-only intent capture. Saving never calculates tax or publishes. */
export function InvoiceTaxContextForm({ invoiceId, invoiceVersion, reviewFingerprint, disabled, onPendingChange, onSavingChange, onOpenChange, onSaved }: Props) {
  const { t, i18n } = useTranslation();
  const prefix = useId();
  const sectionRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const alive = useRef(true);
  const requestGeneration = useRef(0);
  const command = useRef<{ fingerprint: string; key: string } | null>(null);
  const [opened, setOpened] = useState(false);
  const [source, setSource] = useState<FormSource | null>(null);
  const [loadedFingerprint, setLoadedFingerprint] = useState("");
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [discardOpen, setDiscardOpen] = useState(false);
  const stale = Boolean(source && (source.invoice.version !== invoiceVersion || loadedFingerprint !== reviewFingerprint));
  const tr = (key: string) => t(`invoices.taxContext.${key}`);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; requestGeneration.current += 1; };
  }, []);
  useEffect(() => { onPendingChange(dirty || saving); }, [dirty, saving, onPendingChange]);
  useEffect(() => () => { onPendingChange(false); }, [onPendingChange]);
  useEffect(() => { onSavingChange(saving); }, [saving, onSavingChange]);
  useEffect(() => () => { onSavingChange(false); }, [onSavingChange]);
  useEffect(() => { onOpenChange(opened); }, [opened, onOpenChange]);
  useEffect(() => () => { onOpenChange(false); }, [onOpenChange]);

  function edit(update: (previous: Draft) => Draft) {
    setDraft(update); setDirty(true); setErrors({});
  }
  function displayError(error: unknown) {
    if (error instanceof ApiError) {
      if (error.status === 409) { setNeedsReload(true); return "stale"; }
      if (error.status === 401 || error.status === 403) return "permission";
      if (error.status === 503) return "paused";
      if (error.status === 404) return "unavailable";
    }
    return "requestFailed";
  }
  async function load(preserveDraft: boolean) {
    const generation = ++requestGeneration.current;
    const previousFocus = document.activeElement instanceof HTMLElement && sectionRef.current?.contains(document.activeElement)
      ? document.activeElement : null;
    setOpened(true); setLoading(true); setErrorKey(null);
    try {
      const next = await api.integrations.quickbooks.invoiceTaxContext(invoiceId);
      if (!alive.current || generation !== requestGeneration.current) return;
      if (next.invoice.id !== invoiceId || next.invoice.version !== invoiceVersion || next.publishingAuthorized !== false
        || next.taxCalculationProven !== false || !next.invoice.lines.length || next.invoice.lines.length > 500) {
        setNeedsReload(true); setErrorKey("stale"); return;
      }
      setSource(next); setLoadedFingerprint(reviewFingerprint); setNeedsReload(false); setErrors({});
      if (!preserveDraft) {
        const prior = next.currentContext.decisions;
        setDraft({ transactionDate: prior?.transactionDate ?? "", origin: prior?.origin ?? next.suggestions.origin ?? blankAddress(),
          destination: prior?.destination ?? blankAddress(), intents: Object.fromEntries(prior?.lines.map(line => [line.invoiceLineItemId, line.taxIntent]) ?? []) });
        setDirty(false);
      }
    } catch (error) {
      if (alive.current && generation === requestGeneration.current) setErrorKey(displayError(error));
    } finally {
      if (alive.current && generation === requestGeneration.current) {
        setLoading(false);
        requestAnimationFrame(() => {
          if (!alive.current || generation !== requestGeneration.current || !previousFocus) return;
          if (document.activeElement !== document.body && document.activeElement !== previousFocus) return;
          const target = previousFocus.isConnected && !previousFocus.matches(':disabled') && !previousFocus.closest('[inert]') ? previousFocus : titleRef.current;
          target?.focus();
        });
      }
    }
  }
  function close() {
    requestGeneration.current += 1;
    setOpened(false); setSource(null); setDraft(emptyDraft()); setDirty(false); setErrors({}); setErrorKey(null); setLoading(false);
    command.current = null; setDiscardOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }
  async function save() {
    if (!source || saving || loading || disabled || stale || needsReload) return;
    const invalid: Record<string, string> = {};
    const day = new Date(`${draft.transactionDate}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.transactionDate) || !Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== draft.transactionDate) invalid.transactionDate = tr("requiredDate");
    for (const name of ["origin", "destination"] as const) {
      for (const field of ["Line1", "City"] as const) if (!draft[name][field].trim()) invalid[`${name}.${field}`] = tr("required");
      if (!states.includes(draft[name].CountrySubDivisionCode)) invalid[`${name}.CountrySubDivisionCode`] = tr("required");
      if (!/^\d{5}(?:-\d{4})?$/.test(draft[name].PostalCode.trim())) invalid[`${name}.PostalCode`] = tr("invalidZip");
    }
    for (const line of source.invoice.lines) if (!["TAXABLE", "NON_TAXABLE"].includes(draft.intents[line.invoiceLineItemId])) invalid[`line.${line.invoiceLineItemId}`] = tr("requiredIntent");
    setErrors(invalid);
    if (Object.keys(invalid).length) {
      requestAnimationFrame(() => sectionRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()); return;
    }
    if (new Date(source.sourceTokenExpiresAtUtc).getTime() <= Date.now()) { setNeedsReload(true); setErrorKey("stale"); return; }
    const address = (value: InvoiceTaxAddress): InvoiceTaxAddress => ({ ...value, Line1: value.Line1.trim(), City: value.City.trim(),
      PostalCode: value.PostalCode.trim(), ...(value.Line2?.trim() ? { Line2: value.Line2.trim() } : { Line2: undefined }) });
    const decisions: InvoiceTaxDecisions = { transactionDate: draft.transactionDate, origin: address(draft.origin), destination: address(draft.destination),
      lines: source.invoice.lines.map(line => ({ invoiceLineItemId: line.invoiceLineItemId, taxIntent: draft.intents[line.invoiceLineItemId] as "TAXABLE" | "NON_TAXABLE" })) };
    // A lost successful response can advance the server revision before reload.
    // Keep the accepted command identity for unchanged semantic decisions.
    const fingerprint = JSON.stringify(decisions);
    if (command.current?.fingerprint !== fingerprint) command.current = { fingerprint, key: crypto.randomUUID() };
    const generation = ++requestGeneration.current;
    setSaving(true); setErrorKey(null);
    try {
      await api.integrations.quickbooks.confirmInvoiceTaxContext(invoiceId, { ...decisions, expectedContextRevision: source.expectedContextRevision,
        commandKey: command.current.key, sourceToken: source.sourceToken });
      if (!alive.current || generation !== requestGeneration.current) return;
      setDirty(false); command.current = null;
      await onSaved();
      if (alive.current && generation === requestGeneration.current) await load(false);
    } catch (error) {
      if (alive.current && generation === requestGeneration.current) setErrorKey(displayError(error));
    } finally {
      if (alive.current) {
        setSaving(false);
        requestAnimationFrame(() => {
          if (alive.current && document.activeElement === document.body) titleRef.current?.focus();
        });
      }
    }
  }
  function addressFields(name: "origin" | "destination") {
    const update = (field: keyof InvoiceTaxAddress, value: string) => edit(previous => ({ ...previous, [name]: { ...previous[name], [field]: value } }));
    return <fieldset className="space-y-3" disabled={saving || disabled}>
      <legend className="mb-2 text-sm font-semibold">{tr(name)}</legend>
      <p className="text-xs text-[var(--qf-text-muted)]">{tr(`${name}Help`)}</p>
      <Input label={tr("street")} autoComplete="off" maxLength={200} value={draft[name].Line1} error={errors[`${name}.Line1`]} onChange={event => update("Line1", event.target.value)} />
      <Input label={tr("street2")} autoComplete="off" maxLength={200} value={draft[name].Line2 ?? ""} onChange={event => update("Line2", event.target.value)} />
      <Input label={tr("city")} autoComplete="off" maxLength={100} value={draft[name].City} error={errors[`${name}.City`]} onChange={event => update("City", event.target.value)} />
      <div className="grid grid-cols-2 gap-3">
        <Select label={tr("state")} placeholder={tr("chooseState")} value={draft[name].CountrySubDivisionCode} error={errors[`${name}.CountrySubDivisionCode`]}
          options={states.map(value => ({ value, label: value }))} onChange={event => update("CountrySubDivisionCode", event.target.value)} />
        <Input label={tr("zip")} inputMode="numeric" autoComplete="off" maxLength={10} value={draft[name].PostalCode} error={errors[`${name}.PostalCode`]} onChange={event => update("PostalCode", event.target.value)} />
      </div>
      <p className="text-xs text-[var(--qf-text-muted)]">{tr("country")}</p>
    </fieldset>;
  }
  return <div ref={sectionRef} className="space-y-3 border-t border-[var(--qf-border)] pt-3" data-testid="invoice-tax-context"
    onFocusCapture={event => {
      const target = event.target as HTMLElement;
      requestAnimationFrame(() => {
        if (!target.isConnected || document.activeElement !== target) return;
        const navigation = document.querySelector('.qf-mobile-bottom-nav')?.getBoundingClientRect();
        const bounds = target.getBoundingClientRect();
        if (navigation && navigation.height > 0 && bounds.bottom > navigation.top && bounds.top < navigation.bottom) {
          target.scrollIntoView({ block: "center", behavior: "instant" });
        }
      });
    }}>
    <div>
      <h4 ref={titleRef} tabIndex={-1} className="text-sm font-semibold">{tr("title")}</h4>
      <p className="mt-1 text-xs leading-5 text-[var(--qf-text-muted)]">{tr("boundary")}</p>
    </div>
    {!opened ? <Button ref={triggerRef} type="button" variant="outline" className="min-h-11" disabled={disabled} onClick={() => void load(false)}>{tr("open")}</Button> : <>
      {errorKey ? <Alert tone="error">{tr(errorKey)}</Alert> : null}
      {(stale || needsReload) && errorKey !== "stale" ? <Alert tone="warning">{tr("stale")}</Alert> : null}
      {source?.currentContext.revision && !source.currentContext.current && !dirty ? <Alert tone="warning">{tr("previousStale")}</Alert> : null}
      {loading ? <LoadingState variant="compact" title={tr("loading")} /> : null}
      {source ? <>
        <Input type="date" label={tr("date")} value={draft.transactionDate} error={errors.transactionDate} disabled={saving || disabled}
          onChange={event => edit(previous => ({ ...previous, transactionDate: event.target.value }))} />
        <div className="grid gap-5 lg:grid-cols-2">{addressFields("origin")}{addressFields("destination")}</div>
        <fieldset disabled={saving || disabled} className="space-y-3">
          <legend className="mb-2 text-sm font-semibold">{tr("lineIntent")}</legend>
          <p className="text-xs text-[var(--qf-text-muted)]">{tr("lineHelp")}</p>
          {source.invoice.lines.map((line, index) => {
            const fieldError = errors[`line.${line.invoiceLineItemId}`];
            const errorId = `${prefix}-line-${index}-error`;
            return <fieldset key={line.invoiceLineItemId} className="space-y-2 border-b border-[var(--qf-border)] pb-3 last:border-0">
              <legend className="max-w-full break-words text-sm font-medium">{line.description}</legend>
              <p className="text-xs text-[var(--qf-text-muted)]">{new Intl.NumberFormat(i18n.resolvedLanguage ?? "en-US", { style: "currency", currency: "USD" }).format(Number(line.amount))}{line.mapping.displayName ? ` · ${line.mapping.displayName}` : ""}</p>
              <div className="flex flex-wrap gap-x-5 gap-y-1">
                {(["TAXABLE", "NON_TAXABLE"] as const).map(intent => <label key={intent} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
                  <input type="radio" className="h-4 w-4" name={`${prefix}-${line.invoiceLineItemId}`} value={intent} checked={draft.intents[line.invoiceLineItemId] === intent}
                    aria-invalid={Boolean(fieldError)} aria-describedby={fieldError ? errorId : undefined}
                    onChange={() => edit(previous => ({ ...previous, intents: { ...previous.intents, [line.invoiceLineItemId]: intent } }))} />
                  {tr(intent === "TAXABLE" ? "taxable" : "nonTaxable")}
                </label>)}
              </div>
              {fieldError ? <p id={errorId} className="text-xs text-[var(--qf-danger-text)]">{fieldError}</p> : null}
            </fieldset>;
          })}
        </fieldset>
        {dirty ? <p className="text-xs text-[var(--qf-text-muted)]">{tr("unsaved")}</p> : null}
      </> : null}
      <div className="flex flex-wrap gap-2">
        {source ? <Button type="button" className="min-h-11" loading={saving} disabled={loading || disabled || stale || needsReload || (!dirty && source.currentContext.current)} onClick={() => void save()}>{tr("save")}</Button> : null}
        <Button type="button" variant="outline" className="min-h-11" disabled={loading || saving || disabled} onClick={() => void load(dirty)}>{tr("reload")}</Button>
        <Button type="button" variant="ghost" className="min-h-11" disabled={saving} onClick={() => dirty ? setDiscardOpen(true) : close()}>{tr("close")}</Button>
      </div>
    </>}
    <ConfirmModal open={discardOpen} onClose={() => setDiscardOpen(false)} onConfirm={close} title={tr("discardTitle")} description={tr("discardDescription")} confirmLabel={tr("discard")} />
  </div>;
}
