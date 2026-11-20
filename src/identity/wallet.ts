/**
 * Automaton Wallet Management
 *
 * Creates and manages wallets for the automaton's identity and payments.
 * Supports both EVM (secp256k1/viem) and Solana (Ed25519/tweetnacl) wallets.
 * The private key is the automaton's sovereign identity.
 * Chain type is chosen at genesis and never changes.
 */

import type { PrivateKeyAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import nacl from "tweetnacl";
import bs58 from "bs58";
import fs from "fs";
import path from "path";
import type { WalletData } from "../types.js";
import type { ChainType } from "./chain.js";
import { EvmChainIdentity, SolanaChainIdentity } from "./chain.js";
import type { ChainIdentity } from "./chain.js";
import {
  WALLET_PASSPHRASE_ENV,
  WalletPassphraseError,
  decryptWalletFile,
  encryptWalletData,
  isEncryptedWalletFile,
  walletPassphrase,
  type EncryptedWalletFile,
} from "./wallet-crypto.js";

/**
 * Create a stub PrivateKeyAccount for Solana wallets.
 * The stub has the Solana address but throws on any EVM signing attempt,
 * preventing accidental use of a random key.
 */
function createSolanaStubAccount(solanaAddress: string): PrivateKeyAccount {
  const throwSigning = () => {
    throw new Error(
      "Cannot use EVM signing methods on a Solana wallet. Use chainIdentity instead.",
    );
  };
  return {
    address: solanaAddress as any,
    publicKey: "0x" as any,
    source: "custom",
    type: "local",
    signMessage: throwSigning as any,
    signTypedData: throwSigning as any,
    signTransaction: throwSigning as any,
    sign: throwSigning as any,
  } as unknown as PrivateKeyAccount;
}

const AUTOMATON_DIR = path.join(
  process.env.HOME || "/root",
  ".automaton",
);
const WALLET_FILE = path.join(AUTOMATON_DIR, "wallet.json");

export function getAutomatonDir(): string {
  return AUTOMATON_DIR;
}

export function getWalletPath(): string {
  return WALLET_FILE;
}

/**
 * Generate a Solana Ed25519 keypair.
 * Returns the 64-byte secret key (first 32 = private, last 32 = public).
 */
export function generateSolanaKeypair(): { secretKey: Uint8Array; publicKey: Uint8Array; address: string } {
  const keypair = nacl.sign.keyPair();
  return {
    secretKey: keypair.secretKey,
    publicKey: keypair.publicKey,
    address: bs58.encode(keypair.publicKey),
  };
}

// ─── file access (fork, Phase 3 step 1: encryption at rest) ─────────

type RawWalletFile = WalletData | EncryptedWalletFile;

function readRawWalletFile(): RawWalletFile {
  const raw = JSON.parse(fs.readFileSync(WALLET_FILE, "utf-8")) as RawWalletFile & { version?: unknown };
  if (raw && typeof raw === "object" && "version" in raw && raw.version !== undefined && !isEncryptedWalletFile(raw)) {
    throw new Error(`Unknown wallet file version ${JSON.stringify(raw.version)}; refusing to use it.`);
  }
  return raw;
}

/**
 * The wallet's key material, decrypting with the owner's passphrase when the
 * file is encrypted. Throws when it is encrypted and no passphrase is set.
 */
function readWalletData(): { data: WalletData; encrypted: boolean } {
  const raw = readRawWalletFile();
  if (!isEncryptedWalletFile(raw)) return { data: raw, encrypted: false };
  const passphrase = walletPassphrase();
  if (!passphrase) {
    throw new WalletPassphraseError(
      `The wallet is encrypted but no passphrase is set (secrets file wallet_passphrase, env ${WALLET_PASSPHRASE_ENV}).`,
    );
  }
  return { data: decryptWalletFile(raw, passphrase), encrypted: true };
}

/** Writes the wallet file atomically (temp file in the same folder, then rename), mode 0600. */
function writeWalletFile(content: RawWalletFile): void {
  const tmp = `${WALLET_FILE}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(content, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, WALLET_FILE);
}

function addressOf(data: WalletData): string {
  if ((data.chainType || "evm") === "solana") {
    const keypair = nacl.sign.keyPair.fromSecretKey(bs58.decode(data.secretKey!));
    return bs58.encode(keypair.publicKey);
  }
  return privateKeyToAccount(data.privateKey!).address;
}

/** New wallets are encrypted when a passphrase is set; refused without one when required. */
function storeNewWallet(data: WalletData, address: string, requireEncryption: boolean): void {
  const passphrase = walletPassphrase();
  if (!passphrase && requireEncryption) {
    throw new WalletPassphraseError(
      `Refusing to create an unencrypted wallet: walletEncryption is "required" (or mainnet) and no passphrase is set ` +
        `(secrets file wallet_passphrase, env ${WALLET_PASSPHRASE_ENV}).`,
    );
  }
  writeWalletFile(passphrase ? encryptWalletData(data, address, passphrase) : data);
}

export interface WalletOptions {
  /**
   * Fork: refuse a plaintext wallet (existing or new). Set from
   * config.walletEncryption "required" or mainnet (walletEncryptionRequired).
   */
  requireEncryption?: boolean;
}

/**
 * Get or create the automaton's wallet.
 * The private key IS the automaton's identity -- protect it.
 *
 * @param chainType - If creating a new wallet, which chain to use. Defaults to "evm".
 */
export async function getWallet(chainType?: ChainType, opts: WalletOptions = {}): Promise<{
  account: PrivateKeyAccount;
  chainIdentity: ChainIdentity;
  chainType: ChainType;
  isNew: boolean;
  /** Fork: whether wallet.json is encrypted at rest. */
  encrypted: boolean;
}> {
  if (!fs.existsSync(AUTOMATON_DIR)) {
    fs.mkdirSync(AUTOMATON_DIR, { recursive: true, mode: 0o700 });
  }
  // Fork: read the passphrase now in every case, so it leaves process.env at
  // startup even when the wallet is plaintext and never needs it.
  walletPassphrase();

  if (fs.existsSync(WALLET_FILE)) {
    const { data: walletData, encrypted } = readWalletData();
    if (!encrypted && opts.requireEncryption) {
      throw new WalletPassphraseError(
        "The wallet is not encrypted, and walletEncryption is \"required\" (or mainnet). " +
          "Encrypt it first: pnpm agent:wallet:encrypt (automaton --wallet encrypt).",
      );
    }
    const resolvedChainType = walletData.chainType || "evm";

    if (resolvedChainType === "solana" && walletData.secretKey) {
      const secretKey = bs58.decode(walletData.secretKey);
      const solanaIdentity = new SolanaChainIdentity(secretKey);
      const account = createSolanaStubAccount(solanaIdentity.address);
      return { account, chainIdentity: solanaIdentity, chainType: "solana", isNew: false, encrypted };
    }

    // EVM path (default)
    const account = privateKeyToAccount(walletData.privateKey!);
    return { account, chainIdentity: new EvmChainIdentity(account), chainType: "evm", isNew: false, encrypted };
  }

  // Create new wallet
  const resolvedChain = chainType || "evm";
  const encrypted = walletPassphrase() !== undefined;

  if (resolvedChain === "solana") {
    const { secretKey, address } = generateSolanaKeypair();
    const solanaIdentity = new SolanaChainIdentity(secretKey);

    const walletData: WalletData = {
      chainType: "solana",
      secretKey: bs58.encode(secretKey),
      createdAt: new Date().toISOString(),
    };

    storeNewWallet(walletData, address, opts.requireEncryption === true);

    const account = createSolanaStubAccount(address);
    return { account, chainIdentity: solanaIdentity, chainType: "solana", isNew: true, encrypted };
  }

  // EVM wallet
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  const walletData: WalletData = {
    chainType: "evm",
    privateKey,
    createdAt: new Date().toISOString(),
  };

  storeNewWallet(walletData, account.address, opts.requireEncryption === true);

  return { account, chainIdentity: new EvmChainIdentity(account), chainType: "evm", isNew: true, encrypted };
}

/**
 * Get the wallet address without loading the full account. An encrypted file
 * keeps the address in clear, so no passphrase is needed.
 */
export function getWalletAddress(): string | null {
  if (!fs.existsSync(WALLET_FILE)) {
    return null;
  }
  const raw = readRawWalletFile();
  return isEncryptedWalletFile(raw) ? raw.address : addressOf(raw);
}

/**
 * Load the full wallet account (needed for signing).
 * For Solana wallets, returns a proxy account.
 */
export function loadWalletAccount(): PrivateKeyAccount | null {
  if (!fs.existsSync(WALLET_FILE)) {
    return null;
  }

  const { data: walletData } = readWalletData();

  if (walletData.chainType === "solana") {
    // Solana wallets don't have a PrivateKeyAccount; callers should use getWallet() instead
    return null;
  }

  return privateKeyToAccount(walletData.privateKey!);
}

/**
 * Get the chain type from the wallet file.
 */
export function getWalletChainType(): ChainType {
  if (!fs.existsSync(WALLET_FILE)) {
    return "evm";
  }
  try {
    const raw = readRawWalletFile();
    return raw.chainType || "evm";
  } catch {
    return "evm";
  }
}

/** Fork: what the owner may see about the wallet (never key material; no passphrase needed). */
export interface WalletInfo {
  exists: boolean;
  encrypted: boolean;
  address: string | null;
  chainType: ChainType;
  createdAt: string | null;
  /** scrypt cost of an encrypted file, e.g. "scrypt N=32768 r=8 p=1". */
  kdf: string | null;
}

export function walletInfo(): WalletInfo {
  if (!fs.existsSync(WALLET_FILE)) {
    return { exists: false, encrypted: false, address: null, chainType: "evm", createdAt: null, kdf: null };
  }
  const raw = readRawWalletFile();
  if (isEncryptedWalletFile(raw)) {
    return {
      exists: true, encrypted: true, address: raw.address, chainType: raw.chainType, createdAt: raw.createdAt,
      kdf: `scrypt N=${raw.kdf.N} r=${raw.kdf.r} p=${raw.kdf.p}, aes-256-gcm`,
    };
  }
  return { exists: true, encrypted: false, address: addressOf(raw), chainType: raw.chainType || "evm", createdAt: raw.createdAt ?? null, kdf: null };
}

/**
 * Fork (owner command `--wallet encrypt`): encrypts an existing plaintext
 * wallet in place with the owner's passphrase. Checks the result decrypts to
 * the same address before replacing the file (atomic rename). No plaintext
 * copy is kept.
 */
export function encryptExistingWallet(): { status: "encrypted" | "already" | "missing"; address?: string } {
  if (!fs.existsSync(WALLET_FILE)) return { status: "missing" };
  const raw = readRawWalletFile();
  if (isEncryptedWalletFile(raw)) return { status: "already", address: raw.address };
  const passphrase = walletPassphrase();
  if (!passphrase) {
    throw new WalletPassphraseError(
      `No passphrase set: create the secrets file wallet_passphrase first (env ${WALLET_PASSPHRASE_ENV}).`,
    );
  }
  const address = addressOf(raw);
  const enc = encryptWalletData(raw, address, passphrase);
  const back = decryptWalletFile(enc, passphrase);
  if (addressOf(back) !== address) throw new Error("Encryption check failed (address mismatch); wallet left unchanged.");
  writeWalletFile(enc);
  return { status: "encrypted", address };
}

export function walletExists(): boolean {
  return fs.existsSync(WALLET_FILE);
}
