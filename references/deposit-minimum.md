# Destination deposit minimum (USDT)

The owner's rule: Fundkit sets **no deposit minimum of its own** for USDT deposits into any of
the nine supported exchanges. Where the exchange publishes a minimum, that minimum is enforced.
Where it publishes none, the minimum is **unknown**: Fundkit says so, recommends depositing at
least 1 USDT, and does not check against that figure. The rule covers wallet top-ups from any
compatible wallet and exchange-to-exchange transfers, at every entry point: the native
`fundkit_deposit_address` and `fundkit_transfer_prepare` tools, and the documented flows in
[SKILL.md](../SKILL.md) (Scenario 1, Scenario 2 API withdrawals and the 2.9 manual send).

fundkit supports **USDT only**. A request for any other coin, USDC included, is refused before
any session, read or write (`UNSUPPORTED_COIN`), and is never read, planned or sent as USDT.

Applying the rule (the minimum _policy_) is separate from _support_, meaning which venue and chain
a fundkit adapter can actually read and send. Both are in [Scope](#scope-policy-versus-support).

## History

A real T3 thread (Bybit → Binance, BSC) ran as follows:

| Request                   | Result                                                   | Correct?            |
| ------------------------- | -------------------------------------------------------- | ------------------- |
| address only              | verified address and QR                                  | yes                 |
| 2 USDT                    | `BELOW_WITHDRAW_MIN` (Bybit `withdrawMin` 10)            | yes, kept           |
| 10 USDT, 10.14 available  | `INSUFFICIENT_BALANCE` (0.15 fee on top, 10.15 needed)   | yes, kept           |
| 10 USDT, enough available | `DESTINATION_MINIMUM_UNDOCUMENTED`                       | fixed by this rule  |

Binance's API reference (`GET /sapi/v1/capital/config/getall`, 28 `networkList` fields, read
2026-11-26) names no deposit minimum, and `depositDust` has only an example value. MEXC (no
field) and Gate (only a currency-level value) held the same way in the documented flows. The
owner first set a 1 USDT operator minimum for Binance BSC, then for every exchange. They then
revised it: even 1 USDT is not to be a minimum. An unknown minimum is stated as such, with a
recommendation of at least 1 USDT that is not a check, for wallet top-ups and transfers alike.

## Rule

`C_min` is the conservative expected credit on the destination: the amount minus every fee that
may be taken before the credit (A's withdrawal fee unless it is shown to be on top, and B's
deposit fee).

1. **Positive credit, always.** `C_min > 0`, or the plan holds with `CREDIT_NOT_POSITIVE`
   (an amount equal to or below a fee that may be taken from it). This applies whatever the
   minimum is, including a venue minimum of 0.
2. **Venue minimum, enforced.** If B's healthy USDT lookup for that chain publishes a minimum,
   and it is an exact non-negative decimal, that value is the minimum, whatever it is: 0, below
   1 or above. `C_min ≥ minimum` passes (inclusive), anything lower holds with
   `BELOW_DEPOSIT_MIN`. It is recorded with its field name.
3. **Unknown otherwise.** If that lookup publishes no applicable minimum (the field is absent,
   or the venue's only value does not apply to that chain), the minimum is unknown. It is
   recorded as `value: null`, `basis: venue-unpublished`, `venueMinimum: unknown`, never as 0
   and never as a credit guarantee. It adds no threshold: any positive `C_min` that every other
   gate allows qualifies, 0.5 USDT and the smallest amount fundkit can send (0.000001 USDT on
   a 6-place step) included.
4. **The recommendation.** Wherever the minimum is unknown, the user is told, before any
   confirmation:
   - on a transfer plan and its card: `Destination deposit minimum unknown. Fundkit recommends
depositing at least 1 USDT.`
   - on an address or QR lookup, which takes no amount: `The exchange has not published a
minimum for this network. Fundkit recommends depositing at least 1 USDT.`

   The 1 USDT is advice only. It is never compared with an amount, never a threshold, never a
   guarantee and never an extra question, acknowledgement or step. The agent may translate it
   in the chat; the card keeps the English.

5. **Never "not published" for something else.** These still hold, and none of them is
   reported as an unknown minimum:
   - a minimum field that is present but malformed (`null`, empty, text, negative):
     `DESTINATION_MINIMUM_UNREADABLE`. On the address-only lookup, which never blocks on a
     minimum, the same case says "could not be read", not "not published";
   - a field the venue returns without a documented meaning that is unreadable (Binance
     `depositDust`): `DESTINATION_FIELD_UNREADABLE`, the row is not healthy;
   - contrary evidence against the amount, never a minimum: `C_min` at or below a readable
     Binance `depositDust`, or below Gate's currency-level `min_deposit_amount` on a
     multi-chain response: `DESTINATION_MINIMUM_CONTRARY`;
   - a failed read, an API or auth error, or a response for another coin or chain (the address
     lookup then shows no address and no minimum claim);
   - deposits disabled or suspended, or Binance `busy`;
   - an unsupported chain, or a contract that is not the USDT reference contract;
   - any recipient problem (address, memo, disagreeing reads), and an inbound cap.

6. **Unchanged:** every source gate (withdrawal minimum, maximum, step, fee, available balance
   in one wallet, key rights), session caps, the single human approval, idempotency, the
   address-only QR (independent of any amount), and reconciliation against the expected `C`.

There is no constant left to compare `depositDust` with: the old rule held when it was above
1 USDT. It is now compared with the plan's own `C_min`, is bound into the plan (a change makes
the plan stale), and is never shown as the minimum.

