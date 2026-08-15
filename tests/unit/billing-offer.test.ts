import assert from "node:assert/strict";
import test from "node:test";
import type Stripe from "stripe";
import {
  BASIC_FIRST_PAID_MONTH_DISCOUNT_PERCENT,
  BASIC_MONTHLY_PRICE_CENTS,
  BASIC_TRIAL_DAYS,
  isExpectedBasicIntroCoupon,
  isExpectedBasicIntroCouponForPrice,
  isExpectedBasicMonthlyPrice,
} from "../../src/lib/billing-offer";

const BASIC_PRICE = {
  active: true,
  currency: "usd",
  type: "recurring",
  unit_amount: 2900,
  recurring: { interval: "month", interval_count: 1 },
} as Stripe.Price;

const BASIC_COUPON = {
  valid: true,
  duration: "once",
  percent_off: 50,
  amount_off: null,
} as Stripe.Coupon;

test("locks the published Basic billing contract", () => {
  assert.equal(BASIC_MONTHLY_PRICE_CENTS, 2900);
  assert.equal(BASIC_TRIAL_DAYS, 20);
  assert.equal(BASIC_FIRST_PAID_MONTH_DISCOUNT_PERCENT, 50);
  assert.equal(isExpectedBasicMonthlyPrice(BASIC_PRICE), true);
  assert.equal(isExpectedBasicIntroCoupon(BASIC_COUPON), true);
});

test("rejects Stripe offers that could overcharge or repeat the discount", () => {
  assert.equal(isExpectedBasicMonthlyPrice({ ...BASIC_PRICE, unit_amount: 1900 }), false);
  assert.equal(
    isExpectedBasicMonthlyPrice({
      ...BASIC_PRICE,
      recurring: { ...BASIC_PRICE.recurring!, interval: "year" },
    }),
    false,
  );
  assert.equal(isExpectedBasicIntroCoupon({ ...BASIC_COUPON, percent_off: 25 }), false);
  assert.equal(isExpectedBasicIntroCoupon({ ...BASIC_COUPON, duration: "forever" }), false);
  assert.equal(isExpectedBasicIntroCoupon({ id: "deleted", object: "coupon", deleted: true }), false);
  const productPrice = { ...BASIC_PRICE, product: "prod_basic" };
  assert.equal(
    isExpectedBasicIntroCouponForPrice(
      { ...BASIC_COUPON, applies_to: { products: ["prod_basic"] } },
      productPrice,
    ),
    true,
  );
  assert.equal(
    isExpectedBasicIntroCouponForPrice(
      { ...BASIC_COUPON, applies_to: { products: ["prod_other"] } },
      productPrice,
    ),
    false,
  );
});
