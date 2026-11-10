/**
 * Fork change 2: Base Sepolia testnet mode, mainnet only with owner approval,
 * and the agent cannot set its own environment for the next start.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  resolveNetworkMode,
  activateNetwork,
  getActiveNetwork,
  assertNetworkAllowed,
  resetNetworkForTests,
  MAINNET_APPROVAL_ENV,
} from "../identity/network.js";
import { ResilientHttpClient } from "../conway/http-client.js";
import { x402Fetch } from "../conway/x402.js";
import { topupCredits } from "../conway/topup.js";
import { registerAgent, leaveFeedback } from "../registry/erc8004.js";
import { isProtectedFile, isStartupEnvFile } from "../self-mod/code.js";
import { createPathProtectionRules } from "../agent/policy-rules/path-protection.js";
import { createCommandSafetyRules, isForbiddenCommand } from "../agent/policy-rules/command-safety.js";
import { createBuiltinTools } from "../agent/tools.js";
import { DEFAULT_CONFIG } from "../types.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const PAY_TO = "0x2222222222222222222222222222222222222222";

afterEach(() => {
  resetNetworkForTests();
  vi.restoreAllMocks();
});

// ─── Network mode ─────────────────────────────────────────────

describe("resolveNetworkMode", () => {
  it("defaults to testnet", () => {
    expect(DEFAULT_CONFIG.network).toBe("testnet");
    expect(resolveNetworkMode({ walletAddress: WALLET }, {})).toBe("testnet");
    expect(resolveNetworkMode({ network: "testnet", walletAddress: WALLET }, {})).toBe("testnet");
  });

  it("refuses mainnet without the owner approval", () => {
    expect(() => resolveNetworkMode({ network: "mainnet", walletAddress: WALLET }, {})).toThrow(/not approved/);
  });

  it("refuses mainnet approved for a different wallet", () => {
    const env = { [MAINNET_APPROVAL_ENV]: "0x9999999999999999999999999999999999999999" };
    expect(() => resolveNetworkMode({ network: "mainnet", walletAddress: WALLET }, env)).toThrow(/not approved/);
  });

  it("refuses an approval with no wallet address to compare", () => {
    const env = { [MAINNET_APPROVAL_ENV]: WALLET };
    expect(() => resolveNetworkMode({ network: "mainnet" }, env)).toThrow(/not approved/);
  });

  it("allows mainnet with explicit setting + matching approval (case-insensitive)", () => {
    const env = { [MAINNET_APPROVAL_ENV]: WALLET.toUpperCase().replace("0X", "0x") };
    expect(resolveNetworkMode({ network: "mainnet", walletAddress: WALLET }, env)).toBe("mainnet");
  });

  it("rejects unknown values instead of guessing", () => {
    expect(() => resolveNetworkMode({ network: "base", walletAddress: WALLET }, {})).toThrow(/Invalid "network"/);
  });

  it("active network is testnet until activated, and activation can't be skipped by the approval alone", () => {
    expect(getActiveNetwork().caip2).toBe("eip155:84532");
    activateNetwork({ walletAddress: WALLET }, { [MAINNET_APPROVAL_ENV]: WALLET });
    expect(getActiveNetwork().mode).toBe("testnet");
  });

  it("assertNetworkAllowed only allows the active network", () => {
    expect(() => assertNetworkAllowed("eip155:84532")).not.toThrow();
    expect(() => assertNetworkAllowed("base-sepolia")).not.toThrow();
    expect(() => assertNetworkAllowed("eip155:8453")).toThrow(/Blocked/);
    expect(() => assertNetworkAllowed("mainnet")).toThrow(/Blocked/);
    expect(() => assertNetworkAllowed("something-else")).toThrow(/Blocked/);
  });
});

// ─── x402 payments ────────────────────────────────────────────

function paymentRequired(network: string): Response {
  return new Response(
    JSON.stringify({
      x402Version: 1,
      accepts: [{ scheme: "exact", network, maxAmountRequired: "0.01", payToAddress: PAY_TO, requiredDeadlineSeconds: 60 }],
    }),
    { status: 402, headers: { "Content-Type": "application/json" } },
  );
}

describe("x402 in testnet mode", () => {
  const account = privateKeyToAccount(generatePrivateKey());

  it("refuses to sign a mainnet payment", async () => {
    const spy = vi.spyOn(ResilientHttpClient.prototype, "request").mockResolvedValueOnce(paymentRequired("base"));
    const result = await x402Fetch("https://example.com/paid", account);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Blocked");
    expect(spy).toHaveBeenCalledTimes(1); // never sent a paid request
  });

  it("signs a Base Sepolia payment", async () => {
    const spy = vi
      .spyOn(ResilientHttpClient.prototype, "request")
      .mockResolvedValueOnce(paymentRequired("base-sepolia"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const result = await x402Fetch("https://example.com/paid", account);
    expect(result.success).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    const paid = spy.mock.calls[1][1] as { headers: Record<string, string> };
    const payment = JSON.parse(Buffer.from(paid.headers["X-Payment"], "base64").toString());
    expect(payment.network).toBe("eip155:84532");
  });

  it("Conway credit top-ups are disabled (real USDC on mainnet)", async () => {
    const spy = vi.spyOn(ResilientHttpClient.prototype, "request");
    const result = await topupCredits("https://api.conway.tech", account, 5);
    expect(result.success).toBe(false);
    expect(result.error).toContain("disabled in testnet mode");
    expect(spy).not.toHaveBeenCalled();
  });
});

// ─── ERC-8004 writes ──────────────────────────────────────────

describe("ERC-8004 writes in testnet mode", () => {
  const account = privateKeyToAccount(generatePrivateKey());

  it("registerAgent on mainnet is blocked before any RPC call", async () => {
    await expect(registerAgent(account, "https://example.com/card.json", "mainnet", {} as any)).rejects.toThrow(/Blocked/);
  });

  it("leaveFeedback on mainnet is blocked before any RPC call", async () => {
    await expect(leaveFeedback(account, "1", 5, "ok", "mainnet", {} as any)).rejects.toThrow(/Blocked/);
  });
});

// ─── Start-up / environment files are write-protected ─────────

const STARTUP_FILES = [
  "/root/.automaton/automaton.json",
  "/root/.env",
  "/root/app/.env.production",
  "/root/.envrc",
  "/root/ecosystem.config.js",
  "/root/ecosystem.config.cjs",
  "/root/.pm2/dump.pm2",
  "/root/.config/systemd/user/automaton.service",
  "/etc/systemd/system/automaton.service",
  "/root/.bashrc",
  "/root/.profile",
  "/root/.bash_profile",
  "/root/.zshrc",
  "/etc/environment",
  "/etc/profile.d/automaton.sh",
  "/etc/default/automaton",
  "/etc/crontab",
  "/root/.npmrc",
  "/root/automaton/docker-compose.yml",
  "/root/automaton/compose.yaml",
  "/root/automaton/Dockerfile",
  "/root/automaton/scripts/automaton.sh",
  "/root/automaton/start.sh",
  "/root/automaton/entrypoint.sh",
  "C:\\Users\\agent\\automaton\\.env",
];

describe("start-up and environment files cannot be written", () => {
  const protectedRule = createPathProtectionRules().find((r) => r.id === "path.protected_files")!;

  for (const file of STARTUP_FILES) {
    it(`blocks write_file and edit_own_file: ${file}`, () => {
      expect(isProtectedFile(file)).toBe(true);
      for (const tool of ["write_file", "edit_own_file"]) {
        const result = protectedRule.evaluate({ tool: { name: tool }, args: { path: file } } as any);
        expect(result?.action).toBe("deny");
      }
    });
  }

  it("write_file tool itself refuses (inline guard)", async () => {
    const writeFile = createBuiltinTools("sandbox").find((t) => t.name === "write_file")!;
    const conway = { writeFile: vi.fn() };
    const out = await writeFile.execute({ path: "/root/.env", content: `${MAINNET_APPROVAL_ENV}=${WALLET}` }, { conway } as any);
    expect(out).toMatch(/Blocked/);
    expect(conway.writeFile).not.toHaveBeenCalled();
  });

  it("does not block ordinary files", () => {
    for (const f of ["/root/app/index.ts", "/root/app/auth.service.ts", "/root/app/environment.ts", "/root/notes.md", "/root/app/runner.ts"]) {
      expect(isStartupEnvFile(f)).toBe(false);
    }
  });
});

// ─── Shell commands ───────────────────────────────────────────

const BLOCKED_COMMANDS = [
  `export ${MAINNET_APPROVAL_ENV}=${WALLET}`,
  `${MAINNET_APPROVAL_ENV}=${WALLET} node dist/index.js --run`,
  `echo '${MAINNET_APPROVAL_ENV}=${WALLET}' >> ~/.env`,
  `echo "export X=1" >> ~/.bashrc`,
  `printf 'x' > /root/.profile`,
  `setx ${MAINNET_APPROVAL_ENV} ${WALLET}`,
  `powershell -c "[Environment]::SetEnvironmentVariable('A','B','User')"`,
  `env automaton_mainnet_approved=${WALLET} pm2 restart automaton`,
  `pm2 restart automaton --update-env`,
  `pm2 set automaton:env x`,
  `pm2 start ecosystem.config.js`,
  `sed -i 's/testnet/mainnet/' ~/.automaton/automaton.json`,
  `jq '.network="mainnet"' automaton.json`,
  `systemctl --user edit automaton`,
  `systemctl --user set-environment A=B`,
  `cp x.service ~/.config/systemd/user/`,
  `echo A=B | sudo tee -a /etc/environment`,
  `crontab -e`,
  `echo 'node dist/index.js' > start.sh`,
  `vi scripts/automaton.sh`,
  `cat docker-compose.yml`,
];

const ALLOWED_COMMANDS = [
  "echo hello",
  "ls -la",
  "git status",
  "pm2 restart automaton",
  `node -e "console.log(process.env.HOME)"`,
  "cat src/auth.service.ts",
  "pnpm run build",
];

describe("shell commands that set the agent's environment are blocked", () => {
  const forbiddenRule = createCommandSafetyRules().find((r) => r.id === "command.forbidden_patterns")!;

  for (const command of BLOCKED_COMMANDS) {
    it(`blocks: ${command}`, () => {
      expect(isForbiddenCommand(command)).toBe(true);
      const result = forbiddenRule.evaluate({ tool: { name: "exec" }, args: { command } } as any);
      expect(result?.action).toBe("deny");
    });
  }

  it("exec tool itself refuses the approval variable (inline guard)", async () => {
    const exec = createBuiltinTools("sandbox").find((t) => t.name === "exec")!;
    const conway = { exec: vi.fn() };
    const out = await exec.execute(
      { command: `export ${MAINNET_APPROVAL_ENV}=${WALLET}` },
      { conway, identity: { sandboxId: "sandbox" } } as any,
    );
    expect(out).toMatch(/Blocked/);
    expect(conway.exec).not.toHaveBeenCalled();
  });

  for (const command of ALLOWED_COMMANDS) {
    it(`allows: ${command}`, () => {
      expect(isForbiddenCommand(command)).toBe(false);
    });
  }
});
