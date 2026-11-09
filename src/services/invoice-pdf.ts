import PDFDocument from "pdfkit";
import { validateQuickBooksInvoiceLink } from "./quickbooks";

/** Customer document input. Do not pass ORM records or provider payloads here. */
export interface InvoicePdfData {
  invoiceNumber: number | string;
  title: string;
  scopeText: string;
  documentLocale?: "en-US" | "es-US";
  status: string;
  paymentStatus: string;
  currency: string;
  issuedAtUtc: Date | null;
  dueAtUtc: Date | null;
  createdAt: Date;
  business: {
    name: string;
    timezone: string;
    businessEmail?: string | null;
    businessPhone?: string | null;
    addressLines?: string[];
  };
  customerName: string;
  lineItems: Array<{ description: string; quantity: number; unitPrice: number; lineTotal: number }>;
  subtotalAmount: number;
  taxAmount: number;
  totalAmount: number;
  amountPaid: number;
  balanceDue: number;
  hostedPaymentUrl: string | null;
}

const labels = {
  "en-US": {
    invoice: "Invoice", customer: "Bill to", issued: "Issued", due: "Due", created: "Created",
    description: "Description", quantity: "Qty", price: "Unit price", amount: "Amount",
    subtotal: "Subtotal", tax: "Tax", total: "Invoice total", paid: "Payments received", balance: "Balance due",
    pay: "Pay securely with QuickBooks", snapshot: "Amounts reflect this document when it was generated. QuickBooks shows the current balance and available payment methods.",
    plainSnapshot: "Amounts reflect this document when it was generated. Contact the business for the current balance.",
    page: "Page", draft: "Draft", open: "Open", settled: "Paid", void: "Void", uncollectible: "Uncollectible",
    pending: "Awaiting payment", partial: "Partially paid", refunded: "Refunded", partialRefund: "Partially refunded", failed: "Payment needs attention", canceled: "Canceled",
  },
  "es-US": {
    invoice: "Factura", customer: "Facturar a", issued: "Emitida", due: "Vencimiento", created: "Creada",
    description: "Descripción", quantity: "Cant.", price: "Precio unitario", amount: "Importe",
    subtotal: "Subtotal", tax: "Impuesto", total: "Total de factura", paid: "Pagos recibidos", balance: "Saldo pendiente",
    pay: "Pagar de forma segura con QuickBooks", snapshot: "Los importes reflejan el documento cuando se generó. QuickBooks muestra el saldo actual y los métodos de pago disponibles.",
    plainSnapshot: "Los importes reflejan el documento cuando se generó. Comuníquese con la empresa para consultar el saldo actual.",
    page: "Página", draft: "Borrador", open: "Abierta", settled: "Pagada", void: "Anulada", uncollectible: "Incobrable",
    pending: "Pendiente de pago", partial: "Pagada parcialmente", refunded: "Reembolsada", partialRefund: "Reembolsada parcialmente", failed: "El pago necesita atención", canceled: "Cancelada",
  },
} as const;

