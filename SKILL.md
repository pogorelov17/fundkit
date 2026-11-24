---
name: usdt-funding
description: >-
  Plan and semi-automatically execute USDT funding moves between centralized exchanges
  (Binance, Bybit, Gate, OKX, Bitget, WhiteBIT, BingX, MEXC, KuCoin) through the official
  ccxt-mcp 0.1.3 server pinned to ccxt 4.5.85, plus manual OKX Wallet deposits to an exchange
  and watch-only Hyperliquid margin monitoring. Use when the user wants to move, top up or
  fund USDT between exchanges, transfer between funding and trading wallets, pick the cheapest
  network, copy a deposit address into OKX Wallet, or check free margin on Hyperliquid.
  Enforces live network checks on both sides, verified chain and contract, offline-verified
  withdraw requests only, explicit gross/withdraw/net fee math, an exact expiring plan bound to
  human approval, a separate approval before any withdrawal, no retries on unknown outcomes,
  and reconciliation only by attributable IDs.
---

# USDT funding: OKX Wallet → exchange, exchange A → exchange B, funding ↔ trading

Reply in the user's language, but keep the approval keywords below exactly as written. You
plan and execute writes only through the `ccxt-mcp` MCP server. Read the state first, then
build an exact plan. Execute writes only after explicit human approval. Do not write or run
programs or scripts of your own.

Detailed tables live in [`references/`](references/): pins, schemas and gates in
[`ccxt-mcp.md`](references/ccxt-mcp.md), per-exchange data in
[`exchanges.md`](references/exchanges.md), environment and key setup in
[`security.md`](references/security.md). Read the reference a step points to before you act
on it.

## Hard rules

1. **You never see or ask for keys.** You only know account aliases (`okx-main`) and tool
   results. If the user pastes an API key, secret, passphrase, seed or private key into the
   chat, do not use it and ask them to rotate it immediately. Never print the environment in
   any way: no `env`, `printenv`, `set`, `export -p`, `declare -x`, `ps e`, `/proc/*/environ`,
   `echo $…_SECRET`. Do not use the shell to read `.env` files, profile configs or the server
   journal.
2. **A plan is bound to exact arguments and an expiry.** Writes are `transfer`, `withdraw`,
   `get_deposit_address` (the first call may *create* an address), `create_order`, `cancel_*`,
   `set_*`, `call_write_method` and `call_implicit_write`. Before any write, show a plan with
   the **full JSON arguments** of every call and `expires <UTC>`, and get the reply
   `APPROVE <PLAN-ID>`. The deposit-address mini-plan uses `ADDRESS <PLAN-ID>` instead. If any
   field changes (amount, network, address, memo, wallet, `params`, order) or the plan has
   expired, you need a new plan and a new approval.
3. **Withdrawals get their own approval, in advance.** Before the **first** `withdraw` call,
   show its exact JSON and get a separate `WITHDRAW <PLAN-ID>` from the human. On hosts with a
   native confirmation form (Claude Code and Codex both support it), the first call opens the
   form, and accepting the form sends the withdrawal immediately.
