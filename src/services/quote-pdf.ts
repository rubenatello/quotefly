import PDFDocument from "pdfkit";

export type QuotePdfTemplateId = "modern" | "professional" | "bold" | "minimal" | "classic";

export interface QuoteComponentColors {
  headerBgColor?: string;
  headerTextColor?: string;
  sectionTitleColor?: string;
  tableHeaderBgColor?: string;
  tableHeaderTextColor?: string;
  totalsColor?: string;
  footerTextColor?: string;
}

export interface QuotePdfLineItem {
  description: string;
  quantity: number;
  unitCost: number;
  unitPrice: number;
}

export interface QuotePdfData {
  quoteId: string;
  serviceType: string;
  status: string;
  title: string;
  scopeText: string;
  createdAt: Date;
  sentAt: Date | null;
  internalCostSubtotal: number;
  customerPriceSubtotal: number;
  taxAmount: number;
  totalAmount: number;
  customer: {
    fullName: string;
    email: string | null;
    phone: string;
  };
  tenant: {
    name: string;
    timezone: string;
  };
  branding: {
    templateId: string;
    primaryColor: string;
    logoUrl: string | null;
    businessEmail?: string | null;
    businessPhone?: string | null;
    addressLine1?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
    componentColors?: QuoteComponentColors | null;
  };
  lineItems: QuotePdfLineItem[];
}

interface ResolvedComponentColors {
  headerBgColor: string;
  headerTextColor: string;
  sectionTitleColor: string;
  tableHeaderBgColor: string;
  tableHeaderTextColor: string;
  totalsColor: string;
  footerTextColor: string;
}

interface ThemeDefinition {
  headerStyle: "bar" | "block" | "minimal" | "card";
  accentColor: string;
  secondaryColor: string;
  textDark: string;
}

const TEMPLATE_THEMES: Record<QuotePdfTemplateId, ThemeDefinition> = {
  modern: {
    headerStyle: "bar",
    accentColor: "#1f4b70",
    secondaryColor: "#e8f0f7",
    textDark: "#1b2b3a",
  },
  professional: {
    headerStyle: "card",
    accentColor: "#2d4f2b",
    secondaryColor: "#eef6ee",
    textDark: "#1f2a1f",
  },
  bold: {
    headerStyle: "block",
    accentColor: "#7f2a10",
    secondaryColor: "#fff0ea",
    textDark: "#2f120a",
  },
  minimal: {
    headerStyle: "minimal",
    accentColor: "#2a2a2a",
    secondaryColor: "#f3f3f3",
    textDark: "#121212",
  },
  classic: {
    headerStyle: "card",
    accentColor: "#4d3d2a",
    secondaryColor: "#f8f4ec",
    textDark: "#2f2418",
  },
};

function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatLocalDate(value: Date | null, timeZone: string): string {
  if (!value) return "Not sent";

  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(value);
  } catch {
    return value.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
}

function compactLocationLine(data: QuotePdfData["branding"]): string | null {
  const city = data.city?.trim();
  const state = data.state?.trim();
  const postalCode = data.postalCode?.trim();

  if (!city && !state && !postalCode) return null;

  const locationParts: string[] = [];
  if (city) locationParts.push(city);
  if (state) locationParts.push(state);
  const left = locationParts.join(", ");

  if (left && postalCode) return `${left} ${postalCode}`;
  return left || postalCode || null;
}

function buildSenderLines(data: QuotePdfData): string[] {
  const lines = [data.tenant.name];
  const addressLine1 = data.branding.addressLine1?.trim();
  const addressLine2 = data.branding.addressLine2?.trim();
  const locationLine = compactLocationLine(data.branding);
  const businessPhone = data.branding.businessPhone?.trim();
  const businessEmail = data.branding.businessEmail?.trim();

  if (addressLine1) lines.push(addressLine1);
  if (addressLine2) lines.push(addressLine2);
  if (locationLine) lines.push(locationLine);
  if (businessPhone) lines.push(businessPhone);
  if (businessEmail) lines.push(businessEmail);

  return lines;
}

