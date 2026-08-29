import type { TFunction } from "i18next";
import type { CustomerLostReason } from "../../lib/api";

export function customerLostReasonLabel(reason: CustomerLostReason, t: TFunction): string {
  return t(`customers.lifecycle.reasons.${reason}`);
}
