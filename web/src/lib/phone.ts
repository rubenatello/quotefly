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

export function formatUsPhoneDisplay(value: string | null | undefined): string {
  if (!value) return "";
  const normalized = normalizeUsPhoneDigits(value);
  if (!normalized) return value.trim();
  return `(${normalized.slice(0, 3)}) ${normalized.slice(3, 6)}-${normalized.slice(6)}`;
}

export function formatUsPhoneInput(value: string): string {
  const existingFormatted = formatUsPhoneDisplay(value);
  if (existingFormatted && existingFormatted === value.trim()) {
    return existingFormatted;
  }

  let digits = digitsOnly(value);
  if (digits.length > 10 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }
  digits = digits.slice(0, 10);

  if (!digits) return "";
  if (digits.length < 4) return `(${digits}`;
  if (digits.length < 7) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export function phoneMatchesSearch(phone: string, searchTerm: string): boolean {
  const normalizedSearchDigits = normalizePhoneSearchDigits(searchTerm);
  const normalizedPhoneDigits = normalizePhoneSearchDigits(phone);
  if (normalizedSearchDigits && normalizedPhoneDigits) {
    return normalizedPhoneDigits.includes(normalizedSearchDigits);
  }
  return phone.toLowerCase().includes(searchTerm.trim().toLowerCase());
}

export function toPhoneHrefValue(phone: string): string {
  const normalizedDigits = normalizeUsPhoneDigits(phone);
  if (normalizedDigits) return normalizedDigits;
  const rawDigits = normalizePhoneSearchDigits(phone);
  return rawDigits ?? phone.trim();
}
