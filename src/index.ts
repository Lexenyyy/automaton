#!/usr/bin/env node
/**
 * Conway Automaton Runtime
 *
 * The entry point for the sovereign AI agent.
 * Handles CLI args, bootstrapping, and orchestrating
 * the heartbeat daemon + agent loop.
 */

import fs from "fs";
import path from "path";
import { getWallet, getAutomatonDir } from "./identity/wallet.js";
import { provision } from "./identity/provision.js";
import { loadConfig, resolvePath } from "./config.js";
import { createDatabase } from "./state/database.js";
import { createHeartbeatDaemon } from "./heartbeat/daemon.js";
import { consumeNextWakeEvent, insertWakeEvent } from "./state/database.js";
import { runAgentLoop } from "./agent/loop.js";
import { loadSkills } from "./skills/loader.js";
import { initStateVersioning } from "./git/state-versioning.js";
import type { AgentState, Skill } from "./types.js";
import { createLogger, setGlobalLogLevel, StructuredLogger } from "./observability/logger.js";
import { prettySink } from "./observability/pretty-sink.js";
import { bootstrapTopup } from "./conway/topup.js";
import { isContainerSandbox } from "./sandbox/transport.js";
import { prepareRuntime, runPreflight } from "./runtime/prepare.js";
import { formatLeaseHolder, readRuntimeLease, releaseRuntimeLease, startLeaseHeartbeat } from "./runtime/instance-lease.js";
import { pendingStartupSleep, waitForSleepOrWake } from "./agent/startup-sleep.js";
import { effectiveSleepUntil, resolveSleepSettings } from "./agent/sleep-limits.js";
import {
  beginInferenceShutdown,
  getInFlightInferenceCount,
  waitForInFlightInference,
} from "./inference/in-flight.js";

/** Max wait for in-flight model calls on SIGTERM (below Docker's 30 s stop grace). */
const SHUTDOWN_INFERENCE_WAIT_MS = 20_000;

const logger = createLogger("main");

const VERSION = "0.2.1";

