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
- 2026-11-12: **Blockers before the first real run (Phase 1).** Owner decisions: Groq in the main loop
  later; agent genesis prompt changes off by default; model allowlist = the strategy models;
  `--preflight` approved.
  - **Kill command** (`fa68d14`): `pnpm agent:kill` (`docker/kill-agent.mjs`) finds every container of
    the compose project by label, including one-off `agent:run` containers, kills them in one call
    (SIGKILL) and removes them. Volumes and images are never touched. Exit 0 when nothing is left
    running, also when nothing was running. SQLite WAL keeps committed data. A model call already in
    flight may still be billed (cents, inside the daily cap). `agent:down` stays the graceful stop.
  - **Settings in the database** (`3129292`): migration V13 adds `agent_settings` and an append-only
    `agent_settings_changes` history. The two tools store there instead of `saveConfig`. Owner limits in
    the config (`agentSettings`): genesis prompt off by default (when on: 1/day, max 2000 chars); model
    only from the allowlist (default: the owner's strategy models, taken from the original config so
    the agent can always switch back), max 4/day. At startup a stored value is used only if it still
    meets the current limits. Owner commands: `automaton --settings show|reset`
    (`pnpm agent:settings`, `agent:settings:reset`). Guard: no agent code references `saveConfig`.
  - **Conway off** (`45412db`): new setting `"conway": "on" | "off"` (absent: on with a Conway key,
    otherwise off; the Docker template sets off). With off:
    - no Conway key needed and Conway registration skipped;
    - the Conway client refuses every call before sending;
    - the main-loop model client never uses the Conway backend, and model keys also come from env;
    - x402 to Conway hosts refused (covers top-ups);
    - the Conway social relay is not used;
    - 14 Conway-only tools are hidden and not executable;
    - contradictory settings refuse to start.
  - **`--preflight`**: `run()`'s setup moved to `src/runtime/prepare.ts` (`prepareRuntime`), shared by
    `--run` and `--preflight`. Preflight runs the real startup path plus checks (wallet, read-only RPC
    chain-id call, Conway mode, model providers and keys, sandbox) and exits. No model call, never
    creates a wallet, never prints keys. `inference-chokepoint` now expects the raw model client there.
  - `check_for_updates` is skipped quietly in container mode (it could only fail there).
  - Tests: `agent-settings` (15), `conway-off` (13, including a startup run with a stubbed fetch that
    records zero Conway requests). `agent:verify` 97 checks: kill, settings commands, preflight with no
    Conway key and fake model keys.
  - Baselines: Linux 1893 passed, 0 failed. Windows 1863 passed, 22 known failures, 8 Linux-only skipped.
- 2026-11-16: **First-run genesis prompt** in `docker/automaton.testnet.json` (owner text): test
  instance on Base Sepolia; check status, balance and tier, write a short SOUL.md, list tools, then
  sleep. No earning, contacting, installing or payments.
- 2026-11-16: **Owner ledger commands in Docker: `pnpm agent:ledger`, `pnpm agent:ledger:grant <dollars>`.**
  The ledger CLI (`automaton-cli ledger`) is not in the runtime image, so the owner had no way to add the
  testing grant to `state.db` in the `automaton-home` volume.
  - The show/grant/adjust logic moved to `src/state/ledger-command.ts` (`runLedgerCommand`), shared by
    `automaton-cli ledger` and a new runtime flag `automaton --ledger [show | grant <amount> | adjust
    <±amount> --memo "..."]`. Output and rules are unchanged (grant > 0, max 2 decimals, append-only,
    `livemode` true, source `owner_cli`).
  - Owner only, like `--settings`: the agent has no tool that reaches it, and its shell stays blocked
    from `state.db`. No change to the policy engine.
  - Tests: `ledger-command` (10). `agent:verify` 100 checks (+3: `--ledger show`, `grant 5.00` persists,
    negative amount refused; throwaway volume only).
  - Baselines: Linux 1903 passed, 0 failed. Windows 1873 passed, 22 known failures, 8 Linux-only skipped.
