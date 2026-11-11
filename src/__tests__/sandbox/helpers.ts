import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const isWindows = process.platform === "win32";

/** A fresh Unix socket path (Linux) or named pipe (Windows, tests only). */
export function tempSocketPath(): string {
  const id = randomBytes(6).toString("hex");
  return isWindows ? `\\\\.\\pipe\\automaton-sbx-${id}` : path.join(os.tmpdir(), `sbx-${id}.sock`);
}

export function tempDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
