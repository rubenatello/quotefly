import { useCallback, useRef } from "react";
import { canTrackAnalytics } from "./cookie-consent";

type AnalyticsEvent = {
  name: string;
  properties?: Record<string, string | number | boolean | null>;
};

const EVENT_BUFFER: AnalyticsEvent[] = [];
const FLUSH_INTERVAL_MS = 5000;
const MAX_BUFFER_SIZE = 25;

let flushTimer: ReturnType<typeof setInterval> | null = null;

function flush() {
  if (EVENT_BUFFER.length === 0) return;
  const batch = EVENT_BUFFER.splice(0, EVENT_BUFFER.length);
  // When analytics endpoint is ready, POST batch to /v1/analytics/events
  if (import.meta.env.DEV) {
    console.debug("[analytics]", batch);
  }
}

function ensureFlushTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
}

export function trackEvent(name: string, properties?: AnalyticsEvent["properties"]) {
  if (!canTrackAnalytics()) return;
  EVENT_BUFFER.push({ name, properties: { ...properties, _ts: Date.now() } });
  ensureFlushTimer();
  if (EVENT_BUFFER.length >= MAX_BUFFER_SIZE) {
    flush();
  }
}

/** Page-level tracking — deduplicated per page */
export function usePageView(page: string) {
  const lastPage = useRef<string | null>(null);
  if (page !== lastPage.current) {
    lastPage.current = page;
    trackEvent("page_view", { page });
  }
}

/** Returns a stable `track` function for component-level events */
export function useTrack() {
  return useCallback(trackEvent, []);
}
