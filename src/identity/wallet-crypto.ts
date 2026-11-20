/**
 * Wallet encryption at rest (fork, Phase 3 step 1, owner-approved).
 *
 * Upstream stored the private key in plain JSON (`wallet.json`, mode 0600).
 * Now the key is encrypted with a passphrase that the owner keeps in the
 * runtime's secrets folder (file `wallet_passphrase`, exported to the runtime
 * process only as AUTOMATON_WALLET_PASSPHRASE; never the sandbox, never the
 * config). Key derivation: scrypt; cipher: AES-256-GCM with the chain type and
 * address as additional authenticated data, so the address kept in clear for
 * status commands cannot be swapped without the decryption failing.
 *
 * What this protects: a copy of the wallet volume (backup, `docker cp`, a
 * future bug that leaks a file) no longer contains a usable key. What it does
 * not: someone who can read both the volume and the secrets folder on the host,
 * or the running process's memory (the key is decrypted there at startup).
 *
 * Losing the passphrase loses the wallet. The owner keeps a copy offline.
 */

import crypto from "node:crypto";
import type { WalletData } from "../types.js";
import type { ChainType } from "./chain.js";

export const WALLET_PASSPHRASE_ENV = "AUTOMATON_WALLET_PASSPHRASE";
export const MIN_WALLET_PASSPHRASE_LENGTH = 16;
export const WALLET_FILE_VERSION = 2;

/** scrypt cost: 32 MiB, about 0.1 s. Stored in the file, so it can be raised later. */
export const DEFAULT_SCRYPT = { N: 32768, r: 8, p: 1 } as const;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

export interface EncryptedWalletFile {
  version: 2;
  chainType: ChainType;
  /** In clear for status commands; bound to the ciphertext as AAD. */
  address: string;
  createdAt: string;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: { name: "aes-256-gcm"; iv: string; tag: string };
  ciphertext: string;
}

export class WalletPassphraseError extends Error {}

export function isEncryptedWalletFile(x: unknown): x is EncryptedWalletFile {
  const f = x as EncryptedWalletFile | null;
  return !!f && typeof f === "object" && f.version === WALLET_FILE_VERSION && typeof f.ciphertext === "string";
}

function aad(chainType: ChainType, address: string): Buffer {
  return Buffer.from(`automaton-wallet-v2|${chainType}|${address}`, "utf-8");
}

function deriveKey(passphrase: string, salt: Buffer, p: { N: number; r: number; p: number }): Buffer {
  return crypto.scryptSync(passphrase, salt, 32, { N: p.N, r: p.r, p: p.p, maxmem: SCRYPT_MAXMEM });
}

/** A problem with a passphrase, or null when it is usable. */
export function checkWalletPassphrase(passphrase: string): string | null {
  if (passphrase.length < MIN_WALLET_PASSPHRASE_LENGTH) {
    return `The wallet passphrase must be at least ${MIN_WALLET_PASSPHRASE_LENGTH} characters (use a random one).`;
  }
  return null;
}

export function encryptWalletData(
  data: WalletData,
  address: string,
  passphrase: string,
  scrypt: { N: number; r: number; p: number } = DEFAULT_SCRYPT,
): EncryptedWalletFile {
  const problem = checkWalletPassphrase(passphrase);
  if (problem) throw new WalletPassphraseError(problem);
  const chainType: ChainType = data.chainType || "evm";
  const secret = chainType === "solana" ? { secretKey: data.secretKey } : { privateKey: data.privateKey };
  if (!secret.secretKey && !secret.privateKey) throw new Error("Wallet data has no key to encrypt.");
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt, scrypt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(chainType, address));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secret), "utf-8"), cipher.final()]);
  key.fill(0);
  return {
    version: WALLET_FILE_VERSION,
    chainType,
    address,
    createdAt: data.createdAt,
    kdf: { name: "scrypt", N: scrypt.N, r: scrypt.r, p: scrypt.p, salt: salt.toString("base64") },
    cipher: { name: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") },
    ciphertext: ciphertext.toString("base64"),
  };
}

/** Decrypts; throws WalletPassphraseError on a wrong passphrase or a damaged/altered file. */
export function decryptWalletFile(file: EncryptedWalletFile, passphrase: string): WalletData {
  if (file.kdf?.name !== "scrypt" || file.cipher?.name !== "aes-256-gcm") {
    throw new WalletPassphraseError("Unknown wallet encryption format.");
  }
  const key = deriveKey(passphrase, Buffer.from(file.kdf.salt, "base64"), file.kdf);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(file.cipher.iv, "base64"));
    decipher.setAAD(aad(file.chainType, file.address));
    decipher.setAuthTag(Buffer.from(file.cipher.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(file.ciphertext, "base64")), decipher.final()]);
    const secret = JSON.parse(plain.toString("utf-8")) as { privateKey?: `0x${string}`; secretKey?: string };
    plain.fill(0);
    return { ...secret, chainType: file.chainType, createdAt: file.createdAt };
  } catch {
    throw new WalletPassphraseError("Cannot decrypt the wallet: wrong passphrase, or the wallet file was changed or damaged.");
  } finally {
    key.fill(0);
  }
}

// ─── passphrase from the environment ──────────────────────────────

let cachedPassphrase: string | undefined;
let passphraseRead = false;

/**
 * The owner's passphrase (AUTOMATON_WALLET_PASSPHRASE), or undefined when not
 * set. Read once: the variable is then removed from process.env so nothing
 * later in this process (tools, child processes, env dumps) sees it. Throws
 * WalletPassphraseError when it is set but too short.
 */
export function walletPassphrase(): string | undefined {
  if (!passphraseRead) {
    passphraseRead = true;
    const raw = process.env[WALLET_PASSPHRASE_ENV];
    delete process.env[WALLET_PASSPHRASE_ENV];
    cachedPassphrase = raw && raw.length > 0 ? raw : undefined;
  }
  if (cachedPassphrase !== undefined) {
    const problem = checkWalletPassphrase(cachedPassphrase);
    if (problem) throw new WalletPassphraseError(problem);
  }
  return cachedPassphrase;
}

/** Tests only: forget the cached passphrase so the env is read again. */
export function resetWalletPassphraseCacheForTests(): void {
  cachedPassphrase = undefined;
  passphraseRead = false;
}

// ─── setting ──────────────────────────────────────────────────────

export type WalletEncryptionMode = "required" | "optional";

/** A problem with config.walletEncryption, or null when valid or unset. */
export function checkWalletEncryptionSetting(config: { walletEncryption?: unknown }): string | null {
  const v = config.walletEncryption;
  if (v === undefined || v === "required" || v === "optional") return null;
  return `walletEncryption must be "required" or "optional" (got ${JSON.stringify(v)})`;
}

/** Mainnet always requires an encrypted wallet; otherwise the setting (default "optional"). */
export function walletEncryptionRequired(config: { walletEncryption?: unknown; network?: string } | null | undefined): boolean {
  if (!config) return false;
  return config.network === "mainnet" || config.walletEncryption === "required";
}
