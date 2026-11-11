/**
 * Command Safety Policy Rules
 *
 * Detects shell injection attempts and forbidden command patterns.
 * These rules are the primary defense; isForbiddenCommand() in tools.ts
 * is kept as defense-in-depth.
 */

import type { PolicyRule, PolicyRequest, PolicyRuleResult } from "../../types.js";

// Shell metacharacters that could enable injection when interpolated
const SHELL_METACHAR_RE = /[;|&$`\n(){}<>]/;

// Tools whose arguments may be interpolated into shell commands
const SHELL_INTERPOLATED_TOOLS = new Set([
  "exec",
  "pull_upstream",
  "install_npm_package",
  "install_mcp_server",
  "install_skill",
  "create_skill",
  "remove_skill",
]);

// Fields per tool that get interpolated into shell commands
const SHELL_FIELDS: Record<string, string[]> = {
  exec: [], // exec is the shell itself, handled by forbidden_patterns
  pull_upstream: ["commit"],
  install_npm_package: ["package"],
  install_mcp_server: ["package", "name"],
  install_skill: ["name", "url"],
  create_skill: ["name"],
  remove_skill: ["name"],
};

// Forbidden command patterns (migrated from tools.ts isForbiddenCommand)
const FORBIDDEN_COMMAND_PATTERNS: { pattern: RegExp; description: string }[] = [
  // Self-destruction
  { pattern: /rm\s+(-rf?\s+)?.*\.automaton/, description: "Delete .automaton directory" },
  { pattern: /rm\s+(-rf?\s+)?.*state\.db/, description: "Delete state database" },
  { pattern: /rm\s+(-rf?\s+)?.*wallet\.json/, description: "Delete wallet" },
  { pattern: /rm\s+(-rf?\s+)?.*automaton\.json/, description: "Delete config" },
  { pattern: /rm\s+(-rf?\s+)?.*heartbeat\.yml/, description: "Delete heartbeat config" },
  { pattern: /rm\s+(-rf?\s+)?.*SOUL\.md/, description: "Delete SOUL.md" },
  // Process killing
  { pattern: /kill\s+.*automaton/, description: "Kill automaton process" },
  { pattern: /pkill\s+.*automaton/, description: "Kill automaton process" },
  { pattern: /systemctl\s+(stop|disable)\s+automaton/, description: "Stop automaton service" },
  // Database destruction
  { pattern: /DROP\s+TABLE/i, description: "Drop database table" },
  { pattern: /DELETE\s+FROM\s+(turns|identity|kv|schema_version|skills|children|registry)/i, description: "Delete from critical table" },
  { pattern: /TRUNCATE/i, description: "Truncate table" },
  // Safety infrastructure modification via shell
  { pattern: /sed\s+.*injection-defense/, description: "Modify injection defense via sed" },
  { pattern: /sed\s+.*self-mod\/code/, description: "Modify self-mod code via sed" },
  { pattern: /sed\s+.*audit-log/, description: "Modify audit log via sed" },
  { pattern: />\s*.*injection-defense/, description: "Overwrite injection defense" },
  { pattern: />\s*.*self-mod\/code/, description: "Overwrite self-mod code" },
  { pattern: />\s*.*audit-log/, description: "Overwrite audit log" },
  // Credential harvesting
  { pattern: /cat\s+.*\.ssh/, description: "Read SSH keys" },
  { pattern: /cat\s+.*\.gnupg/, description: "Read GPG keys" },
  { pattern: /cat\s+.*\.env/, description: "Read environment file" },
  { pattern: /cat\s+.*wallet\.json/, description: "Read wallet file" },
  // Policy engine modification via shell
  { pattern: /sed\s+.*policy-engine/, description: "Modify policy engine via sed" },
  { pattern: /sed\s+.*policy-rules/, description: "Modify policy rules via sed" },
  { pattern: />\s*.*policy-engine/, description: "Overwrite policy engine" },
  { pattern: />\s*.*policy-rules/, description: "Overwrite policy rules" },

  // ── Fork change 2: the agent must not set its own environment for the next start ──
  // It knows its wallet address, so it could otherwise write the mainnet approval
  // itself. Best-effort pattern list (defense-in-depth); the hard boundary is
  // OS isolation (ROADMAP Phase 1: shell only inside Docker as non-root).
  // Mainnet approval variable, in any form or case
  { pattern: /MAINNET_APPROVED/i, description: "Touch the mainnet approval variable" },
  // Setting any AUTOMATON_* variable (approval, RPC URL, ...)
  { pattern: /\bAUTOMATON_[A-Z0-9_]+\s*=/i, description: "Set an AUTOMATON_* environment variable" },
  // Config and env/start-up files: any reference (read or write)
  { pattern: /automaton\.json/i, description: "Access agent config file" },
  { pattern: /(^|[\s"'=:\/<>|;&(])\.env(\.[\w.-]+)?(?![\w-])/, description: "Access .env file" },
  { pattern: /\.envrc\b/, description: "Access direnv file" },
  { pattern: /ecosystem(\.config)?\.(c?js|mjs|json|ya?ml)\b/i, description: "Access pm2 ecosystem file" },
  { pattern: /\.(bashrc|bash_profile|bash_login|zshrc|zprofile|zshenv|zlogin|pam_environment)\b/, description: "Access shell start-up file" },
  { pattern: /(^|[\s"'=:\/<>|;&(])\.profile\b/, description: "Access shell profile" },
  { pattern: /\.npmrc\b/, description: "Access npm config" },
  { pattern: /\/etc\/(environment|profile|init\.d|supervisor|default|crontab|cron\.d)/, description: "Access system start-up/env config" },
  { pattern: /\.pm2\b/, description: "Access pm2 home" },
  { pattern: /systemd/, description: "Access systemd config" },
  { pattern: /\.(service|socket|timer)(?![\w.-])/, description: "Access systemd unit file" },
  { pattern: /(docker-)?compose(\.[\w-]+)?\.ya?ml\b/i, description: "Access Docker Compose file" },
  { pattern: /Dockerfile/i, description: "Access Dockerfile" },
  { pattern: /\b(start|run|launch|entrypoint|docker-entrypoint)[\w.-]*\.(sh|bash|cmd|bat|ps1)\b/i, description: "Access start script" },
  { pattern: /automaton\.sh\b/, description: "Access start script" },
  // Supervisor commands that change the environment or start config
  { pattern: /--update-env\b/, description: "Restart with a changed environment" },
  { pattern: /\bpm2\s+(set|unset|start|startOrRestart|ecosystem|init|save|resurrect|startup|deploy|env|conf|config)\b/, description: "Change pm2 start config" },
  { pattern: /\bsystemctl\b.*\b(edit|set-environment|unset-environment|import-environment|link|daemon-reload|revert|enable|preset|set-property)\b/, description: "Change systemd service config" },
  { pattern: /\blaunchctl\s+(setenv|load|bootstrap)\b/, description: "Change launchd config" },
  { pattern: /\bcrontab\b/, description: "Change scheduled jobs" },
  // ── Fork change 3: the agent must not write its own ledger or database from the shell ──
  // (File tools already can't write state.db; ledger UPDATE/DELETE are blocked by triggers.
  // These stop e.g. inserting a fake owner_grant via sqlite3.)
  { pattern: /ledger_entries/i, description: "Access the ledger table" },
  { pattern: /\bsqlite3?\b[^\n]*state\.db/i, description: "Open the agent database with sqlite" },
  { pattern: /state\.db/i, description: "Access the agent database file" },
  // Persistent environment on Windows
  { pattern: /\bsetx\b/i, description: "Set persistent Windows environment variable" },
  { pattern: /SetEnvironmentVariable/i, description: "Set persistent Windows environment variable" },
  { pattern: /HKCU\\Environment|HKEY_CURRENT_USER\\Environment|Session Manager\\Environment/i, description: "Change environment in the registry" },
];

export function getForbiddenCommandMatch(command: string): { description: string; pattern: string } | null {
  for (const { pattern, description } of FORBIDDEN_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return { description, pattern: pattern.source };
    }
  }
  return null;
}

export function isForbiddenCommand(command: string): boolean {
  return getForbiddenCommandMatch(command) !== null;
}

function deny(rule: string, reasonCode: string, humanMessage: string): PolicyRuleResult {
  return { rule, action: "deny", reasonCode, humanMessage };
}

/**
 * Detect shell metacharacters in tool arguments that will be
 * interpolated into shell commands.
 */
function createShellInjectionRule(): PolicyRule {
  return {
    id: "command.shell_injection",
    description: "Detect shell metacharacters in arguments interpolated into shell commands",
    priority: 300,
    appliesTo: {
      by: "name",
      names: Array.from(SHELL_INTERPOLATED_TOOLS),
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const fields = SHELL_FIELDS[request.tool.name];
      if (!fields || fields.length === 0) return null;

      for (const field of fields) {
        const value = request.args[field];
        if (typeof value !== "string") continue;

        if (SHELL_METACHAR_RE.test(value)) {
          return deny(
            "command.shell_injection",
            "SHELL_INJECTION_DETECTED",
            `Shell metacharacter detected in ${request.tool.name}.${field}: "${value.slice(0, 50)}"`,
          );
        }
      }

      return null;
    },
  };
}

/**
 * Check exec commands against forbidden patterns.
 * Replaces the isForbiddenCommand() function with a proper policy rule.
 */
function createForbiddenPatternsRule(): PolicyRule {
  return {
    id: "command.forbidden_patterns",
    description: "Block self-destructive and credential-harvesting shell commands",
    priority: 300,
    appliesTo: {
      by: "name",
      names: ["exec"],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const command = request.args.command as string | undefined;
      if (!command) return null;

      const match = getForbiddenCommandMatch(command);
      if (match) {
        return deny(
          "command.forbidden_patterns",
          "FORBIDDEN_COMMAND",
          `Blocked: ${match.description} (pattern: ${match.pattern})`,
        );
      }

      return null;
    },
  };
}

export function createCommandSafetyRules(): PolicyRule[] {
  return [
    createShellInjectionRule(),
    createForbiddenPatternsRule(),
  ];
}
