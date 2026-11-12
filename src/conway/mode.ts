/**
 * Conway on/off (fork, Phase 1).
 *
 * Setting `"conway": "on" | "off"` in automaton.json. When absent: "on" if a
 * Conway API key exists (upstream behavior), otherwise "off".
 *
 * Off = own providers only. Then no request may reach Conway: the Conway
 * client refuses every API call, the model client never uses the Conway
 * backend, x402 payments to Conway hosts are refused, the Conway social relay
 * is not used and Conway-only tools are not offered to the model.
 */

export type ConwayMode = "on" | "off";

export class ConwayDisabledError extends Error {
  constructor(what: string) {
    super(`Conway is off ("conway": "off"); ${what} is not available. The request was not sent.`);
    this.name = "ConwayDisabledError";
  }
}

/** Resolve the setting; throws on an invalid value (refuse to start). */
export function resolveConwayMode(setting: unknown, conwayApiKey: string | undefined): ConwayMode {
  if (setting === undefined || setting === null) return conwayApiKey ? "on" : "off";
  if (setting === "on" || setting === "off") return setting;
  throw new Error(`Invalid "conway" setting: ${JSON.stringify(setting)} (use "on" or "off")`);
}

let conwayDisabled = false;

/** Set once at startup when the mode is "off". */
export function setConwayDisabled(): void {
  conwayDisabled = true;
}

export function isConwayDisabled(): boolean {
  return conwayDisabled;
}

/** Tests only. */
export function resetConwayModeForTests(): void {
  conwayDisabled = false;
}

/** True for conway.tech and any subdomain of it. */
export function isConwayHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return host === "conway.tech" || host.endsWith(".conway.tech");
  } catch {
    return false;
  }
}

/**
 * Tools that need the Conway platform (credits, Conway sandboxes, children,
 * domains, x402 to the default Conway-only allowlist). Hidden from the model
 * and refused when Conway is off. A guard test checks this list against the
 * tool source, so a new Conway-calling tool must be added here.
 */
export const CONWAY_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "check_credits",
  "topup_credits",
  "transfer_credits",
  "create_sandbox",
  "list_sandboxes",
  "spawn_child",
  "fund_child",
  "check_child_status",
  "start_child",
  "verify_child_constitution",
  "search_domains",
  "register_domain",
  "manage_dns",
  "x402_fetch",
]);

/** The tools offered to the model (and executable) in the given mode. */
export function filterToolsForConwayMode<T extends { name: string }>(tools: T[], mode: ConwayMode | undefined): T[] {
  return mode === "off" ? tools.filter((t) => !CONWAY_ONLY_TOOLS.has(t.name)) : tools;
}
