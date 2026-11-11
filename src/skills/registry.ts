/**
 * Skills Registry
 *
 * Install skills from remote sources:
 * - Git repos: git clone <url> ~/.automaton/skills/<name>
 * - URLs: fetch a SKILL.md from any URL
 * - Self-created: the automaton writes its own SKILL.md files
 *
 * All shell commands use execFileSync with argument arrays to prevent injection.
 * Directory operations use fs.* to avoid shell interpolation entirely.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import * as yaml from "yaml";
import type {
  Skill,
  SkillSource,
  AutomatonDatabase,
  ConwayClient,
} from "../types.js";
import { parseSkillMd } from "./format.js";
import { shellCommand } from "../sandbox/protocol.js";

/** Fork: in sandbox container mode installs run in the sandbox, not here. */
export interface InstallSkillOptions {
  containerSandbox?: boolean;
}

// Validation patterns to prevent injection via path/URL arguments
const SKILL_NAME_RE = /^[a-zA-Z0-9-]+$/;
const SAFE_URL_RE = /^https?:\/\/[^\s;|&$`(){}<>]+$/;

// Size limits for skill content
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_INSTRUCTIONS_LENGTH = 10_000;

/**
 * Validate that a skill path does not escape the skills directory.
 * Prevents path traversal attacks via crafted skill names.
 */
function validateSkillPath(skillsDir: string, name: string): string {
  const resolved = path.resolve(skillsDir, name);
  if (!resolved.startsWith(path.resolve(skillsDir) + path.sep)) {
    throw new Error(`Skill path traversal detected: ${name}`);
  }
  return resolved;
}

/**
 * Install a skill from a git repository.
 * Clones the repo into ~/.automaton/skills/<name>/
 * Uses execFileSync with argument arrays to prevent shell injection.
 */
export async function installSkillFromGit(
  repoUrl: string,
  name: string,
  skillsDir: string,
  db: AutomatonDatabase,
  conway: ConwayClient,
  options: InstallSkillOptions = {},
): Promise<Skill | null> {
  // Validate inputs to prevent injection
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(`Invalid skill name: "${name}". Must match ${SKILL_NAME_RE.source}`);
  }
  if (!SAFE_URL_RE.test(repoUrl)) {
    throw new Error(`Invalid repo URL: "${repoUrl}". Must be an http(s) URL with no shell metacharacters.`);
  }

  const resolvedDir = resolveHome(skillsDir);
  const targetDir = validateSkillPath(resolvedDir, name);

  if (options.containerSandbox) {
    // Fork: clone in the sandbox; the runtime starts no process and only
    // reads SKILL.md back as text.
    const result = await conway.exec(
      shellCommand(["git", "clone", "--depth", "1", "--", repoUrl, targetDir]),
      60_000,
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to clone skill repo: ${(result.stderr || result.stdout).trim() || `exit code ${result.exitCode}`}`);
    }
    return saveSkillFromSandbox(path.join(targetDir, "SKILL.md"), "git", db, conway);
  }

  // Clone using execFileSync with argument array (no shell interpolation)
  try {
    execFileSync("git", ["clone", "--depth", "1", repoUrl, targetDir], {
      encoding: "utf-8",
      timeout: 60_000,
    });
  } catch (err: any) {
    throw new Error(`Failed to clone skill repo: ${err.message}`);
  }

  // Read SKILL.md using fs (no shell needed)
  const skillMdPath = path.join(targetDir, "SKILL.md");
  if (!fs.existsSync(skillMdPath)) {
    throw new Error(`No SKILL.md found in cloned repo at ${skillMdPath}`);
  }

  const content = fs.readFileSync(skillMdPath, "utf-8");
  const skill = parseSkillMd(content, skillMdPath, "git");
  if (!skill) {
    throw new Error("Failed to parse SKILL.md from cloned repo");
  }

  db.upsertSkill(skill);
  return skill;
}

/**
 * Install a skill from a URL (fetches a single SKILL.md).
 * Uses execFileSync with argument arrays and fs.* for safe operations.
 */
