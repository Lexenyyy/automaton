declare module "@conway/automaton/config.js" {
  export interface AutomatonCliConfig {
    name: string;
    walletAddress: string;
    creatorAddress: string;
    sandboxId: string;
    dbPath: string;
    inferenceModel: string;
    conwayApiUrl: string;
    conwayApiKey: string;
    openaiApiKey?: string;
    anthropicApiKey?: string;
    socialRelayUrl?: string;
    network?: "testnet" | "mainnet";
  }

  export function loadConfig(): AutomatonCliConfig | null;
  export function resolvePath(p: string): string;
}

declare module "@conway/automaton/state/database.js" {
  export interface CliToolCall {
    name: string;
    result: string;
    error?: string;
  }

  export interface CliTurn {
    id: string;
    timestamp: string;
    state: string;
    input?: string;
    inputSource?: string;
    thinking: string;
    toolCalls: CliToolCall[];
    tokenUsage: { totalTokens: number };
    costCents: number;
  }

  export interface CliHeartbeatEntry {
    enabled: boolean;
  }

  export interface CliInstalledTool {
    id: string;
    name: string;
  }

  export interface AutomatonCliDatabase {
    getAgentState(): string;
    getTurnCount(): number;
    getInstalledTools(): CliInstalledTool[];
    getHeartbeatEntries(): CliHeartbeatEntry[];
    getRecentTurns(limit: number): CliTurn[];
    close(): void;
    /** Underlying better-sqlite3 handle (opaque to the CLI). */
    raw: unknown;
  }

  export function createDatabase(path: string): AutomatonCliDatabase;
}

declare module "@conway/automaton/state/ledger.js" {
  export type LedgerKind =
    | "owner_grant" | "owner_withdrawal" | "inference_cost" | "hosting_cost"
    | "stripe_revenue" | "stripe_fee" | "stripe_refund" | "adjustment";

  export interface LedgerEntryInput {
    kind: LedgerKind;
    amountCents: number;
    livemode: boolean;
    source: string;
    externalId?: string | null;
    memo?: string;
    currency?: string;
    occurredAt?: string;
  }

  export interface LedgerEntry {
    id: string;
    occurredAt: string;
    recordedAt: string;
    kind: LedgerKind;
    amountCents: number;
    currency: string;
    livemode: boolean;
    source: string;
    externalId: string | null;
    memo: string;
  }

  export function insertLedgerEntry(db: unknown, entry: LedgerEntryInput): boolean;
  export function getLedgerBalanceCents(db: unknown, opts: { liveOnly: boolean }): number;
  export function getUncountedCurrencyCount(db: unknown): number;
  export function getLifetimeInferenceCostCents(db: unknown): number;
  export function getLedgerTotalsByKind(db: unknown): { kind: LedgerKind; totalCents: number; count: number }[];
  export function getRecentLedgerEntries(db: unknown, limit?: number): LedgerEntry[];
}
