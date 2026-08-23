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

export function openKody(detail: KodyOpenDetail) {
  window.dispatchEvent(new CustomEvent<KodyOpenDetail>(KODY_OPEN_EVENT, { detail }));
}

export function publishKodyOutcome(detail: KodyOutcomeDetail) {
  window.dispatchEvent(new CustomEvent<KodyOutcomeDetail>(KODY_OUTCOME_EVENT, { detail }));
}
