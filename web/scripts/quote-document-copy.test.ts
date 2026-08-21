import assert from "node:assert/strict";
import test from "node:test";
import {
  formatQuoteDocumentDate,
  formatQuoteDocumentMoney,
  quoteDocumentCopy,
} from "../src/lib/quote-document-copy";
import { buildQuoteFooterText } from "../src/components/quotes/quote-footer";

test("Spanish customer-document copy preserves accents and punctuation", () => {
  const copy = quoteDocumentCopy("es-US");

  assert.equal(copy.customerQuote, "Cotización para el cliente");
  assert.equal(copy.description, "Descripción");
  assert.equal(copy.questionsWithoutContact("Jardinería Peña"), "¿Tienes preguntas sobre esta cotización? Comunícate con Jardinería Peña.");
  assert.equal(copy.createdWithQuoteFly, "Creada con QuoteFly");
});

test("document money and dates use the explicit document locale while keeping USD", () => {
  assert.match(formatQuoteDocumentMoney(1234.5, "es-US"), /1,234\.50/);
  assert.match(formatQuoteDocumentMoney(1234.5, "es-US"), /\$/);
  assert.equal(
    formatQuoteDocumentDate("2026-08-20T23:30:00.000Z", "es-US", "America/Los_Angeles"),
    "20 ago 2026",
  );
  assert.equal(formatQuoteDocumentDate("not-a-date", "es-US"), "N/D");
});

test("built-in Spanish footer localizes only QuoteFly copy and preserves tenant text", () => {
  assert.equal(
    buildQuoteFooterText({
      businessName: "Jardinería Peña",
      businessPhone: "(555) 010-2026",
      businessEmail: "hola@example.com",
      documentLocale: "es-US",
    }),
    "¿Tienes preguntas sobre esta cotización? Comunícate con Jardinería Peña al (555) 010-2026 o hola@example.com.",
  );
});