- 2026-11-16: **Fixes from the first testnet run** (owner-approved plan, one commit each).
  - **Creator address from `AUTOMATON_CREATOR_ADDRESS`** (fix 5): the first run had the zero address.
    The env value overrides `creatorAddress` in the config (`src/identity/creator.ts`); the Docker
    template leaves it empty so the owner's address is not committed, and compose passes the variable
    to the runtime only. `prepareRuntime` (`--run` and `--preflight`) refuses an empty, zero, malformed
    or bad-checksum address; preflight prints the creator it uses. Tests: `creator-address` (4),
    `conway-off` (+1). `agent:verify` +2 checks (creator from env; refusal without it).
    Baselines: Linux 1908 passed, 0 failed. Windows 1878 passed, 22 known failures, 8 skipped.
    `agent:verify` 102 checks.
  - **One-off commands clean up after themselves** (fix 7): `docker compose run` started the sandbox
    (`depends_on`) and left it running. New `docker/run-oneoff.mjs` wraps every pnpm one-off command:
    `agent:init`, `agent:ledger*` and `agent:settings*` run with `--no-deps` (they only touch the
    wallet and `state.db`, so the sandbox is never started); `agent:preflight` and `agent:run` stop and
    remove the sandbox afterwards, but only if it was not already running (a live agent's sandbox is
    never touched). Volumes are never removed; the runtime's exit code is passed through; Ctrl+C still
    reaches the runtime for a graceful stop. `agent:verify` 106 checks (+4). Baselines unchanged
    (Linux 1908 passed; Windows 1878 passed, 22 known failures, 8 skipped).
  - **State versioning off in container mode** (fix 4): startup tried to `git init` `~/.automaton`
    through the sandbox and failed with "path outside the sandbox roots". That folder is in the
    runtime (no git there by design) and the sandbox must not reach it. New `initStateVersioning`
    skips it in container mode and logs one info line ("State versioning: off (container mode;
    history is kept in the database)"); local mode is unchanged. The `commit*` helpers had no callers,
    so nothing else used the repo. Open point for fix 3: the `git_*` tools still default to
    `~/.automaton`. Test: `state-versioning-mode` (2). Baselines: Linux 1910 passed; Windows 1880
    passed, 22 known failures, 8 skipped.
  - **Fewer repeated status checks** (fix 1): the first run called `system_synopsis` and
    `check_balance` three times before acting. Causes: the loop dropped every status-only turn from
    the context (so the model never saw it had checked), and the wake-up text and genesis prompt both
    asked for checks. Changes:
    - The wake-up message carries a status snapshot (`src/agent/status-snapshot.ts`): balance, tier,
      network, inference spend today and lifetime against the caps, heartbeats, model, plus "this
      status is current; no status tool needed". The "survey / check your balance" prompts are gone.
    - `selectContextTurns` keeps the most recent status-only turn in the context.
    - `StatusToolCache`: within one wake cycle, a repeated read-only status call (`check_balance`,
      `system_synopsis`, `check_credits`, `check_usdc_balance`, `check_inference_spending`) returns
      the earlier result with an "unchanged, act on it" note and no new RPC read. Any other tool
      call clears it; entries expire after 5 minutes; errors are never cached.
    - Testnet genesis prompt: status and tools come from the given context ("no tool call needed");
      SOUL.md is written with `update_soul`. Same goals and limits as the owner's text.
    Test: `status-snapshot` (7). Baselines: Linux 1917 passed; Windows 1887 passed, 22 known
    failures, 8 skipped. `agent:verify` 106.
  - **Orchestration switch; simple tasks done directly** (fix 2): the first run created an
    orchestrator goal instead of calling `update_soul`, because the orchestration prompt said "you
    MUST call create_goal" and the orchestrator always ran. New setting
    `"orchestration": "on" | "off"` (`src/agent/orchestration-mode.ts`; absent = on, upstream
    behavior; the Docker template sets off). With off: no orchestrator, plan mode or local worker
    pool (so no worker model spend), no orchestration/turn-protocol prompt or orchestrator status
    block, and the 13 goal and child tools are hidden and not executable. With on: the rule is now
    "do it directly when it takes 3 tool calls or fewer, or is soul/worklog/heartbeat/config/memory,
    a creator reply, survival or a health check; create_goal only for multi-step work", plus an
    `update_soul` example; the phase is read from the status block instead of a tool call. Preflight
    shows the mode and hidden count. Test: `orchestration-mode` (4). Baselines: Linux 1921 passed;
    Windows 1891 passed, 22 known failures, 8 skipped. `agent:verify` 106.
  - **Fewer tokens per turn** (fix 3): the first run used ~10k input tokens per turn, mostly tool
    definitions. Measured with the testnet config (o200k): fixed input per call ~10k before fix 2,
    7.2k after it (4,261 tool schemas for 56 tools + 2,895 system prompt, of which 1,383 a duplicate
    text tool list), now ~2.3k (837 for 10 tool schemas + 1,511 system prompt). Changes:
    - New setting `toolAllowlist` (`src/agent/tool-allowlist.ts`; absent = all tools). Applied after
      the Conway and orchestration filters, so a tool not listed is neither offered nor executable.
      Startup (`--run`, `--preflight`) refuses unknown/hidden names or a list without `sleep`.
    - Testnet template (owner-approved list): `exec`, `read_file`, `write_file`, `check_balance`,
      `sleep`, `update_soul`, `view_soul`, `remember_fact`, `recall_facts`, `switch_model`. Left out:
      tools that cannot work in container mode (ports, installs, `git_*` on `~/.automaton`, which
      closes the fix 4 open point), status tools covered by the wake-up snapshot, later-phase tools.
      `modify_heartbeat` left out by the owner (could raise wake-up frequency); re-enabling it with
      an owner-set minimum interval and max wake-ups per day is now a Phase 5b roadmap item.
    - The system prompt no longer repeats every tool's description (they are in the tool
      definitions); one line names the dangerous tools.
    - Fixed prompt layers (rules, constitution, genesis, skills, environment) now come before soul,
      worklog and status, so the identical prefix is longer for provider prompt caching.
    - Per-turn `[TOKENS]` log line (system / tools / history+input estimates). Preflight shows how
      many tools the allowlist hides.
    Tests: `tool-allowlist` (3), `conway-off` (+allowlist refusal). The template's own list is
    checked by `agent:verify` (preflight). Baselines: Linux 1924 passed; Windows 1894 passed, 22
    known failures, 8 skipped. `agent:verify` 106.
  - **Sub-cent accounting in millicents** (fix 6, owner-approved change to spending-limit code): every
    call was rounded up to a whole cent, so the first run's ledger showed $0.06 for about $0.02 of
    real spend. Amounts are now exact in millicents (1 mc = 1/1000 cent = $0.00001), rounded up per
    call, so the ledger can still never show less than the real cost.
    - Schema V14 (`applyMigrationV14`): nullable `inference_costs.cost_mc` and
      `ledger_entries.amount_mc`, added only where missing. No existing row is changed (the ledger
      stays append-only); older rows count as cents × 1000. New rows keep the cents column as the mc
      amount rounded away from zero, so the existing sign CHECKs hold; a new CHECK keeps the mc sign
      equal to the cents sign. `insertLedgerEntry` refuses an inconsistent pair.
    - Pricing: `costMcCeil` (metered client: orchestrator, workers) and `costMcFromPer1k` (router:
      main loop) compute estimates and actual costs in mc; `recordCost` stores both units.
    - Caps: the per-call, hourly, daily, session and lifetime checks, and the in-flight reservations,
      are compared exactly in mc against the owner's cent caps (cap values unchanged; no cap
      loosened). Cents helpers round spend UP and the ledger balance DOWN.
    - Display: `pnpm agent:ledger`, the wake-up status and `check_balance` show exact amounts
      (e.g. `-$0.00312`); whole-cent amounts still print as `$5.00`.
    - Prompt caching discounts (cached input tokens) are not used to lower the recorded cost: it
      stays conservative.
    Tests: `sub-cent-accounting` (10); `ledger`, `inference-router` and others updated for the
    exact amounts. Baselines: Linux 1934 passed; Windows 1904 passed, 22 known failures, 8 skipped.
    `agent:verify` 106.
