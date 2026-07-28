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
    <div className="min-h-screen bg-slate-50 px-4">
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center gap-5 text-center">
        {recovery ? (
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-quotefly-blue/[0.08] text-2xl font-bold text-quotefly-blue" aria-hidden="true">
            QF
          </div>
        ) : (
          <div className="relative h-12 w-12" aria-hidden="true">
            <span className="absolute inset-0 animate-spin rounded-full border-4 border-slate-200 border-t-quotefly-blue" />
            <span className="absolute inset-[10px] rounded-full bg-quotefly-orange/15" />
          </div>
        )}

        <div role="status" aria-live="polite" aria-atomic="true" className="space-y-2">
          <p className="text-base font-semibold text-slate-900">
            {recovery ? "Your workspace is still here" : message}
          </p>
          {recovery ? (
            <>
              <p className="text-sm text-slate-600">{message}</p>
              <p className={`text-sm font-medium ${recovery.isOnline ? "text-emerald-700" : "text-amber-700"}`}>
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
            className="inline-flex min-h-[44px] min-w-32 items-center justify-center rounded-lg bg-quotefly-blue px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-quotefly-blue disabled:cursor-wait disabled:opacity-60"
          >
            {recovery.retrying ? "Retrying..." : "Retry"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
