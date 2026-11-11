/**
 * Fork Phase 1: the runtime never executes or imports code from the
 * workspace (/workspace, written by the agent in the sandbox). Skills are
 * loaded only as text: the loader reads SKILL.md and nothing else.
 *
 * 1. Static guard: no dynamic code loading anywhere in src (non-literal
 *    import()/require(), eval, new Function, vm, dlopen, createRequire,
 *    loader hooks). A new one fails this test until it is reviewed.
 * 2. Behavior: a skill folder full of code is loaded without running or
 *    reading any of it.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSkills } from "../skills/loader.js";
import type { Skill } from "../types.js";
import { tempDir } from "./sandbox/helpers.js";

const SRC = path.resolve(__dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|mts|cts|js|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const FILES = sourceFiles(SRC).map((full) => ({
  rel: path.relative(SRC, full).split(path.sep).join("/"),
  text: fs.readFileSync(full, "utf8"),
}));

function countMatches(pattern: RegExp): Record<string, number> {
  const found: Record<string, number> = {};
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  for (const { rel, text } of FILES) {
    const n = (text.match(global) ?? []).length;
    if (n > 0) found[rel] = n;
  }
  return found;
}

describe("runtime loads no code at run time (static guard)", () => {
  it("scans a real source tree", () => {
    expect(FILES.length).toBeGreaterThan(50);
  });

  it("has no import() with a computed specifier", () => {
    // Every dynamic import must be a plain string literal ("./x.js").
    expect(countMatches(/\bimport\s*\(\s*(?!["'])/)).toEqual({});
    expect(countMatches(/\bimport\s*\(\s*["'][^"']*["']\s*\+/)).toEqual({});
  });

  it("uses require() only inside the agent-card script text sent to the sandbox", () => {
    expect(countMatches(/\brequire\s*\(/)).toEqual({
      // Text of /tmp/agent-card-server.js, written with conway.writeFile and
      // run in the sandbox; the runtime never evaluates it.
      "registry/agent-card.ts": 2,
    });
  });

  it("has no eval, new Function, vm, dlopen, createRequire or loader hooks", () => {
    expect(countMatches(/\beval\s*\(/)).toEqual({});
    expect(countMatches(/\bnew\s+Function\s*\(/)).toEqual({});
    // Imports of the vm module only ("vm" is also a tool category name).
    expect(countMatches(/(from\s+|import\s*\(\s*)["'](node:)?vm["']/)).toEqual({});
    expect(countMatches(/\bprocess\.dlopen\b/)).toEqual({});
    expect(countMatches(/\bcreateRequire\b/)).toEqual({});
    expect(countMatches(/\bmodule\.register\b|\bregisterHooks\b/)).toEqual({});
  });
});

describe("skills are loaded only as text", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).__skillCanary;
  });

  function fakeDb() {
    const skills = new Map<string, Skill>();
    return {
      getSkills: (_enabledOnly?: boolean) => [...skills.values()],
      getSkillByName: (name: string) => skills.get(name),
      upsertSkill: (s: Skill) => void skills.set(s.name, s),
    } as any;
  }

  it("reads only SKILL.md from a skill folder that also contains code", () => {
    const dir = tempDir("skills-");
    const skillDir = path.join(dir, "canary");
    fs.mkdirSync(path.join(skillDir, "node_modules", "evil"), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: canary\ndescription: test skill\nauto-activate: true\n---\n# Canary\nPlain text instructions.\n",
    );
    const canary = "globalThis.__skillCanary = true;\n";
    for (const f of ["index.js", "index.mjs", "skill.ts", "setup.sh", "node_modules/evil/index.js"]) {
      fs.writeFileSync(path.join(skillDir, f), canary);
    }
    fs.writeFileSync(
      path.join(skillDir, "package.json"),
      JSON.stringify({ name: "canary", main: "index.js", scripts: { postinstall: "sh setup.sh" } }),
    );

    const readSpy = vi.spyOn(fs, "readFileSync");
    const skills = loadSkills(dir, fakeDb());

    expect(skills.map((s) => s.name)).toEqual(["canary"]);
    expect(skills[0].instructions).toContain("Plain text instructions.");
    const readsInSkillDir = readSpy.mock.calls
      .map(([p]) => String(p))
      .filter((p) => p.startsWith(skillDir));
    expect(readsInSkillDir).toEqual([path.join(skillDir, "SKILL.md")]);
    expect((globalThis as any).__skillCanary).toBeUndefined();

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
