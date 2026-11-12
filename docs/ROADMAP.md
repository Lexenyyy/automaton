# Automaton Build Roadmap

Hybrid approach: start from the Conway fork and replace Conway-specific pieces with our own
providers one at a time. Rules in `CLAUDE.md` apply to every phase.
Estimates assume one developer, part-time. Total: about 4 to 6 months.

## Phase 0 — Study & setup (1 week) — IN PROGRESS
- [x] Fork and clone; `pnpm install` and `pnpm build` succeed (Node 22, Windows)
- [x] Read architecture; map Conway dependencies (see CLAUDE.md "Phase 0 findings")
- [x] Docker installed and working
- [ ] Write our own genesis prompt and review `constitution.md`
- [ ] Decide the ONE service the agent will sell (blocks Phase 5b)
- [x] Apply planned changes 1–3 from CLAUDE.md. All Phase 0 code changes are done:
  - change 1: tighter treasury limits
  - change 1b: cheap default models
  - change 1c: $1/day inference cap
  - change 2: Base Sepolia testnet mode
  - change 3: own balance source, ledger, lifetime inference cap, shell blocked from ledger/DB
  Change 4 (replace `exposePort`) needs the VPS and is scheduled in Phase 5a.
Done when: build passes, every `src/` folder is understood, sandbox is isolated.
(Remaining open items are non-code: genesis prompt/constitution review and choosing the service.)

## Phase 1 — Core agent loop (2 weeks)
Goal: Think → Act → Observe loop running safe tools, remembering what happened.
- Model client with retries, timeouts, token/cost counting (exists: `src/inference/`)
- Tool interface; start with a minimal safe tool set
- Turn limits per hour; SQLite persistence across restarts (exists: `src/state/`)
- Context summarization when history grows (exists: `src/memory/`)
- Structured logs with per-call cost
- Safety now: shell only inside Docker as non-root; hard daily spend cap in code; working kill command.
  This is also the hard boundary for change 2: the shell pattern blocklist for start-up/env files is
  best-effort (obfuscated commands can get past regexes), so the agent's shell must not be able to
  write `automaton.json`, `.env`, pm2/systemd configs or start scripts at the OS level.
  - [x] **Shell only inside Docker as non-root.** Done in `34e383c`, `e00c0d0`, `b5317a2`: two
        containers (runtime + sandbox, see CLAUDE.md "Running the agent in Docker"). The agent's shell
        and file tools run in a sandbox without network, secrets or host folders; config is read-only;
        keys reach the runtime only. `pnpm agent:verify`: 84 checks pass.
  - [x] **`--run` without a Conway API key.** Done in `45412db`: `"conway": "off"` (own providers only,
        nothing sent to Conway) and `--preflight` (`pnpm agent:preflight`) to check the startup path
        without a model call.
  - [x] **Mutable settings in a read-only config.** Done in `3129292`: `update_genesis_prompt` and
        `switch_model` store their value in the database within the owner's `agentSettings` limits.
  - [x] **Working kill command.** Done in `fa68d14`: `pnpm agent:kill` stops both containers at once
        (SIGKILL), keeps volumes, safe to run anytime. The hard daily spend cap exists since change 1c.
        Phase 2's creator CLI can call the same script.
  - [ ] **Groq in the main loop** (owner decision: later). The main-loop model client has no Groq backend;
        Groq is only available to the workers through the provider registry.
