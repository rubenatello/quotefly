function normalizeSuperuserEmail(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const unquoted = trimmed.replace(/^['"]+|['"]+$/g, "").trim().toLowerCase();
  return unquoted || null;
}

const SUPERUSER_EMAIL_SET = new Set(
  (process.env.SUPERUSER_EMAILS ?? "")
    .split(/[,\n;]/)
    .map((email) => normalizeSuperuserEmail(email))
    .filter((email): email is string => Boolean(email)),
);

export function isSuperuserEmail(email?: string | null): boolean {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return false;
  return SUPERUSER_EMAIL_SET.has(normalized);
}