- 2026-11-16: **Testnet runs (owner-started, Base Sepolia, OpenAI).**
  - **Run 1** (first real run, before the fixes above): worked end to end. OpenAI charged $0.02; the
    ledger recorded $0.06 (every call rounded up to 1¢). Issues found: `system_synopsis` and
    `check_balance` called 3 times before acting; an orchestrator goal created instead of
    `update_soul`; ~10k tokens per turn, mostly tool definitions; "State repo init failed: path
    outside the sandbox roots"; creator address 0x000…; one-off commands left the sandbox running.
    Fixed in `09f6f44`, `12d5b04`, `c918070`, `c2ff04a`, `c086b54`, `c745d95`, `922d138`.
  - **Run 2** (after `922d138`): 2 turns, ~3k tokens each; SOUL.md written with `update_soul`;
    `write_file` to SOUL.md correctly blocked; slept on its own; cost $0.00311 (exact, millicents).
    Leftovers: `pnpm agent:down` left the `agent:run` runtime container running ("Network
    automaton_egress: Resource is still in use"; the owner used `agent:kill`), and `recall_facts`
    returned a stale fact from run 1 (a `system_synopsis` snapshot with creator 0x000…). Both are
    fixed in the next commits.
- 2026-11-16: **Graceful `pnpm agent:down`, including the `agent:run` runtime** (run-2 leftover).
  `docker compose down` does not stop one-off `compose run` containers, so the runtime kept running and
  the network stayed in use. New `docker/down-agent.mjs`:
  1. SIGTERM to every running runtime container of the project (one-off included), 30 s grace;
     reports per container: stopped gracefully (exit 0) or force-stopped at the timeout (exit 137,
     script exits 1);
  2. stops the sandbox and any other project container;
  3. removes the stopped containers and runs `compose down --remove-orphans` (network). Never `-v`.
  The runtime's SIGTERM handler now admits no new model call (`tryReserve` refuses while shutting
  down) and waits up to 20 s until every call that already ran has its cost recorded, then saves the
  state as sleeping and exits. Before, it exited at once, so a call billed by the provider could be
  missing from the ledger. In-flight calls are counted process-wide from the existing budget
  reservation (`src/inference/in-flight.ts`), released only after `recordCost`. No cap changed.
  Tests: `in-flight-shutdown` (6). `agent:verify` 111 (+5: one-off runtime stand-in stopped by
  SIGTERM with exit 0, nothing left, network removed, volumes kept, a SIGTERM-ignoring stand-in
  force-stopped and reported). Baselines: Linux 1940 passed; Windows 1910 passed, 22 known failures,
  8 skipped.
