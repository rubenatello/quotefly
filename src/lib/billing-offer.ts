import Stripe from "stripe";

export const BASIC_MONTHLY_PRICE_USD = 29;
export const BASIC_MONTHLY_PRICE_CENTS = BASIC_MONTHLY_PRICE_USD * 100;
export const BASIC_TRIAL_DAYS = 20;
export const BASIC_FIRST_PAID_MONTH_DISCOUNT_PERCENT = 50;
export const BASIC_INTRO_OFFER_CODE = "basic_first_paid_month_half_off";

export function isExpectedBasicMonthlyPrice(price: Stripe.Price): boolean {
  return (
    price.active === true &&
    price.type === "recurring" &&
    price.currency.toLowerCase() === "usd" &&
    price.unit_amount === BASIC_MONTHLY_PRICE_CENTS &&
    price.recurring?.interval === "month" &&
    price.recurring.interval_count === 1
  );
}

export function isExpectedBasicIntroCoupon(
  coupon: Stripe.Coupon | Stripe.DeletedCoupon,
): coupon is Stripe.Coupon {
  if ("deleted" in coupon && coupon.deleted) return false;
  return (
    coupon.valid === true &&
    coupon.duration === "once" &&
    coupon.percent_off === BASIC_FIRST_PAID_MONTH_DISCOUNT_PERCENT &&
    coupon.amount_off === null
  );
}

export function isExpectedBasicIntroCouponForPrice(
  coupon: Stripe.Coupon | Stripe.DeletedCoupon,
  price: Stripe.Price,
): coupon is Stripe.Coupon {
  if (!isExpectedBasicIntroCoupon(coupon)) return false;
  const restrictedProductIds = coupon.applies_to?.products ?? [];
  if (restrictedProductIds.length === 0) return true;
  const priceProductId =
    typeof price.product === "string" ? price.product : price.product?.id ?? null;
  return priceProductId !== null && restrictedProductIds.includes(priceProductId);
}
