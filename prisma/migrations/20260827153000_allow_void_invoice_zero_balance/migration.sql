-- A voided invoice extinguishes the receivable without fabricating a payment.
-- Preserve the strict arithmetic invariant for every non-void invoice.
ALTER TABLE "Invoice"
    DROP CONSTRAINT "Invoice_balance_check";

ALTER TABLE "Invoice"
    ADD CONSTRAINT "Invoice_balance_check" CHECK (
        (
            "status" = 'VOID'
            AND "amountPaid" = 0
            AND "balanceDue" = 0
        )
        OR (
            "status" <> 'VOID'
            AND "balanceDue" = "totalAmount" - "amountPaid"
        )
    );
