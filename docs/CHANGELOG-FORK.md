# Fork changelog

- 2026-11-10: Forked from Conway-Research/automaton @ d8f8168. Added CLAUDE.md (project rules + Phase 0 findings).
- 2026-11-10: Added docs/ROADMAP.md (full phase plan with Phase 0 progress).
- 2026-11-10: **Planned change 1: tightened `DEFAULT_TREASURY_POLICY`** (`src/types.ts`) for minimum cost
  and small balances. Every value is the same or stricter, none looser:
  | Field | Upstream | Fork |
  |---|---|---|
  | maxSingleTransferCents | 5000 ($50) | 500 ($5) |
  | maxHourlyTransferCents | 10000 ($100) | 1000 ($10) |
  | maxDailyTransferCents | 25000 ($250) | 2000 ($20) |
  | maxX402PaymentCents | 100 ($1) | 50 ($0.50), so the x402 envelope is $5/hr and $25/day |
  | maxTransfersPerTurn | 2 | 1 |
  | maxInferenceDailyCents | 50000 ($500) | 500 ($5) |
  | requireConfirmationAboveCents | 1000 ($10) | 100 ($1) |
  These are unchanged: minimumReserveCents 1000, x402AllowedDomains `['conway.tech']` (to revisit in
  changes 2 and 3), and transferCooldownMs 0 (no code reads it).
  Tests: `financial.test.ts` and `spend-tracker.test.ts` now use a fixed `UPSTREAM_TEST_POLICY` fixture,
  so their rule-logic tests don't depend on the defaults. `general-harness.test.ts` (per-turn transfer
  counting) uses an explicit `maxTransfersPerTurn: 2` test policy. `authority-rules.test.ts` asserts the new defaults.
  No limit was loosened to make a test pass.
  Note: `maxInferenceDailyCents` doesn't limit main-loop inference, because no code records spend in the
  `inference` category. The real inference caps are in change 1b.
- 2026-11-10: Docs: $5 total testing budget and the temporary Windows test baseline added to CLAUDE.md.
  New Phase 1 tasks in ROADMAP.md, including the HIGH PRIORITY tokenizer hang.
- 2026-11-10: **Added 6 Claude Code skills from ECC** (https://github.com/affaan-m/ecc, commit `d2ef268`,
  MIT License, (c) 2026 Affaan Mustafa) to `.claude/skills/`:
  `verification-loop`, `agent-security-hardening`, `cost-aware-llm-pipeline`, `typescript-patterns`,
  `ecc-security-review`, `evm-token-decimals`.
  - We copied only these skill folders. We ran no install script and added no ECC hooks, agents,
    commands or settings. The temporary clone was deleted afterwards.
  - Left out: `llm-trading-agent-security`. Its example limits ($500/transaction, $2,000/day), its
    private-key-from-env pattern and its mainnet Flashbots RPC conflict with CLAUDE.md, and trading is
    not our service.
  - Renamed `security-review` to `ecc-security-review` (folder and `name:`), so it doesn't hide the
    built-in `/security-review`. `agent-security-hardening` still refers to it by its old name.
  - Content edits:
    - `verification-loop` Phase 5 no longer prints matching lines (it could have printed a real
      secret, see CLAUDE.md rule 5). It now lists file paths only, in PowerShell.
    - `evm-token-decimals` no longer falls back to 18 decimals. If `decimals()` fails it now fails
      closed: a guess would misstate USDC (6 decimals) by a factor of 10^12.
  - Added a "Project overrides (see CLAUDE.md)" section to the flagged skills: `verification-loop`,
    `evm-token-decimals`, `ecc-security-review`, `typescript-patterns` and `cost-aware-llm-pipeline`.
    These cover PowerShell instead of bash, pnpm instead of npm, the test baseline, no repo-wide
    formatting, no `tsconfig` migration or dependency upgrades without approval, testnet only, and our
    spending limits. `agent-security-hardening` was clean and is unchanged.
  - CLAUDE.md wins on any conflict with these skills.
- 2026-11-10: **Base agent template checkpoint** (docs only). ROADMAP Phase 5 is split into:
  - 5a: the general service base (web server, payment endpoint, VPS, public URL replacing `exposePort`)
  - a CHECKPOINT: tag `base-v1`, stop and tell the owner how to create a new agent repo from it, and
    continue only after they confirm. Later general improvements get new tags (`base-v2`, …).
  - 5b: the job-specific service

  CLAUDE.md gets rule 7, "Reusable base": job code goes in `src/services/<job>/`, genesis prompt, skills
  and config; prefer settings over hardcoded values; warn the owner when a change would tie the base to
  one job; one wallet per agent, keys never shared.
