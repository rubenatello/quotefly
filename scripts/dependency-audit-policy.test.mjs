import test from "node:test";
import assert from "node:assert/strict";
import { acceptedPolicyFor } from "./dependency-audit-policy.mjs";

const braceFinding = {
  workspace: "Web",
  packageName: "brace-expansion",
  vulnerability: { nodes: ["node_modules/minimatch/node_modules/brace-expansion"] },
  via: { url: "https://github.com/advisories/GHSA-mh99-v99m-4gvg" },
};

test("accepts the documented ESLint-only brace-expansion node", () => {
  const policy = acceptedPolicyFor({
    ...braceFinding,
    lockPackages: {
      "node_modules/minimatch/node_modules/brace-expansion": { version: "1.1.16", dev: true },
    },
  });

  assert.equal(policy?.packageName, "brace-expansion");
});

test("rejects the same advisory if the vulnerable node becomes production code", () => {
  const policy = acceptedPolicyFor({
    ...braceFinding,
    lockPackages: {
      "node_modules/minimatch/node_modules/brace-expansion": { version: "1.1.16" },
    },
  });

  assert.equal(policy, null);
});

test("rejects an exception when workspace, package, node, or version drifts", () => {
  const lockPackages = {
    "node_modules/minimatch/node_modules/brace-expansion": { version: "1.1.15", dev: true },
  };

  assert.equal(acceptedPolicyFor({ ...braceFinding, workspace: "Root", lockPackages }), null);
  assert.equal(acceptedPolicyFor({ ...braceFinding, packageName: "other-package", lockPackages }), null);
  assert.equal(acceptedPolicyFor({ ...braceFinding, lockPackages }), null);
});