function safeText(value: string): string {
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/** No network, provider, ledger or sending side effects. */
export async function renderInvoicePdf(data: InvoicePdfData, options: { compress?: boolean } = {}): Promise<Buffer> {
  const locale = data.documentLocale === "es-US" ? "es-US" : "en-US";
  const text = labels[locale];
  const numeric = [data.subtotalAmount, data.taxAmount, data.totalAmount, data.amountPaid, data.balanceDue,
    ...data.lineItems.flatMap(line => [line.quantity, line.unitPrice, line.lineTotal])];
  if (!/^[A-Z]{3}$/.test(data.currency) || numeric.some(value => !Number.isFinite(value))) {
    throw new Error("INVOICE_PDF_AMOUNT_INVALID");
  }
  const fields = [data.title, data.scopeText, data.customerName, data.business.name,
    data.business.businessEmail ?? "", data.business.businessPhone ?? "", ...(data.business.addressLines ?? []),
    ...data.lineItems.map(line => line.description)];
  if (data.lineItems.length > 750 || fields.some(value => value.length > 50_000)
    || fields.reduce((sum, value) => sum + value.length, 0) > 300_000) {
    throw new Error("INVOICE_PDF_CONTENT_TOO_LARGE");
  }
  const paymentStatusAllowsCollection = ["PENDING", "PARTIALLY_PAID", "REFUNDED", "PARTIALLY_REFUNDED"].includes(data.paymentStatus);
  const paymentUrl = data.status === "OPEN" && data.balanceDue > 0 && paymentStatusAllowsCollection
    ? validateQuickBooksInvoiceLink(data.hostedPaymentUrl) : null;
  let timezone = data.business.timezone;
  try { new Intl.DateTimeFormat(locale, { timeZone: timezone }).format(data.createdAt); } catch { timezone = "UTC"; }
  const date = (value: Date) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: timezone }).format(value);
  const money = (value: number) => new Intl.NumberFormat(locale, { style: "currency", currency: data.currency }).format(value);
  const quantity = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(value);
  const invoiceNumber = safeText(String(data.invoiceNumber));
  const doc = new PDFDocument({ size: "LETTER", margin: 48, autoFirstPage: false, compress: options.compress ?? true,
    info: { Title: `${text.invoice} ${invoiceNumber}`, Author: safeText(data.business.name), Subject: text.invoice } });
  const chunks: Buffer[] = [];
  const complete = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const left = 48;
  const width = 516;
  const bottom = 724;
  let y = 90;
  let page = 0;
  let tableActive = false;
  const setFont = (size = 10, bold = false) => doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor("#172334");
  const drawTableHeader = () => {
    doc.rect(left, y, width, 24).fill("#edf2f6");
    setFont(9, true);
    doc.text(text.description, 56, y + 7, { width: 246, lineBreak: false });
    doc.text(text.quantity, 308, y + 7, { width: 44, align: "right", lineBreak: false });
    doc.text(text.price, 364, y + 7, { width: 92, align: "right", lineBreak: false });
    doc.text(text.amount, 466, y + 7, { width: 90, align: "right", lineBreak: false });
    y += 32;
  };
  const nextPage = () => {
    page += 1;
    if (page > 80) throw new Error("INVOICE_PDF_CONTENT_TOO_LARGE");
    doc.addPage();
    setFont(10, true);
    doc.text(`${text.invoice} #${invoiceNumber}`, left, 46, { width: 390, lineBreak: false });
    setFont(9);
    doc.text(`${text.page} ${page}`, 450, 46, { width: 114, align: "right", lineBreak: false });
    doc.moveTo(left, 68).lineTo(left + width, 68).strokeColor("#d8e0e7").stroke();
    y = 88;
    if (tableActive) drawTableHeader();
  };
  const ensureSpace = (height: number) => { if (y + height > bottom) nextPage(); };
  const wrap = (value: string, targetWidth: number, size: number, bold = false): string[] => {
    setFont(size, bold);
    const result: string[] = [];
    for (const paragraph of safeText(value).split(/\r?\n/)) {
      let line = "";
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        if (line && doc.widthOfString(`${line} ${word}`) <= targetWidth) { line += ` ${word}`; continue; }
        if (line) result.push(line);
        line = "";
        for (const character of word) {
          if (line && doc.widthOfString(line + character) > targetWidth) { result.push(line); line = ""; }
          line += character;
        }
      }
      result.push(line);
    }
    return result;
  };
  const block = (value: string, size = 10, bold = false, gap = 5) => {
    const lineHeight = size * 1.35;
    for (const line of wrap(value, width, size, bold)) {
      ensureSpace(lineHeight);
      setFont(size, bold).text(line, left, y, { width, lineBreak: false });
      y += lineHeight;
    }
    y += gap;
  };
  const numericCell = (value: string, x: number, targetWidth: number, bold = false, preferredSize = 10) => {
    setFont(preferredSize, bold);
    const measured = doc.widthOfString(value);
    const size = Math.min(preferredSize, Math.max(6, preferredSize * targetWidth / Math.max(measured, 1)));
    setFont(size, bold);
    if (doc.widthOfString(value) > targetWidth + 0.1) throw new Error("INVOICE_PDF_AMOUNT_INVALID");
    doc.text(value, x, y, { width: targetWidth, align: "right", lineBreak: false });
  };
  try {
    nextPage();
    block(data.business.name, 21, true, 8);
    for (const contact of [data.business.businessEmail, data.business.businessPhone, ...(data.business.addressLines ?? [])]) {
      if (contact) block(contact, 9, false, 2);
    }
    y += 12;
    block(`${text.customer}: ${data.customerName}`, 11, true);
    const status = ({ DRAFT: text.draft, OPEN: text.open, PAID: text.settled, VOID: text.void, UNCOLLECTIBLE: text.uncollectible } as Record<string, string>)[data.status] ?? text.open;
    const payment = ({ PENDING: text.pending, PARTIALLY_PAID: text.partial, SUCCEEDED: text.settled, REFUNDED: text.refunded,
      PARTIALLY_REFUNDED: text.partialRefund, FAILED: text.failed, CANCELED: text.canceled } as Record<string, string>)[data.paymentStatus] ?? text.pending;
    block(`${status} - ${payment}`, 10);
    block(`${data.issuedAtUtc ? text.issued : text.created}: ${date(data.issuedAtUtc ?? data.createdAt)}`, 9);
    if (data.dueAtUtc) block(`${text.due}: ${date(data.dueAtUtc)}`, 9);
    y += 8;
    block(data.title, 15, true, 7);
    if (data.scopeText) block(data.scopeText, 10, false, 14);
    ensureSpace(56);
    tableActive = true;
    drawTableHeader();
    for (const line of data.lineItems) {
      const description = wrap(line.description, 246, 10);
      // Keep ordinary rows together; exceptionally long descriptions may span pages.
      const rowHeight = description.length * 14 + 11;
      if (rowHeight <= bottom - 120) ensureSpace(rowHeight);
      for (let index = 0; index < description.length; index += 1) {
        ensureSpace(15);
        setFont(10).text(description[index], 56, y, { width: 246, lineBreak: false });
        if (index === 0) {
          numericCell(quantity(line.quantity), 308, 44);
          numericCell(money(line.unitPrice), 364, 92);
          // Stored immutable invoice line total is authoritative; never recalculate it.
          numericCell(money(line.lineTotal), 466, 90);
        }
        y += 14;
      }
      y += 8;
      doc.moveTo(left, y - 3).lineTo(left + width, y - 3).strokeColor("#e6ebef").stroke();
    }
    tableActive = false;
    y += 12;
    ensureSpace(150);
    for (const [label, value, bold] of [[text.subtotal, data.subtotalAmount, false], [text.tax, data.taxAmount, false],
      [text.total, data.totalAmount, true], [text.paid, data.amountPaid, false], [text.balance, data.balanceDue, true]] as const) {
      setFont(11, bold);
      doc.text(label, 302, y, { width: 150, align: "right", lineBreak: false });
      numericCell(money(value), 462, 102, bold, 11);
      y += 24;
    }
    y += 12;
    if (paymentUrl) {
      ensureSpace(100);
      doc.roundedRect(left, y, width, 42, 6).fill("#175d45");
      doc.font("Helvetica-Bold").fontSize(12).fillColor("#ffffff").text(text.pay, left + 10, y + 14, { width: width - 20, align: "center", lineBreak: false });
      doc.link(left, y, width, 42, paymentUrl);
      y += 56;
    }
    block(paymentUrl ? text.snapshot : text.plainSnapshot, 9);
    doc.end();
  } catch (error) {
    doc.destroy();
    // Consume the stream completion if destroy emits an asynchronous error.
    void complete.catch(() => undefined);
    throw error;
  }
  return complete;
}
