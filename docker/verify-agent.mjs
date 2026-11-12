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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "automaton-verify";
const COMPOSE = ["compose", "-f", path.join(ROOT, "docker", "compose.agent.yml"), "-p", PROJECT];
const PROBE = `${PROJECT}-runtime-probe`;

const fakeSecret = `verify-fake-secret-${crypto.randomBytes(16).toString("hex")}`;
const fakeSecretHash = crypto.createHash("sha256").update(fakeSecret).digest("hex");
const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-verify-secrets-"));
fs.writeFileSync(path.join(secretsDir, "groq_api_key"), fakeSecret + "\n");

const env = { ...process.env, AUTOMATON_SECRETS_DIR: secretsDir };
delete env.AUTOMATON_MAINNET_APPROVED;

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
  try { if (fs.readFileSync("/proc/" + pid + "/environ", "latin1").includes(SECRET)) inEnviron.push(pid); } catch {}
}
check("fake secret not in any process environment", inEnviron.length === 0, inEnviron.join(","));
const grep = spawnSync("grep", ["-rIlsF", "--exclude-dir=proc", "--exclude-dir=sys", "--exclude-dir=dev", "-e", SECRET, "/"], { encoding: "utf-8", timeout: 240000 });
// grep exits 1 (no match) or 2 (no match, but some files were unreadable, as expected).
check("fake secret not in any readable file", (grep.status === 1 || grep.status === 2) && grep.stdout.trim() === "", (grep.stdout || "").trim() || ("grep exit " + grep.status));

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
  docker(["rm", "-f", PROBE]);
  docker([...COMPOSE, "down", "-v", "--remove-orphans"]);
  fs.rmSync(secretsDir, { recursive: true, force: true });
}

let exitCode = 1;
try {
  console.log("agent:verify: building images ...");
  docker([...COMPOSE, "build", "--quiet"], { allowFail: false, timeoutMs: 900_000 });
  cleanup();
  fs.mkdirSync(secretsDir, { recursive: true });
  fs.writeFileSync(path.join(secretsDir, "groq_api_key"), fakeSecret + "\n");

  console.log("agent:verify: starting the sandbox ...");
  docker([...COMPOSE, "up", "-d", "--wait", "sandbox"], { allowFail: false });

  // Throwaway testnet wallet in the throwaway volume (address only is printed).
  const init = docker([...COMPOSE, "run", "--rm", "-T", "runtime", "--init"]);
  const initJson = findInitResult(init.out + "\n" + init.err);
  check("entrypoint", "--init creates a wallet and prints only the address",
    init.code === 0 && /^0x[0-9a-fA-F]{40}$/.test(initJson?.address ?? "") && Object.keys(initJson ?? {}).sort().join() === "address,configDir,isNew",
    initJson ? `address ${initJson.address}` : init.err.trim());

  const statusRun = docker([...COMPOSE, "run", "--rm", "-T", "runtime", "--status"]);
  check("entrypoint", "--status shows Base Sepolia (testnet)", statusRun.code === 0 && (statusRun.out + statusRun.err).includes("Base Sepolia (testnet)"), statusRun.code);

  const settingsShow = docker([...COMPOSE, "run", "--rm", "-T", "runtime", "--settings", "show"]);
  check("entrypoint", "owner command --settings show works; agent genesis changes OFF by default",
    settingsShow.code === 0 && settingsShow.out.includes("=== AGENT SETTINGS ===") && /Genesis prompt[\s\S]*agent changes OFF/.test(settingsShow.out),
    settingsShow.code === 0 ? "" : settingsShow.err.trim());
  const settingsReset = docker([...COMPOSE, "run", "--rm", "-T", "runtime", "--settings", "reset"]);
  check("entrypoint", "owner command --settings reset works", settingsReset.code === 0 && settingsReset.out.includes("No agent settings to reset."), settingsReset.err.trim());

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

  exitCode = results.every((r) => r.ok) ? 0 : 1;
} catch (err) {
  check("verify", "script error", false, err.message);
  exitCode = 1;
} finally {
  cleanup();
}

let group = "";
for (const r of results) {
  if (r.group !== group) {
    group = r.group;
    console.log(`\n${group}`);
  }
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail && (!r.ok || r.detail.startsWith("address")) ? `  (${r.detail})` : ""}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\nagent:verify: ${results.length - failed} passed, ${failed} failed`);
process.exit(exitCode);
