/**
 * Sandbox server (fork, Phase 1). Runs ONLY in the sandbox container.
 *
 * Executes the agent's shell commands and file operations for the runtime.
 * The sandbox container holds no secrets, has no network and runs as a
 * non-root user; that container is the security boundary. The checks here
 * (path roots, size and time limits, fixed environment) are defense in depth.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  MAX_BODY_BYTES,
  TIMEOUT_EXIT_CODE,
  clampTimeout,
} from "./protocol.js";

export interface SandboxServerOptions {
  /** Unix socket (or Windows named pipe, tests only) to listen on. */
  socketPath: string;
  /** Directories the file operations may touch. Commands start in `home`. */
  roots: string[];
  /** Home directory for commands and for `~` in paths. */
  home: string;
  /** PATH given to commands. */
  commandPath?: string;
  /** Shell used to run commands. */
  shell?: string;
  /** File mode of the socket, so the runtime's group can connect. */
  socketMode?: number;
  /** Maximum commands running at the same time. */
  maxConcurrent?: number;
}

const DEFAULT_COMMAND_PATH = "/usr/local/bin:/usr/bin:/bin";

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Resolve a requested path and check that it stays inside one of the roots. */
export function confinePath(requested: unknown, roots: string[], home: string): string {
  if (typeof requested !== "string" || requested.length === 0 || requested.includes("\0")) {
    throw new HttpError(400, "path must be a non-empty string");
  }
  const expanded = requested === "~" || requested.startsWith("~/")
    ? path.join(home, requested.slice(1))
    : requested;
  if (!path.isAbsolute(expanded)) {
    throw new HttpError(400, "path must be absolute or start with ~/");
  }
  const resolved = path.resolve(expanded);
  // Follow symlinks on the part of the path that exists, so a link inside a
  // root cannot point outside it.
  const real = realpathOfExisting(resolved);
  for (const root of roots) {
    const realRoot = realpathOfExisting(path.resolve(root));
    const rel = path.relative(realRoot, real);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      return resolved;
    }
  }
  throw new HttpError(403, `path outside the sandbox roots: ${requested}`);
}

function realpathOfExisting(p: string): string {
  let current = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return p;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : {});
      } catch {
        reject(new HttpError(400, "invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

interface ExecOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCommand(command: string, timeoutMs: number, opts: Required<Pick<SandboxServerOptions, "home" | "shell" | "commandPath">>): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    // Fixed, minimal environment: nothing is inherited from the server.
    const child = spawn(opts.shell, ["-c", command], {
      cwd: opts.home,
      env: { PATH: opts.commandPath, HOME: opts.home, LANG: "C.UTF-8" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group, so a timeout kills every child
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outSize = 0;
    let errSize = 0;
    let note = "";
    let finished = false;

    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const timer = setTimeout(() => {
      note = `\n[sandbox: command timed out after ${timeoutMs} ms and was killed]`;
      killGroup();
    }, timeoutMs);

    child.stdout!.on("data", (c: Buffer) => {
      outSize += c.length;
      if (outSize > MAX_BODY_BYTES) {
        note = "\n[sandbox: output limit reached, command killed]";
        killGroup();
        return;
      }
      out.push(c);
    });
    child.stderr!.on("data", (c: Buffer) => {
      errSize += c.length;
      if (errSize > MAX_BODY_BYTES) {
        note = "\n[sandbox: output limit reached, command killed]";
        killGroup();
        return;
      }
      err.push(c);
    });

    const finish = (exitCode: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString("utf-8"),
        stderr: Buffer.concat(err).toString("utf-8") + note,
        exitCode,
      });
    };

    child.on("error", (e) => {
      err.push(Buffer.from(String(e.message)));
      finish(127);
    });
    child.on("close", (code, signal) => {
      if (note.includes("timed out")) finish(TIMEOUT_EXIT_CODE);
      else if (code !== null) finish(code);
      else finish(signal ? 128 + (signal === "SIGKILL" ? 9 : 15) : 1);
    });
  });
}

export function createSandboxServer(options: SandboxServerOptions): http.Server {
  const roots = options.roots.map((r) => path.resolve(r));
  const home = path.resolve(options.home);
  const execOpts = {
    home,
    shell: options.shell ?? "/bin/sh",
    commandPath: options.commandPath ?? DEFAULT_COMMAND_PATH,
  };
  const maxConcurrent = options.maxConcurrent ?? 4;
  let running = 0;

  const handle = async (req: http.IncomingMessage): Promise<{ status: number; body: unknown }> => {
    const route = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && route === "/health") {
      return { status: 200, body: { ok: true, uid: process.getuid?.() ?? null } };
    }
    if (req.method !== "POST") throw new HttpError(405, "method not allowed");
    const body = await readJsonBody(req);

    if (route === "/exec") {
      if (typeof body.command !== "string" || body.command.length === 0) {
        throw new HttpError(400, "command must be a non-empty string");
      }
      if (running >= maxConcurrent) throw new HttpError(429, "too many commands running");
      running++;
      try {
        return { status: 200, body: await runCommand(body.command, clampTimeout(body.timeoutMs), execOpts) };
      } finally {
        running--;
      }
    }
    if (route === "/files/write") {
      if (typeof body.content !== "string") throw new HttpError(400, "content must be a string");
      const target = confinePath(body.path, roots, home);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body.content, "utf-8");
      return { status: 200, body: { ok: true } };
    }
    if (route === "/files/read") {
      const target = confinePath(body.path, roots, home);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(target);
      } catch {
        throw new HttpError(404, `file not found: ${body.path}`);
      }
      if (!stat.isFile()) throw new HttpError(400, "not a regular file");
      if (stat.size > MAX_BODY_BYTES) throw new HttpError(413, "file too large");
      return { status: 200, body: { content: fs.readFileSync(target, "utf-8") } };
    }
    throw new HttpError(404, "unknown route");
  };

  return http.createServer((req, res) => {
    handle(req)
      .then(({ status, body }) => send(res, status, body))
      .catch((e: any) => {
        const status = e instanceof HttpError ? e.status : 500;
        send(res, status, { error: e instanceof HttpError ? e.message : `internal error: ${e?.code ?? "unknown"}` });
      });
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const payload = Buffer.from(JSON.stringify(body), "utf-8");
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": payload.length });
  res.end(payload);
}

/** Start listening. Removes a stale socket file first and sets its mode. */
export function startSandboxServer(options: SandboxServerOptions): Promise<http.Server> {
  const server = createSandboxServer(options);
  if (process.platform !== "win32") {
    try {
      if (fs.lstatSync(options.socketPath).isSocket()) fs.unlinkSync(options.socketPath);
    } catch {
      // no stale socket
    }
  }
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      if (process.platform !== "win32") {
        fs.chmodSync(options.socketPath, options.socketMode ?? 0o660);
      }
      resolve(server);
    });
  });
}
