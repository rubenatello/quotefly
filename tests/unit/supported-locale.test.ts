import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SUPPORTED_LOCALE,
  normalizeSupportedLocale,
  SupportedLocaleSchema,
} from "../../src/lib/supported-locale";

test("supported locales accept only the product's exact English and Spanish tags", () => {
  assert.equal(SupportedLocaleSchema.parse("en-US"), "en-US");
  assert.equal(SupportedLocaleSchema.parse("es-US"), "es-US");
  assert.equal(SupportedLocaleSchema.safeParse("es-MX").success, false);
  assert.equal(SupportedLocaleSchema.safeParse("en-us").success, false);
});

test("locale normalization fails closed to the English product default", () => {
  assert.equal(DEFAULT_SUPPORTED_LOCALE, "en-US");
  assert.equal(normalizeSupportedLocale("es-US"), "es-US");
  assert.equal(normalizeSupportedLocale("unsupported"), "en-US");
  assert.equal(normalizeSupportedLocale(null), "en-US");
});
