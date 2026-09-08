import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { validateDirectory } from "./store";

/** Production entrypoint only. Marker is internal process wiring, never an HTTP option. */
export function launchWithProcessLock(directory: string, entrypoint: string): void {
  validateDirectory(directory);
  const lock = path.join(directory, "process.lock");
  try {
    const stat = fs.lstatSync(lock);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new Error("WATCHDOG_PROCESS_LOCK_INVALID");
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  process.umask(0o077);
  const child = spawn("/usr/bin/flock", ["--nonblock", "--conflict-exit-code", "73", "--no-fork", "--", lock, process.execPath, entrypoint, "--lock-held"], {
    stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => child.kill(signal));
  child.once("error", () => { process.stderr.write("WATCHDOG_LOCK_LAUNCH_FAILED\n"); process.exitCode = 1; });
  child.once("exit", code => { process.exitCode = code ?? 1; });
}
