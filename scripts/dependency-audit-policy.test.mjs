import test from "node:test";
import assert from "node:assert/strict";
import { acceptedPolicyFor, resolveAcceptedVulnerabilityPackages } from "./dependency-audit-policy.mjs";

const esbuildFinding = {
  workspace: "Web",
  packageName: "esbuild",
  vulnerability: { nodes: ["node_modules/esbuild"] },
  via: { url: "https://github.com/advisories/GHSA-g7r4-m6w7-qqqr" },
};

test("rejects advisories when no exception is documented", () => {
  assert.equal(
    acceptedPolicyFor({
      ...esbuildFinding,
      lockPackages: { "node_modules/esbuild": { version: "0.27.7", dev: true } },
    }),
    null,
  );
});

test("rejects an advisory cycle with no documented accepted root", () => {
  const { acceptedPackages } = resolveAcceptedVulnerabilityPackages({
    workspace: "Web",
    vulnerabilities: {
      alpha: { nodes: ["node_modules/alpha"], via: ["beta"] },
      beta: { nodes: ["node_modules/beta"], via: ["alpha"] },
    },
    lockPackages: {},
  });

  assert.equal(acceptedPackages.size, 0);
});
