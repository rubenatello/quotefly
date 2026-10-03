import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, ApiError, type QuickBooksRecoveryEvent, type QuickBooksRecoveryEvents, type QuickBooksRecoveryReason, type QuickBooksStatusPayload } from "../../lib/api";
import { Alert, Button, Modal, ModalBody, ModalFooter, ModalHeader, Select } from "../ui";

type Props = {
  tenantId: string;
  canManage: boolean;
  status: QuickBooksStatusPayload;
  onAvailabilityChange: (count: number) => void;
};
const reasons: QuickBooksRecoveryReason[] = ["PROVIDER_RECOVERED", "CONNECTION_REAUTHORIZED", "MAPPING_CORRECTED"];
const typeKeys = { Invoice: "invoice", Payment: "payment", RefundReceipt: "refund", Unsupported: "other" } as const;
const definitiveRejections: Record<string, { status: number; copy: string }> = {
  QUICKBOOKS_MANAGER_REQUIRED: { status: 403, copy: "permissionChanged" },
  QUICKBOOKS_EVENT_NOT_FOUND: { status: 404, copy: "reviewAgain" },
  QUICKBOOKS_REPLAY_KEY_CONFLICT: { status: 409, copy: "reviewAgain" },
  QUICKBOOKS_EVENT_NOT_REPLAYABLE: { status: 409, copy: "reviewAgain" },
  QUICKBOOKS_CONNECTION_REVIEW_REQUIRED: { status: 409, copy: "reviewAgain" },
  QUICKBOOKS_REPLAY_DISABLED: { status: 503, copy: "disabled" },
};

/** Scope changes remount all request state, including an uncertain command identity. */
export function QuickBooksRecoveryPanel(props: Props) {
  if (!props.canManage || !props.tenantId) return null;
  const scope = `${props.tenantId}:${props.status.environment}:${props.status.connection?.connectedAtUtc ?? ""}:${props.status.connection?.status ?? ""}`;
  return <RecoveryPanel key={scope} {...props} />;
}