/** Git commit the Docker image was built from (fork; set by docker/build-agent.mjs). */
function buildCommit(): string {
  return process.env.AUTOMATON_BUILD_COMMIT || "unknown (not a labelled image)";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ─── CLI Commands ────────────────────────────────────────────

  if (args.includes("--version") || args.includes("-v")) {
    logger.info(`Conway Automaton v${VERSION}`);
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h")) {
    logger.info(`
Conway Automaton v${VERSION}
Sovereign AI Agent Runtime

Usage:
  automaton --run          Start the automaton (first run triggers setup wizard).
                           A sleep still pending from before is honoured;
                           add --wake-now to wake the agent immediately.
  automaton --setup        Re-run the interactive setup wizard
  automaton --configure    Edit configuration (providers, model, treasury, general)
  automaton --pick-model   Interactively pick the active inference model
  automaton --init         Initialize wallet and config directory
  automaton --provision    Provision Conway API key via SIWE
  automaton --status       Show current automaton status
  automaton --preflight    Check the startup path (no model call, agent not started)
  automaton --settings show|reset
                           Owner: show or reset settings the agent changed itself
  automaton --soul show|reset
                           Owner: show the soul, or write a fresh one from the settings
  automaton --wallet show|encrypt
                           Owner: show the wallet (balances, limits, recent transfers; no key material),
                           or encrypt it in place
  automaton --wallet send <cents|all> [--reason "..."] [--confirm]
                           Owner: send USDC to the creator address only (same checks as send_usdc);
                           dry run without --confirm
  automaton --payment-test Owner: send_usdc limits test (one real 0.10 USDC transfer to the creator,
                           then refusals; testnet only, no model call, not while an agent runs)
  automaton --facts [list | delete <category/key> ...]
                           Owner: list the agent's facts, or delete some (not while it runs)
  automaton --ledger [show | grant <amount> | adjust <±amount> --memo "..."]
                           Owner: show the ledger or add a grant/adjustment (dollars)
  automaton --activity [--json] [--since <ISO time>]
                           Owner: recent turns, inference spend and sleep state
  automaton --version      Show version
  automaton --help         Show this help

Environment:
  CONWAY_API_URL           Conway API URL (default: https://api.conway.tech)
  CONWAY_API_KEY           Conway API key (overrides config)
  OLLAMA_BASE_URL          Ollama base URL (overrides config, e.g. http://localhost:11434)
`);
    process.exit(0);
  }

  if (args.includes("--init")) {
    // Read chain type from genesis.json if written by parent during spawn
    let initChainType: import("./identity/chain.js").ChainType | undefined;
    try {
      const genesisPath = path.join(getAutomatonDir(), "genesis.json");
      if (fs.existsSync(genesisPath)) {
        const genesis = JSON.parse(fs.readFileSync(genesisPath, "utf-8"));
        initChainType = genesis.chainType;
      }
    } catch {}
    // Fork (Phase 3): a new wallet is encrypted when a passphrase is set, and
    // refused without one when walletEncryption is "required" (or mainnet).
    const { walletEncryptionRequired } = await import("./identity/wallet-crypto.js");
    let initResult: Awaited<ReturnType<typeof getWallet>>;
    try {
      initResult = await getWallet(initChainType, { requireEncryption: walletEncryptionRequired(loadConfig()) });
    } catch (err: any) {
      logger.error(`Init failed: ${err?.message ?? String(err)}`);
      process.exit(1);
    }
    logger.info(
      JSON.stringify({
        address: initResult.chainIdentity.address,
        isNew: initResult.isNew,
        configDir: getAutomatonDir(),
      }),
    );
    process.exit(0);
  }

  if (args.includes("--wallet")) {
    // Owner only (pnpm agent:wallet / agent:wallet:encrypt; fork, Phase 3):
    // show the wallet (address, encrypted or not; never key material), or
    // encrypt a plaintext wallet in place with the owner's passphrase.
    // No model call, no network. Encrypt is refused while an agent runs.
    const sub = args[args.indexOf("--wallet") + 1] ?? "show";
    if (sub !== "show" && sub !== "encrypt" && sub !== "send") {
      logger.error("Usage: automaton --wallet show|encrypt|send");
      process.exit(2);
    }
    if (sub === "send") {
      // Fork (Phase 4 step 7): owner USDC send to the creator only (tier-walk drain).
      const { parseOwnerSendArgs, runOwnerSend } = await import("./agent/owner-send.js");
      const parsed = parseOwnerSendArgs(args.slice(args.indexOf("--wallet") + 2));
      if ("error" in parsed) {
        console.log(parsed.error);
        process.exit(2);
      }
      const config = loadConfig();
      if (!config) {
        logger.error("Automaton is not configured.");
        process.exit(1);
      }
      let code = 0;
      let rt: Awaited<ReturnType<typeof prepareRuntime>> | undefined;
      try {
        rt = await prepareRuntime(config, { preflight: true });
        const held = readRuntimeLease(rt.db.raw);
        if (held?.live) {
          console.log(`Refusing --wallet send while an agent is running (${formatLeaseHolder(held.lease, held.ageMs)}). Stop it first.`);
          code = 1;
        } else {
          const { getActiveNetwork } = await import("./identity/network.js");
          const { createViemUsdcChain } = await import("./agent/usdc-transfer.js");
          const { createBuiltinTools } = await import("./agent/tools.js");
          const { resolveSurvivalSettings } = await import("./survival/settings.js");
          const { DEFAULT_TREASURY_POLICY } = await import("./types.js");
          const network = getActiveNetwork();
          const r = await runOwnerSend({
            db: rt.db.raw,
            ctx: { identity: rt.identity, config: rt.config, db: rt.db, conway: rt.conway, inference: rt.inference, social: rt.social },
            sendTool: createBuiltinTools(rt.config.sandboxId).find((t) => t.name === "send_usdc")!,
            network,
            chain: createViemUsdcChain(rt.account, network, rt.config.rpcUrl || process.env.AUTOMATON_RPC_URL),
            policy: rt.config.treasuryPolicy ?? DEFAULT_TREASURY_POLICY,
            survival: resolveSurvivalSettings(rt.config),
            project: process.env.AUTOMATON_PROJECT?.trim() || null,
          }, parsed);
          console.log(r.output);
          code = r.code;
        }
      } catch (err: any) {
        console.log(`Wallet send failed: ${err?.message ?? String(err)}`);
        code = 1;
      } finally {
        rt?.db.close();
      }
      process.exit(code);
    }
    const { walletInfo, encryptExistingWallet } = await import("./identity/wallet.js");
    const { walletEncryptionRequired } = await import("./identity/wallet-crypto.js");
    const config = loadConfig();
    let code = 0;
    try {
      if (sub === "encrypt") {
        let held: ReturnType<typeof readRuntimeLease> = null;
        if (config) {
          const db = createDatabase(resolvePath(config.dbPath));
          try { held = readRuntimeLease(db.raw); } finally { db.close(); }
        }
        if (held?.live) {
          console.log(`Refusing to encrypt the wallet while an agent is running (${formatLeaseHolder(held.lease, held.ageMs)}). Stop it first (pnpm agent:down).`);
          code = 1;
        } else {
          const r = encryptExistingWallet();
          console.log(
            r.status === "encrypted" ? `Wallet encrypted in place (${r.address}). No plaintext copy was kept. Keep an offline copy of the passphrase: without it the wallet is lost.`
              : r.status === "already" ? `Wallet already encrypted (${r.address}). Nothing changed.`
              : "No wallet found. Create it with --init (pnpm agent:init).",
          );
          if (r.status === "missing") code = 1;
        }
      }
      // Fork (Phase 3 step 5): live balances (read-only RPC), limits, sent amounts, recent transfers.
      const info = walletInfo();
      const { walletReport, readWalletBalances } = await import("./agent/wallet-report.js");
      const { activateNetwork } = await import("./identity/network.js");
      const { DEFAULT_TREASURY_POLICY } = await import("./types.js");
      let network: import("./identity/network.js").NetworkInfo | null = null;
      let networkError: string | undefined;
      let balances: Awaited<ReturnType<typeof readWalletBalances>> | null = null;
      if (info.exists && info.chainType === "evm" && info.address) {
        try {
          network = activateNetwork({ network: config?.network, walletAddress: info.address });
          balances = await readWalletBalances(info.address as `0x${string}`, network, config?.rpcUrl || process.env.AUTOMATON_RPC_URL);
        } catch (err: any) {
          networkError = err?.message ?? String(err);
        }
      }
      const reportDb = config ? createDatabase(resolvePath(config.dbPath)) : null;
      try {
        console.log(walletReport({
          info, network, networkError, balances,
          policy: config?.treasuryPolicy ?? DEFAULT_TREASURY_POLICY,
          creatorAddress: config?.creatorAddress,
          encryptionSetting: `${config?.walletEncryption ?? "optional (default)"}${walletEncryptionRequired(config) ? " → required" : ""}`,
          db: reportDb?.raw ?? null,
          survival: (await import("./survival/settings.js")).resolveSurvivalSettings(config),
        }));
      } finally {
        reportDb?.close();
      }
    } catch (err: any) {
      console.log(`Wallet command failed: ${err?.message ?? String(err)}`);
      code = 1;
    }
    process.exit(code);
  }

  if (args.includes("--provision")) {
    try {
      const result = await provision();
      logger.info(JSON.stringify(result));
    } catch (err: any) {
      logger.error(`Provision failed: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (args.includes("--status")) {
    await showStatus();
    process.exit(0);
  }

  if (args.includes("--preflight")) {
    // Fork: the real startup path plus checks, then exit. No model call, no
    // agent loop, nothing sent to Conway; one read-only RPC call.
    const config = loadConfig();
    if (!config) {
      logger.error("Automaton is not configured.");
      process.exit(1);
    }
    const { ok, lines } = await runPreflight(config);
    console.log([`build: ${buildCommit()}`, ...lines].join("\n"));
    process.exit(ok ? 0 : 1);
  }

  if (args.includes("--settings")) {
    // Owner only (run from the host; the agent has no access): show or reset
    // the settings the agent changed itself.
    const sub = args[args.indexOf("--settings") + 1] ?? "show";
    if (sub !== "show" && sub !== "reset") {
      logger.error('Usage: automaton --settings show|reset');
      process.exit(2);
    }
    const config = loadConfig();
    if (!config) {
      logger.error("Automaton is not configured.");
      process.exit(1);
    }
    const db = createDatabase(resolvePath(config.dbPath));
    const { resetAgentSettings, settingsReport } = await import("./agent/settings.js");
    if (sub === "reset") {
      const removed = resetAgentSettings(db.raw);
      console.log(removed.length ? `Reset agent settings: ${removed.join(", ")}` : "No agent settings to reset.");
    }
    console.log(settingsReport(config, db.raw));
    db.close();
    process.exit(0);
  }

  if (args.includes("--payment-test")) {
    // Owner only (pnpm agent:payment-test; fork, Phase 3 step 7): send_usdc
    // through executeTool + the policy engine, no model call. One real 0.10 USDC
    // transfer to the creator, then refusals. Testnet only; refused while an agent runs.
    const config = loadConfig();
    if (!config) {
      logger.error("Automaton is not configured.");
      process.exit(1);
    }
    let code = 0;
    let rt: Awaited<ReturnType<typeof prepareRuntime>> | undefined;
    try {
      rt = await prepareRuntime(config, { preflight: true });
      const held = readRuntimeLease(rt.db.raw);
      if (held?.live) {
        console.log(`Refusing the payment test while an agent is running (${formatLeaseHolder(held.lease, held.ageMs)}). Stop it first (pnpm agent:down).`);
        code = 1;
      } else {
        const { getActiveNetwork } = await import("./identity/network.js");
        const { createViemUsdcChain } = await import("./agent/usdc-transfer.js");
        const { createBuiltinTools } = await import("./agent/tools.js");
        const { runPaymentTest, paymentTestPreconditions, formatPaymentTest } = await import("./agent/payment-test.js");
        const { DEFAULT_TREASURY_POLICY } = await import("./types.js");
        const network = getActiveNetwork();
        const deps = {
          db: rt.db.raw,
          ctx: { identity: rt.identity, config: rt.config, db: rt.db, conway: rt.conway, inference: rt.inference, social: rt.social },
          sendTool: createBuiltinTools(rt.config.sandboxId).find((t) => t.name === "send_usdc")!,
          network,
          chain: createViemUsdcChain(rt.account, network, rt.config.rpcUrl || process.env.AUTOMATON_RPC_URL),
          policy: rt.config.treasuryPolicy ?? DEFAULT_TREASURY_POLICY,
        };
        const problems = await paymentTestPreconditions(deps);
        if (problems.length) {
          console.log(`Payment test not started:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
          code = 1;
        } else {
          const result = await runPaymentTest(deps);
          console.log(formatPaymentTest(result));
          code = result.ok ? 0 : 1;
        }
      }
    } catch (err: any) {
      console.log(`Payment test failed: ${err?.message ?? String(err)}`);
      code = 1;
    } finally {
      rt?.db.close();
    }
    process.exit(code);
  }

  if (args.includes("--soul")) {
    // Owner only (pnpm agent:soul / agent:soul:reset): show the soul, or write a
    // fresh one from soulConfig.defaultCorePurpose/defaultValues (fork, run 5).
    // No model call, no network, no wallet file read.
    const sub = args[args.indexOf("--soul") + 1] ?? "show";
    if (sub !== "show" && sub !== "reset") {
      logger.error("Usage: automaton --soul show|reset");
      process.exit(2);
    }
    const config = loadConfig();
    if (!config) {
      logger.error("Automaton is not configured.");
      process.exit(1);
    }
    const db = createDatabase(resolvePath(config.dbPath));
    const { resetSoul, soulIdentityFromDb, soulReport } = await import("./soul/reset.js");
    let code = 0;
    try {
      if (sub === "reset") {
        const held = readRuntimeLease(db.raw);
        if (held?.live) {
          console.log(`Refusing to reset the soul while an agent is running (${formatLeaseHolder(held.lease, held.ageMs)}). Stop it first (pnpm agent:down).`);
          code = 1;
        } else {
          const r = resetSoul(db.raw, config, soulIdentityFromDb(db.raw, config));
          console.log(r.success
            ? `Soul reset: version ${r.version} written from the owner's settings (earlier versions kept in soul_history).`
            : `Soul reset failed: ${r.errors?.join("; ")}`);
          if (!r.success) code = 1;
        }
      }
      console.log(soulReport(db.raw, undefined, config));
    } finally {
      db.close();
    }
    process.exit(code);
  }

  if (args.includes("--facts")) {
    // Owner only (pnpm agent:facts / agent:facts:delete): list the agent's
    // long-term facts or delete some (fork, run 6 follow-up H3). Delete is
    // refused while an agent runs. No model call, no network, no wallet read.
    const config = loadConfig();
    if (!config) {
      logger.error("Automaton is not configured.");
      process.exit(1);
    }
    const db = createDatabase(resolvePath(config.dbPath));
    const { runFactsCommand } = await import("./memory/facts-command.js");
    let result: { code: number; output: string };
    try {
      const held = readRuntimeLease(db.raw);
      result = runFactsCommand(db.raw, args.slice(args.indexOf("--facts") + 1), {
        agentRunning: held?.live ? formatLeaseHolder(held.lease, held.ageMs) : null,
      });
    } finally {
      db.close();
    }
    console.log(result.output);
    process.exit(result.code);
  }

  if (args.includes("--ledger")) {
    // Owner only (run from the host; the agent has no access): show the
    // ledger, add a grant or an adjustment. Same logic as `automaton-cli ledger`.
    const config = loadConfig();
    if (!config) {
      logger.error("Automaton is not configured.");
      process.exit(1);
    }
    const db = createDatabase(resolvePath(config.dbPath));
    const { runLedgerCommand } = await import("./state/ledger-command.js");
    let result: { code: number; output: string };
    try {
      result = runLedgerCommand(db.raw, args.slice(args.indexOf("--ledger") + 1), {
        liveOnly: config.network === "mainnet",
      });
    } finally {
      db.close();
    }
    console.log(result.output);
    process.exit(result.code);
  }

  if (args.includes("--activity")) {
    // Owner only (pnpm agent:status): recent turns, spend and sleep state from
    // state.db. Read-only; no model call, no network.
    const config = loadConfig();
    if (!config) {
      logger.error("Automaton is not configured.");
      process.exit(1);
    }
    // --json [--since <ISO time>]: machine-readable, for pnpm agent:watch.
    const sinceArg = args.includes("--since") ? args[args.indexOf("--since") + 1] : undefined;
    if (sinceArg !== undefined && !Number.isFinite(Date.parse(sinceArg))) {
      logger.error("Usage: automaton --activity [--json] [--since <ISO time>]");
      process.exit(2);
    }
    const since = sinceArg ? new Date(sinceArg).toISOString() : undefined;
    const db = createDatabase(resolvePath(config.dbPath));
    const { getActivityReport, formatActivityReport } = await import("./state/activity-report.js");
    try {
      const { resolveSurvivalSettings } = await import("./survival/settings.js");
      const report = getActivityReport(db.raw, new Date(), since, resolveSurvivalSettings(config));
      console.log(args.includes("--json") ? JSON.stringify(report) : formatActivityReport(report));
    } finally {
      db.close();
    }
    process.exit(0);
  }

  if (args.includes("--setup")) {
    const { runSetupWizard } = await import("./setup/wizard.js");
    await runSetupWizard();
    process.exit(0);
  }

  if (args.includes("--pick-model")) {
    const { runModelPicker } = await import("./setup/model-picker.js");
    await runModelPicker();
    process.exit(0);
  }

  if (args.includes("--configure")) {
    const { runConfigure } = await import("./setup/configure.js");
    await runConfigure();
    process.exit(0);
  }

  if (args.includes("--run")) {
    StructuredLogger.setSink(prettySink);
    await run();
    return;
  }

  // Default: show help
  logger.info('Run "automaton --help" for usage information.');
  logger.info('Run "automaton --run" to start the automaton.');
}

