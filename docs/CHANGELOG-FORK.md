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
- 2026-11-16: **A restart honours a pending sleep; `--wake-now` overrides** (incident fix 4,
  owner-approved). Upstream, `--run` cleared `sleep_until` and woke the agent at once: in the incident the
  agent had chosen a 3600 s sleep at 15:34:42, and the restart 26 s later woke it immediately.
  - `src/agent/startup-sleep.ts` (new): `pendingStartupSleep` returns a `sleep_until` still in the future
    (any kind: the agent's `sleep`, loop guard, cycle limit, budget pause), with the reason from
    `last_wake_end` or `sleep_reason`; none with `--wake-now`. `waitForSleepOrWake` is the existing sleep
    wait (30 s steps, a wake event ends it early), now shared with the run loop's sleeping state.
  - `run()`: before the loop, drains stale wake events, sets the state to sleeping, logs "Honouring the
    pending sleep until ... To wake the agent now, start it with --wake-now (pnpm agent:run --wake-now)"
    and waits. `pnpm agent:run --wake-now` passes the flag through `run-oneoff`.
  Tests: `startup-sleep` (5). Baselines: Linux 1978 passed; Windows 1946 passed, 22 known failures,
  10 skipped. `agent:verify` 122.
- 2026-11-16: **Incident record: second agent on old code; run 4.**
  - Incident (15:35–16:17 UTC, about 43¢ of the $5 testing budget, testnet only, no funds moved):
    `agent:down` (15:34:52) correctly stopped the run that existed. 13 s later an interactive
    `pnpm agent:run` in another VS Code terminal started `automaton-runtime-run-d8a545bd3b3e` on the image
    built before the run-3 fixes. On that old code the loop guard only warned and soul updates had no
    per-wake limit, so it ran 285 turns over 15 wakes (25 turns, then a 2-min forced sleep), rewriting
    SOUL.md: 171 denied `write_file`, 83 `update_soul`, 40 `exec`. The 25¢ hourly cap paused it at 16:17.
    It ended at 16:38 when another run recreated the sandbox. Found from the Docker Desktop engine logs
    (the containers were `--rm`) and read-only queries of state.db. Why it went unnoticed: no command
    showed running runtimes, nothing refused a second agent, the image had no build label, and a restart
    always woke the agent. Fixed by the four entries above.
  - Run 4 (build `1ec28e5`, owner-started): 2 turns, $0.00322. One `write_file` SOUL.md attempt received
    the new explanation; it then slept on its own with zero soul rewrites.
  - Testnet genesis prompt (`docker/automaton.testnet.json`), one sentence added after rule (4): "Never
    use write_file for SOUL.md; use view_soul/update_soul." (702 of 2000 chars.)
- 2026-11-16: **Sleep floor and daily wake cap** (Phase 2 prep A1, owner-approved; only tightens). Nothing
  limited how short a sleep the agent picked: `sleep(0)` or `sleep(-5)` ended the wake and the runtime woke
  it again 10 s later (about 240 wakes an hour, stopped only by the 25¢ hourly and $1 daily caps: up to $1 a
  day). The idle path also slept only 60 s.
  - `src/agent/sleep-limits.ts` (new), owner setting `sleepConfig` (code defaults `minSeconds` 300,
    `maxWakesPerDay` 48, 0 = no limit; template 1800 / 48; invalid values fall back to the defaults).
  - Floor: the runtime's sleeping state (`index.ts`, the one place every sleep goes through) never waits
    less than `minSeconds` and writes the effective `sleep_until` back, so status and restarts see it.
  - `sleep` tool: refuses non-numbers, zero and negatives ("duration_seconds must be a positive number of
    seconds (minimum N)"); raises a shorter value and says so ("Entering sleep mode for 1800s (the minimum;
    you asked for 60s)").
  - Wake cap: each wake cycle is counted per UTC day (kv `wake_count_day`) before any model call. Past the
    cap the loop sleeps until the next UTC day; the next wake-up status says "wake limit: N wakes today
    (max M per day)". Restarts and heartbeat wake-ups count; `--wake-now` does not override it.
  With the template values the most the agent can spend is about 48 wakes × 0.3¢ ≈ 15¢ a day.
  Tests: `sleep-limits` (8, including a loop run at the cap and the real `sleep` tool). Baselines: Linux
  1986 passed; Windows 1954 passed, 22 known failures, 10 skipped. `agent:verify` 122.
- 2026-11-16: **Tighter money caps for unattended testnet runs** (Phase 2 prep A2). Template
  `docker/automaton.testnet.json`: `"modelStrategy": { "hourlyBudgetCents": 5, "dailyBudgetCents": 30 }`
  (were the code defaults 25¢ / $1; lifetime 500¢ and per-call 5¢ unchanged, other strategy fields keep
  their defaults). Expected use is at most 2 wakes an hour (30-min sleep floor) at about 0.3¢ each and
  at most 48 wakes a day (about 15¢), so the caps leave 2–8× headroom and stop a fault within an hour.
  `agent:verify` 122.
- 2026-11-16: **Detached runs; `agent:logs`; logs saved on stop** (Phase 2 prep A3). Until now the agent's log
  existed only in the `agent:run` terminal: closing it ended the run, and the `--rm` container took its log
  with it.
  - `pnpm agent:run --detach` (`run-oneoff`; the flag may come after `--`, as pnpm appends it): `compose run
    -d -T`, not `--rm`, so the run survives closing the terminal and its log stays readable after it exits;
    the sandbox is left running for it. Prints the next commands.
  - `pnpm agent:logs [-f] [--tail N]` (`docker/logs-agent.mjs`, new): the log of the running runtime, else
    the newest stopped one; warns if more than one is running.
  - `agent:down` and `agent:kill` save every runtime log (with timestamps) to `~/.automaton-logs`
    (`AUTOMATON_LOG_DIR`), outside the repo: `--rm` (interactive) ones before stopping them, kept
    (detached) ones after, so their shutdown lines are included.
  - `compose.agent.yml`: runtime log rotation (json-file, 20 MB × 5).
  Tests: `agent:verify` +6 (detach returns, logs after exit, container kept, sandbox kept, down saves both
  kinds, kill saves). `agent:verify` 128; no `src/` change.
- 2026-11-16: **Watchdog `pnpm agent:watch`** (Phase 2 prep A4). Unattended runs must stop on their own when
  something looks wrong, not when the owner happens to look.
  - `docker/watch-agent.mjs` (new): every `--interval` s (default 300) checks Docker (runtimes, old image) and
    the activity report since the watch started; on the first stop rule it runs `agent:down` (graceful, logs
    saved) and exits 2; `--hours H` ends the run the same way with exit 0. Rules and defaults: no runtime /
    more than one / old image; spend since start > 5¢ (`--max-run-cents`) or in the last hour > 3¢
    (`--max-hour-cents`, below the 5¢ code cap); > 6 turns in one wake started after the watch
    (`--max-wake-turns`); > 20 turns in an hour (`--max-hour-turns`); a wake ended by force (loop guard,
    cycle limit, budget cap, wake limit, consecutive errors); one tool denied 3 times (`--max-denials`); tier
    low_compute/critical/dead; any ledger entry other than inference cost (so no owner grants during a
    watched run); activity unreadable 3 times. In the first hour, hour figures count only since the start.
    `--since` resumes counting from an earlier time; `--once` checks once. One line per check on the console
    and in `~/.automaton-logs/watch-<project>-<start>.log`. Ctrl+C stops only the watchdog.
  - `runtime --activity --json [--since <ISO>]`: adds tier, turns this wake, wake start and since-stats
    (turns, spend, most-denied tool, non-inference ledger entries). Text report shows tier and turns this wake.
  - `agent:status` and the watchdog read the activity report through a label-free `docker run` (no network,
    no secrets, read-only root) instead of `compose run`, so the check never shows up as a second runtime.
  Tests: `activity-report` +1; `agent:verify` +7 (nothing to watch, `--once` passes, a tripped rule runs
  `agent:down`, `--hours` ends the run, an exited runtime is noticed, watch log, status without a compose
  container). Baselines: Linux 1987 passed; Windows 1955 passed, 22 known failures, 10 skipped.
  `agent:verify` 135.
- 2026-11-16: **Docs: Phase 2 step A done; unattended-run plan** (Phase 2 prep A5). ROADMAP Phase 2 lists
  A1–A4 with commits, A5 (provider-side cap: the owner's OpenAI account is prepaid with auto-reload off,
  so no code), and the run plan: run 5 (3 h), run 6 (24 h), then 72 h with supervision, plus the review
  checklist after each run.
- 2026-11-17: **Run 5 (build 9adf74d, 3 h planned, detached, watchdog)**. A false start at 23:00 UTC: the UTC
  day still held the 43¢ incident, so the daily cap put the agent to sleep and the watchdog stopped it ("a wake
  ended by force: budget cap reached"). Restarted 00:28 UTC. Wake 1: 3 turns, 0.48¢, slept 1 h. Wake 2
  (01:28): 19 turns in 30 s, 3.26¢: upstream loop warnings ("DO SOMETHING DIFFERENT NOW … execute a concrete
  task") pushed it into `remember_fact`, sandbox `exec echo > …` files (a fake SOUL.md) and `update_soul`; the
  soul rate limit (2/wake) and the loop guard held, and the watchdog stopped the run at 01:33 (3.26¢ in the hour
  > 3¢). Also found: the soul frontmatter parser reads an empty field's next line (`Name: address:`), the soul
  still had the old genesis purpose and upstream values, `write_file` confines to `/root` (unusable with the
  container sandbox). ~4,000 prompt tokens per call, flat. Network: two RPC `fetch failed` errors (01:32,
  01:33) during sleep, cached balance used; no OpenAI errors; no effect. Fixes F1–F7 below (owner-approved).
- 2026-11-17: **Per-wake turn cap in the runtime** (F1). `maxTurnsPerCycle` (code default 25) is now 6 in
  the testnet template, so a wake ends after 6 turns ("cycle limit", 30-min forced sleep) without waiting
  for the watchdog's 5-minute check. `src/agent/turn-limits.ts` (new): startup refuses a value that is not
  a whole number 1..100 (was: silently used). The wake status says "Turns this wake: at most N"; preflight
  prints the wake limits (turns, sleep floor, wakes per day). Tests: `turn-limits` (4); `agent:verify` +1
  (template wake limits in preflight). Baselines: Linux 1991 passed; Windows 1959 passed, 22 known failures,
  10 skipped; `agent:verify` 136.
- 2026-11-17: **Loop warnings point to sleep; one warning per wake** (F2). The upstream warnings ("LOOP DETECTED
  … DO SOMETHING DIFFERENT NOW. Pick ONE concrete task … and execute it", "MAINTENANCE LOOP … Write code, create
  a file, register a service, or build something new") pushed a finished agent into new actions in run 5. Both
  now end with "If your tasks for this wake are done, call sleep now. Otherwise take one different step that
  your genesis prompt needs." (`LOOP_WARNING_NEXT_STEP` in `src/agent/loop.ts`). The second loop detection in
  one wake (repeated pattern or status-only turns) ends the wake with a forced sleep (loopGuard
  `forcedSleepMinutes`), reason "forced sleep: 2 loop warnings this wake (last: …)", which the watchdog treats as
  forced. Stricter than before (was: a new warning each time). Tests: `loop.test.ts` (the "enforcement resets"
  test now asserts the second detection ends the wake; wording checks).
- 2026-11-17: **Soul parser fix; identity fields from the runtime** (F3). `parseSoulV1` read frontmatter with
  `^key:\s*(.+)$`; `\s*` matched the line break, so an empty `name:` took the next line (`address:`), and every
  rewrite shifted the error down (run 5: `Name: address:`, heading `# address:`). Now `^key:[ \t]*(.*)$`, and a
  value that is itself another field (`creator: born_at: …`, left by the bug) reads as empty, so the stored soul
  repairs itself on the next load/write. `updateSoul(…, identity)` takes name, address and creator from the
  runtime (config name, wallet address, creator address) and ignores them in the agent's updates; the
  `update_soul` tool passes them and accepts only `corePurpose, values, behavioralGuidelines, personality,
  boundaries, strategy` (was: any key, including name/address/version). `view_soul` shows "(not set)" for an
  empty name. Tests: `soul-identity` (4).
- 2026-11-17: **Owner soul reset; soul defaults as settings; sandbox cleanup** (F4). The soul still carried the
  first genesis prompt's purpose ("update my SOUL.md … note the main tools") and the upstream values ("Survive:
  maintain compute resources at all costs", "Create: build things"), injected into every prompt.
  - `automaton --soul show|reset`, `pnpm agent:soul` / `pnpm agent:soul:reset` (`src/soul/reset.ts`, new; one-off
    with `--no-deps`, no model call, no network, no wallet file read: the address comes from the `identity` table).
    Reset writes a fresh soul as the next version: purpose `soulConfig.defaultCorePurpose` (else the genesis
    prompt), values `soulConfig.defaultValues` (else the upstream four), identity from the runtime, no strategy;
    `soul_history` keeps every earlier version (change_source `human`, approved_by `owner`). Refused while an
    agent runs: by `run-oneoff` (like `--init`) and by the runtime lease.
  - Settings (rule 7): `soulConfig.defaultCorePurpose` (string ≤ 2000) and `defaultValues` (1–10 strings); startup
    refuses invalid values. Template: a short testnet purpose and three values (follow the genesis prompt and the
    owner's rules; spend little, few turns, then sleep; honest, legal, within provider terms).
  - `saveSoulVersion` (validate, version, write, log) now shared by `updateSoul` and the reset.
  - Sandbox cleanup (owner-approved, done once by hand): removed `READY_NOTICE.txt` and the fake `SOUL.md` that
    run 5 wrote with `exec echo > …` in the sandbox home (`automaton_sandbox-home`). Left in place: six tool notes
    from the 2026-11-16 incident run (`MAIN_TOOLS.txt`, `TOOLS*.md/txt`).
  Tests: `soul-reset` (5); `agent:verify` +3 (reset in a container; refused by run-oneoff and by the lease).
  Baselines: Linux 2000 passed; Windows 1968 passed, 22 known failures, 10 skipped; `agent:verify` 139.
- 2026-11-17: **Genesis wording; preflight warns about a used-up daily cap** (F7).
  - Testnet genesis prompt (844 characters): step (3) is now "if you observed something new, store it with one
    remember_fact (category self, key last_observation; this replaces the old one), otherwise skip this step";
    step (4) "then call sleep. Use at most 4 tool calls per wake."; "Never use write_file or exec for SOUL.md"
    (run 5 wrote a fake one with `exec echo > SOUL.md`); missing space before "Do not try" fixed.
  - Preflight: `INFO  inference today (UTC): $X of $Y daily cap`, or a `WARN` line when the cap is already reached
    (a run started then only sleeps until 00:00 UTC and the watchdog stops it, as run 5's first start at 23:00
    UTC did). A warning, not a failure. `dailyCapStatus` in `src/inference/budget.ts` (same strictest-cap rule
    and UTC day as the budget tracker). Tests: `daily-cap-status` (3); `agent:verify` +1.
  Baselines: Linux 2003 passed; Windows 1971 passed, 22 known failures, 10 skipped; `agent:verify` 140.
- 2026-11-17: **Offline handling** (F6). Run 5 had two RPC errors during sleep and no model errors, but an outage
  would have ended each wake after 5 failed calls ("5 consecutive errors", which the watchdog treats as forced)
  and a model-call timeout was handled as a text reply.
  - `src/agent/offline.ts` (new): `isNetworkError` (DNS/connection errors, resets, timeouts, `fetch failed`,
    `AbortError`/`TimeoutError`, open circuit; provider errors such as 401/429 are not offline). The loop ends
    the wake at the first such error: no more turns or tool calls, reason "offline: model API unreachable (…);
    retry in N min", sleep 30, 60, then 120 min for offline wakes in a row (never below the sleep floor); the
    first successful model call resets it (kv `offline_streak`). A router timeout result now goes the same way.
    Other errors keep the old path.
  - Balance: a cached wallet figure shows as "[cached: wallet RPC unreachable, last read … UTC]" (was "[cached]"),
    an unknown one as "[unavailable: wallet RPC unreachable]". Unchanged: the heartbeat keeps the last tier when
    the balance is unavailable.
  - Activity report: `offlineStreak` (JSON) and an "Offline:" line. Watchdog: shows "OFFLINE n wake(s) in a
    row"; an offline wake end is not a stop; more than `--max-offline-wakes` (default 4, about 4 h) in a row is.
  Tests: `offline` (9); `agent:verify` +2 (one offline wake passes, five stop the run).
  Baselines: Linux 2012 passed; Windows 1980 passed, 22 known failures, 10 skipped; `agent:verify` 142.
- 2026-11-17: **`write_file` confined to the workspace with the container sandbox** (F5; owner-approved under
  rule 4, narrows only). `write_file` confined paths to `/root` (the Conway sandbox home), which our sandbox
  refuses (roots `/workspace` and its home), so every `write_file` failed (run 5: `note.txt` → `/root/note.txt`,
  HTTP 403). In container mode it now confines to `sandbox.workspaceDir` (default `/workspace`): relative paths
  resolve there, `~` is refused (for `exec` it is the sandbox home, outside the workspace), as is any path
  outside, with a message naming the workspace. The sandbox's own root check and the policy engine's path
  protection are unchanged; local/Conway mode keeps `/root`. Tests: `write-file-workspace` (3); `agent:verify` +2
  (relative path written to `/workspace` through the sandbox; `/root` refused).
  Baselines: Linux 2015 passed; Windows 1983 passed, 22 known failures, 10 skipped; `agent:verify` 144.
- 2026-11-18: **The model sees its own tool calls again** (G1, run 5 retry). Run 5 retry, wake 3: 6 turns
  (`view_soul`, `update_soul` ×2, `remember_fact`, a denied `update_soul`, `exec`) until the turn cap. Cause:
  `buildContextMessages` (upstream) rendered a turn's assistant message and tool results only when the turn
  had text, and gpt-4.1-mini sends tool calls without text (all 333 stored turns had none). The model never
  saw what it had done or the results, only the wake-up message again on each turn. Now a turn with tool calls
  is rendered with them and their (truncated) results, with or without text. The OpenAI request sends
  `content: null` for an assistant message that has only tool calls. Cost: the history now carries the tool
  results of the last turns (about +0.5-1.5k input tokens per call; the token budget and summary still apply).
  Tests: `context-tool-only-turns` (3).
  Baselines: Linux 2018 passed; Windows 1986 passed, 22 known failures, 10 skipped; `agent:verify` 144.
- 2026-11-18: **Repetition warning asks to sleep, not to build** (G2). The history warning (upstream; a tool
  used 3 times in the last 5 turns) said "Move on to BUILDING something. Write code, create files, set up a
  service." In run 5 retry wake 3 it followed three `update_soul` calls, and the agent ran `exec`. It now ends
  with the same next step as the loop warnings (F2): "If your tasks for this wake are done, call sleep now.
  Otherwise take one different step that your genesis prompt needs." (`LOOP_WARNING_NEXT_STEP` moved to
  `context.ts`, re-exported from `loop.ts`.) `sleep` is no longer counted: one sleep per wake over several
  one-turn wakes would otherwise have warned "you have been calling sleep repeatedly" at the next wake.
  Tests: `context-tool-only-turns` +2.
  Baselines: Linux 2020 passed; Windows 1988 passed, 22 known failures, 10 skipped; `agent:verify` 144.
- 2026-11-18: **corePurpose is owner-only** (G3; owner-requested under rule 4, only tightens). In run 5 retry the
  agent rewrote its core purpose twice in one wake right after the owner reset it (v88 → v90).
  - Setting `soulConfig.ownerOnlySections` (default `["corePurpose"]`, also explicit in the template; `[]` = the
    agent may change every section). Startup and `agent:soul:reset` refuse names that are not soul sections.
  - New policy rule `authority.soul_owner_only` (priority 400, any input source): `update_soul` on such a section is
    denied with "Policy denied: OWNER_ONLY_SOUL_SECTION — The soul section "corePurpose" is set by your owner only;
    you cannot change it. You may update: values, … Don't retry." Nothing is written; the denial is recorded in
    `policy_decisions` (the watchdog counts it). The owner changes the purpose with `soulConfig.defaultCorePurpose`
    and `pnpm agent:soul:reset`, which does not go through tools. Reflection never wrote corePurpose.
  - `agent:soul` / `agent:soul:reset` print "Owner-only sections: …". The `update_soul` parameter text says owner
    sections are refused. `AGENT_SOUL_SECTIONS` moved to `src/soul/sections.ts` (re-exported from `soul/tools.ts`).
  - Unchanged: the unused upstream flag `requireCreatorApprovalForPurposeChange`.
  Tests: `soul-owner-only` (4); `soul-per-wake-limit` now updates `strategy` (same rule tested). `agent:verify` +1.
  Baselines: Linux 2024 passed; Windows 1992 passed, 22 known failures, 10 skipped; `agent:verify` 145.
- 2026-11-18: **Run 5b passed** (build `81ca745`, 13:50–16:50 UTC, detached, `agent:watch --hours 3`). Before it:
  `agent:soul:reset` (v90, the agent's own purpose → v91 from the template). Watchdog: DONE after 3 h, `agent:down`
  exit 0, log saved. Read-only review of the log and state.db:
  - 3 wakes, one per hour (the agent chose 3600 s each time): 1 turn (`sleep`), 2 turns (`remember_fact`
    "observation_…" + `sleep`), 1 turn (`sleep`). Every wake ended "agent chose sleep"; no loop or repetition
    warning, no forced sleep, no offline wake.
  - Spend 1.19¢ (282 + 295 + 305 + 308 millicents); ledger matches `inference_costs` and the watchdog; no
    ledger entry other than inference. Lifetime $0.61 of $5.00.
  - No policy decision other than allow (G3 never triggered); soul unchanged at v91 with the template purpose;
    semantic memory 10 facts (+1).
  - Tokens per call 6909 → 7127 → 7496 → 7538 (run 5 retry: about 4.5k). The increase is G1: the last turns
    now carry their tool results. Bounded: at most 20 turns of history (only the newest sleep-only turn is
    kept), memory retrieval within its token budget. About 0.3¢ per call.
  - Run 6 (24 h) plan: about 24 wakes, 10–15¢; the watchdog runs with `--hours 24 --max-run-cents 20`.
- 2026-11-20: **Run 6 passed** (build `12d6995`, 2026-11-18 19:21 UTC – 2026-11-19 19:21 UTC, detached,
  `agent:watch --hours 24 --max-run-cents 20`). Watchdog: DONE after 24 h, `agent:down` exit 0 (graceful, 1.7 s),
  log saved; no stop rule tripped. Read-only review of the saved log and a copy of state.db (opened in a no-network
  container from a read-only mount; no other file read):
  - 24 wakes, one per hour (the agent chose 3600 s every time; actual interval 3600 s + 1–3 s). 20 wakes of one
    turn (`sleep`), 4 of two (`remember_fact` `self/last_observation` + `sleep`, at 00:22, 04:22, 07:22, 16:23).
    28 turns, every wake ended "agent chose sleep"; no loop/repetition warning, no forced sleep, no offline wake,
    no WARN/ERROR line in the runtime log.
  - Spend 13.141¢ (28 calls); ledger = `inference_costs` = watchdog; no ledger entry other than inference.
    Ledger balance at the end $4.25 (lifetime ledger spend about 75¢ of $5.00, including the run-1 rounding).
  - Context leveled: input per call 7.9k → 13.0k tokens (peak 16:23), then 12.4–13.0k from 08:23 on (history cap
    of 20 turns reached; the system part also grew 2.5k → 3.3k while working memory filled to its 20 entries).
    Cost per call 0.33¢ → about 0.52¢, flat for the last 11 hours. Expect about 12.5¢ a day at hourly wakes.
  - UTC midnight: the 00:22 wake was normal; spend split 1.843¢ (5 calls, 11-18) / 11.298¢ (23 calls, 11-19), far
    below the 30¢ daily cap; `wake_count_day` restarted at 2026-11-19 (19 wakes by the end, as expected); the
    00:00 heartbeat ran all six tasks without error; the watchdog's hour figures stayed correct.
  - Policy: 28 decisions, all allow (all-time denials unchanged: 165, last 2026-11-17). Soul unchanged at v91.
  - Facts: `semantic_memory` still 10 (the genesis step keeps one `last_observation` key, updated 4 times). Seven
    stale facts from runs 1–5 remain (`tool_error:write_file:*` 161×/12×, `tool_error:update_soul:RATE_LIMIT`,
    $4.44 balance notes, `genesis_task_progress`). Working memory 20 entries (capped).
  - Heartbeat: 1,168 runs, 0 failures (`fail_count` 0 for all six tasks). `check_social_inbox` every 2 min is 721 of
    them (62%), with Conway and social features off. `heartbeat_history` is never pruned (`pruneHistory` in
    `src/heartbeat/scheduler.ts` has no caller): about 1,170 rows / 125 KiB a day.
  - Database: 2.65 MB, WAL checkpointed at shutdown, no free pages. Largest: `turns` ~472 KiB, `tool_calls`
    ~348 KiB, `heartbeat_history` ~170 KiB, `soul_history` ~154 KiB (90 versions, mostly from the incident).
    Estimated growth about 0.2 MB a day.
  - Upstream noise: the memory classifier filed one sleep reason as `knowledge_store` `financial/pricing:reason`
    and wrote 17 `event_stream` rows (`knowledge`, `market_signal`) from sleep reasons that mention dollars. Small.
  - Not measured: container memory/CPU (the watchdog does not record `docker stats`; containers removed at the end).
  - Follow-ups (not blocking, before the 72 h run): prune `heartbeat_history`; skip `check_social_inbox` when
    Conway is off; owner command to remove stale facts; `docker stats` in the watchdog log.
- 2026-11-20: **Heartbeat history is pruned** (run 6 follow-up H1). `heartbeat_history` grew by about 1,170 rows a
  day and was never pruned (upstream `pruneHistory` had no caller). New setting `heartbeatHistoryDays` (default 7,
  0 = keep all, also 7 in the template; startup refuses values outside whole numbers 0..365). The heartbeat
  scheduler deletes older rows (successes and failures) from its tick, at most once an hour, and logs how many
  (`src/heartbeat/history-retention.ts`, `DurableScheduler.maybePruneHistory`). The first prune after the next
  start removes the rows from before 2026-11-13 (none) and then keeps about 8,000 rows.
  Tests: `heartbeat-history-retention` (5).
  Baselines: Linux 2029 passed; Windows 1997 passed, 22 known failures, 10 skipped; `agent:verify` 145.
- 2026-11-20: **No social inbox check without a social relay** (run 6 follow-up H2). The heartbeat ran
  `check_social_inbox` every 2 minutes as a no-op (721 of 1,168 runs in run 6), because the task returns at once
  when there is no social client. Without one (no `socialRelayUrl`, or a Conway relay with Conway off) the daemon
  now leaves the task out of its task map (`buildHeartbeatTaskMap` in `src/heartbeat/daemon.ts`), so it is never
  executed or recorded; the log says "Social inbox check off (no social relay)." With a relay nothing changes.
  Tests: `heartbeat-social-off` (2).
  Baselines: Linux 2031 passed; Windows 1999 passed, 22 known failures, 10 skipped; `agent:verify` 145 (not rerun:
  no sandbox/Docker change).
- 2026-11-20: **Owner facts command** (run 6 follow-up H3). Seven stale facts from runs 1–5 stay in `semantic_memory`
  and the agent has no tool to delete facts (its shell cannot reach state.db). New `automaton --facts list |
  delete <category/key> ...`, `pnpm agent:facts` and `pnpm agent:facts:delete <category/key> ...`
  (`src/memory/facts-command.ts`; one-off with `--no-deps`, no model call, no network, no wallet file read). Delete
  takes exact `category/key` pairs (split at the first `/`), all or nothing: one unknown key deletes nothing. Refused
  while an agent runs, by `run-oneoff` (like `--soul reset`) and by the runtime lease.
  Tests: `facts-command` (5); `agent:verify` +3 (list in a container; delete refused by run-oneoff and by the lease).
  Baselines: Linux 2036 passed; Windows 2004 passed, 22 known failures, 10 skipped; `agent:verify` 148.
- 2026-11-20: **Watchdog records container memory and CPU** (run 6 follow-up H4). Run 6's review could not say how much
  memory the containers used. Every `agent:watch` check line now ends with `| runtime NNMiB x.x% cpu, sandbox NNMiB
  x.x% cpu` (`docker stats --no-stream`), and the DONE/STOP line gives the peaks ("Peak: runtime NNMiB, x.x% cpu;
  sandbox …"). Recorded only, never a stop rule; "stats n/a" when Docker cannot report them.
  Tests: `agent:verify` +2 (check line, DONE peaks).
  Baselines: Linux 2036 passed; Windows 2004 passed, 22 known failures, 10 skipped; `agent:verify` 150.
- 2026-11-21: **Wallet encrypted at rest** (Phase 3 step 1, owner decision 2026-11-20). `wallet.json` held the private
  key in plain JSON (mode 0600).
  - `src/identity/wallet-crypto.ts` (new): scrypt (N=32768, r=8, p=1; stored in the file) + AES-256-GCM. The chain type
    and address stay in clear (status commands need no passphrase) and are bound to the ciphertext as additional
    authenticated data, so a swapped address fails to decrypt. File format `version: 2`; an unknown version is refused.
    Passphrase: env `AUTOMATON_WALLET_PASSPHRASE`, in Docker from the secrets file `wallet_passphrase`
    (`docker/load-secrets.sh`; runtime only, never the sandbox or the config). At least 16 characters. Read once at
    startup and removed from `process.env` (the container's initial environment block still has it).
  - `src/identity/wallet.ts`: decrypts on load; a new wallet is written encrypted when a passphrase is set; writes are
    atomic (temp file + rename, mode 0600). `walletInfo()` (no key material) and `encryptExistingWallet()` (encrypts in
    place, checks the result decrypts to the same address first, keeps no plaintext copy).
  - Setting `walletEncryption`: `"required"` refuses to start with, or create, a plaintext wallet; `"optional"` (code
    default, upstream behavior) accepts one. Mainnet always requires it. Template: `"required"`. Startup refuses other
    values. Preflight prints `INFO wallet file: encrypted at rest` or a `WARN`.
  - Owner commands: `automaton --wallet show|encrypt`, `pnpm agent:wallet` / `pnpm agent:wallet:encrypt` (encrypt is
    refused while an agent runs, by `run-oneoff` and by the runtime lease).
  - `automaton-cli send` loads the wallet through the shared loader (was: read `privateKey` from the JSON directly).
  - Protects a copied wallet volume (backup, `docker cp`, a file leak). Does not protect against someone with both the
    volume and the secrets folder, or the running process's memory. Losing the passphrase loses the wallet.
  - Migration (owner): create `wallet_passphrase` in the secrets folder, `pnpm agent:build`, `pnpm agent:wallet:encrypt`.
    Until then `--preflight`/`--run` refuse the plaintext wallet.
  Tests: `wallet-encryption` (11: round trip, wrong passphrase, swapped address, altered ciphertext, env removal,
  required/optional, refusal without passphrase, in-place encryption, unknown version, and a leak test that plants a
  known key and checks preflight output and every log line for it and for the passphrase). `agent:verify` +4 (init
  writes version 2 with no `privateKey`; `--wallet show`; refused without the passphrase; `--wallet encrypt` refused
  while a runtime runs); the sandbox checks now also search every process environment and readable file for the
  passphrase.
  Baselines: Linux 2047 passed; Windows 2015 passed, 22 known failures, 10 skipped; `agent:verify` 154.
- 2026-11-21: **Owner migrated the main wallet** (`agent:wallet:encrypt`; preflight "encrypted at rest"; passphrase
  backed up offline).
- 2026-11-21: **Payment limits as settings** (Phase 3 step 2). Settings only; the checks before a payment come with
  `send_usdc` (step 3) and the policy rules (step 4).
  - `treasuryPolicy.transferAllowlist` (new): the only recipients of on-chain payments, EVM addresses (EIP-55 checksum
    when mixed case, not zero) or `"creator"` for the creator address, at most 20. Code default `[]` = no payments.
  - `src/agent/payment-limits.ts` (new): startup refuses transfer limits that are not whole numbers >= 0, per transfer
    > per hour, per hour > per day, and bad recipients (`checkPaymentLimits`); `resolveTransferAllowlist`;
    `describePaymentLimits`. Preflight prints `INFO payments: per transfer …, recipients: creator 0x…` and a `WARN`
    for limits looser than the code defaults.
  - `loadConfig` no longer replaces an invalid payment limit with the (possibly looser) default; it keeps the value so
    startup refuses it. Other treasury values keep the upstream fallback.
  - Template: per transfer 25¢, hour 50¢, day $1, reserve $1 left in the wallet, 1 transfer per turn, confirmation
    above 25¢, recipients `["creator"]`. The reserve is below the code default ($10) so that a few test USDC can move;
    preflight warns about it.
  - `.dockerignore`: the template is in the build context so the Linux tests can check it (not copied into images).
  Tests: `payment-limits` (7, including the template); `authority-rules` skips the new list field in its "all numbers"
  check. `agent:verify` +1 (preflight payments line).
  Baselines: Linux 2054 passed; Windows 2022 passed, 22 known failures, 10 skipped; `agent:verify` 155.
- 2026-11-21: **`send_usdc` tool** (Phase 3 step 3). The only payment tool was Conway's `transfer_credits`.
  - `src/agent/usdc-transfer.ts` (new), `sendUsdc()`: before anything is signed, in code: amount in whole cents
    1..`maxSingleTransferCents` (1 cent = 0.01 USDC = 10,000 base units); reason required (max 200 characters);
    recipient a valid address on the resolved `transferAllowlist`, never the agent's own; the UTC-hour and UTC-day
    windows (`spend_tracking`, category `transfer`, the same windows `SpendTracker` uses); the token reports 6 decimals;
    a fresh on-chain USDC balance >= amount + `minimumReserveCents`; ETH >= twice the estimated fee. Unreadable balances
    refuse. Active network only (Base Sepolia unless the owner approved mainnet).
  - Accounting: the spend is recorded before the broadcast and removed only if nothing was sent or the transaction
    reverted; an unconfirmed one (90 s) stays `pending` and keeps counting ("Do not send it again"). Each broadcast is a
    row in `onchain_transactions` (`usdc_transfer`, pending → confirmed/failed, gas used, metadata with recipient,
    amount, reason). No ledger entry: the wallet balance is read on chain. One transfer at a time per process.
  - Tool `send_usdc` (financial, dangerous; `src/agent/tools.ts`) with a viem client (`createViemUsdcChain`; RPC from
    `rpcUrl`/`AUTOMATON_RPC_URL`). `usdcAddressFor()` exported from `src/conway/x402.ts`.
  - Not in the template `toolAllowlist`: the agent can neither see nor call it until the limits test (step 7).
  Tests: `usdc-transfer` (24: 16 refusals with nothing signed or recorded, exact base units, reserve edge, broadcast
  error, revert, pending, one at a time, registration, not allowlisted).
  Baselines: Linux 2078 passed; Windows 2046 passed, 22 known failures, 10 skipped; `agent:verify` 155.
- 2026-11-21: **Policy rules for `send_usdc`; minimum reserve enforced** (Phase 3 step 4; owner-approved under rule 4
  on 2026-11-20, tightening only). A second, independent layer in front of the tool's own checks.
  - `TRANSFER_TOOLS = ["transfer_credits", "send_usdc"]` (`src/agent/policy-rules/financial.ts`): the per-transfer,
    hourly, daily, per-turn and confirmation rules now cover both.
  - New rule `financial.transfer_recipient_allowlist` (send_usdc): denies a recipient not on the resolved
    `transferAllowlist` (`RECIPIENT_NOT_ALLOWED`), and every payment when the list is empty (`PAYMENTS_OFF`).
  - `financial.minimum_reserve` was a declaration that always allowed. For send_usdc it now denies when the payment
    would leave less than `minimumReserveCents` in the wallet (`RESERVE`), judged on the wallet USDC balance the
    heartbeat last read (kv `wallet_usdc_cache:<network>:<address>`; rules are synchronous), and denies when no balance
    has been read yet (`RESERVE_UNKNOWN`, fail closed). The tool re-reads the balance on chain before signing. Conway
    tools (`transfer_credits`, `fund_child`, `x402_fetch`) keep the upstream behaviour: Conway credits, hidden while
    Conway is off.
  - Transfers per turn: the loop and the general harness count every tool in `TRANSFER_TOOLS` (was:
    `transfer_credits` only). The harness's SPEC alias path now counts too (upstream did not, so an alias could skip
    the per-turn limit).
  Tests: `send-usdc-policy` (11: allow; recipient; payments off; per transfer; hour; per turn; reserve edge; unknown
  balance; decision logged; rule set; a denied call through `executeTool` never runs the tool). `financial` rule count
  9 → 10.
  Baselines: Linux 2089 passed; Windows 2057 passed, 22 known failures, 10 skipped; `agent:verify` 155.
- 2026-11-21: **`pnpm agent:wallet` shows balances, limits and transfers** (Phase 3 step 5). `--wallet show` (and the
  report after `--wallet encrypt`) now adds: the active network; live USDC and ETH balances (two read-only RPC calls,
  nothing signed; "unavailable (…)" when the RPC cannot be reached); the payment limits and recipients; what was sent
  this UTC hour and today; the last 5 `send_usdc` transfers (time, amount, recipient, status, tx hash). No key material.
  `src/agent/wallet-report.ts` (new: `readWalletBalances`, `walletReport`).
  Tests: `wallet-report` (4); `agent:verify` +1 (network, balances or "unavailable", limits, no transfers).
  Baselines: Linux 2093 passed; Windows 2061 passed, 22 known failures, 10 skipped; `agent:verify` 156.
- 2026-11-22: **Owner funded the agent wallet** (Phase 3 step 6): 2.00 test USDC and 0.0005 ETH on Base Sepolia
  (`agent:wallet`: recipients creator).
- 2026-11-22: **Owner payment-limits test** (Phase 3 step 7, part 1). `automaton --payment-test`,
  `pnpm agent:payment-test` (`src/agent/payment-test.ts`): `send_usdc` through `executeTool` and the policy engine
  with the default rules (the loop's path), no model call. Testnet only; refused while an agent runs (run-oneoff and
  the runtime lease); preconditions: creator on the recipient list, USDC >= 0.10 + reserve, some ETH.
  - One real transfer inside the limits: 0.10 USDC to the creator.
  - Refused with the configured limits: 26 cents (per transfer), a recipient not on the list (the burn address,
    1 cent), a second transfer in the same turn.
  - Refused with tightened copies of the configured limits (each value only stricter): hourly and daily limit set to
    what was already sent this hour/today, reserve raised to the current balance. A 2 USDC wallet cannot exceed the
    real windows without being drained; the windows themselves are the configured ones.
  - The tool's own checks without the policy engine: recipient and per-transfer limit (second layer).
  - Each case must match: a refusal may not sign (broadcasts counted) or add a transaction or spend row. The command
    refreshes the cached wallet balance the reserve rule reads (same kv key and format as the heartbeat).
  - The `send_usdc` tool body moved to `executeSendUsdc(args, ctx, chain?)` (same behaviour; the test injects the chain).
  Tests: `payment-test` (3: full run against a stateful fake chain with 2.00 USDC, a refusal that signs is reported
  FAIL, preconditions). `agent:verify` +2 (unfunded throwaway wallet stops at the preconditions; refused while a
  runtime runs).
  Baselines: Linux 2096 passed; Windows 2064 passed, 22 known failures, 10 skipped; `agent:verify` 158.
- 2026-11-22: **Payment test passed on Base Sepolia** (owner ran `pnpm agent:payment-test`, build `6d31d3a`): all 9
  cases as expected; the one real transfer was 0.10 USDC to the creator (tx `0x56234ca9…`).
- 2026-11-22: **Config template switch and the payment-test template** (Phase 3 step 7, part 2, for the real agent
  wake).
  - `AUTOMATON_CONFIG_TEMPLATE` selects the runtime's config file in `docker/compose.agent.yml`; unset = the normal
    `./automaton.testnet.json`. `configTemplate()` (`docker/agent-instances.mjs`) accepts only `./automaton.<name>.json`
    files that exist in `docker/`; `run-oneoff` refuses anything else (exit 2) before compose runs and prints a note
    whenever another template is in use; the status/watchdog activity read mounts the same file; the watchdog's first
    log line names it; `agent:verify` always uses the normal template.
  - `docker/automaton.paytest.json` (new): the normal template plus `send_usdc` in `toolAllowlist` and a one-time
    genesis prompt (recall `self/payment_test_done`; if absent, send exactly 0.05 USDC to the creator with reason "Phase
    3 payment test" and store the result; then sleep; no other payment, never retry a refused or pending one, at most 5
    tool calls). Every other setting is identical (a test enforces this).
  - Preflight prints `INFO payment tools offered: …` (`none` with the normal template).
  Tests: `payment-limits` +1 (paytest = normal template except genesis prompt and `send_usdc`). `agent:verify` +3
  (normal template offers no payment tool; a bad template value refused; paytest template noted, preflight passes,
  `send_usdc` offered).
  Baselines: Linux 2097 passed; Windows 2065 passed, 22 known failures, 10 skipped; `agent:verify` 161.
- 2026-11-22: **Real agent payment wake passed** (Phase 3 step 7, part 3; build `bf35637`, 19:40–20:40 UTC,
  `AUTOMATON_CONFIG_TEMPLATE=./automaton.paytest.json`, `agent:run --detach --wake-now`, `agent:watch --hours 1
  --max-run-cents 4`). Watchdog DONE after 1 h, graceful `agent:down`, log saved; template switched back by the owner.
  Read-only review of the saved log and a copy of state.db:
  - One wake, 4 turns, exactly the genesis steps: `recall_facts` (no `payment_test_done`), `send_usdc` 5 cents to the
    creator ("Sent 0.05 USDC … tx 0xb913abad…, block 62272898"), `remember_fact self/payment_test_done`, `sleep 3600`.
    Wake ended "agent chose sleep"; no warning, no forced sleep, no retry.
  - Policy: the send was allowed; no denial during the wake. The 6 `send_usdc` denials in `policy_decisions` are the
    owner's payment test (19:01), one per refused case.
  - `onchain_transactions`: two rows, both `usdc_transfer` confirmed on eip155:84532 (payment test 0.10 USDC, 62,159
    gas; agent 0.05 USDC, 45,047 gas). `spend_tracking`: the same two (10 + 5 cents, UTC hour 19). Wallet 1.85 USDC.
  - Ledger: only inference (4 entries, 2.049¢; ~0.51¢ per call at 12.2–12.9k input tokens; 11 tools offered).
    No ledger entry for the transfers (by design: the wallet balance is read on chain).
  - Tier "high" the whole run (balance $6.15 = 1.90 USDC + $4.25 ledger), as expected; routing still used
    gpt-4.1-mini. The watchdog stops only on low_compute/critical/dead, so "high" did not stop it (CLAUDE.md said
    "tier not normal"; corrected).
  - Heartbeat: no `check_social_inbox` runs (H2 works). `heartbeatHistoryDays` 7: nothing old enough to prune yet
    (oldest row 2026-11-16).
  - Memory (H4): runtime 173 MiB peak at the wake, then 114 → 119 MiB over the hour; sandbox 16–21 MiB.
  - Facts: 11 (+ `payment_test_done`); the 7 stale run 1–5 facts are still there (owner may delete with
    `agent:facts:delete`). Soul unchanged (v91). DB 2.68 MB.
  Phase 3 "done when" met: testnet payment within limits (owner one-off and the agent itself), over-limit payments
  blocked in code at two layers (payment test, 9/9), key never leaks (encrypted at rest, leak test, passphrase
  absent from the sandbox).
- 2026-11-23: **Phase 4 plan approved; step 1: tier audit** (characterization tests only, no behaviour change).
  Owner decisions: dead = stay up, heartbeat only; heartbeat wakes only on a tier change; the walk drains with an owner
  `--wallet send` (creator only, same checks); the throwaway wallet reuses the secrets folder; the walk's settings (0.50
  USDC, reserve $0, scaled thresholds, `deadGraceMinutes` ~5) only in `automaton.tierwalk.json`.
  `src/__tests__/survival-tier-audit.test.ts` (9) pins today's behaviour: thresholds $5 / $0.50 / $0.10 / >= 0
  (negative = dead); agent_turn routing high/normal/low_compute → gpt-4.1-mini, critical → gpt-4.1-nano, dead → no
  model; `heartbeat_ping` asks for a wake on every ping while critical or dead; `check_credits` wakes only on a change
  into critical and sets dead after 1 h at <= 0, and funding clears the timer but not the state; a wake event ends a
  sleep at the next 30 s check (below the sleep floor); a wake in state dead overwrites it and calls the model.
  Findings F1–F6 and the tier table are in ROADMAP Phase 4; the `TODAY:` tests are flipped by the steps that change
  them. No source change.
  Baselines: Linux 2106 passed; Windows 2074 passed, 22 known failures, 10 skipped; `agent:verify` 161 (not rerun).
- 2026-11-23: **Survival thresholds and dead grace as settings** (Phase 4 step 2; finding F4). Owner approved F5 (route
  low_compute agent turns to nano) and F6 (leave the unused upstream helpers unwired) for step 3.
  - `config.survival` (`src/survival/settings.ts`, new): `highCents`, `normalCents`, `lowComputeCents`,
    `deadGraceMinutes`. Defaults equal the old hardcoded values exactly (500 / 50 / 10 cents from `SURVIVAL_THRESHOLDS`,
    60 minutes from `check_credits`). critical (>= 0) and dead (< 0) stay fixed.
  - Startup (`prepareRuntime`) refuses: non-whole or negative values, unknown keys, thresholds not strictly in order
    (`highCents > normalCents > lowComputeCents >= 0`, checked together with the defaults for a partial block), and
    `deadGraceMinutes` outside 1..10080 (so 0 cannot be set by accident). Preflight prints `INFO survival tiers: …`.
  - `getSurvivalTier(cents, thresholds)`: every production call passes `resolveSurvivalSettings(config)` (loop ×3,
    status snapshot, system prompt, `check_balance`, heartbeat tick context via scheduler and `forceRun`, planner
    context via orchestrator ×2 and the orchestrator harness, the unwired monitor); a source-scan test fails on any
    call without thresholds. `check_credits` uses `deadGraceMinutes`. The unused `getSurvivalTier` import in
    `heartbeat/tasks.ts` was removed.
  - The main template is unchanged (no `survival` block → the defaults), so the main agent behaves as before; the
    walk's scaled values go only into `automaton.tierwalk.json` (step 7).
  Tests: `survival-settings` (16: defaults = old values incl. every boundary; main template uses the defaults; source
  scan; 5 out-of-order cases; bad values; a scaled set; `deadGraceMinutes` 0/-5/1.5/"5"/10081 refused, 1 and 10080
  accepted; the heartbeat honours a 5-minute grace; preflight refuses out-of-order thresholds and a 0 grace, and prints
  the default tiers). `survival-tier-audit` (9) unchanged and passing.
  Baselines: Linux 2122 passed; Windows 2090 passed, 22 known failures, 10 skipped; `agent:verify` 161.
- 2026-11-23: **Tier behaviour fixes** (Phase 4 step 3; findings F1, F2, F3, F5; F6 stays unwired by owner decision).
  - Survival watch on every heartbeat tick (`src/survival/tier-watch.ts`, called by `DurableScheduler.tick`; not a
    scheduled task, so no history rows). The dead timer, entering/leaving dead and tier-change wakes moved here from
    `check_credits`, which runs only every 6 hours (a 1-hour grace could take up to 7 hours); `check_credits` now only
    records `last_credit_check`.
    - Entering dead: balance below $0 at once, or at <= $0 for `survival.deadGraceMinutes`. No wake.
    - Leaving dead (F3): only here, only when a live balance read is above $0: the state is set to `sleeping` (and
      `sleep_until` cleared) explicitly, logged, and recorded. An unavailable read changes nothing.
    - Every tier change of the effective tier ("dead" while the state is dead) is appended to kv
      `survival_tier_changes` (last 100: time, from, to, balance, woke, note) and logged as INFO, e.g.
      `Tier change: normal → low_compute (balance $0.30); agent woken`. The first observation is not a change.
    - Wakes (F2): one per tier change, never for a change into dead, and at most one per new setting
      `survival.tierWakeMinGapMinutes` (default 60, 1..1440; kv `last_tier_wake_at`). A balance bouncing across a
      boundary is recorded every time but cannot cause a wake storm. `heartbeat_ping` records the distress signal
      but no longer asks for a wake (upstream: every 15-minute ping while critical or dead).
  - Dead = heartbeat only (F1, owner decision): the run loop (`src/index.ts`) checks the state at the top of every
    cycle and, while dead, waits in `waitWhileDead` (`src/survival/dead-state.ts`; checks every 30 s, drops wake
    requests while still dead) instead of entering the agent loop; upstream slept 5 minutes and re-entered it. A dead
    agent stays dead across restarts and `--wake-now` (a pending sleep no longer turns it into sleeping). Second guard:
    `runAgentLoop` returns at once in dead (no wake counted, no model call), and a wake whose balance turns negative
    ends as "dead: balance below $0" before any model call.
  - F5 (owner-approved): low_compute agent turns route to gpt-4.1-nano (`DEFAULT_ROUTING_MATRIX`; was gpt-4.1-mini,
    the same as normal).
  - Effect on the main agent (template unchanged): no more distress wakes; a tier change wakes it once (at most once
    an hour); dead never calls the model.
  Tests: `survival-tier-watch` (14: dead at once below $0 and after the grace; unavailable reads change nothing; stays
  dead at $0, below $0 and on unavailable reads; leaves dead only above $0 with the state cleared; INFO lines; one
  wake per change; a 60-minute normal↔low_compute bounce gives 60 records and 2 wakes with a 30-minute gap; the gap
  setting; one wake event per change through the scheduler; 8 real heartbeat ticks in dead with the agent loop
  called each time: 0 model calls, then funding resumes; the agent loop in dead; a negative balance mid-wake).
  `survival-tier-audit`: the `TODAY:` tests flipped to `NOW (step 3)`. `heartbeat` (ping and check_credits no
  longer wake), `survival-settings` (+1 gap range; grace via the watch), `inference-router` (low_compute → nano).
  Baselines: Linux 2136 passed; Windows 2104 passed, 22 known failures, 10 skipped; `agent:verify` 161.
- 2026-11-23: **Only a live balance read decides survival** (Phase 4, owner check after step 3; owner kept revival
  without a wake gap). A failed wallet read was already never counted as $0 (the balance source falls back to the
  last good value, "cached", or reports "unavailable"), and the survival watch ignored "unavailable". It did act on
  "cached": the last good wallet value plus the current ledger, so a ledger change during an RPC outage could start
  the dead timer or record a tier change from a failed read. Now the survival watch (`evaluateSurvival`) acts only on
  status "live" (no timer, no dead in/out, no tier change otherwise), and the agent loop ends a wake as dead only on a
  live read.
  Tests: `survival-rpc-outage` (5, real scheduler and balance source, wallet-only balance with a $0 ledger, so a
  failed read counted as $0 would be dead after the 60-minute grace): 90 minutes of failing reads after a good read;
  a ledger change during the outage (fails without the fix: `normal → low_compute` recorded); a cold start with the
  RPC down; recovery; the agent loop on an unreadable balance.
  Baselines: Linux 2141 passed; Windows 2109 passed, 22 known failures, 10 skipped; `agent:verify` 161 (not rerun: no
  sandbox/Docker change).
- 2026-11-23: **Wallet balance read cache** (Phase 4, owner check after step 3). The heartbeat reads the survival
  balance on every 60 s tick and the agent loop once per turn; each read was an on-chain RPC call (about 60+ an hour;
  true since change 3, not new in step 3).
  - Setting `walletReadCacheSeconds` (`src/survival/balance.ts`; default 300, 0 = read on chain every time, max
    3600; startup refuses other values; preflight prints it). `createBalanceSource` passes it to `OwnBalanceSource`,
    which reuses a successful read younger than that (status stays "live"; the snapshot carries `walletReadAt`). A
    failed read after the cache expired is still "cached"/"unavailable" (never live, never $0).
  - `send_usdc` refreshes the cache right after a payment: confirmed or reverted → a fresh on-chain read is written;
    pending, or that read fails → the entry is removed (the next read goes on chain, and the reserve rule fails
    closed until then). `walletCacheKey()` is shared by the balance source, `send_usdc` and the reserve rule.
  - Effect: 12 on-chain balance reads an hour instead of 60 from the heartbeat (default).
  Tests: `wallet-read-cache` (8: 12 vs 60 reads in an hour of real ticks; reuse is live; expired + failing is
  cached; setting and validation; refresh after confirmed, reverted, pending and a failed read).
  Baselines: Linux 2149 passed; Windows 2117 passed, 22 known failures, 10 skipped; `agent:verify` 161.
- 2026-11-23: **Runway estimate** (Phase 4 step 4). `src/survival/runway.ts` (new):
  - Burn rate = inference spend in the ledger over the last 24 h, divided by the hours actually covered (at least 1,
    at most 24, never more than the time since the first ledger entry, so a young agent is not divided by 24 hours
    it has not lived). Only inference counts as burn (deliberate `send_usdc` payments and future revenue are not
    extrapolated).
  - From the survival balance and the owner's thresholds: the next lower tier, its boundary and the hours until it;
    hours until $0. No spend in the window = "no estimate" (never infinite); at or below $0 = "none".
  - Shown: in the per-turn status of the system prompt and the wake-up status (an unreadable balance gives
    "Runway: unknown"); in `agent:status` (activity report text and `runway` in `--activity --json`, from the last
    known balance and the configured thresholds); in preflight (one balance read through the cached source).
  - Example: `Runway: $6.15 lasts ~25 d 15 h at 1.0¢/h (inference, last 24 h); normal at $5.00 in ~4 d 19 h`.
  Tests: `runway` (12: 24 h window and old spend ignored; young agent; 1-hour minimum; no spend; next tier for every
  tier; scaled thresholds; at/below $0; formatting; durations; activity report text and JSON; before any balance
  read; wake-up status live and unreadable). `agent:verify` +1 (preflight runway and wallet read cache lines).
  Baselines: Linux 2161 passed; Windows 2129 passed, 22 known failures, 10 skipped; `agent:verify` 162.
- 2026-11-23: **Owner notice while dead** (Phase 4 step 5; owner kept the 24-hour runway window fixed and noted for
  Phase 5 that the runway must also count non-inference spending).
  - `src/survival/dead-notice.ts` (new). The survival watch writes one record when the agent enters dead (kv
    `dead_notice`: since, reason, network, balance at entry) and logs **one WARN** with the notice: per entry into
    dead, not per check (the run loop's wait logs nothing per 30 s check). Dead set by the agent loop (a live balance
    below $0) gets its record and WARN on the next heartbeat check.
  - The notice text is built when shown, from the latest balance: `DEAD since <UTC> (<reason>). No model calls until
    funded. Fund <wallet address> on <network>: at least X USDC to revive (critical), Y USDC to reach normal (balance
    now $Z). Or add an owner grant: pnpm agent:ledger:grant <dollars>.` (revive = balance above $0, normal = above
    `survival.normalCents`). When the balance is already above $0, it says the heartbeat revives the agent on its next
    live read instead. Only public data: the wallet address (from the identity table), amounts and times.
  - Shown while dead: first line of `agent:status` (`!!! …`; `deadNotice` in `--activity --json`, from the last known
    balance) and of `agent:wallet` (from the ledger plus the live wallet read). Not shown when alive.
  - Reviving deletes the record; the tier-history entry and the INFO line say `revived at <time> (dead since <time>)`.
  - Watchdog: a dead agent's notice is printed as `DEAD NOTICE: …` (console and watch log), then `STOP: the agent is
    dead` and a graceful `agent:down` (default unchanged: dead stops the run).
  Tests: `dead-notice` (11: one WARN across entry and 30 checks; negative balance; dead set by the loop; text and
  amounts at $0, below $0 and scaled thresholds; already above $0; no secrets; agent:status banner and JSON, fallback
  before the record; agent:wallet banner with the live balance and none when alive; revive clears it and records
  "revived at", dying again warns again). `agent:verify` +2 (the real watchdog on a stand-in runtime marked dead
  reports the notice and stops with exit 2; `agent:status` shows it).
  Baselines: Linux 2172 passed; Windows 2140 passed, 22 known failures, 10 skipped; `agent:verify` 164.
- 2026-11-23: **Confirmed: the network in the dead notice comes from the config** (owner check). The survival watch
  takes the label from `getActiveNetwork()`, which the runtime activates at startup from `config.network` (mainnet
  also needs `AUTOMATON_MAINNET_APPROVED`); the fixed "Base Sepolia (testnet)" strings were test fixtures only. New
  tests without a network override: testnet → "Base Sepolia (testnet)", mainnet with approval → "Base mainnet" in
  the record and the notice text. No source change.
  Baselines: Linux 2174 passed; Windows 2142 passed, 22 known failures, 10 skipped; `agent:verify` 164 (not rerun).
- 2026-11-23: **Watchdog `--allow-tiers`** (Phase 4 step 6, for the tier walk). `pnpm agent:watch --allow-tiers
  low_compute,critical,dead` (`docker/watch-agent.mjs`):
  - Only real tier names (high, normal, low_compute, critical, dead), comma-separated. An unknown name, no value, or a
    following flag taken as the value is refused before anything is watched (exit 2).
  - It only skips the tier stops listed (and, with `dead`, the dead-state stop; the dead notice is then printed once
    per entry into dead as `DEAD NOTICE (not stopping: --allow-tiers dead): …`). Every other rule stays on: the money
    caps (`--max-run-cents`, `--max-hour-cents`; the runtime's hourly/daily/lifetime caps are separate and untouched),
    turns per wake/hour, policy denials, forced wake ends, offline wakes, non-inference ledger entries, and the runtime
    count and old-image (build) checks.
  - When used, the start prints a banner (`!!! --allow-tiers: the watchdog will NOT stop on tier(s): …` and `!!! Still
    stops on tier(s): …. All other stop rules stay on: …`), and check lines mark an allowed tier `(allowed by
    --allow-tiers)`.
  - Default unchanged: without the option, low_compute, critical and dead stop the run.
  Tests: `agent:verify` +8 (four bad values refused before watching; allowed dead: banner, notice, no stop, agent left
  running; the money cap still stops with `--allow-tiers`; two runtimes still stop with `--allow-tiers`; default:
  critical still stops).
  Baselines: Linux 2174 passed; Windows 2142 passed, 22 known failures, 10 skipped; `agent:verify` 172.
