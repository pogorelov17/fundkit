# fundkit

A Markdown-only Agent Skill that lets an AI agent move USDT between a crypto wallet and
exchanges with a human approving every write. There is no code: no programs, scripts,
packages or services. The agent talks to exchanges through the official MCP server
[`ccxt-mcp@0.1.3`](https://github.com/ccxt/ccxt/tree/master/mcp), pinned with `ccxt@4.5.85`,
the last ccxt release with which the server's `withdraw` still passes network, fee and memo
to the exchange. Works in Claude Code and Codex.

## Quick start

From the repository root, in Claude Code or Codex:

```text
Read SKILL.md and help me plan a USDT transfer.
```

That explicit read is all the skill needs. Without exchange servers the agent can explain the
flow but stops before live data. To let it read live data and execute approved writes, the
operator sets up:

1. **Server.** Install the pinned server ([install](references/ccxt-mcp.md#install)) and create
   one `config.json` per account, starting with `"dryRun": true`
   ([profile config](references/security.md#profile-configjson)).
2. **Host.** Register the servers without secrets and pick launch scheme A or B
   ([environment contract](references/security.md#environment-contract),
   [host registration](references/security.md#host-registration)).
3. **Check.** Run the [smoke check](references/security.md#smoke-check), then ask the agent
   for a preflight check as the first request.

Automatic skill discovery is optional and host-specific; this repository does not rely on it
([loading the skill](references/security.md#loading-the-skill)).

## What it does

- **OKX Wallet → exchange.** Picks a network from the exchange's live data; the human copies
  the address from the exchange UI and sends from the wallet by hand. The deposit is matched
  by transaction hash.
- **Exchange A → exchange B** (semi-automatic). Accounts for account modes, available amount
  minus margin reserve, and a network enabled on both sides. Debit, withdraw amount and credit
  are computed separately. Then: exact plan → approval → separate withdrawal approval →
  reconciliation by ID.
- **funding ↔ trading/margin** on one exchange.
- **Hyperliquid**: watch-only margin and position monitoring by public address.

Exchanges: Binance, Bybit, Gate, OKX, Bitget, WhiteBIT, BingX, MEXC, KuCoin, plus Hyperliquid
(read-only).

## Safety model

- **Keys.** The agent knows only account aliases and never reads the environment. One server
  per account. Hosts do not isolate keys between servers (Claude Code passes its whole
  environment to each one), so keep one account's keys per host launch or have the operator
  launch each server separately ([schemes A and B](references/security.md#environment-contract)).
- **Approvals.** Writes run only from a plan with exact arguments and an expiry, after the
  reply `APPROVE <PLAN-ID>`. The first `withdraw` call also needs a separate
  `WITHDRAW <PLAN-ID>`; a requested deposit-address lookup needs `ADDRESS <PLAN-ID>`.
- **Execution.** No retries on an unknown outcome. A step counts only with an attributable ID,
  a deposit only by its on-chain hash. Amounts are explicit and exact multiples of the
  currency, network and exchange steps. Network, chain, contract, fee and minimums are never
  guessed. Withdrawals run only for offline-verified "exchange + network" pairs; withdrawals
  to Gate and from BingX are manual.
- **Exchange side.** Minimal key permissions, IP allowlist and a withdrawal address whitelist
  ([key permissions](references/security.md#exchange-key-permissions)).

## Example requests

```text
Check which exchange profiles are connected and what they are allowed to do.
I want to top up Bybit with 150 USDT from OKX Wallet. Which network fits and what should I check before sending?
Make a plan: 300 USDT must arrive on Bybit (UTA) from OKX (trading account), keep a 100 USDT margin reserve on OKX.
Move 50 USDT from main to trade on KuCoin. Plan first.
How much free margin and which positions are on Hyperliquid for address 0x…?
The last withdrawal is stuck. Reconcile what actually happened without repeating anything.
```

## Files

| File | Contents |
|---|---|
| [`SKILL.md`](SKILL.md) | agent rules and scenarios |
| [`references/ccxt-mcp.md`](references/ccxt-mcp.md) | pins, tool schemas, approval gates, journal, limitations, verification |
| [`references/exchanges.md`](references/exchanges.md) | wallets, network data, outbound withdraw table, amount steps, account modes |
| [`references/security.md`](references/security.md) | environment contract, host registration, loading the skill, smoke check, key permissions |

## Verification and limits

Verified in a scratch environment with no real keys and no live writes: pins, schemas and
gates, the approval token (including 60 s expiry), and the final `withdraw` and `transfer`
requests on all nine exchanges, built offline without sending. Also public network data,
`call_implicit_get`, and the server environment on Claude Code 2.1.331 and Codex 0.172.0
([details](references/ccxt-mcp.md#verification)).

Not verified: real accounts, modes, available amounts, fee models, exchange responses to
writes, and actual transfers. Network flags and fees are visible only with a key on most
exchanges, so plans are built from live data at request time. The skill gives no execution
guarantees. Use at your own risk and start with `dryRun`.
