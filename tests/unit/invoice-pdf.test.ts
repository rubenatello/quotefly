import assert from "node:assert/strict";
import test from "node:test";
import { renderInvoicePdf, type InvoicePdfData } from "../../src/services/invoice-pdf";

const trustedUrl = "https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-synthetic-test";

export function invoicePdfFixture(overrides: Partial<InvoicePdfData> = {}): InvoicePdfData {
  return {
    invoiceNumber: 1042, title: "Replace the kitchen faucet", scopeText: "Supply, install and test the replacement faucet.",
    documentLocale: "en-US", status: "OPEN", paymentStatus: "PARTIALLY_PAID", currency: "USD",
    issuedAtUtc: new Date("2026-11-08T00:30:00Z"), dueAtUtc: new Date("2026-12-08T18:00:00Z"), createdAt: new Date("2026-11-08T00:30:00Z"),
    business: { name: "North County Plumbing", timezone: "America/Los_Angeles", businessEmail: "office@example.com", businessPhone: "555-0100", addressLines: ["123 Example Road", "Example City, CA 90001"] },
    customerName: "Synthetic Customer", lineItems: [{ description: "Faucet and installation", quantity: 3, unitPrice: 33.333, lineTotal: 100 }],
    subtotalAmount: 100, taxAmount: 0, totalAmount: 100, amountPaid: 25, balanceDue: 75, hostedPaymentUrl: trustedUrl,
    ...overrides,
  };
}

function pdfText(pdf: Buffer): string {
  const runs: string[] = [];
  for (const array of pdf.toString("latin1").matchAll(/\[((?:.|\r|\n)*?)\]\s*TJ/g)) {
    runs.push([...array[1].matchAll(/<([0-9a-fA-F]+)>/g)].map(fragment => Buffer.from(fragment[1], "hex").toString("latin1")).join(""));
  }
  return runs.join("\n");
}

test("renders customer-safe invoice totals and an approved QuickBooks link annotation", async () => {
  const data = { ...invoicePdfFixture(), internalCostSubtotal: "INTERNAL_COST_SENTINEL", privateNote: "PRIVATE_STAFF_SENTINEL" };
  const pdf = await renderInvoicePdf(data, { compress: false });
  const text = pdfText(pdf);
  assert.ok(pdf.subarray(0, 5).equals(Buffer.from("%PDF-")));
  assert.match(text, /Invoice #1042/);
  assert.match(text, /North County Plumbing/);
  assert.match(text, /Faucet and installation/);
  assert.match(text, /\$100\.00/);
  assert.match(text, /\$75\.00/);
  assert.match(text, /Partially paid/);
  assert.match(text, /Pay securely with QuickBooks/);
  assert.ok(pdf.toString("latin1").includes(`/URI (${trustedUrl})`));
  assert.doesNotMatch(text, /INTERNAL_COST_SENTINEL|PRIVATE_STAFF_SENTINEL/);
  assert.equal(data.amountPaid, 25);
  assert.equal(data.balanceDue, 75);
});

test("invalid or absent links never become PDF actions", async () => {
  for (const hostedPaymentUrl of [null, "https://intuit.com.evil.example/pay", "javascript:alert(1)", "http://connect.intuit.com/pay", "https://user:password@connect.intuit.com/pay"]) {
    const pdf = await renderInvoicePdf(invoicePdfFixture({ hostedPaymentUrl }), { compress: false });
    assert.doesNotMatch(pdf.toString("latin1"), /\/URI\s*\(/);
    assert.doesNotMatch(pdfText(pdf), /Pay securely/);
  }
});

test("paid, void, draft and failed states suppress the payment button even with a trusted link", async () => {
  for (const overrides of [
    { status: "PAID", paymentStatus: "SUCCEEDED", balanceDue: 0 },
    { status: "VOID", balanceDue: 75 }, { status: "DRAFT", balanceDue: 75 },
    { paymentStatus: "FAILED", balanceDue: 75 }, { status: "OPEN", balanceDue: 0 },
  ]) {
    const pdf = await renderInvoicePdf(invoicePdfFixture(overrides), { compress: false });
    assert.doesNotMatch(pdf.toString("latin1"), /\/URI\s*\(/);
  }
});

test("uses stored line totals instead of recomputing quantity times unit price", async () => {
  const pdf = await renderInvoicePdf(invoicePdfFixture({ lineItems: [{ description: "Rounding-preserved line", quantity: 3, unitPrice: 33.33, lineTotal: 100 }] }), { compress: false });
  assert.match(pdfText(pdf), /\$100\.00/);
  assert.doesNotMatch(pdfText(pdf), /\$99\.99/);
});

test("long descriptions paginate with repeated table headings and retain the last line", async () => {
  const lines = Array.from({ length: 75 }, (_, index) => ({ description: `Service ${index + 1}: ${"A detailed customer-facing description of the work. ".repeat(6)}`, quantity: 1, unitPrice: 10, lineTotal: 10 }));
  lines.push({ description: "FINAL_VISIBLE_LINE", quantity: 1, unitPrice: 10, lineTotal: 10 });
  const pdf = await renderInvoicePdf(invoicePdfFixture({ lineItems: lines }), { compress: false });
  const pages = pdf.toString("latin1").match(/\/Type\s*\/Page\b/g)?.length ?? 0;
  assert.ok(pages > 3 && pages < 30);
  assert.match(pdfText(pdf), /FINAL_VISIBLE_LINE/);
  assert.ok((pdfText(pdf).match(/Description/g)?.length ?? 0) >= pages - 1);
});

test("localizes invoice labels and displays timestamps in the business timezone", async () => {
  const english = pdfText(await renderInvoicePdf(invoicePdfFixture(), { compress: false }));
  assert.match(english, /Nov 7, 2026/);
  const spanish = pdfText(await renderInvoicePdf(invoicePdfFixture({ documentLocale: "es-US" }), { compress: false }));
  assert.match(spanish, /Factura #1042/);
  assert.match(spanish, /Saldo pendiente/);
  assert.match(spanish, /Pagar de forma segura con QuickBooks/);
});

test("rejects malformed numeric data and unbounded document content", async () => {
  await assert.rejects(renderInvoicePdf(invoicePdfFixture({ balanceDue: Number.NaN })), /INVOICE_PDF_AMOUNT_INVALID/);
  await assert.rejects(renderInvoicePdf(invoicePdfFixture({ scopeText: "x".repeat(50_001) })), /INVOICE_PDF_CONTENT_TOO_LARGE/);
});
