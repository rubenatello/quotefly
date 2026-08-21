import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { enUS } from "../src/i18n/locales/en-US";
import { esUS } from "../src/i18n/locales/es-US";

const assistantPath = new URL("../src/components/ai/KodyAssistant.tsx", import.meta.url);
const buttonPath = new URL("../src/components/ai/KodyButton.tsx", import.meta.url);
const normalizationPath = new URL("../src/components/ai/kody-response-normalization.ts", import.meta.url);
const englishPath = new URL("../src/i18n/locales/en-US.ts", import.meta.url);
const spanishPath = new URL("../src/i18n/locales/es-US.ts", import.meta.url);

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return prefix ? [prefix] : [];
  return Object.entries(value).flatMap(([key, nested]) => flattenKeys(nested, prefix ? `${prefix}.${key}` : key));
}

test("Kody English and Spanish resources have exact key parity", () => {
  assert.deepEqual(flattenKeys(enUS.kody).sort(), flattenKeys(esUS.kody).sort());
});

test("Kody interface copy is locale-backed", async () => {
  const [assistant, button, english, spanish] = await Promise.all([
    readFile(assistantPath, "utf8"),
    readFile(buttonPath, "utf8"),
    readFile(englishPath, "utf8"),
    readFile(spanishPath, "utf8"),
  ]);

  assert.match(assistant, /useTranslation\(\)/);
  assert.match(button, /t\("kody\.button"\)/);
  assert.match(english, /kody:\s*\{/);
  assert.match(spanish, /kody:\s*\{/);
  assert.match(spanish, /Pregúntale a Kody/);
  assert.doesNotMatch(assistant, /aria-label="Ask Kody"|>Suggested actions<|>Sources & safety<|"Thinking\.\.\."/);
});

test("Kody keeps semantic routing language-neutral and tenant content verbatim", async () => {
  const [assistant, normalization] = await Promise.all([
    readFile(assistantPath, "utf8"),
    readFile(normalizationPath, "utf8"),
  ]);

  assert.match(assistant, /if \(action\.type === "OPEN_CUSTOMER"\)/);
  assert.match(assistant, /routes: Record<string, string>/);
  assert.match(assistant, /if \(tenantTitle\) return tenantTitle/);
  assert.doesNotMatch(assistant, /navigate\([^\n]*action\.label/);
  assert.match(normalization, /return type;/);
});

test("Kody result formatting uses the active locale and tenant timezone", async () => {
  const assistant = await readFile(assistantPath, "utf8");
  assert.match(assistant, /new Intl\.NumberFormat\(locale/);
  assert.match(assistant, /new Intl\.DateTimeFormat\(locale/);
  assert.match(assistant, /formatKodyDate\(value, locale, displayTimeZone\)/);
  assert.doesNotMatch(assistant, /Intl\.NumberFormat\(undefined/);
  assert.doesNotMatch(assistant, /value\.toLocaleString\(\)/);
});
