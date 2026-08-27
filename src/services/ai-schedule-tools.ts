import { type JobAppointmentStatus, type JobStatus, Prisma } from "@prisma/client";
import type { AccessContext } from "../lib/access-policy";
import { hasCapability } from "../lib/access-policy";
import {
  shiftTenantLocalDate,
  tenantLocalDateParts,
  tenantWallTimeToUtc,
  tenantWallTimeUtcCandidates,
} from "../lib/tenant-time";
import { visibleJobWhere, type JobTransaction } from "./jobs";

const ACTIVE_SCHEDULE_STATUSES: JobAppointmentStatus[] = ["SCHEDULED", "DISPATCHED", "ARRIVED"];
const ACTIVE_JOB_STATUSES: JobStatus[] = ["UNSCHEDULED", "SCHEDULED", "DISPATCHED", "IN_PROGRESS"];
const MAX_ASSISTANT_SCHEDULE_RESULTS = 8;
const MAX_BOOKING_OPENINGS = 3;
const MAX_BOOKING_SEARCH_DAYS = 7;
const MAX_BOOKING_CONFLICT_ROWS = 256;
const BOOKING_GRID_MINUTES = 30;

const AssistantScheduleSelect = {
  id: true,
  status: true,
  startsAtUtc: true,
  endsAtUtc: true,
  timeZone: true,
  version: true,
  assignedTenantUserId: true,
  assignedTenantUser: {
    select: {
      id: true,
      user: { select: { fullName: true } },
    },
  },
  job: {
    select: {
      id: true,
      jobNumber: true,
      status: true,
      title: true,
      customer: { select: { id: true, fullName: true } },
    },
  },
} as const satisfies Prisma.JobAppointmentSelect;

const AssistantJobSelect = {
  id: true,
  jobNumber: true,
  status: true,
  title: true,
  customerId: true,
  assignedTenantUserId: true,
  customer: { select: { id: true, fullName: true } },
  assignedTenantUser: {
    select: {
      id: true,
      deletedAtUtc: true,
      user: { select: { fullName: true, deletedAtUtc: true } },
    },
  },
} as const satisfies Prisma.JobSelect;

type AssistantJob = Prisma.JobGetPayload<{ select: typeof AssistantJobSelect }>;

export type AssistantScheduleRange = "TODAY" | "TOMORROW" | "WEEK" | "NEXT_7_DAYS";

export type AssistantScheduleItem = Readonly<{
  appointmentId: string;
  appointmentVersion: number;
  appointmentStatus: JobAppointmentStatus;
  startsAtUtc: string;
  endsAtUtc: string;
  timeZone: string;
  jobId: string;
  jobNumber: number;
  jobStatus: JobStatus;
  jobTitle: string;
  customerId: string;
  customerName: string;
  assignedTenantUserId: string;
  assigneeName: string;
}>;

export type AssistantBookingOption = Readonly<{
  startsAtUtc: string;
  endsAtUtc: string;
  offsetLabel: string;
  scheduleOpening?: boolean;
}>;

export type AssistantBookingPreview = Readonly<{
  outcome:
    | "READY"
    | "FORBIDDEN"
    | "JOB_NOT_FOUND"
    | "JOB_AMBIGUOUS"
    | "JOB_UNASSIGNED"
    | "MISSING_DATE"
    | "MISSING_TIME"
    | "MISSING_DURATION"
    | "MISSING_SEARCH_WINDOW"
    | "INVALID_LOCAL_TIME"
    | "PAST_TIME"
    | "SLOT_CONFLICT"
    | "NO_OPEN_SLOT"
    | "SCHEDULE_LIMIT_REACHED"
    | "ACTIVE_APPOINTMENT_LOCKED"
    | "APPOINTMENT_AMBIGUOUS";
  jobMatches: readonly AssistantJobSummary[];
  job: AssistantJobSummary | null;
  mode: "CREATE" | "RESCHEDULE" | null;
  appointmentId: string | null;
  appointmentVersion: number | null;
  timeZone: string;
  options: readonly AssistantBookingOption[];
  repeatedLocalTime: boolean;
  availabilitySearched?: boolean;
}>;

export type AssistantDispatchPreview = Readonly<{
  outcome: "READY" | "JOB_NOT_FOUND" | "JOB_AMBIGUOUS" | "APPOINTMENT_NOT_FOUND" | "APPOINTMENT_AMBIGUOUS";
  jobMatches: readonly AssistantJobSummary[];
  item: AssistantScheduleItem | null;
}>;

export type AssistantJobSummary = Readonly<{
  jobId: string;
  jobNumber: number;
  jobStatus: JobStatus;
  jobTitle: string;
  customerId: string;
  customerName: string;
  assignedTenantUserId: string | null;
  assigneeName: string | null;
}>;

