/**
 * Balance Source (fork change 3)
 *
 * Where the agent's survival balance comes from.
 *
 *   "own" (default):  wallet USDC on the active network (read live)
 *                     + local ledger (off-chain money: grants, inference costs,
 *                       later Stripe). On-chain money is never also in the
 *                       ledger, so nothing is counted twice.
 *   "conway":         Conway compute credits (upstream behavior, for Conway Cloud).
 *
 * A failed wallet read is never treated as 0. It falls back to the last good
 * value for the same network ("cached"), or reports "unavailable" so callers
 * keep the current tier instead of sliding toward critical/dead.
 */

import type BetterSqlite3 from "better-sqlite3";
import type { Address } from "viem";
import type { AutomatonConfig, ConwayClient, FinancialState } from "../types.js";
import { getUsdcBalance, getUsdcBalanceDetailed } from "../conway/x402.js";
import { getActiveNetwork } from "../identity/network.js";
import { getLedgerBalanceCents } from "../state/ledger.js";
import { createLogger } from "../observability/logger.js";

type Database = BetterSqlite3.Database;
const logger = createLogger("survival.balance");

export type BalanceStatus = "live" | "cached" | "unavailable";
export type BalanceSourceKind = "own" | "conway";

export interface BalanceSnapshot {
  kind: BalanceSourceKind;
  /** Total used for survival tiers (USD cents). Not meaningful when status is "unavailable". */
  balanceCents: number;
  /** Wallet USDC in cents (rounded down), or null when unknown. */
  walletUsdcCents: number | null;
  /** Ledger balance in cents (0 for the Conway source). */
  ledgerCents: number;
  /** Wallet USDC in dollars, for display (0 when unknown). */
  usdcBalance: number;
  status: BalanceStatus;
  network: string;
  checkedAt: string;
}

export interface BalanceSource {
  readonly kind: BalanceSourceKind;
  read(): Promise<BalanceSnapshot>;
}

export type WalletReader = (address: string, chainType?: string) => Promise<number>;

/** USDC dollars → whole cents, rounded down so the balance is never overstated. */
export function usdcToCents(usdc: number): number {
  return Math.floor(usdc * 100 + 1e-6);
}