export async function installSkillFromUrl(
  url: string,
  name: string,
  skillsDir: string,
  db: AutomatonDatabase,
  conway: ConwayClient,
  options: InstallSkillOptions = {},
): Promise<Skill | null> {
  // Validate inputs to prevent injection
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(`Invalid skill name: "${name}". Must match ${SKILL_NAME_RE.source}`);
  }
  if (!SAFE_URL_RE.test(url)) {
    throw new Error(`Invalid URL: "${url}". Must be an http(s) URL with no shell metacharacters.`);
  }

  const resolvedDir = resolveHome(skillsDir);
  const targetDir = validateSkillPath(resolvedDir, name);
  const skillMdPath = path.join(targetDir, "SKILL.md");

  if (options.containerSandbox) {
    // Fork: fetch in the sandbox; --url keeps the URL from being read as an option.
    const mkdir = await conway.exec(shellCommand(["mkdir", "-p", "--", targetDir]), 10_000);
    const result = mkdir.exitCode !== 0
      ? mkdir
      : await conway.exec(shellCommand(["curl", "-fsSL", "-o", skillMdPath, "--url", url]), 30_000);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to fetch SKILL.md from URL: ${(result.stderr || result.stdout).trim() || `exit code ${result.exitCode}`}`);
    }
    return saveSkillFromSandbox(skillMdPath, "url", db, conway);
  }

  // Create directory using fs (no shell needed)
  fs.mkdirSync(targetDir, { recursive: true });

  // Fetch SKILL.md using execFileSync with argument array (no shell interpolation)
  try {
    execFileSync("curl", ["-fsSL", "-o", skillMdPath, url], {
      encoding: "utf-8",
      timeout: 30_000,
    });
  } catch (err: any) {
    throw new Error(`Failed to fetch SKILL.md from URL: ${err.message}`);
  }

  // Read content using fs (no shell needed)
  const content = fs.readFileSync(skillMdPath, "utf-8");
  const skill = parseSkillMd(content, skillMdPath, "url");
  if (!skill) {
    throw new Error("Failed to parse fetched SKILL.md");
  }

  db.upsertSkill(skill);
  return skill;
}

/** Container mode: read SKILL.md from the sandbox as text, parse, store. */
async function saveSkillFromSandbox(
  skillMdPath: string,
  source: SkillSource,
  db: AutomatonDatabase,
  conway: ConwayClient,
): Promise<Skill> {
  let content: string;
  try {
    content = await conway.readFile(skillMdPath);
  } catch (err: any) {
    throw new Error(`No SKILL.md found at ${skillMdPath}: ${err?.message ?? err}`);
  }
  const skill = parseSkillMd(content, skillMdPath, source);
  if (!skill) {
    throw new Error("Failed to parse SKILL.md");
  }
  db.upsertSkill(skill);
  return skill;
}

/**
 * Create a new skill authored by the automaton itself.
 * Uses fs.* for directory creation and file writing (no shell needed).
 */
export async function createSkill(
  name: string,
  description: string,
  instructions: string,
  skillsDir: string,
  db: AutomatonDatabase,
  conway: ConwayClient,
): Promise<Skill> {
  // Validate name to prevent path traversal/injection
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(`Invalid skill name: "${name}". Must match ${SKILL_NAME_RE.source}`);
  }

  // Enforce size limits
  const safeDescription = description.slice(0, MAX_DESCRIPTION_LENGTH);
  const safeInstructions = instructions.slice(0, MAX_INSTRUCTIONS_LENGTH);

  const resolvedDir = resolveHome(skillsDir);
  const targetDir = validateSkillPath(resolvedDir, name);

  // Create directory using fs (no shell needed)
  fs.mkdirSync(targetDir, { recursive: true });

  // Generate YAML frontmatter safely using yaml.stringify (prevents YAML injection)
  const frontmatter = yaml.stringify({
    name,
    description: safeDescription,
    "auto-activate": true,
  });
  const content = `---\n${frontmatter}---\n\n${safeInstructions}`;

  const skillMdPath = path.join(targetDir, "SKILL.md");
  await conway.writeFile(skillMdPath, content);

  const skill: Skill = {
    name,
    description: safeDescription,
    autoActivate: true,
    instructions: safeInstructions,
    source: "self",
    path: skillMdPath,
    enabled: true,
    installedAt: new Date().toISOString(),
  };

  db.upsertSkill(skill);
  return skill;
}

/**
 * Remove a skill (disable in DB and optionally delete from disk).
 * Uses fs.rmSync for safe file deletion (no shell needed).
 */
export async function removeSkill(
  name: string,
  db: AutomatonDatabase,
  _conway: ConwayClient,
  skillsDir: string,
  deleteFiles: boolean = false,
): Promise<void> {
  // Validate name to prevent path traversal/injection
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(`Invalid skill name: "${name}". Must match ${SKILL_NAME_RE.source}`);
  }

  db.removeSkill(name);

  if (deleteFiles) {
    const resolvedDir = resolveHome(skillsDir);
    const targetDir = validateSkillPath(resolvedDir, name);
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
}

/**
 * List all installed skills.
 */
export function listSkills(db: AutomatonDatabase): Skill[] {
  return db.getSkills();
}

function resolveHome(p: string): string {
  if (p.startsWith("~")) {
    return path.join(process.env.HOME || "/root", p.slice(1));
  }
  return p;
}
