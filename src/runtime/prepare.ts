/**
 * Runtime setup shared by `--run` and `--preflight` (fork, Phase 1).
 *
 * prepareRuntime() is the startup path up to (not including) the heartbeat
 * and the agent loop. `--preflight` runs exactly this path, plus checks, and
 * exits: no model call, no agent loop, nothing sent to Conway, one read-only
 * RPC call to the active network.
 */

import fs from "fs";
import { randomUUID } from "crypto";
import { keccak256, toHex, createPublicClient, http } from "viem";
import { getWallet, getWalletPath } from "../identity/wallet.js";
import { loadApiKeyFromConfig } from "../identity/provision.js";
import { resolvePath } from "../config.js";
import { createDatabase } from "../state/database.js";
import { createConwayClient } from "../conway/client.js";
import { createInferenceClient, resolveInferenceBackend } from "../conway/inference.js";
import { loadHeartbeatConfig, syncHeartbeatToDb } from "../heartbeat/config.js";
import { ModelRegistry } from "../inference/registry.js";
import { loadSkills } from "../skills/loader.js";
import { createSocialClient } from "../social/client.js";
import { PolicyEngine } from "../agent/policy-engine.js";
import { SpendTracker } from "../agent/spend-tracker.js";
import { createDefaultRules } from "../agent/policy-rules/index.js";
import { createBuiltinTools } from "../agent/tools.js";
import { applyAgentSettings } from "../agent/settings.js";
import { activateNetwork, getActiveNetwork } from "../identity/network.js";
import { isContainerSandbox } from "../sandbox/transport.js";
import {
  filterToolsForConwayMode,
  isConwayHost,
  resolveConwayMode,
  setConwayDisabled,
  type ConwayMode,
} from "../conway/mode.js";
import { createLogger } from "../observability/logger.js";
import type {
  AutomatonConfig,
  AutomatonDatabase,
  AutomatonIdentity,
  ConwayClient,
  InferenceClient,
  Skill,
  SocialClientInterface,
} from "../types.js";
import { DEFAULT_TREASURY_POLICY } from "../types.js";
import type { PrivateKeyAccount } from "viem";
import type { ChainType } from "../identity/chain.js";
import type { HeartbeatConfig } from "../types.js";

const logger = createLogger("main");
const ts = () => new Date().toISOString();

/**
 * Make sure the RPC serves the active chain. A mainnet RPC with testnet mode
 * (or the reverse) would read the wrong balances.
 */
export async function verifyRpcChain(rpcUrl: string | undefined, expectedChainId: number): Promise<void> {
  if (!rpcUrl) return;
  const client = createPublicClient({ chain: getActiveNetwork().chain, transport: http(rpcUrl, { timeout: 10_000 }) });
  let actual: number;
  try {
    actual = await client.getChainId();
  } catch (err: any) {
    throw new Error(`Could not verify the RPC chain id: ${err?.message || String(err)}. Refusing to start.`);
  }
  if (actual !== expectedChainId) {
    throw new Error(
      `RPC chain id ${actual} does not match the active network (${expectedChainId}). Fix rpcUrl / AUTOMATON_RPC_URL. Refusing to start.`,
    );
  }
}

export interface PreparedRuntime {
  config: AutomatonConfig;
  db: AutomatonDatabase;
  identity: AutomatonIdentity;
  account: PrivateKeyAccount;
  resolvedChainType: ChainType;
  conwayMode: ConwayMode;
  conway: ConwayClient;
  inference: InferenceClient;
  modelRegistry: ModelRegistry;
  social: SocialClientInterface | undefined;
  policyEngine: PolicyEngine;
  spendTracker: SpendTracker;
  heartbeatConfig: HeartbeatConfig;
  skillsDir: string;
  skills: Skill[];
  ollamaBaseUrl: string | undefined;
  /** Keys used by the main-loop model client (config first, then env). */
  modelKeys: { openaiApiKey?: string; anthropicApiKey?: string };
  rpcUrlChecked: string | undefined;
}

