/**
 * Fork Phase 1, step 3: on an inference budget refusal the orchestrator and
 * local workers pause until the next budget window. They never mark tasks
 * failed, fall back to a guessed plan, or replan because of it.
 */

import type BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulid";

vi.mock("../../orchestration/workspace.js", () => ({
  AgentWorkspace: class {
    basePath = "/tmp/budget-pause-test-workspace";
    logDecision() {}
  },
}));
vi.mock("../../agent/harness-types.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agent/harness-types.js")>()),
  buildWisdomFromGoal: () => ({ conventions: [], successes: [], failures: [], gotchas: [] }),
}));

import { Orchestrator } from "../../orchestration/orchestrator.js";
import { LocalWorkerPool } from "../../orchestration/local-worker.js";
import { ColonyMessaging } from "../../orchestration/messaging.js";
import { GeneralHarness } from "../../agent/harnesses/general-harness.js";
import { InferenceBudgetExceededError } from "../../inference/metered-client.js";
import {
  BUDGET_PAUSE_KEY,
  getBudgetPauseUntil,
  nextBudgetWindow,
  pauseForBudget,
} from "../../inference/budget-pause.js";
import type { AutomatonDatabase } from "../../types.js";
import { createInMemoryDb } from "./test-db.js";
import { createTestConfig, createTestIdentity } from "../mocks.js";

const budgetError = () => new InferenceBudgetExceededError("Daily inference budget exhausted");

let db: BetterSqlite3.Database;
beforeEach(() => {
  db = createInMemoryDb();
});
afterEach(() => db.close());

function insertGoal(): string {
  const id = ulid();
  db.prepare(
    "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, 'active', ?)",
  ).run(id, "Goal", "A goal", new Date().toISOString());
  return id;
}

function insertTask(goalId: string, status: string, assignedTo: string | null = null): string {
  const id = ulid();
  db.prepare(
    `INSERT INTO task_graph
     (id, goal_id, title, description, status, assigned_to, agent_role, priority, dependencies, created_at)
     VALUES (?, ?, 'Task', 'Do it', ?, ?, 'generalist', 50, '[]', ?)`,
  ).run(id, goalId, status, assignedTo, new Date().toISOString());
  return id;
}

function setState(state: Record<string, unknown>): void {
  db.prepare(
    "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('orchestrator.state', ?, datetime('now'))",
  ).run(JSON.stringify({ replanCount: 0, failedTaskId: null, failedError: null, ...state }));
}

function getState(): Record<string, unknown> {
  const row = db.prepare("SELECT value FROM kv WHERE key = 'orchestrator.state'").get() as { value: string };
  return JSON.parse(row.value);
}

function goalStatus(id: string): string {
  return (db.prepare("SELECT status FROM goals WHERE id = ?").get(id) as { status: string }).status;
}

function taskRow(id: string): { status: string; assigned_to: string | null } {
  return db.prepare("SELECT status, assigned_to FROM task_graph WHERE id = ?").get(id) as any;
}

function makeOrchestrator(chat: ReturnType<typeof vi.fn>): Orchestrator {
  const automataDb = {
    raw: db,
    getIdentity: () => "0x1234",
    getChildren: () => [],
    getUnprocessedInboxMessages: () => [],
    markInboxMessageProcessed: () => {},
  } as unknown as AutomatonDatabase;
  const messaging = new ColonyMessaging(
    { deliver: vi.fn(), getRecipients: vi.fn().mockReturnValue([]) } as any,
    automataDb,
  );
  return new Orchestrator({
    db,
    agentTracker: {
      getIdle: vi.fn().mockReturnValue([]),
      getBestForTask: vi.fn().mockReturnValue(null),
      updateStatus: vi.fn(),
      register: vi.fn(),
    } as any,
    funding: {
      fundChild: vi.fn(),
      recallCredits: vi.fn(),
      getBalance: vi.fn().mockResolvedValue(0),
    } as any,
    messaging,
    inference: { chat, chatDirect: vi.fn() },
    identity: createTestIdentity(),
    config: {},
  });
}

describe("budget pause helpers", () => {
  it("next window is the next UTC hour, at least 5 minutes away", () => {
    const early = Date.parse("2026-11-11T10:10:00Z");
    expect(new Date(nextBudgetWindow(early)).toISOString()).toBe("2026-11-11T11:00:00.000Z");
    const late = Date.parse("2026-11-11T10:58:00Z");
    expect(new Date(nextBudgetWindow(late)).toISOString()).toBe("2026-11-11T11:03:00.000Z");
  });

  it("stores the pause, expires it, and never shortens a longer pause", () => {
    const now = Date.parse("2026-11-11T10:10:00Z");
    const longer = Date.parse("2026-11-11T15:00:00Z");
    db.prepare("INSERT INTO kv (key, value) VALUES (?, ?)").run(BUDGET_PAUSE_KEY, new Date(longer).toISOString());
    pauseForBudget(db, "x", now);
    expect(getBudgetPauseUntil(db, now)).toBe(longer);
    expect(getBudgetPauseUntil(db, longer + 1)).toBeNull();
  });
});

