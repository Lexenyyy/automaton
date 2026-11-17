/**
 * Fork, run 5 (F4): owner soul reset (`--soul reset`, pnpm agent:soul:reset).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSoulDefaults, resetSoul, soulIdentityFromDb, soulReport } from "../soul/reset.js";
import { parseSoulMd } from "../soul/model.js";
import { updateSoul } from "../soul/tools.js";
import { createTestConfig, createTestDb } from "./mocks.js";
import type { AutomatonDatabase } from "../types.js";

const identity = { name: "automaton-testnet", address: "0xAbC0000000000000000000000000000000000001", creator: "0xDef0000000000000000000000000000000000002" };
let dir: string;
let soulPath: string;
let db: AutomatonDatabase;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-reset-"));
  soulPath = path.join(dir, "SOUL.md");
  db = createTestDb();
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const settings = {
  defaultCorePurpose: "I am a test agent. Each wake I read my status, note anything new, and sleep.",
  defaultValues: ["Follow my genesis prompt", "Spend as little as possible"],
};

describe("owner soul reset", () => {
  it("replaces the agent's soul with the owner's settings as the next version; history kept", async () => {
    await updateSoul(db.raw, { corePurpose: "Old purpose: update my SOUL.md and note my tools.", strategy: "Build things." }, "agent", "old", soulPath);
    await updateSoul(db.raw, { strategy: "Build more things." }, "agent", "old 2", soulPath);

    const config = createTestConfig({ soulConfig: { ...createTestConfig().soulConfig!, ...settings } as any });
    const r = resetSoul(db.raw, config, identity, soulPath);
    // The first agent write is version 2 (upstream: the implicit default soul is 1).
    expect(r).toEqual({ success: true, version: 4 });

    const soul = parseSoulMd(fs.readFileSync(soulPath, "utf-8"));
    expect(soul.version).toBe(4);
    expect(soul.corePurpose).toBe(settings.defaultCorePurpose);
    expect(soul.values).toEqual(settings.defaultValues);
    expect(soul.strategy).toBe("");
    expect(soul.name).toBe(identity.name);
    expect(soul.address).toBe(identity.address);
    expect(soul.creator).toBe(identity.creator);

    const rows = db.raw.prepare("SELECT version, change_source, change_reason, approved_by FROM soul_history ORDER BY version").all();
    expect(rows).toEqual([
      { version: 2, change_source: "agent", change_reason: "old", approved_by: null },
      { version: 3, change_source: "agent", change_reason: "old 2", approved_by: null },
      { version: 4, change_source: "human", change_reason: "owner reset (agent:soul:reset)", approved_by: "owner" },
    ]);
  });

  it("without settings: the genesis prompt as purpose and the upstream values", () => {
    const config = createTestConfig({ genesisPrompt: "Test genesis prompt." });
    const r = resetSoul(db.raw, config, identity, soulPath);
    expect(r.success).toBe(true);
    const soul = parseSoulMd(fs.readFileSync(soulPath, "utf-8"));
    expect(soul.corePurpose).toBe("Test genesis prompt.");
    expect(soul.values).toHaveLength(4);
  });

  it("refuses invalid settings (startup refuses them too)", () => {
    expect(checkSoulDefaults({})).toEqual([]);
    expect(checkSoulDefaults({ soulConfig: settings as any })).toEqual([]);
    expect(checkSoulDefaults({ soulConfig: { defaultCorePurpose: " " } as any })).toHaveLength(1);
    expect(checkSoulDefaults({ soulConfig: { defaultValues: [] } as any })).toHaveLength(1);
    expect(checkSoulDefaults({ soulConfig: { defaultValues: ["ok", 3] } as any })).toHaveLength(1);
    const r = resetSoul(db.raw, createTestConfig({ soulConfig: { defaultValues: [] } as any }), identity, soulPath);
    expect(r.success).toBe(false);
    expect(fs.existsSync(soulPath)).toBe(false);
  });

  it("identity from the config and the identity table (no wallet file)", () => {
    db.setIdentity("address", identity.address);
    db.setIdentity("creator", "0xFromDb0000000000000000000000000000000003");
    const config = createTestConfig({ name: "automaton-testnet", creatorAddress: "" as any });
    expect(soulIdentityFromDb(db.raw, config)).toEqual({
      name: "automaton-testnet",
      address: identity.address,
      creator: "0xFromDb0000000000000000000000000000000003",
    });
  });

  it("owner report shows identity, purpose and values", () => {
    expect(soulReport(db.raw, soulPath)).toBe("No soul yet (SOUL.md does not exist).");
    resetSoul(db.raw, createTestConfig({ soulConfig: settings as any }), identity, soulPath);
    const text = soulReport(db.raw, soulPath);
    expect(text).toContain("Soul version 1");
    expect(text).toContain("last change: human, owner reset (agent:soul:reset)");
    expect(text).toContain(`Name: automaton-testnet   Address: ${identity.address}`);
    expect(text).toContain("  - Spend as little as possible");
  });
});
