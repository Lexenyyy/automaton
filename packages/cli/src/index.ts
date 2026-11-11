#!/usr/bin/env node
/**
 * Conway Automaton CLI
 *
 * Creator-facing CLI for interacting with an automaton.
 * Usage: automaton-cli <command> [args]
 */

const args = process.argv.slice(2);
const command = args[0];

async function main(): Promise<void> {
  switch (command) {
    case "status":
      await import("./commands/status.js");
      break;
    case "logs":
      await import("./commands/logs.js");
      break;
    case "fund":
      await import("./commands/fund.js");
      break;
    case "send":
      await import("./commands/send.js");
      break;
    case "ledger":
      await import("./commands/ledger.js");
      break;
    default:
      console.log(`
Conway Automaton CLI - Creator Tools

Usage:
  automaton-cli status              Show automaton status
  automaton-cli logs [--tail N]     View automaton logs
  automaton-cli fund <amount> [--to 0x...]  Transfer Conway credits
  automaton-cli send <to-address> <message> Send a social message
  automaton-cli ledger [show]       Show the agent's ledger and balance
  automaton-cli ledger grant <amount> [--memo "..."]   Add an owner grant (dollars)
  automaton-cli ledger adjust <±amount> --memo "..."  Correct the ledger (memo required)
`);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
