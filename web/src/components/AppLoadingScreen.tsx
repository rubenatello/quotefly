import { useTranslation } from "react-i18next";

type AppLoadingScreenProps = {
  message?: string;
  recovery?: {
    isOnline: boolean;
    retrying: boolean;
    onRetry: () => void;
  };
};

export function AppLoadingScreen({ message, recovery }: AppLoadingScreenProps) {
  const { t } = useTranslation();
  const resolvedMessage = message ?? t("auth.defaultLoading");

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
            {recovery ? t("auth.workspaceStillHere") : resolvedMessage}
          </p>
          {recovery ? (
            <>
              <p className="text-sm text-[var(--qf-text-soft)]">{resolvedMessage}</p>
              <p className={`text-sm font-medium ${recovery.isOnline ? "text-[var(--qf-success-text)]" : "text-[var(--qf-warning-text)]"}`}>
                {recovery.isOnline
                  ? t("auth.onlineRetry")
                  : t("auth.offlineRetry")}
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
            {recovery.retrying ? t("auth.retrying") : t("auth.retry")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function WorkspaceRouteLoading({ message }: { message?: string }) {
  const { t } = useTranslation();
  const resolvedMessage = message ?? t("auth.loadingWorkspace");

  return (
    <div role="status" aria-live="polite" aria-label={resolvedMessage} className="space-y-4 sm:space-y-5">
      <span className="sr-only">{resolvedMessage}</span>

      <div className="flex items-center justify-between gap-4">
        <div className="space-y-2">
          <div className="h-3 w-28 animate-pulse rounded-full bg-[var(--qf-interactive-active)]" aria-hidden="true" />
          <div className="h-5 w-52 max-w-[64vw] animate-pulse rounded-lg bg-[var(--qf-interactive-active)]" aria-hidden="true" />
        </div>
        <div className="hidden h-11 w-32 animate-pulse rounded-xl bg-[var(--qf-selected)] sm:block" aria-hidden="true" />
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)] p-4 shadow-[var(--qf-shadow-sm)]">
            <div className="h-9 w-9 animate-pulse rounded-xl bg-[var(--qf-panel-muted)]" aria-hidden="true" />
            <div className="mt-5 h-6 w-16 animate-pulse rounded-lg bg-[var(--qf-interactive-active)]" aria-hidden="true" />
            <div className="mt-2 h-3 w-24 animate-pulse rounded-full bg-[var(--qf-panel-muted)]" aria-hidden="true" />
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-2xl border border-[var(--qf-border)] bg-[var(--qf-panel)] shadow-[var(--qf-shadow-sm)]">
        <div className="border-b border-[var(--qf-border)] p-4 sm:p-5">
          <div className="h-4 w-36 animate-pulse rounded-md bg-[var(--qf-interactive-active)]" aria-hidden="true" />
          <div className="mt-2 h-3 w-64 max-w-[75vw] animate-pulse rounded-full bg-[var(--qf-panel-muted)]" aria-hidden="true" />
        </div>
        <div className="divide-y divide-[var(--qf-border)]">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex items-center gap-3 p-4 sm:px-5">
              <div className="h-10 w-10 shrink-0 animate-pulse rounded-xl bg-[var(--qf-panel-muted)]" aria-hidden="true" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="h-3.5 w-2/5 animate-pulse rounded-full bg-[var(--qf-interactive-active)]" aria-hidden="true" />
                <div className="h-3 w-3/5 animate-pulse rounded-full bg-[var(--qf-panel-muted)]" aria-hidden="true" />
              </div>
              <div className="h-9 w-20 animate-pulse rounded-xl bg-[var(--qf-panel-muted)]" aria-hidden="true" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
