import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import type { FullConfig } from "@playwright/test";
import { applyE2eEnv, assertTestDatabaseUrl } from "./e2e-env";

type OwnedServer = {
  child: ChildProcess;
  label: string;
  output: () => string;
};

// Windows + OneDrive workspaces can spend several minutes importing the API after migrations.
// Keep the browser gate deterministic instead of failing before the server has opened its port.
const STARTUP_TIMEOUT_MS = 240_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

function startOwnedServer(label: string, args: string[], env: NodeJS.ProcessEnv): OwnedServer {
  let output = "";
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const appendOutput = (chunk: Buffer | string) => {
    output = `${output}${chunk.toString()}`.slice(-12_000);
  };
  child.stdout?.on("data", appendOutput);
  child.stderr?.on("data", appendOutput);

  return { child, label, output: () => output };
}

async function waitForServer(server: OwnedServer, url: string) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
    if (server.child.exitCode !== null) {
      throw new Error(`${server.label} exited during startup.\n${server.output()}`);
    }

    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server has not opened its port yet.
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }

  throw new Error(`${server.label} did not become ready at ${url}.\n${server.output()}`);
}

async function stopOwnedServer(server: OwnedServer) {
  const { child } = server;
  if (child.exitCode !== null || !child.pid) return;

  child.kill("SIGTERM");
  const exited = await Promise.race([
    once(child, "exit").then(() => true),
    new Promise<boolean>((resolveDelay) => setTimeout(() => resolveDelay(false), SHUTDOWN_TIMEOUT_MS)),
  ]);
  if (exited || !child.pid) return;

  // This fallback is limited to the exact Windows process tree created above.
  spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

export default async function globalSetup(_config: FullConfig) {
  if (process.platform !== "win32" || process.env.E2E_REUSE_EXISTING_SERVER === "true") return;

  applyE2eEnv();
  assertTestDatabaseUrl();

  const apiPort = process.env.E2E_API_PORT || "4100";
  const webPort = process.env.E2E_WEB_PORT || "4173";
  const apiUrl = process.env.E2E_API_URL || `http://127.0.0.1:${apiPort}`;
  const webUrl = process.env.E2E_WEB_URL || `http://127.0.0.1:${webPort}`;

  const apiServer = startOwnedServer(
    "QuoteFly E2E API",
    ["--import", "tsx", resolve("scripts/e2e-api-server.ts")],
    { ...process.env, PORT: apiPort },
  );
  const webServer = startOwnedServer(
    "QuoteFly E2E web app",
    [resolve("web/node_modules/vite/bin/vite.js"), "web", "--host", "127.0.0.1", "--port", webPort],
    { ...process.env, VITE_API_BASE_URL: apiUrl },
  );
  const servers = [apiServer, webServer];

  try {
    await Promise.all([
      waitForServer(apiServer, `${apiUrl}/v1/health`),
      waitForServer(webServer, webUrl),
    ]);
  } catch (error) {
    await Promise.allSettled(servers.map(stopOwnedServer));
    throw error;
  }

  return async () => {
    await Promise.allSettled(servers.map(stopOwnedServer));
  };
}
