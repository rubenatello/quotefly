function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.replace("#", "");
  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : normalized;

  const value = Number.parseInt(expanded, 16);
  if (!Number.isFinite(value)) {
    return { r: 30, g: 92, b: 173 };
  }

  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function initialsFromCompanyName(companyName: string): string {
  const words = companyName
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!words.length) return "QF";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0] ?? ""}${words[1][0] ?? ""}`.toUpperCase();
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function generateMinimalLogoDataUrl(
  companyName: string,
  primaryColor = "#1e6fd8",
  accentColor = "#f5922f",
): string {
  const initials = escapeXml(initialsFromCompanyName(companyName));
  const { r, g, b } = hexToRgb(primaryColor);

  // Transparent background by design.
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='320' height='96' viewBox='0 0 320 96' role='img' aria-label='${escapeXml(
    companyName,
  )} logo'>
  <g>
    <circle cx='48' cy='48' r='30' fill='rgba(${r},${g},${b},0.14)'/>
    <path d='M28 63c8-18 21-29 40-33' stroke='${accentColor}' stroke-width='6' stroke-linecap='round' fill='none'/>
    <circle cx='57' cy='32' r='5' fill='${accentColor}'/>
    <text x='48' y='57' text-anchor='middle' font-family='Arial, Helvetica, sans-serif' font-size='24' font-weight='700' fill='${primaryColor}'>${initials}</text>
  </g>
  <text x='92' y='56' font-family='Arial, Helvetica, sans-serif' font-size='28' font-weight='700' fill='${primaryColor}'>${escapeXml(
    companyName,
  )}</text>
</svg>`;

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}
