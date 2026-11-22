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

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PROJECT, SERVICE_IMAGES, gitBuildCommit, imageCommit, warnStaleRuntimes } from "./agent-instances.mjs";

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
  check("entrypoint", "--preflight passes with no Conway key", pre.code === 0 && preOut.includes("PREFLIGHT PASSED"),
    pre.code === 0 ? "" : preOut.split("\n").filter((l) => /FAIL|Error|error/.test(l)).join(" | ").slice(0, 500));
  check("entrypoint", "--preflight: Conway off, sandbox reached as uid 10002, model key from secrets",
    preOut.includes("Conway: off (own providers only") && preOut.includes("sandbox: reachable, runs as uid 10002") &&
    preOut.includes("model gpt-4.1-mini: provider openai, key present"));
  check("build commit", "--preflight prints the build commit", preOut.includes(`build: ${BUILD_COMMIT}`));
  check("entrypoint", "--preflight: template wake limits (6 turns per wake, 1800 s sleep floor, 48 wakes/day)",
    preOut.includes("wake limits: 6 turns per wake, sleep at least 1800 s, 48 wakes per UTC day"));
  check("entrypoint", "--preflight shows today's inference spend against the 30c daily cap (not reached)",
    preOut.includes("INFO  inference today (UTC): $0.00 of $0.30 daily cap"));
  check("entrypoint", "--preflight prints no key values", !preOut.includes(fakeSecret) && !preOut.includes(fakeOpenAiKey));
  check("entrypoint", "--preflight uses the creator address from AUTOMATON_CREATOR_ADDRESS", preOut.includes(`creator: ${VERIFY_CREATOR}`));
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
    preOneoff.status === 0 && preOneoff.stdout.includes("PREFLIGHT PASSED") && sandboxIds(true) === "",
    `exit ${preOneoff.status}; sandbox ${sandboxIds(true) || "none"}`);
  docker([...COMPOSE, "up", "-d", "--wait", "sandbox"], { allowFail: false });
  const preKeep = oneoff(["--needs-sandbox", "--", "--preflight"]);
  check("one-off commands", "preflight leaves an already running sandbox running",
    preKeep.status === 0 && sandboxIds(false) !== "", `exit ${preKeep.status}`);
  // Config template switch (AUTOMATON_CONFIG_TEMPLATE, Phase 3 step 7).
  const withTemplate = (value, args) => spawnSync(process.execPath, [oneoffScript, "--project", PROJECT, ...args],
    { encoding: "utf-8", env: { ...env, AUTOMATON_CONFIG_TEMPLATE: value }, timeout: 300_000 });
  const badTpl = withTemplate("../compose.agent.yml", ["--", "--ledger", "show"]);
  check("one-off commands", "AUTOMATON_CONFIG_TEMPLATE outside ./automaton.<name>.json is refused before compose runs (exit 2)",
    badTpl.status === 2 && badTpl.stderr.includes("AUTOMATON_CONFIG_TEMPLATE must look like"), `exit ${badTpl.status}: ${badTpl.stderr.trim()}`);
  const payTpl = withTemplate("./automaton.paytest.json", ["--needs-sandbox", "--", "--preflight"]);
  check("one-off commands", "the paytest template: noted, preflight passes, send_usdc offered",
    payTpl.status === 0 && payTpl.stderr.includes("note: config template ./automaton.paytest.json") &&
      payTpl.stdout.includes("PREFLIGHT PASSED") && payTpl.stdout.includes("INFO  payment tools offered: send_usdc"),
    `exit ${payTpl.status}; ${(payTpl.stdout.split("\n").find((l) => l.includes("payment tools")) ?? payTpl.stdout.slice(-300)).trim()}`);
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
    preLive.status === 0 && sandboxIds(false) !== "" && preLive.stderr.includes("sandbox left running"),
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