- 2026-11-10: **Change 1b: cheap default models.** The routing matrix (`src/inference/types.ts`) chose the
  model, not the config, so a normal-tier turn always went to `gpt-5.2` ($1.75/$14 per M tokens).
  - The new defaults use the cheapest capable models: `gpt-4.1-mini` ($0.40/$1.60) for turns, planning,
    safety checks and summaries, and `gpt-4.1-nano` ($0.10/$0.40) for heartbeat triage and the
    low_compute/critical tiers. The high tier tries `gpt-4.1-mini` first and falls back to `gpt-5-mini`.
    No default route uses `gpt-5.2` or `gpt-5.3` any more.
  - We prefer `gpt-4.1-mini` over `gpt-5-mini` because it is cheaper per token, and `gpt-5-mini`
    bills hidden reasoning tokens as output. Prices are from the unchanged `STATIC_MODEL_BASELINE`
    and are not verified against OpenAI's current price list.
  - `DEFAULT_MODEL_STRATEGY_CONFIG` (both copies) and `DEFAULT_CONFIG.inferenceModel` now default to
    `gpt-4.1-mini` / `gpt-4.1-nano`, with matching fallbacks in `config.ts` and `index.ts`.
  - `InferenceRouter.selectModel` change: when the matrix explicitly lists no candidates (critical
    summarization and planning), the config fallback may only pick free models. Without this, the new
    `criticalModel` (`gpt-4.1-nano`, tierMinimum critical) would have turned those tasks back on.
    Before, the old `gpt-5-mini` was blocked by its tier minimum.
  - Unchanged: the deprecated `survival/low-compute.ts` and `setLowComputeMode` fallbacks (the router
    no longer uses them). Groq/Ollama setups still get the OpenAI baseline from the matrix, which
    needs its own design.
- 2026-11-10: **Change 1c: real inference budgets, $1/day cap for testing.**
  Before this change, `InferenceBudgetTracker` had no daily check, and every limit defaulted to 0 (no limit).
  | Setting | Before | After |
  |---|---|---|
  | `modelStrategy.dailyBudgetCents` (new) | – | 100 ($1/day, UTC day) |
  | `modelStrategy.hourlyBudgetCents` | 0 | 25 |
  | `modelStrategy.perCallCeilingCents` | 0 | 5 |
  | `modelStrategy.sessionBudgetCents` | 0 | 0 (unchanged; session id is often `"default"`, so a cap would be a lifetime cap) |
  | `treasuryPolicy.maxInferenceDailyCents` | 500 | 100 |
  - The loop enforces whichever daily cap is stricter, the model-strategy one or the treasury one
    (`resolveDailyInferenceCap`). A saved config with a looser value in one place is still limited
    by the other.
  - Router cost estimate: it now uses the real call's `maxTokens` (before, it assumed 1000 output
    tokens while calls could use 4096 to 8192) and counts the tool schemas sent with each request.
  - Budget stop in the loop: when the router refuses a call, the loop now records no turn, puts
    claimed inbox messages back, and sleeps until the next UTC hour (at least 5 minutes). Before, it
    spun through up to 25 empty turns and slept only 2 minutes.
  - `configure` asks for the daily budget.
  - Tests:
    - New: daily cap allow and deny, the router refusing without calling the model, the estimate
      using the preference's `maxTokens`, `resolveDailyInferenceCap`, and the loop budget stop.
    - Four existing tests checked one limit while assuming all the others were 0. They now set the
      other limits to 0 explicitly. The inference-cap rule test spends 50 instead of 100 to stay under
      the new 100 cap. No production limit was loosened.
  - Still open (ROADMAP Phase 1): calls that bypass the router (compression, planner, orchestrator,
    plan-mode, summarization, harnesses) are not capped yet. Old saved `modelStrategy` values still
    override the defaults. Recorded costs are rounded up to whole cents per call (at least 1¢), which
    overcounts, so it errs on the safe side.
- 2026-11-10: **Docs: card payments added to the plan.**
  - ROADMAP Phase 5a: card payments via Stripe Checkout (cards, Apple Pay, Google Pay) alongside
    x402/USDC. Checkout is hosted, so the agent never sees card data. Payments are confirmed by signed
    webhooks. The owner owns the Stripe account, and we use test mode until Phase 8. Stripe secrets
    fall under CLAUDE.md rule 5. "Done when" now also needs a Stripe test-mode payment confirmed by a
    signed webhook.
  - Change 3 (CLAUDE.md) and ROADMAP Phase 3: the balance/ledger must count both USDC and Stripe revenue.
  - ROADMAP Phase 8: VAT/tax setup checked with an accountant before taking real card payments.
