const SUPERUSER_EMAIL_SET = new Set(
  (process.env.SUPERUSER_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);

export function isSuperuserEmail(email?: string | null): boolean {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return false;
  return SUPERUSER_EMAIL_SET.has(normalized);
}

