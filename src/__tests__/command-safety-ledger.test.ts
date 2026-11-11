/**
 * Fork change 3: the agent can't write its ledger or database from the shell.
 */

import { describe, it, expect, vi } from "vitest";
import { createCommandSafetyRules, isForbiddenCommand } from "../agent/policy-rules/command-safety.js";
import { createBuiltinTools } from "../agent/tools.js";

const BLOCKED = [
  `sqlite3 ~/.automaton/state.db "INSERT INTO ledger_entries (id, occurred_at, kind, amount_cents, livemode, source) VALUES ('x','2026-01-01','owner_grant',100000,1,'owner_cli')"`,
  `sqlite3 /root/.automaton/state.db .dump`,
  `sqlite /root/.automaton/state.db`,
  `python3 -c "import sqlite3; sqlite3.connect('/root/.automaton/state.db').execute('select 1')"`,
  `node -e "require('better-sqlite3')('state.db').exec('DROP TRIGGER ledger_no_update')"`,
  `echo "SELECT * FROM ledger_entries" | sqlite3 db.sqlite`,
  `cp ~/.automaton/state.db /tmp/x.db`,
];

const ALLOWED = ["sqlite3 /root/app/data.db .tables", "echo hello", "ls ~/.automaton"];

describe("shell access to the ledger and agent database is blocked", () => {
  const rule = createCommandSafetyRules().find((r) => r.id === "command.forbidden_patterns")!;

  for (const command of BLOCKED) {
    it(`blocks: ${command.slice(0, 70)}`, () => {
      expect(isForbiddenCommand(command)).toBe(true);
      expect(rule.evaluate({ tool: { name: "exec" }, args: { command } } as any)?.action).toBe("deny");
    });
  }

  for (const command of ALLOWED) {
    it(`allows: ${command}`, () => {
      expect(isForbiddenCommand(command)).toBe(false);
    });
  }

  it("exec tool itself refuses (inline guard)", async () => {
    const exec = createBuiltinTools("sandbox").find((t) => t.name === "exec")!;
    const conway = { exec: vi.fn() };
    const out = await exec.execute({ command: BLOCKED[0] }, { conway, identity: { sandboxId: "sandbox" } } as any);
    expect(out).toMatch(/Blocked/);
    expect(conway.exec).not.toHaveBeenCalled();
  });
});