function getKv(db: Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

function setKv(db: Database, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(key, value);
}

/** Planner context and older code read this key; keep it current. */
function writeLegacyBalanceCache(db: Database, s: BalanceSnapshot): void {
  if (s.status === "unavailable") return;
  setKv(db, "last_known_balance", JSON.stringify({ creditsCents: s.balanceCents, usdcBalance: s.usdcBalance }));
}

const defaultWalletReader: WalletReader = async (address, chainType) => {
  if (chainType === "solana") {
    return getUsdcBalance(address, "solana:mainnet", "solana"); // throws on failure
  }
  const result = await getUsdcBalanceDetailed(address as Address, getActiveNetwork().caip2);
  if (!result.ok) throw new Error(result.error || "USDC balance read failed");
  return result.balance;
};

export class OwnBalanceSource implements BalanceSource {
  readonly kind = "own" as const;

  constructor(
    private readonly db: Database,
    private readonly address: string,
    private readonly chainType?: string,
    private readonly readWallet: WalletReader = defaultWalletReader,
  ) {}

  async read(): Promise<BalanceSnapshot> {
    const network = getActiveNetwork();
    const networkKey = this.chainType === "solana" ? "solana:mainnet" : network.caip2;
    const networkLabel = this.chainType === "solana" ? "Solana" : network.label;
    // Mainnet counts only real money; testnet also counts test money (e.g. Stripe test mode).
    const ledgerCents = getLedgerBalanceCents(this.db, { liveOnly: network.mode === "mainnet" });
    // Cache per network AND wallet: a value is never reused for another chain or address.
    const cacheKey = `wallet_usdc_cache:${networkKey}:${this.address.toLowerCase()}`;

    let usdc: number | null = null;
    let status: BalanceStatus = "live";
    try {
      usdc = await this.readWallet(this.address, this.chainType);
      setKv(this.db, cacheKey, JSON.stringify({ usdc, at: new Date().toISOString() }));
    } catch (err: any) {
      const cached = getKv(this.db, cacheKey);
      if (cached) {
        try {
          usdc = Number(JSON.parse(cached).usdc);
          status = Number.isFinite(usdc) ? "cached" : "unavailable";
          if (status === "unavailable") usdc = null;
        } catch {
          usdc = null;
          status = "unavailable";
        }
      } else {
        status = "unavailable";
      }
      logger.warn(`Wallet balance read failed (${status}): ${err?.message || String(err)}`);
    }

    const walletUsdcCents = usdc === null ? null : usdcToCents(usdc);
    const snapshot: BalanceSnapshot = {
      kind: "own",
      balanceCents: ledgerCents + (walletUsdcCents ?? 0),
      walletUsdcCents,
      ledgerCents,
      usdcBalance: usdc ?? 0,
      status,
      network: networkLabel,
      checkedAt: new Date().toISOString(),
    };
    writeLegacyBalanceCache(this.db, snapshot);
    return snapshot;
  }
}

/** Upstream behavior: Conway compute credits are the survival balance. */
export class ConwayBalanceSource implements BalanceSource {
  readonly kind = "conway" as const;

  constructor(
    private readonly db: Database,
    private readonly conway: ConwayClient,
    private readonly address: string,
    private readonly chainType?: string,
  ) {}

  async read(): Promise<BalanceSnapshot> {
    const network = this.chainType === "solana" ? "Solana" : getActiveNetwork().label;
    let usdc = 0;
    try {
      const net = this.chainType === "solana" ? "solana:mainnet" : getActiveNetwork().caip2;
      usdc = await getUsdcBalance(this.address, net, this.chainType as any);
    } catch {
      // display only
    }

    try {
      const credits = await this.conway.getCreditsBalance();
      const snapshot: BalanceSnapshot = {
        kind: "conway", balanceCents: credits, walletUsdcCents: usdcToCents(usdc), ledgerCents: 0,
        usdcBalance: usdc, status: "live", network, checkedAt: new Date().toISOString(),
      };
      writeLegacyBalanceCache(this.db, snapshot);
      return snapshot;
    } catch (err: any) {
      logger.warn(`Conway credits read failed: ${err?.message || String(err)}`);
      const cached = getKv(this.db, "last_known_balance");
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (typeof parsed.creditsCents === "number") {
            return {
              kind: "conway", balanceCents: parsed.creditsCents, walletUsdcCents: usdcToCents(usdc), ledgerCents: 0,
              usdcBalance: usdc, status: "cached", network, checkedAt: new Date().toISOString(),
            };
          }
        } catch {
          // fall through
        }
      }
      return {
        kind: "conway", balanceCents: 0, walletUsdcCents: usdcToCents(usdc), ledgerCents: 0,
        usdcBalance: usdc, status: "unavailable", network, checkedAt: new Date().toISOString(),
      };
    }
  }
}

export function createBalanceSource(params: {
  config: Pick<AutomatonConfig, "balanceSource">;
  db: Database;
  conway: ConwayClient;
  address: string;
  chainType?: string;
}): BalanceSource {
  return params.config.balanceSource === "conway"
    ? new ConwayBalanceSource(params.db, params.conway, params.address, params.chainType)
    : new OwnBalanceSource(params.db, params.address, params.chainType);
}

export function toFinancialState(s: BalanceSnapshot): FinancialState {
  return {
    creditsCents: s.balanceCents, // deprecated alias: now the total survival balance
    usdcBalance: s.usdcBalance,
    lastChecked: s.checkedAt,
    balanceCents: s.balanceCents,
    walletUsdcCents: s.walletUsdcCents,
    ledgerCents: s.ledgerCents,
    balanceStatus: s.status,
    balanceSource: s.kind,
    network: s.network,
  };
}

/** One-line human summary, for tools, logs and prompts. */
export function formatBalance(s: Pick<FinancialState, "balanceCents" | "creditsCents" | "walletUsdcCents" | "ledgerCents" | "balanceStatus" | "balanceSource" | "network">): string {
  const usd = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;
  const total = s.balanceCents ?? s.creditsCents;
  if (s.balanceSource === "conway") return `${usd(total)} Conway credits`;
  const wallet = s.walletUsdcCents === null || s.walletUsdcCents === undefined ? "unknown" : usd(s.walletUsdcCents);
  const status = s.balanceStatus && s.balanceStatus !== "live" ? ` [${s.balanceStatus}]` : "";
  return `${usd(total)} (wallet ${wallet} USDC on ${s.network ?? "?"} + ledger ${usd(s.ledgerCents ?? 0)})${status}`;
}
