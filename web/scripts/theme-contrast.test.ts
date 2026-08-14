import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cssPath = fileURLToPath(new URL("../src/index.css", import.meta.url));
const css = readFileSync(cssPath, "utf8");

function variableBlock(selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = css.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(block?.[1], `Expected ${selector} theme variables.`);
  return block[1];
}

function colorVariable(block: string, name: string) {
  const hexMatch = block.match(new RegExp(`--qf-${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`));
  if (hexMatch?.[1]) return hexMatch[1];

  const rgbMatch = block.match(new RegExp(`--qf-${name}:\\s*(\\d{1,3})\\s+(\\d{1,3})\\s+(\\d{1,3})\\s*;`));
  assert.ok(rgbMatch, `Expected --qf-${name} to use a testable hex or RGB color.`);
  const channels = rgbMatch.slice(1, 4).map((channel) => Number.parseInt(channel, 10));
  assert.ok(channels.every((channel) => channel >= 0 && channel <= 255), `Expected valid RGB channels for --qf-${name}.`);
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function channelToLinear(channel: number) {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string) {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  const [red, green, blue] = channels.map(channelToLinear);
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

function contrast(foreground: string, background: string) {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function expectContrast(
  block: string,
  foregroundName: string,
  backgroundName: string,
  minimum: number,
  label: string,
) {
  const foreground = colorVariable(block, foregroundName);
  const background = colorVariable(block, backgroundName);
  const ratio = contrast(foreground, background);
  assert.ok(
    ratio >= minimum,
    `${label} contrast ${ratio.toFixed(2)}:1 is below ${minimum}:1 (${foreground} on ${background}).`,
  );
}

const light = variableBlock(":root");
const dark = variableBlock("html.dark");

for (const [name, block] of [["light", light], ["dark", dark]] as const) {
  test(`${name} theme text and interactive colors meet contrast targets`, () => {
    expectContrast(block, "text-rgb", "panel-rgb", 4.5, `${name} primary text`);
    expectContrast(block, "text-soft-rgb", "panel-rgb", 4.5, `${name} secondary text`);
    expectContrast(block, "text-muted-rgb", "panel-rgb", 4.5, `${name} muted text`);
    expectContrast(block, "text-rgb", "interactive-hover", 4.5, `${name} hover text`);
    expectContrast(block, "focus", "panel-rgb", 3, `${name} focus indicator`);
  });
}

test("light theme semantic actions and statuses remain readable", () => {
  expectContrast(light, "action-primary-text", "action-primary", 4.5, "Primary button");
  expectContrast(light, "action-primary-text", "action-primary-hover", 4.5, "Primary button hover");
  expectContrast(light, "action-primary-text", "action-primary-active", 4.5, "Primary button active");
  expectContrast(light, "action-secondary-text", "action-secondary", 4.5, "Secondary button");
  expectContrast(light, "action-secondary-text", "action-secondary-hover", 4.5, "Secondary button hover");
  expectContrast(light, "action-secondary-text", "action-secondary-active", 4.5, "Secondary button active");
  expectContrast(light, "success-text", "success-surface", 4.5, "Success status");
  expectContrast(light, "warning-text", "warning-surface", 4.5, "Warning status");
  expectContrast(light, "danger-text", "danger-surface", 4.5, "Danger status");
  expectContrast(light, "info-text", "info-surface", 4.5, "Information status");
});

test("dark theme semantic actions and statuses remain readable", () => {
  expectContrast(dark, "action-primary-text", "action-primary", 4.5, "Dark primary button");
  expectContrast(dark, "action-primary-text", "action-primary-hover", 4.5, "Dark primary button hover");
  expectContrast(dark, "action-primary-text", "action-primary-active", 4.5, "Dark primary button active");
  expectContrast(dark, "action-secondary-text", "action-secondary", 4.5, "Dark secondary button");
  expectContrast(dark, "action-secondary-text", "action-secondary-hover", 4.5, "Dark secondary button hover");
  expectContrast(dark, "action-secondary-text", "action-secondary-active", 4.5, "Dark secondary button active");
  expectContrast(dark, "success-text", "success-surface", 4.5, "Dark success status");
  expectContrast(dark, "warning-text", "warning-surface", 4.5, "Dark warning status");
  expectContrast(dark, "danger-text", "danger-surface", 4.5, "Dark danger status");
  expectContrast(dark, "info-text", "info-surface", 4.5, "Dark information status");
});

test("strong lifecycle colors retain readable white labels", () => {
  for (const [token, label] of [
    ["info-strong", "Ready"],
    ["success-strong", "Won"],
    ["warning-strong", "Sent"],
    ["danger-strong", "Declined"],
  ] as const) {
    const ratio = contrast("#ffffff", colorVariable(light, token));
    assert.ok(ratio >= 4.5, `${label} lifecycle contrast ${ratio.toFixed(2)}:1 is below 4.5:1.`);
  }
});
