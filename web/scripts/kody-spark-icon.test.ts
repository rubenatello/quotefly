import { strict as assert } from "node:assert";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const { KodySparkIcon } = await import("../src/components/ai/KodySparkIcon");

test("KodySparkIcon is theme-friendly and accessible when titled", () => {
  const markup = renderToStaticMarkup(createElement(KodySparkIcon, {
    title: "Kody",
    size: 20,
    className: "text-current",
  }));

  assert.match(markup, /role="img"/);
  assert.match(markup, />Kody<\/title>/);
  assert.match(markup, /stroke="currentColor"/);
  assert.match(markup, /width="20"/);
  assert.match(markup, /height="20"/);
  assert.doesNotMatch(markup, /aria-hidden="true"/);
});

test("KodySparkIcon thinking state is reduced-motion safe", () => {
  const markup = renderToStaticMarkup(createElement(KodySparkIcon, { thinking: true }));

  assert.match(markup, /aria-hidden="true"/);
  assert.match(markup, /qf-kody-spark-icon--thinking/);
  assert.match(markup, /qf-kody-spark-icon__spark/);
  assert.match(markup, /qf-kody-spark-icon__wing/);
  assert.match(markup, /prefers-reduced-motion: no-preference/);
});
