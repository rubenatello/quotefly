import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acceptedPolicyFor, advisoryId } from "./dependency-audit-policy.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = "npm";

function runAudit(label, cwd) {
  const result = spawnSync(npmCommand, ["audit", "--json"], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32",
  });

  if (result.error) throw result.error;

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    process.stderr.write(result.stderr || result.stdout || `${label} audit did not return JSON.\n`);
    process.exitCode = 1;
    return;
  }

  const vulnerabilities = report.vulnerabilities ?? {};
  const lockPackages = JSON.parse(readFileSync(path.join(cwd, "package-lock.json"), "utf8")).packages ?? {};
  const acceptedPackages = new Set();
  const acceptedPolicies = new Map();
  const unresolved = [];

  for (const [packageName, vulnerability] of Object.entries(vulnerabilities)) {
    const directFindings = vulnerability.via.filter((via) => typeof via === "object");
    const dependencyFindings = vulnerability.via.filter((via) => typeof via === "string");
    const acceptedDirectFindings = directFindings.filter((via) => {
      const policy = acceptedPolicyFor({ workspace: label, packageName, vulnerability, via, lockPackages });
      if (policy) acceptedPolicies.set(`${packageName}:${advisoryId(via)}`, policy);
      return Boolean(policy);
    });
    const rejectedDirectFindings = directFindings.filter(
      (via) => !acceptedPolicyFor({ workspace: label, packageName, vulnerability, via, lockPackages }),
    );

    if (rejectedDirectFindings.length === 0 && dependencyFindings.length === 0 && acceptedDirectFindings.length > 0) {
      acceptedPackages.add(packageName);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [packageName, vulnerability] of Object.entries(vulnerabilities)) {
      if (acceptedPackages.has(packageName)) continue;
      const directFindings = vulnerability.via.filter((via) => typeof via === "object");
      const dependencyFindings = vulnerability.via.filter((via) => typeof via === "string");
      const directAccepted = directFindings.every((via) =>
        Boolean(acceptedPolicyFor({ workspace: label, packageName, vulnerability, via, lockPackages })),
      );
      const dependenciesAccepted = dependencyFindings.length > 0 && dependencyFindings.every((name) => acceptedPackages.has(name));
      if (directAccepted && dependenciesAccepted) {
        acceptedPackages.add(packageName);
        changed = true;
      }
    }
  }

  for (const [packageName, vulnerability] of Object.entries(vulnerabilities)) {
    if (!acceptedPackages.has(packageName)) {
      unresolved.push({ packageName, severity: vulnerability.severity, via: vulnerability.via });
    }
  }

  if (unresolved.length > 0) {
    process.stderr.write(`${label} dependency audit failed:\n`);
    for (const finding of unresolved) {
      process.stderr.write(`- ${finding.packageName} (${finding.severity})\n`);
      for (const via of finding.via) {
        if (typeof via === "object") {
          process.stderr.write(`  ${advisoryId(via) ?? via.title}: ${via.title}\n`);
        }
      }
    }
    process.exitCode = 1;
    return;
  }

  console.log(`${label} dependency audit passed.`);
  for (const packageName of acceptedPackages) {
    const vulnerability = vulnerabilities[packageName];
    for (const via of vulnerability.via) {
      if (typeof via !== "object") continue;
      const id = advisoryId(via);
      const policy = id ? acceptedPolicies.get(`${packageName}:${id}`) : undefined;
      if (policy) console.log(`- Accepted ${id} for ${packageName}: ${policy.reason}`);
    }
  }
}

runAudit("Root", projectRoot);
runAudit("Web", path.join(projectRoot, "web"));