// ─── Status Command ────────────────────────────────────────────

async function showStatus(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    logger.info("Automaton is not configured. Run the setup script first.");
    return;
  }

  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);

  const state = db.getAgentState();
  const turnCount = db.getTurnCount();
  const tools = db.getInstalledTools();
  const heartbeats = db.getHeartbeatEntries();
  const skills = db.getSkills(true);
  const children = db.getChildren();
  const registry = db.getRegistryEntry();

  logger.info(`
=== AUTOMATON STATUS ===
Name:       ${config.name}
Address:    ${config.walletAddress}
Creator:    ${config.creatorAddress}
Sandbox:    ${config.sandboxId}
State:      ${state}
Turns:      ${turnCount}
Tools:      ${tools.length} installed
Skills:     ${skills.length} active
Heartbeats: ${heartbeats.filter((h) => h.enabled).length} active
Children:   ${children.filter((c) => c.status !== "dead").length} alive / ${children.length} total
Network:    ${config.network === "mainnet" ? "Base mainnet (needs owner approval at start)" : "Base Sepolia (testnet)"}
Agent ID:   ${registry?.agentId || "not registered"}
Model:      ${config.inferenceModel}
Version:    ${config.version}
========================
`);

  db.close();
}

// ─── Main Run ──────────────────────────────────────────────────

