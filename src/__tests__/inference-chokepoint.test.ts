/**
 * Fork Phase 1, step 5: inference choke-point guard.
 *
 * Every model call must go through the budget tracker and the ledger:
 * either InferenceRouter.route (main loop, summarizeTurns) or
 * MeteredInferenceClient (orchestrator, planner, workers). This test scans
 * the source and fails when a new place creates a raw client, talks to a
 * model API directly, or makes a .chat() call that nobody has reviewed.
 *
 * If this fails because you added a call: route it through the router or a
 * MeteredInference, then add it to the allowlist below with the reason.
 * Counts are exact, so a new call inside an allowed file also fails.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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

describe("inference choke point", () => {
  it("scans a real source tree", () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES.some((f) => f.rel === "inference/metered-client.ts")).toBe(true);
  });

  it("creates the raw UnifiedInferenceClient only in loop.ts, where it is wrapped", () => {
    expect(countMatches(/new\s+UnifiedInferenceClient\s*\(/)).toEqual({
      "agent/loop.ts": 1,
    });
  });

  it("hands the raw unified client only to MeteredInferenceClient in loop.ts", () => {
    const loop = FILES.find((f) => f.rel === "agent/loop.ts")!.text;
    // 1 declaration + 2 MeteredInferenceClient constructor arguments.
    expect(loop.match(/\brawUnifiedInference\b/g)?.length).toBe(3);
    const wrapped = loop.match(/new\s+MeteredInferenceClient\(\s*rawUnifiedInference\s*,/g) ?? [];
    expect(wrapped.length).toBe(2);
  });

  it("creates the raw Conway/OpenAI/Anthropic inference client only in the startup path", () => {
    // runtime/prepare.ts (moved from index.ts in the Conway-off change) passes
    // it to the main loop, which only calls it via router.route.
    expect(countMatches(/(?<!function\s)\bcreateInferenceClient\s*\(/)).toEqual({
      "runtime/prepare.ts": 1,
    });
  });

  it("talks to model APIs directly only inside the client layer", () => {
    const allowed = {
      "inference/provider-registry.ts": "builds the OpenAI SDK clients for UnifiedInferenceClient",
      "inference/inference-client.ts": "UnifiedInferenceClient itself (only used wrapped)",
      "conway/inference.ts": "raw Conway/OpenAI/Anthropic client (only used via router.route)",
    };
    const patterns = [
      /new\s+OpenAI\s*\(/,
      /new\s+Anthropic\s*\(/,
      /completions\.create\s*\(/,
      /\/chat\/completions\b/,
      /api\.anthropic\.com\/v1\/messages/,
      /\/api\/(chat|generate)\b/, // Ollama native API
    ];
    for (const pattern of patterns) {
      for (const file of Object.keys(countMatches(pattern))) {
        expect(allowed, `${file} matches ${pattern}: model API access outside the client layer`).toHaveProperty([file]);
      }
    }
  });

  it("has no unreviewed .chat() / .chatDirect() call sites", () => {
    // file → [exact count, why it is metered]
    const allowed: Record<string, [number, string]> = {
      "agent/loop.ts": [1, "inside the router.route callback (main turn)"],
      "agent/context.ts": [1, "inside the router.route callback (summarizeTurns)"],
      "inference/metered-client.ts": [2, "the metered wrapper calling its inner client"],
      "agent/worker-inference-bridge.ts": [1, "takes Pick<MeteredInference, 'chat'>"],
      "orchestration/local-worker.ts": [1, "forwards to the worker bridge (metered)"],
      "agent/harnesses/base-harness.ts": [1, "HarnessContext.inference = worker bridge (metered)"],
      "orchestration/orchestrator.ts": [1, "params.inference: MeteredInference"],
      "orchestration/planner.ts": [1, "PlannerInference = Pick<MeteredInference, 'chat'>"],
      "orchestration/plan-mode.ts": [1, "Pick<MeteredInference, 'chat'>"],
      "memory/compression-engine.ts": [2, "Pick<MeteredInference, 'chat'>"],
    };
    const found = countMatches(/\.chat(?:Direct)?\s*\(/);
    const expected = Object.fromEntries(Object.entries(allowed).map(([f, [n]]) => [f, n]));
    expect(found).toEqual(expected);
  });
});
