import assert from "node:assert/strict";
import test from "node:test";
import { parseChatToQuotePrompt } from "../../src/services/chat-to-quote";

test("keeps a direct customer and prepares a reconciled custom-table price breakdown", () => {
  const parsed = parseChatToQuotePrompt(
    "lets do a quote for Rober California for a construction job that we are building him a custom wooden table for a large dining area, cost of materials is $2000 and labor will be about $1500. Total job estimated to be about 3500",
  );

  assert.equal(parsed.customerName, "Rober California");
  assert.equal(parsed.serviceType, "CONSTRUCTION");
  assert.equal(parsed.title, "Custom Wooden Dining Table Quote");
  assert.equal(parsed.estimatedTotalAmount, 3500);
  assert.equal(parsed.estimatedInternalCostAmount, null);
  assert.equal(parsed.pricingConflict, null);
  assert.deepEqual(parsed.lineItems.map((line) => ({
    description: line.description,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    sectionType: line.sectionType,
  })), [{
    description: "Custom wooden table materials",
    quantity: 1,
    unitPrice: 2000,
    sectionType: "INCLUDED",
  }, {
    description: "Custom wooden table labor",
    quantity: 1,
    unitPrice: 1500,
    sectionType: "INCLUDED",
  }]);
});

test("still resolves a trailing customer when quote-for describes the work first", () => {
  const parsed = parseChatToQuotePrompt(
    "Kody I need a plumbing quote for faucet replacement for Maria Lopez. Please prepare it for review.",
  );

  assert.equal(parsed.customerName, "Maria Lopez");
  assert.equal(parsed.serviceType, "PLUMBING");
});

test("does not promote a lone component price into the whole quote total", () => {
  const parsed = parseChatToQuotePrompt(
    "Prepare a construction quote for Ana Gomez with $2000 for materials; labor still needs pricing.",
  );

  assert.equal(parsed.customerName, "Ana Gomez");
  assert.equal(parsed.estimatedTotalAmount, null);
  assert.equal(parsed.estimatedInternalCostAmount, null);
});

test("flags a stated total that contradicts the material and labor breakdown", () => {
  const parsed = parseChatToQuotePrompt(
    "Prepare a construction quote for Ana Gomez. Materials are $2000 and labor is $1500, but the total is $3000.",
  );

  assert.deepEqual(parsed.pricingConflict, {
    materialAmount: 2000,
    laborAmount: 1500,
    componentTotalAmount: 3500,
    statedTotalAmount: 3000,
  });
});
