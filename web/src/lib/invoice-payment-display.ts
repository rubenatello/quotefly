import type { InvoicePaymentStatus } from "./api";

type InvoicePaymentDisplayInput = {
  paymentStatus: InvoicePaymentStatus;
  hasReversedPayment: boolean;
  amountPaid: string | number;
  balanceDue: string | number;
};

export type InvoicePaymentDisplay = {
  translationKey:
    | "invoices.paymentPartiallyPaid"
    | "invoices.paymentReversed"
    | `domain.invoicePaymentStatus.${InvoicePaymentStatus}`;
  tone: "slate" | "emerald" | "red" | "amber";
};

export function invoicePaymentDisplay(input: InvoicePaymentDisplayInput): InvoicePaymentDisplay {
  const amountPaid = Number(input.amountPaid);
  const balanceDue = Number(input.balanceDue);
  const hasPositivePaidBalance = amountPaid > 0 && balanceDue > 0;

  // A current partial balance takes precedence over a historical reversal marker.
  if (input.paymentStatus === "PARTIALLY_PAID" || (input.paymentStatus === "PENDING" && hasPositivePaidBalance)) {
    return { translationKey: "invoices.paymentPartiallyPaid", tone: "amber" };
  }
  if (input.hasReversedPayment && balanceDue > 0) {
    return { translationKey: "invoices.paymentReversed", tone: "amber" };
  }
  if (input.paymentStatus === "SUCCEEDED") {
    return { translationKey: "domain.invoicePaymentStatus.SUCCEEDED", tone: "emerald" };
  }
  if (input.paymentStatus === "FAILED" || input.paymentStatus === "CANCELED") {
    return { translationKey: `domain.invoicePaymentStatus.${input.paymentStatus}`, tone: "red" };
  }
  if (input.paymentStatus === "REFUNDED" || input.paymentStatus === "PARTIALLY_REFUNDED") {
    return { translationKey: `domain.invoicePaymentStatus.${input.paymentStatus}`, tone: "amber" };
  }
  return { translationKey: `domain.invoicePaymentStatus.${input.paymentStatus}`, tone: "slate" };
}
