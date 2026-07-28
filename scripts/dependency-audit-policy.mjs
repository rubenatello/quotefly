export const acceptedAdvisories = [
  {
    workspace: "Web",
    packageName: "react-router",
    advisoryId: "GHSA-qwww-vcr4-c8h2",
    nodes: [{ path: "node_modules/react-router", version: "7.18.1", devOnly: false }],
    reason:
      "QuoteFly uses React Router only as a client-side Vite SPA and does not enable React Server Components or server actions.",
  },
  {
    workspace: "Web",
    packageName: "brace-expansion",
    advisoryId: "GHSA-mh99-v99m-4gvg",
    nodes: [
      {
        path: "node_modules/minimatch/node_modules/brace-expansion",
        version: "1.1.16",
        devOnly: true,
      },
    ],
    reason:
      "This exact vulnerable node is reachable only through ESLint development tooling and is not installed in the production bundle.",
  },
];

export function advisoryId(via) {
  if (typeof via?.url !== "string") return null;
  return via.url.split("/").at(-1) ?? null;
}

export function acceptedPolicyFor({ workspace, packageName, vulnerability, via, lockPackages }) {
  const policy = acceptedAdvisories.find(
    (candidate) =>
      candidate.workspace === workspace &&
      candidate.packageName === packageName &&
      candidate.advisoryId === advisoryId(via),
  );

  if (!policy) return null;

  const vulnerabilityNodes = [...(vulnerability.nodes ?? [])].sort();
  const policyNodes = policy.nodes.map((node) => node.path).sort();
  if (JSON.stringify(vulnerabilityNodes) !== JSON.stringify(policyNodes)) return null;

  for (const expectedNode of policy.nodes) {
    const installedNode = lockPackages[expectedNode.path];
    if (!installedNode || installedNode.version !== expectedNode.version) return null;
    if (expectedNode.devOnly && installedNode.dev !== true) return null;
    if (!expectedNode.devOnly && installedNode.dev === true) return null;
  }

  return policy;
}
