import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const rootIndex = process.argv.indexOf("--root");
const root = path.resolve(rootIndex >= 0 ? process.argv[rootIndex + 1] : process.cwd());
const jsonOutput = process.argv.includes("--json");
const routesDirectory = path.join(root, "src", "routes");
const methodPattern = /\bapp\.(get|post|put|patch|delete)\s*\(/g;
const routePattern = /\bapp\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/g;

function riskClass(method, routePath) {
  if (routePath.includes("webhook") || routePath.includes("callback")) return "provider-callback";
  if (routePath.startsWith("/internal/")) return method === "GET" ? "superuser-read" : "superuser-mutation";
  if (method !== "GET") return "tenant-mutation";
  if (["/health", "/ready"].includes(routePath)) return "public-read";
  return "tenant-read";
}

const files = (await readdir(routesDirectory))
  .filter((file) => file.endsWith(".ts"))
  .sort();
const routes = [];
let declarations = 0;

for (const file of files) {
  const source = await readFile(path.join(routesDirectory, file), "utf8");
  declarations += [...source.matchAll(methodPattern)].length;
  for (const match of source.matchAll(routePattern)) {
    const method = match[1].toUpperCase();
    const routePath = match[2];
    const line = source.slice(0, match.index).split(/\r?\n/).length;
    routes.push({ method, path: `/v1${routePath}`, risk: riskClass(method, routePath), file, line });
  }
}

routes.sort((left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method));
const unmatchedDeclarations = declarations - routes.length;
const countsByRisk = Object.fromEntries(
  [...new Set(routes.map((route) => route.risk))]
    .sort()
    .map((risk) => [risk, routes.filter((route) => route.risk === risk).length]),
);
const report = { routeCount: routes.length, declarationCount: declarations, unmatchedDeclarations, countsByRisk, routes };

if (jsonOutput) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(`QuoteFly routes: ${routes.length}`);
  console.log(`Unmatched declarations: ${unmatchedDeclarations}`);
  for (const [risk, count] of Object.entries(countsByRisk)) console.log(`${risk}: ${count}`);
  for (const route of routes) console.log(`${route.method.padEnd(6)} ${route.path.padEnd(72)} ${route.risk} (${route.file}:${route.line})`);
}

if (unmatchedDeclarations !== 0 || routes.length === 0) process.exitCode = 1;
