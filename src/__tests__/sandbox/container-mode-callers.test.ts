/**
 * Fork Phase 1, sandbox step 2: runtime call sites that used to start
 * processes or touch the runtime filesystem outside the conway.exec choke
 * point. In container mode none of them may start a process in the runtime,
 * and no sandbox error may lead to a local retry.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    execFileSync: vi.fn((...args: unknown[]) => (actual.execFileSync as any)(...args)),
  };
});

import { execFileSync } from "child_process";
import { GeneralHarness } from "../../agent/harnesses/general-harness.js";
import type { HarnessContext } from "../../agent/harness-types.js";
import { AgentWorkspace } from "../../orchestration/workspace.js";
import { isOnPath, loadSkills } from "../../skills/loader.js";
import { installSkillFromGit, installSkillFromUrl } from "../../skills/registry.js";
import { getRepoInfo, checkUpstream, getUpstreamDiffs } from "../../self-mod/upstream.js";
import { resetSandboxModeForTests, isContainerSandboxActive } from "../../sandbox/mode.js";
import { workerEditRoot } from "../../sandbox/transport.js";
import { shellCommand } from "../../sandbox/protocol.js";
import { createConwayClient } from "../../conway/client.js";
import type { ConwayClient, Skill } from "../../types.js";
import { createInMemoryDb } from "../orchestration/test-db.js";
import { createTestConfig, createTestIdentity, MockConwayClient } from "../mocks.js";
import { tempDir } from "./helpers.js";

afterEach(() => {
  vi.mocked(execFileSync).mockClear();
  resetSandboxModeForTests();
});

function fakeSkillDb() {
  const skills = new Map<string, Skill>();
  return {
    getSkills: () => [...skills.values()],
    getSkillByName: (name: string) => skills.get(name),
    upsertSkill: (s: Skill) => void skills.set(s.name, s),
  } as any;
}

describe("general harness: no local fallback", () => {
  it("reports sandbox errors for exec, write_file and read_file and touches nothing locally", async () => {
    const root = tempDir("general-nofallback-");
    const db = createInMemoryDb();
    const conway = new MockConwayClient();
    const fail = async () => {
      throw new Error("sandbox down");
    };
    conway.exec = fail as any;
    conway.writeFile = fail as any;
    conway.readFile = fail as any;

    const harness = new GeneralHarness();
    const workspace = new AgentWorkspace("goal-x", path.join(root, "ws"));
    const context: HarnessContext = {
      workspaceRoot: workspace.basePath,
      allowedEditRoot: root,
      workspace,
      identity: createTestIdentity(),
      config: createTestConfig(),
      db,
      conway,
      inference: { chat: async () => ({ content: "done" }) },
      budget: { maxTurns: 5, maxCostCents: 50, timeoutMs: 5_000, turnsUsed: 0, costUsedCents: 0, startedAt: 0 },
      wisdom: { conventions: [], successes: [], failures: [], gotchas: [] },
      abortSignal: new AbortController().signal,
      goalId: "goal-x",
      toolCatalog: [],
    };
    await harness.initialize(
      {
        id: "t1", parentId: null, goalId: "goal-x", title: "t", description: "d", status: "assigned",
        assignedTo: "local://w", agentRole: "generalist", priority: 50, dependencies: [], result: null,
        metadata: { estimatedCostCents: 1, actualCostCents: 0, maxRetries: 0, retryCount: 0, timeoutMs: 5_000,
          createdAt: new Date().toISOString(), startedAt: null, completedAt: null },
      },
      context,
    );
    const run = (name: string, args: Record<string, unknown>) =>
      harness.getToolDefs().find((t) => t.name === name)!.execute(args);

    const existing = path.join(root, "keep.txt");
    fs.writeFileSync(existing, "local content");

    expect(await run("exec", { command: "echo hi" })).toBe("exec error: sandbox down");
    expect(await run("write_file", { path: path.join(root, "new.txt"), content: "x" })).toBe("write error: sandbox down");
    expect(await run("read_file", { path: existing })).toBe("read error: sandbox down");
    expect(fs.existsSync(path.join(root, "new.txt"))).toBe(false);

    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("skills loader requirements", () => {
  function skillWithRequirements(dir: string) {
    const skillDir = path.join(dir, "needs-tools");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: needs-tools\ndescription: d\nrequires:\n  bins: [definitely-not-a-real-binary-xyz]\n  env: [SKILL_TEST_UNSET_VAR]\n---\nText.\n",
    );
  }

  it("local mode: a missing binary or env var skips the skill, without starting a process", () => {
    const dir = tempDir("skills-req-");
    skillWithRequirements(dir);
    expect(loadSkills(dir, fakeSkillDb()).map((s) => s.name)).toEqual([]);
    expect(execFileSync).not.toHaveBeenCalled();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("container mode: requirements describe the sandbox and are not checked in the runtime", () => {
    const dir = tempDir("skills-req-");
    skillWithRequirements(dir);
    expect(loadSkills(dir, fakeSkillDb(), { containerSandbox: true }).map((s) => s.name)).toEqual(["needs-tools"]);
    expect(execFileSync).not.toHaveBeenCalled();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("isOnPath finds executables without a process and rejects unsafe names", () => {
    const dir = tempDir("bin-");
    const bin = process.platform === "win32" ? "tool.EXE" : "tool";
    fs.writeFileSync(path.join(dir, bin), "");
    fs.chmodSync(path.join(dir, bin), 0o755);
    expect(isOnPath("tool", dir)).toBe(true);
    expect(isOnPath("missing", dir)).toBe(false);
    expect(isOnPath("../tool", dir)).toBe(false);
    expect(isOnPath("tool", "relative/dir")).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("skills registry in container mode", () => {
  function recordingConway(exitCode = 0) {
    const commands: string[] = [];
    const reads: string[] = [];
    const conway = {
      exec: async (command: string) => {
        commands.push(command);
        return { stdout: "", stderr: exitCode ? "fatal: no network" : "", exitCode };
      },
      readFile: async (p: string) => {
        reads.push(p);
        return "---\nname: remote-skill\ndescription: d\n---\nRemote text.\n";
      },
    } as unknown as ConwayClient;
    return { conway, commands, reads };
  }

  it("quotes every argument of a sandbox command", () => {
    expect(shellCommand(["echo", "a b", "it's", "$(id)"])).toBe(`'echo' 'a b' 'it'\\''s' '$(id)'`);
  });

  it("clones in the sandbox with -- before the URL and reads SKILL.md back as text", async () => {
    const { conway, commands, reads } = recordingConway();
    const skillsDir = "/workspace/skills";
    const skill = await installSkillFromGit("https://example.com/r.git", "remote-skill", skillsDir, fakeSkillDb(), conway, {
      containerSandbox: true,
    });
    const target = path.resolve(skillsDir, "remote-skill");
    expect(commands).toEqual([`'git' 'clone' '--depth' '1' '--' 'https://example.com/r.git' '${target}'`]);
    expect(reads).toEqual([path.join(target, "SKILL.md")]);
    expect(skill?.instructions).toContain("Remote text.");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("fetches a URL skill in the sandbox with --url", async () => {
    const { conway, commands } = recordingConway();
    await installSkillFromUrl("https://example.com/SKILL.md", "remote-skill", "/workspace/skills", fakeSkillDb(), conway, {
      containerSandbox: true,
    });
    const target = path.resolve("/workspace/skills", "remote-skill");
    expect(commands).toEqual([
      `'mkdir' '-p' '--' '${target}'`,
      `'curl' '-fsSL' '-o' '${path.join(target, "SKILL.md")}' '--url' 'https://example.com/SKILL.md'`,
    ]);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("reports a sandbox failure (e.g. no network) as an error", async () => {
    const { conway } = recordingConway(128);
    await expect(
      installSkillFromGit("https://example.com/r.git", "remote-skill", "/workspace/skills", fakeSkillDb(), conway, {
        containerSandbox: true,
      }),
    ).rejects.toThrow(/Failed to clone skill repo: fatal: no network/);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("still validates names and URLs first", async () => {
    const { conway, commands } = recordingConway();
    await expect(
      installSkillFromGit("https://x.com/r.git; rm -rf /", "a", "/workspace/skills", fakeSkillDb(), conway, { containerSandbox: true }),
    ).rejects.toThrow(/Invalid repo URL/);
    await expect(
      installSkillFromUrl("https://x.com/S.md", "../evil", "/workspace/skills", fakeSkillDb(), conway, { containerSandbox: true }),
    ).rejects.toThrow(/Invalid skill name/);
    expect(commands).toEqual([]);
  });
});

describe("self-mod upstream in container mode", () => {
  it("creating a container-mode client switches the runtime into container mode", () => {
    expect(isContainerSandboxActive()).toBe(false);
    createConwayClient({ apiUrl: "http://x", apiKey: "k", sandboxId: "", sandbox: { mode: "container" } });
    expect(isContainerSandboxActive()).toBe(true);
  });

  it("refuses every upstream git call without starting git", () => {
    createConwayClient({ apiUrl: "http://x", apiKey: "k", sandboxId: "", sandbox: { mode: "container" } });
    for (const fn of [getRepoInfo, checkUpstream, getUpstreamDiffs]) {
      expect(() => fn()).toThrow(/not available in sandbox container mode/);
    }
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("local mode is unchanged (a local client does not switch the mode)", () => {
    createConwayClient({ apiUrl: "http://x", apiKey: "k", sandboxId: "" });
    expect(isContainerSandboxActive()).toBe(false);
  });
});

describe("worker edit root", () => {
  it("is the current directory in local mode and the shared workspace in container mode", () => {
    const cwd = os.tmpdir();
    expect(workerEditRoot(undefined, cwd)).toBe(cwd);
    expect(workerEditRoot({ mode: "local" }, cwd)).toBe(cwd);
    expect(workerEditRoot({ mode: "container" }, cwd)).toBe("/workspace");
    expect(workerEditRoot({ mode: "container", workspaceDir: "/srv/ws" }, cwd)).toBe("/srv/ws");
    expect(() => workerEditRoot({ mode: "container", workspaceDir: "ws" }, cwd)).toThrow(/absolute/);
  });
});