export async function prepareRuntime(
  config: AutomatonConfig,
  opts: { preflight: boolean },
): Promise<PreparedRuntime> {
  // Preflight never creates a wallet; --init does.
  if (opts.preflight && !fs.existsSync(getWalletPath())) {
    throw new Error("No wallet found. Create it first with --init (pnpm agent:init).");
  }

  // Load wallet (chain-aware)
  const { account, chainIdentity, chainType: walletChainType } = await getWallet();
  const resolvedChainType: ChainType = config.chainType || walletChainType || "evm";

  // EVM network: testnet unless mainnet is set AND approved by the owner (fork change 2).
  // Throws (refuses to start) on mainnet without approval or an unknown value.
  const network = activateNetwork({ network: config.network, walletAddress: chainIdentity.address });
  logger.info(`[${ts()}] Network: ${network.label}`);
  // Preflight always checks the RPC (the configured one or the network default).
  const rpcUrl =
    config.rpcUrl ||
    process.env.AUTOMATON_RPC_URL ||
    (opts.preflight ? getActiveNetwork().chain.rpcUrls.default.http[0] : undefined);
  if (resolvedChainType !== "solana") {
    await verifyRpcChain(rpcUrl, network.chainId);
  }

  // Fork: Conway on/off. Off = own providers only; nothing is sent to Conway.
  const apiKey = config.conwayApiKey || loadApiKeyFromConfig() || "";
  const conwayMode = resolveConwayMode(config.conway, apiKey);
  config.conway = conwayMode;
  if (conwayMode === "on" && !apiKey) {
    throw new Error('"conway": "on" needs a Conway API key (run --provision), or set "conway": "off".');
  }
  if (conwayMode === "off") {
    setConwayDisabled();
    if (config.balanceSource === "conway") {
      throw new Error('balanceSource "conway" needs Conway on. Use balanceSource "own" with "conway": "off".');
    }
  }
  logger.info(`[${ts()}] Conway: ${conwayMode === "on" ? "on" : "off (own providers only)"}`);

  // Initialize database
  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);

  // Fork: apply settings the agent changed itself (stored in the database),
  // only where they still meet the owner's current limits.
  {
    const { applied, ignored } = applyAgentSettings(config, db.raw);
    if (applied.length) logger.info(`[${ts()}] Agent settings applied: ${applied.join(", ")}`);
    for (const i of ignored) logger.warn(`[${ts()}] Agent setting ${i.key} ignored: ${i.why}`);
  }

  // Persist createdAt: only set if not already stored (never overwrite)
  const existingCreatedAt = db.getIdentity("createdAt");
  const createdAt = existingCreatedAt || new Date().toISOString();
  if (!existingCreatedAt) {
    db.setIdentity("createdAt", createdAt);
  }

  // Build identity (chain-aware)
  const identity: AutomatonIdentity = {
    name: config.name,
    address: chainIdentity.address,
    account,
    creatorAddress: config.creatorAddress,
    sandboxId: config.sandboxId,
    apiKey,
    createdAt,
    chainType: resolvedChainType,
    chainIdentity,
  };

  // Store identity in DB
  db.setIdentity("name", config.name);
  db.setIdentity("address", chainIdentity.address);
  db.setIdentity("creator", config.creatorAddress);
  db.setIdentity("chainType", resolvedChainType);
  db.setIdentity("sandbox", config.sandboxId);
  const storedAutomatonId = db.getIdentity("automatonId");
  const automatonId = storedAutomatonId || config.sandboxId || randomUUID();
  if (!storedAutomatonId) {
    db.setIdentity("automatonId", automatonId);
  }

  // Create Conway client (with Conway off it refuses every Conway API call;
  // shell and file tools still go to the sandbox)
  const conway = createConwayClient({
    apiUrl: config.conwayApiUrl,
    apiKey,
    sandboxId: config.sandboxId,
    sandbox: config.sandbox,
    conwayEnabled: conwayMode === "on",
  });

  // Register automaton identity with Conway (one-time). Fork: only with Conway
  // on, and never during preflight.
  const registrationState = db.getIdentity("conwayRegistrationStatus");
  if (conwayMode === "on" && !opts.preflight && registrationState !== "registered") {
    try {
      const genesisPromptHash = config.genesisPrompt ? keccak256(toHex(config.genesisPrompt)) : undefined;
      await conway.registerAutomaton({
        automatonId,
        automatonAddress: chainIdentity.address,
        creatorAddress: config.creatorAddress,
        name: config.name,
        bio: config.creatorMessage || "",
        genesisPromptHash,
        account,
        chainType: resolvedChainType,
        chainIdentity,
      });
      db.setIdentity("conwayRegistrationStatus", "registered");
      logger.info(`[${ts()}] Automaton identity registered.`);
    } catch (err: any) {
      const status = err?.status;
      if (status === 409) {
        db.setIdentity("conwayRegistrationStatus", "conflict");
        logger.warn(`[${ts()}] Automaton identity conflict: ${err.message}`);
      } else {
        db.setIdentity("conwayRegistrationStatus", "failed");
        logger.warn(`[${ts()}] Automaton identity registration failed: ${err.message}`);
      }
    }
  }

  // Resolve Ollama base URL: env var takes precedence over config
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || config.ollamaBaseUrl;

  // Fork: model keys from config, or from the environment (Docker loads them
  // from the secrets folder into the runtime's environment only).
  const modelKeys = {
    openaiApiKey: config.openaiApiKey || process.env.OPENAI_API_KEY || undefined,
    anthropicApiKey: config.anthropicApiKey || process.env.ANTHROPIC_API_KEY || undefined,
  };

  // Create inference client — pass a live registry lookup so model names like
  // "gpt-oss:120b" route to Ollama based on their registered provider, not heuristics.
  const modelRegistry = new ModelRegistry(db.raw);
  modelRegistry.initialize();
  const inference = createInferenceClient({
    apiUrl: config.conwayApiUrl,
    apiKey,
    defaultModel: config.inferenceModel,
    maxTokens: config.maxTokensPerTurn,
    lowComputeModel: config.modelStrategy?.lowComputeModel || "gpt-4.1-nano",
    openaiApiKey: modelKeys.openaiApiKey,
    anthropicApiKey: modelKeys.anthropicApiKey,
    ollamaBaseUrl,
    getModelProvider: (modelId) => modelRegistry.get(modelId)?.provider,
    conwayEnabled: conwayMode === "on",
  });

  if (ollamaBaseUrl) {
    logger.info(`[${ts()}] Ollama backend: ${ollamaBaseUrl}`);
  }

  // Create social client (chain-aware: pass ChainIdentity for Solana signing).
  // Fork: with Conway off, a Conway relay (the default) is not used.
  let social: SocialClientInterface | undefined;
  if (config.socialRelayUrl) {
    if (conwayMode === "off" && isConwayHost(config.socialRelayUrl)) {
      logger.info(`[${ts()}] Social relay off (Conway relay, Conway is off).`);
    } else {
      social = createSocialClient(config.socialRelayUrl, resolvedChainType === "solana" ? chainIdentity : account);
      logger.info(`[${ts()}] Social relay: ${config.socialRelayUrl}`);
    }
  }

  // Initialize PolicyEngine + SpendTracker (Phase 1.4)
  const treasuryPolicy = config.treasuryPolicy ?? DEFAULT_TREASURY_POLICY;
  const rules = createDefaultRules(treasuryPolicy);
  const policyEngine = new PolicyEngine(db.raw, rules);
  const spendTracker = new SpendTracker(db.raw);

  // Load and sync heartbeat config
  const heartbeatConfigPath = resolvePath(config.heartbeatConfigPath);
  const heartbeatConfig = loadHeartbeatConfig(heartbeatConfigPath);
  syncHeartbeatToDb(heartbeatConfig, db);

  // Load skills
  const skillsDir = config.skillsDir || "~/.automaton/skills";
  let skills: Skill[] = [];
  try {
    skills = loadSkills(skillsDir, db, { containerSandbox: isContainerSandbox(config.sandbox) });
    logger.info(`[${ts()}] Loaded ${skills.length} skills.`);
  } catch (err: any) {
    logger.warn(`[${ts()}] Skills loading failed: ${err.message}`);
  }

  return {
    config,
    db,
    identity,
    account,
    resolvedChainType,
    conwayMode,
    conway,
    inference,
    modelRegistry,
    social,
    policyEngine,
    spendTracker,
    heartbeatConfig,
    skillsDir,
    skills,
    ollamaBaseUrl,
    modelKeys,
    rpcUrlChecked: rpcUrl,
  };
}