- Found in Phase 0 review, to fix in this phase:
  - [x] **HIGH PRIORITY: the tokenizer could freeze the agent loop.** Fixed in `f560a96`.
        `estimateTokens` ran every turn through `js-tiktoken`, which is quadratic on long strings with
        no spaces (5k chars took 1 s, 20k took 21 s). The counter (`src/memory/context-manager.ts`) now
        encodes long whitespace-free runs in 64-char slices. Above 50k chars it counts the first 50k and
        scales by length. Measured worst case: about 170 ms. `context-hardening.test.ts` no longer hangs.
  - [ ] **Count tool results the way the model sees them.** `estimateTurnTokens` (`src/agent/context.ts`)
        counts the full tool result, but the context sends only the first 10k chars
        (`truncateToolResult`). Turns with huge results look more expensive than they are, so they get
        summarized sooner. Fixing this changes which turns are summarized, so it needs the owner's approval.
  - [x] **3 stale status-block tests in `context-hardening.test.ts`.** They were hidden while the file
        hung and still expected the upstream `Credits:` line and tiers. Fixed in `ddc79b9`: the tests
        now match the change 3 `Balance:` block and `getSurvivalTier` (the prompt was correct).
  - [x] **Run the test suite in a Linux Docker container.** Done in `e15a727`: `pnpm test:linux`.
        Linux baseline: 1820 passed, 0 failed. CLAUDE.md now uses it as the main baseline.
  - [ ] **Windows test failures that already existed (22).** Test helpers build paths in a way that
        produces `C:\C:\...` and use POSIX paths like `/root/...`:
        `skills-hardening` (12), `command-injection` (5), `tools-security` (3), `path-protection` (1),
        `orchestration/local-worker-harness` (1). The Linux run showed that all 22 pass on Linux, so they
        are Windows-only. Fix them only if running on Windows matters; the VPS runs Linux. Low priority.
  - [ ] **Enforce the minimum reserve in code.** `financial.minimum_reserve` (`src/agent/policy-rules/financial.ts`)
        only states the limit and always returns `null`. The only real guard is "max half the balance" inside
        `transfer_credits`. Needs the balance source from change 3. This is a policy-engine change, so it needs
        the owner's approval.
  - [ ] **Old saved config overrides the new defaults.** `saveConfig` writes the whole `treasuryPolicy` to
        `~/.automaton/automaton.json`, and `loadConfig` lets saved values win. A config created before the
        tightened defaults keeps the old, looser limits. Options: warn when a saved limit is looser than the
        default, or clamp it to the default.
  - [ ] **Some loop tests call the public Base RPC.** ERC-8004 discovery in `loop.test.ts` reaches
        `sepolia.base.org` (before change 2: mainnet). Mock it so tests don't depend on the network.
        Then add an offline variant of `pnpm test:linux` (`docker run --network none`) to prove that
        no test needs the network.
  - [ ] **Rename `turnToolCallCount` to `turnTransferCount`.** I checked `loop.ts` and `general-harness.ts`: both
        count only `transfer_credits` calls, so `maxTransfersPerTurn` works correctly. The name suggests it counts
        all tool calls, which is misleading. This is cleanup only.
  - [x] **Route all inference through the budget tracker.** Done (Phase 1 steps 1–5):
        - The main loop and `summarizeTurns` use `InferenceRouter`.
        - The orchestrator, planner, plan-mode, compression engine and workers use `MeteredInferenceClient`.
        - Both share one `InferenceBudgetTracker` and write every cost to `inference_costs` and the ledger.
        - In-flight reservations stop parallel calls from overspending together.
        - On a budget refusal, orchestration and workers pause until the next budget window; tasks are
          not failed or replanned.
        - `inference-chokepoint.test.ts` fails on any new unmetered call site.
  - [ ] **Policy rule `financial.inference_daily_cap` sees no `inference` spend.** The tracker already enforces
        the daily cap, so this would be a second guard, not a missing one. It is a policy-engine change and
        needs the owner's approval (deferred by the owner on 2026-11-11).
  - [ ] **The two price tables could disagree.** The router prices from `ModelRegistry`; the metered client
        prices from `ProviderRegistry`, never below the built-in price. Merging them is cleanup.
Done when: agent completes a simple task unaided; restart loses no state; cost per turn visible.

## Phase 2 — Heartbeat, identity & memory (1–2 weeks)
- Heartbeat scheduler independent of the main loop (exists: `src/heartbeat/`)
- Process supervision (pm2/systemd) with a crash-loop limit
- SOUL.md identity file in every turn's context (exists: `src/soul/`)
- Creator CLI: status, logs, pause, resume, kill (`packages/cli`)
Done when: runs 72h unattended without crashes or runaway cost; pause/kill work.

## Phase 3 — Wallet & money, TESTNET ONLY (2 weeks)
- Wallet generated with viem, stored encrypted, never in logs or model context
- Base Sepolia only; fund with faucet test USDC
- Balance visible to the agent each turn
- Payment tool with code-enforced limits: per transaction, per day, recipient allowlist
- [x] Our own balance source replacing Conway-only `getCreditsBalance()`. The balance/ledger must count
  both USDC and Stripe revenue (Stripe arrives in Phase 5a; design the ledger for both from the start).
  Done in change 3: `src/survival/balance.ts` (wallet USDC + `ledger_entries`), owner CLI
  `automaton-cli ledger`, lifetime real-money inference cap
