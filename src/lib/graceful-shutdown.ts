type ShutdownSignal = "SIGTERM" | "SIGINT";

type ShutdownLogger = Readonly<{
  info: (fields: object, message?: string) => unknown;
  error: (fields: object, message?: string) => unknown;
}>;

type ShutdownProcess = Readonly<{
  once: (signal: ShutdownSignal, listener: () => void) => unknown;
  exit: (code: number) => never;
}> & { exitCode?: number };

type ShutdownTimer = ReturnType<typeof setTimeout>;

export function installGracefulApiShutdown(options: Readonly<{
  close: () => Promise<unknown>;
  logger: ShutdownLogger;
  processControl?: ShutdownProcess;
  timeoutMs?: number;
  setTimer?: (handler: () => void, timeoutMs: number) => ShutdownTimer;
  clearTimer?: (timer: ShutdownTimer) => void;
}>): void {
  const processControl = options.processControl ?? process;
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 5_000, 10_000));
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  let shutdownStarted = false;
  const log = (level: "info" | "error", fields: object, message: string) => {
    try {
      options.logger[level](fields, message);
    } catch {
      // A logging failure must not prevent server closure or the force-fail bound.
    }
  };

  const shutdown = (signal: ShutdownSignal) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    log(
      "info",
      { eventCode: "API_GRACEFUL_SHUTDOWN_STARTED", signal },
      "API graceful shutdown started.",
    );

    const forceFailTimer = setTimer(() => {
      processControl.exitCode = 1;
      log(
        "error",
        { eventCode: "API_GRACEFUL_SHUTDOWN_TIMEOUT", signal },
        "API graceful shutdown timed out.",
      );
      processControl.exit(1);
    }, timeoutMs);
    forceFailTimer.unref();

    void Promise.resolve()
      .then(options.close)
      .then(() => {
        clearTimer(forceFailTimer);
        log(
          "info",
          { eventCode: "API_GRACEFUL_SHUTDOWN_COMPLETED", signal },
          "API graceful shutdown completed.",
        );
      })
      .catch(() => {
        processControl.exitCode = 1;
        log(
          "error",
          { eventCode: "API_GRACEFUL_SHUTDOWN_FAILED", signal },
          "API graceful shutdown failed.",
        );
        // Keep the bounded timer armed in case a failed close leaves handles open.
      });
  };

  processControl.once("SIGTERM", () => shutdown("SIGTERM"));
  processControl.once("SIGINT", () => shutdown("SIGINT"));
}
