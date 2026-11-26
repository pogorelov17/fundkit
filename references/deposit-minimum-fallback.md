# Destination deposit minimum: operator fallback

The owner's rule: the fallback applies to deposits into all nine supported exchanges, in USDT and
USDC. That covers wallet top-ups and exchange-to-exchange transfers, at every planning entry
point (the native `fundkit_transfer_prepare` tools, and the documented flows in
[SKILL.md](../SKILL.md): Scenario 1, Scenario 2 API withdrawals and the 2.9 manual send).

Applying the rule (the minimum *policy*) is separate from *support*, meaning which coin, chain and
venue a fundkit adapter can actually read and send. Both are in [Scope](#scope-policy-versus-support).

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
USDT BSC only. They then revised it to **one unit, on every exchange, for USDT and USDC**.

## Rule

`C_min` is the conservative expected credit on the destination: the amount minus every fee that
may be taken before the credit (A's withdrawal fee unless it is shown to be on top, and B's
deposit fee).

1. **Venue minimum first.** If B's healthy lookup for that coin and chain publishes a minimum, and
   it is an exact non-negative decimal, that value is the minimum, whatever it is: 0, lower than
   1 or higher. It is the venue's own figure and is recorded with its field name.
2. **Operator fallback otherwise.** If that lookup publishes no applicable minimum (the field is
   absent, or the venue's only value does not apply to that chain), the minimum is **1 unit of
   the actual coin**: 1 USDT for a USDT deposit, 1 USDC for a USDC deposit. The check is
   inclusive: `C_min >= 1` passes, and anything lower holds with `BELOW_DEPOSIT_MIN`. Examples:
   0.9999 holds and 1 passes when the fee is on top. With a 0.15 fee that may be taken from the
   amount, 1.15 passes and 1.1499 holds. At the finest exact unit, 0.999999999999 holds.
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
   - an unsupported coin or chain, or a contract that is not the reference contract for that coin;
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

| | USDT | USDC |
| --- | --- | --- |
| Policy (this rule) | all nine destinations | all nine destinations |
| Chains with a reference contract | TRC20, BEP20, ERC20, TON | BEP20 (`0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`), ERC20 (`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`); TRC20 and TON are not supported, and no variant is substituted |
| Native tools (address, transfer) | Binance, Bybit | Binance, Bybit, on BEP20 and ERC20 |
| Documented flows (nine venues) | supported as before, with this rule | **hold `ASSET_NOT_VERIFIED`**: the per-venue tables (outbound wire ids such as OKX `USDT-BSC`, whitelist rows with `coin: "USDT"`, WhiteBIT's `"USDT (<NET>)"` keys, amount steps, entity restrictions) were verified for USDT only |

The other seven venues return `VENUE_NOT_NATIVE` in the native tools, as before. When a venue's
USDC adapter is verified, this rule applies to it unchanged.

## Native tools: binding and recheck

The plan records `destination.minimum` = `{value, coin, basis, venueMinimum, field | statement}`
inside the hashed body. Every token detail comes from the plan's coin: the network row, the
address reads, the contract check, the balance, the fee asset, the withdrawal `code`, the QR's
alt text and the card's contract line. A USDC plan never reads, shows or sends a USDT value.

For any fallback plan (any venue, coin or chain), `fundkit_transfer_confirm` reads the
destination again on its deposit-only profile. It does this twice: before the card opens, and
after the human approves, right before the approval is passed to ccxt-mcp. Any change gives
`not-sent` with `DESTINATION_RECHECK_FAILED` and zero withdrawals:

- a different address or memo;
- deposits off, or contrary evidence;
- any read error;
- a venue minimum that has become known, even one the amount would clear, because the approved
  card no longer describes the plan.

The card wait is shortened, so card plus recheck stay inside ccxt-mcp's form wait. A plan on a
venue minimum is not rechecked, as before.

## Acceptance

These were run offline, with a fake ccxt-mcp and a T3-shaped host, in `tests/test_native.py`. They
were also run against the pinned ccxt-mcp 0.1.3 with the recorder transport inside `unshare -rn`
(`tests/test_real_ccxt_mcp.py`).

1. **Matrix.** The policy gives 1 for each of the 9 venues × 2 coins (18 cases), and none for
   other venues or coins. For each case: an absent field gives the fallback with `unknown` and the
   statement; 0, 0.5, 25 and 2 are applied as the venue's own figure; `null`, empty, text and
   negative hold.
2. **Reproducer, both coins.** Bybit → Binance BSC, 10 + 0.15 on top, 812.44 available: `ready`,
   debit 10.15, credit 10, minimum 1 with basis `fundkit-operator-fallback` in the plan and on the
   card. Cancel on the card gives zero withdrawal writes (fake: no dispatch; real server: no
   POST). For USDC, every coin-scoped request and every card line names USDC only.
3. **Approve once:** exactly one dispatch carrying the plan's coin; a second confirm sends nothing.
4. **Boundaries:** 0.9999 holds and 1 passes end to end for both coins. The shared check: 1.15 and
   1.1499 with the fee subtracted, and one exact unit below 1. A credit that is not positive holds,
   even with a venue minimum of 0.
5. **Venue minimum:** Binance 20 holds 10; Binance 0.5 lets 0.5001 through with no recheck; Bybit
   1, 0 and 350; Bybit with no field gives the fallback, which is rechecked, and a minimum that
   appears before the card stops it. Bybit `""` and Binance `n/a`, `null` and `-1` hold.
6. **Contrary, unhealthy, wrong token or chain:**
   - `depositDust` 1.01 or 1.5; `busy`;
   - deposits disabled;
   - a USDT contract on a USDC row, a USDT answer to a USDC read, a missing USDC answer;
   - a gated read for another coin or chain, two default addresses, a missing memo field;
   - an address equal to a token contract, an auth error.
   Each of these holds, with no plan and no card.
7. **Recheck:**
   - Before the card: a venue minimum appears (equal or higher), the address changes, deposits
     close, `depositDust` turns unreadable, or the key check fails.
   - While the card is open: a minimum appears (USDT and USDC), the address changes, or a read
     fails.
   Each of these gives `not-sent`, `DESTINATION_RECHECK_FAILED` and zero dispatch (real server:
   zero POST).
8. **Unsupported:** USDC on TRC20 or TON, a coin such as DAI, and a non-native venue are refused
   before any session or read.
9. **Address-only QR**, unchanged and independent of any amount: USDC on Binance BSC and ERC20 and
   on Bybit BSC gives a verified QR of the USDC address. The USDT address on the same chain stays
   its own.
10. **Other routes:** Binance TRC20 now uses the fallback like BSC; Binance → Bybit keeps Bybit's
    `depositMin` with no recheck.

The documented nine-venue flows are agent procedures, not code. Their counts in
[recipients.md](recipients.md#prerequisites-by-route) follow from this rule. They have not been
re-run as offline fixtures for this change.
