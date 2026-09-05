const RELEASE_SHA_PATTERN = /^[a-f0-9]{40}$/i;

export type ReleaseIdentitySource = Readonly<Record<string, string | undefined>>;

export function resolveRuntimeReleaseSha(
  source: ReleaseIdentitySource = process.env,
): string | null {
  const normalize = (candidate: string | undefined) => {
    const normalized = candidate?.trim().toLowerCase();
    return normalized && RELEASE_SHA_PATTERN.test(normalized) ? normalized : null;
  };
  const manualReleaseSha = normalize(source.QUOTEFLY_RELEASE_SHA);
  const platformCandidates = [
    source.RAILWAY_GIT_COMMIT_SHA,
    source.RENDER_GIT_COMMIT,
  ];
  for (const candidate of platformCandidates) {
    if (candidate?.trim() && !normalize(candidate)) {
      throw new Error("A provider runtime release identity is malformed.");
    }
  }
  const platformReleaseShas = platformCandidates
    .map(normalize)
    .filter((candidate): candidate is string => candidate !== null);
  const uniquePlatformReleaseShas = new Set(platformReleaseShas);
  if (uniquePlatformReleaseShas.size > 1) {
    throw new Error("Conflicting provider runtime release identities are configured.");
  }
  const platformReleaseSha = platformReleaseShas[0] ?? null;
  if (platformReleaseSha && manualReleaseSha && platformReleaseSha !== manualReleaseSha) {
    throw new Error("Manual and provider runtime release identities conflict.");
  }
  return platformReleaseSha ?? manualReleaseSha;
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
