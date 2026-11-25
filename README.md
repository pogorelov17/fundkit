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
   ([venue profiles](references/security.md#venue-profiles): credential fields, variable
   names and key rights for all nine exchanges).
2. **Host.** Register one server per profile and pick a launch scheme. Scheme C keeps each
   account's key in its own `chmod 600` profile file, so exchange A and exchange B are both
   connected in one session
   ([environment contract](references/security.md#environment-contract),
   [host registration](references/security.md#host-registration)).
3. **Check.** Run the [smoke check](references/security.md#smoke-check), then paste a
   [setup prompt](references/prompts.md#setup-and-diagnosis) as the first request.

Automatic skill discovery is optional and host-specific; this repository does not rely on it
([loading the skill](references/security.md#loading-the-skill)).

## What it does

- **OKX Wallet → exchange.** Picks a network from the exchange's live data. On each of the nine
  exchanges the agent reads the address, network and memo from the operator's own account
  with a read-only key ([native recipient reads](references/recipients.md)). Whether a network
  qualifies depends on the documented facts per venue (some hold). The operator
  enters the amount, pastes the verified address and memo into OKX Wallet and signs. Send amount, network fee
  (quoted amount or cap, asset and treatment) and expected credit are kept apart. The deposit is matched by transaction
  hash and expected credit.
- **Exchange A → exchange B** (semi-automatic). Both accounts are connected in the same
  session with separate credentials. The agent prepares everything: account modes, available
  amount minus margin reserve, a network enabled on both sides, B's recipient read from B's
  own account, and debit, withdraw amount and credit computed separately. The user approves
  the plan and the withdrawal and confirms each native form. The agent then proves the
  withdrawal on A, matches the deposit on B by hash and plans any transfer on B for its own
  approval. A HANDOFF block to a second chat is only the fallback without a B profile. A route
  runs only when every documented gate passes on live data. Where a venue documents no value
  for a needed fact (for example the Binance, MEXC and Gate deposit minimum, the KuCoin and Gate
  deposit fee, the WhiteBIT contract or the MEXC withdrawal step), the route holds. The user
  may then read that value in the UI and use the manual sheet.
- **funding ↔ trading/margin** on one exchange.
- **Hyperliquid**: watch-only margin and position monitoring by public address.

Exchanges: Binance, Bybit, Gate, OKX, Bitget, WhiteBIT, BingX, MEXC, KuCoin, plus Hyperliquid
(read-only).

## Safety model

- **Keys.** The agent knows only account aliases and never reads the environment. One server
  per account. Claude Code passes its whole environment to every server; Codex forwards only
  each server's `env_vars`, but the values stay in the host environment. So either put each
  account's credentials into its own `chmod 600` profile file and keep exchange keys out of
  the host environment (scheme C, both accounts in one session), keep one account's keys and
  one enabled registration for that exchange per host launch (scheme A), or have the operator
  launch each server separately (scheme B)
  ([environment contract](references/security.md#environment-contract)).
- **Approvals.** MCP writes run only from a plan with exact arguments and an expiry, after the
  reply `APPROVE <PLAN-ID>`. The first `withdraw` call also needs a separate
  `WITHDRAW <PLAN-ID>`. Every money move (`withdraw`, `transfer`) is confirmed by the human in
  the host's native form. A server without the form gets no money move, and the agent never
  redeems a confirmation token. Money-moving servers run under an operator-owned OS user,
  separate from the agent's. `get_deposit_address` is never called, because it can create an
  address on its own even under `dryRun`. The Gate and WhiteBIT address reads may create an
  address, so they run only with provisioning consent in the operator's setup record. The
  operator authorizes a manual send by signing or submitting the exact transaction on the
  current sheet before its expiry.
- **Execution.** No retries on an unknown outcome. A step counts only with an attributable ID
  and a success status, a deposit only by its full on-chain hash and expected credit. Pending
  records are polled read-only; failed, missing or ambiguous ones hold the route. Internal
  transfer proof is venue-specific: an API read on Binance, Bybit, OKX, Bitget classic, BingX,
  MEXC and Gate (`GET /wallet/transfers` by `tx_id`); on WhiteBIT, KuCoin and Bitget UTA only
  operator evidence agreed in advance, or the transfer is manual. Amounts are explicit and exact multiples of the currency,
  network and exchange steps. Network, chain, contract, fee and minimums are never guessed.
  API withdrawals run only for offline-verified "exchange + network" pairs, with whitelist
  evidence (Binance and Gate saved-address reads, otherwise the setup record). The full address, network and memo are checked on the final
  confirmation screen against their source (the native recipient read's tool result, or the
  deposit page if the user chose it), never against text pasted into the chat.
- **Fresh chats.** Carry the latest operation record forward. An open or unknown send is reconciled read-only. API withdrawals require a native confirmation form; otherwise use the exchange UI.
- **Crash hold.** A crash-cut entry in the shared ccxt-mcp journal stops all writes on every
  profile that shares it, for good: reads and operator investigation only.
- **Exchange side.** Minimal key permissions, IP allowlist and a withdrawal address whitelist
  ([key permissions](references/security.md#exchange-key-permissions)).

## Example requests

```text
Check which exchange profiles are connected and what they are allowed to do.
I want to top up Bybit with 150 USDT from OKX Wallet. Which network fits and what should I check before sending?
Give me my Bybit USDT deposit address for TRC20 so I can paste it into OKX Wallet.
Both accounts are connected: move 300 USDT from okx-src to bybit-dst, then settle it into the unified wallet with bybit-settle.
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
| [`references/recipients.md`](references/recipients.md) | native recipient reads (address, memo, landing wallet), deposit fee and minimum sources and hard limits per venue |
| [`references/prompts.md`](references/prompts.md) | copyable English and Russian prompts for setup, diagnosis, read-only checks and planning |

## Verification and limits

Verified in a scratch environment with no real keys and no live writes: pins, schemas and
gates, the approval token (including 60 s expiry) and the 300 s form wait, and the final
`withdraw` and `transfer` requests, built offline without sending; transfer proof reads,
journal crash entries and deposit hash matching; the Bybit deposit-address read; two
same-exchange registrations sharing one key; public network data, `call_implicit_get`, the
server environment and registration commands on Claude Code 2.1.331 and Codex 0.172.0.

On 2026-11-25 a repair pack replaced the previous fixture run, which had not enforced the route
gates. A reference planner follows this skill's gates on tool results only, over real ccxt-mcp
servers and a fixture transport (212 scenarios, 1294 checks, 0 failures,
[details](references/ccxt-mcp.md#verification)):

- **72 directed exchange pairs**, with the network chosen among TRC20, BEP20, ERC20 and TON.
  **24 settle**, from Binance, Bybit, Gate, OKX, Bitget, BingX or KuCoin to Bybit, OKX, Bitget
  or BingX. Each runs from the recipient read and both preflights through a native-form
  withdrawal, proof by id, a deposit matched by hash, and a transfer on B's settlement
  registration proven by id. **48 hold** before any money-moving call, with zero wire writes,
  because a venue documents no value for a needed fact: the Binance, MEXC and Gate deposit
  minimum, the KuCoin deposit fee, the WhiteBIT contract (both directions) and the MEXC
  withdrawal step. Bitget BEP20 also holds in both roles (id mismatch), so Bitget routes use TON.
- 84 isolated gate scenarios: 78 fail exactly the expected gate (pre-dispatch ones before any
  money-moving request), and 6 positive twins pass. 36 recipient reads pass the address, memo
  and raw-row checks on 9 venues × 4 networks. The stated holds remain.

Every response in those runs is synthetic, shaped after venue references and ccxt's parsers.
Not verified: real accounts, modes, available amounts, fee models, exchange responses to writes
and reads with a real key, whether a read-only key may read the deposit address on each venue,
and actual transfers. A settled fixture route does not show that a real route is ready. Hard
limits per venue are listed in
[`recipients.md`](references/recipients.md#status-by-destination-venue). Network flags and fees
are visible only with a key on most exchanges, so plans are built from live data at request
time. The skill gives no execution guarantees. Use at your own risk and start with `dryRun`.
