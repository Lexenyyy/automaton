/**
 * Orchestration on/off (fork, Phase 1).
 *
 * In the first testnet run the agent created an orchestrator goal for a
 * one-tool task (writing SOUL.md), because the orchestration prompt says to
 * delegate everything. With "orchestration": "off" there is no orchestrator,
 * no local worker pool (so no worker model spend), no orchestration prompt,
 * and the goal and child tools are neither offered nor executable.
 */

import type { AutomatonConfig } from "../types.js";

export type OrchestrationMode = "on" | "off";

/** Goal orchestration and child-agent tools. */
export const ORCHESTRATION_TOOLS: ReadonlySet<string> = new Set([
  "create_goal",
  "list_goals",
  "cancel_goal",
  "get_plan",
  "orchestrator_status",
  "spawn_child",
  "list_children",
  "fund_child",
  "check_child_status",
  "start_child",
  "message_child",
  "verify_child_constitution",
  "prune_dead_children",
]);

/** Absent = "on" (upstream behavior). Anything other than "off" is "on". */
export function resolveOrchestrationMode(config: Pick<AutomatonConfig, "orchestration">): OrchestrationMode {
  return config.orchestration === "off" ? "off" : "on";
}

/** The tools offered to the model (and executable) in the given mode. */
export function filterToolsForOrchestration<T extends { name: string }>(tools: T[], mode: OrchestrationMode): T[] {
  return mode === "off" ? tools.filter((t) => !ORCHESTRATION_TOOLS.has(t.name)) : tools;
}
