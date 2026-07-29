import test from "node:test";
import assert from "node:assert/strict";
import { acceptedPolicyFor, resolveAcceptedVulnerabilityPackages } from "./dependency-audit-policy.mjs";

const braceFinding = {
  workspace: "Web",
  packageName: "brace-expansion",
  vulnerability: { nodes: ["node_modules/minimatch/node_modules/brace-expansion"] },
  via: { url: "https://github.com/advisories/GHSA-mh99-v99m-4gvg" },
};

const esbuildFinding = {
  workspace: "Web",
  packageName: "esbuild",
  vulnerability: { nodes: ["node_modules/esbuild"] },
  via: { url: "https://github.com/advisories/GHSA-g7r4-m6w7-qqqr" },
};

const exactEsbuildLockPackages = {
  "node_modules/esbuild": { version: "0.27.7", dev: true },
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

test("accepts only the exact Web tsx esbuild development node", () => {
  const policy = acceptedPolicyFor({
    ...esbuildFinding,
    lockPackages: exactEsbuildLockPackages,
  });

  assert.equal(policy?.advisoryId, "GHSA-g7r4-m6w7-qqqr");
  assert.deepEqual(policy?.nodes, [
    { path: "node_modules/esbuild", version: "0.27.7", devOnly: true },
  ]);
});

test("rejects the esbuild disposition in the Root workspace", () => {
  assert.equal(
    acceptedPolicyFor({
      ...esbuildFinding,
      workspace: "Root",
      lockPackages: exactEsbuildLockPackages,
    }),
    null,
  );
});

test("rejects the esbuild disposition when the installed version drifts", () => {
  assert.equal(
    acceptedPolicyFor({
      ...esbuildFinding,
      lockPackages: { "node_modules/esbuild": { version: "0.27.8", dev: true } },
    }),
    null,
  );
});

test("rejects the esbuild disposition when the vulnerable node path drifts", () => {
  assert.equal(
    acceptedPolicyFor({
      ...esbuildFinding,
      vulnerability: { nodes: ["node_modules/tsx/node_modules/esbuild"] },
      lockPackages: {
        "node_modules/tsx/node_modules/esbuild": { version: "0.27.7", dev: true },
      },
    }),
    null,
  );
});

test("rejects the esbuild disposition if the node enters the production install", () => {
  assert.equal(
    acceptedPolicyFor({
      ...esbuildFinding,
      lockPackages: { "node_modules/esbuild": { version: "0.27.7" } },
    }),
    null,
  );
});

test("accepts a cyclic transitive report only when it is grounded in an accepted advisory", () => {
  const vulnerabilities = {
    "brace-expansion": {
      nodes: ["node_modules/minimatch/node_modules/brace-expansion"],
      via: [{ url: "https://github.com/advisories/GHSA-mh99-v99m-4gvg" }],
    },
    minimatch: { nodes: ["node_modules/minimatch"], via: ["brace-expansion"] },
    eslint: { nodes: ["node_modules/eslint"], via: ["eslint-utils", "minimatch"] },
    "eslint-utils": { nodes: ["node_modules/eslint-utils"], via: ["eslint"] },
  };

  const { acceptedPackages } = resolveAcceptedVulnerabilityPackages({
    workspace: "Web",
    vulnerabilities,
    lockPackages: {
      "node_modules/minimatch/node_modules/brace-expansion": { version: "1.1.16", dev: true },
    },
  });

  assert.deepEqual([...acceptedPackages].sort(), ["brace-expansion", "eslint", "eslint-utils", "minimatch"]);
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