describe("Orchestrator on budget refusal", () => {
  it("does nothing while paused", async () => {
    const goalId = insertGoal();
    setState({ phase: "classifying", goalId });
    pauseForBudget(db, "cap");
    const chat = vi.fn();
    const result = await makeOrchestrator(chat).tick();
    expect(result.phase).toBe("classifying");
    expect(chat).not.toHaveBeenCalled();
    expect(getState().phase).toBe("classifying");
  });

  it("planning: pauses, keeps the phase, no fallback plan, goal not failed", async () => {
    const goalId = insertGoal();
    setState({ phase: "planning", goalId });
    const chat = vi.fn().mockRejectedValue(budgetError());
    const result = await makeOrchestrator(chat).tick();
    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.phase).toBe("planning");
    expect(goalStatus(goalId)).toBe("active");
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_graph").get()).toEqual({ n: 0 });
    expect(getBudgetPauseUntil(db)).not.toBeNull();
  });

  it("classifying: pauses instead of guessing the complexity", async () => {
    const goalId = insertGoal();
    setState({ phase: "classifying", goalId });
    const chat = vi.fn().mockRejectedValue(budgetError());
    const result = await makeOrchestrator(chat).tick();
    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.phase).toBe("classifying");
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_graph").get()).toEqual({ n: 0 });
    expect(getBudgetPauseUntil(db)).not.toBeNull();
  });

  it("replanning: pauses, does not replan or reset the failed task", async () => {
    const goalId = insertGoal();
    const failed = insertTask(goalId, "failed");
    setState({ phase: "replanning", goalId, failedTaskId: failed, replanCount: 1 });
    const chat = vi.fn().mockRejectedValue(budgetError());
    const result = await makeOrchestrator(chat).tick();
    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.phase).toBe("replanning");
    expect(getState().replanCount).toBe(1);
    expect(taskRow(failed).status).toBe("failed");
    expect(goalStatus(goalId)).toBe("active");
  });
});

describe("LocalWorkerPool on budget refusal", () => {
  it("requeues the task as pending and pauses; the task is not failed", async () => {
    const goalId = insertGoal();
    const taskId = insertTask(goalId, "assigned", "local://w");
    const harness = {
      id: "general",
      initialize: vi.fn(),
      execute: vi.fn().mockRejectedValue(budgetError()),
    };
    const pool = new LocalWorkerPool({
      db,
      inference: { chat: vi.fn() },
      conway: {} as any,
      harnessRegistry: { createForRole: () => harness } as any,
      identity: createTestIdentity(),
      config: createTestConfig(),
    });
    pool.spawn({
      id: taskId,
      parentId: null,
      goalId,
      title: "Task",
      description: "Do it",
      status: "assigned",
      assignedTo: "local://w",
      agentRole: "generalist",
      priority: 50,
      dependencies: [],
      result: null,
      metadata: {
        estimatedCostCents: 0,
        actualCostCents: 0,
        maxRetries: 0,
        retryCount: 0,
        timeoutMs: 5_000,
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
      },
    });
    await vi.waitFor(() => expect(pool.getActiveCount()).toBe(0));
    expect(taskRow(taskId)).toEqual({ status: "pending", assigned_to: null });
    expect(getBudgetPauseUntil(db)).not.toBeNull();
  });
});

describe("BaseHarness on budget refusal", () => {
  it("stops at once instead of retrying the refused call", async () => {
    const chat = vi.fn().mockRejectedValue(budgetError());
    const harness = new GeneralHarness();
    await harness.initialize(
      {
        id: "t1",
        parentId: null,
        goalId: "g1",
        title: "Task",
        description: "Do it",
        status: "assigned",
        assignedTo: "local://w",
        agentRole: "generalist",
        priority: 50,
        dependencies: [],
        result: null,
        metadata: {
          estimatedCostCents: 0,
          actualCostCents: 0,
          maxRetries: 0,
          retryCount: 0,
          timeoutMs: 5_000,
          createdAt: new Date().toISOString(),
          startedAt: null,
          completedAt: null,
        },
      },
      {
        workspaceRoot: "/tmp/x",
        allowedEditRoot: "/tmp/x",
        workspace: {} as any,
        identity: createTestIdentity(),
        config: createTestConfig(),
        db,
        conway: {} as any,
        inference: { chat },
        budget: { maxTurns: 5, maxCostCents: 50, timeoutMs: 5_000, turnsUsed: 0, costUsedCents: 0, startedAt: 0 },
        wisdom: { conventions: [], successes: [], failures: [], gotchas: [] },
        abortSignal: new AbortController().signal,
        goalId: "g1",
      },
    );
    await expect(harness.execute()).rejects.toBeInstanceOf(InferenceBudgetExceededError);
    expect(chat).toHaveBeenCalledTimes(1);
  });
});