- 2026-11-16: **No status snapshots as long-term facts** (run-2 leftover). Memory ingestion saved the
  output of `system_synopsis`, `check_credits` and `check_usdc_balance` as permanent facts; run 2's
  `recall_facts` returned a run-1 synopsis with creator 0x000…, and the memory block also loads
  "self" facts automatically on turns without input.
  - Ingestion no longer stores these (status is only true at that moment; the wake-up message
    carries the current status). Error learning and `discover_agents` are unchanged.
  - Schema V15 deletes exactly those three keys (`self/system_synopsis`,
    `financial/last_known_balance`, `financial/usdc_balance`); other facts are kept. On the owner's
    volume it runs the next time a command opens the database.
  - `recall_facts` and the memory block show each fact's last-updated day, so old facts are
    recognizable; `remember_fact` says not to store current status.
  Tests: `stale-status-facts` (3); `memory` test updated (status output is no longer stored).
  Baselines: Linux 1943 passed; Windows 1913 passed, 22 known failures, 8 skipped. `agent:verify` 111.
- 2026-11-16: **Testnet run 3: restart test** (owner-started, after `11b1cf0`).
  - Stopped with `pnpm agent:down` and started again. **State survived**: balance continued at $4.93,
    soul continued from version 5. ROADMAP Phase 1 "restart loses no state" is met.
  - **Sandbox held**: `ls /root/.automaton` from the agent's shell got "Permission denied".
  - **But the run looped for 25 turns (~4.7¢)** until the cycle limit forced sleep: the genesis prompt
    ("This is your first run… write a short SOUL.md") is read on every wake, so the agent redid the
    first-run tasks; `write_file` SOUL.md was tried 12 times (correctly blocked), `read_file` SOUL.md
    said "not found" (the soul lives in the runtime, not the sandbox), `update_soul` ran 8 times in one
    wake, and "Repetitive pattern detected" was logged 4 times without effect. "SOUL.md content changed
    since last load" was logged after every `update_soul`. Also found while planning: after the cycle
    limit the agent slept only 2 minutes, so the loop could restart until the daily cap.
  - Fixes follow in the next commits (owner-approved plan).