async function run(): Promise<void> {
  logger.info(
    `[${new Date().toISOString()}] Conway Automaton v${VERSION} starting... (build ${buildCommit()})`,
  );

  // Load config — first run triggers interactive setup wizard
  let config = loadConfig();
  if (!config) {
    const { runSetupWizard } = await import("./setup/wizard.js");
    config = await runSetupWizard();
  }

  // Fork: shared startup path (also used by --preflight).
  const rt = await prepareRuntime(config, { preflight: false });
  const {
    db, identity, account, resolvedChainType, conway, inference, social,
    policyEngine, spendTracker, heartbeatConfig, skillsDir, ollamaBaseUrl,
  } = rt;
  let skills: Skill[] = rt.skills;

  // Initialize state repo (git). Fork: off in container mode (no git in the
  // runtime; the sandbox must not reach ~/.automaton).
  try {
    const sv = await initStateVersioning(conway, config.sandbox);
    logger.info(
      `[${new Date().toISOString()}] ${sv.status === "off" ? `State versioning: off (${sv.reason}).` : "State repo initialized."}`,
    );
  } catch (err: any) {
    logger.warn(`[${new Date().toISOString()}] State repo init failed: ${err.message}`);
  }

  // Bootstrap topup: buy minimum credits ($5) from USDC so the agent can start.
  // The agent decides larger topups itself via the topup_credits tool.
  // Only when Conway credits are the survival balance (fork change 3).
  if (config.balanceSource === "conway") try {
    let bootstrapTimer: ReturnType<typeof setTimeout>;
    const bootstrapTimeout = new Promise<null>((_, reject) => {
      bootstrapTimer = setTimeout(() => reject(new Error("bootstrap topup timed out")), 15_000);
    });
    try {
      await Promise.race([
        (async () => {
          const creditsCents = await conway.getCreditsBalance().catch(() => 0);
          const topupResult = await bootstrapTopup({
            apiUrl: config.conwayApiUrl,
            account,
            creditsCents,
            chainType: resolvedChainType,
          });
          if (topupResult?.success) {
            logger.info(
              `[${new Date().toISOString()}] Bootstrap topup: +$${topupResult.amountUsd} credits from USDC`,
            );
          }
        })(),
        bootstrapTimeout,
      ]);
    } finally {
      clearTimeout(bootstrapTimer!);
    }
  } catch (err: any) {
    logger.warn(`[${new Date().toISOString()}] Bootstrap topup skipped: ${err.message}`);
  }

  // Start heartbeat daemon (Phase 1.1: DurableScheduler)
  const heartbeat = createHeartbeatDaemon({
    identity,
    config,
    heartbeatConfig,
    db,
    rawDb: db.raw,
    conway,
    social,
    onWakeRequest: (reason) => {
      logger.info(`[HEARTBEAT] Wake request: ${reason}`);
      // Phase 1.1: Use wake_events table instead of KV wake_request
      insertWakeEvent(db.raw, 'heartbeat', reason);
    },
  });

  heartbeat.start();
  logger.info(`[${new Date().toISOString()}] Heartbeat daemon started.`);

  // Handle graceful shutdown. Fork: admit no new model call, then wait (up to
  // SHUTDOWN_INFERENCE_WAIT_MS, inside Docker's 30 s stop grace) until every
  // call that already ran has its cost recorded, so the ledger never misses one.
  let shuttingDown = false;
  let stopLeaseHeartbeat: (() => void) | undefined;
  let leaseLost = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[${new Date().toISOString()}] Shutting down...`);
    beginInferenceShutdown();
    heartbeat.stop();
    const pending = getInFlightInferenceCount();
    if (pending > 0) {
      logger.info(`[${new Date().toISOString()}] Waiting for ${pending} model call(s) to be recorded...`);
      const idle = await waitForInFlightInference(SHUTDOWN_INFERENCE_WAIT_MS);
      if (!idle) {
        logger.warn(
          `[${new Date().toISOString()}] ${getInFlightInferenceCount()} model call(s) still running after ${SHUTDOWN_INFERENCE_WAIT_MS / 1000}s; ` +
            "their cost may be missing from the ledger. Check the provider's usage page.",
        );
      }
    }
    try {
      stopLeaseHeartbeat?.();
      // A runtime that lost its lease leaves the agent state to the new holder.
      if (!leaseLost) db.setAgentState("sleeping");
      if (rt.lease) releaseRuntimeLease(db.raw, rt.lease.instanceId);
      db.close();
    } finally {
      process.exit(leaseLost ? 3 : 0);
    }
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Fork: keep the instance lease fresh. If it is no longer ours (this process
  // stalled past the TTL and another runtime started), stop: never two agents.
  if (rt.lease) {
    const leaseId = rt.lease.instanceId;
    stopLeaseHeartbeat = startLeaseHeartbeat(db.raw, leaseId, (why) => {
      logger.error(`[${new Date().toISOString()}] Runtime lease lost (${why}). Stopping this runtime.`);
      leaseLost = true;
      void shutdown();
    });
  }

  // Fork (after the tier walk): a restart is the owner's answer to a
  // "model unavailable" stop, so it clears the stop (the agent wakes again).
  const { clearModelUnavailableOnStart, formatModelStop, readModelUnavailable, waitWhileModelUnavailable } =
    await import("./agent/model-stop.js");
  const clearedStop = clearModelUnavailableOnStart(db.raw);
  if (clearedStop) {
    logger.info(
      `[${new Date().toISOString()}] Restart clears the model-unavailable stop (${clearedStop.model}, ${clearedStop.provider}: ` +
        `${clearedStop.code}, since ${clearedStop.since}). If the config still names that model, the next wake stops again.`,
    );
  }

  // Fork: a restart honours a sleep that is still pending (the agent's own or
  // a forced one), so restarting does not cost a wake. --wake-now overrides.
  const wakeNow = process.argv.includes("--wake-now");
  // Fork (Phase 4 step 3): a dead agent stays dead across restarts (and
  // --wake-now); the run loop below waits for the heartbeat to see a balance
  // above $0. Honouring a pending sleep here would have set "sleeping".
  const startDead = db.getAgentState() === "dead";
  if (startDead) {
    logger.info(`[${new Date().toISOString()}] Agent state is dead: no wake and no model call until the balance is above $0.`);
  }
  const pending = startDead ? null : pendingStartupSleep((k) => db.getKV(k), Date.now(), wakeNow);
  if (pending) {
    // Stale wake events from before this start would end the sleep at once.
    while (consumeNextWakeEvent(db.raw));
    db.setAgentState("sleeping");
    logger.info(
      `[${new Date().toISOString()}] Honouring the pending sleep until ${new Date(pending.untilMs).toISOString()}` +
        `${pending.reason ? ` (${pending.reason})` : ""}. To wake the agent now, start it with --wake-now ` +
        "(pnpm agent:run --wake-now).",
    );
    const end = await waitForSleepOrWake(db.raw, pending.untilMs);
    logger.info(
      `[${new Date().toISOString()}] ${end.woken ? `Woken by ${end.source}: ${end.reason}` : "Pending sleep is over"}.`,
    );
  } else if (wakeNow && !startDead) {
    logger.info(`[${new Date().toISOString()}] --wake-now: any pending sleep is ignored.`);
  }

  // ─── Main Run Loop ──────────────────────────────────────────
  // The automaton alternates between running and sleeping.
  // The heartbeat can wake it up.

  while (true) {
    try {
      // Fork (Phase 4 step 3, F1): while dead, never enter the agent loop.
      // Wait until the heartbeat's survival watch sees a balance above $0.
      if (db.getAgentState() === "dead") {
        logger.info(`[${new Date().toISOString()}] Dead: waiting for funding (heartbeat only, no model calls).`);
        const { waitWhileDead } = await import("./survival/dead-state.js");
        const w = await waitWhileDead(db.raw);
        logger.info(
          `[${new Date().toISOString()}] Left dead after ${w.polls} check(s)` +
            `${w.ignoredWakes ? `, ${w.ignoredWakes} wake request(s) ignored while dead` : ""}. Resuming.`,
        );
        continue;
      }

      // Fork (after the tier walk): a model the provider no longer serves stops
      // the agent until restart: no agent loop, no model call, wakes ignored.
      const modelStop = readModelUnavailable(db.raw);
      if (modelStop) {
        // INFO: the agent loop already logged the one ERROR line.
        logger.info(`[${new Date().toISOString()}] Waiting until restart. ${formatModelStop(modelStop)}`);
        await waitWhileModelUnavailable(db.raw);
        continue;
      }

      // Reload skills (may have changed since last loop)
      try {
        skills = loadSkills(skillsDir, db, { containerSandbox: isContainerSandbox(config.sandbox) });
      } catch (error) {
        logger.error("Skills reload failed", error instanceof Error ? error : undefined);
      }

      // Run the agent loop
      await runAgentLoop({
        identity,
        config,
        db,
        conway,
        inference,
        social,
        skills,
        policyEngine,
        spendTracker,
        ollamaBaseUrl,
        onStateChange: (state: AgentState) => {
          logger.info(`[${new Date().toISOString()}] State: ${state}`);
        },
        onTurnComplete: (turn) => {
          logger.info(
            `[${new Date().toISOString()}] Turn ${turn.id}: ${turn.toolCalls.length} tools, ${turn.tokenUsage.totalTokens} tokens`,
          );
        },
      });

      // Agent loop exited (sleeping or dead)
      // Fork: a model-unavailable stop is handled at the top of the loop (no sleep timer).
      if (readModelUnavailable(db.raw)) continue;
      const state = db.getAgentState();

      if (state === "dead") {
        // Fork (Phase 4 step 3): handled at the top of the loop (waitWhileDead).
        // Upstream slept 5 minutes here and re-entered the agent loop.
        logger.info(`[${new Date().toISOString()}] Automaton is dead. Heartbeat will continue.`);
        continue;
      }

      if (state === "sleeping") {
        // Fork: no sleep is shorter than the owner's floor (sleepConfig.minSeconds),
        // whichever path set it (agent, idle, budget, guard); the effective
        // wake time is written back so status and restarts see it.
        const sleepUntilStr = db.getKV("sleep_until");
        const sleepUntil = effectiveSleepUntil(
          sleepUntilStr ? new Date(sleepUntilStr).getTime() : NaN,
          Date.now(),
          resolveSleepSettings(config),
        );
        db.setKV("sleep_until", new Date(sleepUntil).toISOString());
        const sleepMs = sleepUntil - Date.now();
        logger.info(
          `[${new Date().toISOString()}] Sleeping for ${Math.round(sleepMs / 1000)}s`,
        );

        // Sleep, but check for wake requests periodically (Phase 1.1 wake_events)
        const end = await waitForSleepOrWake(db.raw, sleepUntil);
        if (end.woken) {
          logger.info(`[${new Date().toISOString()}] Woken by ${end.source}: ${end.reason}`);
        }

        // Clear sleep state
        db.deleteKV("sleep_until");
        continue;
      }
    } catch (err: any) {
      logger.error(
        `[${new Date().toISOString()}] Fatal error in run loop: ${err.message}`,
      );
      // Wait before retrying
      await sleep(30_000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Entry Point ───────────────────────────────────────────────

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
