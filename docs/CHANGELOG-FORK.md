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
- 2026-11-11: **Change 3, part 3: own balance source and survival tiers.**
  - New `src/survival/balance.ts`. The default `balanceSource: "own"` is wallet USDC on the active
    network plus the ledger. `"conway"` keeps upstream Conway credits.
  - A failed wallet read is never counted as 0. It falls back to the last good value for the same
    network and wallet ("cached"), or reports "unavailable". USDC is rounded down to whole cents.
  - Owner decisions: testnet USDC counts toward survival in testnet mode, there is no automatic grant
    (`automaton-cli ledger grant`), and a negative balance means dead right away.
  - **The loop**, using the balance source:
    - The `-1` "API unreachable" sentinel is replaced by `balanceStatus: "unavailable"`, which means
      low-compute mode with no tier change.
    - The inline Conway top-up only runs in Conway mode, as does the startup bootstrap top-up in
      `index.ts`.
  - **The heartbeat**:
    - The tick context reads the configured source. On "unavailable" it keeps the last tier.
    - `check_credits` doesn't start the dead timer on "unavailable".
    - The auto top-up only runs in Conway mode, and the funding hints point to USDC or
      `automaton-cli ledger grant`.
  - **The monitor and funding strategies** read the balance source.
  - **One tier calculation:** `system-prompt.ts` (was 50/10/0¢) and `planner-context.ts` (was
    5000/100/0¢, labels low/stable/comfortable, negatives clamped to 0) now use `getSurvivalTier`.
  - `FinancialState` gains `balanceCents`, `walletUsdcCents`, `ledgerCents`, `balanceStatus`,
    `balanceSource` and `network`. `creditsCents` stays as a deprecated alias for the total.
  - New read-only tool `check_balance`. `heartbeat_ping` and `distress_signal` use the balance source.
    Conway tools (`check_credits`, `transfer_credits`, `fund_child`, top-ups) are unchanged.
  - Bug found by a test and fixed before commit: the wallet cache is keyed by network and address.
  - Tests: new `balance.test.ts`. It covers rounding, live/cached/unavailable, per-network and
    per-wallet cache, testnet vs mainnet ledger, a tier walk from high to dead, the heartbeat,
    planner and prompt tiers, `check_balance`, and the loop (unavailable means low-compute, no
    Conway top-up). The shared `createTestConfig` fixture now sets `balanceSource: "conway"`, because
    the upstream tests model a Conway-hosted agent with mock credits.
  - ROADMAP 5a note: Stripe in Cyprus likely settles in EUR; decide a conversion rule or an EUR ledger.
