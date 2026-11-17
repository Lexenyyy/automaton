/**
 * Soul Tools — Tool implementations for soul management.
 *
 * Provides updateSoul, reflectOnSoul (trigger), viewSoul, and viewSoulHistory.
 * All operations validate before saving and log to soul_history.
 *
 * Phase 2.1: Soul System Redesign
 */

import fs from "fs";
import path from "path";
import type BetterSqlite3 from "better-sqlite3";
import type { SoulModel, SoulHistoryRow } from "../types.js";
import { loadCurrentSoul, writeSoulMd, createHash, createDefaultSoul, applySoulIdentity } from "./model.js";
import type { SoulIdentity } from "./model.js";

/** Sections the agent may change with update_soul (fork, run 5: was any key, including name/address). */
export const AGENT_SOUL_SECTIONS = [
  "corePurpose",
  "values",
  "behavioralGuidelines",
  "personality",
  "boundaries",
  "strategy",
] as const;
import { validateSoul } from "./validator.js";
import { insertSoulHistory, getCurrentSoulVersion, getLatestSoulHistory, getSoulHistory } from "../state/database.js";
import { ulid } from "ulid";
import { createLogger } from "../observability/logger.js";
const logger = createLogger("soul");

// ─── Update Soul ────────────────────────────────────────────────

export interface UpdateSoulResult {
  success: boolean;
  version: number;
  errors?: string[];
}

/**
 * Update the soul with new content. Validates, versions, saves to file, and logs.
 */
export async function updateSoul(
  db: BetterSqlite3.Database,
  updates: Partial<SoulModel>,
  source: SoulHistoryRow["changeSource"],
  reason?: string,
  soulPath?: string,
  /** Fork (run 5): name, address and creator come from the runtime, never from `updates`. */
  identity?: SoulIdentity,
): Promise<UpdateSoulResult> {
  try {
    const home = process.env.HOME || "/root";
    const resolvedPath = soulPath || path.join(home, ".automaton", "SOUL.md");

    // Load current soul or create default
    let current = loadCurrentSoul(db, resolvedPath);
    if (!current) {
      current = createDefaultSoul(
        updates.corePurpose || "No purpose set.",
        updates.name || "",
        updates.address || "",
        updates.creator || "",
      );
    }

    // Merge updates into current soul; identity fields from the runtime win.
    const merged: SoulModel = applySoulIdentity(
      {
        ...current,
        ...updates,
        format: "soul/v1",
        updatedAt: new Date().toISOString(),
      },
      identity,
    );

    return saveSoulVersion(db, merged, current.version, source, reason, resolvedPath, null);
  } catch (error) {
    logger.error("updateSoul failed", error instanceof Error ? error : undefined);
    return {
      success: false,
      version: 0,
      errors: [error instanceof Error ? error.message : "Unknown error"],
    };
  }
}

/** The default soul file path (~/.automaton/SOUL.md). */
export function defaultSoulPath(): string {
  return path.join(process.env.HOME || "/root", ".automaton", "SOUL.md");
}

/**
 * Validate a complete soul, give it the next version, write SOUL.md and log it
 * to soul_history. Shared by updateSoul and the owner reset (fork, run 5).
 */
export function saveSoulVersion(
  db: BetterSqlite3.Database,
  soul: SoulModel,
  fileVersion: number,
  source: SoulHistoryRow["changeSource"],
  reason: string | undefined,
  resolvedPath: string,
  approvedBy: string | null,
): UpdateSoulResult {
  // Validate
  const validation = validateSoul(soul);
  if (!validation.valid) {
    return {
      success: false,
      version: fileVersion,
      errors: validation.errors,
    };
  }

  // Increment version
  const currentVersion = getCurrentSoulVersion(db);
  const newVersion = Math.max(currentVersion, fileVersion) + 1;
  const newSoul: SoulModel = {
    ...validation.sanitized,
    version: newVersion,
    updatedAt: new Date().toISOString(),
  };

  // Write to file
  const content = writeSoulMd(newSoul);
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(resolvedPath, content, "utf-8");

  // Get previous version ID
  const latestHistory = getLatestSoulHistory(db);
  const previousVersionId = latestHistory?.id || null;

  // Log to soul_history
  insertSoulHistory(db, {
    id: ulid(),
    version: newVersion,
    content,
    contentHash: createHash(content),
    changeSource: source,
    changeReason: reason || null,
    previousVersionId,
    approvedBy,
    createdAt: new Date().toISOString(),
  });

  return { success: true, version: newVersion };
}

// ─── View Soul ──────────────────────────────────────────────────

/**
 * View the current soul model.
 */
export function viewSoul(
  db: BetterSqlite3.Database,
  soulPath?: string,
): SoulModel | null {
  return loadCurrentSoul(db, soulPath);
}

// ─── View Soul History ──────────────────────────────────────────

/**
 * View soul change history.
 */
export function viewSoulHistory(
  db: BetterSqlite3.Database,
  limit?: number,
): SoulHistoryRow[] {
  return getSoulHistory(db, limit);
}
