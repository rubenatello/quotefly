type AppLoadingScreenProps = {
  message?: string;
};

export function AppLoadingScreen({ message = "Loading..." }: AppLoadingScreenProps) {
  return (
    <div className="min-h-screen bg-slate-50 px-4">
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center gap-4 text-center">
        <div className="relative h-12 w-12">
          <span className="absolute inset-0 animate-spin rounded-full border-4 border-slate-200 border-t-quotefly-blue" />
          <span className="absolute inset-[10px] rounded-full bg-quotefly-orange/15" />
        </div>
        <p className="text-sm font-medium text-slate-700">{message}</p>
      </div>
    </div>
  );
}
