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
