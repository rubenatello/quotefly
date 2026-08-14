import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeThemePreference,
  readThemePreference,
  resolveThemePreference,
  THEME_STORAGE_KEY,
  writeThemePreference,
} from "../src/lib/theme";

test("theme preference accepts only supported values", () => {
  assert.equal(normalizeThemePreference("system"), "system");
  assert.equal(normalizeThemePreference("light"), "light");
  assert.equal(normalizeThemePreference("dark"), "dark");
  assert.equal(normalizeThemePreference("sepia"), "system");
  assert.equal(normalizeThemePreference(null), "system");
});

test("system preference follows the device while explicit choices win", () => {
  assert.equal(resolveThemePreference("system", false), "light");
  assert.equal(resolveThemePreference("system", true), "dark");
  assert.equal(resolveThemePreference("light", true), "light");
  assert.equal(resolveThemePreference("dark", false), "dark");
});

test("theme storage is defensive in privacy-restricted browsers", () => {
  assert.equal(readThemePreference({ getItem: () => "dark" }), "dark");
  assert.equal(readThemePreference({ getItem: () => "invalid" }), "system");
  assert.equal(readThemePreference({ getItem: () => { throw new Error("blocked"); } }), "system");

  const writes: Array<[string, string]> = [];
  writeThemePreference({ setItem: (key, value) => { writes.push([key, value]); } }, "light");
  assert.deepEqual(writes, [[THEME_STORAGE_KEY, "light"]]);
  assert.doesNotThrow(() => {
    writeThemePreference({ setItem: () => { throw new Error("blocked"); } }, "dark");
  });
});
