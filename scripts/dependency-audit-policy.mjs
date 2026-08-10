export const acceptedAdvisories = [];

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

export function resolveAcceptedVulnerabilityPackages({ workspace, vulnerabilities, lockPackages }) {
  const candidates = new Set();
  const acceptedPolicies = new Map();
  const dependencyNamesByPackage = new Map();
  const dependentsByDependency = new Map();
  const directlyGrounded = new Set();

  for (const [packageName, vulnerability] of Object.entries(vulnerabilities)) {
    const directFindings = vulnerability.via.filter((via) => typeof via === "object");
    const dependencyFindings = vulnerability.via.filter((via) => typeof via === "string");
    const policies = directFindings.map((via) =>
      acceptedPolicyFor({ workspace, packageName, vulnerability, via, lockPackages }),
    );

    if (policies.some((policy) => !policy) || directFindings.length + dependencyFindings.length === 0) {
      continue;
    }

    candidates.add(packageName);
    dependencyNamesByPackage.set(packageName, dependencyFindings);

    for (const policy of policies) {
      if (!policy) continue;
      acceptedPolicies.set(`${packageName}:${policy.advisoryId}`, policy);
      directlyGrounded.add(packageName);
    }

    for (const dependencyName of dependencyFindings) {
      const dependents = dependentsByDependency.get(dependencyName) ?? new Set();
      dependents.add(packageName);
      dependentsByDependency.set(dependencyName, dependents);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const packageName of [...candidates]) {
      const dependencyNames = dependencyNamesByPackage.get(packageName) ?? [];
      if (dependencyNames.some((dependencyName) => !candidates.has(dependencyName))) {
        candidates.delete(packageName);
        changed = true;
      }
    }
  }

  const grounded = new Set([...directlyGrounded].filter((packageName) => candidates.has(packageName)));
  const queue = [...grounded];

  while (queue.length > 0) {
    const dependencyName = queue.shift();
    if (!dependencyName) continue;

    for (const dependentName of dependentsByDependency.get(dependencyName) ?? []) {
      if (!candidates.has(dependentName) || grounded.has(dependentName)) continue;
      grounded.add(dependentName);
      queue.push(dependentName);
    }
  }

  changed = true;
  while (changed) {
    changed = false;
    for (const packageName of [...grounded]) {
      const dependencyNames = dependencyNamesByPackage.get(packageName) ?? [];
      if (dependencyNames.some((dependencyName) => !grounded.has(dependencyName))) {
        grounded.delete(packageName);
        changed = true;
      }
    }
  }

  return { acceptedPackages: grounded, acceptedPolicies };
}
