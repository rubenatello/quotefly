import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Bell, BriefcaseBusiness, Check, CheckCheck, LoaderCircle, RotateCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Ref, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { api, type WorkspaceNotification } from "../../lib/api";
import {
  formatNotificationReceivedAt,
  formatNotificationWindow,
  mergeNotificationPages,
  NOTIFICATIONS_UPDATED_EVENT,
  notificationTitleKey,
} from "../../lib/notification-display";
import { cn } from "../../lib/utils";

const PAGE_SIZE = 25;
const SUMMARY_REFRESH_MS = 120_000;

export function NotificationBellButton({
  unreadCount,
  onClick,
  className,
  buttonRef,
}: {
  unreadCount: number;
  onClick: () => void;
  className?: string;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const { t } = useTranslation();
  const safeCount = Math.max(0, Math.floor(unreadCount));
  return (
    <button
      type="button"
      ref={buttonRef}
      onClick={onClick}
      aria-label={t("notificationsCenter.bellLabel", { count: safeCount })}
      className={cn(
        "relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] text-[var(--qf-text-soft)] transition hover:border-[var(--qf-border-strong)] hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]",
        className,
      )}
    >
      <Bell size={18} aria-hidden="true" />
      {safeCount > 0 ? (
        <span
          aria-hidden="true"
          className="absolute -right-1 -top-1 flex min-h-5 min-w-5 items-center justify-center rounded-full border-2 border-[var(--qf-panel)] bg-[var(--qf-danger-strong)] px-1 text-[10px] font-bold leading-none text-white"
        >
          {safeCount > 99 ? "99+" : safeCount}
        </span>
      ) : null}
    </button>
  );
}

function NotificationRow({
  notification,
  displayTimeZone,
  pending,
  onMarkRead,
  onOpenJob,
}: {
  notification: WorkspaceNotification;
  displayTimeZone: string;
  pending: boolean;
  onMarkRead: (notification: WorkspaceNotification) => void;
  onOpenJob: (jobId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const unread = notification.readAtUtc === null;
  const title = t(notificationTitleKey(notification.kind));
  return (
    <article
      data-notification-status={unread ? "unread" : "read"}
      className={cn(
        "rounded-2xl border p-4",
        unread
          ? "border-[var(--qf-focus)]/35 bg-[var(--qf-focus-ring)]"
          : "border-[var(--qf-border)] bg-[var(--qf-panel)]",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full",
            unread ? "bg-[var(--qf-action-primary)]" : "bg-[var(--qf-border-strong)]",
          )}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-[var(--qf-text)]">{title}</h3>
              <p className="mt-1 break-words text-sm text-[var(--qf-text-soft)]">
                {t("notificationsCenter.jobSummary", {
                  number: notification.job.jobNumber,
                  title: notification.job.title,
                  customer: notification.job.customer.fullName,
                })}
              </p>
              <p className="mt-1 text-xs font-medium text-[var(--qf-text-soft)]">
                {formatNotificationWindow(notification, i18n.resolvedLanguage ?? "en-US", displayTimeZone)}
              </p>
              <p className="mt-1 text-xs font-medium text-[var(--qf-text-soft)]">
                {t("notificationsCenter.receivedAt", {
                  time: formatNotificationReceivedAt(notification, i18n.resolvedLanguage ?? "en-US", displayTimeZone),
                })}
              </p>
            </div>
            {unread ? <span className="sr-only">{t("notificationsCenter.unread")}</span> : null}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onOpenJob(notification.job.id)}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[var(--qf-action-primary)] px-3 text-sm font-semibold text-[var(--qf-action-primary-text)] transition hover:bg-[var(--qf-action-primary-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]"
            >
              <BriefcaseBusiness size={16} aria-hidden="true" />
              {t("notificationsCenter.openJob")}
            </button>
            {unread ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => onMarkRead(notification)}
                aria-label={t("notificationsCenter.markReadLabel", { title })}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-3 text-sm font-semibold text-[var(--qf-text-soft)] transition hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] disabled:cursor-wait disabled:opacity-60"
              >
                {pending ? <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
                {t("notificationsCenter.markRead")}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </article>
  );
}

export function NotificationCenter({
  open,
  onOpenChange,
  displayTimeZone,
  onUnreadCountChange,
  onOpenJob,
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  displayTimeZone: string;
  onUnreadCountChange: (count: number) => void;
  onOpenJob: (jobId: string) => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [notifications, setNotifications] = useState<WorkspaceNotification[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [markingAll, setMarkingAll] = useState(false);
  const [knownUnreadCount, setKnownUnreadCount] = useState(0);
  const [unreadAnnouncement, setUnreadAnnouncement] = useState("");
  const requestGenerationRef = useRef(0);
  const summaryGenerationRef = useRef(0);
  const lastSummaryCountRef = useRef<number | null>(null);
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const refreshSummary = useCallback(async () => {
    const generation = summaryGenerationRef.current + 1;
    summaryGenerationRef.current = generation;
    try {
      const response = await api.notifications.summary();
      if (generation !== summaryGenerationRef.current) return;
      const nextCount = Math.max(0, response.unreadCount);
      if (lastSummaryCountRef.current !== null && lastSummaryCountRef.current !== nextCount) {
        setUnreadAnnouncement(t("notificationsCenter.countUpdated", { count: nextCount }));
      }
      lastSummaryCountRef.current = nextCount;
      setKnownUnreadCount(nextCount);
      onUnreadCountChange(nextCount);
    } catch {
      // A transient refresh failure must not erase a previously known count.
    }
  }, [onUnreadCountChange, t]);

  useEffect(() => {
    void refreshSummary();
    const refreshOnFocus = () => void refreshSummary();
    const intervalId = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshSummary();
    }, SUMMARY_REFRESH_MS);
    window.addEventListener("focus", refreshOnFocus);
    window.addEventListener(NOTIFICATIONS_UPDATED_EVENT, refreshOnFocus);
    return () => {
      summaryGenerationRef.current += 1;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshOnFocus);
      window.removeEventListener(NOTIFICATIONS_UPDATED_EVENT, refreshOnFocus);
    };
  }, [refreshSummary]);

  const loadPage = useCallback(async ({ append = false, cursor }: { append?: boolean; cursor?: string } = {}) => {
    const generation = append ? requestGenerationRef.current : requestGenerationRef.current + 1;
    if (!append) requestGenerationRef.current = generation;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(false);
    try {
      const response = await api.notifications.list({ filter: filterRef.current, limit: PAGE_SIZE, cursor });
      if (generation !== requestGenerationRef.current) return;
      setNotifications((current) => mergeNotificationPages(append ? current : [], response.items));
      setNextCursor(response.page.hasMore ? response.page.nextCursor : null);
    } catch {
      if (generation === requestGenerationRef.current) setError(true);
    } finally {
      if (generation === requestGenerationRef.current) {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!open) {
      requestGenerationRef.current += 1;
      setLoading(false);
      setLoadingMore(false);
      return;
    }
    void loadPage();
  }, [filter, loadPage, open]);

  const markRead = async (notification: WorkspaceNotification) => {
    if (pendingIds.has(notification.id)) return;
    setPendingIds((current) => new Set(current).add(notification.id));
    try {
      const response = await api.notifications.markRead(notification.id);
      setNotifications((current) => {
        const updated = filterRef.current === "unread"
          ? current.filter((item) => item.id !== notification.id)
          : current.map((item) => item.id === notification.id ? response.notification : item);
        return mergeNotificationPages([], updated);
      });
      await Promise.all([loadPage(), refreshSummary()]);
    } catch {
      setError(true);
    } finally {
      setPendingIds((current) => {
        const next = new Set(current);
        next.delete(notification.id);
        return next;
      });
    }
  };

  const markAllRead = async () => {
    if (markingAll) return;
    setMarkingAll(true);
    setError(false);
    try {
      const response = await api.notifications.markAllRead();
      setNotifications((current) => {
        if (filterRef.current === "unread") {
          return current.filter((notification) => notification.createdAt > response.cutoffAtUtc);
        }
        return current.map((notification) => notification.createdAt <= response.cutoffAtUtc ? {
          ...notification,
          readAtUtc: notification.readAtUtc ?? response.cutoffAtUtc,
        } : notification);
      });
      await Promise.all([loadPage(), refreshSummary()]);
    } catch {
      setError(true);
    } finally {
      setMarkingAll(false);
    }
  };

  const requestOpenJob = (jobId: string) => {
    onOpenJob(jobId);
  };
  const visibleUnreadCount = notifications.filter((notification) => notification.readAtUtc === null).length;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{unreadAnnouncement}</span>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[160] bg-[var(--qf-overlay)] backdrop-blur-sm motion-safe:animate-in motion-safe:fade-in motion-reduce:transition-none" />
        <DialogPrimitive.Content
          data-testid="notification-center"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocusRef.current?.focus();
          }}
          className="qf-theme-scope fixed inset-y-0 right-0 z-[170] flex w-full max-w-md flex-col overflow-hidden border-l border-[var(--qf-border)] bg-[var(--qf-panel)] text-[var(--qf-text)] shadow-[var(--qf-shadow-lg)] outline-none motion-safe:animate-in motion-safe:slide-in-from-right motion-reduce:transition-none"
        >
          <div className="border-b border-[var(--qf-border)] px-4 py-4 sm:px-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <DialogPrimitive.Title className="text-lg font-semibold text-[var(--qf-text)]">
                  {t("notificationsCenter.title")}
                </DialogPrimitive.Title>
                <DialogPrimitive.Description className="mt-1 text-sm text-[var(--qf-text-soft)]">
                  {t("notificationsCenter.description")}
                </DialogPrimitive.Description>
              </div>
              <DialogPrimitive.Close asChild>
                <button
                  type="button"
                  aria-label={t("notificationsCenter.close")}
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] text-[var(--qf-text-soft)] transition hover:bg-[var(--qf-interactive-hover)] hover:text-[var(--qf-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]"
                >
                  <X size={18} aria-hidden="true" />
                </button>
              </DialogPrimitive.Close>
            </div>
            <div className="mt-4 flex items-center justify-between gap-3">
              <div className="inline-flex rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel-muted)] p-1" role="group" aria-label={t("notificationsCenter.filterLabel")}>
                {(["all", "unread"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                    className={cn(
                      "min-h-11 rounded-lg px-3 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]",
                      filter === value
                        ? "bg-[var(--qf-panel)] text-[var(--qf-text)] shadow-sm"
                        : "text-[var(--qf-text-soft)] hover:text-[var(--qf-text)]",
                    )}
                  >
                    {t(`notificationsCenter.filter.${value}`)}
                  </button>
                ))}
              </div>
              <button
                type="button"
                disabled={markingAll || (knownUnreadCount === 0 && visibleUnreadCount === 0)}
                onClick={() => void markAllRead()}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl px-2 text-sm font-semibold text-[var(--qf-link)] transition hover:bg-[var(--qf-interactive-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {markingAll ? <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <CheckCheck size={16} aria-hidden="true" />}
                {t("notificationsCenter.markAllRead")}
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
            {error ? (
              <div role="alert" className="mb-4 rounded-2xl border border-[var(--qf-danger-border)] bg-[var(--qf-danger-surface)] p-4 text-sm text-[var(--qf-danger-text)]">
                <p>{t("notificationsCenter.error")}</p>
                <button
                  type="button"
                  onClick={() => void loadPage()}
                  className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl border border-current px-3 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)]"
                >
                  <RotateCw size={16} aria-hidden="true" />
                  {t("notificationsCenter.retry")}
                </button>
              </div>
            ) : null}

            {loading ? (
              <div role="status" className="flex min-h-40 items-center justify-center gap-2 text-sm text-[var(--qf-text-soft)]">
                <LoaderCircle size={18} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                {t("notificationsCenter.loading")}
              </div>
            ) : notifications.length === 0 && !error ? (
              <div className="flex min-h-56 flex-col items-center justify-center px-5 text-center">
                <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--qf-panel-muted)] text-[var(--qf-text-soft)]">
                  <Bell size={21} aria-hidden="true" />
                </span>
                <h3 className="mt-4 text-sm font-semibold text-[var(--qf-text)]">
                  {t(filter === "unread" ? "notificationsCenter.emptyUnread" : "notificationsCenter.empty")}
                </h3>
                <p className="mt-1 max-w-xs text-sm text-[var(--qf-text-soft)]">{t("notificationsCenter.emptyDescription")}</p>
              </div>
            ) : (
              <div className="space-y-3">
                {notifications.map((notification) => (
                  <NotificationRow
                    key={notification.id}
                    notification={notification}
                    displayTimeZone={displayTimeZone}
                    pending={pendingIds.has(notification.id)}
                    onMarkRead={(item) => void markRead(item)}
                    onOpenJob={requestOpenJob}
                  />
                ))}
              </div>
            )}

            {nextCursor && !loading ? (
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void loadPage({ append: true, cursor: nextCursor })}
                className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-[var(--qf-border)] bg-[var(--qf-panel)] px-4 text-sm font-semibold text-[var(--qf-text)] transition hover:bg-[var(--qf-interactive-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] disabled:cursor-wait disabled:opacity-60"
              >
                {loadingMore ? <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
                {loadingMore ? t("notificationsCenter.loadingMore") : t("notificationsCenter.loadMore")}
              </button>
            ) : null}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
