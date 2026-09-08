import { INTERVAL_MS, MAX_RETRY_AGE_MS, loadConfig, probe, recordProbe, sendNotification } from "./core";
import { WatchdogStore } from "./store";
import { createWatchdogServer } from "./server";
import { launchWithProcessLock } from "./process-lock";

export async function startWatchdog(externalLockHeld = false) {
  const config = loadConfig(process.env);
  const store = new WatchdogStore(config.directory, config.destination, externalLockHeld);
  const server = createWatchdogServer(config, store);
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let task: Promise<void> = Promise.resolve();
  let failures = 0;
  let retryAt = 0;
  const run = async () => {
    const startedAt = Date.now();
    try {
      const severity = await probe(config);
      store.change(state => recordProbe(state, severity, Date.now()));
    } catch { process.stderr.write("WATCHDOG_PROBE_OR_STORAGE_FAILED\n"); }
    // One send per minute bounds costs even during a flood. The persisted item/id/body
    // never changes across retries. Stop before the provider's 24-hour dedupe window.
    const item = store.snapshot().queue[0];
    if (item && store.healthy && Date.now() >= retryAt) {
      if (Date.now() - item.at >= MAX_RETRY_AGE_MS) {
        process.stderr.write("WATCHDOG_DELIVERY_EXPIRED_OPERATOR_REQUIRED\n");
      } else {
        try {
          await sendNotification(config, item);
          store.change(state => {
            state.queue = state.queue.filter(pending => pending.id !== item.id);
            state.lastAcceptedAt = Date.now();
          });
          failures = 0;
          retryAt = 0;
        } catch {
          failures = Math.min(failures + 1, 8);
          retryAt = Date.now() + Math.min(30 * INTERVAL_MS, INTERVAL_MS * 2 ** failures) + Math.floor(Math.random() * 5000);
          process.stderr.write("WATCHDOG_EMAIL_OR_STORAGE_FAILED\n");
        }
      }
    }
    if (!stopping) timer = setTimeout(() => { task = run(); }, Math.max(INTERVAL_MS - (Date.now() - startedAt), 1000));
  };
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.port, "0.0.0.0", resolve); });
  } catch { store.close(); throw new Error("WATCHDOG_LISTEN_FAILED"); }
  task = run();
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (timer) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await task;
    store.close();
  };
  return { stop };
}
if (require.main === module) {
  if (process.platform === "linux" && process.argv[2] !== "--lock-held") {
    try { launchWithProcessLock(loadConfig(process.env).directory, __filename); }
    catch { process.stderr.write("WATCHDOG_STARTUP_FAILED\n"); process.exitCode = 1; }
  } else startWatchdog(process.platform === "linux" && process.argv[2] === "--lock-held").then(({ stop }) => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => {
      stop().catch(() => { process.stderr.write("WATCHDOG_SHUTDOWN_FAILED\n"); process.exitCode = 1; });
    });
  }).catch(() => { process.stderr.write("WATCHDOG_STARTUP_FAILED\n"); process.exitCode = 1; });
}
