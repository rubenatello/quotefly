import { parseQuickBooksWorkerEnv, type QuickBooksWorkerEnv } from "../config/quickbooks-worker-env";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

type Runner = { runQuickBooksReconciliationWorker: (env: QuickBooksWorkerEnv) => Promise<void> };

export function assertQuickBooksWorkerArtifactHasNoEnvFiles(root: string) {
  for (const directory of [root, resolve(root, "prisma")]) {
    if (existsSync(directory) && readdirSync(directory).some(name =>
      (name === ".env" || name.startsWith(".env.")) && name !== ".env.example")) {
      throw new Error("QUICKBOOKS_WORKER_ENV_FILE_FORBIDDEN");
    }
  }
}

async function loadProductionRunner(): Promise<Runner> {
  // Prisma 6 can implicitly load artifact-root/prisma env files during construction.
  // Enforce the clean-artifact requirement before importing its module graph.
  assertQuickBooksWorkerArtifactHasNoEnvFiles(resolve(__dirname, "../.."));
  return import("./quickbooks-reconciliation-runtime.js");
}

/** Validate before loading Prisma or any service that can construct a database client. */
export async function startQuickBooksReconciliationWorker(
  input: NodeJS.ProcessEnv = process.env,
  loadRunner: () => Promise<Runner> = loadProductionRunner,
) {
  const env = parseQuickBooksWorkerEnv(input);
  const runner = await loadRunner();
  await runner.runQuickBooksReconciliationWorker(env);
}