function buildFooterText(data: QuotePdfData): string {
  const contactParts = [data.branding.businessPhone?.trim(), data.branding.businessEmail?.trim()].filter(Boolean);

  if (contactParts.length > 0) {
    return `Questions about this quote? Contact ${data.tenant.name} at ${contactParts.join(" or ")}.`;
  }

  return `Questions about this quote? Contact ${data.tenant.name}.`;
}

function safeTemplateId(templateId: string): QuotePdfTemplateId {
  if (templateId === "professional" || templateId === "bold" || templateId === "minimal" || templateId === "classic") {
    return templateId;
  }
  return "modern";
}

function safeHexColor(color: string, fallback: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : fallback;
}

function getContrastingTextColor(color: string): string {
  const safe = safeHexColor(color, "#5B85AA");
  const red = Number.parseInt(safe.slice(1, 3), 16);
  const green = Number.parseInt(safe.slice(3, 5), 16);
  const blue = Number.parseInt(safe.slice(5, 7), 16);
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return luminance > 0.62 ? "#111111" : "#ffffff";
}

function resolveComponentColors(
  overrides: QuoteComponentColors | null | undefined,
  accentColor: string,
): ResolvedComponentColors {
  const headerBgColor = safeHexColor(overrides?.headerBgColor ?? accentColor, accentColor);
  const tableHeaderBgColor = safeHexColor(overrides?.tableHeaderBgColor ?? accentColor, accentColor);

  return {
    headerBgColor,
    headerTextColor: safeHexColor(
      overrides?.headerTextColor ?? getContrastingTextColor(headerBgColor),
      getContrastingTextColor(headerBgColor),
    ),
    sectionTitleColor: safeHexColor(overrides?.sectionTitleColor ?? accentColor, accentColor),
    tableHeaderBgColor,
    tableHeaderTextColor: safeHexColor(
      overrides?.tableHeaderTextColor ?? getContrastingTextColor(tableHeaderBgColor),
      getContrastingTextColor(tableHeaderBgColor),
    ),
    totalsColor: safeHexColor(overrides?.totalsColor ?? accentColor, accentColor),
    footerTextColor: safeHexColor(overrides?.footerTextColor ?? "#666666", "#666666"),
  };
}

async function loadLogoBuffer(logoUrl: string | null): Promise<Buffer | null> {
  if (!logoUrl) return null;

  const dataUrlMatch = logoUrl.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
  if (dataUrlMatch) {
    try {
      return Buffer.from(dataUrlMatch[1], "base64");
    } catch {
      return null;
    }
  }

  if (!logoUrl.startsWith("http://") && !logoUrl.startsWith("https://")) {
    return null;
  }

  try {
    const response = await fetch(logoUrl);
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch {
    return null;
  }
}

function writeHeader(
  doc: PDFKit.PDFDocument,
  data: QuotePdfData,
  theme: ThemeDefinition,
  colors: ResolvedComponentColors,
  accentColor: string,
  logoBuffer: Buffer | null,
): number {
  const left = 48;
  const right = doc.page.width - 48;
  const width = right - left;
  const quoteLabel = `Quote #${data.quoteId.slice(0, 8).toUpperCase()}`;
  const createdDate = formatLocalDate(data.createdAt, data.tenant.timezone);

  if (theme.headerStyle === "bar") {
    doc.rect(0, 0, doc.page.width, 110).fill(colors.headerBgColor);
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, left, 26, { fit: [88, 56] });
      } catch {
        // Ignore bad image payloads and continue without logo rendering.
      }
    }
    doc.fillColor(colors.headerTextColor).font("Helvetica-Bold").fontSize(21).text(data.tenant.name, left + (logoBuffer ? 100 : 0), 28);
    doc.font("Helvetica").fontSize(11).text(quoteLabel, left + (logoBuffer ? 100 : 0), 58);
    doc.text(`Prepared ${createdDate}`, left + (logoBuffer ? 100 : 0), 74);
    doc.fillColor("#111111");
    return 132;
  }

  if (theme.headerStyle === "block") {
    doc.rect(0, 0, doc.page.width, 150).fill(colors.headerBgColor);
    doc.fillColor(colors.headerTextColor).font("Helvetica-Bold").fontSize(26).text("QUOTE", left, 30);
    doc.font("Helvetica").fontSize(11).text(`${data.tenant.name}`, left, 66);
    doc.text(quoteLabel, left, 82);
    doc.text(`Prepared: ${createdDate}`, left, 98);
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, right - 105, 25, { fit: [92, 92] });
      } catch {
        // Ignore bad image payloads and continue without logo rendering.
      }
    }
    doc.fillColor("#111111");
    return 170;
  }

  if (theme.headerStyle === "card") {
    doc.roundedRect(left, 30, width, 86, 10).fill(theme.secondaryColor);
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, left + 12, 43, { fit: [76, 58] });
      } catch {
        // Ignore bad image payloads and continue without logo rendering.
      }
    }
    doc.fillColor(colors.headerBgColor).font("Helvetica-Bold").fontSize(19).text(data.tenant.name, left + (logoBuffer ? 100 : 14), 46);
    doc.fillColor(theme.textDark).font("Helvetica").fontSize(11).text(quoteLabel, left + (logoBuffer ? 100 : 14), 72);
    doc.text(`Prepared ${createdDate}`, left + (logoBuffer ? 100 : 14), 88);
    doc.fillColor("#111111");
    return 136;
  }

  doc.fillColor(colors.headerBgColor).font("Helvetica-Bold").fontSize(23).text(data.tenant.name, left, 42);
  doc.font("Helvetica").fontSize(11).fillColor("#555555").text(quoteLabel, left, 72);
  doc.text(`Prepared ${createdDate}`, left, 88);
  if (logoBuffer) {
    try {
      doc.image(logoBuffer, right - 96, 38, { fit: [84, 56] });
    } catch {
      // Ignore bad image payloads and continue without logo rendering.
    }
  }
  doc.fillColor("#111111");
  return 126;
}