/**
 * `--preflight`: the real startup path plus checks; then exit. Returns the
 * report lines and whether everything passed. Never prints key values.
 */
export async function runPreflight(config: AutomatonConfig): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = ["=== PREFLIGHT ==="];
  let ok = true;
  const line = (pass: boolean, text: string) => {
    if (!pass) ok = false;
    lines.push(`${pass ? "PASS" : "FAIL"}  ${text}`);
  };

  let rt: PreparedRuntime;
  try {
    rt = await prepareRuntime(config, { preflight: true });
  } catch (err: any) {
    line(false, `startup: ${err?.message ?? String(err)}`);
    return { ok, lines };
  }

  try {
    line(true, `network: ${getActiveNetwork().label}, RPC chain id verified (${rt.rpcUrlChecked ? "read-only call" : "skipped"})`);
    line(true, `wallet: ${rt.identity.address}`);
    line(true, `Conway: ${rt.conwayMode}${rt.conwayMode === "off" ? " (own providers only; no Conway requests)" : ""}`);
    line(true, `database: ${rt.db.raw.name}`);

    // Models: each strategy model must have a usable provider (no model call).
    const s = rt.config.modelStrategy;
    const models = [...new Set([rt.config.inferenceModel, s?.inferenceModel, s?.lowComputeModel, s?.criticalModel].filter(Boolean) as string[])];
    for (const model of models) {
      try {
        const backend = resolveInferenceBackend(model, {
          ...rt.modelKeys,
          ollamaBaseUrl: rt.ollamaBaseUrl,
          getModelProvider: (id) => rt.modelRegistry.get(id)?.provider,
          conwayEnabled: rt.conwayMode === "on",
        });
        line(true, `model ${model}: provider ${backend}, key ${backend === "ollama" ? "not needed" : "present"}`);
      } catch (err: any) {
        line(false, `model ${model}: ${err?.message ?? String(err)}`);
      }
    }

    // Sandbox (container mode): one harmless command through the socket.
    if (isContainerSandbox(rt.config.sandbox)) {
      try {
        const r = await rt.conway.exec("id -u", 10_000);
        line(r.exitCode === 0, `sandbox: reachable, runs as uid ${r.stdout.trim()}`);
      } catch (err: any) {
        line(false, `sandbox: ${err?.message ?? String(err)}`);
      }
    } else {
      lines.push("INFO  sandbox: local mode (shell runs in this process)");
    }

    const all = createBuiltinTools(rt.identity.sandboxId);
    const offered = filterToolsForConwayMode(all, rt.conwayMode);
    lines.push(`INFO  tools: ${offered.length} offered, ${all.length - offered.length} Conway-only hidden`);
    lines.push(`INFO  social relay: ${rt.social ? rt.config.socialRelayUrl : "off"}`);
    lines.push(`INFO  skills: ${rt.skills.length} loaded from ${rt.skillsDir}`);
  } finally {
    rt.db.close();
  }

  lines.push(`=== ${ok ? "PREFLIGHT PASSED" : "PREFLIGHT FAILED"} (no model call, agent not started) ===`);
  return { ok, lines };
}
