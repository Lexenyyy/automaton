/**
 * Owner facts command (fork, run 6 follow-up H3): list or delete the agent's
 * long-term facts (semantic_memory).
 *
 * Run 6 left seven stale facts from the run 1–5 incidents (old balances,
 * tool-error counts) that the agent still recalls. The agent has no tool that
 * deletes facts, and its shell cannot reach state.db, so the owner removes them
 * here: `pnpm agent:facts` / `pnpm agent:facts:delete <category/key> ...`.
 * Deleting is refused while an agent runs (runtime lease). No model call, no
 * network, no wallet file read.
 */

import type BetterSqlite3 from "better-sqlite3";

type Database = BetterSqlite3.Database;

export interface FactsCommandResult {
  /** Process exit code: 0 ok, 1 refused/not found, 2 usage error. */
  code: number;
  output: string;
}

export const FACTS_USAGE = "Usage: facts [list | delete <category/key> [<category/key> ...]]";

interface FactRow {
  id: string;
  category: string;
  key: string;
  value: string;
  updated_at: string;
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function factsReport(db: Database): string {
  const rows = db
    .prepare("SELECT id, category, key, value, updated_at FROM semantic_memory ORDER BY category, key")
    .all() as FactRow[];
  if (rows.length === 0) return "=== FACTS (semantic_memory) ===\n(none)";
  const lines = rows.map((r) => `  ${r.category}/${r.key}  [${r.updated_at}]\n      ${oneLine(r.value, 100)}`);
  return `=== FACTS (semantic_memory): ${rows.length} ===\n${lines.join("\n")}`;
}

/** "category/key" → parts (split at the first "/"); null when malformed. */
export function parseFactRef(ref: string): { category: string; key: string } | null {
  const i = ref.indexOf("/");
  if (i <= 0 || i === ref.length - 1) return null;
  return { category: ref.slice(0, i), key: ref.slice(i + 1) };
}

/**
 * Runs one facts subcommand. `args` starts at the subcommand. `agentRunning`
 * (the runtime lease is live) refuses `delete`.
 */
export function runFactsCommand(
  db: Database,
  args: readonly string[],
  opts: { agentRunning: string | null },
): FactsCommandResult {
  const sub = args[0] ?? "list";
  if (sub === "list") return { code: 0, output: factsReport(db) };
  if (sub !== "delete") return { code: 2, output: FACTS_USAGE };

  const refs = args.slice(1);
  if (refs.length === 0) return { code: 2, output: FACTS_USAGE };
  const parsed = refs.map((r) => ({ ref: r, p: parseFactRef(r) }));
  const bad = parsed.filter((x) => !x.p).map((x) => x.ref);
  if (bad.length) return { code: 2, output: `Not in the form category/key: ${bad.join(", ")}\n${FACTS_USAGE}` };
  if (opts.agentRunning) {
    return {
      code: 1,
      output: `Refusing to delete facts while an agent is running (${opts.agentRunning}). Stop it first (pnpm agent:down).`,
    };
  }

  const find = db.prepare("SELECT id FROM semantic_memory WHERE category = ? AND key = ?");
  const missing = parsed.filter((x) => !find.get(x.p!.category, x.p!.key)).map((x) => x.ref);
  if (missing.length) {
    // All or nothing: a typo should not leave a half-done cleanup.
    return { code: 1, output: `Not found (nothing deleted): ${missing.join(", ")}\n\n${factsReport(db)}` };
  }
  const del = db.prepare("DELETE FROM semantic_memory WHERE category = ? AND key = ?");
  const deleted = db.transaction(() => parsed.reduce((n, x) => n + del.run(x.p!.category, x.p!.key).changes, 0))();
  return { code: 0, output: `Deleted ${deleted} fact(s): ${refs.join(", ")}\n\n${factsReport(db)}` };
}
