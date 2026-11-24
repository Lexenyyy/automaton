/**
 * Fork Phase 1: "conway": "off" = own providers only. The agent starts
 * without a Conway API key and nothing is ever sent to a Conway host.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONWAY_ONLY_TOOLS,
  ConwayDisabledError,
  filterToolsForConwayMode,
  isConwayHost,
  resetConwayModeForTests,
  resolveConwayMode,
  setConwayDisabled,
} from "../conway/mode.js";
import { createConwayClient } from "../conway/client.js";
import { createInferenceClient, resolveInferenceBackend } from "../conway/inference.js";
import { createBuiltinTools } from "../agent/tools.js";

const SEPOLIA_CHAIN_ID_HEX = "0x14a34"; // 84532

/** fetch stub: answers eth_chainId, records every Conway request and refuses it. */
function stubFetch() {
  const conwayRequests: string[] = [];
  const otherRequests: string[] = [];
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    if (isConwayHost(url)) {
      conwayRequests.push(url);
      throw new Error("test: Conway must not be called");
    }
    otherRequests.push(url);
    // Fork (model check): the free OpenAI model list answers with today's models.
    if (url === "https://api.openai.com/v1/models") {
      const data = [{ id: "gpt-4.1-mini", shutdown_date: "2027-01-14" }, { id: "gpt-6-luna", shutdown_date: null }];
      return new Response(JSON.stringify({ object: "list", data }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const reply = (one: any) => ({ jsonrpc: "2.0", id: one.id, result: one.method === "eth_chainId" ? SEPOLIA_CHAIN_ID_HEX : "0x0" });
    const payload = Array.isArray(body) ? body.map(reply) : reply(body);
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, conwayRequests, otherRequests };
}

afterEach(() => {
  resetConwayModeForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("conway setting", () => {
  it("absent: on with a Conway key (upstream), off without", () => {
    expect(resolveConwayMode(undefined, "key")).toBe("on");
    expect(resolveConwayMode(undefined, "")).toBe("off");
    expect(resolveConwayMode("off", "key")).toBe("off");
    expect(resolveConwayMode("on", "")).toBe("on");
    expect(() => resolveConwayMode("maybe", "")).toThrow(/Invalid "conway" setting/);
  });

  it("recognizes Conway hosts", () => {
    for (const u of ["https://api.conway.tech/v1", "https://social.conway.tech", "https://conway.tech", "https://inference.conway.tech."]) {
      expect(isConwayHost(u)).toBe(true);
    }
    for (const u of ["https://api.openai.com", "https://notconway.tech", "https://conway.tech.evil.com", "not a url"]) {
      expect(isConwayHost(u)).toBe(false);
    }
  });
});

describe("Conway client with Conway off", () => {
  it("refuses every Conway API call without sending anything", async () => {
    const { fetchMock } = stubFetch();
    const c = createConwayClient({ apiUrl: "https://api.conway.tech", apiKey: "", sandboxId: "", conwayEnabled: false });
    const calls: Promise<unknown>[] = [
      c.getCreditsBalance(),
      c.getCreditsPricing(),
      c.listSandboxes(),
      c.createSandbox({ name: "x" } as any),
      c.transferCredits("0x0000000000000000000000000000000000000001", 1),
      c.searchDomains("example"),
      c.listModels(),
    ];
    // Some upstream methods swallow errors and return an empty list; either
    // way nothing may be sent.
    for (const r of await Promise.allSettled(calls)) {
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ConwayDisabledError);
      else expect(r.value).toEqual([]);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the process-wide switch also covers clients created without the option", async () => {
    const { fetchMock } = stubFetch();
    setConwayDisabled();
    const c = createConwayClient({ apiUrl: "https://api.conway.tech", apiKey: "k", sandboxId: "sbx-remote" });
    await expect(c.exec("id")).rejects.toBeInstanceOf(ConwayDisabledError);
    await expect(c.createScopedClient("other").getCreditsBalance()).rejects.toBeInstanceOf(ConwayDisabledError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("main-loop model client with Conway off", () => {
  const registry = (map: Record<string, string>) => (id: string) => map[id];

  it("never picks the Conway backend", () => {
    const off = { conwayEnabled: false };
    expect(resolveInferenceBackend("gpt-4.1-mini", { ...off, openaiApiKey: "k" })).toBe("openai");
    expect(resolveInferenceBackend("claude-x", { ...off, anthropicApiKey: "k" })).toBe("anthropic");
    expect(resolveInferenceBackend("llama3", { ...off, ollamaBaseUrl: "http://localhost:11434", getModelProvider: registry({ llama3: "ollama" }) })).toBe("ollama");
    expect(() => resolveInferenceBackend("gpt-4.1-mini", off)).toThrow(/No provider for model 'gpt-4.1-mini' with Conway off/);
    expect(() => resolveInferenceBackend("conway-model", { ...off, getModelProvider: registry({ "conway-model": "conway" }) })).toThrow(/Conway off/);
    // Conway on: upstream behavior unchanged
    expect(resolveInferenceBackend("gpt-4.1-mini", {})).toBe("conway");
  });

  it("a chat for a model without a usable key fails before anything is sent", async () => {
    const { fetchMock } = stubFetch();
    const client = createInferenceClient({
      apiUrl: "https://api.conway.tech",
      apiKey: "",
      defaultModel: "gpt-4.1-mini",
      maxTokens: 100,
      conwayEnabled: false,
    });
    await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/Conway off/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("x402 with Conway off", () => {
  it("refuses payments to Conway hosts (covers credit top-ups) without a request", async () => {
    const { fetchMock } = stubFetch();
    setConwayDisabled();
    const { x402Fetch } = await import("../conway/x402.js");
    const r = await x402Fetch("https://api.conway.tech/v1/credits/topup", {} as any);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Conway is off/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Conway-only tools", () => {
  const builtins = createBuiltinTools("sbx");

  it("are hidden (and therefore not executable) with Conway off, all offered with Conway on", () => {
    const names = builtins.map((t) => t.name);
    for (const n of CONWAY_ONLY_TOOLS) expect(names).toContain(n);
    const off = filterToolsForConwayMode(builtins, "off").map((t) => t.name);
    expect(off.filter((n) => CONWAY_ONLY_TOOLS.has(n))).toEqual([]);
    expect(off.length).toBe(builtins.length - CONWAY_ONLY_TOOLS.size);
    expect(filterToolsForConwayMode(builtins, "on")).toHaveLength(builtins.length);
    // Still available with Conway off: own-model tools and on-chain balance.
    for (const keep of ["switch_model", "list_models", "check_usdc_balance", "exec", "write_file"]) expect(off).toContain(keep);
  });

  it("guard: every tool that calls the Conway platform is on the Conway-only list", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../agent/tools.ts"), "utf-8").replace(/\r\n/g, "\n");
    const end = src.indexOf("export async function executeTool");
    const starts = [...src.matchAll(/\n\s*\{\s*\n\s*name: "([a-z_0-9]+)",/g)].filter((m) => m.index! < end);
    // exec/writeFile/readFile go to the sandbox; expose/remove port are Phase 5a;
    // list_models reads the local registry first (the Conway fallback is refused by the client).
    const notConway = new Set(["exec", "writeFile", "readFile", "exposePort", "removePort", "listModels"]);
    const missing: string[] = [];
    starts.forEach((m, i) => {
      const body = src.slice(m.index!, i + 1 < starts.length ? starts[i + 1].index! : end);
      const apiCalls = [...body.matchAll(/conway\.(\w+)\(/g)].map((x) => x[1]).filter((x) => !notConway.has(x));
      const usesConwayUrl = /conwayApiUrl|x402Fetch|topupCredits|createScopedClient/.test(body);
      if ((apiCalls.length || usesConwayUrl) && !CONWAY_ONLY_TOOLS.has(m[1])) missing.push(`${m[1]} (${apiCalls.join(",") || "conway url/x402"})`);
    });
    expect(missing).toEqual([]);
  });
});

describe("startup without a Conway key (prepareRuntime / --preflight)", () => {
  let home: string;
  const savedHome = process.env.HOME;
  const savedOpenAi = process.env.OPENAI_API_KEY;

  const savedCreator = process.env.AUTOMATON_CREATOR_ADDRESS;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "conway-off-home-")));
    process.env.HOME = home;
    delete process.env.AUTOMATON_RPC_URL;
    delete process.env.AUTOMATON_CREATOR_ADDRESS;
    vi.resetModules();
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    if (savedCreator === undefined) delete process.env.AUTOMATON_CREATOR_ADDRESS;
    else process.env.AUTOMATON_CREATOR_ADDRESS = savedCreator;
    if (savedOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAi;
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function setup() {
    const { createTestConfig } = await import("./mocks.js");
    const { DEFAULT_MODEL_STRATEGY_CONFIG } = await import("../types.js");
    return createTestConfig({
      sandboxId: "",
      conwayApiKey: undefined as any,
      conway: undefined,
      network: "testnet",
      balanceSource: "own",
      socialRelayUrl: "https://social.conway.tech",
      inferenceModel: "gpt-4.1-mini",
      modelStrategy: { ...DEFAULT_MODEL_STRATEGY_CONFIG },
      dbPath: path.join(home, ".automaton", "state.db"),
      heartbeatConfigPath: path.join(home, ".automaton", "heartbeat.yml"),
      skillsDir: path.join(home, ".automaton", "skills"),
      sandbox: undefined,
    });
  }

  it("preflight refuses without a wallet and does not create one", async () => {
    stubFetch();
    const { runPreflight } = await import("../runtime/prepare.js");
    const { getWalletPath } = await import("../identity/wallet.js");
    const r = await runPreflight(await setup());
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/No wallet found/);
    expect(fs.existsSync(getWalletPath())).toBe(false);
  });

  it("starts with no Conway key: Conway off, own model key used, nothing sent to Conway", async () => {
    const { conwayRequests, otherRequests } = stubFetch();
    process.env.OPENAI_API_KEY = "test-openai-key";
    const { getWallet } = await import("../identity/wallet.js");
    await getWallet();
    const { prepareRuntime, runPreflight } = await import("../runtime/prepare.js");
    const { CONWAY_ONLY_TOOLS: hidden } = await import("../conway/mode.js");

    const report = await runPreflight(await setup());
    const text = report.lines.join("\n");
    expect(report.ok).toBe(true);
    expect(text).toContain("Conway: off (own providers only; no Conway requests)");
    expect(text).toContain("model gpt-4.1-mini: provider openai, key present");
    expect(text).toContain("model gpt-6-luna: provider openai, key present");
    // Fork (model check): both models confirmed by the free model list; mini's shutdown date is a WARN.
    expect(text).toContain("PASS  model gpt-6-luna: listed by openai, no shutdown date");
    expect(text).toContain("PASS  model gpt-4.1-mini: listed by openai");
    expect(text).toMatch(/WARN {2}model gpt-4\.1-mini: openai shuts it down on 2027-01-14 \(\d+ days\)/);
    expect(text).toContain("INFO  reasoning effort (OpenAI reasoning models only): none");
    expect(otherRequests.filter((u) => u === "https://api.openai.com/v1/models")).toHaveLength(1);
    expect(text).toContain("social relay: off");
    expect(text).toContain(`${hidden.size} Conway-only hidden`);
    expect(text).not.toContain("test-openai-key");
    expect(otherRequests.some((u) => u.includes("sepolia.base.org"))).toBe(true);

    // The real --run setup path (registration included) with Conway off.
    const rt = await prepareRuntime(await setup(), { preflight: false });
    expect(rt.conwayMode).toBe("off");
    expect(rt.config.conway).toBe("off");
    expect(rt.social).toBeUndefined();
    expect(rt.db.getIdentity("conwayRegistrationStatus")).toBeUndefined();

    // Fork: instance lease. A second --run on the same database is refused;
    // preflight reports the lease as held.
    expect(text).toContain("runtime lease: free");
    expect(rt.lease).toBeDefined();
    await expect(prepareRuntime(await setup(), { preflight: false })).rejects.toThrow(
      /Another runtime is already running on this database .*Refusing to start/,
    );
    expect((await runPreflight(await setup())).lines.join("\n")).toContain("runtime lease: HELD");
    const { releaseRuntimeLease } = await import("../runtime/instance-lease.js");
    releaseRuntimeLease(rt.db.raw, rt.lease!.instanceId);
    rt.db.close();

    expect(conwayRequests).toEqual([]);
  });

  it("fork (model check): a configured model the provider no longer lists FAILs preflight; a rejected key FAILs once, no key printed", async () => {
    stubFetch();
    process.env.OPENAI_API_KEY = "test-openai-key";
    const { getWallet } = await import("../identity/wallet.js");
    await getWallet();
    const { runPreflight } = await import("../runtime/prepare.js");
    const retired = await runPreflight(
      { ...(await setup()), agentSettings: { model: { allowedModels: ["gpt-4.1-mini", "gpt-4.1-nano"] } } } as any,
      { fetchModelList: async () => ({ ok: true, models: new Map([["gpt-4.1-mini", { id: "gpt-4.1-mini" }], ["gpt-6-luna", { id: "gpt-6-luna" }]]) }) },
    );
    expect(retired.ok).toBe(false);
    expect(retired.lines).toContain("FAIL  model gpt-4.1-nano: not offered by openai (retired or unknown); the agent cannot use it");
    expect(retired.lines.at(-1)).toMatch(/PREFLIGHT FAILED/);

    const rejected = await runPreflight(await setup(), { fetchModelList: async () => ({ ok: false, reason: "HTTP 401, invalid_api_key, key rejected" }) });
    expect(rejected.ok).toBe(false);
    expect(rejected.lines.filter((l) => l.startsWith("FAIL"))).toEqual([
      "FAIL  model list (openai): could not read (HTTP 401, invalid_api_key, key rejected); models not confirmed",
    ]);
    expect(rejected.lines.join("\n")).not.toContain("test-openai-key");
  });

  it("preflight fails clearly when a model has no usable key", async () => {
    stubFetch();
    delete process.env.OPENAI_API_KEY;
    const { getWallet } = await import("../identity/wallet.js");
    await getWallet();
    const { runPreflight } = await import("../runtime/prepare.js");
    const r = await runPreflight(await setup());
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/FAIL {2}model gpt-4.1-mini: No provider for model 'gpt-4.1-mini' with Conway off/);
  });

  it("refuses contradictory settings", async () => {
    stubFetch();
    const { getWallet } = await import("../identity/wallet.js");
    await getWallet();
    const { prepareRuntime } = await import("../runtime/prepare.js");
    await expect(prepareRuntime({ ...(await setup()), conway: "on" }, { preflight: true })).rejects.toThrow(/needs a Conway API key/);
    await expect(prepareRuntime({ ...(await setup()), balanceSource: "conway" }, { preflight: true })).rejects.toThrow(
      /balanceSource "conway" needs Conway on/,
    );
    // toolAllowlist: unknown/hidden names or no "sleep" refuse to start.
    await expect(prepareRuntime({ ...(await setup()), toolAllowlist: ["exec", "transfer_credits"] }, { preflight: true })).rejects.toThrow(
      /not available in this mode: transfer_credits.*must include "sleep".*Refusing to start/,
    );
  });

  it("refuses to start without a real creator address; the env value overrides the config", async () => {
    stubFetch();
    const { getWallet } = await import("../identity/wallet.js");
    await getWallet();
    const { prepareRuntime, runPreflight } = await import("../runtime/prepare.js");
    const zero = "0x0000000000000000000000000000000000000000";
    await expect(prepareRuntime({ ...(await setup()), creatorAddress: zero }, { preflight: true })).rejects.toThrow(
      /zero address.*AUTOMATON_CREATOR_ADDRESS.*Refusing to start/,
    );
    const report = await runPreflight({ ...(await setup()), creatorAddress: "" });
    expect(report.ok).toBe(false);
    expect(report.lines.join("\n")).toMatch(/FAIL {2}startup: No creator address/);

    process.env.AUTOMATON_CREATOR_ADDRESS = "0x000000000000000000000000000000000000dEaD";
    const rt = await prepareRuntime({ ...(await setup()), creatorAddress: zero }, { preflight: true });
    expect(rt.config.creatorAddress).toBe("0x000000000000000000000000000000000000dEaD");
    expect(rt.db.getIdentity("creator")).toBe("0x000000000000000000000000000000000000dEaD");
    rt.db.close();
  });
});