function normalize(value: string) {
  return value.normalize("NFKD").replace(/\p{M}+/gu, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function localDateIso(date: Pick<ReturnType<typeof tenantLocalDateParts>, "year" | "month" | "day">) {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function utcMidnightForLocalDate(
  date: Pick<ReturnType<typeof tenantLocalDateParts>, "year" | "month" | "day">,
  timeZone: string,
) {
  return tenantWallTimeToUtc({ ...date, hour: 0, minute: 0 }, timeZone);
}

function scheduleWindow(message: string, now: Date, timeZone: string) {
  const normalized = normalize(message);
  const today = tenantLocalDateParts(now, timeZone);
  const todayDate = { year: today.year, month: today.month, day: today.day };
  let range: AssistantScheduleRange = "TODAY";
  let startDate = todayDate;
  let dayCount = 1;

  if (/\b(?:tomorrow|manana)\b/.test(normalized)) {
    range = "TOMORROW";
    startDate = shiftTenantLocalDate(todayDate, 1);
  } else if (/\b(?:next\s+7\s+days?|next\s+seven\s+days?|proximos?\s+7\s+dias?|siguientes?\s+7\s+dias?)\b/.test(normalized)) {
    range = "NEXT_7_DAYS";
    dayCount = 7;
  } else if (/\b(?:this\s+week|week\s+schedule|schedule\s+for\s+the\s+week|esta\s+semana|agenda\s+semanal)\b/.test(normalized)) {
    range = "WEEK";
    const weekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
    startDate = shiftTenantLocalDate(todayDate, weekday === 0 ? -6 : 1 - weekday);
    dayCount = 7;
  }

  const fromUtc = utcMidnightForLocalDate(startDate, timeZone);
  const toUtc = utcMidnightForLocalDate(shiftTenantLocalDate(startDate, dayCount), timeZone);
  if (!fromUtc || !toUtc) throw new Error("Tenant schedule window could not be resolved.");
  return { range, date: localDateIso(startDate), fromUtc, toUtc };
}

function explicitMine(message: string) {
  return /\b(?:my|mine|assigned\s+to\s+me|mi|mis|mio|mios|asignad[ao]s?\s+a\s+mi)\b/.test(normalize(message));
}

function scheduleItem(
  appointment: Prisma.JobAppointmentGetPayload<{ select: typeof AssistantScheduleSelect }>,
): AssistantScheduleItem {
  return {
    appointmentId: appointment.id,
    appointmentVersion: appointment.version,
    appointmentStatus: appointment.status,
    startsAtUtc: appointment.startsAtUtc.toISOString(),
    endsAtUtc: appointment.endsAtUtc.toISOString(),
    timeZone: appointment.timeZone,
    jobId: appointment.job.id,
    jobNumber: appointment.job.jobNumber,
    jobStatus: appointment.job.status,
    jobTitle: appointment.job.title,
    customerId: appointment.job.customer.id,
    customerName: appointment.job.customer.fullName,
    assignedTenantUserId: appointment.assignedTenantUserId,
    assigneeName: appointment.assignedTenantUser.user.fullName,
  };
}

export async function listAssistantSchedule(
  transaction: JobTransaction,
  access: AccessContext,
  params: { message: string; now: Date; timeZone: string; limit?: number },
) {
  const window = scheduleWindow(params.message, params.now, params.timeZone);
  const mine = !hasCapability(access, "viewAllWorkspaceRecords") || explicitMine(params.message);
  const limit = Math.min(Math.max(Math.trunc(params.limit ?? MAX_ASSISTANT_SCHEDULE_RESULTS), 1), MAX_ASSISTANT_SCHEDULE_RESULTS);
  const appointments = await transaction.jobAppointment.findMany({
    where: {
      tenantId: access.tenantId,
      deletedAtUtc: null,
      status: { in: ACTIVE_SCHEDULE_STATUSES },
      startsAtUtc: { lt: window.toUtc },
      endsAtUtc: { gt: window.fromUtc },
      ...(mine ? { assignedTenantUserId: access.tenantUserId } : {}),
      job: visibleJobWhere(access),
    },
    select: AssistantScheduleSelect,
    orderBy: [{ startsAtUtc: "asc" }, { id: "asc" }],
    take: limit + 1,
  });
  return {
    ...window,
    timeZone: params.timeZone,
    mine,
    hasMore: appointments.length > limit,
    items: appointments.slice(0, limit).map(scheduleItem),
  };
}

function summarizeJob(job: AssistantJob): AssistantJobSummary {
  return {
    jobId: job.id,
    jobNumber: job.jobNumber,
    jobStatus: job.status,
    jobTitle: job.title,
    customerId: job.customer.id,
    customerName: job.customer.fullName,
    assignedTenantUserId: job.assignedTenantUserId,
    assigneeName: job.assignedTenantUser?.user.fullName ?? null,
  };
}

const JOB_SEARCH_STOP_WORDS = new Set([
  "a", "additional", "appointment", "at", "book", "booking", "cita", "con", "create", "crear", "de", "dispatch",
  "despacha", "despachar", "el", "for", "from", "hoy", "hours", "hour", "job", "la", "las", "manana", "minutes",
  "me", "mi", "mine", "minute", "my", "new", "next", "on", "otra", "para", "por", "proximo", "programa", "programar", "reagenda", "reschedule", "schedule",
  "scheduled", "the", "to", "trabajo", "una", "visit", "visita", "with",
]);

function jobNumberFromMessage(message: string) {
  const match = normalize(message).match(/(?:\b(?:job|trabajo)\s*(?:number|numero|no\.?|#)?\s*|\bj[-\s]*|#)(\d{1,9})\b/);
  if (!match?.[1]) return null;
  const jobNumber = Number(match[1]);
  return Number.isSafeInteger(jobNumber) ? jobNumber : null;
}

function jobSearchTokens(message: string, contextSearch?: string) {
  const source = contextSearch?.trim() || message;
  return normalize(source)
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, " ")
    .replace(/\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?\b/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2 && !JOB_SEARCH_STOP_WORDS.has(token))
    .slice(0, 6);
}

async function resolveVisibleJobs(
  transaction: JobTransaction,
  access: AccessContext,
  params: { message: string; jobId?: string; quoteId?: string; search?: string },
) {
  const baseWhere: Prisma.JobWhereInput = {
    ...visibleJobWhere(access),
    status: { in: ACTIVE_JOB_STATUSES },
  };
  const contextJobId = params.jobId?.trim();
  if (contextJobId) {
    const job = await transaction.job.findFirst({
      where: { ...baseWhere, id: contextJobId },
      select: AssistantJobSelect,
    });
    return job ? [job] : [];
  }
  const contextQuoteId = params.quoteId?.trim();
  if (contextQuoteId) {
    const job = await transaction.job.findFirst({
      where: { ...baseWhere, sourceQuoteId: contextQuoteId },
      select: AssistantJobSelect,
    });
    return job ? [job] : [];
  }
  const jobNumber = jobNumberFromMessage(params.message);
  if (jobNumber !== null) {
    const job = await transaction.job.findFirst({
      where: { ...baseWhere, jobNumber },
      select: AssistantJobSelect,
    });
    return job ? [job] : [];
  }
  const tokens = jobSearchTokens(params.message, params.search);
  if (!tokens.length) return [];
  return transaction.job.findMany({
    where: {
      ...baseWhere,
      AND: tokens.map((token) => ({
        OR: [
          { title: { contains: token, mode: "insensitive" } },
          { customer: { fullName: { contains: token, mode: "insensitive" } } },
        ],
      })),
    },
    select: AssistantJobSelect,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 4,
  });
}

type LocalDay = Pick<ReturnType<typeof tenantLocalDateParts>, "year" | "month" | "day">;
type ClockTime = Readonly<{ hour: number; minute: number }>;
const DURATION_AMOUNT_TOKEN = "(?:\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)";
const DURATION_WORD_AMOUNTS: Readonly<Record<string, number>> = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
});

function explicitDurationMinutes(message: string, minimumMinutes: number) {
  const normalized = normalize(message);
  const match = new RegExp(
    `\\b(?:(?:for|during|lasting|takes?|duration(?:\\s+of)?|durante|por|dura|duracion(?:\\s+de)?|a|un|una)\\s+)?(${DURATION_AMOUNT_TOKEN})\\s*[- ]?\\s*(hours?|hrs?|minutes?|mins?|horas?|minutos?)\\b`,
    "i",
  ).exec(normalized);
  if (!match?.[1] || !match[2]) return null;
  const token = match[1].toLowerCase();
  const amount = Number.isFinite(Number(token)) ? Number(token) : DURATION_WORD_AMOUNTS[token];
  if (!amount) return null;
  const minutes = /^(?:hours?|hrs?|horas?)$/i.test(match[2]) ? Math.round(amount * 60) : Math.round(amount);
  return Number.isFinite(minutes) && minutes >= minimumMinutes && minutes <= 14 * 24 * 60 ? minutes : null;
}

function validLocalDay(year: number, month: number, day: number): LocalDay | null {
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() + 1 !== month || value.getUTCDate() !== day) return null;
  return { year, month, day };
}

function bookingDate(message: string, now: Date, timeZone: string): LocalDay | null {
  const normalized = normalize(message);
  const today = tenantLocalDateParts(now, timeZone);
  const current = { year: today.year, month: today.month, day: today.day };
  if (/\b(?:tomorrow|manana)\b/.test(normalized)) return shiftTenantLocalDate(current, 1);
  if (/\b(?:today|hoy)\b/.test(normalized)) return current;
  const iso = normalized.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso?.[1] && iso[2] && iso[3]) return validLocalDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const weekday = normalized.match(/\b(?:(next|proximo|proxima)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|domingo|lunes|martes|miercoles|jueves|viernes|sabado)\b/);
  if (weekday?.[2]) {
    const weekdayNumber: Record<string, number> = {
      sunday: 0, domingo: 0,
      monday: 1, lunes: 1,
      tuesday: 2, martes: 2,
      wednesday: 3, miercoles: 3,
      thursday: 4, jueves: 4,
      friday: 5, viernes: 5,
      saturday: 6, sabado: 6,
    };
    const target = weekdayNumber[weekday[2]];
    if (target !== undefined) {
      const currentWeekday = new Date(Date.UTC(current.year, current.month - 1, current.day)).getUTCDay();
      let dayOffset = (target - currentWeekday + 7) % 7;
      if (weekday[1] && dayOffset === 0) dayOffset = 7;
      return shiftTenantLocalDate(current, dayOffset);
    }
  }
  const slash = normalized.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (!slash?.[1] || !slash[2]) return null;
  let year = slash[3] ? Number(slash[3]) : today.year;
  if (year < 100) year += 2000;
  return validLocalDay(year, Number(slash[1]), Number(slash[2]));
}

function clockTime(hourText: string | undefined, minuteText: string | undefined, meridiemText: string | undefined) {
  if (!hourText) return null;
  const rawHour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;
  const meridiem = meridiemText?.replace(/[.\s]/g, "").toLowerCase();
  if (!Number.isInteger(rawHour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (meridiem === "am" || meridiem === "pm") {
    if (rawHour < 1 || rawHour > 12) return null;
    return { hour: meridiem === "am" ? (rawHour === 12 ? 0 : rawHour) : (rawHour === 12 ? 12 : rawHour + 12), minute };
  }
  if (rawHour < 0 || rawHour > 23 || (rawHour >= 1 && rawHour <= 12)) return null;
  return { hour: rawHour, minute };
}

function bookingTimes(message: string):
  | Readonly<{ start: ClockTime; end: ClockTime | null; durationMinutes: number | null }>
  | null {
  const normalized = normalize(message);
  const token = "(\\d{1,2})(?::(\\d{2}))?\\s*(a\\.?\\s*m\\.?|p\\.?\\s*m\\.?)?";
  const range = new RegExp(`\\b(?:from|de(?:\\s+las)?)\\s+${token}\\s+(?:to|until|hasta|a)\\s+${token}\\b`, "i").exec(normalized);
  if (range) {
    // A 1–12 hour is ambiguous without its own meridiem. Do not infer one
    // endpoint's AM/PM from the other: "11 PM to 1" and "11 to 1 AM" can
    // represent materially different visits.
    const start = clockTime(range[1], range[2], range[3]);
    const end = clockTime(range[4], range[5], range[6]);
    return start && end ? { start, end, durationMinutes: null } : null;
  }
  const startMatch = new RegExp(`\\b(?:at|@|a\\s+las?)\\s+${token}\\b`, "i").exec(normalized);
  const durationMinutes = explicitDurationMinutes(normalized, 1);
  if (!startMatch || !durationMinutes) return null;
  const start = clockTime(startMatch[1], startMatch[2], startMatch[3]);
  if (!start) return null;
  return { start, end: null, durationMinutes };
}

function offsetLabel(value: Date, timeZone: string) {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
    .formatToParts(value)
    .find((item) => item.type === "timeZoneName")?.value;
  return part ?? "UTC";
}

function bookingOptions(
  message: string,
  now: Date,
  timeZone: string,
): { outcome: "READY" | "MISSING_DATE" | "MISSING_TIME" | "INVALID_LOCAL_TIME" | "PAST_TIME"; options: AssistantBookingOption[]; repeatedLocalTime: boolean } {
  const date = bookingDate(message, now, timeZone);
  if (!date) return { outcome: "MISSING_DATE", options: [], repeatedLocalTime: false };
  const times = bookingTimes(message);
  if (!times) return { outcome: "MISSING_TIME", options: [], repeatedLocalTime: false };
  const starts = tenantWallTimeUtcCandidates({ ...date, ...times.start }, timeZone);
  if (!starts.length) return { outcome: "INVALID_LOCAL_TIME", options: [], repeatedLocalTime: false };

  let pairs: Array<{ start: Date; end: Date }> = [];
  if (times.durationMinutes !== null) {
    pairs = starts.map((start) => ({ start, end: new Date(start.getTime() + times.durationMinutes! * 60_000) }));
  } else if (times.end) {
    const startMinutes = times.start.hour * 60 + times.start.minute;
    const endMinutes = times.end.hour * 60 + times.end.minute;
    const endDate = endMinutes <= startMinutes ? shiftTenantLocalDate(date, 1) : date;
    const ends = tenantWallTimeUtcCandidates({ ...endDate, ...times.end }, timeZone);
    if (!ends.length) return { outcome: "INVALID_LOCAL_TIME", options: [], repeatedLocalTime: false };
    if (starts.length === ends.length && starts.length > 1) {
      pairs = starts.map((start, index) => ({ start, end: ends[index]! }));
    } else {
      pairs = starts.flatMap((start) => ends.map((end) => ({ start, end })));
    }
  }

  const unique = new Map<string, AssistantBookingOption>();
  for (const pair of pairs) {
    const duration = pair.end.getTime() - pair.start.getTime();
    if (duration <= 0 || duration > 14 * 24 * 60 * 60 * 1_000) continue;
    const key = `${pair.start.toISOString()}|${pair.end.toISOString()}`;
    unique.set(key, {
      startsAtUtc: pair.start.toISOString(),
      endsAtUtc: pair.end.toISOString(),
      offsetLabel: offsetLabel(pair.start, timeZone),
    });
  }
  const options = Array.from(unique.values()).sort((left, right) => left.startsAtUtc.localeCompare(right.startsAtUtc)).slice(0, 2);
  if (!options.length) return { outcome: "INVALID_LOCAL_TIME", options: [], repeatedLocalTime: false };
  if (options.every((option) => new Date(option.endsAtUtc) <= now)) {
    return { outcome: "PAST_TIME", options: [], repeatedLocalTime: false };
  }
  return { outcome: "READY", options, repeatedLocalTime: options.length > 1 };
}

function requestsOpenSchedule(message: string) {
  const normalized = normalize(message);
  return /\b(?:open|openings?|available|availability|free|gaps?|slots?|abiertos?|abiertas?|disponibles?|disponibilidad|libres?|huecos?|espacios?)\b/.test(normalized)
    || /\b(?:when|cuando)\b.{0,96}\b(?:fit|cabe)\b/.test(normalized)
    || /\b(?:find|can\b.{0,24}\bfind)\s+(?:an?\s+)?time\s+for\b/.test(normalized)
    || /\b(?:buscar|busca|puede\b.{0,24}\bencontrar)\s+(?:una?\s+)?hora\s+para\b/.test(normalized);
}

function availabilityDurationMinutes(message: string) {
  return explicitDurationMinutes(message, BOOKING_GRID_MINUTES);
}

function availabilityDays(message: string, now: Date, timeZone: string): LocalDay[] | null {
  const normalized = normalize(message);
  const today = tenantLocalDateParts(now, timeZone);
  const current = { year: today.year, month: today.month, day: today.day };
  let dayCount = 1;
  let start = bookingDate(message, now, timeZone);

  if (/\b(?:next\s+7\s+days?|next\s+seven\s+days?|proximos?\s+7\s+dias?|siguientes?\s+7\s+dias?)\b/.test(normalized)) {
    start = current;
    dayCount = MAX_BOOKING_SEARCH_DAYS;
  } else if (/\b(?:this\s+week|esta\s+semana)\b/.test(normalized)) {
    start = current;
    const weekday = new Date(Date.UTC(current.year, current.month - 1, current.day)).getUTCDay();
    dayCount = Math.min(weekday === 0 ? 1 : 8 - weekday, MAX_BOOKING_SEARCH_DAYS);
  }
  if (!start) return null;
  return Array.from({ length: dayCount }, (_, index) => shiftTenantLocalDate(start!, index));
}

function availabilityDailyWindow(message: string): { start: ClockTime; end: ClockTime } | null {
  const normalized = normalize(message);
  const token = "(\\d{1,2})(?::(\\d{2}))?\\s*(a\\.?\\s*m\\.?|p\\.?\\s*m\\.?)?";
  const match = new RegExp(`\\b(?:between|entre)\\s+${token}\\s+(?:and|y)\\s+${token}\\b`, "i").exec(normalized)
    ?? new RegExp(`\\b(?:from|de(?:\\s+las?)?)\\s+${token}\\s+(?:to|until|hasta|a)\\s+${token}\\b`, "i").exec(normalized);
  if (!match) return null;
  const start = clockTime(match[1], match[2], match[3]);
  const end = clockTime(match[4], match[5], match[6]);
  if (!start || !end || end.hour * 60 + end.minute <= start.hour * 60 + start.minute) return null;
  return { start, end };
}

type BookingSearchWindow = Readonly<{ startsAtUtc: Date; endsAtUtc: Date }>;

function availabilityWindows(
  message: string,
  now: Date,
  timeZone: string,
):
  | Readonly<{ outcome: "READY"; durationMinutes: number; windows: readonly BookingSearchWindow[] }>
  | Readonly<{ outcome: "MISSING_DATE" | "MISSING_DURATION" | "MISSING_SEARCH_WINDOW" | "INVALID_LOCAL_TIME"; durationMinutes: null; windows: readonly [] }> {
  const days = availabilityDays(message, now, timeZone);
  if (!days) return { outcome: "MISSING_DATE", durationMinutes: null, windows: [] };
  const durationMinutes = availabilityDurationMinutes(message);
  if (!durationMinutes) return { outcome: "MISSING_DURATION", durationMinutes: null, windows: [] };
  const dailyWindow = availabilityDailyWindow(message);
  if (!dailyWindow) return { outcome: "MISSING_SEARCH_WINDOW", durationMinutes: null, windows: [] };

  const windows: BookingSearchWindow[] = [];
  for (const day of days.slice(0, MAX_BOOKING_SEARCH_DAYS)) {
    const starts = tenantWallTimeUtcCandidates({ ...day, ...dailyWindow.start }, timeZone);
    const ends = tenantWallTimeUtcCandidates({ ...day, ...dailyWindow.end }, timeZone);
    if (!starts.length || !ends.length) {
      return { outcome: "INVALID_LOCAL_TIME", durationMinutes: null, windows: [] };
    }
    const startsAtUtc = starts[0]!;
    const endsAtUtc = ends[ends.length - 1]!;
    if (endsAtUtc <= startsAtUtc || endsAtUtc.getTime() - startsAtUtc.getTime() < durationMinutes * 60_000) continue;
    windows.push({ startsAtUtc, endsAtUtc });
  }
  return windows.length
    ? { outcome: "READY", durationMinutes, windows }
    : { outcome: "INVALID_LOCAL_TIME", durationMinutes: null, windows: [] };
}

type AppointmentConflict = Readonly<{ id: string; startsAtUtc: Date; endsAtUtc: Date }>;

async function bookingConflicts(
  transaction: JobTransaction,
  params: {
    tenantId: string;
    assignedTenantUserId: string;
    fromUtc: Date;
    toUtc: Date;
    excludeAppointmentId?: string | null;
  },
) {
  const rows = await transaction.jobAppointment.findMany({
    where: {
      tenantId: params.tenantId,
      assignedTenantUserId: params.assignedTenantUserId,
      deletedAtUtc: null,
      status: { in: ACTIVE_SCHEDULE_STATUSES },
      startsAtUtc: { lt: params.toUtc },
      endsAtUtc: { gt: params.fromUtc },
      ...(params.excludeAppointmentId ? { id: { not: params.excludeAppointmentId } } : {}),
    },
    select: { id: true, startsAtUtc: true, endsAtUtc: true },
    orderBy: [{ startsAtUtc: "asc" }, { id: "asc" }],
    take: MAX_BOOKING_CONFLICT_ROWS + 1,
  });
  return {
    conflicts: rows.slice(0, MAX_BOOKING_CONFLICT_ROWS) as AppointmentConflict[],
    limitReached: rows.length > MAX_BOOKING_CONFLICT_ROWS,
  };
}

function overlapsConflict(startsAtUtc: Date, endsAtUtc: Date, conflicts: readonly AppointmentConflict[]) {
  return conflicts.some((conflict) => conflict.startsAtUtc < endsAtUtc && conflict.endsAtUtc > startsAtUtc);
}

async function openBookingOptions(
  transaction: JobTransaction,
  params: {
    tenantId: string;
    assignedTenantUserId: string;
    message: string;
    now: Date;
    timeZone: string;
    excludeAppointmentId?: string | null;
  },
): Promise<Readonly<{ outcome: "READY" | "MISSING_DATE" | "MISSING_DURATION" | "MISSING_SEARCH_WINDOW" | "INVALID_LOCAL_TIME" | "NO_OPEN_SLOT" | "SCHEDULE_LIMIT_REACHED"; options: readonly AssistantBookingOption[] }>> {
  const search = availabilityWindows(params.message, params.now, params.timeZone);
  if (search.outcome !== "READY") return { outcome: search.outcome, options: [] };
  const overallFromUtc = search.windows[0]!.startsAtUtc;
  const overallToUtc = search.windows[search.windows.length - 1]!.endsAtUtc;
  const conflictResult = await bookingConflicts(transaction, {
    tenantId: params.tenantId,
    assignedTenantUserId: params.assignedTenantUserId,
    fromUtc: overallFromUtc,
    toUtc: overallToUtc,
    excludeAppointmentId: params.excludeAppointmentId,
  });
  if (conflictResult.limitReached) return { outcome: "SCHEDULE_LIMIT_REACHED", options: [] };

  const gridMs = BOOKING_GRID_MINUTES * 60_000;
  const durationMs = search.durationMinutes * 60_000;
  const options: AssistantBookingOption[] = [];
  for (const window of search.windows) {
    const earliest = Math.max(window.startsAtUtc.getTime(), params.now.getTime());
    let candidateStartMs = Math.ceil(earliest / gridMs) * gridMs;
    while (candidateStartMs + durationMs <= window.endsAtUtc.getTime() && options.length < MAX_BOOKING_OPENINGS) {
      const startsAtUtc = new Date(candidateStartMs);
      const endsAtUtc = new Date(candidateStartMs + durationMs);
      if (!overlapsConflict(startsAtUtc, endsAtUtc, conflictResult.conflicts)) {
        options.push({
          startsAtUtc: startsAtUtc.toISOString(),
          endsAtUtc: endsAtUtc.toISOString(),
          offsetLabel: offsetLabel(startsAtUtc, params.timeZone),
          scheduleOpening: true,
        });
      }
      candidateStartMs += gridMs;
    }
    if (options.length >= MAX_BOOKING_OPENINGS) break;
  }
  return options.length ? { outcome: "READY", options } : { outcome: "NO_OPEN_SLOT", options: [] };
}

async function removeConflictingRequestedOptions(
  transaction: JobTransaction,
  params: {
    tenantId: string;
    assignedTenantUserId: string;
    options: readonly AssistantBookingOption[];
    excludeAppointmentId?: string | null;
  },
) {
  if (!params.options.length) return { outcome: "READY" as const, options: params.options };
  const starts = params.options.map((option) => new Date(option.startsAtUtc));
  const ends = params.options.map((option) => new Date(option.endsAtUtc));
  const conflictResult = await bookingConflicts(transaction, {
    tenantId: params.tenantId,
    assignedTenantUserId: params.assignedTenantUserId,
    fromUtc: new Date(Math.min(...starts.map((value) => value.getTime()))),
    toUtc: new Date(Math.max(...ends.map((value) => value.getTime()))),
    excludeAppointmentId: params.excludeAppointmentId,
  });
  if (conflictResult.limitReached) return { outcome: "SCHEDULE_LIMIT_REACHED" as const, options: [] };
  const options = params.options.filter((option) => !overlapsConflict(
    new Date(option.startsAtUtc),
    new Date(option.endsAtUtc),
    conflictResult.conflicts,
  ));
  return options.length ? { outcome: "READY" as const, options } : { outcome: "SLOT_CONFLICT" as const, options: [] };
}

function explicitAdditionalVisit(message: string) {
  return /\b(?:additional|another|second|new)\s+visit\b|\b(?:visita\s+adicional|otra\s+visita|segunda\s+visita|nueva\s+visita)\b/.test(normalize(message));
}

export async function prepareAssistantBooking(
  transaction: JobTransaction,
  access: AccessContext,
  params: { message: string; now: Date; timeZone: string; jobId?: string; quoteId?: string; search?: string },
): Promise<AssistantBookingPreview> {
  if (!hasCapability(access, "manageAssignments")) {
    return { outcome: "FORBIDDEN", jobMatches: [], job: null, mode: null, appointmentId: null, appointmentVersion: null, timeZone: params.timeZone, options: [], repeatedLocalTime: false };
  }
  const jobs = await resolveVisibleJobs(transaction, access, params);
  const jobMatches = jobs.map(summarizeJob);
  if (!jobs.length) {
    return { outcome: "JOB_NOT_FOUND", jobMatches, job: null, mode: null, appointmentId: null, appointmentVersion: null, timeZone: params.timeZone, options: [], repeatedLocalTime: false };
  }
  if (jobs.length !== 1) {
    return { outcome: "JOB_AMBIGUOUS", jobMatches, job: null, mode: null, appointmentId: null, appointmentVersion: null, timeZone: params.timeZone, options: [], repeatedLocalTime: false };
  }
  const job = jobs[0]!;
  const jobSummary = summarizeJob(job);
  if (!job.assignedTenantUserId || !job.assignedTenantUser || job.assignedTenantUser.deletedAtUtc || job.assignedTenantUser.user.deletedAtUtc) {
    return { outcome: "JOB_UNASSIGNED", jobMatches, job: jobSummary, mode: null, appointmentId: null, appointmentVersion: null, timeZone: params.timeZone, options: [], repeatedLocalTime: false };
  }
  const activeAppointments = await transaction.jobAppointment.findMany({
    where: {
      tenantId: access.tenantId,
      jobId: job.id,
      deletedAtUtc: null,
      status: { in: ACTIVE_SCHEDULE_STATUSES },
    },
    select: { id: true, version: true, status: true },
    orderBy: [{ startsAtUtc: "asc" }, { id: "asc" }],
    take: 3,
  });
  const additionalVisit = explicitAdditionalVisit(params.message);
  const locked = activeAppointments.some((appointment) => appointment.status === "DISPATCHED" || appointment.status === "ARRIVED");
  if (!additionalVisit && locked) {
    return { outcome: "ACTIVE_APPOINTMENT_LOCKED", jobMatches, job: jobSummary, mode: null, appointmentId: null, appointmentVersion: null, timeZone: params.timeZone, options: [], repeatedLocalTime: false };
  }
  const scheduled = activeAppointments.filter((appointment) => appointment.status === "SCHEDULED");
  if (!additionalVisit && scheduled.length > 1) {
    return { outcome: "APPOINTMENT_AMBIGUOUS", jobMatches, job: jobSummary, mode: null, appointmentId: null, appointmentVersion: null, timeZone: params.timeZone, options: [], repeatedLocalTime: false };
  }
  const existing = additionalVisit ? null : scheduled[0] ?? null;
  const base = {
    jobMatches,
    job: jobSummary,
    mode: existing ? "RESCHEDULE" as const : "CREATE" as const,
    appointmentId: existing?.id ?? null,
    appointmentVersion: existing?.version ?? null,
    timeZone: params.timeZone,
  };
  if (requestsOpenSchedule(params.message)) {
    const availability = await openBookingOptions(transaction, {
      tenantId: access.tenantId,
      assignedTenantUserId: job.assignedTenantUserId,
      message: params.message,
      now: params.now,
      timeZone: params.timeZone,
      excludeAppointmentId: existing?.id,
    });
    if (availability.outcome !== "READY") {
      return {
        ...base,
        outcome: availability.outcome,
        options: [],
        repeatedLocalTime: false,
        availabilitySearched: true,
      };
    }
    return {
      ...base,
      outcome: "READY",
      options: availability.options,
      repeatedLocalTime: false,
      availabilitySearched: true,
    };
  }

  const parsed = bookingOptions(params.message, params.now, params.timeZone);
  if (parsed.outcome !== "READY") {
    return { ...base, outcome: parsed.outcome, mode: null, appointmentId: null, appointmentVersion: null, options: [], repeatedLocalTime: false };
  }
  const conflictChecked = await removeConflictingRequestedOptions(transaction, {
    tenantId: access.tenantId,
    assignedTenantUserId: job.assignedTenantUserId,
    options: parsed.options,
    excludeAppointmentId: existing?.id,
  });
  if (conflictChecked.outcome !== "READY") {
    return { ...base, outcome: conflictChecked.outcome, options: [], repeatedLocalTime: false };
  }
  return {
    ...base,
    outcome: "READY",
    options: conflictChecked.options,
    repeatedLocalTime: conflictChecked.options.length > 1,
  };
}

export async function prepareAssistantDispatch(
  transaction: JobTransaction,
  access: AccessContext,
  params: { message: string; now: Date; jobId?: string; appointmentId?: string; search?: string },
): Promise<AssistantDispatchPreview> {
  const mine = !hasCapability(access, "viewAllWorkspaceRecords") || explicitMine(params.message);
  const appointmentId = params.appointmentId?.trim();
  const nextRequested = /\b(?:next(?:\s+(?:job|appointment|visit))?|proximo(?:\s+(?:trabajo|cita|visita))?|siguiente(?:\s+(?:trabajo|cita|visita))?)\b/.test(normalize(params.message));
  if (appointmentId || (nextRequested && !params.jobId && jobNumberFromMessage(params.message) === null)) {
    const appointment = await transaction.jobAppointment.findFirst({
      where: {
        tenantId: access.tenantId,
        deletedAtUtc: null,
        status: "SCHEDULED",
        ...(appointmentId ? { id: appointmentId } : { endsAtUtc: { gt: params.now } }),
        ...(mine ? { assignedTenantUserId: access.tenantUserId } : {}),
        job: visibleJobWhere(access),
      },
      select: AssistantScheduleSelect,
      orderBy: [{ startsAtUtc: "asc" }, { id: "asc" }],
    });
    return appointment
      ? { outcome: "READY", jobMatches: [], item: scheduleItem(appointment) }
      : { outcome: "APPOINTMENT_NOT_FOUND", jobMatches: [], item: null };
  }
  const jobs = await resolveVisibleJobs(transaction, access, params);
  const jobMatches = jobs.map(summarizeJob);
  if (!jobs.length) return { outcome: "JOB_NOT_FOUND", jobMatches, item: null };
  if (jobs.length !== 1) return { outcome: "JOB_AMBIGUOUS", jobMatches, item: null };
  const job = jobs[0]!;
  const appointments = await transaction.jobAppointment.findMany({
    where: {
      tenantId: access.tenantId,
      jobId: job.id,
      deletedAtUtc: null,
      status: "SCHEDULED",
      ...(appointmentId ? { id: appointmentId } : {}),
      ...(!hasCapability(access, "viewAllWorkspaceRecords") ? { assignedTenantUserId: access.tenantUserId } : {}),
    },
    select: AssistantScheduleSelect,
    orderBy: [{ startsAtUtc: "asc" }, { id: "asc" }],
    take: 3,
  });
  if (!appointments.length) return { outcome: "APPOINTMENT_NOT_FOUND", jobMatches, item: null };
  if (appointments.length !== 1) return { outcome: "APPOINTMENT_AMBIGUOUS", jobMatches, item: null };
  return { outcome: "READY", jobMatches, item: scheduleItem(appointments[0]!) };
}