function drawSectionTitle(doc: PDFKit.PDFDocument, y: number, title: string, sectionTitleColor: string): number {
  doc.fillColor(sectionTitleColor).font("Helvetica-Bold").fontSize(12).text(title, 48, y);
  return y + 18;
}

function ensureSpace(doc: PDFKit.PDFDocument, y: number, minSpace: number): number {
  const bottomLimit = doc.page.height - 64;
  if (y + minSpace <= bottomLimit) return y;
  doc.addPage();
  return 56;
}

function drawPartyCard(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  width: number,
  title: string,
  lines: string[],
  sectionTitleColor: string,
): number {
  const contentLines = lines.filter((line) => line.trim().length > 0);
  const height = Math.max(86, 42 + contentLines.length * 14);

  doc.roundedRect(x, y, width, height, 10).fillAndStroke("#ffffff", "#d7dde5");
  doc.fillColor(sectionTitleColor).font("Helvetica-Bold").fontSize(11).text(title, x + 14, y + 12);

  let textY = y + 32;
  doc.fillColor("#222222").font("Helvetica").fontSize(10);
  for (const line of contentLines) {
    doc.text(line, x + 14, textY, { width: width - 28 });
    textY += 14;
  }

  return y + height;
}

function drawLineItemsTable(
  doc: PDFKit.PDFDocument,
  yStart: number,
  items: QuotePdfLineItem[],
  tableHeaderColor: string,
  tableHeaderTextColor: string,
): number {
  let y = yStart;
  const normalizedItems =
    items.length > 0
      ? items
      : [{ description: "Scope summary", quantity: 1, unitCost: 0, unitPrice: 0 }];

  const xDescription = 48;
  const xQty = 350;
  const xUnit = 408;
  const xTotal = 494;

  doc.rect(48, y, 516, 24).fill(tableHeaderColor);
  doc.fillColor(tableHeaderTextColor).font("Helvetica-Bold").fontSize(10);
  doc.text("Description", xDescription + 8, y + 8, { width: 280 });
  doc.text("Qty", xQty + 8, y + 8, { width: 42, align: "right" });
  doc.text("Unit", xUnit + 8, y + 8, { width: 66, align: "right" });
  doc.text("Total", xTotal + 8, y + 8, { width: 58, align: "right" });

  y += 24;
  doc.font("Helvetica").fillColor("#222222");

  normalizedItems.forEach((item, index) => {
    y = ensureSpace(doc, y, 34);

    if (index % 2 === 0) {
      doc.rect(48, y, 516, 28).fill("#f7f7f7");
      doc.fillColor("#222222");
    }

    const total = item.quantity * item.unitPrice;
    doc.text(item.description, xDescription + 8, y + 8, { width: 280 });
    doc.text(String(item.quantity), xQty + 8, y + 8, { width: 42, align: "right" });
    doc.text(formatMoney(item.unitPrice), xUnit + 8, y + 8, { width: 66, align: "right" });
    doc.text(formatMoney(total), xTotal + 8, y + 8, { width: 58, align: "right" });
    y += 28;
  });

  return y + 12;
}

