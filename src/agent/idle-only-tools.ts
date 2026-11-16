const IDLE_ONLY_TOOL_NAMES = [
  "check_credits",
  "check_usdc_balance",
  "system_synopsis",
  "review_memory",
  "list_children",
  "check_child_status",
  "list_sandboxes",
  "list_models",
  "list_skills",
  "git_status",
  "git_log",
  "check_reputation",
  "recall_facts",
  "recall_procedure",
  "heartbeat_ping",
  "check_inference_spending",
  "orchestrator_status",
  "list_goals",
  "get_plan",
] as const;

export const IDLE_ONLY_TOOLS = new Set<string>(IDLE_ONLY_TOOL_NAMES);

export function isIdleOnlyTool(name: string): boolean {
  return IDLE_ONLY_TOOLS.has(name);
}

/**
 * Turns to show the model: drop turns that only made status checks (so the
 * model doesn't continue a status-check pattern), but keep the most recent
 * one, so the model can see it already checked and what the result was.
 * Fork: dropping all of them made the model check again and again.
 */
export function selectContextTurns<T extends { toolCalls: { name: string }[] }>(allTurns: T[]): T[] {
  const isIdleOnly = (t: T) => t.toolCalls.length > 0 && t.toolCalls.every((tc) => isIdleOnlyTool(tc.name));
  let lastIdle = -1;
  for (let i = allTurns.length - 1; i >= 0; i--) {
    if (isIdleOnly(allTurns[i])) {
      lastIdle = i;
      break;
    }
  }
  const selected = allTurns.filter((t, i) => !isIdleOnly(t) || i === lastIdle);
  return selected.length > 0 ? selected : allTurns.slice(-2);
}