4. **Withdraw only with a verified request.** The pair "exchange A + network" must appear in
   the [outbound withdraw table](references/exchanges.md#outbound-withdraw). Pass `network` at
   the top level and the memo only in `tag`. Put exactly what the table requires for that
   exchange into `params`: `fee` for OKX, `accountType` for Bybit, `uta` for Bitget, `{}` for
   the rest. Any other key (`chain`, `network`, `includeFee` and so on) goes to the exchange
   and overrides the request, and it is visible neither in the preview nor in the form. For
   example, `params.chain` on Bybit replaced BSC with ETH (verified). If the pair is not in the
   table, or the exchange is marked "manual only", the human withdraws in the exchange UI.
5. **No retries until non-execution is proven.** On `UNKNOWN_OUTCOME`, a host timeout, a
   dropped connection, no response, or any error that is not on the
   [not-sent list](#26-responses-what-was-definitely-not-sent), retry nothing. Non-execution is
   proven **only** by a code from that list, or by an explicit operator finding from the
   exchange's own records (UI or support) covering the window from the snapshot to now. An
   empty API history, an empty `unresolvedIntents` and an unchanged balance are not proof. A
   retry is possible only as a new plan.
6. **Amounts are explicit.** Do not accept "all", "max" or "the rest" without a number. Every
   amount is a USDT number labeled with its meaning (debit, call argument or credit, see
   [2.3](#23-debit-withdraw-amount-and-credit)) and exactly representable in the currency,
   network and exchange steps (also 2.3). Never exceed `maxTransferValue` or the user's limit.
7. **Never guess the network, fee, minimum, contract or chain.** If a field did not come in a
   live response and the human did not read it in the exchange UI, it is "unknown", and a
   network with an unknown field does not qualify. Do not suggest small "test" transfers.
8. **Hyperliquid is watch-only** by public address. No transfers, withdrawals, orders or
   private keys (collateral there is USDC).
9. **Do not trust addresses from the chat.** The human copies the deposit address from
   exchange B's UI and checks it outside the chat. For a withdrawal from exchange A, the
   address must already be on A's withdrawal whitelist.

## Call syntax

`call_read_method` always has two required fields, `exchange` and `method`, even when
`account` is set. Without `exchange` the host returns `-32602 Required at exchange`. The
`exchange` value must match the account's exchange. Pass positional arguments in `args`, for
example `[code, since, limit]`, and use `null` for a skipped one.

```text
call_read_method {"exchange":"okx","account":"okx-main","method":"fetchDepositWithdrawFee","args":["USDT"],"includeInfo":true}
call_read_method {"exchange":"okx","account":"okx-main","method":"fetchBalance","params":{"type":"funding"},"includeInfo":true}
call_read_method {"exchange":"okx","account":"okx-main","method":"fetchWithdrawals","args":["USDT",null,20]}
call_implicit_get {"exchange":"kucoin","method":"publicGetCurrenciesCurrency","params":{"currency":"USDT"}}
call_implicit_get {"exchange":"gate","method":"publicWalletGetCurrencyChains","params":{"currency":"USDT"}}
```

With ccxt-mcp 0.1.3 and ccxt 4.5.85, `call_implicit_get` accepts only camelCase names
(snake_case returns `UNKNOWN_ENDPOINT`). Use it only for the
[network data sources](references/exchanges.md#network-data-sources). Schemas:
[`references/ccxt-mcp.md`](references/ccxt-mcp.md#tools).

## Step 0. Preflight (read-only)

For each server involved:

1. Call `get_safety_status {}`. It must return `version: "0.1.3"` and `ccxtVersion: "4.5.84"`
   (that is how ccxt 4.5.85 reports itself). On any other version, **stop**: ccxt 4.5.87+ with
   ccxt-mcp 0.1.3 sends withdrawals without network, fee and memo (verified). `configProblems`
   must be empty; with `strictPermissions`, a config readable by other users (not
   `chmod 600`) shows `REFUSED` there. Note `elicitationSupported`. If `unresolvedIntents` is
   not empty, **stop**: the journal is shared by all profiles of one OS user, so those entries
   may belong to another alias. Reconcile them first through the server for that alias.
2. Call `list_accounts {}`: check the alias, `exchange`, `environment`, `funds`, `dryRun`,
   `confirm` (not `never`) and `maxTransferValue`. Aliases must be unique across all servers.
3. Tell the user which profiles are read-only, which have `funds: "live"` and with what cap,
   and whether the native form is available. Only the operator can enable a missing tier, in
   the config; it cannot be done from the conversation.

If no `ccxt-mcp` tools are available, say so, explain what the operator needs to set up
([`references/security.md`](references/security.md)), and stop before any live data or plan
numbers. You may still explain the flow in general terms.

## Scenario 1. OKX Wallet → exchange (manual send)

OKX Wallet is a non-custodial wallet. Only the human sends from it, by hand.

1. Ask the user for the destination exchange, the networks where they hold USDT in OKX
   Wallet, and the amount.
2. Read the destination's network data from the
   [source listed for that exchange](references/exchanges.md#network-data-sources): deposit
   enabled, deposit minimum, deposit fee, contract, memo. An empty response or an error means
   "no data", not "network disabled". If the source lacks a field (for example the Gate
   deposit minimum), the human reads it on the exchange's deposit page, and the plan says
   "source: human, <exchange> UI".
3. A network qualifies if its chain is in the [chain table](#chains), deposits are enabled,
   the USDT contract on that chain matches both the wallet's contract and the reference, and
   the amount is at least the minimum. Reject bridged variants and other contracts.
4. By default the human copies the address **themselves** in the exchange app (Deposit →
   USDT → network). Call `get_deposit_address` only if the human asked for it separately, the
   profile has `funds`, and you showed a mini-plan `PLAN <PLAN-ID>` with the exact JSON of
   that call and an expiry, and the human replied `ADDRESS <PLAN-ID>`. Warn that the first
   call may create a new address and that `dryRun` does not stop this tool.
5. Before sending, the human checks that the wallet network matches the deposit network, that
   the first and last 6 characters of the address match in two places, and that the memo is
   set if one is required.
6. After sending, ask for the transaction hash from the wallet and credit the deposit by the
   [deposit rule](#27-reconciliation). If the funds must reach a trading wallet, run
   Scenario 3.

## Scenario 2. Exchange A → exchange B (semi-automatic)

### 2.1 Account mode and available amount (live data)

- **Account mode** comes from a live response, never a guess: Bybit UTA or classic, OKX
  `acctLv` (`fetchAccounts` with `includeInfo`), Binance classic or Portfolio Margin, Gate /
  Bitget / KuCoin classic or unified. The mode decides wallet names, the withdrawal wallet and
  the Bybit and Bitget `params`. Unknown mode: stop.
- **Available to transfer or withdraw** is the exchange's field for that mode in the raw
  `fetchBalance` response of the right wallet with `includeInfo: true`. Put the field name
  and value in the plan. `free` without such a field is not an available amount. No field:
  stop. Where to look: [account mode table](references/exchanges.md#account-mode-and-available-amount).
- **Margin reserve** is named by the user; suggest at least 20 % of used margin and at least
  10 USDT. Check positions with `get_positions`. The transferable amount is
  `min(exchange available, free − reserve)`. A transfer must not move a position closer to
  liquidation without explicit consent.

### 2.2 Network choice (both sides, live data)

1. On **each** side, read the network from that exchange's
   [network data source](references/exchanges.md#network-data-sources). Do not use
   `fetchCurrencies` to pick a network: a response over 80,000 characters is replaced whole
   by `{"truncated":true}`. If this host launch has no keyed profile for B (scheme A) and B's
   source needs a key, the human reads B's fields on B's deposit page (the plan names that
   source). Without that, hold the route.
2. Enable flags, minimums, contract, memo and precision appear only in `info` (or in the
   `call_implicit_get` response), with different field names per exchange. A missing field is
   **unknown**, and the network does not qualify. Infer nothing from the network name.
3. A candidate qualifies only if all of these hold:
   - the pair "A + network code" is in the
     [outbound withdraw table](references/exchanges.md#outbound-withdraw), and the outbound
     value from the table matches the network id in A's live response;
   - B's network id comes from B's live response (or from B's deposit page if the response
     lacks it);
   - both sides are on the same chain from the [chain table](#chains), confirmed by an
     exchange field (name, `chainId`, explorer link) or by the human in each side's UI;
   - the USDT contract on both sides matches that chain's reference (compare EVM addresses
     case-insensitively). If a side does not return the contract (WhiteBIT), the human reads
     it in the UI;
   - withdrawals on A are enabled (including for API, if the exchange distinguishes) **and**
     deposits on B are enabled, and the amount is within every minimum and maximum;
   - B is not Gate: there is no automatic withdrawal to Gate, because Gate's deposit minimum
     is not available by API. A route to Gate is
     [manual only](references/exchanges.md#gate-as-recipient-manual-only).
4. Matching names (`BEP20` and `BSC`) prove nothing. The same contract address can exist on
   several EVM chains, so chain **and** contract decide together.
5. Network cost is A's withdrawal fee plus B's deposit fee plus internal transfers. Pick the
   cheapest; on a tie, the faster one.

#### Chains

Only these chains. The USDT reference contracts matched across Gate, KuCoin and Bitget.

| ccxt code | Chain | USDT reference contract |
|---|---|---|
| `TRC20` | Tron mainnet | `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` |
| `BEP20` | BNB Smart Chain, EVM chainId 56 | `0x55d398326f99059fF775485246999027B3197955` |
| `ERC20` | Ethereum mainnet, EVM chainId 1 | `0xdAC17F958D2ee523a2206206994597C13D831ec7` |
| `TON` | TON mainnet (memo required if the exchange asks for one) | `EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs` |

### 2.3 Debit, withdraw amount and credit

Keep three numbers apart:

- `D`: the **gross debit** on A (what leaves the balance);
- `W`: the **`amount` argument** of `withdraw`;
- `C`: the **net credit** on B.

Let `f` be A's withdrawal fee (fixed plus percentage, if any) and `d` be B's deposit fee.
Both must be exact: from a live exchange field or from B's deposit page as read by the human.
Unknown `d`: stop.

| A's fee model | `D` | `C` |
|---|---|---|
| on top | `W + f` | `W − d` |
| deducted from amount | `W` | `W − f − d` |
| **unconfirmed** (default) | `W` to `W + f` | `W − f − d` to `W − d` |

Treat the model as unconfirmed until exchange fields or documentation show it directly. With
an unconfirmed model, require at least `W + f` available, and the lower bound of `C` must be
at least B's deposit minimum. Plan the final transfer on B at no more than the lower bound of
`C`.

Example (debit budget): budget 100 USDT, `f = 1` on top, `d = 0`. Then `W = 99`, `D = 100`,
`C = 99`. If the model is unconfirmed, `W = 99` gives `D` from 99 to 100 and `C` from 98 to
99.

Example (target credit): B must receive 300 USDT, `f = 1`, `d = 0`, model unconfirmed. Use
`W = 300 + f + d = 301`: then `C` is 300 to 301, `D` is 301 to 302, and A must have at least
302 available.

- **Fee in another asset.** If `f` or `d` is charged in something other than USDT, do not add
  it into `D`/`W`/`C`. Check that asset's balance on the right side separately: it must cover
  the fee plus a reserve the user names. Unknown asset: stop.
- **OKX.** Pass `{"fee":"<f>"}` in `params`, where `f` is the exact fee for that network from
  the same live response the plan was built on. ccxt 4.5.85 sends it as `fee` (verified).
  Without `fee`, ccxt takes the fee from its own currency data (`GET /asset/currencies`,
  merged with the load cache), not from the plan. A call without `fee` is therefore not
  allowed.
- **Minimums.** Check `W` against A's withdrawal minimum and `C` against B's deposit minimum.
- **Representable amounts (before plan approval).** Every call amount (`W` and each
  `transfer` `amount`) must reach the exchange unchanged:
  - at most 15 significant digits and at least `0.000001`: MCP passes the amount as a JSON
    number, some exchanges receive it as a number too, and `0.0000001` went out as `1e-7`
    (verified offline);
  - the amount is a multiple of **every** step: currency, network, and the exchange's own
    step for that withdrawal or transfer. ccxt rounds some calls by the currency step and
    others by the network step, usually to nearest, so possibly up (see the
    [amount step table](references/exchanges.md#amount-steps)). Each step comes from a live
    field (name and value in the plan), from that table, or from the withdrawal page as read
    by the human. Any step unknown: stop;
  - if the amount fails, reject it and do not silently adjust it, neither yourself nor by
    letting ccxt round it. A smaller multiple is a new plan: recompute `D`, `W`, `C`, `f`,
    `d`, minimums, reserve, budget and target credit. Target no longer met: stop.

  Example: Gate, `W = 10.12349`, ccxt currency step `0.0001`, network step `0.00001`. Gate
  rounds by the currency step and would send `10.1235`, more than planned (verified offline).
  The original amount is rejected. `10.1234` is allowed only after recomputing: if B needs at
  least `X`, the lower bound of `C` at the new `W` must stay ≥ `X`, otherwise stop.

### 2.4 Plan

```text
PLAN <PLAN-ID>  (for example FK-20261124-1312-OKX-BYBIT), created <UTC>, expires <UTC + 15 min>
Route: <A-alias> (<mode>) → <B-alias> (<mode>), USDT
Chain: <Tron mainnet | BNB Smart Chain 56 | Ethereum 1 | TON mainnet>, contract <…> (A: <source>, B: <source>)
Network: A network=<ccxt code> → outbound <field>=<value> = id in A's response <…>; B network id <…> (<source>)
Candidates: <network / A withdraw / B deposit / fee / min / field source>
Available on A: <field>=<value>, reserve <R>, transferable <T>
Amounts: D=<…>, W=<…>, C=<…> (fee model: <on top | deducted | unconfirmed>); f=<…> <asset>, d=<…> <asset>
Amount steps: currency <…>, network <…>, exchange <…> (<source>); W and transfer amounts are multiples of all, ≤ 15 significant digits, ≥ 0.000001
B address: <first6>…<last6>, memo <none | …>, copied by the human from B's UI, on A's whitelist: yes
Calls (exactly these arguments):
  1. transfer {"account":"<A>","code":"USDT","amount":<…>,"fromAccount":"<…>","toAccount":"<…>","params":{}}
  2. withdraw {"account":"<A>","code":"USDT","amount":<W>,"address":"<…>","tag":"<memo as a string, only if required>","network":"<code>","params":<per table>}   ← separate WITHDRAW <PLAN-ID>
  3. (wait) credit on B by transaction hash (2.7)
  4. transfer {"account":"<B>","code":"USDT","amount":<≤ C_min>,"fromAccount":"<…>","toAccount":"<…>","params":{}}   ← new plan if this one has expired
Before each write: expiry and that step's checks (2.5). Both networks are checked before the withdrawal.
Caps: maxTransferValue A=<…>, B=<…>; user limit <…>
To approve: APPROVE <PLAN-ID>
```

### 2.5 Executing each write

1. **Expiry.** Before **every** dispatch, including redeeming a token and the final transfer
   on B, check that the current UTC time is strictly before `expires`. If `now ≥ expires`, the
   plan has expired, and the remaining steps go into a new plan with a new approval (and a new
   `WITHDRAW` for a withdrawal). The final step after waiting for the deposit almost always
   needs a new plan.
2. **Recheck before the call.** For every step, compare the exact arguments with the approved
   plan and check the account mode, available amount, reserve and caps on the debited
   exchange. What else to check depends on the step:
   - **Internal transfer on A**: both A wallets and the exact transfer amount.
   - **Withdrawal from A** (initial data checks): both networks per 2.2, address and memo,
     fees, minimums and amounts per 2.3. If B's data is only available in B's app, the
     operator checks it there before the withdrawal.
   - **Internal transfer on B** (destination-only settlement): confirm the credit by the
     hash from the A session per 2.7, then check the credited wallet, its available amount,
     the target wallet and the exact transfer amount. B's data plus the withdrawal result
     saved in the chat are enough for this step; do not re-read A or recheck the networks.

   If any condition of the step is unknown, stop. If the conditions of the approved plan have
   changed, recompute the remaining steps and get a new approval.
3. **History and balances.** Before a withdrawal, save the latest IDs from `fetchWithdrawals`
   on A and the balance of the debited wallet. Before each internal transfer, save the
   balances of both wallets and the latest IDs from `fetchTransfers` on the same exchange,
   where the method exists (2.7). After the withdrawal, the A session finds the record by its
   ID and saves the PLAN-ID, network and on-chain hash in the chat. If a new launch opens a
   separate chat, carry the approved plan and the journal line over. The B session finds the
   deposit by hash in `fetchDeposits` and records the credit ID.
4. **Call with exactly the plan's arguments.**
   - `elicitationSupported: true`: the call opens the host's form. The form shows only a
     preview (amount, wallets or address and network, memo, environment) and one `confirm`
     field (yes/no); it has no PLAN-ID, no expiry and no `params`. So **before** the call,
     tell the human: `<PLAN-ID> step <n>: the form opens now, plan expires <UTC>`. The human
     accepts the form only if, at the moment of accepting, they have checked the clock
     themselves, it is strictly before that expiry, and every form field matches the plan. If
     `now ≥ expires` or a field cannot be checked, they decline. Accepting sends the write
     immediately.
   - Confirmed decline (`CONFIRM_DECLINED`, `CONFIRM_CANCELED`): nothing was sent. Remaining
     steps only via a new plan with fresh data and new `APPROVE` (and `WITHDRAW`).
   - Form response lost or unknown (host timeout, dropped connection, no response): the write
     may have gone out. Reconcile per 2.7 only; do not repeat the call.
   - `elicitationSupported: false`: a call without `confirm` returns a preview and a
     `confirmToken` that lives 60 s. Compare the preview with the plan field by field, then
     repeat the **identical** call with `"confirm":"<token>"`. Do this only if the human has
     already approved exactly these arguments (`APPROVE`, plus `WITHDRAW` for a withdrawal).
     The model itself can redeem the token, so human approval is mandatory here.
5. `CONFIRM_EXPIRED` means nothing was sent. Repeat steps 1–2. If everything matches and the
   plan is still valid, get a new preview with the same arguments and redeem the token. If
   anything changed, a new approval is required.
6. After each step, reconcile against history (2.7) and write a journal line.

### 2.6 Responses: what was definitely not sent

| Response | Meaning | Action |
|---|---|---|
| `CONFIRM_INVALID`, `CONFIRM_EXPIRED`, `CONFIRM_MISMATCH` | token rejected before dispatch | new preview per 2.5, item 5 |
| `CONFIRM_DECLINED`, `CONFIRM_CANCELED` | the human declined or closed the form; nothing sent | stop; remaining steps need a new plan and new approvals |
| `CONFIRM_UNAVAILABLE` | the form did not open; nothing sent | ask the human, then the same approved call |
| `TIER_DISABLED`, `TRANSFER_VALUE_CAP`, `DAILY_VALUE_CAP`, `UNVALUABLE_TRANSFER`, `UNKNOWN_ACCOUNT`, `-32602` | gate or schema rejection before dispatch | stop and report |
| **everything else**: `UNKNOWN_OUTCOME`, `EXCHANGE_ERROR`, `INSUFFICIENT_FUNDS`, `AUTH_FAILED`, `BAD_REQUEST`, `INTERNAL_ERROR`, host timeout, dropped connection, no response | the write may have gone out | reconcile per 2.7, no retries |

Inside `withdraw` and `transfer`, ccxt makes preliminary reads: account mode on Bybit,
currencies on OKX without `fee`, a UTA probe on Bitget and KuCoin. Their failure also comes
back as `UNKNOWN_OUTCOME` and cannot be told apart from a failure of the write itself.

### 2.7 Reconciliation

- **A step is done only with an attributable unique ID.** That is either the `id` in the
  call's own response, or the ID of a record that the operator, in the exchange UI,
  unambiguously attributes to this step (created by this key within the call window). You
  then find that ID through `fetchWithdrawals` / `fetchTransfers` and record it in the
  journal.
- Matching amount, address, network or wallets, and balance shifts, are **not** proof, even
  when the timing matches: a parallel operation (another session, the UI, another person)
  looks the same. Report such records as "candidate" and go no further.
- An empty `get_safety_status.unresolvedIntents` **does not prove** nothing went out. On
  `UNKNOWN_OUTCOME` the journal closes the intent with an `error` entry and it leaves the
  list. The server never sees a host timeout. The list shows only intents cut off by a
  process crash.
- **Deposit credit** (Scenarios 1 and 2). Read history with `includeInfo: true`:
  `call_read_method {"exchange":"<B>","account":"<B-alias>","method":"fetchDeposits","args":["USDT",null,20],"includeInfo":true}`.
  In the A session, read `fetchWithdrawals` with `includeInfo: true` and write the hash into
  the chat.
  - `id` is an operation number inside one exchange; it links a call to a record on that
    same exchange. The only link across exchanges, or to the wallet, is the on-chain
    transaction hash. Usually that is `txid`, but WhiteBIT puts the hash in raw
    `info.transactionHash`, while its unified `txid` is an internal WhiteBIT id (verified
    offline).
  - Compare networks within one namespace: raw with raw, unified with unified. KuCoin raw
    `info.chain: "bsc"` is the `chainId` from the network source, while unified
    `network: "BEP20"` is the ccxt code (verified offline). Do not compare `bsc` with
    `BEP20`.
  - A deposit counts only if there is **exactly one** such record, its hash equals A's
    withdrawal hash (or the hash from the wallet), the asset is USDT, the chain is the
    plan's, the status is complete (`ok`), and the credited amount is unambiguous, within the
    plan's `C` (if the plan sets one) and at least the fixed amount of the final transfer.
  - Several candidates, no hash, an incomplete status, a record that does not show how much
    was credited, or a record that changed after reconciliation (amount, network, status):
    hold the route. Do not take the next step; report and wait for a new plan and approval.
- Call only history methods the exchange has. Gate and WhiteBIT have no `fetchTransfers`. If
  an internal transfer there returned no `id`, hold the route: no further steps until the
  operator reconciles the transfer in the exchange UI and gives its ID, or confirms
  non-execution per rule 5. Report any discrepancy over 0.01 USDT.

## Scenario 3. funding ↔ trading/margin on one exchange

Same cycle: account mode → available amount and reserve → a plan with one `transfer` and an
expiry → `APPROVE <PLAN-ID>` → expiry check and recheck → call → reconciliation by ID (2.7).
Take wallet names only from the [wallet table](references/exchanges.md#wallets-for-transfer).
On Gate and Bitget, `funding` is an alias of `spot`, so `funding → spot` is meaningless
there. On BingX, `future` is `stdFutures`, while USDT-M perpetual is `swap` or `linear`
(`USDTMPerp`).

## Scenario 4. Hyperliquid margin monitoring (watch-only)

The profile holds only a public `walletAddress`, with no keys and no `funds`/`trading`.
Margin fields appear **only** in `info`:

```text
call_read_method {"exchange":"hyperliquid","account":"hl-watch","method":"fetchBalance","includeInfo":true}
call_read_method {"exchange":"hyperliquid","account":"hl-watch","method":"fetchBalance","params":{"type":"spot"}}
get_positions {"account":"hl-watch"}
```

From `info`, report `marginSummary.accountValue`, `totalMarginUsed`,
`crossMaintenanceMarginUsed` and `withdrawable`; `get_balance` does not show them. If `info`
contains `balances` instead of `marginSummary`, the address runs in unified mode (ccxt then
reads spot state). Stop and say margin cannot be checked with this tool; do not derive it
from spot balances. Without a profile, read via
`call_read_method {"exchange":"hyperliquid","method":"fetchBalance","params":{"user":"0x…"},"includeInfo":true}`.

## Journal line in the chat

```text
[<UTC>] <PLAN-ID> step <n> <tool> <alias> → <ok|code> id=<…> txid=<…> D/W/C=<…>
```

## When to stop and ask

A required profile or tier is missing; the version is not `0.1.3` / `4.5.84`;
`configProblems` or `unresolvedIntents` is not empty; the account mode, available amount,
network flag, minimum, fee, chain, contract, fee asset or amount step is unknown; an amount is
not exactly representable; the "exchange + network" pair is not in the outbound withdraw
table; the recipient is Gate (manual only); the preview or form does not match the plan; the
plan has expired; there was no explicit `APPROVE`, `WITHDRAW` or `ADDRESS`; the address is not
on A's whitelist; a write's outcome is unknown or has no attributable ID; Hyperliquid turned
out to be a USDT source or recipient, or runs in unified mode.
