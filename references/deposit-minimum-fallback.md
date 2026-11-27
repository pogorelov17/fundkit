# Destination deposit minimum: operator fallback (USDT)

The owner's rule: the fallback applies to USDT deposits into all nine supported exchanges. That
covers wallet top-ups and exchange-to-exchange transfers, at every planning entry point (the
native `fundkit_transfer_prepare` tool, and the documented flows in [SKILL.md](../SKILL.md):
Scenario 1, Scenario 2 API withdrawals and the 2.9 manual send).

fundkit supports **USDT only**. A request for any other coin, USDC included, is refused before
any session, read or write (`UNSUPPORTED_COIN`), and is never read, planned or sent as USDT.
The owner withdrew the earlier USDC extension ("only USDT"), so this rule has no USDC part.

Applying the rule (the minimum *policy*) is separate from *support*, meaning which venue and chain
a fundkit adapter can actually read and send. Both are in [Scope](#scope-policy-versus-support).

## Why

A real T3 thread (Bybit → Binance, BSC) ran as follows:

| Request | Result | Correct? |
| --- | --- | --- |
| address only | verified address and QR | yes |
| 2 USDT | `BELOW_WITHDRAW_MIN` (Bybit `withdrawMin` 10) | yes, kept |
| 10 USDT, 10.14 available | `INSUFFICIENT_BALANCE` (0.15 fee on top, 10.15 needed) | yes, kept |
| 10 USDT, enough available | `DESTINATION_MINIMUM_UNDOCUMENTED` | the case fixed here |

Binance's API reference (`GET /sapi/v1/capital/config/getall`, 28 `networkList` fields, read
2026-11-26) names no deposit minimum, and `depositDust` has only an example value. That route
could therefore never reach a confirmation. MEXC (no field) and Gate (only a currency-level value)
held the same way in the documented flows. The owner first set an operator fallback for Binance
USDT BSC only. They then revised it to **1 USDT, on every exchange**.

## Rule

`C_min` is the conservative expected credit on the destination: the amount minus every fee that
may be taken before the credit (A's withdrawal fee unless it is shown to be on top, and B's
deposit fee).

1. **Venue minimum first.** If B's healthy USDT lookup for that chain publishes a minimum, and it
   is an exact non-negative decimal, that value is the minimum, whatever it is: 0, lower than 1
   or higher. It is the venue's own figure and is recorded with its field name.