function RecoveryPanel({ status, onAvailabilityChange }: Props) {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState<QuickBooksRecoveryEvents | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<QuickBooksRecoveryEvent | null>(null);
  const [reason, setReason] = useState<QuickBooksRecoveryReason | "">("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const [pageHistory, setPageHistory] = useState<Array<string | null>>([null]);
  const [pageReset, setPageReset] = useState(false);
  const command = useRef<string | null>(null);
  const unresolvedCommands = useRef(new Map<string, { key: string; reason: QuickBooksRecoveryReason }>());
  const active = useRef(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const loadVersion = useRef(0);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const section = useRef<HTMLElement | null>(null);
  const enabled = status.providerWorkflowsEnabled && !status.oauthOnlyMode;
  const canReplay = enabled && data?.replayEnabled && status.setup.confirmed;

  const load = useCallback(async (cursor: string | null = null, history: Array<string | null> = [null]) => {
    if (!enabled) return;
    const version = ++loadVersion.current;
    setLoading(true);
    setLoadError(false);
    try {
      let result: QuickBooksRecoveryEvents;
      let reset = false;
      try {
        result = await api.integrations.quickbooks.recoveryEvents(cursor);
      } catch (error) {
        if (!active.current || version !== loadVersion.current) return;
        if (!cursor || !(error instanceof ApiError) || error.status !== 400 || error.code !== "QUICKBOOKS_RECOVERY_CURSOR_INVALID") throw error;
        result = await api.integrations.quickbooks.recoveryEvents();
        reset = true;
      }
      if (cursor && result.events.length === 0 && result.total > 0) {
        if (!active.current || version !== loadVersion.current) return;
        result = await api.integrations.quickbooks.recoveryEvents();
        reset = true;
      }
      if (!active.current || version !== loadVersion.current) return;
      const bounded = { ...result, events: result.events.slice(0, 25),
        total: Number.isSafeInteger(result.total) && result.total >= 0 ? result.total : result.events.length,
        hasMore: result.hasMore === true && typeof result.nextCursor === "string", nextCursor: result.nextCursor ?? null };
      setData(bounded);
      setPageHistory(reset ? [null] : history);
      setPageReset(reset);
      // Unsupported/deleted records still need a visible route to manual review.
      onAvailabilityChange(bounded.total);
    } catch {
      if (!active.current || version !== loadVersion.current) return;
      setLoadError(true);
    } finally {
      if (active.current && version === loadVersion.current) setLoading(false);
    }
  }, [enabled, onAvailabilityChange]);

  useEffect(() => {
    active.current = true;
    void load();
    return () => { active.current = false; loadVersion.current += 1; generation.current += 1; };
  }, [load]);

  function close() {
    if (inFlight.current) return;
    setSelected(null);
    setActionError(null);
    command.current = null;
    requestAnimationFrame(() => {
      if (active.current) (returnFocus.current?.isConnected ? returnFocus.current : section.current)?.focus();
    });
  }

  async function confirm() {
    if (!selected || !reason || !canReplay || inFlight.current) return;
    inFlight.current = true;
    command.current ??= crypto.randomUUID();
    unresolvedCommands.current.set(selected.id, { key: command.current, reason });
    const actionGeneration = generation.current;
    const isCurrent = () => active.current && generation.current === actionGeneration;
    setBusy(true);
    setActionError(null);
    try {
      await api.integrations.quickbooks.replayRecoveryEvent(selected.id, reason, command.current);
      if (!isCurrent()) return;
      unresolvedCommands.current.delete(selected.id);
      setQueued(true);
      setSelected(null);
      command.current = null;
      // Refresh can fail independently; the confirmed queued notice remains visible.
      await load();
      if (isCurrent()) section.current?.focus();
    } catch (error) {
      if (!isCurrent()) return;
      const rejection = error instanceof ApiError && error.code ? definitiveRejections[error.code] : undefined;
      if (error instanceof ApiError && rejection?.status === error.status) {
        // These structured API errors are returned before replay is committed.
        // A later corrected action needs a fresh reason and command identity.
        unresolvedCommands.current.delete(selected.id);
        command.current = null;
        setActionError(rejection.copy);
      } else {
        // An unrecognized/proxy 503 does not prove that the action failed.
        setActionError("uncertain");
      }
      // Preserve the exact reason and command on uncertain responses. A retry
      // asks for the result of this action rather than creating another replay.
    } finally {
      inFlight.current = false;
      // No other mutation can start while inFlight is held. Release the local
      // loading state even if enablement changed, without applying its result.
      if (active.current) setBusy(false);
    }
  }

  function dateLabel(value: string | null) {
    const date = value ? new Date(value) : null;
    return date && Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(date)
      : t("admin.quickBooksRecovery.dateUnknown");
  }

  return (
    <section ref={section} id="quickbooks-recovery" tabIndex={-1} aria-labelledby="quickbooks-recovery-title" className="border-t border-[var(--qf-border)] py-4 outline-none focus-visible:ring-2 focus-visible:ring-[var(--qf-focus)]">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h4 id="quickbooks-recovery-title" className="font-semibold text-[var(--qf-text)]">{t("admin.quickBooksRecovery.title")}</h4>
          <p className="mt-1 text-sm text-[var(--qf-text-soft)]">{t("admin.quickBooksRecovery.description")}</p>
        </div>
        {enabled && <Button variant="outline" className="min-h-11 sm:min-h-11" icon={<RefreshCw size={16} />} onClick={() => void load()} disabled={loading || busy}>{t("admin.quickBooksRecovery.refresh")}</Button>}
      </div>
      <div className="mt-3 space-y-3">
        {!enabled ? <Alert tone="info">{t(status.oauthOnlyMode ? "admin.quickBooksRecovery.oauthOnly" : "admin.quickBooksRecovery.disabled")}</Alert> : <>
          {queued && <div role="status"><Alert tone="success">{t("admin.quickBooksRecovery.queued")}</Alert></div>}
          {pageReset && <p role="status" className="text-sm text-[var(--qf-text-soft)]">{t("admin.quickBooksRecovery.pageReset")}</p>}
          {loadError && <Alert tone="error">{t("admin.quickBooksRecovery.loadError")}</Alert>}
          {loading && <p role="status" className="text-sm">{t("admin.quickBooksRecovery.loading")}</p>}
          {data && !data.replayEnabled && <Alert tone="info">{t("admin.quickBooksRecovery.disabled")}</Alert>}
          {data?.replayEnabled && !status.setup.confirmed && <Alert tone="info">{t("admin.quickBooksRecovery.setupRequired")}</Alert>}
          {data?.events.length === 0 && !loading && <p className="text-sm text-[var(--qf-text-soft)]">{t("admin.quickBooksRecovery.empty")}</p>}
          {data && data.events.length > 0 && <>
            <p className="text-xs text-[var(--qf-text-muted)]">{t("admin.quickBooksRecovery.pageSummary", { page: pageHistory.length, count: data.events.length, total: data.total })}</p>
            <ul className="divide-y divide-[var(--qf-border)]">
              {data.events.map((event) => <li key={event.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 text-sm">
                  <p className="font-semibold text-[var(--qf-text)]">{t(`admin.quickBooksRecovery.types.${typeKeys[event.type] ?? "other"}`)}</p>
                  <p className="text-[var(--qf-text-soft)]">{t(event.replaySupported ? "admin.quickBooksRecovery.needsReview" : "admin.quickBooksRecovery.manualReview")}</p>
                  <p className="mt-1 text-xs text-[var(--qf-text-muted)]">{dateLabel(event.deadAtUtc ?? event.receivedAtUtc)}</p>
                </div>
                {event.replaySupported && <Button variant="outline" className="min-h-11 sm:min-h-11" disabled={!canReplay || busy || loading} onClick={(click) => {
                  returnFocus.current = click.currentTarget;
                  const unresolved = unresolvedCommands.current.get(event.id);
                  setSelected(event); setReason(unresolved?.reason ?? ""); setActionError(unresolved ? "uncertain" : null); command.current = unresolved?.key ?? null;
                }}>{t("admin.quickBooksRecovery.review")}</Button>}
              </li>)}
            </ul>
          </>}
          {data && (pageHistory.length > 1 || data.hasMore) && <nav aria-label={t("admin.quickBooksRecovery.pagination")} className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--qf-border)] pt-3">
            <Button variant="outline" className="min-h-11 sm:min-h-11" disabled={loading || busy || pageHistory.length <= 1} onClick={() => {
              const history = pageHistory.slice(0, -1);
              void load(history.at(-1) ?? null, history).then(() => { if (active.current) section.current?.focus(); });
            }}>{t("admin.quickBooksRecovery.previous")}</Button>
            <Button variant="outline" className="min-h-11 sm:min-h-11" disabled={loading || busy || !data.hasMore || !data.nextCursor} onClick={() => {
              if (!data.nextCursor) return;
              void load(data.nextCursor, [...pageHistory, data.nextCursor]).then(() => { if (active.current) section.current?.focus(); });
            }}>{t("admin.quickBooksRecovery.next")}</Button>
          </nav>}
        </>}
      </div>
      <Modal open={selected !== null} onClose={close} closeOnBackdrop={!busy} ariaLabel={t("admin.quickBooksRecovery.confirmTitle")}>
        <ModalHeader title={t("admin.quickBooksRecovery.confirmTitle")} description={t("admin.quickBooksRecovery.confirmDescription")} onClose={busy ? undefined : close} />
        <ModalBody>
          <Select label={t("admin.quickBooksRecovery.reason")} value={reason} disabled={busy || command.current !== null} onChange={(event) => setReason(event.target.value as QuickBooksRecoveryReason)} options={[
            { value: "", label: t("admin.quickBooksRecovery.chooseReason") },
            ...reasons.filter((value) => data?.reasons.includes(value)).map((value) => ({ value, label: t(`admin.quickBooksRecovery.reasons.${value}`) })),
          ]} />
          {actionError && <div className="mt-3"><Alert tone="error">{t(`admin.quickBooksRecovery.${actionError}`)}</Alert></div>}
        </ModalBody>
        <ModalFooter>
          <Button variant="outline" className="min-h-11 sm:min-h-11" disabled={busy} onClick={close}>{t("common.cancel")}</Button>
          <Button className="min-h-11 sm:min-h-11" loading={busy} disabled={!reason || !canReplay} onClick={() => void confirm()}>{t(actionError ? "admin.quickBooksRecovery.retry" : "admin.quickBooksRecovery.confirm")}</Button>
        </ModalFooter>
      </Modal>
    </section>
  );
}
