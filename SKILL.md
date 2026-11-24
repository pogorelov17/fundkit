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
on it. A new chat or host launch remembers nothing: it starts by reading this file again, and
only what the human pastes carries over.

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
4. **API withdrawals require a native confirmation form and a verified request.** The pair "exchange A + network" must appear in
   the [outbound withdraw table](references/exchanges.md#outbound-withdraw). Pass `network` at
   the top level and the memo only in `tag`. Put exactly what the table requires for that
   exchange into `params`: `fee` for OKX, `accountType` for Bybit, `uta` for Bitget, `{}` for
   the rest. Any other key (`chain`, `network`, `includeFee` and so on) goes to the exchange
   and overrides the request, and it is visible neither in the preview nor in the form. For
   example, `params.chain` on Bybit replaced BSC with ETH (verified). If the pair is not in the
   table, or the exchange is marked "manual only", the human withdraws in the exchange UI.
5. **Reconcile before considering another attempt.** On `UNKNOWN_OUTCOME`, a host timeout, a
   dropped connection, no response, or any error that is not on the
   [not-sent list](#26-responses-what-was-definitely-not-sent), retry nothing. For a potentially submitted operation, establish non-execution
   from a pre-dispatch response in 2.6 or an explicit operator finding from the exchange's
   records covering the snapshot through the present. An empty history, unchanged balance
   or empty `unresolvedIntents` cannot prove it. For a witnessed cancellation on a manual
   confirmation screen use the rule below. A new attempt needs fresh authorization; for
   a dispatched operation that failed, use the return-evidence rule in 2.7.
6. **Amounts are explicit.** Do not accept "all", "max" or "the rest" without a number. Every
   amount is a USDT number labeled with its meaning (debit, call argument or credit, see
   [2.3](#23-debit-withdraw-amount-and-credit)) and exactly representable in the currency,
   network and exchange steps (also 2.3). Never exceed `maxTransferValue` or the user's limit.
7. **Never guess the network, fee, minimum, contract or chain.** If a field did not come in a
   live response and the human did not read it in the exchange UI, it is "unknown", and a
   network with an unknown field does not qualify. Do not suggest small "test" transfers.
8. **Hyperliquid is watch-only** by public address. No transfers, withdrawals, orders or
   private keys (collateral there is USDC).
9. **Do not trust addresses from the chat.** The human copies the deposit address and memo
   from B's deposit page. On the **final confirmation screen** of whatever sends (OKX Wallet,
   the host form, or exchange A's withdrawal page in a manual send), the human checks the
   **full** address character by character, the network, and the exact memo (or that none is
   required) against B's deposit page, not against the chat. Any difference: do not confirm.
   The fix is a fresh copy from B's page, and a changed address or memo needs a new plan or
   sheet and new approvals. For an API withdrawal, the full address must already be on A's
   withdrawal whitelist. Immediately before a manual send, refresh B's deposit availability on
   the selected network, fee (asset and amount), and applicable minimum from its live data or
   deposit page. Recalculate net credit. If anything changed, cancel, replace the sheet, and
   get fresh approval; if a field is unavailable or the minimum is missed, hold the send.

### Manual confirmation

For both manual routes, give each final sheet a unique ID and a UTC expiry 15 minutes after
creation. A replacement gets a new ID. Show the sheet to the person controlling the sending
wallet or exchange account. Use the following sequence:

1. Leave the transaction unsigned and unsubmitted while checking the final screen against
   the current sheet and B's deposit page (rule 9). If a value changes or the sheet expires,
   cancel the screen. Prepare a replacement only after the destination and amounts qualify.
2. Once the checks pass, record `OPEN` with the exact sheet and its ID. The operator checks
   that the screen still matches and the UTC expiry has not arrived, then personally signs
   or submits that exact transaction. **That final action authorizes the manual send.**
   A sheet, chat message or past authorization alone does not authorize another submission.
3. If the operator instead deliberately cancels the still-unsigned, unsubmitted screen, they
   report the sheet ID, UTC time and that they personally observed cancellation before using
   any signing or submission control. Record this as `NOT SENT — canceled before submission`
   against that OPEN. If cancellation happens before OPEN, discard the unused sheet.
   If the operator pressed Sign or Submit, lost the screen, or cannot establish the ordering,
   keep OPEN and reconcile read-only. A missing hash or a later Cancel button proves nothing.

## Call syntax

`call_read_method` always has two required fields, `exchange` and `method`, even when
`account` is set. Without `exchange` the host returns `-32602 Required at exchange`. The
`exchange` value must match the account's exchange. Pass positional arguments in `args`, for
example `[code, since, limit]`, and use `null` for a skipped one.

```text
call_read_method {"exchange":"okx","account":"okx-main","method":"fetchDepositWithdrawFee","args":["USDT"],"includeInfo":true}
call_read_method {"exchange":"okx","account":"okx-main","method":"fetchBalance","params":{"type":"funding"},"includeInfo":true}
call_read_method {"exchange":"okx","account":"okx-main","method":"fetchWithdrawals","args":["USDT",null,20]}
call_read_method {"exchange":"okx","account":"okx-main","method":"fetchAccounts","includeInfo":true}
call_read_method {"exchange":"okx","account":"okx-main","method":"fetchTransfer","args":["<transId>","USDT"],"includeInfo":true}
call_implicit_get {"exchange":"kucoin","method":"publicGetCurrenciesCurrency","params":{"currency":"USDT"}}
call_implicit_get {"exchange":"gate","method":"publicWalletGetCurrencyChains","params":{"currency":"USDT"}}
```

With ccxt-mcp 0.1.3 and ccxt 4.5.85, `call_implicit_get` accepts only camelCase names
(snake_case returns `UNKNOWN_ENDPOINT`). Use it only for the
[network data sources](references/exchanges.md#network-data-sources). Schemas:
[`references/ccxt-mcp.md`](references/ccxt-mcp.md#tools).

## Step 0. Preflight (read-only)

Before preparing a plan or sheet in any fresh chat, including a manual wallet or exchange
UI send, ask the operator for the latest operation record for that source account or wallet
(see [journal line](#journal-line-in-the-chat)).
On first use, have them confirm there was no prior attempt. In either case, confirm that
no other send is outstanding and nobody else is acting on the route. If there is an
`OPEN` step, reconcile it first. Lost, stale or uncertain state means reads only. A carried record
serves as evidence for reconciliation. After recovery, any remaining action requires a fresh
plan or sheet and fresh authorization; a previous approval does not carry forward.

For each server involved:

1. Call `get_safety_status {}`. It must return `version: "0.1.3"` and `ccxtVersion: "4.5.84"`
   (that is how ccxt 4.5.85 reports itself). On any other version, **stop**: ccxt 4.5.87+ with
   ccxt-mcp 0.1.3 sends withdrawals without network, fee and memo (verified). `configProblems`
   must be empty; with `strictPermissions`, a config readable by other users (not
   `chmod 600`) shows `REFUSED` there. Note `elicitationSupported` and the `journal` path.
   **Crash hold.** Ask the operator whether a write hold is recorded for this `journal` path.
   If one is, or `unresolvedIntents` is not empty, a **terminal write hold** covers every
   profile that writes to that path (all profiles of that OS user, whatever alias an entry
   names). That means no writes on any of them, in this launch or any later one. Only reads
   and the operator's investigation in the exchanges' own records remain. Exchange history
   alone never clears the hold. Neither does the entry dropping off the list, because the
   server reads only the current and the previous month's file. Never delete, edit or move
   journal files, never point a profile at another journal, and never retry the intent.
   Report the path and the entries, and ask the operator to record the hold outside the
   chat. Resuming writes is outside this skill.
2. Call `list_accounts {}`: check the alias, `exchange`, `environment`, `funds`, `dryRun`,
   `confirm` (not `never`) and `maxTransferValue`. Aliases must be unique across all servers.
3. **One server per keyed exchange.** ccxt-mcp fills every account of an exchange from the
   same `<EXCHANGE>_*` variables, so in a scheme A launch two connected servers for one
   exchange (say `okx-main` and `okx-sub`) sign with the **same** key under different aliases
   (verified offline). Ask the operator which scheme this launch uses. In scheme A, if more
   than one connected server or alias has the keyed exchange, stop until the operator leaves
   exactly one registration enabled
   ([one registration](references/security.md#one-registration-per-keyed-exchange)).
4. **Account identity.** An alias is a label and does not prove which exchange account the
   key belongs to. Before the first write in a launch, read an account identifier and have
   the human compare it with the exchange UI. On OKX, `fetchAccounts` with `includeInfo`
   ([call syntax](#call-syntax)) returns `id` (the UID), raw `label` (the API key name) and
   `perm`. If you know no such read for the exchange, say that only the operator's
   registration check stands behind the alias.
5. Tell the user which profiles are read-only, which have `funds: "live"` and with what cap,
   and whether the native form is available. Only the operator can enable a missing tier, in
   the config; it cannot be done from the conversation.

If no `ccxt-mcp` tools are available, say so, explain what the operator needs to set up
([`references/security.md`](references/security.md)), and stop before any live data or plan
numbers. You may still explain the flow in general terms.

## Scenario 1. OKX Wallet → exchange (manual send)

Start with the operation-record check in Step 0 for the sending wallet. Only the human
sends from OKX Wallet, using the checked sheet.

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
   the amounts below clear the minimum. Reject bridged variants and other contracts.
4. **Amounts.** Keep these apart:
   - `S`: the USDT amount the human enters in the wallet;
   - the wallet's network fee on its confirmation screen: record the exact quoted amount,
     its asset, and whether it
     is added on top of `S` or taken out of it. Gas in the chain's native coin (TRX, BNB,
     ETH, TON) is not USDT: it never enters the USDT math, but the wallet must hold enough of
     that coin. A USDT fee taken out of `S` lowers the on-chain amount. If the screen does
     not establish the amount, asset and fee treatment, hold the send. For variable gas,
     record the exact enforceable maximum in the native asset and label it as a cap;
     an estimate alone cannot bind the operator's maximum debit;
   - `N`: the on-chain USDT amount (`S`, or `S` minus a USDT fee taken out of it);
   - `d`: the exchange's deposit fee, and `C = N − d`: the expected credit.

   Exchanges rarely say whether the deposit minimum applies to `N` or to `C`. Unless the
   exchange states it, require `C` ≥ minimum (that covers both). Example: `S = 150`, gas in
   TRX, `d = 1`, minimum 150: `C = 149` fails; `S = 151` gives `C = 150` and passes. Show the
   human a draft send sheet with the source wallet, destination account, network and contract,
   `S`, network fee <amount or cap, asset, treatment>, `N`, `d`, expected `C`, and the minimum and its basis. Include
   the sources and UTC time of the route checks. After step 5, fill in the full recipient
   and exact memo and issue `SEND SHEET <ID>, created <UTC>, expires <UTC + 15 min>`.
5. By default the human copies the address **themselves** in the exchange app (Deposit →
   USDT → network). Call `get_deposit_address` only if the human asked for it separately, the
   profile has `funds`, and you showed a mini-plan `PLAN <PLAN-ID>` with the exact JSON of
   that call and an expiry, and the human replied `ADDRESS <PLAN-ID>`. Warn that the first
   call may create a new address and that `dryRun` does not stop this tool.
6. Follow [manual confirmation](#manual-confirmation). Refresh B's conditions, compare the
   wallet's send amount and quoted fee (or maximum), including its asset, with this sheet.
   A change from 1 TRX to 10 TRX requires a new sheet even if the USDT credit stays the same.
   Verify the full address, network and exact memo before recording OPEN. Only the operator can sign the checked transaction.
7. After sending, ask for the full transaction hash from the wallet and credit the deposit by
   the [deposit rule](#27-reconciliation): the credited amount must equal the expected `C`. A
   deposit that is still confirming is polled read-only (2.7). If the funds must reach a
   trading wallet, run Scenario 3.

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
   source). Without that, hold the route. The human also notes from that page, or from B's
   deposit settings, which B wallet deposits land in.
2. Enable flags, minimums, contract, memo and precision appear only in `info` (or in the
   `call_implicit_get` response), with different field names per exchange. Read any missing field from the relevant exchange UI. If it remains
   unknown, the network does not qualify. Infer nothing from the network name.
3. For **every route**, verify that A allows withdrawal and B allows deposit on the same
   [reference chain and USDT contract](#chains). Record each venue's network ID or UI label,
   the source and UTC time of each check, and all applicable minima and maxima. Compare
   EVM contract addresses by their full 20-byte value, regardless of letter case. Use the deposit or withdrawal page
   for missing API fields. Check the full recipient and memo per rule 9.
   - **API withdrawal:** require a native form, API withdrawals enabled on A, and an
     [outbound table](references/exchanges.md#outbound-withdraw) entry whose wire value
     matches A's live network ID. Gate inbound and BingX outbound use the manual path.
   - **Manual withdrawal:** qualify the network using the UI labels, chain, contract,
     availability and the UI amount step. Confirm exact amounts from A's preview in
     [2.9](#29-manual-withdrawal-in-exchange-as-ui). The API table and ccxt serialization
     checks apply only to API calls.
4. Matching names (`BEP20` and `BSC`) prove nothing. The same contract address can exist on
   several EVM chains, so chain **and** contract decide together.
5. Network cost is A's withdrawal fee plus B's deposit fee plus internal transfers. Pick the
   cheapest; on a tie, the faster one.

#### Chains

Only these chains and contracts. A chain qualifies only if **both** sides (the wallet or A,
and B) support USDT on that exact chain at exactly that contract. The reference contracts
matched across Gate, KuCoin and Bitget.

| ccxt code | Chain | USDT reference contract |
|---|---|---|
| `TRC20` | Tron mainnet | `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` |
| `BEP20` | BNB Smart Chain, EVM chainId 56 only (not opBNB, not BNB Beacon Chain) | `0x55d398326f99059fF775485246999027B3197955`, the only allowed BSC token (BscScan: Binance-Peg BSC-USD, listed by exchanges as USDT BEP20/BSC); no other USDT-named BSC contract |
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
at least B's deposit minimum (that holds whichever amount B applies the minimum to). The plan
states `C` as bounds; any transfer on B is planned later from the actual credit
([2.8](#28-settlement-on-b)).

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
Route: <A-alias> (<mode>) → <B exchange> (B's mode, wallets and caps are read in B's session), USDT
Chain: <Tron mainnet | BNB Smart Chain 56 | Ethereum 1 | TON mainnet>, contract <…> (A: <source, UTC>, B: <source, UTC>)
Network: A network=<ccxt code> → outbound <field>=<value> = id in A's response <…>; B network id <…> (<source>)
Candidates: <network / A withdraw / B deposit / fee / min / field source>
Available on A: <field>=<value>, reserve <R>, transferable <T>
Amounts: D=<…>, W=<…>, C=<…> (fee model: <on top | deducted | unconfirmed>); f=<…> <asset>, d=<…> <asset>
Amount steps: currency <…>, network <…>, exchange <…> (<source>); W and transfer amounts are multiples of all, ≤ 15 significant digits, ≥ 0.000001
B deposit: address <full address>, memo <none | exact memo>, copied by the human from B's UI, on A's whitelist (full match): yes
Expected on B: C=<C_min>…<C_max> USDT, lands in <B wallet> (source: <B UI | typical, unverified>)
Calls on A (exactly these arguments):
  1. transfer {"account":"<A>","code":"USDT","amount":<…>,"fromAccount":"<…>","toAccount":"<…>","params":<{} | per transfer proof table>}
     proof: <API: <read from the transfer proof table> | operator: <A> UI transfer history, access and quiet window confirmed <UTC> | manual: the human transfers in A's UI>
  2. withdraw {"account":"<A>","code":"USDT","amount":<W>,"address":"<full address>","tag":"<memo as a string, only if required>","network":"<code>","params":<per table>}   ← separate WITHDRAW <PLAN-ID>
     proof: fetchWithdrawals record with the call's id, status ok, with a hash
Then: on final source success, hand off the verified route, source proof and hash (2.8); B matches the deposit (2.7) before planning an internal transfer.
Before each write: expiry and that step's checks (2.5). Both networks are checked before the withdrawal.
Caps: maxTransferValue A=<…>; user limit <…> | target credit <…>
To approve: APPROVE <PLAN-ID>
```

### 2.5 Executing each write

1. **Expiry.** Before **every** dispatch, including redeeming a token, check that the current
   UTC time is strictly before `expires`. If `now ≥ expires`, the plan has expired, and the
   remaining steps go into a new plan with a new approval (and a new `WITHDRAW` for a
   withdrawal).
2. **Recheck before the call.** For every step, compare the exact arguments with the approved
   plan and check the account mode, available amount, reserve and caps on the debited
   exchange. What else to check depends on the step:
   - **Internal transfer** (on A, or on B per 2.8): both wallets, the exact amount and the
     step's **proof route**, fixed before approval. Use the API route only if the
     [transfer proof table](references/exchanges.md#transfer-proof) has a read for this
     exchange and mode. Otherwise use the operator route only if the operator has already
     confirmed access to the exchange's transfer history and the quiet window (2.7). If
     neither holds, the step is manual: the human does it in the exchange UI, and the agent
     does not call `transfer`.
   - **Withdrawal from A** (initial data checks): both networks per 2.2, the full address and
     memo, fees, minimums and amounts per 2.3. If B's data is only available in B's app, the
     operator checks it there before the withdrawal.

   If any condition of the step is unknown, stop. If the conditions of the approved plan have
   changed, recompute the remaining steps and get a new approval.
3. **Snapshot.** Save the UTC time and `since` (that time in ms minus 60 000) for the proof
   read. Before a withdrawal, also save the latest IDs from `fetchWithdrawals` on A and the
   balance of the debited wallet. Before a transfer, also save both wallets' balances (they
   only locate funds; they prove nothing). After the withdrawal, find its record by ID and
   write the hash into the chat. Before dispatch, publish the [OPEN record](#journal-line-in-the-chat).
4. **Call with exactly the plan's arguments.**
   - `elicitationSupported: true`: the call opens the host's form. The form shows only a
     preview (amount, wallets or address and network, memo, environment) and one `confirm`
     field (yes/no); it has no PLAN-ID, no expiry and no `params`. So **before** the call,
     tell the human: `<PLAN-ID> step <n>: the form opens now, plan expires <UTC>`. The human
     accepts the form only if, at the moment of accepting, they have checked the clock
     themselves, it is strictly before that expiry, and every form field matches the plan. If
     `now ≥ expires` or a field cannot be checked, they decline. Accepting sends the write
     immediately. The server waits up to 300 s for an answer, then returns
     `CONFIRM_UNAVAILABLE` (nothing sent). The host's tool timeout must be longer than that
     ([host registration](references/security.md#host-registration)).
   - Confirmed decline (`CONFIRM_DECLINED`, `CONFIRM_CANCELED`): nothing was sent. Remaining
     steps only via a new plan with fresh data and new `APPROVE` (and `WITHDRAW`).
   - Form response lost or unknown (host timeout, dropped connection, no response): the write
     may have gone out. Reconcile per 2.7 only; do not repeat the call.
   - `elicitationSupported: false`: use only the exchange UI (2.9) for withdrawals. Never call
     `withdraw` in token mode. For an approved internal `transfer`, compare the returned preview
     with the plan and redeem its 60-second token with the identical arguments. Keep the
     token out of the chat record.
5. Only for an internal transfer: a confirmed pre-dispatch token rejection permits a new
   preview under the same still-valid plan after rechecking steps 1–2. Keep the operation
   record current before redemption. An unknown response always goes to reconciliation.
6. After each step, reconcile against history (2.7) and write a journal line.

### 2.6 Responses: what was definitely not sent

| Response | Meaning | Action |
|---|---|---|
| `CONFIRM_INVALID`, `CONFIRM_EXPIRED`, `CONFIRM_MISMATCH` | token rejected before dispatch | new preview per 2.5, item 5 |
| `CONFIRM_DECLINED`, `CONFIRM_CANCELED` | the human declined or closed the form; nothing sent | stop; remaining steps need a new plan and new approvals |
| `CONFIRM_UNAVAILABLE` | the form did not open or got no answer within 300 s; nothing sent | stop; for a withdrawal use a fresh manual sheet after confirming non-execution |
| `TIER_DISABLED`, `TRANSFER_VALUE_CAP`, `DAILY_VALUE_CAP`, `UNVALUABLE_TRANSFER`, `UNKNOWN_ACCOUNT`, `-32602` | gate or schema rejection before dispatch | stop and report |
| **everything else**: `UNKNOWN_OUTCOME`, `EXCHANGE_ERROR`, `INSUFFICIENT_FUNDS`, `AUTH_FAILED`, `BAD_REQUEST`, `INTERNAL_ERROR`, host timeout, dropped connection, no response | the write may have gone out | reconcile per 2.7, no retries |

Inside `withdraw` and `transfer`, ccxt makes preliminary reads: account mode on Bybit,
currencies on OKX without `fee`, a UTA probe on Bitget and KuCoin. Their failure also comes
back as `UNKNOWN_OUTCOME` and cannot be told apart from a failure of the write itself.

### 2.7 Reconciliation

- **A step is done only with an attributable unique ID and a success status for that ID.**
  The ID is the `id` in the call's own response. It says which record is this step's, not
  that the step succeeded. Compare IDs only within the namespace the
  [transfer proof table](references/exchanges.md#transfer-proof) names. OKX `transId` is not
  a `billId`, KuCoin `orderId` is not a ledger `id`, BingX `transferId` is not `tranId`, and
  a withdrawal ID on A is not a deposit ID on B.
  - **Withdrawal:** the record with that `id` in `fetchWithdrawals` (WhiteBIT: the
    `uniqueId` that ccxt generates and returns as `id`), status `ok`, with a hash.
  - **Transfer, API route:** the table's read for that exchange, with `since` from the
    snapshot (2.5) and `includeInfo: true`. It must return exactly one record with that ID,
    the exchange's success value, and the planned amount and wallets.
  - **Transfer, operator route** (the table has no API proof for this exchange and mode).
    Before approval, the operator confirms two things. First, they can open this account's
    transfer history in the exchange UI, showing time, amount, from and to wallets, and
    status. Second, nobody else (other sessions, the UI, other people, automatic transfers)
    will move USDT between those wallets until reconciliation is done. After the call, the
    operator reports exactly one record in the window from the snapshot to now, with the
    planned amount and wallets and a final success status, plus the record ID if the UI
    shows one. The journal line names the source: `operator, <exchange> UI, <UTC>`.
- **Status handling** (transfers, withdrawals, deposits; values in any letter case). Nothing
  is ever re-issued:
  - success (`ok` or the table's success value): done; write the journal line.
  - **pending** (`pending`, `processing`, `WAIT`, or a deposit or withdrawal still
    confirming): poll read-only, at most once a minute. Re-read the same record by the same
    ID or hash. Do no write and take no next step. If it is still pending after the time the
    exchange states, the operator checks the UI, and polling continues.
  - **failed** (`failed`, `fail`, `canceled`, `rejected`): keep OPEN until the operator
    identifies the terminal failure and shows from attributable exchange or chain records
    that no debit was taken or how the debit was reversed or released. Record the returned amount and any retained fee.
    Close as FAILED-RECONCILED with the operation ID/hash, proof references and UTC time.
    An unexplained shortfall, pending refund or balance change alone keeps the step OPEN.
    Any further attempt needs a new plan or sheet and fresh authorization.
  - **missing** (the ID is not in the read, OKX returns all fields `null`, or the list is
    empty): this proves neither success nor non-execution. Poll read-only for a few minutes,
    then hold and ask the operator.
  - **ambiguous** (any other value or `null`, several candidates, a record that changed after
    reconciliation, or no ID because the outcome is unknown): hold. Only reads and operator
    investigation are allowed. If the operator attributes exactly one record to this step
    from the exchange's own records, its ID then goes through the same status handling.
- Matching amount, address, network or wallets, and balance shifts, are **not** proof, even
  when the timing matches: a parallel operation (another session, the UI, another person)
  looks the same. Report such records as "candidate" and go no further.
- An empty `get_safety_status.unresolvedIntents` **does not prove** nothing went out. On
  `UNKNOWN_OUTCOME` the journal closes the intent with an `error` entry, and the intent
  leaves the list. The server never sees a host timeout. The list shows only intents cut off
  by a process crash, and those trigger the crash hold (Step 0).
- **Deposit credit** (Scenarios 1 and 2). Read history with `includeInfo: true`:
  `call_read_method {"exchange":"<B>","account":"<B-alias>","method":"fetchDeposits","args":["USDT",null,20],"includeInfo":true}`.
  In the A session, read `fetchWithdrawals` with `includeInfo: true` and write the full hash
  into the chat.
  - `id` is an operation number inside one exchange. It links a call to a record on that
    same exchange. The only link across exchanges, or to the wallet, is the full on-chain
    transaction hash. Usually that is `txid`, but WhiteBIT puts the hash in raw
    `info.transactionHash`, while its unified `txid` is an internal WhiteBIT id (verified
    offline).
  - Compare networks within one namespace: raw with raw, unified with unified. KuCoin raw
    `info.chain: "bsc"` is the `chainId` from the network source, while unified
    `network: "BEP20"` is the ccxt code (verified offline). Do not compare `bsc` with
    `BEP20`.
  - Compare the full hash. For hex hashes, letter case and a leading `0x` do not matter.
    Any other difference (a suffix, a truncated value) is not a match; treat it as ambiguous
    and have the operator check.
  - A deposit counts only if there is **exactly one** record with that hash. The hash must
    equal A's withdrawal hash (or the hash from the wallet), the asset must be USDT, the chain
    the plan's, and the status complete (`ok`). The credited amount must be unambiguous and
    match the expectation: within the `C` bounds of the plan, handoff or sheet (Scenario 2)
    or equal to the send sheet's `C` (Scenario 1). Network gas is never part of it.
  - A record with the right hash that is still confirming is pending (poll as above). No
    hash, several candidates, no visible credited amount, a credit outside the expectation,
    or a record that changed after reconciliation is ambiguous: hold, report, and take no
    next step.
- Call only history methods the exchange has. Report any discrepancy over 0.01 USDT.

### 2.8 Settlement on B

B's mode, wallets, available amounts, steps and caps are read only in a session that has B's
key. In scheme A that is a new launch and a new chat
([scheme A](references/security.md#scheme-a-one-keyed-account-per-launch)). That chat starts
by reading this file, and the human pastes the HANDOFF block plus the latest operation record for any previously used account. In scheme B it can be the same chat. For both API and manual withdrawals, issue the block only when the same
attributable source withdrawal record shows its ID, a final successful status and the full
on-chain hash (2.7). A hash can appear while the withdrawal is pending: keep OPEN and poll
read-only. Missing or uncertain status holds the route even if B already displays a deposit.

```text
HANDOFF <PLAN-ID> A→B, written <UTC>
B: exchange <ccxt id>, account <B alias>, identity <nonsecret UID or account label shown in B's UI>
Lands in: <B wallet> (source: <B UI | typical, unverified>); then: <nothing | transfer to <B wallet>>
User: limit <USDT> | target credit <USDT>
Chain: <name>, EVM chainId <56 | 1 | none>, contract <…>, ccxt code <…>, B network id <…>
Pre-send verification: A <source, observed chain and contract, UTC>; B <source, observed chain and contract, UTC>
Deposit: address <full address>, memo <none | exact memo>
A: <exchange> <alias>, withdrawal id <…> (A's namespace), W=<…>, D=<…>, sent <UTC>
Source proof: <fetchWithdrawals or A withdrawal-history UI>, status <final success value>, checked <UTC>
Hash: <full on-chain hash from that source record>
Expected credit: C=<C_min>…<C_max> USDT, B deposit minimum <…> (<stated | assumed>)
```

1. Run Step 0 on B's server. Require the source proof above before advancing; an incomplete
   handoff is for read-only reconciliation. The alias must match the block's `B:` line. Where Step 0 reads
   an account identifier, it must match the block's identity. Where it cannot, the operator
   confirms that this alias's key belongs to that account. Otherwise stop.
2. A missing or unreadable field is re-established by a read (B's deposit history, or A's
   `fetchWithdrawals` in an A session), or by the operator reading it in the exchange UI.
   Never infer a missing value. Keep the pre-send A/B chain and token verification with
   its sources and times, which must precede the send. Recover lost evidence from the original chat or transaction-specific
   exchange or on-chain evidence. Today's coin listing alone cannot identify a past transfer.
3. Match one completed B deposit per 2.7: full hash, USDT, chain, receiving address, memo
   (when required), and unambiguous credit within the expected bounds. On Bybit the address
   may be in `addressTo` or `info.toAddress`. For omitted receipt fields use evidence tied
   to this transaction (B's deposit details or its on-chain receipt on the verified chain).
   Bybit's deposit record omits the token contract: use the documented pre-send verification
   above. If the record supplies a contract it must agree. Missing evidence, conflicting
   values or multiple matching deposits hold the route.
4. Find where the credit sits. Start from the block's `Lands in` wallet, then the deposit
   wallet in the [account mode table](references/exchanges.md#account-mode-and-available-amount)
   (typical only: account settings can change it). Read that wallet's available field per
   2.1. A balance change only locates funds; the hash attributes them. If it is not clear
   which wallet holds the credit, the human checks B's UI.
5. If the block's `then` asks for a transfer, make a **new plan** with one `transfer`, its
   own PLAN-ID (`<PLAN-ID>-B`), expiry and proof route (2.5). Its amount is at most the
   attributed credit, the holding wallet's available field and the user's limit, and no more
   than the target needs. It must be a multiple of B's steps (2.3) and within B's
   `maxTransferValue`. Then `APPROVE <PLAN-ID>-B` → 2.5 → 2.7.

### 2.9 Manual withdrawal in exchange A's UI

Apply Step 0 to the source account before preparing a sheet. Use this path for BingX
outbound, Gate inbound, a network outside the outbound API table, a host without a native
confirmation form, or a user-requested manual send. The human
selects the verified chain in A's UI. Keep the sheet in draft until A's preview gives the
exact debit, fee and amount sent to B; calculate the exact net credit after B's fee.
Check the UI step, limits, reserve, budget or target, and B's deposit minimum before sending.
For example, with 99 USDT entered, a 1 USDT fee on top and no deposit fee, the preview
must show debit 100 and receive 99. An unknown fee treatment or receive amount holds the sheet.

```text
WITHDRAWAL SHEET <PLAN-ID>, created <UTC>, expires <UTC + 15 min>
From: <A exchange> <wallet>; A's UI label <…> = chain <…>, contract <…>
Route evidence: A <source, observed chain/contract, UTC>; B <source, observed chain/contract, UTC>
To: <B exchange>, address <full address>, memo <none | exact memo> (from B's deposit page)
Enter: W=<…> (multiple of A's UI step, ≥ A's withdrawal minimum <…>)
Fee: f=<…> <asset>, model <on top | deducted>; exact debit D=<…>; exact receive amount on A's preview <…>
Expected on B: exact C=<…> USDT after deposit fee d=<…> <asset>, B deposit minimum <…> (<stated | assumed>)
User: limit <USDT> | target credit <USDT>
```

1. Follow [manual confirmation](#manual-confirmation) on A's withdrawal screen. Refresh B's
   deposit conditions and compare the full address, network and memo with B's page. Verify
   the exact debit, fee and receive amount before OPEN and before any submitting 2FA action.
2. Open the attributable withdrawal record in A's history (UI or `fetchWithdrawals`). Read
   its ID, displayed final status and full hash from that record. While pending, poll read-only.
3. Only on verified final success, copy the source proof and exact sheet into the HANDOFF (2.8). B's session
   counts the deposit only by hash and the sheet's exact credit (set both bounds to `C`, 2.7).

## Scenario 3. funding ↔ trading/margin on one exchange

Same cycle: account mode → available amount and reserve → a plan with one `transfer`, an
expiry and a proof route (2.5) → `APPROVE <PLAN-ID>` → expiry check and recheck → call → ID
and success status (2.7). With no API or operator proof route, the transfer is manual in the
exchange UI. Take wallet names only from the [wallet table](references/exchanges.md#wallets-for-transfer).
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

Before any potentially dispatching call or manual confirmation, put this record in the chat.
Use the approved arguments or the exact send sheet; omit secrets and confirmation tokens.

```text
OPEN <plan/step> | <journal path or manual wallet, exchange/account identity> | snapshot <UTC> | <exact arguments/sheet> | id/hash <known values or pending>
```

Keep it current on every response. Pending, missing, lost or ambiguous results keep the step
OPEN across chats, including when the server records an error and lists no unresolved intent.
Only reconcile read-only until the operator can establish the outcome under 2.7. Close the
record as DONE with attributable proof of completion, NOT SENT with proof of non-execution
under rule 5 (including a witnessed manual cancellation), or FAILED-RECONCILED with the failure and return evidence specified in 2.7.
For a deposit-address request use the verified address response. For `transfer` and
`withdraw`, an explicit `dryRun: true` result closes the step as NOT SENT. A completed step must never be sent again. Retain the latest record for Step 0; a crash
hold on the server journal still applies even after the exchange outcome is known.

Chat records depend on the operator carrying the latest state. They cannot lock parallel
chats or guarantee exactly-once execution if a record is lost or stale and the operator
mistakenly confirms there was no prior attempt. Example of a reconciliation entry:

```text
[<UTC>] <PLAN-ID> step <n> <tool|manual> <alias> → <ok|code> id=<…> status=<…> proof=<read | operator, <exchange> UI, <UTC>> txid=<…> D/W/C=<…>
```

## When to stop and ask

A required profile or tier is missing; the version is not `0.1.3` / `4.5.84`;
`configProblems` is not empty; a crash hold applies (`unresolvedIntents` not empty, or a hold
recorded for the journal path: reads only, permanently); more than one connected server or
alias has the keyed exchange in a scheme A launch; the human could not match the account
identifier; the account mode, available amount, network flag, minimum, fee, chain, contract,
fee asset or amount step is unknown; an amount is not exactly representable; a transfer has
no proof route and is not done manually; the "exchange + network" pair is not in the outbound
withdraw table, or the recipient is Gate (both manual, 2.9); the full address, network or
memo differs anywhere; the preview, form or exchange confirmation screen does not match the
plan or sheet; the plan has expired; there was no explicit `APPROVE`, `WITHDRAW` or
`ADDRESS`; the address is not on A's whitelist; a write's outcome is unknown, has no
attributable ID, or its status is failed, missing or ambiguous (pending is only polled); a
deposit's credit does not match the expected `C`; a HANDOFF field is missing and cannot be
re-established; Hyperliquid turned out to be a USDT source or recipient, or runs in unified
mode.
