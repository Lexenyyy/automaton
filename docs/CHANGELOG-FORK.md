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
