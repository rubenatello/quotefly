import { readFile } from "node:fs/promises";
import path from "node:path";
import PDFDocument from "pdfkit";

export type QuotePdfTemplateId = "modern" | "professional" | "minimal";
export type QuotePdfLogoPosition = "left" | "center" | "right";

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
  sectionType?: "INCLUDED" | "ALTERNATE";
  sectionLabel?: string | null;
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
    logoPosition?: QuotePdfLogoPosition | null;
    showQuoteFlyAttribution: boolean;
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

interface HeaderFrame {
  top: number;
  height: number;
  textColor: string;
  metaColor: string;
}

const TEMPLATE_THEMES: Record<QuotePdfTemplateId, ThemeDefinition> = {
  modern: {
    headerStyle: "bar",
    accentColor: "#2a7fd8",
    secondaryColor: "#f8fafc",
    textDark: "#0f172a",
  },
  professional: {
    headerStyle: "card",
    accentColor: "#2a7fd8",
    secondaryColor: "#f8fafc",
    textDark: "#0f172a",
  },
  minimal: {
    headerStyle: "minimal",
    accentColor: "#2a7fd8",
    secondaryColor: "#ffffff",
    textDark: "#0f172a",
  },
};

function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatQuantity(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/\.?0+$/, "");
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
  if (templateId === "minimal") {
    return "minimal";
  }
  if (templateId === "professional" || templateId === "bold" || templateId === "classic") {
    return "professional";
  }
  return "modern";
}

