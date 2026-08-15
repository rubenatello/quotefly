import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const { KodySparkIcon } = await import("../src/components/ai/KodySparkIcon");

test("KodySparkIcon renders the Kody mascot asset and is accessible when titled", async () => {
  const markup = renderToStaticMarkup(createElement(KodySparkIcon, {
    title: "Kody",
    size: 20,
    className: "text-current",
  }));

  assert.match(markup, /role="img"/);
  assert.match(markup, /aria-label="Kody"/);
  assert.match(markup, /src="\/images\/kody\/kody-ai\.png"/);
  assert.match(markup, /style="width:20px;height:20px"/);
  assert.match(markup, /<span role="img" aria-label="Kody"/);

  const asset = await readFile(new URL("../public/images/kody/kody-ai.png", import.meta.url));
  assert.equal(asset.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(asset.readUInt32BE(16), 1254);
  assert.equal(asset.readUInt32BE(20), 1254);
});

test("KodySparkIcon thinking state is reduced-motion safe", () => {
  const markup = renderToStaticMarkup(createElement(KodySparkIcon, { thinking: true }));

  assert.match(markup, /aria-hidden="true"/);
  assert.match(markup, /qf-kody-spark-icon--thinking/);
  assert.match(markup, /qf-kody-spark-icon__image/);
  assert.match(markup, /qf-kody-avatar-pulse/);
  assert.match(markup, /prefers-reduced-motion: no-preference/);
});
