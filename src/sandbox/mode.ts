/**
 * Process-wide sandbox mode flag (fork, Phase 1).
 *
 * Set once when the Conway client is created in container mode. Helpers
 * without access to the config (self-mod/upstream.ts) check it so they never
 * start a process in the runtime.
 */

let containerSandboxActive = false;

export function setContainerSandboxActive(): void {
  containerSandboxActive = true;
}

export function isContainerSandboxActive(): boolean {
  return containerSandboxActive;
}

/** Tests only. */
export function resetSandboxModeForTests(): void {
  containerSandboxActive = false;
}
