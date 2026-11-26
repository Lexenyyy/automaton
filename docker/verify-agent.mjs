#!/usr/bin/env node
/**
 * pnpm agent:verify (fork, Phase 1): isolation checks for the agent in Docker.
 *
 * Runs in a separate, throwaway compose project ("automaton-verify") with its
 * own volumes and a FAKE secret, and removes everything at the end. It never
 * touches the real wallet volume or real keys, never starts the agent loop,
 * calls no model and moves no money.
 *
 * Check scripts are sent to the containers on stdin (`node -`), so nothing
 * extra is baked into the images.
 */

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PROJECT, SERVICE_IMAGES, gitBuildCommit, imageCommit, warnStaleRuntimes } from "./agent-instances.mjs";
import { bootAt } from "./supervise-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "automaton-verify";
const COMPOSE = ["compose", "-f", path.join(ROOT, "docker", "compose.agent.yml"), "-p", PROJECT];
const PROBE = `${PROJECT}-runtime-probe`;

const fakeSecret = `verify-fake-secret-${crypto.randomBytes(16).toString("hex")}`;
const fakeOpenAiKey = `verify-fake-openai-${crypto.randomBytes(16).toString("hex")}`;
const fakeSecretHash = crypto.createHash("sha256").update(fakeSecret).digest("hex");
const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-verify-secrets-"));
fs.writeFileSync(path.join(secretsDir, "groq_api_key"), fakeSecret + "\n");
fs.writeFileSync(path.join(secretsDir, "openai_api_key"), fakeOpenAiKey + "\n");
// Fork (Phase 3): the template requires an encrypted wallet; fake passphrase for the throwaway wallet.
const fakeWalletPassphrase = `verify-fake-passphrase-${crypto.randomBytes(16).toString("hex")}`;
fs.writeFileSync(path.join(secretsDir, "wallet_passphrase"), fakeWalletPassphrase + "\n");
// Linux host (VPS): the bind-mounted folder keeps host permissions, and mkdtemp
// makes it 0700 for the host user, so the runtime (uid 10001) could not read the
// fake secrets. They are throwaway values; make them readable. Docker Desktop
// (Windows) ignores these permissions.
function openFakeSecretsOnLinux() {
  if (process.platform === "win32") return;
  fs.chmodSync(secretsDir, 0o755);
  for (const f of fs.readdirSync(secretsDir)) fs.chmodSync(path.join(secretsDir, f), 0o644);
}
openFakeSecretsOnLinux();

const VERIFY_CREATOR = "0x000000000000000000000000000000000000dEaD";
const BUILD_COMMIT = gitBuildCommit(ROOT);
const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-verify-logs-"));
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const OLD_IMAGE = `${PROJECT}-old:local`;
const env = {
  ...process.env,
  AUTOMATON_SECRETS_DIR: secretsDir,
  AUTOMATON_CREATOR_ADDRESS: VERIFY_CREATOR,
  AUTOMATON_BUILD_COMMIT: BUILD_COMMIT,
  AUTOMATON_LOG_DIR: logsDir,
};
delete env.AUTOMATON_MAINNET_APPROVED;
delete env.AUTOMATON_CONFIG_TEMPLATE; // verify always uses the normal template (checks below select others explicitly)

const results = [];
const check = (group, name, ok, detail = "") => results.push({ group, name, ok: Boolean(ok), detail: String(detail) });

// Fork (model check): preflight confirms every model with the provider's free
// model list. Verify uses a fake OpenAI key, which OpenAI rejects, so preflight
// fails on exactly that one line and nothing else. Verify adds no switch to skip
// the check; "passes" below means: that rejection is the only FAIL.
const MODEL_LIST_REJECTED = /^FAIL {2}model list \(openai\): could not read \(HTTP 401[^)]*key rejected\); models not confirmed$/;
const failLines = (out) => String(out).split("\n").map((l) => l.trim()).filter((l) => l.startsWith("FAIL"));
const preflightOkButFakeKey = (out) => {
  const fails = failLines(out);
  return String(out).includes("PREFLIGHT FAILED") && fails.length === 1 && MODEL_LIST_REJECTED.test(fails[0]);
};
const failSummary = (out) => failLines(out).join(" | ").slice(0, 500) || "no FAIL lines";

