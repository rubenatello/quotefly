import { strict as assert } from "node:assert";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const { KodySparkIcon } = await import("../src/components/ai/KodySparkIcon");

test("KodySparkIcon renders the code-native Kody mark and is accessible when titled", () => {
  const markup = renderToStaticMarkup(createElement(KodySparkIcon, {
    title: "Kody",
    size: 20,
    className: "text-current",
  }));

  assert.match(markup, /role="img"/);
  assert.match(markup, /aria-label="Kody"/);
  assert.match(markup, /<svg/);
  assert.match(markup, /fill="#2f6fd6"/);
  assert.match(markup, /fill="#ff8912"/);
  assert.doesNotMatch(markup, /<img/);
  assert.match(markup, /style="width:20px;height:20px"/);
  assert.match(markup, /<span role="img" aria-label="Kody"/);
});

test("KodySparkIcon thinking state is reduced-motion safe", () => {
  const markup = renderToStaticMarkup(createElement(KodySparkIcon, { thinking: true }));

  assert.match(markup, /aria-hidden="true"/);
  assert.match(markup, /qf-kody-spark-icon--thinking/);
  assert.match(markup, /qf-kody-spark-icon__spark/);
  assert.match(markup, /qf-kody-spark-pulse/);
  assert.match(markup, /prefers-reduced-motion: no-preference/);
});
