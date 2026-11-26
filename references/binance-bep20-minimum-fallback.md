# Binance BEP20 destination: operator fallback minimum

Scope: the native `fundkit_transfer_prepare` / `fundkit_transfer_confirm` flow, destination
**Binance**, coin **USDT**, network **BNB Smart Chain (BEP20, Binance id `BSC`)** only. Every
other destination, asset and chain, the documented Markdown flows in [SKILL.md](../SKILL.md)
and `fundkit_deposit_address` are unchanged.

## Why

A real T3 thread (Bybit → Binance, BSC) ran as follows:

| Request | Result | Correct? |
| --- | --- | --- |
| address only | verified address and QR | yes |
| 2 USDT | `BELOW_WITHDRAW_MIN` (Bybit `withdrawMin` 10) | yes, kept |
| 10 USDT, 10.14 available | `INSUFFICIENT_BALANCE` (0.15 fee on top, 10.15 needed) | yes, kept |
| 10 USDT, enough available | `DESTINATION_MINIMUM_UNDOCUMENTED` | the case fixed here |

Binance's API reference (`GET /sapi/v1/capital/config/getall`, 28 `networkList` fields, read
2026-11-26) still names no deposit minimum; `depositDust` has only an example value. The last
case therefore could never reach a confirmation.

## Rule

When the Binance USDT BSC row and the recipient are verified and healthy and Binance supplies
no deposit minimum, the plan uses **5 USDT as Fundkit's operator fallback minimum**:

- It is Fundkit's own operating assumption, not a Binance figure, and it does not guarantee that
  Binance credits the deposit. The plan, the chat summary and the confirmation card say exactly
  that, in the same card the human already approves; no extra step, question or lookup.
- The check is on the conservative expected credit `C_min` (amount minus every fee that may be
  taken before the credit; Binance deposit fee 0): `C_min >= 5` passes (inclusive), below
  holds with `BELOW_DEPOSIT_MIN`.
- Healthy means all of: key check passed, the single `BSC` row with the USDT BEP20 contract,
  `depositEnable: true`, `busy` not `true`, the response names coin USDT, and the recipient
  read as before (gated and raw reads agree, one default row, memo field present, address
  shape). Any read, API or auth error, invalid field, suspension or disagreement holds exactly as
  before; the fallback is never used to get past it.
- Contrary evidence holds (`DESTINATION_MINIMUM_CONTRARY`): a `depositDust` that is not an exact
  decimal or is above 5. `depositDust` is never used as a minimum, only as a reason not to
  assume one.
- A venue minimum, when Binance supplies one on the row (`depositMin`, an exact decimal), is
  applied instead of the fallback, whether it is higher or lower; an unreadable one holds
  (`DESTINATION_MINIMUM_UNREADABLE`). Binance does not return such a field today.
- Every source gate stays: withdrawal minimum and maximum, step, fee, available balance in one
  wallet, key rights, and the session's caps, the single human approval and idempotency.

## Binding and recheck

The plan records `destination.minimum` = `{value, basis, venueMinimum, statement}` inside the
hashed body. For a fallback plan, `fundkit_transfer_confirm` reads Binance again on the
destination profile twice: before the card opens and again after the human approves, right
before the approval is passed to ccxt-mcp. Any change holds with `not-sent` and
`DESTINATION_RECHECK_FAILED`, zero withdrawal: a different address or memo, deposits disabled,
contrary evidence, any read error, or a venue minimum that became known (even one the amount
would clear: the approved card no longer describes the plan). A new prepare is needed.

## Acceptance

Offline (fake ccxt-mcp, T3-shaped host) and against the pinned ccxt-mcp 0.1.3 with the recorder
transport inside `unshare -rn`:

1. Bybit → Binance BSC, 10 USDT, fee 0.15 on top, 812.44 available: `ready`, debit 10.15,
   credit 10, minimum 5 with basis `fundkit-operator-fallback`, venue minimum unknown, all in
   the plan and the card. Cancel on the card: `not-sent`, zero withdrawal writes (fake: no
   dispatch; real server: no POST).
2. Source twins unchanged: 2 USDT `BELOW_WITHDRAW_MIN`; 10 USDT with 10.14 available
   `INSUFFICIENT_BALANCE`.
3. Threshold (Bybit `withdrawMin` lowered in the fixture): 4.9999 holds `BELOW_DEPOSIT_MIN`,
   5 is ready; a fee-subtracted source model at 5.15 − 0.15 (passes) and 5.1499 − 0.15 (holds)
   checked on the same function. The tests derive every boundary from the one constant.
4. Venue minimum on the row: 20 holds 10 with `BELOW_DEPOSIT_MIN`; half the fallback lets an
   amount just above it through with that value as basis and no recheck; an unreadable or `null`
   one holds.
5. Contrary, unhealthy or failed data: depositDust 5.01, `busy: true`, deposits disabled,
   contract mismatch, another coin, two default addresses, wrong chain, missing memo field, an
   auth error: hold, no plan, no card. depositDust equal to 5 is no contrary evidence.
6. Recheck: a venue minimum appears (equal or higher), the address changes, deposits close,
   depositDust turns unreadable or the key check fails before the card, or a minimum appears,
   the address changes or a read fails while the card is open: `not-sent`,
   `DESTINATION_RECHECK_FAILED`, zero dispatch (real server: zero POST).
7. Approve once: exactly one dispatch; a second confirm sends nothing.
8. Other networks: Bybit → Binance TRC20 still `DESTINATION_MINIMUM_UNDOCUMENTED`; Binance →
   Bybit unchanged (Bybit `depositMin`, no recheck); the address-only QR flow is unchanged and
   independent of any amount.
