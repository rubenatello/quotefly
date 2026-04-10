# QuickBooks CSV Import (From QuoteFly Quotes)

QuoteFly now exports selected quotes as invoice-style CSV rows.

## In-App Flow

1. Open **App > Build > Quote List**.
2. Filter quotes if needed.
3. Check multiple quotes.
4. Set **Due in X days** (default `14`).
5. Click **Export QuickBooks CSV**.

Rule of thumb: **1 selected quote = 1 invoice** in QuickBooks.
- If a quote has multiple line items, QuoteFly keeps it as one invoice and emits multiple CSV rows sharing the same `Doc Number`.

## CSV Columns Included

- `Txn Type`
- `Doc Number`
- `Customer`
- `Customer Email`
- `Customer Phone`
- `Invoice Date`
- `Due Date`
- `Service Date`
- `Item Name`
- `Item Description`
- `Qty`
- `Rate`
- `Line Amount`
- `Tax Amount`
- `Invoice Total`
- `Currency`
- `Quote Title`
- `Quote ID`
- `Quote Status`
- `Internal Notes`

## QuickBooks Mapping Steps

1. In QuickBooks, start an invoice or sales import flow.
2. Upload the exported CSV.
3. Map fields:
   - Customer -> `Customer`
   - Invoice number/reference -> `Doc Number`
   - Invoice date -> `Invoice Date`
   - Due date -> `Due Date`
   - Item/Service -> `Item Name`
   - Description -> `Item Description`
   - Quantity -> `Qty`
   - Rate -> `Rate`
   - Amount -> `Line Amount`
4. Preview imported rows and totals.
5. Complete import.

## Notes

- QuoteFly exports one row per quote line item so invoice detail is preserved.
- If a quote has no line items, QuoteFly exports one fallback row using quote scope + subtotal.
- Keep `Doc Number` mapped to avoid duplicate invoice imports.
- Quote selection is capped at 100 quotes per export (QuickBooks-friendly import batch).
- If your QuickBooks edition does not support native invoice CSV import, use a CSV importer app and map the same fields.
