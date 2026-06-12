import { spawn } from "node:child_process";
import { applyE2eEnv } from "./e2e-env";

applyE2eEnv();

const apiUrl = process.env.E2E_API_URL || process.env.API_URL || "http://127.0.0.1:4100";
const child = spawn(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["--prefix", "web", "run", "dev", "--", "--host", "127.0.0.1", "--port", process.env.E2E_WEB_PORT || "4173"],
  {
    env: {
      ...process.env,
      VITE_API_BASE_URL: apiUrl,
    },
    stdio: "inherit",
  },
);

const shutdown = () => {
  if (!child.killed) child.kill();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
child.on("exit", (code) => process.exit(code ?? 0));
