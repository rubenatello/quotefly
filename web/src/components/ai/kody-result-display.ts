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

const QUOTE_FOLLOW_UP_FIELD_PRIORITY = [
  "quoteTitle",
  "attentionReason",
  "recommendedAction",
  "openFollowUpTaskTitle",
  "openFollowUpTaskDueAtUtc",
  "lastRecordedFollowUpAtUtc",
  "lastPostSendOutboundActivityAtUtc",
  "hasFollowUpNotes",
  "quoteAmount",
] as const;

const SCHEDULED_FOLLOW_UP_FIELD_PRIORITY = [
  "attentionReason",
  "dueSinceUtc",
  "dueBucket",
  "priority",
  "followUpStepNumber",
  "neverAttempted",
  "notSuccessfullyContacted",
] as const;

const CUSTOMER_FIELD_PRIORITY = [
  "fullName",
  "followUpStatus",
  "lostReason",
  "lostReasonNotes",
  "lostAtUtc",
  "lostByName",
  "email",
  "phone",
] as const;

function isHiddenResultKey(key: string) {
  return key === "id" || key === "version" || key === "followUpType" || key === "attentionRank" || key === "scheduleOpening" || key.endsWith("Version") || key.endsWith("Id") || key.endsWith("ID") || key.endsWith("RefHash");
}

export function visibleKodyResultEntries(
  result: Record<string, string | number | boolean | null>,
) {
  const productResult = "productId" in result || "unitType" in result;
  const invoiceResult = "invoiceId" in result || "invoiceNumber" in result;
  const followUpResult = "followUpType" in result || "attentionReason" in result;
  const customerResult = "customerId" in result && "fullName" in result;
  const entries = Object.entries(result)
    .filter(([key, value]) =>
      !isHiddenResultKey(key)
      && value !== null
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

  if (followUpResult) {
    const fieldPriority = result.followUpType === "SCHEDULED_CUSTOMER"
      ? SCHEDULED_FOLLOW_UP_FIELD_PRIORITY
      : QUOTE_FOLLOW_UP_FIELD_PRIORITY;
    const priority = new Map<string, number>(fieldPriority.map((key, index) => [key, index]));
    entries.sort(([left], [right]) =>
      (priority.get(left) ?? 99) - (priority.get(right) ?? 99));
  }

  if (customerResult && !followUpResult) {
    const priority = new Map(CUSTOMER_FIELD_PRIORITY.map((key, index) => [key, index]));
    entries.sort(([left], [right]) =>
      (priority.get(left as (typeof CUSTOMER_FIELD_PRIORITY)[number]) ?? 99)
      - (priority.get(right as (typeof CUSTOMER_FIELD_PRIORITY)[number]) ?? 99));
  }

  const followUpLimit = result.followUpType === "SCHEDULED_CUSTOMER"
    ? SCHEDULED_FOLLOW_UP_FIELD_PRIORITY.length
    : QUOTE_FOLLOW_UP_FIELD_PRIORITY.length;
  return entries.slice(0, invoiceResult
    ? INVOICE_FIELD_PRIORITY.length
    : followUpResult
      ? followUpLimit
      : customerResult
        ? CUSTOMER_FIELD_PRIORITY.length
        : 6);
}
