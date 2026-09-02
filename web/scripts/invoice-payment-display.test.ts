import { strict as assert } from "node:assert";
import test from "node:test";
import { invoicePaymentDisplay } from "../src/lib/invoice-payment-display";

test("current partial payment wins over a historical reversal marker", () => {
  assert.deepEqual(invoicePaymentDisplay({
    paymentStatus: "PARTIALLY_PAID",
    hasReversedPayment: true,
    amountPaid: 125,
    balanceDue: 375,
  }), {
    translationKey: "invoices.paymentPartiallyPaid",
    tone: "amber",
  });
});

test("a newly reversed payment is called out when money is owed again", () => {
  assert.deepEqual(invoicePaymentDisplay({
    paymentStatus: "PENDING",
    hasReversedPayment: true,
    amountPaid: 0,
    balanceDue: 500,
  }), {
    translationKey: "invoices.paymentReversed",
    tone: "amber",
  });
});

test("legacy pending records with a positive payment render as partially paid", () => {
  assert.deepEqual(invoicePaymentDisplay({
    paymentStatus: "PENDING",
    hasReversedPayment: false,
    amountPaid: "200.00",
    balanceDue: "300.00",
  }), {
    translationKey: "invoices.paymentPartiallyPaid",
    tone: "amber",
  });
});
