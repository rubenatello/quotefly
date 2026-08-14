type AppLoadingScreenProps = {
  message?: string;
  recovery?: {
    isOnline: boolean;
    retrying: boolean;
    onRetry: () => void;
  };
};

export function AppLoadingScreen({ message = "Loading...", recovery }: AppLoadingScreenProps) {
  return (
    <div className="qf-theme-scope min-h-screen bg-qf-canvas px-4 text-qf-text">
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center gap-5 text-center">
        {recovery ? (
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--qf-selected)] text-2xl font-bold text-[var(--qf-link)]" aria-hidden="true">
            QF
          </div>
        ) : (
          <div className="relative h-12 w-12" aria-hidden="true">
            <span className="absolute inset-0 animate-spin rounded-full border-4 border-[var(--qf-border)] border-t-[var(--qf-action-primary)]" />
            <span className="absolute inset-[10px] rounded-full bg-quotefly-orange/15" />
          </div>
        )}

        <div role="status" aria-live="polite" aria-atomic="true" className="space-y-2">
          <p className="text-base font-semibold text-[var(--qf-text)]">
            {recovery ? "Your workspace is still here" : message}
          </p>
          {recovery ? (
            <>
              <p className="text-sm text-[var(--qf-text-soft)]">{message}</p>
              <p className={`text-sm font-medium ${recovery.isOnline ? "text-[var(--qf-success-text)]" : "text-[var(--qf-warning-text)]"}`}>
                {recovery.isOnline
                  ? "You're online. Retry the secure session check to continue."
                  : "You're offline. Reconnect, then retry to continue."}
              </p>
            </>
          ) : null}
        </div>

        {recovery ? (
          <button
            type="button"
            onClick={recovery.onRetry}
            disabled={recovery.retrying}
            className="inline-flex min-h-[44px] min-w-32 items-center justify-center rounded-lg border border-[var(--qf-action-primary)] bg-[var(--qf-action-primary)] px-5 py-2.5 text-sm font-semibold text-[var(--qf-action-primary-text)] shadow-[var(--qf-shadow-sm)] transition hover:border-[var(--qf-action-primary-hover)] hover:bg-[var(--qf-action-primary-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qf-focus)] disabled:cursor-wait disabled:border-[var(--qf-border)] disabled:bg-[var(--qf-panel-muted)] disabled:text-[var(--qf-text-muted)]"
          >
            {recovery.retrying ? "Retrying..." : "Retry"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
