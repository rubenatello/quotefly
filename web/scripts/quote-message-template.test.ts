import assert from "node:assert/strict";
import test from "node:test";
import { buildQuoteMessageDraft } from "../src/lib/quote-message-template";

const baseInput = {
  customerName: "José Peña",
  quoteTitle: "Reparación del jardín",
  quoteTotalAmount: 1_250,
  scopeText: "Instalar césped y limpiar el área.",
};

test("built-in Spanish quote message localizes QuoteFly copy and preserves business content", () => {
  const draft = buildQuoteMessageDraft({
    ...baseInput,
    documentLocale: "es-US",
    branding: {
      primaryColor: "#2a7fd8",
      templateId: "modern",
      businessPhone: "(555) 123-4567",
      businessEmail: "ventas@example.com",
    },
  });

  assert.equal(draft.subject, "Reparación del jardín - Cotización");
  assert.match(draft.body, /Hola José Peña,/);
  assert.match(draft.body, /Gracias por la oportunidad de preparar esta cotización\./);
  assert.match(draft.body, /Instalar césped y limpiar el área\./);
  assert.match(draft.body, /Responda para confirmar o solicitar cambios\./);
});

test("custom tenant quote messages are not machine-translated", () => {
  const customTemplate = "Hello {customer_name}. Custom scope: {quote_scope}";
  const draft = buildQuoteMessageDraft({
    ...baseInput,
    documentLocale: "es-US",
    branding: {
      primaryColor: "#2a7fd8",
      templateId: "modern",
      quoteMessageTemplate: customTemplate,
    },
  });

  assert.equal(draft.body, "Hello José Peña. Custom scope: Instalar césped y limpiar el área.");
  assert.doesNotMatch(draft.body, /Gracias por la oportunidad/);
});

test("English remains the legacy fallback", () => {
  const draft = buildQuoteMessageDraft(baseInput);
  assert.equal(draft.subject, "Reparación del jardín - Quote");
  assert.match(draft.body, /Thanks for the opportunity to quote this project\./);
});
