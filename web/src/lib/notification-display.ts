import type { WorkspaceNotification, WorkspaceNotificationKind } from "./api";

export const NOTIFICATIONS_UPDATED_EVENT = "quotefly:notifications-updated";

export function publishNotificationsUpdated(createdCount: number): void {
  if (createdCount > 0) window.dispatchEvent(new CustomEvent(NOTIFICATIONS_UPDATED_EVENT));
}

const TITLE_KEYS: Record<WorkspaceNotificationKind, string> = {
  BOOKED: "notificationsCenter.kind.booked",
  RESCHEDULED: "notificationsCenter.kind.rescheduled",
  DISPATCHED: "notificationsCenter.kind.dispatched",
  ARRIVED: "notificationsCenter.kind.arrived",
  COMPLETED: "notificationsCenter.kind.completed",
  CANCELED: "notificationsCenter.kind.canceled",
};

export function notificationTitleKey(kind: WorkspaceNotificationKind): string {
  return TITLE_KEYS[kind];
}

export function notificationJobPath(jobId: string): string {
  return `/app/jobs/${encodeURIComponent(jobId)}`;
}

export function mergeNotificationPages(
  current: readonly WorkspaceNotification[],
  incoming: readonly WorkspaceNotification[],
): WorkspaceNotification[] {
  const byId = new Map(current.map((notification) => [notification.id, notification]));
  for (const notification of incoming) byId.set(notification.id, notification);
  return [...byId.values()].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
  );
}

export function formatNotificationWindow(
  notification: Pick<WorkspaceNotification, "startsAtUtc" | "endsAtUtc">,
  locale: string,
  timeZone: string,
): string {
  const startsAt = new Date(notification.startsAtUtc);
  const endsAt = new Date(notification.endsAtUtc);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) return "—";

  const date = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone,
  });
  const localDateKey = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  });
  const time = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
  if (localDateKey.format(startsAt) === localDateKey.format(endsAt)) {
    return `${date.format(startsAt)} · ${time.format(startsAt)}–${time.format(endsAt)}`;
  }
  return `${date.format(startsAt)} · ${time.format(startsAt)}–${date.format(endsAt)} · ${time.format(endsAt)}`;
}

/**
 * Always include the local calendar date. Relative labels such as “today”
 * become ambiguous in an inbox and can be wrong when the viewer is away from
 * the tenant timezone.
 */
export function formatNotificationReceivedAt(
  notification: Pick<WorkspaceNotification, "createdAt">,
  locale: string,
  timeZone: string,
): string {
  const createdAt = new Date(notification.createdAt);
  if (Number.isNaN(createdAt.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(createdAt);
}
