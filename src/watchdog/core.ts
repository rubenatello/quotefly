import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { isQuickBooksExternalEventCode, parseQuickBooksExternalSignalPayload } from "../services/quickbooks-observability";

export const INTERVAL_MS = 60_000;
export const MAX_QUEUE = 128;
export const MAX_RETRY_AGE_MS = 23 * 60 * 60_000;
const REMINDER_MS = 60 * 60_000;
export type Severity = "healthy" | "warning" | "critical";
export type Notification = {
  id: string; at: number; code: string; level: Severity; kind: "incident" | "recovery" | "signal" | "canary";
};
export type WatchdogState = {
  version: 1; destination: string; incident: Severity; healthyStreak: number;
  lastProbeAt: number; lastCanaryAt: number; lastAcceptedAt: number;
  reminders: Record<string, number>; queue: Notification[];
};
export type WatchdogConfig = {
  environment: "staging" | "production"; origin: string; monitorBearer: string;
  apiToken: string; workerToken: string; mailKey: string; from: string; to: string;
  directory: string; port: number; destination: string;
};
const configError = () => new Error("WATCHDOG_CONFIGURATION_INVALID");
export function loadConfig(input: NodeJS.ProcessEnv): WatchdogConfig {
  const environment = input.WATCHDOG_ENVIRONMENT;
  if (environment !== "staging" && environment !== "production") throw configError();
  const origin = environment === "staging" ? "https://api-staging.quotefly.us" : "https://api.quotefly.us";
  const names = ["WATCHDOG_MONITOR_BEARER", "WATCHDOG_API_SOURCE_TOKEN", "WATCHDOG_WORKER_SOURCE_TOKEN", "WATCHDOG_RESEND_API_KEY"];
  const secrets = names.map(name => input[name] ?? "");
  if (secrets.some(value => value.length < 32 || value.length > 512 || /\s/.test(value)) || new Set(secrets).size !== 4) throw configError();
  const from = input.WATCHDOG_EMAIL_FROM ?? "";
  const to = input.WATCHDOG_EMAIL_TO ?? "";
  const mailbox = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,63}$/;
  if ([from, to].some(value => value.length > 254 || !mailbox.test(value))) throw configError();
  const directory = input.WATCHDOG_STATE_DIRECTORY ?? "";
  const port = Number(input.PORT ?? 8080);
  if (!directory || directory.length > 1024 || /[\r\n\0]/.test(directory) || !Number.isInteger(port) || port < 1024 || port > 65535) throw configError();
  return {
    environment, origin, monitorBearer: secrets[0], apiToken: secrets[1], workerToken: secrets[2],
    mailKey: secrets[3], from, to, directory, port,
    destination: createHash("sha256").update(JSON.stringify([environment, origin, from, to])).digest("hex"),
  };
}
export function authorized(header: unknown, token: string): boolean {
  if (typeof header !== "string" || header.length > 520) return false;
  return timingSafeEqual(createHash("sha256").update(header).digest(), createHash("sha256").update(`Bearer ${token}`).digest());
}
export function initialState(destination: string): WatchdogState {
  return { version: 1, destination, incident: "healthy", healthyStreak: 0, lastProbeAt: 0, lastCanaryAt: 0, lastAcceptedAt: 0, reminders: {}, queue: [] };
}
const severities = ["healthy", "warning", "critical"];
const codePattern = /^(?:MONITOR_(?:WARNING|CRITICAL|RECOVERED)|DAILY_CANARY|(?:api|worker):QUICKBOOKS_[A-Z_]{1,80})$/;
function validCode(code: string): boolean {
  return codePattern.test(code) && (!code.includes(":") || isQuickBooksExternalEventCode(code.split(":")[1]));
}
function exactKeys(value: object, keys: string[]): boolean {
  return Object.keys(value).sort().join(",") === keys.sort().join(",");
}
export function validateState(value: unknown, destination: string): value is WatchdogState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as WatchdogState;
  const time = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
  return exactKeys(s, ["version", "destination", "incident", "healthyStreak", "lastProbeAt", "lastCanaryAt", "lastAcceptedAt", "reminders", "queue"])
    && s.version === 1 && s.destination === destination && severities.includes(s.incident)
    && time(s.healthyStreak) && s.healthyStreak <= 2
    && [s.lastProbeAt, s.lastCanaryAt, s.lastAcceptedAt].every(time)
    && !!s.reminders && typeof s.reminders === "object" && !Array.isArray(s.reminders)
    && Object.keys(s.reminders).length <= 96
    && Object.entries(s.reminders).every(([code, at]) => validCode(code) && time(at))
    && Array.isArray(s.queue) && s.queue.length <= MAX_QUEUE
    && new Set(s.queue.map(n => n?.id)).size === s.queue.length
    && s.queue.every(n => n && typeof n === "object"
      && exactKeys(n, ["id", "at", "code", "level", "kind"])
      && typeof n.id === "string" && /^[0-9a-f-]{36}$/.test(n.id) && time(n.at)
      && typeof n.code === "string" && validCode(n.code) && severities.includes(n.level)
      && ["incident", "recovery", "signal", "canary"].includes(n.kind));
}
function enqueue(state: WatchdogState, item: Omit<Notification, "id">): void {
  if (state.queue.length >= MAX_QUEUE) throw new Error("WATCHDOG_QUEUE_FULL");
  state.queue.push({ ...item, id: randomUUID() });
}
export function receiveSignal(state: WatchdogState, input: unknown, role: "api" | "worker", now: number): boolean {
  const signal = parseQuickBooksExternalSignalPayload(input, role);
  if (!signal) return false;
  // A success on one company/worker must never resolve a different company's incident.
  if (signal.level === "info") return true;
  const code = `${role}:${signal.eventCode}`;
  if (Object.hasOwn(state.reminders, code) && now - state.reminders[code] < REMINDER_MS) return true;
  enqueue(state, { at: now, code, level: signal.level === "error" ? "critical" : "warning", kind: "signal" });
  state.reminders[code] = now;
  return true;
}
export function recordProbe(state: WatchdogState, severity: Severity, now: number): void {
  state.lastProbeAt = now;
  state.healthyStreak = severity === "healthy" ? Math.min(2, state.healthyStreak + 1) : 0;
  const next = severity === "healthy" && state.healthyStreak < 2 ? state.incident : severity;
  if (next !== state.incident || (next !== "healthy" && now - (state.reminders[`MONITOR_${next.toUpperCase()}`] ?? 0) >= REMINDER_MS)) {
    const code = next === "healthy" ? "MONITOR_RECOVERED" : `MONITOR_${next.toUpperCase()}`;
    enqueue(state, { at: now, code, level: next, kind: next === "healthy" ? "recovery" : "incident" });
    state.reminders[code] = now;
  }
  state.incident = next;
  if (!state.lastCanaryAt || now - state.lastCanaryAt >= 24 * 60 * 60_000) {
    enqueue(state, { at: now, code: "DAILY_CANARY", level: "healthy", kind: "canary" });
    state.lastCanaryAt = now;
  }
}
export function selfHealthy(state: WatchdogState, now: number): boolean {
  return state.lastProbeAt > 0 && now >= state.lastProbeAt && now - state.lastProbeAt <= 3 * INTERVAL_MS
    && state.queue.every(item => now >= item.at && now - item.at < 5 * INTERVAL_MS)
    && state.lastAcceptedAt > 0 && now >= state.lastAcceptedAt && now - state.lastAcceptedAt < 26 * 60 * 60_000;
}
export async function probe(config: WatchdogConfig, fetcher: typeof fetch = fetch): Promise<Severity> {
  const statuses = await Promise.all(["warning", "critical"].map(async level => {
    try {
      const response = await fetcher(`${config.origin}/v1/internal/quickbooks/monitor/${level}`, {
        headers: { authorization: `Bearer ${config.monitorBearer}` }, redirect: "error", signal: AbortSignal.timeout(8000),
      });
      if (response.body) {
        const reader = response.body.getReader();
        try { if (!(await reader.read()).done) return 0; } finally { await reader.cancel(); }
      }
      return response.status;
    } catch { return 0; }
  }));
  if (statuses.some(status => status !== 204 && status !== 503) || statuses[1] !== 204) return "critical";
  return statuses[0] === 204 ? "healthy" : "warning";
}
export async function sendNotification(config: WatchdogConfig, item: Notification, fetcher: typeof fetch = fetch): Promise<void> {
  const text = [
    `QuoteFly QuickBooks monitor (${config.environment}).`,
    `Notification: ${item.kind}. Severity: ${item.level}. Code: ${item.code}.`,
    `Observed at: ${new Date(item.at).toISOString()}.`,
    item.kind === "canary" ? "Scheduled delivery check only; this is NOT a QuickBooks health or launch approval." : "Review Integration Health in QuoteFly's restricted platform admin and the monitoring runbook.",
    "Provider acceptance is not proof of inbox receipt. Signal notifications are aggregate and contain no customer data.",
  ].join("\n");
  const response = await fetcher("https://api.resend.com/emails", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
    headers: { authorization: `Bearer ${config.mailKey}`, "content-type": "application/json", "idempotency-key": `quotefly-watchdog/${item.id}` },
    body: JSON.stringify({ from: config.from, to: [config.to], subject: `[QuoteFly ${config.environment}] ${item.kind}: ${item.level}`, text }),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error("WATCHDOG_EMAIL_NOT_ACCEPTED");
}
