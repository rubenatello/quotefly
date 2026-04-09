import PDFDocument from "pdfkit";

export type QuotePdfTemplateId = "modern" | "professional" | "bold" | "minimal" | "classic";

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
  };
  lineItems: QuotePdfLineItem[];
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

function safeTemplateId(templateId: string): QuotePdfTemplateId {
  if (templateId === "professional" || templateId === "bold" || templateId === "minimal" || templateId === "classic") {
    return templateId;
  }
  return "modern";
}

function safeHexColor(color: string, fallback: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : fallback;
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
  accentColor: string,
  logoBuffer: Buffer | null,
): number {
  const left = 48;
  const right = doc.page.width - 48;
  const width = right - left;
  const quoteLabel = `Quote #${data.quoteId.slice(0, 8).toUpperCase()}`;

  if (theme.headerStyle === "bar") {
    doc.rect(0, 0, doc.page.width, 110).fill(accentColor);
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, left, 26, { fit: [88, 56] });
      } catch {
        // Ignore bad image payloads and continue without logo rendering.
      }
    }
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(21).text(data.tenant.name, left + (logoBuffer ? 100 : 0), 28);
    doc.font("Helvetica").fontSize(11).text(quoteLabel, left + (logoBuffer ? 100 : 0), 58);
    doc.text(`Status: ${data.status}`, left + (logoBuffer ? 100 : 0), 74);
    doc.fillColor("#111111");
    return 132;
  }

  if (theme.headerStyle === "block") {
    doc.rect(0, 0, doc.page.width, 150).fill(accentColor);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(26).text("QUOTE", left, 30);
    doc.font("Helvetica").fontSize(11).text(`${data.tenant.name}`, left, 66);
    doc.text(quoteLabel, left, 82);
    doc.text(`Created: ${data.createdAt.toLocaleDateString()}`, left, 98);
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
    doc.fillColor(accentColor).font("Helvetica-Bold").fontSize(19).text(data.tenant.name, left + (logoBuffer ? 100 : 14), 46);
    doc.fillColor(theme.textDark).font("Helvetica").fontSize(11).text(quoteLabel, left + (logoBuffer ? 100 : 14), 72);
    doc.text(`Status: ${data.status}`, left + (logoBuffer ? 100 : 14), 88);
    doc.fillColor("#111111");
    return 136;
  }

  doc.fillColor(accentColor).font("Helvetica-Bold").fontSize(23).text(data.tenant.name, left, 42);
  doc.font("Helvetica").fontSize(11).fillColor("#555555").text(quoteLabel, left, 72);
  doc.text(`Status: ${data.status}`, left, 88);
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

function drawSectionTitle(doc: PDFKit.PDFDocument, y: number, title: string, accentColor: string): number {
  doc.fillColor(accentColor).font("Helvetica-Bold").fontSize(12).text(title, 48, y);
  return y + 18;
}

function ensureSpace(doc: PDFKit.PDFDocument, y: number, minSpace: number): number {
  const bottomLimit = doc.page.height - 64;
  if (y + minSpace <= bottomLimit) return y;
  doc.addPage();
  return 56;
}

function drawLineItemsTable(
  doc: PDFKit.PDFDocument,
  yStart: number,
  items: QuotePdfLineItem[],
  accentColor: string,
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

  doc.rect(48, y, 516, 24).fill(accentColor);
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(10);
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

function drawTotals(doc: PDFKit.PDFDocument, y: number, data: QuotePdfData, accentColor: string): number {
  const xLabel = 386;
  const xValue = 492;
  doc.font("Helvetica").fontSize(10).fillColor("#333333");
  doc.text("Subtotal", xLabel, y, { width: 90, align: "right" });
  doc.text(formatMoney(data.customerPriceSubtotal), xValue, y, { width: 72, align: "right" });
  y += 16;
  doc.text("Tax", xLabel, y, { width: 90, align: "right" });
  doc.text(formatMoney(data.taxAmount), xValue, y, { width: 72, align: "right" });
  y += 20;
  doc.font("Helvetica-Bold").fontSize(12).fillColor(accentColor);
  doc.text("Total", xLabel, y, { width: 90, align: "right" });
  doc.text(formatMoney(data.totalAmount), xValue, y, { width: 72, align: "right" });
  return y + 28;
}

export async function generateQuotePdfBuffer(data: QuotePdfData): Promise<Buffer> {
  const templateId = safeTemplateId(data.branding.templateId);
  const theme = TEMPLATE_THEMES[templateId];
  const accentColor = safeHexColor(data.branding.primaryColor, theme.accentColor);
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

    let y = writeHeader(doc, data, theme, accentColor, logoBuffer);

    doc.fillColor("#222222").font("Helvetica-Bold").fontSize(16).text(data.title, 48, y);
    y += 24;
    doc.font("Helvetica").fontSize(10).fillColor("#444444");
    doc.text(`Service: ${data.serviceType}`, 48, y);
    doc.text(`Created: ${data.createdAt.toLocaleDateString()}`, 230, y);
    doc.text(`Sent: ${data.sentAt ? data.sentAt.toLocaleDateString() : "Not sent"}`, 390, y);
    y += 20;

    y = drawSectionTitle(doc, y, "Customer", accentColor);
    doc.font("Helvetica").fontSize(11).fillColor("#222222");
    doc.text(data.customer.fullName, 48, y);
    y += 14;
    doc.text(data.customer.phone, 48, y);
    if (data.customer.email) {
      y += 14;
      doc.text(data.customer.email, 48, y);
    }
    y += 18;

    y = drawSectionTitle(doc, y, "Scope", accentColor);
    doc.font("Helvetica").fontSize(10).fillColor("#222222");
    doc.text(data.scopeText, 48, y, { width: 516 });
    y = doc.y + 16;

    y = drawSectionTitle(doc, y, "Line Items", accentColor);
    y = drawLineItemsTable(doc, y, data.lineItems, accentColor);
    y = drawTotals(doc, y, data, accentColor);

    y = ensureSpace(doc, y, 60);
    doc.moveTo(48, y).lineTo(564, y).stroke("#d8d8d8");
    y += 10;
    doc.font("Helvetica").fontSize(9).fillColor("#666666");
    doc.text(
      `Generated by QuoteFly for ${data.tenant.name} (${data.tenant.timezone}). Stored and rendered from UTC.`,
      48,
      y,
      { width: 516, align: "center" },
    );

    doc.end();
  });
}
