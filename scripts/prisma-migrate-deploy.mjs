import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const migrationDatabaseUrl = process.env.DIRECT_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
if (!migrationDatabaseUrl) {
  console.error("DIRECT_DATABASE_URL or DATABASE_URL is required for Prisma migrations.");
  process.exit(1);
}

if (process.env.NODE_ENV === "production" && !process.env.DIRECT_DATABASE_URL?.trim()) {
  console.error("DIRECT_DATABASE_URL is required for production migrations; DATABASE_URL is reserved for the least-privileged runtime role.");
  process.exit(1);
}

const require = createRequire(import.meta.url);
const prismaCliPath = require.resolve("prisma/build/index.js");
const result = spawnSync(process.execPath, [prismaCliPath, "migrate", "deploy"], {
  stdio: "inherit",
  env: {
    ...process.env,
    DATABASE_URL: migrationDatabaseUrl,
  },
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