- 2026-11-11: **Change 3, part 4: stricter shell rules for the ledger** (owner-approved policy change,
  stricter only). `command.forbidden_patterns` now blocks any shell command that mentions
  `ledger_entries`, opens `state.db` with sqlite, or references `state.db` at all. The `exec` inline
  guard picks these up through the shared list. Without this, the agent could insert a fake
  `owner_grant` from the shell. Other databases (e.g. an app's own `data.db`) are still allowed.
  Tests: `command-safety-ledger.test.ts`.
- 2026-11-11: **Phase 1: every model call goes through the budget tracker and the ledger.**
  Before this, only the main loop's `InferenceRouter` checked the caps. The orchestrator, planner and local
  workers called `UnifiedInferenceClient` directly: no cap, no cost record, no ledger debit.
  - **Step 1, `MeteredInferenceClient`** (`src/inference/metered-client.ts`): wraps the unified client.
    - Before each call, it checks the worst-case estimate over the tier's candidate models.
    - After the call, it records the real cost with a ledger source (`orchestrator`, `worker`).
    - A refusal throws `InferenceBudgetExceededError`, and the model is never called.
    - If `maxTokens` is missing, the output cap keeps the call within the per-call ceiling (5¢) on the
      tier's priciest model.
    - Prices are $/1M tokens. A remote model is never priced below its built-in price, so editing
      `inference-providers.json` can't lower it. A zero or unknown price is charged at the highest
      built-in price. Only loopback providers are free.
    - A paid call that reports no usage is charged at its estimate.
    - Found by a test: `llama3.1:8b` ships priced at 0 as a local model, so a remote provider serving it
      would have been free. Fixed before commit.
  - **Step 2, reservations:** `InferenceBudgetTracker.tryReserve` checks every cap (incl. session) and
    reserves the estimate until the cost is recorded, so parallel calls can't all pass first.
    Both the router and the metered client use it.
  - **Step 3, wiring and pause** (owner decision):
    - `loop.ts` gives the orchestrator and the worker bridge metered clients that share the main
      loop's tracker.
    - On a budget refusal, the orchestrator keeps its phase and pauses until the next budget window
      (next UTC hour, at least 5 min). It never fails the goal, falls back to a guessed plan or replans.
    - Workers put the task back to pending and pause. Harnesses rethrow without retrying.
    - The pause is stored in kv (`inference.budget_pause_until`) and survives a restart. The main loop
      sets it too when the router refuses a turn.
  - **Step 4:** `summarizeTurns` now calls `router.route` (taskType `summarization`; critical tier = free
    models only). Not yet called in production.
  - **Step 5:** `inference-chokepoint.test.ts` scans `src/`. It allows raw clients and direct model API
    access only in the client layer, and every `.chat()` call site must be on a list with an exact count.
    We checked that it catches a bypass.
  - Not changed (owner decision): the policy rule `financial.inference_daily_cap`.
  - Tests: `metered-client`, `budget-reservation`, `orchestration/budget-pause`,
    `summarize-turns-routing`, `inference-chokepoint`. Full suite: 22 known Windows failures, nothing new.
- 2026-11-11: **Fixed the tokenizer hang (Phase 1, HIGH PRIORITY), commit `f560a96`.**
  - js-tiktoken is quadratic on long whitespace-free runs, so one large tool result could block the loop
    for minutes. `createTokenCounter` (`src/memory/context-manager.ts`) now encodes runs longer than
    64 chars in 64-char slices. Above 50k chars it counts the first 50k and scales by total length.
    Texts over 10k chars are no longer cached.
  - Measured worst case (plain letters): about 3.4 ms per 1,000 chars, 170 ms at the limit. The
    previously approved values (512-char slices, 200k limit) were rejected after timing, because they
    allowed about 5 s per call.
  - Accuracy: exact for normal text; at most +0.5% on base64; within 10% above the limit.
  - `estimateTokens` keeps its `length/4` floor, so loop estimates are never below length/4. The floor
    is not applied inside the counter: plain letters (8 chars/token) and English (5 chars/token) would
    be overcounted by up to 100%.
  - Tests: `memory/token-counter-bounds` covers base64, plain letters and normal words above the limit,
    plus surrogate pairs and caching.
  - `context-hardening.test.ts` runs again. It showed 3 stale status-block tests, which also fail on
    unchanged code, so they are now known failures and a ROADMAP item. New baseline: 1795 passed,
    25 failed; the exclusion was removed from CLAUDE.md.
  - Not changed (owner decision): `estimateTurnTokens` still counts the full tool result. This is now
    a separate ROADMAP item.
  - Owner decision: the `length/4` floor stays in `estimateTokens`, not in the counter.
- 2026-11-11: **Updated the 3 stale status-block tests** (`context-hardening.test.ts`, commit `ddc79b9`).
  The prompt was correct; the tests were outdated (owner decision). They now expect `Balance: $50.00`
  and the `getSurvivalTier` tiers: 5000 cents is `high`, 0 is `critical`, a negative balance is `dead`.
  A `normal` case (100 cents) was added. Baseline is back to the 22 Windows failures only:
  1798 passed, 22 failed.
- 2026-11-11: **Linux test run in Docker (Phase 1), commit `e15a727`.** No agent code changed.
  - `pnpm test:linux` builds `docker/test.Dockerfile` (`node:22.21.1-bookworm-slim`, pnpm 10.28.1,
    non-root `node` user) and runs `pnpm build` plus the full vitest suite. The exit code is passed through.
  - `.dockerignore` is an allowlist (src, packages, package/lock/workspace files, tsconfig, vitest config,
    constitution, scripts). `.env`, `.automaton/`, wallet and db files, `.git`, `.claude/` and the Windows
    `node_modules` never enter the image (checked inside the image). No bind mounts and no env vars, so
    the run cannot touch the host or spend money. The container has network access, as on Windows.
  - **Linux baseline: 1820 passed, 0 failed (75 files).** All 22 Windows path failures pass on Linux,
    so they are Windows-only. Windows is unchanged: build passes, 1798 passed, 22 failed.
  - CLAUDE.md now uses the Linux run as the main baseline and keeps the Windows numbers as a secondary check.
  - Later (owner decision): an offline variant (`--network none`), together with the RPC mock item.
- 2026-11-12: **Agent in Docker: runtime + sandbox containers (Phase 1).** Commits `34e383c` (step 1),
  `e00c0d0` (step 2), `b5317a2` (steps 3–4). Owner-approved: two containers, sandbox without internet,
  read-only config, agent code changes.
  - Why: in local mode the agent's shell ran as the agent's own user with its full environment, so it
    could read `wallet.json` and the API keys; only the regex blocklist stood in the way.
  - **Sandbox container mode** (`"sandbox": { "mode": "container" }`): `exec`, `writeFile` and
    `readFile` go to `src/sandbox/server.ts` over a Unix socket. The runtime never runs them itself and
    never falls back to local on an error. `expose_port` is refused. Local mode is unchanged.
  - **Design change (owner addition 1):** a Unix socket on a shared volume instead of an internal network.
    The sandbox has `network_mode: none`, so it has no route to the runtime at all, and the runtime's
    mount of the socket folder is read-only, so it cannot listen there.
  - **Step 2 caller fixes (owner-approved after the audit):**
    - Worker harnesses: the silent local fallbacks (exec and file ops retried in the runtime after any
      Conway error) are removed in every mode; `list_dir` runs in the sandbox; workers edit only
      `/workspace` in container mode.
    - Skills loader: `which` replaced by a PATH check without a process; container mode skips
      `requires.bins/env` (they describe the sandbox, and the env check could reveal which secrets the
      runtime holds).
    - Skills registry: `git clone`/`curl` run in the sandbox in container mode, every argument quoted.
    - Upstream helper: `git` refused in container mode.
    - Two tests that expected the local fallback now check that it does not happen. The
      `command-injection` loader check now requires that no process is started (stricter).
  - **Docker:** `docker/agent.Dockerfile` (targets `runtime`, `sandbox`), `docker/compose.agent.yml`,
    entrypoint that refuses `AUTOMATON_MAINNET_APPROVED`, keys loaded from `AUTOMATON_SECRETS_DIR` into
    the runtime only, config template `docker/automaton.testnet.json` mounted read-only.
  - **`pnpm agent:verify`: 84 checks, all pass.** It runs in a throwaway project with a fake secret and
    removes it afterwards. It includes owner addition 1 (no interfaces or route in the sandbox,
    `ENETUNREACH` to the runtime IP, no runtime listeners except Docker's own DNS on 127.0.0.11) and
    addition 2 (canary skill full of code: only `SKILL.md` is read, the code never runs).
  - **Guard tests:** `sandbox-chokepoint` (child_process and listeners only in reviewed files),
    `runtime-no-workspace-code` (no dynamic code loading; skills read as text only),
    `container-mode-callers`, `sandbox/server`, `sandbox/client-container-mode`.
  - Testnet wallet created with `pnpm agent:init` in the `automaton_automaton-home` volume (address only
    printed). The agent was not started.
  - Baselines: Linux 1865 passed, 0 failed. Windows 1835 passed, 22 known failures, 8 Linux-only skipped.
  - Found, not fixed (ROADMAP): `--run` still needs a Conway API key; `update_genesis_prompt` and
    `switch_model` fail with the read-only config.