function drawTotals(doc: PDFKit.PDFDocument, y: number, data: QuotePdfData, totalsColor: string): number {
  const xLabel = 386;
  const xValue = 492;
  doc.font("Helvetica").fontSize(10).fillColor("#333333");
  doc.text("Subtotal", xLabel, y, { width: 90, align: "right" });
  doc.text(formatMoney(data.customerPriceSubtotal), xValue, y, { width: 72, align: "right" });
  y += 16;
  doc.text("Tax", xLabel, y, { width: 90, align: "right" });
  doc.text(formatMoney(data.taxAmount), xValue, y, { width: 72, align: "right" });
  y += 20;
  doc.font("Helvetica-Bold").fontSize(12).fillColor(totalsColor);
  doc.text("Total", xLabel, y, { width: 90, align: "right" });
  doc.text(formatMoney(data.totalAmount), xValue, y, { width: 72, align: "right" });
  return y + 28;
}

export async function generateQuotePdfBuffer(data: QuotePdfData): Promise<Buffer> {
  const templateId = safeTemplateId(data.branding.templateId);
  const theme = TEMPLATE_THEMES[templateId];
  const accentColor = safeHexColor(data.branding.primaryColor, theme.accentColor);
  const componentColors = resolveComponentColors(data.branding.componentColors, accentColor);
  const logoBuffer = await loadLogoBuffer(data.branding.logoUrl);

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margins: { top: 48, left: 48, right: 48, bottom: 48 },
      info: {
        Title: `${data.title} - ${data.tenant.name}`,
        Author: "QuoteFly",
        Subject: "Customer Quote",
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    let y = writeHeader(doc, data, theme, componentColors, accentColor, logoBuffer);

    doc.fillColor("#222222").font("Helvetica-Bold").fontSize(16).text(data.title, 48, y);
    y += 24;
    doc.font("Helvetica").fontSize(10).fillColor("#444444");
    doc.text(`Service: ${data.serviceType}`, 48, y);
    doc.text(`Prepared: ${formatLocalDate(data.createdAt, data.tenant.timezone)}`, 230, y);
    doc.text(`Sent: ${formatLocalDate(data.sentAt, data.tenant.timezone)}`, 390, y);
    y += 24;

    y = ensureSpace(doc, y, 130);
    const senderLines = buildSenderLines(data);
    const customerLines = [data.customer.fullName, data.customer.phone, data.customer.email ?? ""];
    const partyCardBottom = Math.max(
      drawPartyCard(doc, 48, y, 250, "From", senderLines, componentColors.sectionTitleColor),
      drawPartyCard(doc, 314, y, 250, "Prepared For", customerLines, componentColors.sectionTitleColor),
    );
    y = partyCardBottom + 20;

    y = drawSectionTitle(doc, y, "Scope", componentColors.sectionTitleColor);
    doc.font("Helvetica").fontSize(10).fillColor("#222222");
    doc.text(data.scopeText, 48, y, { width: 516 });
    y = doc.y + 16;

    y = drawSectionTitle(doc, y, "Line Items", componentColors.sectionTitleColor);
    y = drawLineItemsTable(doc, y, data.lineItems, componentColors.tableHeaderBgColor, componentColors.tableHeaderTextColor);
    y = drawTotals(doc, y, data, componentColors.totalsColor);

    y = ensureSpace(doc, y, 60);
    doc.moveTo(48, y).lineTo(564, y).stroke("#d8d8d8");
    y += 10;
    doc.font("Helvetica").fontSize(9).fillColor(componentColors.footerTextColor);
    doc.text(
      `${buildFooterText(data)} Dates shown in ${data.tenant.timezone}.`,
      48,
      y,
      { width: 516, align: "center" },
    );

    doc.end();
  });
}
