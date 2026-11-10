# Automaton Build Roadmap

Hybrid approach: start from the Conway fork and replace Conway-specific pieces with our own
providers one at a time. Rules in `CLAUDE.md` apply to every phase.
Estimates assume one developer, part-time. Total: about 4 to 6 months.

## Phase 0 — Study & setup (1 week) — IN PROGRESS
- [x] Fork and clone; `pnpm install` and `pnpm build` succeed (Node 22, Windows)
- [x] Read architecture; map Conway dependencies (see CLAUDE.md "Phase 0 findings")
- [x] Docker installed and working
- [ ] Write our own genesis prompt and review `constitution.md`
- [ ] Decide the ONE service the agent will sell (blocks Phase 5 planning)
- [ ] Apply planned changes 1–2 from CLAUDE.md (tighter treasury limits, testnet mode)
Done when: build passes, every `src/` folder is understood, sandbox is isolated.

## Phase 1 — Core agent loop (2 weeks)
Goal: Think → Act → Observe loop running safe tools, remembering what happened.
- Model client with retries, timeouts, token/cost counting (exists: `src/inference/`)
- Tool interface; start with a minimal safe tool set
- Turn limits per hour; SQLite persistence across restarts (exists: `src/state/`)
- Context summarization when history grows (exists: `src/memory/`)
- Structured logs with per-call cost
- Safety now: shell only inside Docker as non-root; hard daily spend cap in code; working kill command
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
- Our own balance source replacing Conway-only `getCreditsBalance()`
- Creator `fund` command
Done when: testnet payment works within limits; over-limit payments are blocked by code; key never leaks.

## Phase 4 — Survival system (1 week)
- Credit monitor converts balance into runway estimate
- Tiers: normal → low_compute → critical → dead, each mapped to a model
- Tier and runway in context every turn; clean shutdown at zero with owner notification
Done when: draining the testnet balance moves through all tiers correctly.

## Phase 5 — Earning (3–6 weeks, ongoing)
- Pick ONE narrow, legal, automatable service
- Small web server endpoint; per-request payment (x402 or USDC invoice)
- Own VPS + domain + HTTPS; replace `exposePort` (reverse proxy, e.g. Caddy)
- Agent operates, monitors and improves the service; honest, policy-compliant promotion only
- Track revenue vs cost
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
- Base mainnet with an amount the owner can afford to lose
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
