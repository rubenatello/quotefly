import { applyE2eEnv, assertTestDatabaseUrl } from "./e2e-env";
import { spawnSync } from "node:child_process";

applyE2eEnv();
assertTestDatabaseUrl();

const npmCliPath = process.env.npm_execpath?.replace(/npx-cli\.js$/i, "npm-cli.js");
const migrateCommand = npmCliPath ? process.execPath : process.platform === "win32" ? "npx.cmd" : "npx";
const migrateArgs = npmCliPath
  ? [npmCliPath, "exec", "--", "prisma", "migrate", "deploy"]
  : ["prisma", "migrate", "deploy"];
const migrateResult = spawnSync(
  migrateCommand,
  migrateArgs,
  {
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32" && !npmCliPath,
  },
);

if (migrateResult.error) {
  console.error("Failed to start the Prisma migration command for E2E.", migrateResult.error);
}
if (migrateResult.status !== 0) {
  process.exit(migrateResult.status ?? 1);
}

async function main() {
  const { buildServer } = await import("../src/app");

  const app = buildServer();
  const port = Number(process.env.PORT || 4100);

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  try {
    await app.listen({ port, host: "127.0.0.1" });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void main();
