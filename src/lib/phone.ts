const NON_DIGIT_PATTERN = /\D+/g;

function digitsOnly(value: string): string {
  return value.replace(NON_DIGIT_PATTERN, "");
}

export function normalizeUsPhoneDigits(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = digitsOnly(value);
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1);
  }
  if (digits.length === 10) {
    return digits;
  }
  return null;
}

export function normalizePhoneSearchDigits(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = digitsOnly(value);
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1);
  }
  return digits;
}

export function formatUsPhone(value: string | null | undefined): string | null {
  const normalizedDigits = normalizeUsPhoneDigits(value);
  if (!normalizedDigits) return null;
  return `(${normalizedDigits.slice(0, 3)}) ${normalizedDigits.slice(3, 6)}-${normalizedDigits.slice(6)}`;
}

export function normalizeCustomerPhone(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return formatUsPhone(trimmed) ?? trimmed;
}

export function phoneNumbersEquivalent(left: string, right: string): boolean {
  const leftDigits = normalizePhoneSearchDigits(left);
  const rightDigits = normalizePhoneSearchDigits(right);
  if (leftDigits && rightDigits) {
    return leftDigits === rightDigits;
  }
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
