/**
 * Wallet encryption at rest (fork, Phase 3 step 1).
 *
 * Each test gets a fresh HOME (wallet.ts resolves ~/.automaton at import) and
 * fresh modules, so the passphrase cache starts empty.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const PASS = "test-passphrase-0123456789abcdef";
const ENV = "AUTOMATON_WALLET_PASSPHRASE";
const SEPOLIA_CHAIN_ID_HEX = "0x14a34";

let home: string;
const saved = { HOME: process.env.HOME, pass: process.env[ENV], creator: process.env.AUTOMATON_CREATOR_ADDRESS, openai: process.env.OPENAI_API_KEY };

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wallet-enc-home-")));
  process.env.HOME = home;
  delete process.env[ENV];
  delete process.env.AUTOMATON_RPC_URL;
  delete process.env.AUTOMATON_CREATOR_ADDRESS;
  vi.resetModules();
});

afterEach(() => {
  process.env.HOME = saved.HOME;
  for (const [k, v] of [[ENV, saved.pass], ["AUTOMATON_CREATOR_ADDRESS", saved.creator], ["OPENAI_API_KEY", saved.openai]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

const walletFile = () => path.join(home, ".automaton", "wallet.json");
const readFile = () => fs.readFileSync(walletFile(), "utf-8");

function writePlainWallet(privateKey: `0x${string}`): void {
  fs.mkdirSync(path.join(home, ".automaton"), { recursive: true });
  fs.writeFileSync(walletFile(), JSON.stringify({ chainType: "evm", privateKey, createdAt: "2026-11-20T00:00:00.000Z" }), { mode: 0o600 });
}

describe("wallet-crypto", () => {
  it("round-trips, and refuses a wrong passphrase, a swapped address, an altered ciphertext and a short passphrase", async () => {
    const c = await import("../identity/wallet-crypto.js");
    const pk = generatePrivateKey();
    const addr = privateKeyToAccount(pk).address;
    const enc = c.encryptWalletData({ chainType: "evm", privateKey: pk, createdAt: "t" }, addr, PASS);
    expect(JSON.stringify(enc)).not.toContain(pk.slice(2));
    expect(enc.address).toBe(addr);
    expect(c.decryptWalletFile(enc, PASS).privateKey).toBe(pk);
    expect(() => c.decryptWalletFile(enc, PASS + "x")).toThrow(/wrong passphrase/);
    expect(() => c.decryptWalletFile({ ...enc, address: "0x000000000000000000000000000000000000dEaD" }, PASS)).toThrow(c.WalletPassphraseError);
    const flipped = Buffer.from(enc.ciphertext, "base64");
    flipped[0] ^= 1;
    expect(() => c.decryptWalletFile({ ...enc, ciphertext: flipped.toString("base64") }, PASS)).toThrow(c.WalletPassphraseError);
    expect(() => c.encryptWalletData({ chainType: "evm", privateKey: pk, createdAt: "t" }, addr, "short")).toThrow(/at least 16/);
  });

  it("setting: mainnet always requires encryption; invalid values are reported", async () => {
    const c = await import("../identity/wallet-crypto.js");
    expect(c.walletEncryptionRequired({ network: "mainnet" })).toBe(true);
    expect(c.walletEncryptionRequired({ network: "mainnet", walletEncryption: "optional" })).toBe(true);
    expect(c.walletEncryptionRequired({ walletEncryption: "required" })).toBe(true);
    expect(c.walletEncryptionRequired({ walletEncryption: "optional" })).toBe(false);
    expect(c.walletEncryptionRequired({})).toBe(false);
    expect(c.walletEncryptionRequired(null)).toBe(false);
    expect(c.checkWalletEncryptionSetting({})).toBeNull();
    expect(c.checkWalletEncryptionSetting({ walletEncryption: "yes" })).toMatch(/walletEncryption must be/);
  });

  it("reads the passphrase once and removes it from the environment", async () => {
    process.env[ENV] = PASS;
    const c = await import("../identity/wallet-crypto.js");
    expect(c.walletPassphrase()).toBe(PASS);
    expect(process.env[ENV]).toBeUndefined();
    expect(c.walletPassphrase()).toBe(PASS);
  });
});

describe("wallet file", () => {
  it("a new wallet is written encrypted when a passphrase is set; no key material in the file", async () => {
    process.env[ENV] = PASS;
    const w = await import("../identity/wallet.js");
    const { account, encrypted, isNew } = await w.getWallet();
    expect(isNew).toBe(true);
    expect(encrypted).toBe(true);
    const raw = JSON.parse(readFile());
    expect(Object.keys(raw).sort()).toEqual(["address", "chainType", "cipher", "ciphertext", "createdAt", "kdf", "version"]);
    expect(raw.address).toBe(account.address);
    if (process.platform !== "win32") expect((fs.statSync(walletFile()).mode & 0o777).toString(8)).toBe("600");
    // reopening decrypts to the same account; address and info need no passphrase
    expect((await w.getWallet()).account.address).toBe(account.address);
    expect(w.getWalletAddress()).toBe(account.address);
    expect(w.walletInfo()).toMatchObject({ exists: true, encrypted: true, address: account.address });
    expect(fs.readdirSync(path.join(home, ".automaton")).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("an encrypted wallet without a passphrase is refused", async () => {
    process.env[ENV] = PASS;
    await (await import("../identity/wallet.js")).getWallet();
    vi.resetModules(); // new process: no passphrase this time
    const w = await import("../identity/wallet.js");
    await expect(w.getWallet()).rejects.toThrow(/encrypted but no passphrase/);
    expect(() => w.loadWalletAccount()).toThrow(/encrypted but no passphrase/);
  });

  it("a plaintext wallet: accepted when optional (upstream), refused when required", async () => {
    const pk = generatePrivateKey();
    writePlainWallet(pk);
    process.env[ENV] = PASS; // set but unused: still removed from the environment
    const w = await import("../identity/wallet.js");
    expect((await w.getWallet()).encrypted).toBe(false);
    expect(process.env[ENV]).toBeUndefined();
    await expect(w.getWallet(undefined, { requireEncryption: true })).rejects.toThrow(/not encrypted.*agent:wallet:encrypt/);
  });

  it("refuses to create a plaintext wallet when encryption is required, and writes nothing", async () => {
    const w = await import("../identity/wallet.js");
    await expect(w.getWallet(undefined, { requireEncryption: true })).rejects.toThrow(/Refusing to create an unencrypted wallet/);
    expect(fs.existsSync(walletFile())).toBe(false);
  });

  it("encryptExistingWallet: plaintext → encrypted with the same address; the plaintext key is gone; again = no change", async () => {
    const pk = generatePrivateKey();
    const addr = privateKeyToAccount(pk).address;
    writePlainWallet(pk);
    process.env[ENV] = PASS;
    const w = await import("../identity/wallet.js");
    expect(w.encryptExistingWallet()).toEqual({ status: "encrypted", address: addr });
    expect(readFile()).not.toContain(pk.slice(2));
    expect(w.walletInfo()).toMatchObject({ encrypted: true, address: addr });
    expect(w.encryptExistingWallet()).toEqual({ status: "already", address: addr });
    expect(w.loadWalletAccount()?.address).toBe(addr);
    expect((await w.getWallet(undefined, { requireEncryption: true })).account.address).toBe(addr);
  });

  it("encryptExistingWallet needs a passphrase and leaves the wallet unchanged without one", async () => {
    const pk = generatePrivateKey();
    writePlainWallet(pk);
    const before = readFile();
    const w = await import("../identity/wallet.js");
    expect(() => w.encryptExistingWallet()).toThrow(/No passphrase set/);
    expect(readFile()).toBe(before);
  });

  it("an unknown wallet file version is refused", async () => {
    fs.mkdirSync(path.join(home, ".automaton"), { recursive: true });
    fs.writeFileSync(walletFile(), JSON.stringify({ version: 9, ciphertext: "x" }));
    const w = await import("../identity/wallet.js");
    await expect(w.getWallet()).rejects.toThrow(/Unknown wallet file version/);
  });
});

describe("leak test: a known key never shows up in startup output", () => {
  it("preflight lines and every log line stay free of the planted private key and the passphrase", async () => {
    const pk = generatePrivateKey();
    writePlainWallet(pk);
    process.env[ENV] = PASS;
    process.env.OPENAI_API_KEY = "test-openai-key";
    (await import("../identity/wallet.js")).encryptExistingWallet();

    vi.stubGlobal("fetch", vi.fn(async (_input: any, init?: any) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const reply = (one: any) => ({ jsonrpc: "2.0", id: one.id, result: one.method === "eth_chainId" ? SEPOLIA_CHAIN_ID_HEX : "0x0" });
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(reply) : reply(body)), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const captured: string[] = [];
    const grab = (...a: unknown[]) => { captured.push(a.map(String).join(" ")); };
    vi.spyOn(console, "log").mockImplementation(grab);
    vi.spyOn(console, "error").mockImplementation(grab);
    vi.spyOn(console, "warn").mockImplementation(grab);
    vi.spyOn(process.stdout, "write").mockImplementation(((s: any) => { captured.push(String(s)); return true; }) as any);
    vi.spyOn(process.stderr, "write").mockImplementation(((s: any) => { captured.push(String(s)); return true; }) as any);

    const { createTestConfig } = await import("./mocks.js");
    const { DEFAULT_MODEL_STRATEGY_CONFIG } = await import("../types.js");
    const config = createTestConfig({
      sandboxId: "", conwayApiKey: undefined as any, conway: "off", network: "testnet", balanceSource: "own",
      walletEncryption: "required", socialRelayUrl: "", inferenceModel: "gpt-4.1-mini",
      modelStrategy: { ...DEFAULT_MODEL_STRATEGY_CONFIG }, sandbox: undefined,
      dbPath: path.join(home, ".automaton", "state.db"),
      heartbeatConfigPath: path.join(home, ".automaton", "heartbeat.yml"),
      skillsDir: path.join(home, ".automaton", "skills"),
    });
    const { runPreflight } = await import("../runtime/prepare.js");
    const report = await runPreflight(config);
    vi.restoreAllMocks();

    const text = report.lines.join("\n");
    expect(report.ok, text).toBe(true);
    expect(text).toContain("INFO  wallet file: encrypted at rest");
    const everything = `${text}\n${captured.join("\n")}`;
    expect(everything).not.toContain(pk.slice(2));
    expect(everything.toLowerCase()).not.toContain(pk.slice(2).toLowerCase());
    expect(everything).not.toContain(PASS);
    expect(process.env[ENV]).toBeUndefined();
  });
});
