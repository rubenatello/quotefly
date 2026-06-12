import { applyE2eEnv, assertTestDatabaseUrl } from "./e2e-env";
import { spawnSync } from "node:child_process";

applyE2eEnv();
assertTestDatabaseUrl();

const migrateResult = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["prisma", "migrate", "deploy"],
  {
    env: process.env,
    stdio: "inherit",
  },
);

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