function docker(args, { input, allowFail = true, timeoutMs = 300_000 } = {}) {
  const r = spawnSync("docker", args, { cwd: ROOT, env, input, encoding: "utf-8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  if (!allowFail && r.status !== 0) {
    throw new Error(`docker ${args.join(" ")} failed (${r.status}):\n${r.stderr || r.stdout}`);
  }
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function lastJsonLine(text) {
  const line = text.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
  try {
    return line ? JSON.parse(line) : null;
  } catch {
    return null;
  }
}

/** The --init result, also when the logger wraps it in its own JSON line. */
function findInitResult(text) {
  for (const line of text.split("\n").reverse()) {
    let obj;
    try {
      obj = JSON.parse(line.trim());
    } catch {
      continue;
    }
    if (obj && typeof obj.address === "string") return obj;
    if (obj && typeof obj.message === "string") {
      try {
        const inner = JSON.parse(obj.message);
        if (inner && typeof inner.address === "string") return inner;
      } catch {
        // not it
      }
    }
  }
  return null;
}

function inspect(container) {
  const r = docker(["inspect", container]);
  return r.code === 0 ? JSON.parse(r.out)[0] : null;
}

function hardeningChecks(group, info, expectedUser) {
  const hc = info.HostConfig;
  check(group, "read-only root filesystem", hc.ReadonlyRootfs === true);
  check(group, "all capabilities dropped", (hc.CapDrop ?? []).includes("ALL"), JSON.stringify(hc.CapDrop));
  check(group, "no-new-privileges", (hc.SecurityOpt ?? []).some((s) => s.startsWith("no-new-privileges")), JSON.stringify(hc.SecurityOpt));
  check(group, "not privileged", hc.Privileged === false);
  check(group, "no published ports", Object.keys(hc.PortBindings ?? {}).length === 0 && !hc.PublishAllPorts, JSON.stringify(hc.PortBindings));
  check(group, "no exposed ports", Object.keys(info.Config.ExposedPorts ?? {}).length === 0, JSON.stringify(info.Config.ExposedPorts));
  check(group, `runs as ${expectedUser}`, info.Config.User === expectedUser, info.Config.User);
  check(group, "no Docker socket mounted", !(info.Mounts ?? []).some((m) => /docker\.sock/.test(m.Source ?? "") || /docker\.sock/.test(m.Destination)));
}

// ─── in-container check scripts (sent on stdin) ────────────────

const SHARED = String.raw`
import fs from "node:fs";
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: Boolean(ok), detail: String(detail) });
const fails = (fn) => { try { fn(); return false; } catch { return true; } };
const status = fs.readFileSync("/proc/self/status", "utf-8");
const field = (k) => (status.match(new RegExp("^" + k + ":\\s*(.*)$", "m")) || [])[1];
`;

const sandboxScript = (runtimeIp) => SHARED + String.raw`
import net from "node:net";
import dns from "node:dns/promises";
import { spawnSync } from "node:child_process";

const SECRET = ${JSON.stringify(fakeSecret)};
const WALLET_PASS = ${JSON.stringify(fakeWalletPassphrase)};

check("runs as uid 10002 (agent), not root", process.getuid() === 10002, process.getuid());
check("no effective capabilities", /^0+$/.test(field("CapEff")), field("CapEff"));
check("no-new-privileges set", field("NoNewPrivs") === "1");

// Secrets, wallet, config: not present at all
check("no /run/secrets", !fs.existsSync("/run/secrets"));
check("no runtime home (/home/automaton)", !fs.existsSync("/home/automaton"));
const found = spawnSync("find", ["/", "(", "-path", "/proc", "-o", "-path", "/sys", "-o", "-path", "/dev", ")", "-prune", "-o",
  "(", "-name", "wallet.json", "-o", "-name", "automaton.json", "-o", "-name", "state.db", "-o", "-name", "*api_key*", ")", "-print"],
  { encoding: "utf-8" });
check("no wallet.json, automaton.json, state.db or key files anywhere", found.stdout.trim() === "", found.stdout.trim());
check("fake secret not in own environment", !JSON.stringify(process.env).includes(SECRET));
let inEnviron = [];
for (const pid of fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
  try { const e = fs.readFileSync("/proc/" + pid + "/environ", "latin1"); if (e.includes(SECRET) || e.includes(WALLET_PASS)) inEnviron.push(pid); } catch {}
}
check("fake secret and wallet passphrase not in any process environment", inEnviron.length === 0, inEnviron.join(","));
const grep = spawnSync("grep", ["-rIlsF", "--exclude-dir=proc", "--exclude-dir=sys", "--exclude-dir=dev", "-e", SECRET, "-e", WALLET_PASS, "/"], { encoding: "utf-8", timeout: 240000 });
// grep exits 1 (no match) or 2 (no match, but some files were unreadable, as expected).
check("fake secret and wallet passphrase not in any readable file",(grep.status === 1 || grep.status === 2) && grep.stdout.trim() === "", (grep.stdout || "").trim() || ("grep exit " + grep.status));

// Cannot write outside its own areas
for (const p of ["/etc/automaton-test", "/app/automaton-test", "/usr/local/bin/automaton-test", "/automaton-test"]) {
  check("cannot write " + p, fails(() => fs.writeFileSync(p, "x")));
}
check("no Docker socket", !fs.existsSync("/var/run/docker.sock") && !fs.existsSync("/run/docker.sock"));

// Network: none at all (addition 1)
const ifaces = fs.readdirSync("/sys/class/net").sort();
check("only the loopback interface", JSON.stringify(ifaces) === '["lo"]', ifaces.join(","));
const route = fs.readFileSync("/proc/net/route", "utf-8").trim().split("\n").slice(1).filter(Boolean);
check("empty routing table", route.length === 0, route.join(" | "));
const tryConnect = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port, timeout: 3000 });
  s.on("connect", () => { s.destroy(); resolve("CONNECTED"); });
  s.on("timeout", () => { s.destroy(); resolve("TIMEOUT"); });
  s.on("error", (e) => resolve(e.code || e.message));
});
for (const port of [80, 443, 3000, 8004, 8080]) {
  const r = await tryConnect(${JSON.stringify(runtimeIp)}, port);
  check("no route to the runtime (" + ${JSON.stringify(runtimeIp)} + ":" + port + ")", r === "ENETUNREACH", r);
}
const inet = await tryConnect("1.1.1.1", 443);
check("no internet (1.1.1.1:443)", inet === "ENETUNREACH", inet);
let dnsResult = "resolved";
try { await dns.lookup("example.com"); } catch (e) { dnsResult = e.code; }
check("no DNS", dnsResult !== "resolved", dnsResult);

// Plant a canary skill for the runtime check (addition 2)
const dir = "/workspace/skills/verify-canary";
fs.mkdirSync(dir + "/node_modules/x", { recursive: true });
fs.writeFileSync(dir + "/SKILL.md", "---\nname: verify-canary\ndescription: canary\n---\nCanary text only.\n");
const code = "require('fs').writeFileSync('/tmp/canary-ran','1'); globalThis.__canaryRan = true;\n";
const esm = "import fs from 'node:fs'; fs.writeFileSync('/tmp/canary-ran','1'); globalThis.__canaryRan = true;\n";
fs.writeFileSync(dir + "/index.js", code);
fs.writeFileSync(dir + "/index.cjs", code);
fs.writeFileSync(dir + "/index.mjs", esm);
fs.writeFileSync(dir + "/node_modules/x/index.js", code);
fs.writeFileSync(dir + "/package.json", JSON.stringify({ name: "verify-canary", main: "index.js", scripts: { postinstall: "node index.js" } }));
fs.writeFileSync(dir + "/run.sh", "#!/bin/sh\ntouch /tmp/canary-ran\n", { mode: 0o755 });
check("canary skill planted in /workspace/skills", fs.existsSync(dir + "/SKILL.md"));

console.log(JSON.stringify({ results }));
`;

const runtimeScript = SHARED + String.raw`
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";

const HOME = process.env.HOME;
const AUTO = HOME + "/.automaton";

check("runs as uid 10001 (automaton), not root", process.getuid() === 10001, process.getuid());
check("no effective capabilities", /^0+$/.test(field("CapEff")), field("CapEff"));
check("no-new-privileges set", field("NoNewPrivs") === "1");

// Secrets reach the runtime only (compared by hash, never printed)
const key = process.env.GROQ_API_KEY || "";
check("API key loaded from the secrets folder", crypto.createHash("sha256").update(key).digest("hex") === ${JSON.stringify(fakeSecretHash)});
check("secrets folder is read-only", fails(() => fs.writeFileSync("/run/secrets/automaton/x", "x")));

// Config, wallet, filesystem
check("config is read-only", fails(() => fs.appendFileSync(AUTO + "/automaton.json", "")));
const cfg = JSON.parse(fs.readFileSync(AUTO + "/automaton.json", "utf-8"));
check("config: testnet", cfg.network === "testnet", cfg.network);
check("config: sandbox container mode", cfg.sandbox?.mode === "container", JSON.stringify(cfg.sandbox));
const w = fs.statSync(AUTO + "/wallet.json");
check("wallet.json mode 600, owned by the runtime user", (w.mode & 0o777) === 0o600 && w.uid === 10001, (w.mode & 0o777).toString(8) + " uid " + w.uid);
const d = fs.statSync(AUTO);
check("~/.automaton mode 700", (d.mode & 0o777) === 0o700, (d.mode & 0o777).toString(8));
for (const p of ["/app/x", "/etc/x", HOME + "/x", "/usr/local/bin/x"]) {
  check("cannot write " + p, fails(() => fs.writeFileSync(p, "x")));
}
check("/workspace is read-only", fails(() => fs.writeFileSync("/workspace/x", "x")));
check("sandbox socket folder is read-only", fails(() => fs.writeFileSync("/run/automaton-sandbox/x", "x")));

// Addition 1: the runtime can listen nowhere the sandbox could reach
const listenRes = await new Promise((resolve) => {
  const srv = net.createServer();
  srv.on("error", (e) => resolve(e.code));
  srv.listen("/run/automaton-sandbox/runtime.sock", () => { srv.close(); resolve("LISTENING"); });
});
check("runtime cannot create a socket in the shared socket folder", listenRes !== "LISTENING", listenRes);
const listeners = [];
for (const f of ["tcp", "tcp6", "udp", "udp6"]) {
  const rows = fs.readFileSync("/proc/net/" + f, "utf-8").trim().split("\n").slice(1);
  for (const r of rows) {
    const cols = r.trim().split(/\s+/);
    const local = cols[1], st = cols[3], uid = cols[7];
    // Docker's embedded DNS resolver: 127.0.0.11 (0B00007F), owned by root,
    // in the runtime's own network namespace only. Not the runtime's code.
    if (local.startsWith("0B00007F:") && uid === "0") continue;
    if ((f.startsWith("tcp") && st === "0A") || (f.startsWith("udp") && st === "07")) listeners.push(f + " " + r.trim());
  }
}
check("no TCP/UDP listening sockets (except Docker's DNS on 127.0.0.11)", listeners.length === 0, listeners.join(" | "));

// Runtime has no tools to run things with, and no workspace on PATH
const onPath = (bin) => (process.env.PATH || "").split(":").some((dir) => fs.existsSync(path.join(dir, bin)));
check("PATH has no /workspace", !(process.env.PATH || "").includes("/workspace"), process.env.PATH);
for (const bin of ["git", "curl", "npm", "npx", "corepack"]) check("no " + bin + " in the runtime", !onPath(bin));

// Addition 2: skills are loaded only as text; canary code never runs
const reads = [];
const origRead = fs.readFileSync;
fs.readFileSync = function (p, ...rest) { reads.push(String(p)); return origRead.call(this, p, ...rest); };
const { loadSkills } = await import("/app/dist/skills/loader.js");
const skills = new Map();
const db = { getSkills: () => [...skills.values()], getSkillByName: (n) => skills.get(n), upsertSkill: (s) => skills.set(s.name, s) };
const loaded = loadSkills("/workspace/skills", db, { containerSandbox: true });
fs.readFileSync = origRead;
const canary = loaded.find((s) => s.name === "verify-canary");
check("canary skill loaded as text", canary && canary.instructions.includes("Canary text only."));
const skillReads = reads.filter((p) => p.startsWith("/workspace/"));
check("only SKILL.md files read from /workspace", skillReads.length > 0 && skillReads.every((p) => p.endsWith("/SKILL.md")), skillReads.join(","));
check("canary code never ran", !fs.existsSync("/tmp/canary-ran") && globalThis.__canaryRan === undefined);

// Round trip runtime -> sandbox (the only allowed direction)
try {
const { createConwayClient } = await import("/app/dist/conway/client.js");
const c = createConwayClient({ apiUrl: "http://conway.invalid", apiKey: "unused", sandboxId: "", sandbox: { mode: "container" } });
const id = await c.exec("id -u");
check("exec runs in the sandbox as uid 10002", id.stdout.trim() === "10002", id.stdout.trim() + " / " + id.stderr.trim());
const envOut = await c.exec("env");
check("sandbox command environment has no API key", key.length > 0 && !envOut.stdout.includes(key));
const cat = await c.exec("cat /home/automaton/.automaton/wallet.json");
check("sandbox shell cannot read the wallet", cat.exitCode !== 0 && cat.stdout === "", "exit " + cat.exitCode);
const ls = await c.exec("ls /run/secrets");
check("sandbox shell cannot see the secrets folder", ls.exitCode !== 0, "exit " + ls.exitCode);
const marker = crypto.randomBytes(8).toString("hex");
await c.writeFile("/workspace/verify-roundtrip.txt", marker);
check("sandbox writes appear read-only in the runtime", origRead("/workspace/verify-roundtrip.txt", "utf-8") === marker);
let walletRead = "allowed";
try { await c.readFile("/home/automaton/.automaton/wallet.json"); } catch (e) { walletRead = e.message; }
check("sandbox file tool refuses the wallet path", walletRead !== "allowed", walletRead);
let cfgWrite = "allowed";
try { await c.writeFile("/home/automaton/.automaton/automaton.json", "{}"); } catch (e) { cfgWrite = e.message; }
check("sandbox file tool refuses the config path", cfgWrite !== "allowed", cfgWrite);
// write_file tool (run 5, F5): confined to the workspace, written through the sandbox.
const { createBuiltinTools } = await import("/app/dist/agent/tools.js");
const wf = createBuiltinTools("").find((t) => t.name === "write_file");
const wfCtx = { config: { sandbox: { mode: "container", workspaceDir: "/workspace" } }, conway: c, identity: {}, db: null };
const wfOut = await wf.execute({ path: "verify-write-file.txt", content: marker }, wfCtx);
check("write_file tool: a relative path is written to /workspace through the sandbox",
  wfOut === "File written: /workspace/verify-write-file.txt" && origRead("/workspace/verify-write-file.txt", "utf-8") === marker, wfOut);
const wfRoot = await wf.execute({ path: "/root/note.txt", content: "x" }, wfCtx);
check("write_file tool: a path outside the workspace is refused", wfRoot.startsWith("Blocked:") && wfRoot.includes("outside your workspace"), wfRoot);
let expose = "allowed";
try { await c.exposePort(8080); } catch (e) { expose = e.message; }
check("expose_port refused in container mode", expose !== "allowed", expose);
} catch (e) {
  check("round trip runtime -> sandbox", false, e.message);
}

console.log(JSON.stringify({ results }));
`;

// ─── run ───────────────────────────────────────────────────────

function cleanup() {
  docker(["rm", "-f", PROBE, `${PROJECT}-live`, `${PROJECT}-old`, `${PROJECT}-lease`]);
  docker(["rmi", OLD_IMAGE]);
  docker([...COMPOSE, "down", "-v", "--remove-orphans"]);
  fs.rmSync(secretsDir, { recursive: true, force: true });
  fs.rmSync(logsDir, { recursive: true, force: true });
}

let exitCode = 1;
try {
  console.log("agent:verify: building images ...");
  docker([...COMPOSE, "build", "--quiet"], { allowFail: false, timeoutMs: 900_000 });
  // Same image tags as the real agent: say so if it still runs an older build.
  warnStaleRuntimes(DEFAULT_PROJECT, "agent:verify");
  cleanup();
  check("build commit", `runtime and sandbox images are labelled with the git commit (${BUILD_COMMIT})`,
    imageCommit(SERVICE_IMAGES.runtime) === BUILD_COMMIT && imageCommit(SERVICE_IMAGES.sandbox) === BUILD_COMMIT,
    `${imageCommit(SERVICE_IMAGES.runtime)} / ${imageCommit(SERVICE_IMAGES.sandbox)}`);
  fs.mkdirSync(secretsDir, { recursive: true });
  fs.writeFileSync(path.join(secretsDir, "groq_api_key"), fakeSecret + "\n");
fs.writeFileSync(path.join(secretsDir, "openai_api_key"), fakeOpenAiKey + "\n");
  fs.writeFileSync(path.join(secretsDir, "wallet_passphrase"), fakeWalletPassphrase + "\n");
  openFakeSecretsOnLinux();

  console.log("agent:verify: starting the sandbox ...");
  docker([...COMPOSE, "up", "-d", "--wait", "sandbox"], { allowFail: false });

  // Throwaway testnet wallet in the throwaway volume (address only is printed).
  const init = docker([...COMPOSE, "run", "--rm", "-T", "runtime", "--init"]);
  const initJson = findInitResult(init.out + "\n" + init.err);
  check("entrypoint", "--init creates a wallet and prints only the address",
    init.code === 0 && /^0x[0-9a-fA-F]{40}$/.test(initJson?.address ?? "") && Object.keys(initJson ?? {}).sort().join() === "address,configDir,isNew",
    initJson ? `address ${initJson.address}` : init.err.trim());

  // Wallet encryption at rest (Phase 3 step 1). Only the JSON field names are printed, never values.
  const walletKeys = docker([...COMPOSE, "run", "--rm", "-T", "--no-deps", "--entrypoint", "node", "runtime", "-e",
    "const w=JSON.parse(require('fs').readFileSync(process.env.HOME+'/.automaton/wallet.json','utf-8'));console.log(JSON.stringify({keys:Object.keys(w).sort(),version:w.version}))"]);
  const wk = lastJsonLine(walletKeys.out) ?? {};
  check("entrypoint", "--init writes an encrypted wallet (version 2, no privateKey field)",
    wk.version === 2 && Array.isArray(wk.keys) && !wk.keys.includes("privateKey") && wk.keys.includes("ciphertext"),
    JSON.stringify(wk) || walletKeys.err.trim());
  const walletShow = docker([...COMPOSE, "run", "--rm", "-T", "--no-deps", "runtime", "--wallet", "show"]);
  check("entrypoint", "owner command --wallet show: encrypted, address shown, no passphrase in the output",
    walletShow.code === 0 && walletShow.out.includes("Encrypted:  yes (scrypt") && walletShow.out.includes(initJson?.address ?? "?") &&
      !(walletShow.out + walletShow.err).includes(fakeWalletPassphrase),
    (walletShow.out + walletShow.err).trim().slice(0, 400));
  check("entrypoint", "--wallet show reports the network, USDC/ETH balances (or 'unavailable'), limits and transfers",
    walletShow.out.includes("Network:    Base Sepolia (testnet)") && /USDC: {7}(\d+\.\d\d USDC|unavailable)/.test(walletShow.out) &&
      /ETH: {8}(\d+\.\d{6} ETH|unavailable)/.test(walletShow.out) && walletShow.out.includes("Payments:   per transfer $0.25") &&
      walletShow.out.includes("Recent transfers: none"),
    walletShow.out.trim().slice(0, 600));
  const payTest = docker([...COMPOSE, "run", "--rm", "-T", "--no-deps", "runtime", "--payment-test"]);
  check("entrypoint", "--payment-test on the unfunded throwaway wallet stops at its preconditions (nothing sent)",
    payTest.code === 1 && payTest.out.includes("Payment test not started") &&
      /wallet has 0\.00 USDC|cannot read balances/.test(payTest.out) && !payTest.out.includes("PAYMENT TEST"),
    (payTest.out + payTest.err).trim().slice(0, 400));
  const noPass = docker([...COMPOSE, "run", "--rm", "-T", "--no-deps", "--entrypoint", "node", "runtime", "/app/dist/index.js", "--preflight"]);
  check("entrypoint", "without the passphrase (entrypoint skipped) the encrypted wallet is refused at startup",
    noPass.code !== 0 && (noPass.out + noPass.err).includes("encrypted but no passphrase"), `exit ${noPass.code}`);

  const statusRun = docker([...COMPOSE, "run", "--rm", "-T", "runtime", "--status"]);
  check("entrypoint", "--status shows Base Sepolia (testnet)", statusRun.code === 0 && (statusRun.out + statusRun.err).includes("Base Sepolia (testnet)"), statusRun.code);

  // --preflight: the real startup path without a Conway key (fake model key,
  // no model call, agent not started; one read-only RPC call to Base Sepolia).
  const pre = docker([...COMPOSE, "run", "--rm", "-T", "runtime", "--preflight"]);
  const preOut = pre.out + pre.err;
  check("entrypoint", "--preflight passes with no Conway key (only FAIL: OpenAI rejects verify's fake key in the model check)",
    preflightOkButFakeKey(preOut), failSummary(preOut));
  check("entrypoint", "--preflight asks OpenAI's model list for gpt-6-luna only (fake key rejected: one FAIL; 'not checked'; reasoning effort none)",
    preOut.includes("INFO  model gpt-6-luna: not checked (openai model list unavailable)") &&
      preOut.includes("INFO  reasoning effort (OpenAI reasoning models only): none") && !/gpt-4\.1-(nano|mini)/.test(preOut),
    preOut.split("\n").filter((l) => /model|reasoning/.test(l)).join(" | ").slice(0, 600));
  check("entrypoint", "--preflight: Conway off, sandbox reached as uid 10002, model key from secrets",
    preOut.includes("Conway: off (own providers only") && preOut.includes("sandbox: reachable, runs as uid 10002") &&
    preOut.includes("model gpt-6-luna: provider openai, key present"));
  check("entrypoint", "--preflight with the normal template: 9 tools offered (switch_model removed, model fix 3/3)",
    / INFO {2}tools: 9 offered,|^INFO {2}tools: 9 offered,/m.test(preOut), preOut.split("\n").find((l) => l.includes("tools:")) ?? "no tools line");
  check("build commit", "--preflight prints the build commit", preOut.includes(`build: ${BUILD_COMMIT}`));
  check("entrypoint", "--preflight: template wake limits (6 turns per wake, 1800 s sleep floor, 48 wakes/day)",
    preOut.includes("wake limits: 6 turns per wake, sleep at least 1800 s, 48 wakes per UTC day"));
  check("entrypoint", "--preflight shows today's inference spend against the 30c daily cap (not reached)",
    preOut.includes("INFO  inference today (UTC): $0.00 of $0.30 daily cap"));
  check("entrypoint", "--preflight prints no key values", !preOut.includes(fakeSecret) && !preOut.includes(fakeOpenAiKey));
  check("entrypoint", "--preflight uses the creator address from AUTOMATON_CREATOR_ADDRESS", preOut.includes(`creator: ${VERIFY_CREATOR}`));
  check("entrypoint", "--preflight prints the runway estimate and the wallet read cache",
    /INFO {2}Runway: /.test(preOut) && preOut.includes("INFO  wallet balance: read on chain at most every 300 s"),
    preOut.split("\n").filter((l) => /Runway:|wallet balance:/.test(l)).join(" | ") || "no runway line");
  check("entrypoint", "--preflight with the normal template: no payment tool offered to the agent",
    preOut.includes("INFO  payment tools offered: none"), preOut.split("\n").find((l) => l.includes("payment tools")) ?? "no line");
  check("entrypoint", "--preflight shows the template's payment limits; only the creator may receive payments",
    preOut.includes(`INFO  payments: per transfer $0.25, hour $0.50, day $1.00, reserve $1.00, 1/turn; recipients: creator ${VERIFY_CREATOR.toLowerCase()}`),
    preOut.split("\n").find((l) => l.includes("payments:")) ?? "no payments line");
  const preNoCreator = docker([...COMPOSE, "run", "--rm", "-T", "-e", "AUTOMATON_CREATOR_ADDRESS=", "runtime", "--preflight"]);
  check("entrypoint", "--preflight refuses without a creator address",
    preNoCreator.code !== 0 && (preNoCreator.out + preNoCreator.err).includes("No creator address"), `exit ${preNoCreator.code}`);

  const settingsShow = docker([...COMPOSE, "run", "--rm", "-T", "runtime", "--settings", "show"]);
  check("entrypoint", "owner command --settings show works; agent genesis changes OFF by default",
    settingsShow.code === 0 && settingsShow.out.includes("=== AGENT SETTINGS ===") && /Genesis prompt[\s\S]*agent changes OFF/.test(settingsShow.out),
    settingsShow.code === 0 ? "" : settingsShow.err.trim());
  const settingsReset = docker([...COMPOSE, "run", "--rm", "-T", "runtime", "--settings", "reset"]);
  check("entrypoint", "owner command --settings reset works", settingsReset.code === 0 && settingsReset.out.includes("No agent settings to reset."), settingsReset.err.trim());
  const soulReset = docker([...COMPOSE, "run", "--rm", "-T", "--no-deps", "runtime", "--soul", "reset"]);
  check("entrypoint", "owner command --soul reset writes a fresh soul from the template settings, identity from the runtime",
    soulReset.code === 0 && soulReset.out.includes("Soul reset: version") && soulReset.out.includes("Name: automaton-testnet") &&
      /Address: 0x[0-9a-fA-F]{40}/.test(soulReset.out) && soulReset.out.includes(`Creator: ${VERIFY_CREATOR}`) &&
      soulReset.out.includes("- Spend as little as possible: few turns, then sleep"),
    (soulReset.out + soulReset.err).trim().slice(0, 500));
  check("entrypoint", "template keeps corePurpose owner-only (soulConfig.ownerOnlySections)",
    soulReset.out.includes("Owner-only sections: corePurpose (the agent cannot change them"),
    soulReset.out.trim().slice(-300));

  const factsList = docker([...COMPOSE, "run", "--rm", "-T", "--no-deps", "runtime", "--facts", "list"]);
  check("entrypoint", "owner command --facts list works",
    factsList.code === 0 && factsList.out.includes("=== FACTS (semantic_memory)"), (factsList.out + factsList.err).trim().slice(0, 300));

  // Owner ledger commands (throwaway verify volume; the real wallet volume is never touched).
  const ledgerShow = docker([...COMPOSE, "run", "--rm", "-T", "runtime", "--ledger", "show"]);
  check("entrypoint", "owner command --ledger show works (testnet ledger)",
    ledgerShow.code === 0 && ledgerShow.out.includes("Ledger (testnet: all entries)"), ledgerShow.err.trim());
  const ledgerGrant = docker([...COMPOSE, "run", "--rm", "-T", "runtime", "--ledger", "grant", "5.00"]);
  const ledgerAfter = docker([...COMPOSE, "run", "--rm", "-T", "runtime", "--ledger", "show"]);
  check("entrypoint", "owner command --ledger grant 5.00 persists in the volume",
    ledgerGrant.code === 0 && ledgerGrant.out.includes("Granted $5.00.") && /owner_grant\s+\$5\.00\s+\(1\)/.test(ledgerAfter.out),
    ledgerGrant.code === 0 ? ledgerAfter.out.trim() : ledgerGrant.err.trim());
  const ledgerBad = docker([...COMPOSE, "run", "--rm", "-T", "runtime", "--ledger", "grant", "-5"]);
  check("entrypoint", "owner command --ledger grant refuses a negative amount", ledgerBad.code === 1 && ledgerBad.out.includes("Usage: ledger grant"), `exit ${ledgerBad.code}`);

  const mainnet = docker([...COMPOSE, "run", "--rm", "-T", "-e", "AUTOMATON_MAINNET_APPROVED=0x0000000000000000000000000000000000000001", "runtime", "--status"]);
  check("entrypoint", "refuses to start when AUTOMATON_MAINNET_APPROVED is set", mainnet.code === 64 && mainnet.err.includes("refusing to start"), `exit ${mainnet.code}`);

  // Long-lived runtime container (no agent loop) to inspect and to test routes against.
  docker([...COMPOSE, "run", "-d", "--name", PROBE, "--entrypoint", "node", "runtime", "-e", "setTimeout(()=>{},600000)"], { allowFail: false });
  const probe = inspect(PROBE);
  const nets = Object.keys(probe.NetworkSettings.Networks ?? {});
  const runtimeIp = Object.values(probe.NetworkSettings.Networks ?? {})[0]?.IPAddress ?? "";
  hardeningChecks("runtime container", probe, "10001:10001");
  check("runtime container", "only on the egress network", nets.length === 1 && nets[0] === `${PROJECT}_egress`, nets.join(","));
  const binds = probe.Mounts.filter((m) => m.Type === "bind");
  check("runtime container", "host folders: only the config file and the secrets folder, both read-only",
    binds.length === 2 && binds.every((m) => m.RW === false) &&
    binds.some((m) => m.Destination === "/home/automaton/.automaton/automaton.json") &&
    binds.some((m) => m.Destination === "/run/secrets/automaton"),
    binds.map((m) => `${m.Destination}${m.RW ? " (rw)" : " (ro)"}`).join(", "));
  const vol = (dest) => probe.Mounts.find((m) => m.Destination === dest);
  check("runtime container", "workspace and socket volumes are read-only", vol("/workspace")?.RW === false && vol("/run/automaton-sandbox")?.RW === false);

  const sandboxId = docker([...COMPOSE, "ps", "-q", "sandbox"]).out.trim();
  const sbx = inspect(sandboxId);
  hardeningChecks("sandbox container", sbx, "10002:10002");
  check("sandbox container", "network mode none", sbx.HostConfig.NetworkMode === "none", sbx.HostConfig.NetworkMode);
  check("sandbox container", "no host folders mounted", !sbx.Mounts.some((m) => m.Type === "bind"), sbx.Mounts.map((m) => m.Type + ":" + m.Destination).join(", "));
  check("sandbox container", "no runtime volume or secrets mounted",
    !sbx.Mounts.some((m) => /automaton-home/.test(m.Name ?? "") || m.Destination.startsWith("/run/secrets") || m.Destination.startsWith("/home/automaton")));

  console.log("agent:verify: checks inside the sandbox ...");
  const sres = docker([...COMPOSE, "exec", "-T", "sandbox", "node", "--input-type=module", "-"], { input: sandboxScript(runtimeIp) });
  for (const r of lastJsonLine(sres.out)?.results ?? [{ name: "sandbox script ran", ok: false, detail: sres.err.trim() }]) {
    check("inside the sandbox", r.name, r.ok, r.detail);
  }

  console.log("agent:verify: checks inside the runtime ...");
  const rres = docker(
    [...COMPOSE, "run", "--rm", "-T", "--entrypoint", "sh", "runtime", "-c", ". /usr/local/lib/automaton/load-secrets.sh && exec node --input-type=module -"],
    { input: runtimeScript },
  );
  for (const r of lastJsonLine(rres.out)?.results ?? [{ name: "runtime script ran", ok: false, detail: rres.err.trim() }]) {
    check("inside the runtime", r.name, r.ok, r.detail);
  }

  // ─── kill command (pnpm agent:kill) ──────────────────────────
  console.log("agent:verify: kill command ...");
  const killScript = path.join(ROOT, "docker", "kill-agent.mjs");
  const runningBefore = docker(["ps", "-q", "--filter", `label=com.docker.compose.project=${PROJECT}`]).out.trim().split(/\s+/).filter(Boolean);
  check("kill command", "sandbox and runtime are running before the kill", runningBefore.length >= 2, `${runningBefore.length} running`);
  const t0 = Date.now();
  const kill = spawnSync(process.execPath, [killScript, "--project", PROJECT], { encoding: "utf-8", env, timeout: 60_000 });
  const killMs = Date.now() - t0;
  const runningAfter = docker(["ps", "-q", "--filter", `label=com.docker.compose.project=${PROJECT}`]).out.trim();
  check("kill command", "exits 0", kill.status === 0, (kill.stderr || kill.stdout).trim());
  check("kill command", "nothing of the project is running afterwards", runningAfter === "", runningAfter);
  check("kill command", "stops everything within 5 seconds", killMs < 5_000, `${killMs} ms`);
  const volumes = docker(["volume", "ls", "-q", "--filter", `name=${PROJECT}_`]).out.split(/\s+/);
  check("kill command", "volumes are kept", ["automaton-home", "agent-workspace", "sandbox-socket", "sandbox-home"].every((v) => volumes.includes(`${PROJECT}_${v}`)), volumes.join(","));
  const walletKept = docker([...COMPOSE, "run", "--rm", "-T", "--entrypoint", "sh", "runtime", "-c", "test -f /home/automaton/.automaton/wallet.json"]);
  check("kill command", "wallet is still there after the kill", walletKept.code === 0, `exit ${walletKept.code}`);
  docker([...COMPOSE, "stop", "-t", "0", "sandbox"]);
  const again = spawnSync(process.execPath, [killScript, "--project", PROJECT], { encoding: "utf-8", env, timeout: 60_000 });
  check("kill command", "running it again is safe (exit 0)", again.status === 0, (again.stderr || again.stdout).trim());
  const none = spawnSync(process.execPath, [killScript, "--project", `${PROJECT}-nothing-here`], { encoding: "utf-8", env, timeout: 60_000 });
  check("kill command", "with nothing running: exit 0", none.status === 0 && /nothing running/.test(none.stdout), none.stdout.trim());

  // ─── one-off commands (docker/run-oneoff.mjs) ────────────────
  // Starts from nothing running (after the kill above).
  console.log("agent:verify: one-off commands ...");
  const oneoffScript = path.join(ROOT, "docker", "run-oneoff.mjs");
  const oneoff = (args) => spawnSync(process.execPath, [oneoffScript, "--project", PROJECT, ...args], { encoding: "utf-8", env, timeout: 300_000 });
  const sandboxIds = (all) => docker([...COMPOSE, "ps", ...(all ? ["-a"] : []), "-q", "sandbox"]).out.trim();
  const ledgerOneoff = oneoff(["--", "--ledger", "show"]);
  check("one-off commands", "ledger show works and never creates the sandbox",
    ledgerOneoff.status === 0 && ledgerOneoff.stdout.includes("Ledger (testnet") && sandboxIds(true) === "",
    `exit ${ledgerOneoff.status}; sandbox ${sandboxIds(true) || "none"}`);
  const preOneoff = oneoff(["--needs-sandbox", "--", "--preflight"]);
  check("one-off commands", "preflight passes and stops the sandbox it started",
    preflightOkButFakeKey(preOneoff.stdout) && sandboxIds(true) === "",
    `exit ${preOneoff.status}; sandbox ${sandboxIds(true) || "none"}; ${failSummary(preOneoff.stdout)}`);
  docker([...COMPOSE, "up", "-d", "--wait", "sandbox"], { allowFail: false });
  const preKeep = oneoff(["--needs-sandbox", "--", "--preflight"]);
  check("one-off commands", "preflight leaves an already running sandbox running",
    preflightOkButFakeKey(preKeep.stdout) && sandboxIds(false) !== "", `exit ${preKeep.status}; ${failSummary(preKeep.stdout)}`);
  // Config template switch (AUTOMATON_CONFIG_TEMPLATE, Phase 3 step 7).
  const withTemplate = (value, args) => spawnSync(process.execPath, [oneoffScript, "--project", PROJECT, ...args],
    { encoding: "utf-8", env: { ...env, AUTOMATON_CONFIG_TEMPLATE: value }, timeout: 300_000 });
  const badTpl = withTemplate("../compose.agent.yml", ["--", "--ledger", "show"]);
  check("one-off commands", "AUTOMATON_CONFIG_TEMPLATE outside ./automaton.<name>.json is refused before compose runs (exit 2)",
    badTpl.status === 2 && badTpl.stderr.includes("AUTOMATON_CONFIG_TEMPLATE must look like"), `exit ${badTpl.status}: ${badTpl.stderr.trim()}`);
  const payTpl = withTemplate("./automaton.paytest.json", ["--needs-sandbox", "--", "--preflight"]);
  check("one-off commands", "the paytest template: noted, preflight passes, send_usdc offered",
    payTpl.stderr.includes("note: config template ./automaton.paytest.json") &&
      preflightOkButFakeKey(payTpl.stdout) && payTpl.stdout.includes("INFO  payment tools offered: send_usdc"),
    `exit ${payTpl.status}; ${(payTpl.stdout.split("\n").find((l) => l.includes("payment tools")) ?? payTpl.stdout.slice(-300)).trim()}`);
  // Owner --wallet send (Phase 4 step 7) on the unfunded throwaway wallet: plan printed, dry run refuses, nothing sent.
  const wsDry = oneoff(["--", "--wallet", "send", "10"]);
  check("one-off commands", "--wallet send (dry run): prints project, wallet, creator, amount, balance after; refused (empty wallet); nothing sent",
    wsDry.status === 1 && wsDry.stdout.includes("DRY RUN (add --confirm to send)") && wsDry.stdout.includes(`Project:          ${PROJECT}`) &&
      /Agent wallet: {5}0x[0-9a-fA-F]{40}/.test(wsDry.stdout) && wsDry.stdout.includes(`To (creator):     ${VERIFY_CREATOR}`) &&
      wsDry.stdout.includes("Amount:           0.10 USDC") && wsDry.stdout.includes("Wallet USDC:      0.00 USDC → -0.10 USDC after") &&
      /REFUSED/.test(wsDry.stdout) && !/RESULT: Sent/.test(wsDry.stdout),
    `exit ${wsDry.status}: ${wsDry.stdout.trim().split("\n").filter((l) => /Project|REFUSED|RESULT|DRY/.test(l)).join(" | ")}`);
  const wsOther = oneoff(["--", "--wallet", "send", "10", "0x3333333333333333333333333333333333333333", "--confirm"]);
  check("one-off commands", "--wallet send refuses any recipient other than the creator (exit 2, nothing started)",
    wsOther.status === 2 && wsOther.stdout.includes("pays only the creator address"), `exit ${wsOther.status}: ${wsOther.stdout.trim()}`);
  // The tier-walk template and project go together (never against the main agent).
  const tplEnv = (value) => ({ ...env, AUTOMATON_CONFIG_TEMPLATE: value });
  const twMain = spawnSync(process.execPath, [oneoffScript, "--project", PROJECT, "--", "--ledger", "show"], { encoding: "utf-8", env: tplEnv("./automaton.tierwalk.json"), timeout: 60_000 });
  check("one-off commands", "the tier-walk template is refused for any project other than automaton-tierwalk (exit 2)",
    twMain.status === 2 && twMain.stderr.includes("the tier-walk template is only for --project automaton-tierwalk"), `exit ${twMain.status}: ${twMain.stderr.trim()}`);
  const twNoTpl = spawnSync(process.execPath, [oneoffScript, "--project", "automaton-tierwalk", "--", "--ledger", "show"], { encoding: "utf-8", env, timeout: 60_000 });
  check("one-off commands", "project automaton-tierwalk is refused without the tier-walk template (exit 2, nothing started)",
    twNoTpl.status === 2 && twNoTpl.stderr.includes("project automaton-tierwalk needs AUTOMATON_CONFIG_TEMPLATE=./automaton.tierwalk.json"),
    `exit ${twNoTpl.status}: ${twNoTpl.stderr.trim()}`);
  // The tier-walk template passes the real startup checks (throwaway verify project, direct compose run).
  const twPre = spawnSync("docker", [...COMPOSE, "run", "--rm", "-T", "runtime", "--preflight"], { cwd: ROOT, encoding: "utf-8", env: tplEnv("./automaton.tierwalk.json"), timeout: 300_000 });
  check("one-off commands", "the tier-walk template passes preflight: scaled tiers, reserve $0, creator only, no payment tool for the agent",
    preflightOkButFakeKey(twPre.stdout) &&
      twPre.stdout.includes("INFO  survival tiers: high > $0.40, normal > $0.30, low_compute > $0.15, critical >= $0.00, dead below $0 or after 5 min at <= $0; tier-change wakes at least 1 min apart") &&
      twPre.stdout.includes("per transfer $0.25, hour $0.60, day $1.00, reserve $0.00") && twPre.stdout.includes("INFO  payment tools offered: none"),
    `exit ${twPre.status}: ${(twPre.stdout + twPre.stderr).split("\n").filter((l) => /FAIL|survival tiers|payments:|payment tools|PREFLIGHT/.test(l)).join(" | ")}`);
  const failOneoff = oneoff(["--", "--ledger", "grant", "-5"]);
  check("one-off commands", "passes the runtime's exit code through", failOneoff.status === 1, `exit ${failOneoff.status}`);

  // ─── one agent per project (incident 2026-11-16) ─────────────
  // A stand-in for a live agent:run runtime (one-off runtime container, no
  // agent loop). The real agent is never started; --init is the refused command.
  console.log("agent:verify: one agent per project ...");
  const statusScript = path.join(ROOT, "docker", "status-agent.mjs");
  const status = () => spawnSync(process.execPath, [statusScript, "--project", PROJECT], { encoding: "utf-8", env, timeout: 180_000 });
  const st0 = status();
  check("one agent per project", "agent:status with no runtime: 'not running' plus the activity report from state.db",
    st0.status === 0 && st0.stdout.includes("Runtime:  not running") && st0.stdout.includes("=== AGENT ACTIVITY (state.db) ==="),
    (st0.stdout + st0.stderr).trim());
  const LIVE = `${PROJECT}-live`;
  docker([...COMPOSE, "run", "-d", "--name", LIVE, "--entrypoint", "node", "runtime", "-e",
    "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"], { allowFail: false });
  const st1 = status();
  check("one agent per project", "agent:status shows the running runtime by name",
    st1.status === 0 && st1.stdout.includes("Runtime:  RUNNING, 1 container(s)") && st1.stdout.includes(LIVE), st1.stdout.trim());
  const initRefused = oneoff(["--", "--init"]);
  check("one agent per project", "--init is refused while a runtime runs, naming it (exit 1)",
    initRefused.status === 1 && initRefused.stderr.includes("refusing --init") && initRefused.stderr.includes(LIVE),
    `exit ${initRefused.status}: ${initRefused.stderr.trim()}`);
  const soulRefused = oneoff(["--", "--soul", "reset"]);
  check("one agent per project", "--soul reset is refused while a runtime runs (exit 1)",
    soulRefused.status === 1 && soulRefused.stderr.includes("refusing --soul reset"), `exit ${soulRefused.status}: ${soulRefused.stderr.trim()}`);
  const sendRefused = oneoff(["--", "--wallet", "send", "10", "--confirm"]);
  check("one agent per project", "--wallet send is refused while a runtime runs (exit 1)",
    sendRefused.status === 1 && sendRefused.stderr.includes("refusing --wallet send"), `exit ${sendRefused.status}: ${sendRefused.stderr.trim()}`);
  const payRefused = oneoff(["--", "--payment-test"]);
  check("one agent per project", "--payment-test is refused while a runtime runs (exit 1)",
    payRefused.status === 1 && payRefused.stderr.includes("refusing --payment-test"), `exit ${payRefused.status}: ${payRefused.stderr.trim()}`);
  const walletEncRefused = oneoff(["--", "--wallet", "encrypt"]);
  check("one agent per project", "--wallet encrypt is refused while a runtime runs (exit 1)",
    walletEncRefused.status === 1 && walletEncRefused.stderr.includes("refusing --wallet encrypt"), `exit ${walletEncRefused.status}: ${walletEncRefused.stderr.trim()}`);
  const factsRefused = oneoff(["--", "--facts", "delete", "self/x"]);
  check("one agent per project", "--facts delete is refused while a runtime runs (exit 1)",
    factsRefused.status === 1 && factsRefused.stderr.includes("refusing --facts delete"), `exit ${factsRefused.status}: ${factsRefused.stderr.trim()}`);
  const ledgerLive = oneoff(["--", "--ledger", "show"]);
  check("one agent per project", "ledger show still works, with a note that the agent is running",
    ledgerLive.status === 0 && ledgerLive.stderr.includes("note: the agent is running"), `exit ${ledgerLive.status}`);
  docker([...COMPOSE, "stop", "-t", "0", "sandbox"]);
  docker([...COMPOSE, "rm", "-f", "sandbox"]);
  const preLive = oneoff(["--needs-sandbox", "--", "--preflight"]);
  check("one agent per project", "a one-off never removes a sandbox another runtime uses",
    preflightOkButFakeKey(preLive.stdout) && sandboxIds(false) !== "" && preLive.stderr.includes("sandbox left running"),
    `exit ${preLive.status}; sandbox ${sandboxIds(false) || "none"}`);
  docker(["rm", "-f", LIVE]);

  // A runtime started before a rebuild: an image derived from the current one
  // stands in for the old build (no network, no agent loop).
  docker(["build", "-q", "-t", OLD_IMAGE, "-"], {
    input: `FROM ${SERVICE_IMAGES.runtime}\nLABEL org.automaton.build-commit=verify-old\n`, allowFail: false,
  });
  docker(["run", "-d", "--name", `${PROJECT}-old`, "--network", "none",
    "--label", `com.docker.compose.project=${PROJECT}`, "--label", "com.docker.compose.service=runtime",
    "--entrypoint", "node", OLD_IMAGE, "-e", "setInterval(()=>{},1000)"], { allowFail: false });
  const st2 = status();
  check("build commit", "agent:status flags a runtime that still runs an older image, with its build",
    st2.stdout.includes(`${PROJECT}-old`) && st2.stdout.includes("build verify-old") && st2.stdout.includes("OLD IMAGE"),
    st2.stdout.trim());
  docker(["rm", "-f", `${PROJECT}-old`]);
  docker(["rmi", OLD_IMAGE]);

  // Runtime instance lease across containers on the shared state.db (the
  // backstop in code). Lease functions only; the agent loop is never started.
  const LEASE_JS = `import { createDatabase } from "/app/dist/state/database.js";
import { acquireRuntimeLease, releaseRuntimeLease } from "/app/dist/runtime/instance-lease.js";
const db = createDatabase(process.env.HOME + "/.automaton/state.db");
const r = acquireRuntimeLease(db.raw, { host: process.argv[1], pid: process.pid, build: "verify" });
console.log(JSON.stringify({ ok: r.ok, holder: r.ok ? null : r.holder.host }));`;
  const holderJs = `${LEASE_JS}
process.on("SIGTERM", () => { if (r.ok) releaseRuntimeLease(db.raw, r.lease.instanceId); db.close(); process.exit(0); });
setInterval(() => {}, 1000);`;
  const tryJs = `${LEASE_JS}
if (r.ok) releaseRuntimeLease(db.raw, r.lease.instanceId);
db.close();`;
  const HOLDER = `${PROJECT}-lease`;
  docker([...COMPOSE, "run", "-d", "--no-deps", "--name", HOLDER, "--entrypoint", "node", "runtime",
    "--input-type=module", "-e", holderJs, "verify-holder"], { allowFail: false });
  const tryLease = () => lastJsonLine(docker([...COMPOSE, "run", "--rm", "-T", "--no-deps", "--entrypoint", "node", "runtime",
    "--input-type=module", "-e", tryJs, "verify-second"]).out) ?? {};
  let held = {};
  for (let i = 0; i < 20 && held.holder !== "verify-holder"; i++) held = tryLease(); // holder may still be starting
  check("runtime lease", "a second runtime container is refused while another holds the lease",
    held.ok === false && held.holder === "verify-holder", JSON.stringify(held));
  const preHeld = oneoff(["--needs-sandbox", "--", "--preflight"]);
  check("runtime lease", "--preflight reports the lease as held", preHeld.stdout.includes("runtime lease: HELD"), `exit ${preHeld.status}`);
  const soulHeld = docker([...COMPOSE, "run", "--rm", "-T", "--no-deps", "runtime", "--soul", "reset"]);
  check("runtime lease", "--soul reset is refused by the runtime while another holds the lease",
    soulHeld.code === 1 && soulHeld.out.includes("Refusing to reset the soul while an agent is running"), `exit ${soulHeld.code}`);
  const factsHeld = docker([...COMPOSE, "run", "--rm", "-T", "--no-deps", "runtime", "--facts", "delete", "self/x"]);
  check("runtime lease", "--facts delete is refused by the runtime while another holds the lease",
    factsHeld.code === 1 && factsHeld.out.includes("Refusing to delete facts while an agent is running"), `exit ${factsHeld.code}`);
  docker(["stop", "-t", "10", HOLDER]);
  docker(["rm", "-f", HOLDER]);
  const freed = tryLease();
  check("runtime lease", "after a graceful stop the lease is free at once", freed.ok === true, JSON.stringify(freed));

  // ─── detached runs and saved logs ────────────────────────────
  // `--status` stands in for `--run` (the agent loop is never started).
  console.log("agent:verify: detached runs and logs ...");
  const G = "detached runs and logs";
  const logsScript = path.join(ROOT, "docker", "logs-agent.mjs");
  const logsOf = () => spawnSync(process.execPath, [logsScript, "--project", PROJECT], { encoding: "utf-8", env, timeout: 60_000 });
  const savedLogs = () =>
    fs.existsSync(logsDir) ? fs.readdirSync(logsDir).map((f) => fs.readFileSync(path.join(logsDir, f), "utf-8")).join("\n") : "";
  const runtimeIds = (status) => docker(["ps", "-a", "-q", "--filter", `label=com.docker.compose.project=${PROJECT}`,
    "--filter", "label=com.docker.compose.service=runtime", ...(status ? ["--filter", `status=${status}`] : [])]).out.trim();
  const det = oneoff(["--needs-sandbox", "--", "--status", "--detach"]);
  check(G, "--detach starts the runtime in the background and returns", det.status === 0 && det.stdout.includes("started detached"),
    (det.stdout + det.stderr).trim());
  let lg = { stdout: "", stderr: "" };
  for (let i = 0; i < 20; i++) {
    lg = logsOf();
    if (lg.stdout.includes("=== AUTOMATON STATUS ===") && lg.stderr.includes("stopped, exit 0")) break;
    sleepSync(1000);
  }
  check(G, "agent:logs shows its log, also after it exited", lg.stdout.includes("=== AUTOMATON STATUS ===") && lg.stderr.includes("stopped, exit 0"),
    lg.stderr.trim());
  check(G, "the detached container is kept after it exits (log readable)", runtimeIds("exited") !== "");
  check(G, "the sandbox is left running for a detached run", sandboxIds(false) !== "");
  // An interactive-style (--rm) runtime: it vanishes when stopped, so its log is saved first.
  docker([...COMPOSE, "run", "-d", "--rm", "--name", `${PROJECT}-rm`, "--entrypoint", "node", "runtime", "-e",
    "console.log('verify-rm-marker');process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"], { allowFail: false });
  sleepSync(2000);
  const downScriptA3 = path.join(ROOT, "docker", "down-agent.mjs");
  const dn = spawnSync(process.execPath, [downScriptA3, "--project", PROJECT], { encoding: "utf-8", env, timeout: 180_000 });
  check(G, "agent:down saves both logs (--rm one before it stops, detached one after) and removes them",
    dn.status === 0 && savedLogs().includes("=== AUTOMATON STATUS ===") && savedLogs().includes("verify-rm-marker") && runtimeIds() === "",
    (dn.stdout + dn.stderr).trim());
  docker([...COMPOSE, "run", "-d", "--name", `${PROJECT}-killme`, "--entrypoint", "node", "runtime", "-e",
    "console.log('verify-kill-marker');setInterval(()=>{},1000)"], { allowFail: false });
  sleepSync(2000);
  const kl = spawnSync(process.execPath, [killScript, "--project", PROJECT], { encoding: "utf-8", env, timeout: 60_000 });
  check(G, "agent:kill saves the log too", kl.status === 0 && savedLogs().includes("verify-kill-marker") && runtimeIds() === "",
    (kl.stdout + kl.stderr).trim());

  // ─── watchdog (pnpm agent:watch) ─────────────────────────────
  // Stand-in runtimes (node only, no agent loop); state.db is the verify volume's.
  console.log("agent:verify: watchdog ...");
  const W = "watchdog";
  const watchScript = path.join(ROOT, "docker", "watch-agent.mjs");
  const watch = (extra) => spawnSync(process.execPath, [watchScript, "--project", PROJECT, ...extra], { encoding: "utf-8", env, timeout: 300_000 });
  const standInW = (name, code) =>
    docker([...COMPOSE, "run", "-d", "--name", name, "--entrypoint", "node", "runtime", "-e", code], { allowFail: false });
  const KEEP = "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)";
  const w0 = watch(["--once"]);
  check(W, "with no runtime running: nothing to watch (exit 1)", w0.status === 1 && w0.stdout.includes("nothing to watch"), w0.stdout.trim());
  standInW(`${PROJECT}-w1`, KEEP);
  const w1 = watch(["--once"]);
  check(W, "--once with a healthy runtime: all checks pass, the agent is left running",
    w1.status === 0 && w1.stdout.includes("all checks passed") && runtimeIds("running") !== "", (w1.stdout + w1.stderr).trim());
  check(W, "the check line shows the runtime's memory and CPU (docker stats)",
    /\| runtime \d+MiB [\d.]+% cpu/.test(w1.stdout), w1.stdout.split("\n").find((l) => l.includes("check:")) ?? w1.stdout.trim());
  // Offline wakes (run 5, F6): kv offline_streak as the loop writes it.
  const setOffline = (n) => docker([...COMPOSE, "run", "--rm", "-T", "--no-deps", "--entrypoint", "node", "runtime", "--input-type=module", "-e",
    `import { createDatabase } from "/app/dist/state/database.js";
const db = createDatabase(process.env.HOME + "/.automaton/state.db");
${n > 0 ? `db.setKV("offline_streak", "${n}");` : `db.deleteKV("offline_streak");`}
db.close();`], { allowFail: false });
  setOffline(1);
  const wOff1 = watch(["--once"]);
  check(W, "one offline wake is reported but does not stop the run",
    wOff1.status === 0 && wOff1.stdout.includes("OFFLINE 1 wake(s) in a row") && runtimeIds("running") !== "", (wOff1.stdout + wOff1.stderr).trim());
  setOffline(5);
  const wOff5 = watch(["--once"]);
  check(W, "more than 4 offline wakes in a row stop the run (exit 2)",
    wOff5.status === 2 && wOff5.stdout.includes("STOP: 5 wakes in a row could not reach the model API (> 4)") && runtimeIds("running") === "",
    (wOff5.stdout + wOff5.stderr).trim());
  setOffline(0);
  // Dead agent (Phase 4 step 5): the watchdog reports the owner notice, then stops gracefully.
  const setDead = (on) => docker([...COMPOSE, "run", "--rm", "-T", "--no-deps", "--entrypoint", "node", "runtime", "--input-type=module", "-e",
    `import { createDatabase } from "/app/dist/state/database.js";
const db = createDatabase(process.env.HOME + "/.automaton/state.db");
${on
  ? `db.setAgentState("dead"); db.setKV("dead_notice", JSON.stringify({ since: "2026-11-23T20:00:00.000Z", reason: "verify", network: "Base Sepolia (testnet)", balanceCentsAtEntry: 0 }));
db.setKV("last_known_balance", JSON.stringify({ creditsCents: 0, usdcBalance: 0 }));`
  : `db.setAgentState("sleeping"); db.deleteKV("dead_notice"); db.deleteKV("last_known_balance");`}
db.close();`], { allowFail: false });
  standInW(`${PROJECT}-w1d`, KEEP);
  setDead(true);
  const wDead = watch(["--once"]);
  check(W, "a dead agent: the notice (since, wallet to fund, amounts) is reported, then a graceful stop (exit 2)",
    wDead.status === 2 && wDead.stdout.includes("DEAD NOTICE: DEAD since 2026-11-23 20:00:00 UTC (verify)") &&
      /Fund 0x[0-9a-fA-F]{40} on Base Sepolia \(testnet\): at least 0\.01 USDC to revive \(critical\), 0\.51 USDC to reach normal/.test(wDead.stdout) &&
      wDead.stdout.includes("STOP: the agent is dead") && runtimeIds("running") === "",
    `exit ${wDead.status}; ` + wDead.stdout.split("\n").filter((l) => /DEAD NOTICE|STOP/.test(l)).join(" | "));
  const stDead = status();
  check(W, "agent:status shows the dead notice while dead",
    stDead.stdout.includes("!!! DEAD since 2026-11-23 20:00:00 UTC (verify)"), stDead.stdout.trim().slice(0, 500));

  // --allow-tiers (Phase 4 step 6): only real tier names; skips only the tier stops.
  for (const bad of [["--allow-tiers", "sleepy"], ["--allow-tiers", "critical,zombie"], ["--allow-tiers"], ["--allow-tiers", "--once"]]) {
    const wb = watch([...bad, "--once"].filter((v, i, arr) => !(v === "--once" && arr.indexOf("--once") !== i)));
    check(W, `--allow-tiers refuses ${JSON.stringify(bad.slice(1).join(" ") || "(no value)")} before watching (exit 2)`,
      wb.status === 2 && wb.stderr.includes("--allow-tiers takes a comma list of tier names") && !wb.stdout.includes("check:"),
      `exit ${wb.status}: ${wb.stderr.trim()}`);
  }
  standInW(`${PROJECT}-w1e`, KEEP);
  const wAllow = watch(["--once", "--allow-tiers", "low_compute,critical,dead"]);
  check(W, "--allow-tiers low_compute,critical,dead: banner, dead notice reported, no stop, agent left running",
    wAllow.status === 0 && wAllow.stdout.includes("!!! --allow-tiers: the watchdog will NOT stop on tier(s): low_compute, critical, dead.") &&
      wAllow.stdout.includes("!!! Still stops on tier(s): none. All other stop rules stay on: money caps (run 5c, hour 3c)") &&
      wAllow.stdout.includes("DEAD NOTICE (not stopping: --allow-tiers dead): DEAD since 2026-11-23 20:00:00 UTC (verify)") &&
      wAllow.stdout.includes("(allowed by --allow-tiers)") && wAllow.stdout.includes("all checks passed") && runtimeIds("running") !== "",
    (wAllow.stdout + wAllow.stderr).trim().split("\n").filter((l) => /!!!|DEAD|STOP|passed|check:/.test(l)).join(" | ").slice(0, 900));
  const beforeCost = new Date().toISOString();
  docker([...COMPOSE, "run", "--rm", "-T", "--no-deps", "--entrypoint", "node", "runtime", "--input-type=module", "-e",
    `import { createDatabase } from "/app/dist/state/database.js";
import { insertLedgerEntry } from "/app/dist/state/ledger.js";
const db = createDatabase(process.env.HOME + "/.automaton/state.db");
insertLedgerEntry(db.raw, { kind: "inference_cost", amountCents: -1, amountMc: -600, livemode: true, source: "verify-allow-tiers" });
db.close();`], { allowFail: false });
  const wCap = watch(["--once", "--since", beforeCost, "--allow-tiers", "low_compute,critical,dead", "--max-run-cents", "0.5"]);
  check(W, "--allow-tiers never turns off the money cap: spend above --max-run-cents still stops the run (exit 2)",
    wCap.status === 2 && wCap.stdout.includes("STOP: inference spend since start 0.600c > 0.5c") && runtimeIds("running") === "",
    (wCap.stdout + wCap.stderr).trim().split("\n").filter((l) => /STOP|DEAD/.test(l)).join(" | "));
  standInW(`${PROJECT}-w1g`, KEEP);
  standInW(`${PROJECT}-w1h`, KEEP);
  const wTwo = watch(["--once", "--allow-tiers", "low_compute,critical,dead"]);
  check(W, "--allow-tiers never turns off the runtime checks: two runtimes still stop the run (exit 2)",
    wTwo.status === 2 && /STOP: 2 runtimes are running/.test(wTwo.stdout) && runtimeIds("running") === "",
    (wTwo.stdout + wTwo.stderr).trim().split("\n").filter((l) => /STOP/.test(l)).join(" | "));
  setDead(false);
  // Model unavailable (after the tier walk): agent:status shows it first; the watchdog reports it and
  // stops, also with --allow-tiers (it is not a tier rule).
  const setModelStop = (on) => docker([...COMPOSE, "run", "--rm", "-T", "--no-deps", "--entrypoint", "node", "runtime", "--input-type=module", "-e",
    `import { createDatabase } from "/app/dist/state/database.js";
const db = createDatabase(process.env.HOME + "/.automaton/state.db");
${on
  ? `db.setKV("model_unavailable", JSON.stringify({ model: "gpt-4.1-nano", provider: "openai", code: "model_not_found", since: "2026-11-24T12:00:00.000Z" }));`
  : `db.deleteKV("model_unavailable");`}
db.close();`], { allowFail: false });
  setModelStop(true);
  const stModel = status();
  check(W, "agent:status shows MODEL UNAVAILABLE first: model, since, asleep until restarted, what to fix",
    stModel.stdout.includes("!!! MODEL UNAVAILABLE since 2026-11-24 12:00:00 UTC: gpt-4.1-nano (openai: model_not_found). The agent stays asleep until the runtime is restarted") &&
      stModel.stdout.includes("(MODEL UNAVAILABLE: asleep until restarted)"),
    stModel.stdout.trim().slice(0, 600));
  standInW(`${PROJECT}-w1m`, KEEP);
  const wModel = watch(["--once", "--allow-tiers", "low_compute,critical,dead"]);
  check(W, "model unavailable: the watchdog prints the notice and stops gracefully (exit 2), even with --allow-tiers",
    wModel.status === 2 && wModel.stdout.includes("MODEL UNAVAILABLE: MODEL UNAVAILABLE since 2026-11-24 12:00:00 UTC: gpt-4.1-nano") &&
      wModel.stdout.includes("STOP: model unavailable: gpt-4.1-nano (openai: model_not_found)") && runtimeIds("running") === "",
    `exit ${wModel.status}; ` + wModel.stdout.split("\n").filter((l) => /MODEL|STOP/.test(l)).join(" | "));
  setModelStop(false);
  // Default unchanged: a critical tier still stops the run without --allow-tiers.
  docker([...COMPOSE, "run", "--rm", "-T", "--no-deps", "--entrypoint", "node", "runtime", "--input-type=module", "-e",
    `import { createDatabase } from "/app/dist/state/database.js";
const db = createDatabase(process.env.HOME + "/.automaton/state.db");
db.setKV("last_tick_tier", "critical");
db.close();`], { allowFail: false });
  standInW(`${PROJECT}-w1f`, KEEP);
  const wCrit = watch(["--once"]);
  check(W, "default (no --allow-tiers): tier critical stops the run (exit 2)",
    wCrit.status === 2 && wCrit.stdout.includes("STOP: survival tier critical") && runtimeIds("running") === "",
    (wCrit.stdout + wCrit.stderr).trim().split("\n").filter((l) => /STOP/.test(l)).join(" | "));
  docker([...COMPOSE, "run", "--rm", "-T", "--no-deps", "--entrypoint", "node", "runtime", "--input-type=module", "-e",
    `import { createDatabase } from "/app/dist/state/database.js";
const db = createDatabase(process.env.HOME + "/.automaton/state.db");
db.deleteKV("last_tick_tier");
db.close();`], { allowFail: false });
  standInW(`${PROJECT}-w1b`, KEEP);
  const beforeGrant = new Date().toISOString();
  oneoff(["--", "--ledger", "grant", "0.01"]);
  const w2 = watch(["--once", "--since", beforeGrant]);
  check(W, "a tripped stop rule (ledger entry other than inference) runs agent:down (exit 2)",
    w2.status === 2 && w2.stdout.includes("STOP: 1 ledger entry other than inference cost") && runtimeIds("running") === "",
    (w2.stdout + w2.stderr).trim());
  standInW(`${PROJECT}-w2`, KEEP);
  const w3 = watch(["--hours", "0.001", "--interval", "10"]);
  check(W, "--hours: stops the agent gracefully at the end of the run (exit 0)",
    w3.status === 0 && w3.stdout.includes("DONE: run complete") && runtimeIds("running") === "", (w3.stdout + w3.stderr).trim());
  check(W, "the DONE line reports peak memory and CPU",
    /DONE: run complete[^\n]*Peak: runtime \d+MiB, [\d.]+% cpu/.test(w3.stdout), w3.stdout.split("\n").find((l) => l.includes("DONE")) ?? "");
  standInW(`${PROJECT}-w3`, "setTimeout(()=>process.exit(0),4000)");
  const w4 = watch(["--hours", "0.02", "--interval", "10"]);
  check(W, "a runtime that exits is noticed and cleaned up (exit 2)",
    w4.status === 2 && w4.stdout.includes("STOP: no runtime is running") && runtimeIds() === "", (w4.stdout + w4.stderr).trim());
  check(W, "every check is written to the watch log", fs.readdirSync(logsDir).some((f) => f.startsWith(`watch-${PROJECT}-`)));
  const st3 = status();
  check(W, "agent:status's activity report no longer starts a compose runtime container",
    st3.status === 0 && st3.stdout.includes("Survival tier:") && runtimeIds() === "", (st3.stdout + st3.stderr).trim());

  // ─── graceful stop (pnpm agent:down) ─────────────────────────
  // Stand-ins for an agent:run runtime: one-off `compose run` containers of the
  // runtime service (the real agent is never started here). The sandbox is running.
  console.log("agent:verify: down command ...");
  const downScript = path.join(ROOT, "docker", "down-agent.mjs");
  const down = (extra = []) => spawnSync(process.execPath, [downScript, "--project", PROJECT, ...extra], { encoding: "utf-8", env, timeout: 180_000 });
  const standIn = (name, code) =>
    docker([...COMPOSE, "run", "-d", "--name", name, "--entrypoint", "node", "runtime", "-e", code], { allowFail: false });
  const projectContainers = () => docker(["ps", "-a", "-q", "--filter", `label=com.docker.compose.project=${PROJECT}`]).out.trim();
  const egressNetwork = () => docker(["network", "ls", "-q", "--filter", `name=^${PROJECT}_egress$`]).out.trim();

  standIn(`${PROJECT}-graceful`, "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)");
  const d1 = down();
  check("down command", "stops a one-off runtime (agent:run) with SIGTERM: exit 0, not killed",
    d1.status === 0 && d1.stdout.includes(`${PROJECT}-graceful stopped gracefully (exit 0)`), (d1.stdout + d1.stderr).trim());
  check("down command", "nothing of the project is left (sandbox included)", projectContainers() === "", projectContainers());
  check("down command", "the network is removed (no 'resource still in use')", egressNetwork() === "", egressNetwork());
  const volsAfterDown = docker(["volume", "ls", "-q", "--filter", `name=${PROJECT}_`]).out.split(/\s+/);
  check("down command", "volumes are kept", ["automaton-home", "agent-workspace", "sandbox-socket", "sandbox-home"].every((v) => volsAfterDown.includes(`${PROJECT}_${v}`)), volsAfterDown.join(","));

  docker([...COMPOSE, "up", "-d", "--wait", "sandbox"], { allowFail: false });
  standIn(`${PROJECT}-stubborn`, "setInterval(()=>{},1000)"); // PID 1 without a handler ignores SIGTERM
  const d2 = down(["--timeout", "3"]);
  check("down command", "a runtime that ignores SIGTERM is force-stopped at the timeout and reported (exit 1)",
    d2.status === 1 && d2.stderr.includes("was force-stopped (exit 137)") && projectContainers() === "", (d2.stdout + d2.stderr).trim());

  // ─── supervision (pnpm agent:supervise) ──────────────────────
  // No real --run here (rule 6): refusals, the stop marker written by down/kill,
  // and how the watchdog reads the supervisor's state. The crash → restart path
  // is unit-tested (supervise-policy.test.ts) and tested by the owner on a real run.
  console.log("agent:verify: supervision ...");
  const SV = "supervision";
  const superviseScript = path.join(ROOT, "docker", "supervise-agent.mjs");
  const supervise = (extra) => spawnSync(process.execPath, [superviseScript, "--project", PROJECT, ...extra], { encoding: "utf-8", env, timeout: 60_000 });
  const markerFile = path.join(logsDir, `stop-${PROJECT}.json`);
  const stopMarkerNow = () => { try { return JSON.parse(fs.readFileSync(markerFile, "utf-8")); } catch { return null; } };
  check(SV, "agent:down writes the stop marker (a supervisor never restarts an owner stop)", stopMarkerNow()?.by === "agent:down", JSON.stringify(stopMarkerNow()));
  const s1 = supervise([]);
  check(SV, "agent:supervise refuses to start while the owner's stop marker exists (exit 0, nothing started)",
    s1.status === 0 && s1.stderr.includes("not starting it") && s1.stderr.includes("--resume") && projectContainers() === "", (s1.stdout + s1.stderr).trim());
  const s2 = supervise(["--restart-delay", "90"]);
  check(SV, "a restart delay shorter than the runtime lease (100 s minimum) is refused (exit 2)",
    s2.status === 2 && s2.stderr.includes("--restart-delay must be a whole number from 100"), (s2.stdout + s2.stderr).trim());
  const s3 = supervise(["--", "--init"]);
  check(SV, "only --wake-now is passed to the first start (exit 2)", s3.status === 2 && s3.stderr.includes("only --wake-now"), (s3.stdout + s3.stderr).trim());
  standIn(`${PROJECT}-sv-running`, KEEP);
  const s4 = supervise(["--resume"]);
  check(SV, "with a runtime already running it refuses (exit 1), starts nothing and keeps the stop marker",
    s4.status === 1 && s4.stderr.includes("already running") && runtimeIds("running").split(/\s+/).filter(Boolean).length === 1 &&
      stopMarkerNow()?.by === "agent:down", (s4.stdout + s4.stderr).trim());
  const k2 = spawnSync(process.execPath, [killScript, "--project", PROJECT], { encoding: "utf-8", env, timeout: 60_000 });
  check(SV, "agent:kill writes the stop marker too", k2.status === 0 && stopMarkerNow()?.by === "agent:kill", JSON.stringify(stopMarkerNow()));
  // The watchdog and a supervisor's state file (this process stands in for a live supervisor).
  const stateFile = path.join(logsDir, `supervise-${PROJECT}.json`);
  const writeState = (s) => fs.writeFileSync(stateFile, JSON.stringify({ pid: process.pid, bootAt: bootAt(os.uptime()), project: PROJECT, updatedAt: new Date().toISOString(),
    settings: { maxRestarts: 3, windowMinutes: 60, restartDelaySeconds: 120 }, restarts: [new Date().toISOString()], ...s }));
  writeState({ state: "waiting", reason: "runtime crashed (exit 137); restart 1 of 3 in 60 min, in 120 s", nextStartAt: new Date(Date.now() + 120_000).toISOString() });
  const sw1 = watch(["--once"]);
  check(SV, "watchdog: no runtime while a live supervisor waits to restart it is reported, not a stop",
    sw1.status === 0 && sw1.stdout.includes("the supervisor restarts it") && sw1.stdout.includes("all checks passed"), (sw1.stdout + sw1.stderr).trim());
  writeState({ state: "waiting", updatedAt: new Date(Date.now() - 3_600_000).toISOString() }); // stale: supervisor gone quiet
  const sw2 = watch(["--once"]);
  check(SV, "watchdog: a stale supervisor state does not excuse a missing runtime (nothing to watch, exit 1)",
    sw2.status === 1 && sw2.stdout.includes("nothing to watch"), (sw2.stdout + sw2.stderr).trim());
  writeState({ state: "waiting", reason: "restart pending", nextStartAt: new Date(Date.now() + 120_000).toISOString() });
  const swRun = spawn(process.execPath, [watchScript, "--project", PROJECT, "--interval", "10"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let swOut = "";
  swRun.stdout.on("data", (d) => (swOut += d));
  const swExit = new Promise((r) => swRun.on("close", (c) => r(c)));
  await new Promise((r) => setTimeout(r, 3000));
  writeState({ state: "gave_up", reason: "runtime crashed (exit 1) after 3 restart(s) in the last 60 min (limit 3)" });
  const swCode = await Promise.race([swExit, new Promise((r) => setTimeout(() => r("timeout"), 90_000))]);
  if (swCode === "timeout") swRun.kill();
  check(SV, "watchdog: a supervisor that gave up is a stop (exit 2), with its reason",
    swCode === 2 && swOut.includes("STOP: the supervisor gave up: runtime crashed (exit 1) after 3 restart(s)"), swOut.trim().slice(-800));
  fs.rmSync(stateFile, { force: true });

  // ─── reboots and the VPS (systemd) ───────────────────────────
  // systemd stops the supervisor with SIGTERM at shutdown/reboot: agent:down
  // --no-stop-marker, so the agent resumes at boot. An owner stop keeps the marker.
  console.log("agent:verify: reboot and VPS rules ...");
  const RB = "reboot and VPS";
  fs.rmSync(markerFile, { force: true });
  standIn(`${PROJECT}-sysstop`, KEEP);
  const d3 = down(["--no-stop-marker"]);
  check(RB, "a system stop (agent:down --no-stop-marker, used on SIGTERM) stops the runtime but writes no stop marker",
    d3.status === 0 && d3.stdout.includes("system stop: no stop marker") && stopMarkerNow() === null && projectContainers() === "",
    (d3.stdout + d3.stderr).trim());
  const s5 = supervise(["--restart-delay", "90"]);
  check(RB, "after a system stop nothing blocks the next start (no marker; settings still checked first)",
    s5.status === 2 && !s5.stderr.includes("not starting it"), (s5.stdout + s5.stderr).trim());
  fs.writeFileSync(markerFile, JSON.stringify({ by: "agent:down", at: new Date().toISOString() }));
  const r1 = spawnSync(process.execPath, [superviseScript, "--project", PROJECT, "--clear-stop"], { encoding: "utf-8", env, timeout: 60_000 });
  check(RB, "agent:resume (--clear-stop) clears an owner stop and starts nothing",
    r1.status === 0 && r1.stdout.includes("cleared the stop marker") && stopMarkerNow() === null && projectContainers() === "", (r1.stdout + r1.stderr).trim());
  const wu1 = watch(["--until", "not-a-time"]);
  check(RB, "watchdog --until must be a time (exit 2)", wu1.status === 2 && wu1.stderr.includes("--until must be an ISO time"), (wu1.stdout + wu1.stderr).trim());
  const wu2 = watch(["--until", "2026-01-01T00:00:00Z"]);
  check(RB, "watchdog --until already past (restart after the run's end): the run is complete, agent stopped (exit 0)",
    wu2.status === 0 && wu2.stdout.includes("DONE: run complete at 2026-01-01T00:00:00.000Z"), (wu2.stdout + wu2.stderr).trim());

  // Secrets on a Linux host: the runtime (uid/gid 10001) reads them through the
  // bind mount with the host's permissions. Unreadable = clear refusal (exit 78),
  // never the value; root:10001 0750/0640 (the VPS layout) works.
  const SVOL = `${PROJECT}-secrets-perm`;
  const fakeKey = `verify-perm-${crypto.randomBytes(8).toString("hex")}`;
  docker(["volume", "rm", "-f", SVOL]);
  const asRoot = (cmd) => docker(["run", "--rm", "--user", "0", "--entrypoint", "sh", "-v", `${SVOL}:/s`, SERVICE_IMAGES.runtime, "-c", cmd]);
  asRoot(`printf '%s' '${fakeKey}' > /s/openai_api_key && chown 0:0 /s /s/openai_api_key && chmod 700 /s && chmod 600 /s/openai_api_key`);
  const runVersion = () => docker(["run", "--rm", "-v", `${SVOL}:/run/secrets/automaton:ro`, SERVICE_IMAGES.runtime, "--version"]);
  const p0 = runVersion();
  check(RB, "a secrets folder the runtime cannot enter (0700, host user): clear refusal with the fix (exit 78), value never printed",
    p0.code === 78 && p0.err.includes("the secrets folder is not readable by the runtime") && p0.err.includes("chown -R root:10001") &&
      !(p0.out + p0.err).includes(fakeKey), (p0.out + p0.err).trim().slice(0, 400));
  asRoot("chown 0:10001 /s && chmod 750 /s"); // folder fixed, the file still root-only (0600)
  const p1 = runVersion();
  check(RB, "a secret file the runtime cannot read: clear refusal naming the file (exit 78), value never printed",
    p1.code === 78 && p1.err.includes("secret file openai_api_key is not readable by the runtime") &&
      !(p1.out + p1.err).includes(fakeKey), (p1.out + p1.err).trim().slice(0, 400));
  asRoot("chown 0:10001 /s /s/openai_api_key && chmod 750 /s && chmod 640 /s/openai_api_key");
  const p2 = runVersion();
  check(RB, "the VPS layout (root:10001, folder 0750, files 0640) is readable by the runtime",
    p2.code === 0 && !(p2.out + p2.err).includes("not readable") && !(p2.out + p2.err).includes(fakeKey), (p2.out + p2.err).trim().slice(0, 400));
  docker(["volume", "rm", "-f", SVOL]);

  exitCode = results.every((r) => r.ok) ? 0 : 1;
} catch (err) {
  check("verify", "script error", false, err.message);
  exitCode = 1;
} finally {
  cleanup();
}

// Grouped by heading, in order of first appearance.
const groups = new Map();
for (const r of results) {
  if (!groups.has(r.group)) groups.set(r.group, []);
  groups.get(r.group).push(r);
}
for (const [group, rs] of groups) {
  console.log(`\n${group}`);
  for (const r of rs) {
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail && (!r.ok || r.detail.startsWith("address")) ? `  (${r.detail})` : ""}`);
  }
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\nagent:verify: ${results.length - failed} passed, ${failed} failed`);
process.exit(exitCode);