- 2026-11-16: **One-time setup is not repeated on every wake** (run-3 fix B).
  - The wake-up status now says what is already done (`src/agent/wake-state.ts`): "SOUL.md: exists,
    version N, last updated <day> (view_soul / update_soul; don't rewrite it without a real change)"
    or "SOUL.md: not written yet", and "Last wake ended: <reason> (<time> UTC)". The loop records
    the wake start (kv `wake_cycle_started_at`, also used by the per-wake soul limit) and the reason
    at every exit: agent chose sleep, cycle limit, idle, budget cap, loop enforcement, errors, etc.
  - Testnet genesis prompt reworded from a first-run script into standing rules for every wake:
    write SOUL.md only if the status says it is not written yet, otherwise don't rewrite it unless
    something important changed; then sleep. Same limits as before (no earning, contacting,
    installing or payments).
  Tests: `status-snapshot` (+2), `loop` (wake start and end reason recorded). Baselines: Linux 1945
  passed; Windows 1915 passed, 22 known failures, 8 skipped. `agent:verify` 111.
- 2026-11-16: **SOUL.md messages explain how the soul is managed** (run-3 fix C). In the restart test
  `write_file` SOUL.md was tried 12 times and `read_file` SOUL.md said "not found" (the soul lives in
  the runtime, not the sandbox).
  - `write_file` to SOUL.md is blocked exactly as before (`isProtectedFile` unchanged); the message now
    adds "SOUL.md is not a sandbox file: it is managed with update_soul (change) and view_soul (read);
    it exists (version N, last updated <day>). Don't retry with write_file, read_file or exec."
    Other protected files keep the plain message.
  - `read_file` of any path named SOUL.md returns the same explanation without calling the sandbox.
  Tests: `soul-path-messages` (4; the 2 write_file tests are Linux-only because `/root` confinement
  uses `path.resolve`, the same cause as the known Windows failures). Baselines: Linux 1949 passed;
  Windows 1917 passed, 22 known failures, 10 skipped (8 sandbox + 2 new). `agent:verify` 111.
- 2026-11-16: **Repeat guard and 30-minute forced sleep** (run-3 fix D). The old detector compares whole-
  turn tool sets; the agent mixed `write_file`, `read_file` and `update_soul`, so it only warned (4×)
  and the run went to the 25-turn limit. After that limit the agent slept only 2 minutes.
  - New `RepeatGuard` (`src/agent/repeat-guard.ts`), per wake cycle: force sleep when one tool fails
    `maxRepeats` times (policy denial, "Blocked:", "ERROR:", tool error; any arguments), or is called
    `maxRepeats` times with the same arguments AND the same result (no progress). A rerun with a
    different result does not count. The turn is saved first; the remaining tool calls of that turn
    are skipped. The next wake-up status shows the reason ("Last wake ended: forced sleep: write_file
    failed 3× …").
  - Forced sleeps last `forcedSleepMinutes`: the guard, the 25-turn cycle limit (was 2 min) and the old
    loop enforcement (had no explicit length, so 60 s). A sleep the agent chooses is unchanged.
  - Owner setting `"loopGuard": { "maxRepeats": 3, "forcedSleepMinutes": 30 }` (defaults; in the
    template; `maxRepeats: 0` turns the guard off). The old warning stays.
  Tests: `repeat-guard` (9, including two loop runs); `loop`: the 3 old-detector tests run with the
  guard off, the cycle-limit sleep test expects 30 min. Baselines: Linux 1958 passed; Windows 1926
  passed, 22 known failures, 10 skipped. `agent:verify` 111.
- 2026-11-16: **Per-wake limit on soul updates** (run-3 fix E; new policy rule, owner-approved under
  rule 4, only tightens). The restart test ran `update_soul` 8 times in one wake.
  - New rule `rate.soul_per_wake` in `src/agent/policy-rules/rate-limits.ts` (next to the genesis and
    self-mod rate rules): denies `update_soul` once the agent has written `soulConfig.maxUpdatesPerWake`
    soul versions since the wake cycle started (kv `wake_cycle_started_at`; without it, the last
    hour). Counts only successful agent changes in `soul_history` (not human/system/reflection).
    Message: "Soul already updated N times this wake (max M per wake). Continue next wake; don't retry
    now." With the repeat guard, 3 denials force sleep.
  - Owner setting `"soulConfig": { "maxUpdatesPerWake": 2 }` (default 2, 0 = no limit; in the template;
    the config is read-only to the agent).
  Tests: `soul-per-wake-limit` (4, through the real policy engine and `update_soul`). Baselines: Linux
  1962 passed; Windows 1930 passed, 22 known failures, 10 skipped. `agent:verify` 111.
- 2026-11-16: **No soul-change warning for the agent's own `update_soul`** (run-3 fix F). "SOUL.md content
  changed since last load" was logged after every `update_soul`. `soulChangeWarning`
  (`src/agent/system-prompt.ts`) now compares a new SOUL.md hash with the latest version recorded by
  `update_soul` in `soul_history`: same hash = the agent's own change, no warning; different hash =
  "SOUL.md changed outside update_soul (does not match recorded version N)", reported once per new
  content. Without any soul history (e.g. a wizard-written soul) the upstream check is kept.
  Tests: `soul-change-warning` (3). Baselines: Linux 1965 passed; Windows 1933 passed, 22 known
  failures, 10 skipped. `agent:verify` 111.
- 2026-11-16: **One agent per project; `agent:status`** (incident fix 1). About $0.43 of inference ran
  15:35-16:17 UTC after `agent:down` had reported everything stopped. Cause, from the Docker Desktop
  engine logs and state.db: `agent:down` (15:34:52) did stop the run that existed; 13 s later a new
  interactive `pnpm agent:run` started `automaton-runtime-run-d8a545bd3b3e` on the image built before
  the loop-guard and soul-limit fixes. It ran 285 turns (SOUL.md rewrite loop: 171 denied `write_file`,
  83 `update_soul`; old 25-turn cycle + 2 min sleep) until the 25c hourly cap stopped it. Nothing showed
  it was running, and nothing refused a second agent. Fix (scripts, plus a read-only owner command):
  - `docker/agent-instances.mjs` (new): running runtime/sandbox containers of a project, uptime.
  - `docker/run-oneoff.mjs`: refuses `--run` and `--init` while any runtime container of the project is
    running (names it, exit 1, "stop it first with pnpm agent:down"); ledger/settings/preflight print a
    note. Cleanup no longer removes a sandbox another runtime still uses (at 16:38 a new run's cleanup
    removed the sandbox of a different run).
  - `pnpm agent:status` (`docker/status-agent.mjs`, new): runtimes with uptime, sandbox, and the activity
    report of the new owner command `runtime --activity` (`src/state/activity-report.ts`, read-only):
    state, last turn, turns and inference spend last hour / today (UTC) / lifetime, sleep, budget pause.
    New ledger helper `getInferenceCostSinceMc`.
  - `agent:down` ends by saying no runtime is running now and that a later `agent:run` starts a new one.
  Tests: `activity-report` (3). `agent:verify` +5 ("one agent per project": status without and with a
  runtime, `--init` refused, ledger with note, sandbox kept for another runtime). Baselines: Linux 1968
  passed; Windows 1936 passed, 22 known failures, 10 skipped. `agent:verify` 116.
- 2026-11-16: **Build commit in the images; warning when the agent runs old code** (incident fix 2). The
  incident runtime ran the image built before that afternoon's fixes, while the fixes were rebuilt and
  verified next to it.
  - `docker/agent.Dockerfile`: build arg `AUTOMATON_BUILD_COMMIT` (last lines of each stage, no cache cost)
    becomes label `org.automaton.build-commit` (runtime and sandbox) and env in the runtime;
    `compose.agent.yml` passes it (default `unknown`).
  - `pnpm agent:build` is now `docker/build-agent.mjs`: sets the commit from git (`-dirty` with
    uncommitted changes), builds, then warns if a runtime of the project still runs an older image
    ("takes effect only after pnpm agent:down and pnpm agent:run"). `agent:verify` labels its build the
    same way and gives the same warning for the real project (it rebuilds the same image tags).
  - The runtime logs `(build <commit>)` at startup; `--preflight` prints `build: <commit>` first.
  - `agent:status` and the `run-oneoff` refusal show each runtime's build, and `OLD IMAGE` when the image
    was rebuilt after the container started.
  Tests: `agent:verify` +3 (images labelled, preflight prints it, `agent:status` flags an older image).
  Baselines unchanged: Linux 1968 passed; Windows 1936 passed, 22 known failures, 10 skipped.
  `agent:verify` 119.
- 2026-11-16: **Runtime instance lease** (incident fix 3, owner-approved). The script checks from fix 1
  only cover the pnpm commands; this is the backstop in code, however the runtime was started (e.g. a
  direct `docker compose run`).
  - `src/runtime/instance-lease.ts` (new): kv `runtime_lease` = instance ID, host (container ID), pid,
    build, start time, heartbeat. Acquire, renew and release run in IMMEDIATE transactions. Live = last
    heartbeat under 90 s (`LEASE_TTL_MS`); renewal every 30 s; a malformed value counts as free.
  - `prepareRuntime` (`--run` only) takes it right after the database opens, before anything else is
    written, and refuses to start otherwise: "Another runtime is already running on this database (host,
    pid, build, started, last heartbeat N s ago) ... Refusing to start." Released again if startup then
    fails on the tool allowlist.
  - `run()` renews it; if it is no longer ours (this process stalled past the TTL and another runtime
    took over), the runtime logs it and shuts down (exit 3) without touching the agent state. Graceful
    shutdown releases it, so `agent:down` then `agent:run` works at once; after `agent:kill` it expires
    after 90 s.
  - `--preflight` prints `runtime lease: free` or `HELD, an agent is running (...)`; it never takes it.
  - `agent:verify` output is grouped by heading (fix 2 printed one heading three times).
  Tests: `instance-lease` (5); `conway-off` checks the real startup path (second `--run` refused,
  preflight shows HELD). `agent:verify` +3 (two containers on the shared state.db: refused while held,
  preflight shows HELD, free at once after a graceful stop). Baselines: Linux 1973 passed; Windows 1941
  passed, 22 known failures, 10 skipped. `agent:verify` 122.