- [x] Creator fund command for the own balance: `automaton-cli ledger grant <amount>`
- Creator `fund` command
Done when: testnet payment works within limits; over-limit payments are blocked by code; key never leaks.

## Phase 4 — Survival system (1 week)
- Credit monitor converts balance into runway estimate
- Tiers: normal → low_compute → critical → dead, each mapped to a model
- Tier and runway in context every turn; clean shutdown at zero with owner notification
Done when: draining the testnet balance moves through all tiers correctly.

## Phase 5a — Service base: general and reusable (1–2 weeks)
- Small web server with a per-request payment endpoint (x402 or USDC invoice), with no job logic in it
- Card payments via Stripe Checkout (cards, Apple Pay, Google Pay) alongside x402/USDC. Hosted checkout
  only, the agent never sees card data; confirm payments via signed webhooks. Stripe account is owned
  by the owner. Use Stripe test mode until Phase 8. The Stripe secret key and webhook signing secret
  fall under CLAUDE.md rule 5 (never printed, logged or committed).
- Stripe in Cyprus likely settles in EUR; decide conversion rule or EUR ledger. (The ledger counts
  only USD entries for now; others are stored but not counted.) Stripe webhook writes
  `stripe_revenue` / `stripe_fee` / `stripe_refund` ledger entries, idempotent on the event id,
  with `livemode` from the event.
- Own VPS + domain + HTTPS; replace `exposePort` (reverse proxy, e.g. Caddy) to get a public URL
- Revenue vs cost tracking (general plumbing)
Done when: a placeholder endpoint is reachable at the public HTTPS URL and accepts a testnet payment
within the limits, and a Stripe test-mode payment, confirmed by a signed webhook.

## CHECKPOINT — base template
- [ ] Tag `base-v1`. STOP and tell the owner: the base template is ready. Explain how to create a new
      agent repo from `base-v1`, then continue building this agent's job only after the owner confirms.
- Later general improvements (Phases 6–8) go into the base and get a new tag (`base-v2`, …), not into
  job code.

## Phase 5b — Job-specific service (2–4 weeks, ongoing)
- Pick ONE narrow, legal, automatable service
- Build it in `src/services/<job>/` plus its genesis prompt, skills and config (see CLAUDE.md rule 7)
- Agent operates, monitors and improves the service; honest, policy-compliant promotion only
Done when: at least one real paying customer; known whether it covers its own cost.

## Phase 6 — Self-modification (2–3 weeks)
- Git-versioned agent workspace; every change is a commit with a reason
- Protected files enforced by permissions and tool checks
- Pipeline: propose → tests pass → apply → auto-rollback if unhealthy
- Rate limits on changes; skills preferred over core edits; audit CLI with diffs
Done when: agent adds a working skill itself; protected edits blocked; broken change auto-reverted.

## Phase 7 — Replication & social (2–3 weeks, optional)
- Spawn flow with inherited constitution and limits; lineage tracking; inbox relay (untrusted input)
- Hard caps: max children, max generations, total family budget; family kill switch
- Start with cap of 1 child, 1 generation, testnet only
Done when: one child runs; spawning beyond cap is blocked; kill switch stops all.

## Phase 8 — On-chain identity & launch (1–2 weeks)
- ERC-8004 registration (re-check current spec); agent card with service and pricing
- Security review: keys, payment limits, injection defenses, open ports
- Base mainnet with an amount the owner can afford to lose. Owner only: set `"network": "mainnet"` in
  `automaton.json` and `AUTOMATON_MAINNET_APPROVED=<this agent's wallet address>` in the supervisor's
  environment (not in a file the agent can write); check the RPC URL points at Base mainnet
- VAT/tax setup checked with an accountant before taking real card payments.
- Alerts: tier changes, unusual spend, crashes, self-edits, spawns
Done when: 2 weeks on mainnet within budget; every alert tested; every action auditable.

## Risks
| Risk | Mitigation |
|---|---|
| Agent never earns enough | Choose the service in Phase 0 |
| Runaway model costs | Code-level caps + provider dashboard limits |
| Leaked private key | Encrypted storage, small balances, never in logs/prompts |
| Prompt injection | Untrusted-input handling, tool limits, payment allowlist |
| Bad self-modification | Tests, rollback, protected core |
| Conway platform changes | Replace Conway dependencies with own providers |
| Legal or tax issues | Check local rules before real money; follow provider policies |
