import type { AiAssistantContext, AiAssistantRequestedTool } from "../../lib/api";

export type KodyOpenDetail = {
  prompt: string;
  tool?: AiAssistantRequestedTool;
  context?: AiAssistantContext;
};

export const KODY_OPEN_EVENT = "quotefly:kody-open";
export const KODY_OUTCOME_EVENT = "quotefly:kody-outcome";

export type KodyBookingReviewDetail = {
  mode: "CREATE" | "RESCHEDULE";
  jobId: string;
  jobNumber: number;
  jobTitle: string;
  customerId: string;
  customerName: string;
  assignedTenantUserId: string;
  assigneeName: string;
  startsAtUtc: string;
  endsAtUtc: string;
  timeZone: string;
  appointmentId?: string;
  appointmentVersion?: number;
  expectedStatus?: "SCHEDULED";
};

export type KodyDispatchReviewDetail = {
  jobId: string;
  jobNumber: number;
  jobTitle: string;
  customerId: string;
  customerName: string;
  appointmentId: string;
  appointmentVersion: number;
  expectedStatus: "SCHEDULED";
  startsAtUtc: string;
  endsAtUtc: string;
  timeZone: string;
  assignedTenantUserId: string;
  assigneeName: string;
};

export type KodyOutcomeDetail =
  | { type: "CUSTOMER_CREATED"; customerName: string }
  | { type: "QUOTE_CREATED"; quoteTitle: string; customerName?: string }
  | { type: "QUOTE_MARKED_SENT"; quoteTitle: string; customerName: string }
  | { type: "BOOKING_CREATED"; jobNumber: number; customerName: string; startsAtUtc: string; inAppNotificationCreated: boolean }
  | { type: "BOOKING_RESCHEDULED"; jobNumber: number; customerName: string; startsAtUtc: string; inAppNotificationCreated: boolean }
  | { type: "BOOKING_DISPATCHED"; jobNumber: number; customerName: string; inAppNotificationCreated: boolean };

type KodyOpenIntent = {
  detail: KodyOpenDetail;
  origin: HTMLElement | null;
};

// The contextual launcher can render before the lazy assistant subscribes.
// Keep only the latest intent, in memory, until it is consumed or its workspace exits.
let pendingOpen: KodyOpenIntent | null = null;

function activeElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

export function clearPendingKodyOpen() {
  pendingOpen = null;
}

export function subscribeKodyOpen(listener: (intent: KodyOpenIntent) => void) {
  const handleOpen = (event: Event) => {
    const detail = (event as CustomEvent<KodyOpenDetail>).detail;
    if (!detail || typeof detail.prompt !== "string") return;
    const intent = pendingOpen?.detail === detail
      ? pendingOpen
      : { detail, origin: activeElement() };
    pendingOpen = null;
    listener(intent);
  };
  window.addEventListener(KODY_OPEN_EVENT, handleOpen);
  if (pendingOpen) {
    const intent = pendingOpen;
    pendingOpen = null;
    listener(intent);
  }
  return () => window.removeEventListener(KODY_OPEN_EVENT, handleOpen);
}

export function openKody(detail: KodyOpenDetail) {
  pendingOpen = { detail, origin: activeElement() };
  window.dispatchEvent(new CustomEvent<KodyOpenDetail>(KODY_OPEN_EVENT, { detail }));
}

export function publishKodyOutcome(detail: KodyOutcomeDetail) {
  window.dispatchEvent(new CustomEvent<KodyOutcomeDetail>(KODY_OUTCOME_EVENT, { detail }));
}
