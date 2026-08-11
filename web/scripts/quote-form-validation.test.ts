import assert from "node:assert/strict";
import test from "node:test";
import { isCompleteQuoteLine, validateQuoteHeading, validateQuoteLine } from "../src/lib/quote-form-validation";

const validLine = {
  title: "Replace valve",
  sectionType: "INCLUDED" as const,
  sectionLabel: "",
  quantity: "1",
  unitCost: "25",
  unitPrice: "75",
};

test("quote heading validation matches API minimums and nonnegative tax", () => {
  assert.equal(validateQuoteHeading("Hi", "Valid scope", "0"), "Quote title must be at least 3 characters.");
  assert.equal(validateQuoteHeading("Valid", "No", "0"), "Quote scope must be at least 3 characters.");
  assert.equal(validateQuoteHeading("Valid", "Valid scope", "-1"), "Tax must be a valid amount of 0 or more.");
  assert.equal(validateQuoteHeading("Valid", "Valid scope", "0"), null);
});

test("quote line validation rejects values the API would reject", () => {
  assert.match(validateQuoteLine({ ...validLine, quantity: "0" }) ?? "", /greater than 0/);
  assert.match(validateQuoteLine({ ...validLine, unitCost: "-1" }) ?? "", /cost/);
  assert.match(validateQuoteLine({ ...validLine, unitPrice: "not-a-number" }) ?? "", /price/);
  assert.match(validateQuoteLine({ ...validLine, sectionLabel: "x".repeat(81) }) ?? "", /80 characters/);
  assert.equal(isCompleteQuoteLine(validLine), true);
});
