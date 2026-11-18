/**
 * Soul sections the agent may change, and the ones the owner keeps (fork).
 *
 * Run 5 retry (G3): the agent rewrote its core purpose right after the owner
 * reset it (v88 -> v89 -> v90 in one wake). Sections listed in
 * soulConfig.ownerOnlySections (default: corePurpose) are refused for the
 * agent by policy rule authority.soul_owner_only; the owner changes them in
 * the config template and runs `pnpm agent:soul:reset`.
 *
 * No imports with side effects: the policy rules read this module.
 */

import type { AutomatonConfig } from "../types.js";

/** Sections the agent may change with update_soul (fork, run 5: was any key, including name/address). */
export const AGENT_SOUL_SECTIONS = [
  "corePurpose",
  "values",
  "behavioralGuidelines",
  "personality",
  "boundaries",
  "strategy",
] as const;

/** Default for soulConfig.ownerOnlySections. */
export const DEFAULT_OWNER_ONLY_SOUL_SECTIONS: readonly string[] = ["corePurpose"];

/** Sections only the owner may change (the default when unset or invalid; startup refuses invalid values). */
export function resolveOwnerOnlySoulSections(config: Pick<AutomatonConfig, "soulConfig"> | undefined): readonly string[] {
  const configured = config?.soulConfig?.ownerOnlySections;
  return checkOwnerOnlySoulSections(configured) === null && configured !== undefined
    ? configured
    : DEFAULT_OWNER_ONLY_SOUL_SECTIONS;
}

/** Problem with soulConfig.ownerOnlySections, or null when valid or unset. */
export function checkOwnerOnlySoulSections(value: unknown): string | null {
  if (value === undefined) return null;
  const known = AGENT_SOUL_SECTIONS as readonly string[];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !known.includes(v))) {
    return `soulConfig.ownerOnlySections must be a list of soul sections (${AGENT_SOUL_SECTIONS.join(", ")}); [] lets the agent change all of them`;
  }
  return null;
}
