# CLAUDE.md — Project instructions for Claude

This is **Lexenyyy/automaton**, the owner's fork of Conway-Research/automaton (MIT license):
a continuously running, self-funding AI agent (TypeScript, Node 22, pnpm 10, SQLite).
The goal is an efficient agent that sells one real, legal service and pays for its own compute,
running on the owner's own infrastructure (own VPS, own model API keys), not only Conway Cloud.

## Non-negotiable rules
1. **Legal only.** The agent must only take actions that are legal and that follow the terms of
   every provider and platform it touches. No spam, no scraping against site terms, no deception,
   no unauthorized access. When unsure, don't do it and ask the owner.
2. **Minimum cost, no skipped steps.** Prefer cheap or local models (Groq, Ollama, small OpenAI
   models) for routine work; use expensive models only where they are clearly needed.
3. **Test money first.** Use Base Sepolia testnet until the roadmap reaches Phase 8. Never move
   real funds or switch to mainnet without the owner's explicit approval.
4. **Safety is enforced in code, not prompts.** Never weaken the policy engine
   (`src/agent/policy-engine.ts`, `src/agent/policy-rules/`), path protection, the constitution,
   spending limits, or injection defenses. Changes there need the owner's explicit approval.
5. **Never expose secrets.** Never print, log, commit or read the wallet private key,
   `~/.automaton/wallet.json`, API keys or `.env` files.
6. **Do not run `node dist/index.js --run`** (starts the real agent and setup wizard) unless the
   owner asks for it.

## Workflow for every code change
- Explain the plan first for anything non-trivial; the owner approves edits manually.
- Keep changes small and focused; one concern per commit.
- After changing code: `pnpm build` and `pnpm test` (vitest) must pass.
- Record notable changes and decisions in `docs/CHANGELOG-FORK.md`.
- Environment: Windows + PowerShell. Use PowerShell-compatible commands.

## Roadmap (do phases in order)
0. Study & setup  1. Core agent loop  2. Heartbeat & memory  3. Wallet & money (testnet)
4. Survival tiers  5. Earning (one paid service)  6. Self-modification  7. Replication (optional, capped)
8. On-chain identity & mainnet launch (small funds, alerts on)

## Phase 0 findings (the codebase as forked)
- Much safety already exists: policy engine (6 rule categories), treasury limits, path
  protection, injection defense, inference budget tracker. See ARCHITECTURE.md "Security Model".
- **Balance depends on Conway:** `getCreditsBalance()` in `src/conway/client.ts` always calls
  Conway's API. Without Conway it returns 0, so the agent wrongly believes it is broke.
  Needs our own balance source (wallet USDC + local ledger).
- **Mainnet is hardcoded** in provisioning (`chainId: 8453` in `src/identity/provision.ts`).
  `src/conway/x402.ts` already knows `base-sepolia`, so a testnet mode is feasible.
- **Default spending limits are too loose** for this project (`DEFAULT_TREASURY_POLICY` in
  `src/types.ts`: $50/transfer, $250/day transfers, $500/day inference). To be tightened.
- **Local mode is not public:** `exposePort` returns `http://localhost:PORT` when no Conway
  sandbox is set. Must be replaced for the VPS (reverse proxy + domain + HTTPS).
- Inference providers supported: OpenAI, Anthropic, Groq, Together, local Ollama
  (`src/inference/provider-registry.ts`).

## Planned order of first changes
1. Tighten `DEFAULT_TREASURY_POLICY`.
2. Add a testnet (Base Sepolia) mode.
3. Replace the Conway-only balance source.
4. Replace `exposePort` for self-hosted VPS deployment.
