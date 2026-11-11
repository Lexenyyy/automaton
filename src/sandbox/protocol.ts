/**
 * Sandbox protocol (fork, Phase 1).
 *
 * The runtime (holds wallet, keys, config) sends the agent's shell and file
 * operations to a separate sandbox container (holds no secrets). They talk
 * HTTP over a Unix socket on a shared volume, so the sandbox needs no network
 * and has no route to the runtime. The runtime only connects; it never listens.
 *
 *   GET  /health        -> { ok: true, uid }
 *   POST /exec          { command, timeoutMs? }  -> { stdout, stderr, exitCode }
 *   POST /files/write   { path, content }        -> { ok: true }
 *   POST /files/read    { path }                 -> { content }
 *   errors              -> { error } with HTTP status 4xx/5xx
 */

/** Largest request or response body (matches the 10 MB execLocal buffer). */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;
/** Default and maximum command timeout. */
export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
export const MAX_EXEC_TIMEOUT_MS = 10 * 60_000;
/** Exit code reported when a command is killed for running too long. */
export const TIMEOUT_EXIT_CODE = 124;

export interface ExecRequest {
  command: string;
  timeoutMs?: number;
}

export interface WriteFileRequest {
  path: string;
  content: string;
}

export interface ReadFileRequest {
  path: string;
}

/** Single-quote a value for /bin/sh (commands sent to the sandbox). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build a sandbox command from an argument list, quoting every argument
 * (the shell equivalent of execFileSync with an argument array).
 */
export function shellCommand(args: string[]): string {
  return args.map(shellQuote).join(" ");
}

export function clampTimeout(timeoutMs: unknown): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_EXEC_TIMEOUT_MS;
  }
  return Math.min(Math.floor(timeoutMs), MAX_EXEC_TIMEOUT_MS);
}
