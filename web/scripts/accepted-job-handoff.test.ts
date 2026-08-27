import assert from "node:assert/strict";
import test from "node:test";
import type { QuoteAcceptedJobSummary } from "../src/lib/api";
import { resolveAcceptedJobAction } from "../src/lib/accepted-job-handoff";

const job: QuoteAcceptedJobSummary = {
  id: "job-104",
  jobNumber: 104,
  status: "UNSCHEDULED",
};

test("accepted-job handoff preserves omitted mutation data but clears an explicit server null", () => {
  assert.equal(resolveAcceptedJobAction({
    current: job,
    quoteChanged: false,
    quoteIsAccepted: true,
    acceptedJob: undefined,
  }), job);
  assert.equal(resolveAcceptedJobAction({
    current: job,
    quoteChanged: false,
    quoteIsAccepted: true,
    acceptedJob: null,
  }), null);
});

test("accepted-job handoff clears stale state when the quote changes or is no longer accepted", () => {
  assert.equal(resolveAcceptedJobAction({
    current: job,
    quoteChanged: true,
    quoteIsAccepted: true,
    acceptedJob: undefined,
  }), null);
  assert.equal(resolveAcceptedJobAction({
    current: job,
    quoteChanged: false,
    quoteIsAccepted: false,
    acceptedJob: job,
  }), null);
});
