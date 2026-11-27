# Destination deposit minimum (USDT)

Fundkit sets **no deposit minimum of its own** for USDT deposits into any of the eight
supported exchanges. Where the exchange publishes a minimum, that minimum is enforced. Where it
publishes none, the minimum is **unknown**: Fundkit says so, recommends depositing at least
1 USDT, and does not check against that figure. The rule covers wallet top-ups from any
compatible wallet and exchange-to-exchange transfers, at every entry point: the native
`fundkit_deposit_address` and `fundkit_transfer_prepare` tools, and the documented flows in
[SKILL.md](../SKILL.md) (Scenario 1, Scenario 2 API withdrawals and the 2.9 manual send).

fundkit supports **USDT only**. A request for any other coin, USDC included, is refused before
any session, read or write (`UNSUPPORTED_COIN`), and is never read, planned or sent as USDT.

Applying the rule (the minimum _policy_) is separate from _support_, meaning which venue and chain
a fundkit adapter can actually read and send. Both are in [Scope](#scope-policy-versus-support).

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

6. **Not affected by this rule:** every source gate (withdrawal minimum, maximum, step, fee,
   available balance in one wallet, key rights), session caps, the single human approval,
   idempotency, the address-only QR (independent of any amount), and reconciliation against the
   expected `C`.

Binance `depositDust` is compared only with the plan's own `C_min`. It is bound into the plan
(a change makes the plan stale) and is never shown as the minimum.

Per venue, "publishes no applicable minimum" means:

| Destination | Venue minimum (enforced when present and exact)                                      | Minimum unknown when                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Binance     | a `depositMin` on the `networkList` row (not returned today)                         | always today; `depositDust` is never the minimum (unreadable holds, `C_min` at or below it is contrary)                 |
| Bybit       | `chains[].depositMin`                                                                | the field is absent from the chain row                                                                                   |
| OKX         | `minDep` on the raw currency row                                                     | the field is absent                                                                                                      |
| Bitget      | `minDepositAmount`                                                                   | the field is absent                                                                                                      |
| WhiteBIT    | `required.minAmount` on the address object                                           | the field is absent                                                                                                      |
| KuCoin      | `depositMinSize`                                                                     | the field is `null` or absent (KuCoin's schema uses `null` for unset)                                                    |
| MEXC        | none in the API (`depositTips` is free text)                                         | always                                                                                                                   |
| Gate        | top-level `min_deposit_amount`, only on a single-chain response for the chosen chain | multi-chain or other-chain response; `C_min` below a currency-level value on a multi-chain response is contrary evidence |

## Scope: policy versus support

|                                     | USDT                                                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Policy (this rule)                  | all eight destinations                                                                                                                   |
| Chains                              | TRC20, BEP20, ERC20, TON, at the reference contracts in [SKILL.md, Chains](../SKILL.md#chains)                                           |
| Native tools (address, transfer)    | Binance, Bybit; the other six return `VENUE_NOT_NATIVE`                                                                                  |
| Documented eight-venue flows        | the agent applies this rule ([SKILL.md](../SKILL.md#destination-deposit-minimum)); wallet top-ups from any compatible wallet (Scenario 1) |
| Any other coin (USDC, DAI, …)       | refused with `UNSUPPORTED_COIN` before any session or read, at every entry point                                                         |

## Native tools

**Address.** `fundkit_deposit_address` takes no amount and never asks for one. It adds
`depositMinimum` from the network row it already reads, and never holds the address or QR on
it: `published` (value, field, text), `unpublished` (the advice above) or `unreadable` (a
present but malformed field: "could not be read", with the same recommendation). A failed read
shows no address, no QR and no minimum claim.

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
venue minimum is not rechecked.