function safeLogoPosition(value: string | null | undefined): QuotePdfLogoPosition {
  if (value === "center" || value === "right") return value;
  return "left";
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

async function loadQuoteFlyMarkBuffer(): Promise<Buffer | null> {
  const candidatePaths = [
    path.resolve(process.cwd(), "web/public/favicon.png"),
    path.resolve(process.cwd(), "src/assets/favicon.png"),
  ];

  for (const candidatePath of candidatePaths) {
    try {
      return await readFile(candidatePath);
    } catch {
      // Try the next path.
    }
  }

  return null;
}

function writeHeader(
  doc: PDFKit.PDFDocument,
  data: QuotePdfData,
  theme: ThemeDefinition,
  colors: ResolvedComponentColors,
  logoBuffer: Buffer | null,
): number {
  const left = 48;
  const right = doc.page.width - 48;
  const width = right - left;
  const quoteLabel = `Quote #${data.quoteId.slice(0, 8).toUpperCase()}`;
  const createdDate = formatLocalDate(data.createdAt, data.tenant.timezone);
  const logoPosition = safeLogoPosition(data.branding.logoPosition);

  const drawFrame = (): HeaderFrame => {
    if (theme.headerStyle === "bar") {
      doc.roundedRect(left, 28, width, 124, 16).fillAndStroke("#ffffff", "#dbe3ef");
      doc.save();
      doc.roundedRect(left, 28, width, 124, 16).clip();
      doc.rect(left, 28, width, 6).fill(colors.headerBgColor);
      doc.restore();
      return { top: 28, height: 124, textColor: theme.textDark, metaColor: "#475569" };
    }

    if (theme.headerStyle === "block") {
      doc.roundedRect(left, 28, width, 126, 16).fill(colors.headerBgColor);
      return {
        top: 28,
        height: 126,
        textColor: colors.headerTextColor,
        metaColor: colors.headerTextColor === "#ffffff" ? "#e2e8f0" : "#334155",
      };
    }

    if (theme.headerStyle === "card") {
      doc.roundedRect(left, 28, width, 124, 16).fillAndStroke(theme.secondaryColor, "#dbe3ef");
      doc.roundedRect(left + 18, 46, 4, 78, 2).fill(colors.headerBgColor);
      return { top: 28, height: 124, textColor: theme.textDark, metaColor: "#475569" };
    }

    doc.roundedRect(left, 28, width, 124, 16).fillAndStroke("#ffffff", "#dbe3ef");
    return { top: 28, height: 124, textColor: theme.textDark, metaColor: "#64748b" };
  };

  const frame = drawFrame();
  const innerLeft = left + 18;
  const innerRight = right - 18;
  const contentWidth = innerRight - innerLeft;
  const logoFit: [number, number] = theme.headerStyle === "minimal" ? [80, 42] : [92, 48];
  const logoTop = frame.top + 18;
  let logoBottom = logoTop;

  if (logoBuffer) {
    let logoX = innerLeft;
    if (logoPosition === "center") {
      logoX = left + (width - logoFit[0]) / 2;
    } else if (logoPosition === "right") {
      logoX = innerRight - logoFit[0];
    }

    try {
      doc.image(logoBuffer, logoX, logoTop, { fit: logoFit });
      logoBottom = logoTop + logoFit[1];
    } catch {
      // Ignore bad image payloads and continue without logo rendering.
    }
  }

  const hasLogo = Boolean(logoBuffer);
  const headingAlign = logoPosition === "center" ? "center" : logoPosition === "right" ? "right" : "left";
  const headingTop = hasLogo ? logoBottom + 8 : frame.top + 24;
  const headingX = innerLeft;
  const headingWidth = contentWidth;
  const subtitle = "Customer quote";
  const metaTop = Math.min(frame.top + frame.height - 28, headingTop + 42);

  doc.fillColor(frame.textColor).font("Helvetica-Bold").fontSize(theme.headerStyle === "minimal" ? 20 : 21);
  doc.text(data.title, headingX, headingTop, {
    width: headingWidth,
    align: headingAlign,
  });

  doc.fillColor(frame.metaColor).font("Helvetica").fontSize(10);
  doc.text(subtitle, headingX, headingTop + 22, {
    width: headingWidth,
    align: headingAlign,
  });

  doc.text(`Prepared ${createdDate}`, innerLeft, metaTop, {
    width: contentWidth / 2,
    align: "left",
  });
  doc.text(quoteLabel, innerLeft + contentWidth / 2, metaTop, {
    width: contentWidth / 2,
    align: "right",
  });

  doc.fillColor("#111111");
  return frame.top + frame.height + 20;
}

function drawSectionTitle(doc: PDFKit.PDFDocument, y: number, title: string, sectionTitleColor: string): number {
  doc.fillColor(sectionTitleColor).font("Helvetica-Bold").fontSize(12).text(title, 48, y);
  doc.moveTo(48, y + 16).lineTo(564, y + 16).stroke("#e2e8f0");
  return y + 24;
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
  emptyDescription: string,
  tableHeaderColor: string,
  tableHeaderTextColor: string,
): number {
  let y = yStart;
  const normalizedItems =
    items.length > 0
      ? items
      : [{ description: emptyDescription, quantity: 1, unitCost: 0, unitPrice: 0 }];

  const xDescription = 48;
  const xQty = 350;
  const xUnit = 408;
  const xTotal = 494;

  const drawTableHeader = (top: number) => {
    doc.rect(48, top, 516, 24).fill(tableHeaderColor);
    doc.fillColor(tableHeaderTextColor).font("Helvetica-Bold").fontSize(10);
    doc.text("Description", xDescription + 8, top + 8, { width: 280 });
    doc.text("Qty", xQty + 8, top + 8, { width: 42, align: "right" });
    doc.text("Unit", xUnit + 8, top + 8, { width: 66, align: "right" });
    doc.text("Total", xTotal + 8, top + 8, { width: 58, align: "right" });
  };

  drawTableHeader(y);
  y += 24;

  normalizedItems.forEach((item, index) => {
    doc.font("Helvetica").fontSize(10);
    const descriptionHeight = doc.heightOfString(item.description, {
      width: 280,
      align: "left",
    });
    const rowHeight = Math.max(28, Math.ceil(descriptionHeight) + 12);

    if (y + rowHeight > doc.page.height - 72) {
      doc.addPage();
      y = 56;
      drawTableHeader(y);
      y += 24;
    }

    if (index % 2 === 0) {
      doc.rect(48, y, 516, rowHeight).fill("#f8fafc");
    }

    doc.fillColor("#222222").font("Helvetica").fontSize(10);
    const textY = y + 7;
    const total = item.quantity * item.unitPrice;
    doc.text(item.description, xDescription + 8, textY, { width: 280 });
    doc.text(formatQuantity(item.quantity), xQty + 8, textY, { width: 42, align: "right" });
    doc.text(formatMoney(item.unitPrice), xUnit + 8, textY, { width: 66, align: "right" });
    doc.text(formatMoney(total), xTotal + 8, textY, { width: 58, align: "right" });
    doc.moveTo(48, y + rowHeight).lineTo(564, y + rowHeight).stroke("#e2e8f0");
    y += rowHeight;
  });

  return y + 12;
}

function groupAlternateLineItems(items: QuotePdfLineItem[]) {
  const grouped = new Map<string, QuotePdfLineItem[]>();

  for (const item of items) {
    if (item.sectionType !== "ALTERNATE") continue;
    const key = item.sectionLabel?.trim() || "Alternate Option";
    const existing = grouped.get(key) ?? [];
    existing.push(item);
    grouped.set(key, existing);
  }

  return Array.from(grouped.entries()).map(([label, lineItems]) => ({
    label,
    lineItems,
    subtotal: lineItems.reduce((sum, lineItem) => sum + lineItem.quantity * lineItem.unitPrice, 0),
  }));
}

function drawTotals(doc: PDFKit.PDFDocument, y: number, data: QuotePdfData, totalsColor: string): number {
  y = ensureSpace(doc, y, 94);
  const boxX = 360;
  const boxWidth = 204;
  const boxHeight = 78;

  doc.roundedRect(boxX, y, boxWidth, boxHeight, 10).fillAndStroke("#ffffff", "#dbe3ef");
  doc.font("Helvetica").fontSize(10).fillColor("#334155");
  doc.text("Subtotal", boxX + 16, y + 13, { width: 90 });
  doc.text(formatMoney(data.customerPriceSubtotal), boxX + 112, y + 13, {
    width: 76,
    align: "right",
  });
  doc.text("Tax", boxX + 16, y + 31, { width: 90 });
  doc.text(formatMoney(data.taxAmount), boxX + 112, y + 31, { width: 76, align: "right" });
  doc.moveTo(boxX + 16, y + 50).lineTo(boxX + boxWidth - 16, y + 50).stroke("#e2e8f0");
  doc.font("Helvetica-Bold").fontSize(12).fillColor(totalsColor);
  doc.text("Total", boxX + 16, y + 58, { width: 90 });
  doc.text(formatMoney(data.totalAmount), boxX + 112, y + 58, { width: 76, align: "right" });
  return y + boxHeight + 10;
}

export async function generateQuotePdfBuffer(data: QuotePdfData): Promise<Buffer> {
  const templateId = safeTemplateId(data.branding.templateId);
  const theme = TEMPLATE_THEMES[templateId];
  const accentColor = safeHexColor(data.branding.primaryColor, theme.accentColor);
  const componentColors = resolveComponentColors(data.branding.componentColors, accentColor);
  const logoBuffer = await loadLogoBuffer(data.branding.logoUrl);
  const quoteFlyMarkBuffer = data.branding.showQuoteFlyAttribution ? await loadQuoteFlyMarkBuffer() : null;
  const includedLineItems = data.lineItems.filter((lineItem) => lineItem.sectionType !== "ALTERNATE");
  const alternateSections = groupAlternateLineItems(data.lineItems);

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

    let y = writeHeader(doc, data, theme, componentColors, logoBuffer);

    y = ensureSpace(doc, y, 130);
    const senderLines = buildSenderLines(data);
    const customerLines = [data.customer.fullName, data.customer.phone, data.customer.email ?? ""];
    const partyCardBottom = Math.max(
      drawPartyCard(doc, 48, y, 250, "Business", senderLines, componentColors.sectionTitleColor),
      drawPartyCard(doc, 314, y, 250, "Customer", customerLines, componentColors.sectionTitleColor),
    );
    y = partyCardBottom + 20;

    y = ensureSpace(doc, y, 62);
    doc.moveTo(48, y).lineTo(564, y).stroke("#e2e8f0");
    y += 14;
    doc.fillColor(componentColors.sectionTitleColor).font("Helvetica-Bold").fontSize(11);
    doc.text("Prepared", 48, y, { width: 230 });
    doc.text("Sent", 314, y, { width: 250 });
    y += 16;
    doc.fillColor("#222222").font("Helvetica-Bold").fontSize(10);
    doc.text(formatLocalDate(data.createdAt, data.tenant.timezone), 48, y, { width: 230 });
    doc.text(data.sentAt ? formatLocalDate(data.sentAt, data.tenant.timezone) : "N/A", 314, y, {
      width: 250,
    });
    y += 24;

    y = drawSectionTitle(doc, y, "Overview", componentColors.sectionTitleColor);
    doc.font("Helvetica").fontSize(10).fillColor("#222222");
    doc.text(data.scopeText, 48, y, { width: 516 });
    y = doc.y + 16;

    y = drawSectionTitle(doc, y, "Included Work", componentColors.sectionTitleColor);
    y = drawLineItemsTable(
      doc,
      y,
      includedLineItems,
      "Scope summary",
      componentColors.tableHeaderBgColor,
      componentColors.tableHeaderTextColor,
    );

    for (const section of alternateSections) {
      y = ensureSpace(doc, y, 110);
      y = drawSectionTitle(doc, y, section.label, componentColors.sectionTitleColor);
      doc.font("Helvetica").fontSize(9).fillColor("#64748b");
      doc.text("Optional pricing. This section is not included in the primary total below.", 48, y, {
        width: 516,
      });
      y = doc.y + 10;
      y = drawLineItemsTable(
        doc,
        y,
        section.lineItems,
        "Alternate scope summary",
        componentColors.tableHeaderBgColor,
        componentColors.tableHeaderTextColor,
      );
      doc.font("Helvetica-Bold").fontSize(10).fillColor(componentColors.totalsColor);
      doc.text("Alternate subtotal", 390, y, { width: 90, align: "left" });
      doc.text(formatMoney(section.subtotal), 478, y, { width: 86, align: "right" });
      y += 20;
    }

    y = drawTotals(doc, y, data, componentColors.totalsColor);

    y = ensureSpace(doc, y, data.branding.showQuoteFlyAttribution ? 66 : 48);
    doc.moveTo(48, y).lineTo(564, y).stroke("#d8d8d8");
    y += 8;
    doc.font("Helvetica").fontSize(9).fillColor(componentColors.footerTextColor);
    doc.text(buildFooterText(data), 48, y, { width: 516, align: "center" });
    y = doc.y + 4;

    if (data.branding.showQuoteFlyAttribution) {
      const attributionText = "Created with QuoteFly";
      doc.font("Helvetica").fontSize(8).fillColor(componentColors.footerTextColor);
      const textWidth = doc.widthOfString(attributionText);
      const iconSize = quoteFlyMarkBuffer ? 10 : 0;
      const gap = quoteFlyMarkBuffer ? 5 : 0;
      const totalWidth = iconSize + gap + textWidth;
      const startX = 306 - totalWidth / 2;

      if (quoteFlyMarkBuffer) {
        doc.image(quoteFlyMarkBuffer, startX, y - 1, { fit: [iconSize, iconSize] });
      }

      doc.text(attributionText, startX + iconSize + gap, y, {
        width: textWidth,
        align: "left",
      });
    }

    doc.end();
  });
}
