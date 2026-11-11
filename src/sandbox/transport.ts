/**
 * Runtime side of the sandbox (fork, Phase 1).
 *
 * In container mode the Conway client sends exec/writeFile/readFile here
 * instead of running them in this process. Errors are thrown, never answered
 * by running the operation locally: the runtime holds the secrets, so a local
 * fallback would undo the isolation.
 *
 * Everything the sandbox returns is untrusted agent output.
 */

import http from "node:http";
import path from "node:path";
import type { ExecResult, SandboxConfig } from "../types.js";
import { DEFAULT_SANDBOX_SOCKET } from "../types.js";
import { MAX_BODY_BYTES, clampTimeout } from "./protocol.js";

export interface SandboxTransport {
  exec(command: string, timeoutMs?: number): Promise<ExecResult>;
  writeFile(filePath: string, content: string): Promise<void>;
  readFile(filePath: string): Promise<string>;
}

/** Extra time the HTTP call waits beyond the command timeout. */
const TRANSPORT_GRACE_MS = 5_000;
const FILE_OP_TIMEOUT_MS = 30_000;

export class SandboxError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "SandboxError";
  }
}

/**
 * Validate the sandbox setting. Returns the socket path for container mode,
 * null for local mode, and throws on anything else (refuse to start rather
 * than guess where the tools should run).
 */
export function resolveSandboxSocket(
  sandbox: SandboxConfig | undefined,
  conwaySandboxId: string,
): string | null {
  if (sandbox === undefined || sandbox === null) return null;
  if (typeof sandbox !== "object") {
    throw new Error(`Invalid sandbox setting: expected an object`);
  }
  if (sandbox.mode === "local") return null;
  if (sandbox.mode !== "container") {
    throw new Error(`Invalid sandbox.mode: ${String((sandbox as any).mode)} (use "local" or "container")`);
  }
  if (conwaySandboxId) {
    throw new Error(
      `sandbox.mode "container" cannot be combined with a Conway sandboxId. Remove one of them.`,
    );
  }
  const socketPath = sandbox.socketPath ?? DEFAULT_SANDBOX_SOCKET;
  if (typeof socketPath !== "string" || !path.posix.isAbsolute(socketPath)) {
    throw new Error(`Invalid sandbox.socketPath: must be an absolute path`);
  }
  return socketPath;
}

export function createSandboxTransport(socketPath: string): SandboxTransport {
  const call = (method: "GET" | "POST", route: string, body: unknown, timeoutMs: number): Promise<any> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf-8");
      if (payload && payload.length > MAX_BODY_BYTES) {
        reject(new SandboxError(`Sandbox request too large (${payload.length} bytes)`));
        return;
      }
      const req = http.request(
        {
          socketPath,
          path: route,
          method,
          headers: payload
            ? { "Content-Type": "application/json", "Content-Length": payload.length }
            : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES * 3) {
              req.destroy(new SandboxError("Sandbox response too large"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            let parsed: any;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            } catch {
              reject(new SandboxError(`Sandbox returned invalid JSON (HTTP ${res.statusCode})`, res.statusCode));
              return;
            }
            if (!res.statusCode || res.statusCode >= 400) {
              const msg = typeof parsed?.error === "string" ? parsed.error : "unknown error";
              reject(new SandboxError(`Sandbox error (HTTP ${res.statusCode}): ${msg}`, res.statusCode));
              return;
            }
            resolve(parsed);
          });
          res.on("error", reject);
        },
      );
      req.setTimeout(timeoutMs, () => {
        req.destroy(new SandboxError(`Sandbox did not answer within ${timeoutMs} ms`));
      });
      req.on("error", (err: any) => {
        if (err instanceof SandboxError) {
          reject(err);
        } else {
          reject(
            new SandboxError(
              `Sandbox unreachable (${err?.code ?? err?.message ?? "error"}). ` +
                `The operation will NOT be run in the runtime.`,
            ),
          );
        }
      });
      if (payload) req.write(payload);
      req.end();
    });

  return {
    async exec(command, timeoutMs) {
      const timeout = clampTimeout(timeoutMs);
      const res = await call("POST", "/exec", { command, timeoutMs: timeout }, timeout + TRANSPORT_GRACE_MS);
      return {
        stdout: typeof res?.stdout === "string" ? res.stdout : "",
        stderr: typeof res?.stderr === "string" ? res.stderr : "",
        exitCode: Number.isInteger(res?.exitCode) ? res.exitCode : -1,
      };
    },
    async writeFile(filePath, content) {
      await call("POST", "/files/write", { path: filePath, content }, FILE_OP_TIMEOUT_MS);
    },
    async readFile(filePath) {
      const res = await call("POST", "/files/read", { path: filePath }, FILE_OP_TIMEOUT_MS);
      return typeof res?.content === "string" ? res.content : "";
    },
  };
}
