const PRODUCT_FIELD_PRIORITY = [
  "unitPrice",
  "unitCost",
  "description",
  "serviceType",
  "category",
  "unitType",
  "defaultQuantity",
] as const;

const INVOICE_FIELD_PRIORITY = [
  "invoiceNumber",
  "status",
  "paymentStatus",
  "totalAmount",
  "amountPaid",
  "balanceDue",
  "customerName",
  "jobNumber",
] as const;

function isHiddenResultKey(key: string) {
  return key === "id" || key === "version" || key.endsWith("Version") || key.endsWith("Id") || key.endsWith("ID") || key.endsWith("RefHash");
}

export function visibleKodyResultEntries(
  result: Record<string, string | number | boolean | null>,
) {
  const productResult = "productId" in result || "unitType" in result;
  const invoiceResult = "invoiceId" in result || "invoiceNumber" in result;
  const entries = Object.entries(result)
    .filter(([key]) =>
      !isHiddenResultKey(key)
      && !(productResult && key === "name")
      && !(invoiceResult && key === "title"));

  if (productResult) {
    const priority = new Map(PRODUCT_FIELD_PRIORITY.map((key, index) => [key, index]));
    entries.sort(([left], [right]) =>
      (priority.get(left as (typeof PRODUCT_FIELD_PRIORITY)[number]) ?? 99)
      - (priority.get(right as (typeof PRODUCT_FIELD_PRIORITY)[number]) ?? 99));
  }

  if (invoiceResult) {
    const priority = new Map(INVOICE_FIELD_PRIORITY.map((key, index) => [key, index]));
    entries.sort(([left], [right]) =>
      (priority.get(left as (typeof INVOICE_FIELD_PRIORITY)[number]) ?? 99)
      - (priority.get(right as (typeof INVOICE_FIELD_PRIORITY)[number]) ?? 99));
  }

  return entries.slice(0, invoiceResult ? INVOICE_FIELD_PRIORITY.length : 6);
}
