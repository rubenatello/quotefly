import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { initialState, validateState, type WatchdogState } from "./core";

const MAX_BYTES = 128 * 1024;
export function validateDirectory(directory: string): void {
  if (!path.isAbsolute(directory)) throw new Error("WATCHDOG_STATE_DIRECTORY_INVALID");
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) {
    throw new Error("WATCHDOG_STATE_DIRECTORY_INVALID");
  }
}
/** Linux production uses a crash-released OS lock; direct/dev usage is fail-closed. */
export class WatchdogStore {
  private readonly statePath: string;
  private readonly lockPath: string;
  private value: WatchdogState;
  private closed = false;
  private failed = false;
  constructor(private readonly directory: string, private readonly destination: string, private readonly externalLockHeld = false) {
    validateDirectory(directory);
    this.statePath = path.join(directory, "state.json");
    this.lockPath = path.join(directory, "watchdog.lock");
    if (!externalLockHeld) {
      const fd = fs.openSync(this.lockPath, "wx", 0o600);
      fs.closeSync(fd);
    }
    try {
      if (fs.existsSync(this.statePath)) {
        const file = fs.lstatSync(this.statePath);
        if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_BYTES
          || (process.platform !== "win32" && (file.mode & 0o077) !== 0)) throw new Error("WATCHDOG_STATE_INVALID");
        const parsed: unknown = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
        if (!validateState(parsed, destination)) throw new Error("WATCHDOG_STATE_INVALID");
        this.value = parsed;
      } else this.value = initialState(destination);
      this.persist(this.value); // Fail before accepting input if storage isn't writable.
    } catch {
      if (!externalLockHeld) fs.unlinkSync(this.lockPath);
      throw new Error("WATCHDOG_STORAGE_UNAVAILABLE");
    }
  }
  get healthy(): boolean { return !this.failed && !this.closed; }
  snapshot(): WatchdogState { return structuredClone(this.value); }
  change<T>(update: (next: WatchdogState) => T): T {
    if (!this.healthy) throw new Error("WATCHDOG_STORAGE_UNAVAILABLE");
    const next = this.snapshot();
    const result = update(next);
    if (!validateState(next, this.destination)) throw new Error("WATCHDOG_STATE_INVALID");
    try { this.persist(next); } catch {
      this.failed = true;
      throw new Error("WATCHDOG_STORAGE_UNAVAILABLE");
    }
    this.value = next;
    return result;
  }
  private persist(state: WatchdogState): void {
    const data = JSON.stringify(state);
    if (Buffer.byteLength(data) > MAX_BYTES) throw new Error("WATCHDOG_STATE_TOO_LARGE");
    const temp = path.join(this.directory, `state-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(temp, "wx", 0o600);
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temp, this.statePath);
      if (process.platform !== "win32") {
        const directoryFd = fs.openSync(this.directory, "r");
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
  close(): void {
    if (this.closed) return;
    if (!this.externalLockHeld) fs.unlinkSync(this.lockPath);
    this.closed = true;
  }
}
