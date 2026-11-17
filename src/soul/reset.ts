/**
 * Owner soul reset (fork, run 5 fix F4): `automaton --soul show|reset`,
 * `pnpm agent:soul` / `pnpm agent:soul:reset`.
 *
 * After run 5 the soul still carried the first genesis prompt's purpose
 * ("update my SOUL.md … note the main tools") and the upstream values
 * ("Survive … at all costs", "Create: build things"), injected into every
 * prompt. The reset writes a fresh soul from the owner's settings
 * (soulConfig.defaultCorePurpose / defaultValues, else the genesis prompt and
 * the upstream values), with the runtime identity, as the next version;
 * soul_history keeps every earlier version (change_source "human").
 * No model call and no network.
 */

import type BetterSqlite3 from "better-sqlite3";
import type { AutomatonConfig, SoulConfig } from "../types.js";
import { createDefaultSoul, loadCurrentSoul, applySoulIdentity } from "./model.js";
import type { SoulIdentity } from "./model.js";
import { defaultSoulPath, saveSoulVersion } from "./tools.js";
import type { UpdateSoulResult } from "./tools.js";

const MAX_PURPOSE = 2000;
const MAX_VALUES = 10;

/** Problems with soulConfig.defaultCorePurpose / defaultValues, or [] when valid or unset. */
export function checkSoulDefaults(config: Pick<AutomatonConfig, "soulConfig">): string[] {
  const s: Partial<SoulConfig> = config.soulConfig ?? {};
  const problems: string[] = [];
  if (s.defaultCorePurpose !== undefined &&
    (typeof s.defaultCorePurpose !== "string" || !s.defaultCorePurpose.trim() || s.defaultCorePurpose.length > MAX_PURPOSE)) {
    problems.push(`soulConfig.defaultCorePurpose must be a non-empty string of at most ${MAX_PURPOSE} characters`);
  }
  if (s.defaultValues !== undefined &&
    (!Array.isArray(s.defaultValues) || s.defaultValues.length === 0 || s.defaultValues.length > MAX_VALUES ||
      s.defaultValues.some((v) => typeof v !== "string" || !v.trim()))) {
    problems.push(`soulConfig.defaultValues must be 1 to ${MAX_VALUES} non-empty strings`);
  }
  return problems;
}

/** Identity for the soul from the config and the identity table written at startup (no wallet file read). */
export function soulIdentityFromDb(db: BetterSqlite3.Database, config: AutomatonConfig): SoulIdentity {
  const get = (key: string) =>
    (db.prepare("SELECT value FROM identity WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? "";
  return {
    name: config.name || get("name"),
    address: get("address") || config.walletAddress || "",
    creator: config.creatorAddress || get("creator"),
  };
}

/** Write a fresh soul from the owner's settings as the next version. */
export function resetSoul(
  db: BetterSqlite3.Database,
  config: AutomatonConfig,
  identity: SoulIdentity,
  soulPath: string = defaultSoulPath(),
): UpdateSoulResult {
  const problems = checkSoulDefaults(config);
  if (problems.length) return { success: false, version: 0, errors: problems };
  const s: Partial<SoulConfig> = config.soulConfig ?? {};
  const genesis = config.genesisPrompt || "No purpose set.";
  const fresh = applySoulIdentity(createDefaultSoul(genesis, identity.name, identity.address, identity.creator), identity);
  fresh.corePurpose = s.defaultCorePurpose?.trim() || genesis;
  if (s.defaultValues) fresh.values = s.defaultValues.map((v) => v.trim());
  const current = loadCurrentSoul(db, soulPath);
  return saveSoulVersion(db, fresh, current?.version ?? 0, "human", "owner reset (agent:soul:reset)", soulPath, "owner");
}

/** Owner view of the current soul (text). */
export function soulReport(db: BetterSqlite3.Database, soulPath: string = defaultSoulPath()): string {
  const soul = loadCurrentSoul(db, soulPath);
  if (!soul) return "No soul yet (SOUL.md does not exist).";
  const last = db
    .prepare("SELECT change_source, change_reason, created_at FROM soul_history ORDER BY version DESC LIMIT 1")
    .get() as { change_source: string; change_reason: string | null; created_at: string } | undefined;
  return [
    `Soul version ${soul.version}, updated ${soul.updatedAt}` +
      (last ? ` (last change: ${last.change_source}, ${last.change_reason ?? "no reason"})` : ""),
    `Name: ${soul.name || "(not set)"}   Address: ${soul.address || "(not set)"}   Creator: ${soul.creator || "(not set)"}`,
    `Core purpose: ${soul.corePurpose}`,
    `Values:${soul.values.map((v) => `\n  - ${v}`).join("") || " none"}`,
    soul.strategy ? `Strategy: ${soul.strategy}` : "Strategy: not set",
    soul.personality ? `Personality: ${soul.personality}` : "",
  ].filter(Boolean).join("\n");
}
