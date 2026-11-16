/**
 * Tool allowlist (fork, Phase 1).
 *
 * Every offered tool's schema is sent with every model call; in the first
 * testnet run that was most of the ~10k tokens per turn. The owner can limit
 * the offered tools to the ones the current roadmap phase needs with
 * "toolAllowlist" in the config (absent = all tools, upstream behavior).
 * A tool that is not offered is not executable either: executeTool only finds
 * tools in the same filtered list. This only narrows what the agent can do.
 */

import type { AutomatonConfig } from "../types.js";

/** Absent = no filter. Names are trimmed; duplicates ignored. */
export function resolveToolAllowlist(config: Pick<AutomatonConfig, "toolAllowlist">): Set<string> | null {
  if (!Array.isArray(config.toolAllowlist)) return null;
  return new Set(config.toolAllowlist.map((n) => String(n).trim()).filter(Boolean));
}

export function filterToolsForAllowlist<T extends { name: string }>(tools: T[], allow: Set<string> | null): T[] {
  return allow ? tools.filter((t) => allow.has(t.name)) : tools;
}

/**
 * Problems with the allowlist against the tools that exist after the other
 * filters (Conway mode, orchestration). Empty = fine.
 */
export function checkToolAllowlist(allow: Set<string> | null, available: { name: string }[]): string[] {
  if (!allow) return [];
  const names = new Set(available.map((t) => t.name));
  const problems: string[] = [];
  const unknown = [...allow].filter((n) => !names.has(n));
  if (unknown.length) problems.push(`toolAllowlist names not available in this mode: ${unknown.join(", ")}`);
  if (!allow.has("sleep")) problems.push('toolAllowlist must include "sleep" (otherwise the agent cannot go to sleep)');
  return problems;
}
