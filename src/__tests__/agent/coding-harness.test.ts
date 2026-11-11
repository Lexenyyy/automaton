import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodingHarness } from "../../agent/harnesses/coding-harness.js";
import type { HarnessContext } from "../../agent/harness-types.js";
import type { TaskResult } from "../../orchestration/task-graph.js";
import type { ConwayClient } from "../../types.js";
import { AgentWorkspace } from "../../orchestration/workspace.js";
import { createInMemoryDb } from "../orchestration/test-db.js";
import { createTestConfig, createTestIdentity } from "../mocks.js";

function createConwayStub(overrides?: Partial<ConwayClient>): ConwayClient {
  return {
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    writeFile: async () => undefined,
    readFile: async () => "",
    exposePort: async () => ({ port: 0, publicUrl: "", sandboxId: "" }),
    removePort: async () => undefined,
    createSandbox: async () => ({ id: "", status: "", region: "", vcpu: 0, memoryMb: 0, diskGb: 0, createdAt: "" }),
    deleteSandbox: async () => undefined,
    listSandboxes: async () => [],
    getCreditsBalance: async () => 0,
    getCreditsPricing: async () => [],
    transferCredits: async () => ({ id: "", fromAddress: "", toAddress: "", amountCents: 0, status: "completed", timestamp: "" }),
    registerAutomaton: async () => ({ automaton: {} }),
    searchDomains: async () => [],
    registerDomain: async () => ({ domain: "", status: "pending", registrationDate: "", expirationDate: "", nameservers: [] }),
    listDnsRecords: async () => [],
    addDnsRecord: async () => ({ id: "", type: "A", host: "", value: "", ttl: 300 }),
    deleteDnsRecord: async () => undefined,
    listModels: async () => [],
    createScopedClient: () => createConwayStub(),
    ...overrides,
  } as ConwayClient;
}

describe("agent/CodingHarness confinement", () => {
  let db: ReturnType<typeof createInMemoryDb>;
  let testRoot: string;

  beforeEach(() => {
    db = createInMemoryDb();
    testRoot = mkdtempSync(path.join(os.tmpdir(), "coding-harness-"));
  });

  afterEach(() => {
    db.close();
    rmSync(testRoot, { recursive: true, force: true });
  });

  async function createHarness(conway: ConwayClient) {
    const harness = new CodingHarness();
    const workspace = new AgentWorkspace("goal-coding", path.join(testRoot, "workspace"));
    const context: HarnessContext = {
      workspaceRoot: workspace.basePath,
      allowedEditRoot: testRoot,
      workspace,
      identity: createTestIdentity(),
      config: createTestConfig(),
      db,
      conway,
      inference: { chat: async () => ({ content: "done" }) },
      budget: {
        maxTurns: 5,
        maxCostCents: 50,
        timeoutMs: 5_000,
        turnsUsed: 0,
        costUsedCents: 0,
        startedAt: 0,
      },
      wisdom: { conventions: [], successes: [], failures: [], gotchas: [] },
      abortSignal: new AbortController().signal,
      goalId: "goal-coding",
    };

    await harness.initialize(
      {
        id: "task-coding-1",
        parentId: null,
        goalId: "goal-coding",
        title: "Apply a scoped code edit",
        description: "Only edit files inside the allowed edit root",
        status: "assigned",
        assignedTo: "local://worker",
        agentRole: "executor",
        priority: 50,
        dependencies: [],
        result: null as TaskResult | null,
        metadata: {
          estimatedCostCents: 5,
          actualCostCents: 0,
          maxRetries: 0,
          retryCount: 0,
          timeoutMs: 5_000,
          createdAt: new Date().toISOString(),
          startedAt: null,
          completedAt: null,
        },
      },
      context,
    );

    return harness;
  }

  async function runTool(conway: ConwayClient, toolName: string, args: Record<string, unknown>): Promise<string> {
    const harness = await createHarness(conway);
    const tool = harness.getToolDefs().find((entry) => entry.name === toolName);
    if (!tool) throw new Error(`missing tool: ${toolName}`);
    return tool.execute(args);
  }

  it("blocks patch_file traversal outside the allowed edit root", async () => {
    const outsideFile = path.join(testRoot, "..", "outside.ts");
    const out = await runTool(createConwayStub(), "patch_file", {
      path: outsideFile,
      search: "before",
      replace: "after",
    });

    expect(out).toContain("Blocked: path");
    expect(out).toContain("outside workspace");
  });

  it("blocks list_dir traversal outside the allowed edit root", async () => {
    const out = await runTool(createConwayStub(), "list_dir", { path: "../../etc" });
    expect(out).toContain("Blocked: path");
    expect(out).toContain("outside workspace");
  });

  it("patches a file inside the allowed edit root through the Conway client", async () => {
    const filePath = path.join(testRoot, "src", "example.ts");
    const files = new Map<string, string>([[filePath, "const value = 'before';\n"]]);
    const conway = createConwayStub({
      readFile: async (p) => files.get(p) ?? "",
      writeFile: async (p, c) => void files.set(p, c),
    });

    const out = await runTool(conway, "patch_file", {
      path: filePath,
      search: "'before'",
      replace: "'after'",
    });

    expect(out).toContain("Patched");
    expect(files.get(filePath)).toContain("'after'");
  });

  // Fork Phase 1 (sandbox step 2): a sandbox error is reported and never
  // retried in the runtime.
  it("reports a sandbox error and does not fall back to the runtime filesystem", async () => {
    const filePath = path.join(testRoot, "src", "example.ts");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "const value = 'before';\n", "utf8");
    const failing = createConwayStub({
      exec: async () => {
        throw new Error("sandbox down");
      },
      readFile: async () => {
        throw new Error("sandbox down");
      },
      writeFile: async () => {
        throw new Error("sandbox down");
      },
    });

    expect(await runTool(failing, "patch_file", { path: filePath, search: "'before'", replace: "'after'" })).toBe(
      "patch error: sandbox down",
    );
    expect(await runTool(failing, "read_file", { path: filePath })).toBe("read error: sandbox down");
    expect(await runTool(failing, "write_file", { path: path.join(testRoot, "new.ts"), content: "x" })).toBe(
      "write error: sandbox down",
    );
    expect(await runTool(failing, "exec", { command: "echo hi" })).toBe("exec error: sandbox down");
    expect(await runTool(failing, "list_dir", { path: testRoot })).toBe("list error: sandbox down");

    expect(readFileSync(filePath, "utf8")).toContain("'before'");
    expect(existsSync(path.join(testRoot, "new.ts"))).toBe(false);
  });

  it("lists a directory through the sandbox, not the runtime filesystem", async () => {
    const commands: string[] = [];
    const conway = createConwayStub({
      exec: async (command) => {
        commands.push(command);
        return { stdout: "f\tb.ts\nd\tsrc\nl\tlink\n", stderr: "", exitCode: 0 };
      },
    });
    const out = await runTool(conway, "list_dir", { path: "it's here" });
    expect(commands).toEqual([
      `'find' '${path.join(testRoot, "it'\\''s here")}' '-mindepth' '1' '-maxdepth' '1' '-printf' '%y\\t%f\\n'`,
    ]);
    expect(out).toBe("file\tb.ts\nother\tlink\ndir\tsrc");
  });

  it("reports a failed listing", async () => {
    const conway = createConwayStub({
      exec: async () => ({ stdout: "", stderr: "find: No such file or directory\n", exitCode: 1 }),
    });
    expect(await runTool(conway, "list_dir", {})).toBe("list error: find: No such file or directory");
  });
});
