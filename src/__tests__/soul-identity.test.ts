/**
 * Fork, run 5 (F3): soul frontmatter parser and identity fields.
 *
 * The parser read an empty field's next line ("Name: address:"), and every
 * rewrite shifted the error down. Name, address and creator now come from
 * the runtime, and update_soul only accepts the agent's sections.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultSoul, parseSoulMd, writeSoulMd } from "../soul/model.js";
import { updateSoul } from "../soul/tools.js";
import { createBuiltinTools } from "../agent/tools.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";
import type { AutomatonDatabase } from "../types.js";

// The frontmatter run 5 left in state (soul v86).
const CORRUPTED = `---
format: soul/v1
version: 86
updated_at: 2026-11-17T01:28:49.860Z
name: address:
address: creator:
creator: born_at: 2026-11-16T15:12:12.685Z
born_at: 2026-11-16T15:12:12.685Z
constitution_hash: genesis_alignment: 1.0000
genesis_alignment: 1.0000
last_reflected:
---

# address:

## Core Purpose
I am a test agent.
`;

const savedHome = process.env.HOME;
let home: string;
let db: AutomatonDatabase;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "soul-identity-"));
  process.env.HOME = home;
  db = createTestDb();
});
afterEach(() => {
  db.close();
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const soulFile = () => path.join(home, ".automaton", "SOUL.md");

describe("soul frontmatter parser", () => {
  it("keeps empty fields empty across write and parse (was: took the next line)", () => {
    const soul = createDefaultSoul("Purpose.", "", "", "");
    let parsed = parseSoulMd(writeSoulMd(soul));
    for (let i = 0; i < 3; i++) parsed = parseSoulMd(writeSoulMd(parsed));
    expect(parsed.name).toBe("");
    expect(parsed.address).toBe("");
    expect(parsed.creator).toBe("");
    expect(parsed.constitutionHash).toBe("");
    expect(parsed.bornAt).toBe(soul.bornAt);
  });

  it("repairs the shifted values run 5 left behind", () => {
    const parsed = parseSoulMd(CORRUPTED);
    expect(parsed.version).toBe(86);
    expect(parsed.name).toBe("");
    expect(parsed.address).toBe("");
    expect(parsed.creator).toBe("");
    expect(parsed.bornAt).toBe("2026-11-16T15:12:12.685Z");
    expect(parsed.constitutionHash).toBe("");
    expect(parsed.genesisAlignment).toBe(1);
    expect(parsed.corePurpose).toBe("I am a test agent.");
  });
});

describe("identity fields come from the runtime", () => {
  const identity = { name: "automaton-testnet", address: "0xAbC0000000000000000000000000000000000001", creator: "0xDef0000000000000000000000000000000000002" };

  it("updateSoul writes the runtime identity, ignoring the agent's name/address/creator", async () => {
    fs.mkdirSync(path.dirname(soulFile()), { recursive: true });
    fs.writeFileSync(soulFile(), CORRUPTED);
    const r = await updateSoul(
      db.raw,
      { strategy: "Sleep when done.", name: "evil", address: "0x0", creator: "0x0" } as any,
      "agent",
      "test",
      undefined,
      identity,
    );
    expect(r.success).toBe(true);
    const text = fs.readFileSync(soulFile(), "utf-8");
    expect(text).toContain("name: automaton-testnet\n");
    expect(text).toContain(`address: ${identity.address}\n`);
    expect(text).toContain(`creator: ${identity.creator}\n`);
    expect(text).toContain("born_at: 2026-11-16T15:12:12.685Z\n");
    expect(text).toContain("# automaton-testnet\n");
    expect(text).not.toContain("evil");
  });

  it("update_soul tool: refuses identity and unknown sections, passes the runtime identity", async () => {
    const tool = createBuiltinTools("sbx").find((t) => t.name === "update_soul")!;
    const ctx = {
      identity: createTestIdentity(),
      config: createTestConfig({ name: "automaton-testnet", creatorAddress: identity.creator as any }),
      db,
      conway: new MockConwayClient(),
      inference: new MockInferenceClient(),
    } as any;
    for (const section of ["name", "address", "creator", "version", "genesisPromptOriginal"]) {
      const out = await tool.execute({ section, content: "x", reason: "test" }, ctx);
      expect(out).toMatch(/^Soul update failed: unknown section/);
    }
    expect(fs.existsSync(soulFile())).toBe(false);

    const ok = await tool.execute({ section: "strategy", content: "Sleep when done.", reason: "test" }, ctx);
    expect(ok).toMatch(/^Soul updated: strategy/);
    const parsed = parseSoulMd(fs.readFileSync(soulFile(), "utf-8"));
    expect(parsed.name).toBe("automaton-testnet");
    expect(parsed.address).toBe(ctx.identity.address);
    expect(parsed.creator).toBe(identity.creator);
  });
});