2. **Operator fallback otherwise.** If that lookup publishes no applicable minimum (the field is
   absent, or the venue's only value does not apply to that chain), the minimum is **1 USDT**.
   The check is inclusive: `C_min >= 1` passes, and anything lower holds with
   `BELOW_DEPOSIT_MIN`. Examples: 0.9999 holds and 1 passes when the fee is on top. With a 0.15
   fee that may be taken from the amount, 1.15 passes and 1.1499 holds. At the finest exact
   unit, 0.999999999999 holds.
3. **Never a venue fact.** A fallback minimum is recorded as `basis: fundkit-operator-fallback`,
   `venueMinimum: unknown`, with a statement that it is Fundkit's operator assumption, not the
   venue's figure, and that it does not guarantee the credit. The plan, the chat summary
   (`destinationMinimumBasis`), the confirmation card and the manual send sheet show this source.
   There is no extra question or step.
4. **These still hold, whatever the fallback says:**
   - the minimum field is present but malformed (`null`, empty, text, negative):
     `DESTINATION_MINIMUM_UNREADABLE`;
   - contrary evidence (Binance `depositDust` that is unreadable or above the fallback; Gate's
     currency-level `min_deposit_amount` above it on a multi-chain response):
     `DESTINATION_MINIMUM_CONTRARY`;
   - a failed read, an API or auth error, or a response for another coin or chain;
   - deposits disabled or suspended, or Binance `busy`;
   - an unsupported chain, or a contract that is not the USDT reference contract;
   - any recipient problem (address, memo, disagreeing reads), an inbound cap, and a credit that is
     not positive.
   The fallback never gets a route past any of them.
5. **Unchanged:** every source gate (withdrawal minimum, maximum, step, fee, available balance in
   one wallet, key rights), session caps, the single human approval, idempotency, the address-only
   QR (independent of any amount), and reconciliation against the expected `C`.

Per venue, "publishes no applicable minimum" means:

| Destination | Venue minimum (applied when present and exact) | Fallback applies when |
| --- | --- | --- |
| Binance | a `depositMin` on the `networkList` row (not returned today) | always today; `depositDust` is only contrary evidence, never the minimum |
| Bybit | `chains[].depositMin` | the field is absent from the chain row |
| OKX | `minDep` on the raw currency row | the field is absent |
| Bitget | `minDepositAmount` | the field is absent |
| BingX | the chosen chain's `depositMin` | the field is absent from that row |
| WhiteBIT | `required.minAmount` on the address object | the field is absent |
| KuCoin | `depositMinSize` | the field is `null` or absent (KuCoin's schema uses `null` for unset) |
| MEXC | none in the API (`depositTips` is free text) | always |
| Gate | top-level `min_deposit_amount`, only on a single-chain response for the chosen chain | multi-chain or other-chain response; a currency-level value above the fallback is contrary |

## Scope: policy versus support

| | USDT |
| --- | --- |
| Policy (this rule) | all nine destinations |
| Chains | TRC20, BEP20, ERC20, TON, at the reference contracts in [SKILL.md, Chains](../SKILL.md#chains) |
| Native tools (address, transfer) | Binance, Bybit; the other seven return `VENUE_NOT_NATIVE`, as before |
| Documented nine-venue flows | the agent applies this rule ([SKILL.md](../SKILL.md#destination-deposit-minimum)) |
| Any other coin (USDC, DAI, …) | refused with `UNSUPPORTED_COIN` before any session or read, at every entry point |

## Native tools: binding and recheck

The plan records `destination.minimum` = `{value, coin: "USDT", basis, venueMinimum, field |
statement}` inside the hashed body.

For any fallback plan (any venue or chain), `fundkit_transfer_confirm` reads the destination
again on its deposit-only profile. It does this twice: before the card opens, and after the human
approves, right before the approval is passed to ccxt-mcp. Any change gives `not-sent` with
`DESTINATION_RECHECK_FAILED` and zero withdrawals:

- a different address or memo;
- deposits off, or contrary evidence;
- any read error;
- a venue minimum that has become known, even one the amount would clear, because the approved
  card no longer describes the plan.

The card wait is shortened, so card plus recheck stay inside ccxt-mcp's form wait. A plan on a
venue minimum is not rechecked, as before.

## Acceptance

What was run, and on what. Offline only: synthetic keys and responses, no real account, no
network. `tests/test_native.py` uses the fake ccxt-mcp and a T3-shaped host.
`tests/test_real_ccxt_mcp.py` uses the pinned ccxt-mcp 0.1.3 with ccxt 4.5.85, its transport
replaced by a recorder, inside `unshare -rn`.

1. **Policy matrix.** The policy gives 1 USDT for each of the 9 venues, and none for USDC, DAI,
   lowercase `usdt` or a venue outside the nine. For each venue: an absent field gives the
   fallback with `unknown` and the statement; 0, 0.5, 25 and 2 are applied as the venue's own
   figure; `null`, empty, text and negative hold. A USDC minimum is never assumed
   (`DESTINATION_MINIMUM_UNDOCUMENTED`). This is a function-level check: of the nine, only the
   Binance and Bybit adapters run end to end (items 2 to 7).
2. **Reproducer.** Bybit → Binance BSC, 10 + 0.15 on top, 812.44 available: `ready`, debit 10.15,
   credit 10, minimum 1 USDT with basis `fundkit-operator-fallback` in the plan and on the card.
   Cancel on the card gives zero withdrawal writes (fake: no dispatch; real server: no POST).
3. **Approve once:** exactly one dispatch; a second confirm sends nothing.
4. **Boundaries:** 0.9999 holds and 1 passes end to end. The shared check: 1.15 and 1.1499 with
   the fee subtracted, and one exact unit below 1. A credit that is not positive holds, even with
   a venue minimum of 0.
5. **Venue minimum:** Binance 20 holds 10; Binance 0.5 lets 0.5001 through with no recheck; Bybit
   1 and 0 are applied, 350 holds; Bybit with no field gives the fallback, which is rechecked, and
   a minimum that appears before the card stops it. Bybit `""` and Binance `n/a`, `null` and `-1`
   hold.
6. **Contrary, unhealthy, wrong coin or chain:** `depositDust` 1.01 or 1.5; `busy`; deposits
   disabled; a network list answered for another coin; a gated read for another coin or chain; two
   default addresses; a missing memo field; an auth error. Each holds, with no plan and no card.
7. **Recheck:** before the card (a venue minimum appears, the address changes, deposits close,
   `depositDust` turns unreadable, the key check fails) and while the card is open (a minimum
   appears, the address changes, a read fails). Each gives `not-sent`,
   `DESTINATION_RECHECK_FAILED` and zero dispatch (real server: zero POST).
8. **USDT only:** `USDC`, `usdc`, ` USDC `, `DAI`, an empty string, `USDT-BSC` and a number are
   refused with `UNSUPPORTED_COIN` by `fundkit_deposit_address` and `fundkit_transfer_prepare`,
   with and without a session: zero Doppler secret requests, no profile started, zero ccxt-mcp
   calls, no card and no write (fake). On the real server, USDC gives zero wire requests, and the
   same session's USDT request asks the venues for USDT only. `USDT`, `usdt` and an omitted coin
   are the same request. Both tool schemas offer `coin: ["USDT"]` only.
9. **Address-only QR**, unchanged and independent of any amount.
10. **Other routes:** Binance TRC20 uses the fallback like BSC; Binance → Bybit keeps Bybit's
    `depositMin` with no recheck.

The documented nine-venue flows are agent procedures, not code. They were **not** re-run for this
rule, so no route count after the fallback is claimed: [recipients.md](recipients.md#prerequisites-by-route)
reports only the counts that were measured before it.
