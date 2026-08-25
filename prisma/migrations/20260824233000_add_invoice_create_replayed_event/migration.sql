-- Preserve invoice creation idempotency for databases that applied the invoice
-- ledger migration before CREATE_REPLAYED was included in its enum definition.
ALTER TYPE "InvoiceEventType" ADD VALUE IF NOT EXISTS 'CREATE_REPLAYED';
