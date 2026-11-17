/**
 * Fork, run 5 (F7): preflight's view of today's spend against the daily cap.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dailyCapStatus } from "../inference/budget.js";
import { createTestDb } from "./mocks.js";

let db: ReturnType<typeof createTestDb>;
beforeEach(() => {
  db = createTestDb();
});
afterEach(() => db.close());

let n = 0;
const cost = (mc: number, at: string) =>
  db.raw
    .prepare(
      `INSERT INTO inference_costs (id, session_id, model, provider, input_tokens, output_tokens, cost_cents, cost_mc, latency_ms, tier, task_type, created_at)
       VALUES (?, 's', 'gpt-4.1-mini', 'openai', 0, 0, ?, ?, 0, 'normal', 'agent_turn', ?)`,
    )
    .run(`c${n++}`, Math.ceil(mc / 1000), mc, at);

const NOW = new Date("2026-11-16T23:00:00.000Z");

describe("dailyCapStatus", () => {
  it("counts only the current UTC day and reports the next reset", () => {
    cost(10_000, "2026-11-15 22:00:00"); // yesterday
    cost(4_000, "2026-11-16 00:30:00");
    const s = dailyCapStatus(db.raw, { dailyBudgetCents: 30 }, undefined, NOW);
    expect(s).toEqual({ spentMc: 4_000, capCents: 30, reached: false, resetsAt: "2026-11-17T00:00:00.000Z" });
  });

  it("reached when today's spend is at or over the cap (run 5's false start: 54.9c of 30c)", () => {
    cost(54_917, "2026-11-16 15:40:00");
    expect(dailyCapStatus(db.raw, { dailyBudgetCents: 30 }, undefined, NOW).reached).toBe(true);
  });

  it("uses the stricter of strategy and treasury caps; 0 = no cap, never reached", () => {
    cost(25_000, "2026-11-16 10:00:00");
    expect(dailyCapStatus(db.raw, { dailyBudgetCents: 100 }, { maxInferenceDailyCents: 20 }, NOW)).toMatchObject({ capCents: 20, reached: true });
    expect(dailyCapStatus(db.raw, { dailyBudgetCents: 0 }, undefined, NOW)).toMatchObject({ capCents: 0, reached: false });
  });
});