- 2026-11-10: **Change 2: Base Sepolia testnet mode, default until Phase 8.**
  - New `src/identity/network.ts` decides the network. Testnet is the default and the fail-closed state.
    Mainnet needs both `"network": "mainnet"` in `automaton.json` and
    `AUTOMATON_MAINNET_APPROVED=<this agent's wallet address>` in the environment, read once at
    start-up. Tying the approval to the wallet address means it can't carry over to another agent.
    If mainnet is set without a matching approval, or the value is unknown, the agent refuses to start.
  - Start-up checks that a configured RPC URL serves the active chain id, and refuses to start if not.
  - x402: `signPayment` refuses any network except the active one, so a server asking for mainnet gets
    no signature. Requirement selection prefers the active network. Balance reads default to the
    active network.
  - Conway credit top-ups are disabled in testnet mode, because Conway sells credits for real USDC
    on Base mainnet.
  - ERC-8004: the defaults follow the active network, and `registerAgent`, `updateAgentURI` and
    `leaveFeedback` throw on any other network before any RPC call. Discovery still reads either.
  - Hardcoded `eip155:8453` in these places now follows the active network: the tools, the loop, the
    heartbeat, the agent card and the status output. `configure` shows the network read-only and
    can't switch to mainnet.
  - Not changed: `chainId: 8453` in the Conway sign-in (`provision.ts`, `client.ts`), which moves no
    money; the schema defaults (inserts set `chain` explicitly); Solana paths.
  - **The agent can't set its own environment for the next start** (owner-approved policy change,
    stricter only):
    - `isProtectedFile` (`self-mod/code.ts`) now also blocks writes (via `write_file` and
      `edit_own_file`) to `.env*`, `.envrc`, pm2 ecosystem files and `~/.pm2/`, systemd units and
      `systemd/` dirs, shell profiles (`.bashrc`, `.profile`, `.zshrc`, …), `/etc/environment`,
      `/etc/profile*`, `/etc/default/`, cron, `.npmrc`, Docker/Compose files, `start*/run*/entrypoint*`
      scripts and `scripts/automaton.sh`. Matching is by file name, so it works with any OS path
      format. `automaton.json` was already protected.
    - New `command.forbidden_patterns` entries block any shell command that mentions
      `MAINNET_APPROVED`, sets any `AUTOMATON_*` variable, references those files (or
      `automaton.json`), or changes supervisor or environment config: `--update-env`,
      `pm2 set/start/save/…`, `systemctl edit/set-environment/…`, `crontab`, `setx`,
      `SetEnvironmentVariable`, the registry environment keys.
    - The inline `exec` guard in `tools.ts` now also checks the policy list, so it's never weaker.
    - Limit: a regex blocklist is best-effort. ROADMAP Phase 1 (shell only in Docker, non-root) is the
      hard boundary.
  - Tests: new `network.test.ts` (69 tests). It covers network resolution and approval, x402 refusing
    mainnet and signing Sepolia, top-up refused, ERC-8004 writes blocked, a write blocked for each
    start-up/env file, each blocked shell command (including setting `AUTOMATON_MAINNET_APPROVED`),
    and ordinary files and commands still allowed.
  - Known gap: the ERC-8004 testnet contract addresses equal the mainnet ones in `erc8004.ts`, and
    we couldn't verify them. On testnet a wrong address only wastes test ETH. Re-check in Phase 8.
- 2026-11-11: **Change 3, part 1: local ledger.** A new append-only `ledger_entries` table
  (migration V12) records off-chain money in USD cents. On-chain USDC is never entered here, so
  nothing is double counted.
  - Kinds: owner grant/withdrawal, inference cost, hosting cost, and Stripe revenue/fee/refund
    (Stripe is planned in for Phase 5a, not built). Corrections are `adjustment` entries.
  - The schema enforces the sign for each kind and whole cents. Triggers block UPDATE and DELETE.
    `UNIQUE(source, external_id)` makes webhook replays and double records no-ops.
  - Each entry has a `livemode` flag. Testnet counts every entry; mainnet counts only real money.
    Only USD is counted; other currencies are kept but flagged.
  - `InferenceBudgetTracker.recordCost` writes the cost row and a real-money `inference_cost` debit in
    one transaction, so the ledger keeps it when `inference_costs` is pruned. The migration backfills
    earlier inference costs.
  - The agent has no tool that writes to the ledger. The owner uses the new
    `automaton-cli ledger [show | grant <amount> | adjust <±amount> --memo]`.
  - Tests: `ledger.test.ts`.
- 2026-11-11: **Change 3, part 2: lifetime real-money inference cap.** New setting
  `modelStrategy.lifetimeBudgetCents` (default 500 = the $5 testing budget; 0 = no limit).
  - Why: testnet USDC can keep the survival balance up while the agent spends real money on
    inference. This cap stops paid inference once the all-time total reaches the limit, whatever
    the balance.
  - `checkBudget` blocks any paid call (estimate > 0) that would take the lifetime total past the
    cap. Free/local models (estimate 0) still run.
  - The total comes from the append-only ledger, so pruning `inference_costs` can't reset it. Old
    saved configs without the field get the 500¢ default. `configure` asks for it.
  - Tests: `inference-lifetime-cap.test.ts`. The "no limits" test in `inference-router.test.ts`
    now sets the lifetime cap to 0 as well.
