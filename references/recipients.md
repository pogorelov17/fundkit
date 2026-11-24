# Native recipient reads: deposit address and memo from the operator's own account

How the agent reads a verified USDT recipient (address, memo, chain, landing wallet) from the
operator's own exchange account through ccxt-mcp, so nobody copies an address by hand. Used by
[SKILL.md, Scenario 1](../SKILL.md#scenario-1-okx-wallet--exchange-manual-send) and
[Scenario 2](../SKILL.md#scenario-2-exchange-a--exchange-b-semi-automatic). The exchange UI
stays an option the user may choose; it is never a required step.

Status in this revision: **Bybit** ([SKILL.md, Bybit deposit address](../SKILL.md#bybit-deposit-address))
and **OKX** (below) are verified offline. The other seven venues use the manual path until
their rows here are filled in.

## Common procedure

Use one alias with `"funds": "live"` for every read (ccxt-mcp gates address methods behind
`funds`; `dryRun` does not stop reads). Never call `get_deposit_address`: on several venues it
falls back to creating an address. Only `call_read_method` and `call_implicit_get` with the
names below.

1. **Network data** for the venue ([network data sources](exchanges.md#network-data-sources)):
   deposit enabled, minimum, contract, memo-required flag.
2. **Key check**: the venue's key-metadata read. Require the permission scope in the venue row
   (read-only for a deposit-only profile). Report the account identifier; the operator confirms
   it once against the exchange UI or their own records.
3. **Gated read**: the venue's normalized address method with `includeInfo: true`. It
   establishes the funds gate and gives a comparison value.
4. **Raw read**: the venue's raw endpoint through `call_implicit_get`, same alias, only after
   step 3 succeeded. ccxt indexes addresses by network, so duplicates vanish from step 3
   (verified offline). The raw response must contain **exactly one** eligible row for the
   chosen chain, and its address, memo and chain must equal step 3's `info`. That raw row is
   the address source.
5. **Show** the address and the memo (or `none`) each in its own code block, copied character
   for character from the raw row, with `<venue> UID <id>, alias <alias>, read <UTC>, chain <id>`.

Hold on: an empty result (the tools cannot and must not create an address: the operator
creates one in the exchange, then the agent reads again), several eligible rows, a wrong
chain, a contract suffix that does not match the [reference contract](../SKILL.md#chains),
a missing or non-string memo field where the venue publishes a memo flag, or any field that
differs between steps 3 and 4. Repeat steps 3 and 4 just before OPEN; any change needs a
new sheet or plan.

## OKX

Verified offline with ccxt-mcp 0.1.3, ccxt 4.5.85, synthetic keys, `unshare -rn` and a
fixture transport (shapes from OKX's v5 docs, not captured live):

| Step | Call | Check |
|---|---|---|
| network data | `call_read_method {"exchange":"okx","account":"<alias>","method":"fetchDepositWithdrawFee","args":["USDT"],"includeInfo":true}` | raw `/asset/currencies` row: `chain` `USDT-TRC20`/`USDT-BSC`/`USDT-ERC20`/`USDT-TON`, `canDep`, `minDep`, `ctAddr`, `needTag` |
| key check | `call_implicit_get {"exchange":"okx","account":"<alias>","method":"privateGetAccountConfig"}` | `data[0].perm` exactly `read_only` for a deposit-only key; report `uid`, `mainUid`, `label`, `ip` |
| gated read | `call_read_method {"exchange":"okx","account":"<alias>","method":"fetchDepositAddress","args":["USDT"],"params":{"network":"<code>"},"includeInfo":true}` | sends only `GET /api/v5/asset/deposit-address?ccy=USDT`; ccxt keeps only `selected: true` rows and one per network |
| raw read | `call_implicit_get {"exchange":"okx","account":"<alias>","method":"privateGetAssetDepositAddress","params":{"ccy":"USDT"}}` | `code: "0"`; exactly one row with the chosen `chain` and `selected: true`; equal `addr`, memo and `chain` to the gated `info` |

- Memo: OKX returns `tag`, `memo` or `pmtId`, or `addrEx` (TON: `addrEx.comment`). Use the
  field the raw row carries, exactly as a string. If `needTag` is true and no memo field is
  present, hold.
- `ctAddr` is a contract suffix; it must match the end of the reference contract.
- `to` is the landing wallet: `6` funding, `18` trading. Record it as `Lands in`.
- Rows with `selected: false` are other addresses of the account; they are not eligible.
  Two `selected: true` rows for one chain: ccxt silently kept the last one; hold.
- Offline results: no key → `AUTH_FAILED requires "apiKey" credential`, no passphrase →
  `requires "password" credential`, nothing sent; profile without `funds` → `TIER_DISABLED`
  for both reads (the raw name matches the gate pattern); empty `data` → gated read
  `InvalidAddress`, raw `data: []`, and `get_deposit_address` sent no create request; a
  row for another chain only → `InvalidAddress`; only GET requests.
- Not verified: real-key responses, whether OKX provisions an address on this read.
