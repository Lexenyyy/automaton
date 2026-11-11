/**
 * Sandbox server entry point (fork, Phase 1). Started by the sandbox
 * container: `node dist/sandbox/main.js`. Never run this in the runtime.
 *
 * Settings (environment of the sandbox container, none of them secret):
 *   SANDBOX_SOCKET  Unix socket path   (default /run/automaton-sandbox/sandbox.sock)
 *   SANDBOX_ROOTS   ':'-separated roots for file operations (default /workspace:$HOME)
 *   HOME            home directory for commands
 */

import os from "node:os";
import { DEFAULT_SANDBOX_SOCKET } from "../types.js";
import { startSandboxServer } from "./server.js";

const home = process.env.HOME || os.homedir();
const socketPath = process.env.SANDBOX_SOCKET || DEFAULT_SANDBOX_SOCKET;
const roots = (process.env.SANDBOX_ROOTS || `/workspace:${home}`).split(":").filter(Boolean);

if (process.getuid?.() === 0) {
  console.error("sandbox: refusing to run as root");
  process.exit(1);
}

const server = await startSandboxServer({ socketPath, roots, home });
console.log(JSON.stringify({ sandbox: "listening", socketPath, roots, uid: process.getuid?.() }));

const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
