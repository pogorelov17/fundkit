# fundkit

A Markdown-only Agent Skill that lets an AI agent move USDT between a crypto wallet and
exchanges with a human approving every write. The agent talks to exchanges through the official MCP server
[`ccxt-mcp@0.1.3`](https://github.com/ccxt/ccxt/tree/master/mcp), pinned with `ccxt@4.5.85`,
the last ccxt release with which the server's `withdraw` still passes network, fee and memo
to the exchange. Works in Claude Code and Codex.

## Quick start

From the repository root, in Claude Code or Codex:

```text
Read SKILL.md and help me plan a USDT transfer.
```

That explicit read is all the skill needs. Start every fresh chat or host launch with it,
including the second (B) launch of scheme A. Without exchange servers the agent can explain the
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
  the address from the exchange UI and sends from the wallet by hand. Send amount, network fee
  (quoted amount or cap, asset and treatment) and expected credit are kept apart. The deposit is matched by transaction
  hash and expected credit.
- **Exchange A → exchange B** (semi-automatic). Accounts for account modes, available amount
  minus margin reserve, and a network enabled on both sides. Debit, withdraw amount and credit
  are computed separately. Then: exact plan for A → approval → separate withdrawal approval →
  verified final withdrawal success on A → a HANDOFF block with the source proof and hash → deposit matched in the fresh B chat → a new
  plan and approval for any transfer on B. Routes to Gate and from BingX use a manual
  withdrawal sheet in A's UI, with the same expected-credit and hash checks.
- **funding ↔ trading/margin** on one exchange.
- **Hyperliquid**: watch-only margin and position monitoring by public address.

Exchanges: Binance, Bybit, Gate, OKX, Bitget, WhiteBIT, BingX, MEXC, KuCoin, plus Hyperliquid
(read-only).

## Safety model

- **Keys.** The agent knows only account aliases and never reads the environment. One server
  per account. Claude Code passes its whole environment to every server; Codex forwards only
  each server's `env_vars`, but the values stay in the host environment. So either keep one
  account's keys and one enabled registration for that exchange per host launch, or have the
  operator launch each server separately
  ([schemes A and B](references/security.md#environment-contract)).
- **Approvals.** MCP writes run only from a plan with exact arguments and an expiry, after the
  reply `APPROVE <PLAN-ID>`. The first `withdraw` call also needs a separate
  `WITHDRAW <PLAN-ID>`; a requested deposit-address lookup needs `ADDRESS <PLAN-ID>`. The operator authorizes a manual send by signing or submitting
  the exact transaction on the current sheet before its expiry.
- **Execution.** No retries on an unknown outcome. A step counts only with an attributable ID
  and a success status, a deposit only by its full on-chain hash and expected credit. Pending
  records are polled read-only; failed, missing or ambiguous ones hold the route. Internal
  transfer proof is venue-specific: an API read on Binance, Bybit, OKX, Bitget classic, BingX
  and MEXC; on Gate, WhiteBIT, KuCoin and Bitget UTA only operator evidence agreed in advance,
  or the transfer is manual. Amounts are explicit and exact multiples of the currency,
  network and exchange steps. Network, chain, contract, fee and minimums are never guessed.
  API withdrawals run only for offline-verified "exchange + network" pairs; withdrawals to Gate
  and from BingX are manual. The full address, network and memo are checked on the final
  confirmation screen.
- **Fresh chats.** Carry the latest operation record forward. An open or unknown send is reconciled read-only. API withdrawals require a native confirmation form; otherwise use the exchange UI.
- **Crash hold.** A crash-cut entry in the shared ccxt-mcp journal stops all writes on every
  profile that shares it, for good: reads and operator investigation only.
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
gates, the approval token (including 60 s expiry) and the 300 s form wait, and the final
`withdraw` and `transfer` requests on all nine exchanges, built offline without sending;
transfer proof reads on all nine exchanges, journal crash entries and deposit hash
matching, all on mocked responses; two same-exchange registrations sharing one key. Also public network data,
`call_implicit_get`, the server environment and registration commands on Claude Code 2.1.331
and Codex 0.172.0 ([details](references/ccxt-mcp.md#verification)).

Not verified: real accounts, modes, available amounts, fee models, exchange responses to
writes and reads with a real key (the transfer proof table relies on the response shapes in
ccxt's code), and actual transfers. Network flags and fees are visible only with a key on most
exchanges, so plans are built from live data at request time. The skill gives no execution
guarantees. Use at your own risk and start with `dryRun`.
