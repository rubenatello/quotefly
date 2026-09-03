const RELEASE_SHA_PATTERN = /^[a-f0-9]{40}$/i;

export type ReleaseIdentitySource = Readonly<Record<string, string | undefined>>;

export function resolveRuntimeReleaseSha(
  source: ReleaseIdentitySource = process.env,
): string | null {
  for (const candidate of [
    source.QUOTEFLY_RELEASE_SHA,
    source.RAILWAY_GIT_COMMIT_SHA,
    source.RENDER_GIT_COMMIT,
  ]) {
    const normalized = candidate?.trim().toLowerCase();
    if (normalized && RELEASE_SHA_PATTERN.test(normalized)) return normalized;
  }
  return null;
}

export function releaseShaFromMetrics(metrics: unknown): string | null {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return null;
  const candidate = Reflect.get(metrics, "releaseSha");
  if (typeof candidate !== "string") return null;
  const normalized = candidate.trim().toLowerCase();
  return RELEASE_SHA_PATTERN.test(normalized) ? normalized : null;
}

export function compareRuntimeReleaseShas(
  apiReleaseSha: string | null,
  workerReleaseSha: string | null,
): boolean | null {
  if (!apiReleaseSha || !workerReleaseSha) return null;
  return apiReleaseSha === workerReleaseSha;
}
