/**
 * automaton-cli ledger show
 * automaton-cli ledger grant <amount> [--memo "..."]
 * automaton-cli ledger adjust <±amount> --memo "..."
 *
 * Owner-only view and entries for the agent's local ledger (fork change 3).
 * The logic is shared with the runtime's `--ledger` flag (pnpm agent:ledger in
 * Docker): see src/state/ledger-command.ts.
 */

import { loadConfig, resolvePath } from "@conway/automaton/config.js";
import { createDatabase } from "@conway/automaton/state/database.js";
import { runLedgerCommand } from "@conway/automaton/state/ledger-command.js";

const args = process.argv.slice(3);

const config = loadConfig();
if (!config) {
  console.log("No automaton configuration found.");
  process.exit(1);
}

const db = createDatabase(resolvePath(config.dbPath));
let result: { code: number; output: string };
try {
  result = runLedgerCommand(db.raw, args, { liveOnly: config.network === "mainnet" });
} finally {
  db.close();
}
console.log(result.output);
process.exit(result.code);
