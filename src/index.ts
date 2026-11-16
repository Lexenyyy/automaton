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
import { releaseRuntimeLease, startLeaseHeartbeat } from "./runtime/instance-lease.js";
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
  automaton --ledger [show | grant <amount> | adjust <±amount> --memo "..."]
                           Owner: show the ledger or add a grant/adjustment (dollars)
  automaton --activity     Owner: recent turns, inference spend and sleep state
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
    const { chainIdentity, isNew } = await getWallet(initChainType);
    logger.info(
      JSON.stringify({
        address: chainIdentity.address,
        isNew,
        configDir: getAutomatonDir(),
      }),
    );
    process.exit(0);
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
    const db = createDatabase(resolvePath(config.dbPath));
    const { getActivityReport, formatActivityReport } = await import("./state/activity-report.js");
    try {
      console.log(formatActivityReport(getActivityReport(db.raw)));
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

  // Fork: a restart honours a sleep that is still pending (the agent's own or
  // a forced one), so restarting does not cost a wake. --wake-now overrides.
  const wakeNow = process.argv.includes("--wake-now");
  const pending = pendingStartupSleep((k) => db.getKV(k), Date.now(), wakeNow);
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
  } else if (wakeNow) {
    logger.info(`[${new Date().toISOString()}] --wake-now: any pending sleep is ignored.`);
  }

  // ─── Main Run Loop ──────────────────────────────────────────
  // The automaton alternates between running and sleeping.
  // The heartbeat can wake it up.

  while (true) {
    try {
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
      const state = db.getAgentState();

      if (state === "dead") {
        logger.info(`[${new Date().toISOString()}] Automaton is dead. Heartbeat will continue.`);
        // In dead state, we just wait for funding
        // The heartbeat will keep checking and broadcasting distress
        await sleep(300_000); // Check every 5 minutes
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