Per venue, "publishes no applicable minimum" means:

| Destination | Venue minimum (enforced when present and exact)                                      | Minimum unknown when                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Binance     | a `depositMin` on the `networkList` row (not returned today)                         | always today; `depositDust` is never the minimum (unreadable holds, `C_min` at or below it is contrary)                 |
| Bybit       | `chains[].depositMin`                                                                | the field is absent from the chain row                                                                                   |
| OKX         | `minDep` on the raw currency row                                                     | the field is absent                                                                                                      |
| Bitget      | `minDepositAmount`                                                                   | the field is absent                                                                                                      |
| BingX       | the chosen chain's `depositMin`                                                      | the field is absent from that row                                                                                        |
| WhiteBIT    | `required.minAmount` on the address object                                           | the field is absent                                                                                                      |
| KuCoin      | `depositMinSize`                                                                     | the field is `null` or absent (KuCoin's schema uses `null` for unset)                                                    |
| MEXC        | none in the API (`depositTips` is free text)                                         | always                                                                                                                   |
| Gate        | top-level `min_deposit_amount`, only on a single-chain response for the chosen chain | multi-chain or other-chain response; `C_min` below a currency-level value on a multi-chain response is contrary evidence |

## Scope: policy versus support

|                                     | USDT                                                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Policy (this rule)                  | all nine destinations                                                                                                                    |
| Chains                              | TRC20, BEP20, ERC20, TON, at the reference contracts in [SKILL.md, Chains](../SKILL.md#chains)                                           |
| Native tools (address, transfer)    | Binance, Bybit; the other seven return `VENUE_NOT_NATIVE`, as before                                                                     |
| Documented nine-venue flows         | the agent applies this rule ([SKILL.md](../SKILL.md#destination-deposit-minimum)); wallet top-ups from any compatible wallet (Scenario 1) |
| Any other coin (USDC, DAI, …)       | refused with `UNSUPPORTED_COIN` before any session or read, at every entry point                                                         |

## Native tools

**Address.** `fundkit_deposit_address` takes no amount and never asks for one. It adds
`depositMinimum` from the network row it already reads, and never holds the address or QR on
it: `published` (value, field, text), `unpublished` (the advice above) or `unreadable` (a
present but malformed field: "could not be read", with the same recommendation). A failed read
shows no address, no QR and no minimum claim, as before.

**Plan.** The plan records `destination.minimum` =
`{value, coin: "USDT", basis, venueMinimum, field, notice?, advice?, statement?, uninterpreted?}`
inside the hashed body, and `destination.depositMin` (null when unknown). When unknown, the
prepare result carries `minimumNotice` at the top and in `plan`, `destinationMinimum: "unknown"`,
and `next.how` tells the agent to include the notice in its plan message **before** it calls
`fundkit_transfer_confirm`. The one confirmation card shows the same line in its body, above
Approve and Decline, bound to the same plan id and hash. Nothing is dispatched before the
human approves that card; there is no second card or acknowledgement.

**Recheck.** For a plan whose minimum is unknown, `fundkit_transfer_confirm` reads the
destination again on its deposit-only profile, before the card opens and after the human
approves, right before the approval is passed to ccxt-mcp. Any change gives `not-sent` with
`DESTINATION_RECHECK_FAILED` and zero withdrawals:

- a different address or memo;
- deposits off, an unhealthy row, or an uninterpreted field (`depositDust`) that appeared or
  changed;
- any read error;
- a venue minimum that has become known, whatever its value (0, 1 or higher), because the
  approved card no longer describes the plan.

The card wait is shortened, so card plus recheck stay inside ccxt-mcp's form wait. A plan on a
venue minimum is not rechecked, as before.

## Acceptance

What was run, and on what. Offline only: synthetic keys and responses, no real account, no
network. `tests/test_native.py` uses the fake ccxt-mcp and a T3-shaped host.
`tests/test_real_ccxt_mcp.py` uses the pinned ccxt-mcp 0.1.3 with ccxt 4.5.85, its transport
replaced by a recorder, inside `unshare -rn`.

1. **Policy matrix.** For each of the 9 venues: an absent field gives `venue-unpublished`,
   `value: null`, `depositMin: null`, `unknown`, the notice and the statement, and the smallest
   exact credit (10⁻¹² USDT) passes while 0 holds; 0, 0.5, 25 and 2 are the venue's own figure
   and enforced; `null`, empty, text and negative hold. USDC is never resolved
   (`UNSUPPORTED_COIN`), nor is a venue outside the nine. Function level: of the nine, only
   the Binance and Bybit adapters run end to end (items 2 to 9).
2. **Reproducer.** Bybit → Binance BSC, 10 + 0.15 on top: `ready` with `minimumNotice`, debit
   10.15, credit 10, `destinationMinimum: unknown`; one card with the notice line; Cancel gives
   zero withdrawal writes (fake: no dispatch; real server: no POST).
3. **Order of disclosure.** For 0.5 (Cancel and Approve) and 10 (Approve): the prepare result
   carries the notice and `next.how` requires it before the card; no card exists until
   confirm; the one card shows the notice above the exact call with the plan id and hash; no
   dispatch has happened while the card is open; Approve sends exactly once. Real server: a 0.5
   USDT plan reaches one card with the notice, and Cancel gives zero POST.
4. **Below 1 and the smallest unit:** 0.9999, 0.5, 0.0001 and 1 are planned into Binance;
   0.000001 on a 6-place Bybit step is planned; 0.0000001 is `AMOUNT_NOT_REPRESENTABLE`. Into
   Bybit with no `depositMin`: 0.5 and 1 (credit 0.21 and 0.71 after Binance's 0.29 fee) are
   planned, and a 0.5 plan is sent once on approval.
5. **Zero or negative after fees:** Binance → Bybit 0.29 (credit 0) and 0.1 (credit −0.19)
   hold with `CREDIT_NOT_POSITIVE`; so does a credit of 0 with a venue minimum of 0.
6. **Source gates:** `BELOW_WITHDRAW_MIN` (2 against 10; 0.4999 against 0.5) and
   `INSUFFICIENT_BALANCE` still hold below and above 1.
7. **Venue minimum:** Binance 20 holds 10; Binance 0.5, 0 and 1 are enforced inclusively with
   no notice and no recheck; Bybit 1, 0 are applied, 350 holds 300 and 1 holds a credit of
   0.71. Bybit `""` and Binance `n/a`, `null` hold.
8. **Unhealthy, contrary, wrong coin or chain:** `depositDust` `n/a`; `busy`; deposits
   disabled; a wrong contract; a network list for another coin; a gated read for another chain;
   two default addresses; a missing memo field; an auth error. Each holds, with no notice, no
   plan and no card. `depositDust` 0.0005 and 1.5 hold a credit equal to them and allow one a
   unit above, with the value bound in the plan.
9. **Recheck:** before the card (a minimum of 1, 0 or 20 appears, the address changes, deposits
   close, `depositDust` turns unreadable or appears, the key check fails) and while the card is
   open (a minimum appears, the address changes, a read fails). Each gives `not-sent`,
   `DESTINATION_RECHECK_FAILED` and zero dispatch (real server: zero POST). Bybit: 0.1
   appearing before the card reads `now 0.1 USDT (venue), not unknown (venue-unpublished)`.
10. **Address and QR:** Bybit `depositMin` 1, 0, 350 give `published` with the value; absent
    gives `unpublished` with the advice; `""` gives `unreadable` ("could not be read", never
    "not published"); Binance's row gives the advice, or 0.5 when published. Every case shows
    the verified QR and copyable address, opens no card and creates no plan. A failed read
    shows no address and no minimum claim.
11. **USDT only:** `USDC`, `usdc`, ` USDC `, `DAI`, an empty string, `USDT-BSC` and a number are
    refused with `UNSUPPORTED_COIN` by both native tools, with and without a session, with
    zero reads and writes.

The documented nine-venue flows are agent procedures, not code. They were **not** re-run for this
rule, so no route count under it is claimed: [recipients.md](recipients.md#prerequisites-by-route)
reports only the counts that were measured before it.
