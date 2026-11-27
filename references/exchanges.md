# Exchanges: wallets, networks, outbound requests (ccxt 4.5.85)

**Verified** means checked without keys: from the ccxt 4.5.85 code, from a public response
through ccxt-mcp, or offline from the built request (synthetic keys, network disabled; see
[`ccxt-mcp.md`](ccxt-mcp.md#verification)). **Account test** means something visible only
with the user's key: account mode, key permissions, network enable flags, real fees and
minimums, the available-amount field. Until such a test is done, all of these are
**unknown**.

## Wallets for transfer

From `options.accountsByType`. The left side is the name passed in `fromAccount`/`toAccount`,
the right side is the exchange's wallet id. Different names with the same id are **aliases of
one wallet**.

| Exchange (`exchange`) | Names → wallet id |
|---|---|
| Binance (`binance`) | `main`,`spot`→MAIN · `funding`→FUNDING · `margin`,`cross`→MARGIN · `linear`,`swap`,`future`→UMFUTURE (USDⓈ-M) · `inverse`,`delivery`→CMFUTURE · `option`→OPTION |
| Bybit (`bybit`) | `funding`,`fund`→FUND · `unified`→UNIFIED (UTA) · `spot`,`margin`→SPOT · `contract`,`swap`,`future`→CONTRACT (classic) · `option` · `investment` |
| Gate (`gate`) | **`funding`,`spot`→spot** (no separate funding wallet) · `margin`,`isolated`→margin · `cross_margin`,`cross`→cross_margin · `swap`,`futures`→futures · `future`,`delivery`→delivery · `option`,`options`→options |
| OKX (`okx`) | `funding`→6 · `trading`,`spot`,`swap`,`future`,`futures`,`margin`,`option`→18 (trading) |
| Bitget (`bitget`) | **`funding`,`spot`→spot** · `swap`→usdt_futures (USDT-M) · `usdc_swap`→usdc_futures · `future`→coin_futures (**not** USDT-M) · `cross`→crossed_margin · `isolated`→isolated_margin · `p2p` · `uta`,`unified`→uta |
| WhiteBIT (`whitebit`) | `funding`,`main`→main · `spot`,`trade`→spot · `margin`→collateral |
| MEXC (`mexc`) | `spot`→SPOT · `swap`,`future`→FUTURES (mapped inside `transfer`; offline request verified) |
| KuCoin (`kucoin`) | `funding`,`main`→main · `spot`→trade · `hf`→trade_hf · `margin`,`cross`,`marginV2`→margin · `isolated` · `future`,`swap`,`contract`→contract · `uta`,`unified`→unified · `mining`→pool |
| Hyperliquid | not used (watch-only) |

Before a transfer, Bitget and KuCoin probe the UTA mode themselves, and Bybit generates its
own `transferId`. Key environment variables are described in [`security.md`](security.md).

## Network data sources

The same source serves both sides: A's withdrawal fields and B's deposit fields. Every field
named here was read offline from fixtures shaped after the venue's reference ("offline"). Values
on a real account are an account test.

| Exchange | Source | Fields | Status |
|---|---|---|---|
| Bitget | `call_read_method … fetchDepositWithdrawFee ["USDT"] includeInfo` | `info.chains[]`: `chain`, `withdrawable`, `rechargeable`, `minWithdrawAmount`, `minDepositAmount`, `withdrawFee`, `extraWithdrawFee`, `withdrawMinScale`, `contractAddress`, `needTag` | verified publicly; offline |
| WhiteBIT | `call_implicit_get {"exchange":"whitebit","method":"v4PublicGetFee"}` + `call_implicit_get {"exchange":"whitebit","method":"v4PublicGetAssets"}` | fee `"USDT (<NET>)"`: `is_withdrawal`, `is_api_withdrawal`, `is_depositable`, `is_api_depositable`, `withdraw.min_amount/max_amount/fixed/flex` (`flex` is the percentage part); assets `USDT`: `currency_precision`, `limits.deposit.<NET>.min`, `is_memo`; **no contract** in either | verified publicly; offline |
| KuCoin | `call_implicit_get {"exchange":"kucoin","method":"publicGetCurrenciesCurrency","params":{"currency":"USDT"}}` | `data.precision`; `data.chains[]`: `chainId` (`trx`,`bsc`,`eth`,`ton`), `isDepositEnabled`, `isWithdrawEnabled`, `depositMinSize` (`null` = not set: the minimum is [unknown](deposit-minimum.md)), `withdrawalMinSize`, `withdrawalMinFee`, `withdrawFeeRate` (nonzero: `f` inexact, hold), `withdrawPrecision`, `contractAddress`, `needTag`, and the optional `depositFeeRate` ("Deposit fee rate … the default is empty") and `depositTierFee` (no description); both were `null` on the live public read of 2026-11-25 | verified publicly; offline |
| Gate | `call_implicit_get {"exchange":"gate","method":"publicWalletGetCurrencyChains","params":{"currency":"USDT"}}` | `chain`, `is_disabled`, `is_deposit_disabled`, `is_withdraw_disabled`, `contract_address`, `decimal`, `is_tag`, `withdraw_amount_min` (per chain); **no deposit minimum** per chain. The live public read of 2026-11-25 showed USDT TON with `is_withdraw_disabled: 1` (withdrawals from Gate on TON hold) and `withdraw_amount_min` 10 on TRX, 1 elsewhere | verified publicly; offline |
| Gate, withdrawal fee | `call_implicit_get {"exchange":"gate","account":"<alias>","method":"privateWalletGetWithdrawStatus","params":{"currency":"USDT"}}` | `withdraw_fix_on_chains.<chain>`, `withdraw_percent_on_chains.<chain>` (must be `0%`), `withdraw_amount_mini`; the withdrawal minimum is the larger of that and the chain's `withdraw_amount_min` | offline |
| Bybit | `call_read_method … fetchDepositWithdrawFee ["USDT"] includeInfo` with the Bybit alias | `info.remainAmount` (maximum per withdrawal); `info.chains[]`: `chain`, `chainType`, `chainDeposit` (`1` normal, `0` suspended), `chainWithdraw`, `depositMin`, `withdrawMin`, `contractAddress` (full), `minAccuracy`, `withdrawFee`, `withdrawPercentageFee` (must be `0`); **no deposit fee** ([below](#bybit-deposit-address)). ccxt 4.5.85 sends no `feeType`, so Bybit's default applies (the entered amount is the amount received; the fee comes on top) | fields per Bybit's coin-info docs; offline; `AUTH_FAILED` without a key |
| OKX | `call_implicit_get {"exchange":"okx","account":"<alias>","method":"privateGetAssetCurrencies","params":{"ccy":"USDT"}}` | one raw row per chain: `chain`, `canDep`, `canWd`, `minDep`, `minWd`, `maxWd` (per transaction), `wdQuota` and `usedWdQuota` (24 h, USD), `depQuotaFixed` and `usedDepQuotaFixed` (USD; empty = no deposit limit), `fee`, `burningFeeRate`, `wdTickSz`, `ctAddr`, `needTag` (OKX documents it as the withdrawal-side memo flag; on the deposit side it is a conservative cross-check, the address row is the evidence). Not `fetchDepositWithdrawFee`: its `info` keeps only the last chain's row (verified offline) | offline; key required |
| Binance, MEXC | `fetchDepositWithdrawFee ["USDT"] includeInfo` | `info.networkList[]` (Binance: `withdrawEnable`, `withdrawFee`, `withdrawMin`, `withdrawIntegerMultiple`, `depositEnable`, `contractAddress`, `withdrawTag`; MEXC: `netWork`, `network`, `withdrawEnable`, `withdrawFee`, `withdrawMin`, `withdrawIntegerMultiple`, `depositEnable`, `contract`) | offline; `AUTH_FAILED` without a key |
| all eight, recipient side | [native recipient reads](recipients.md) | address, memo, chain, landing wallet where returned; deposit fee and minimum sources per venue | offline |

`fetchCurrencies` is not suitable for picking a network. For Gate, Bitget, WhiteBIT and
KuCoin the whole response is replaced by the truncation marker, and Binance, Bybit, OKX and MEXC
returned `{}` without a key.

### Gate as recipient

Gate's address response has a currency-level `min_deposit_amount`. It counts as the chain's
minimum only when the **unfiltered** `multichain_addresses` list has exactly one row, that row
is the chosen chain and it is eligible (`obtain_failed: 0`)
([recipients.md, Gate](recipients.md#gate)). The deposit fee is `withdraw_status.deposit`. With
a single-chain response an API withdrawal to Gate uses that minimum (verified offline). With a
multi-chain response, the usual case, Gate publishes no minimum for the chain, so `min` is
[unknown](deposit-minimum.md): no Fundkit minimum, the 1 USDT recommendation is advice only,
and a credit below a currency-level value is contrary evidence and holds. The agent
reads the full address and memo natively (a provisioning read,
[setup consent](recipients.md#provisioning-reads)). The user may still supply Gate's own minimum
from its deposit page as a [per-plan human-read fact](../SKILL.md#per-plan-human-read-facts),
which then wins. The agent
reconciles the Gate deposit by hash ([SKILL.md, 2.7](../SKILL.md#27-reconciliation)).

### Bybit deposit address

How [SKILL.md, Scenario 1](../SKILL.md#bybit-deposit-address) reads the address from the
operator's own Bybit account. Verified offline with ccxt-mcp 0.1.3, ccxt 4.5.85 and mocked
responses unless noted:

- `fetchDepositAddressesByNetwork` with `network` calls only
  `GET /v5/asset/deposit/query-address` with `coin=USDT` and `chainType` from the network code
  (`TRC20` → `TRX`, `BEP20` → `BSC`, `ERC20` → `ETH`, `TON` → `TON`). ccxt-mcp's
  `call_read_method` has no create fallback, and ccxt 4.5.85 has no Bybit
  `createDepositAddress`, so on Bybit even `get_deposit_address` only reads (no address:
  `NOT_SUPPORTED`). The client sends GETs only; whether Bybit provisions an address
  server-side on that query is not documented. An empty result means no address on that
  network: these tools cannot create one.
- The raw entry has `chainType`, `chain`, `addressDeposit`, `tagDeposit`, `batchReleaseLimit`
  and `contractAddress` (last 6 characters only, per Bybit's docs). The unified `tag` turns an
  empty `tagDeposit` into `null`, so read the memo from raw `info.tagDeposit`.
- **Duplicates are hidden.** ccxt indexes the parsed `result.chains` by network
  (`indexBy(…, 'network')`, network taken from `chain`). Two entries for `BSC` with addresses
  `0x1111…` and `0x2222…` came back as one `BEP20` entry with `0x2222…`; the raw read showed
  both. An entry for another chain shows up under its own key: an `ERC20` request answered
  with a `BSC` entry gave `data` keyed `BEP20`.
- **Gates.** ccxt-mcp gates methods matching `/deposit.?address|withdraw.?address|withdrawal.?whitelist/i`
  behind `funds`: `fetchDepositAddressesByNetwork` on an account without `funds` gave
  `TIER_DISABLED`, without an account too. The raw name
  `privateGetV5AssetDepositQueryAddress` does not match that pattern: `call_implicit_get` on
  it returned the address on an account without `funds`. First complete the gated read on the same `funds` alias.
  Its fields must agree with the unique raw row. That raw row supplies the address and memo.
- Bybit serves this endpoint only to main-account keys (Bybit docs).
- `privateGetV5UserQueryApi` (`GET /v5/user/query-api`, any key may call it) returns
  `readOnly`, `permissions`, `ips`, `userID` and `isMaster`. The server replaces the key value
  in `apiKey` with `[redacted:apiKey]`. `userID` is incidental metadata: fundkit does not use
  it to bind the key to an account.
- **Coin list first.** Before its first Bybit call, and already at startup, the server loads
  Bybit's markets and, with a key, its coin list (`GET /v5/asset/coin/query-info`). The load
  is cached on disk for a day. If Bybit answers `10005` there, the key check and every other
  Bybit call in that server process return the same `10005` without sending their own
  request (ccxt keeps the failed load), until a restart. If the coin list loads, a `10005`
  from the key check comes from `query-api` itself.
- Errors: no key in the server process gives `AUTH_FAILED` `bybit requires "apiKey" credential`
  before any signed request, for the key check and the address read alike. Bybit `retCode`
  `10003` (invalid key), `10004` (signature), `10010` (IP not bound) and `10005` (permission
  denied) map to `AUTH_FAILED`; for `10005` ccxt adds a generic text naming "Account
  Transfer", "Subaccount Transfer" and "Withdrawal".
- Deposit fee: Bybit states that it charges no fee for on-chain crypto deposits
  ([Bybit's Fees That You Need to Know](https://www.bybit.com/en/help-center/article/Bybit-Fees-You-Need-to-Know),
  checked 2026-11-24), so `d = 0` with that page as the source. Bybit's network source has no
  deposit fee field. If a live field or a Bybit page the user chose to check shows another
  value, `d` is unknown and the route holds. A credit that differs from the expected `C`
  also holds the route ([SKILL.md, 2.7](../SKILL.md#27-reconciliation)).
- Not verified: whether a read-only key may read the address with a real Bybit account, and
  whether Bybit ever returns several entries for one chain.

## Outbound withdraw

Verified offline with ccxt-mcp 0.1.3 and ccxt 4.5.85. The table shows what the exchange
request actually contains for `network: "<code>"` and `tag`. The value does not depend on live
data: each code has a static mapping, and WhiteBIT passes the string unchanged. No other pairs
qualify. `ARBONE` on every exchange depends on live data and is **not
verified**, so withdrawals there are manual only.

| Exchange | `TRC20` | `BEP20` | `ERC20` | `TON` | memo is sent as | `params` (exactly) |
|---|---|---|---|---|---|---|
| Binance | `network=TRX` | `BSC` | `ETH` | `TON` | `addressTag` | `{"walletType":0}` (spot) or `{"walletType":1}` (funding), the wallet holding the USDT. Binance's default is "the currently selected wallet", a UI setting, so the plan always names it |
| Bybit | `chain=TRX` | `BSC` | `ETH` | `TON` | `tag` | `{"accountType":"FUND"}` or `{"accountType":"UTA"}`, the wallet holding the USDT; without it ccxt picks UTA or SPOT from its own mode query. No beneficiary data is sent: entities that require it hold |
| Gate | `chain=TRX` | `BSC` | `ETH` | `TON` | `memo` | `{}` |
| OKX | `chain=USDT-TRC20` | `USDT-BSC` | `USDT-ERC20` | `USDT-TON` | `toAddr=<address>:<memo>` | `{"fee":"<exact f>"}` (sent as `fee`; OKX's current reference lists no such parameter, so the server's use of it is unverified). No `rcvrInfo` is sent: entities that require it hold |
| Bitget | `chain=TRC20` | `BSC`² | `ERC20` | `TON` | `tag` | `{"uta":true}` or `{"uta":false}` per the verified mode; without it ccxt assumes classic on any probe error |
| WhiteBIT | `network=` the exact string passed: pass `<NET>` from the `"USDT (<NET>)"` key (`TRC20`, `BEP20`, `ERC20`, `TON`) | | | | `memo` | `{}`. The contract comes from the operator's pinned setup evidence ([recipients.md](recipients.md#whitebit)); routes from WhiteBIT still hold because its available amount is not visible ([account mode table](#account-mode-and-available-amount)) |
| MEXC | `netWork=TRX` | `BSC`¹ | `ETH` | `TONCOIN`¹ | `memo` | `{}`; the amount goes out unrounded, so the step must come from a valid live `withdrawIntegerMultiple`; `null` (as in MEXC's reference example) holds that network only ([steps](#amount-steps)) |
| KuCoin | `chain=trx` | `bsc` | `eth` | `ton` | `memo` | `{}`; `network` is required, without it the default chain is sent |

The outbound value must match that network's id in A's live response. Otherwise, stop.

¹ MEXC may return an outdated long id for BEP20 and TON (for example
`BNB Smart Chain(BEP20)`). The pair qualifies only if the id in A's live response is exactly
`BSC` or `TONCOIN`; otherwise withdraw manually.

² Bitget's live public coin list names that chain `BEP20`, not `BSC`, and no source shows that
Bitget accepts `BSC`. Bitget BEP20 **outbound** therefore holds: ccxt builds the withdrawal, and
overriding its chain with `params` would be invisible in the form. Inbound Bitget BEP20 is
native: the recipient read is Bitget's raw, funds-gated endpoint, sent with the live id `BEP20`
([recipients.md, Bitget](recipients.md#bitget)). Bitget TRC20, ERC20 and TON send the live id
in both directions.

### Withdrawal whitelist evidence

Before an API withdrawal, the plan records evidence that A's whitelist holds the full address and
memo on that chain. The agent never adds or changes a whitelist entry.

| Exchange A | Evidence | Pass |
|---|---|---|
| Binance | `call_implicit_get {"exchange":"binance","account":"<A>","method":"sapiGetCapitalWithdrawAddressList"}` (`GET /sapi/v1/capital/withdraw/address/list`, funds-gated) | exactly one row whose `address` equals the recipient character for character (letter case included, also on EVM), `coin: "USDT"`, `network` equal to the outbound id, `addressTag` equal to the memo (`""` for none) and `whiteStatus: true`. A row equal only when case is ignored is not the recipient: hold (verified offline) |
| Gate | `call_implicit_get {"exchange":"gate","account":"<A>","method":"privateWalletGetSavedAddress","params":{"currency":"USDT","chain":"<id>"}}` (`GET /wallet/saved_address`) | exactly one row whose `address` equals the recipient character for character, that `chain`, `tag` equal to the memo and `verified: "1"`; a case-only match holds (verified offline) |
| all others | none in ccxt 4.5.85 (MEXC's `capital/withdraw/address` lists an address book without a whitelist status) | the [setup record](security.md#setup-record) holds alias, full address, memo, chain and the UTC of the operator's 2FA step. The address must equal the recipient character for character, letter case included: an entry that differs only in case holds (verified offline on a Bybit source) |

### Entity lines

The skill sends no travel-rule or recipient data with a withdrawal. Venues that require such
data, or restrict USDT, for some entities therefore need an entity line in the
[setup record](security.md#setup-record). **One rule for every venue below**: the line counts
only when it names the venue's global platform label exactly, gives an ISO 3166-1 alpha-2
jurisdiction that the venue's official page does not list, says "not required", and names its
evidence (the operator's reading of the account profile and withdrawal screen, with UTC). It
holds before any money call when it is missing, names any other or a regional entity (unknown
entities fail closed), has no or an invalid jurisdiction, gives a listed jurisdiction (whatever
the line says: that conflicts with the official page), says "required" or "unknown", or has
no evidence. Where a venue names no entities, "not required" rests on the operator's
evidence alone.

| Venue (side) | Label | Listed jurisdictions (hold) | Official source (read 2026-11-25) |
|---|---|---|---|
| Binance (A) | `Binance.com` | every EU member state (AT, BE, BG, HR, CY, CZ, DK, EE, FI, FR, DE, GR, HU, IE, IT, LV, LT, LU, MT, NL, PL, PT, RO, SK, SI, ES, SE), JP, KZ, NZ, BH, AE, IN, ZA, AU, BR | [withdraw questionnaire](https://developers.binance.com/docs/wallet/travel-rule/withdraw-questionnaire): local entities Japan, Kazakhstan, New Zealand, Bahrain, UAE, India, "EU(Poland,France)" with "For all the EU countries, please following the same questionnaire.", South Africa, Australia, Brazil. They withdraw through `/sapi/v1/localentity/withdraw/apply`, which ccxt 4.5.85 lacks (no `localentity` endpoint) |
| Bybit (A) | `Bybit.com` | KR, IN, TR, KZ, ID, AE | [withdraw](https://bybit-exchange.github.io/docs/v5/asset/withdraw): `beneficiary` "required for kyc/kyb=KOR (Korean), kyc=IND (India) users", sub-fields required for TR, KZ and ID users and address fields for UAE users |
| OKX (A) | `OKX.com` | none named | OKX withdrawal reference: `rcvrInfo` "For the specific entity users to do on-chain withdrawal/lightning withdrawal, this information is required"; no entity is named |
| WhiteBIT (A or B) | `WhiteBIT.com` | the EEA (EU members, IS, LI, NO) and TR | [compliance](https://docs.whitebit.com/institutional/compliance): EEA accounts cannot deposit or withdraw USDT since 2024-12-30; EEA and Turkey deposits can be frozen for the travel rule |

So a Binance account in Italy or Germany holds even if the line says "not required" (verified
offline: Italy, Germany, France, Poland, an unknown entity, a regional entity name, a missing
and a non-ISO jurisdiction all hold; `Binance.com` in a jurisdiction not listed settles). An
account served by a regional entity (for example Bybit EU or OKX TR) holds for API withdrawals;
the manual send in A's UI ([SKILL.md, 2.9](../SKILL.md#29-manual-withdrawal-in-exchange-as-ui))
stays available.

## Amount steps

How ccxt 4.5.85 changes `amount` before sending (verified offline). "Currency" and "network"
are steps from ccxt's currency data; rounding is to nearest (can go up), except Binance,
which rounds down.

| Exchange | `withdraw` | `transfer` |
|---|---|---|
| Binance | network step, down | currency step, down |
| Bybit | unchanged | currency step |
| Gate | currency step, hard-coded `0.0001` in ccxt | same |
| OKX | unchanged | currency step |
| Bitget | network step | unchanged, as a number |
| WhiteBIT | currency step | currency step |
| MEXC | unchanged, as a number; step only from a nonnull `withdrawIntegerMultiple`, otherwise unknown (hold) | unchanged, as a number |
| KuCoin | network step, then as a number | currency step |

ccxt takes the network step from an exchange field: Binance `withdrawIntegerMultiple`, Bybit
`minAccuracy`, OKX `wdTickSz`, Bitget `withdrawMinScale`, KuCoin `withdrawPrecision`; Gate is
hard-coded to `0.0001`, MEXC has none. The currency step is an
explicit field (KuCoin `precision`, WhiteBIT `currency_precision`, Gate `0.0001`), otherwise
the largest step among all USDT networks on that exchange. "Unchanged" does not remove the
exchange's own step: you still need to know it
([SKILL.md, 2.3](../SKILL.md#23-debit-withdraw-amount-and-credit)).

## Withdrawal fee model

The model is **unconfirmed** by default
([SKILL.md, 2.3](../SKILL.md#23-debit-withdraw-amount-and-credit)). What the ccxt 4.5.85 code
shows:

- KuCoin sends `feeDeductType: "INTERNAL"` only with `params.includeFee: true` (verified);
  otherwise the exchange default applies. Do not use `includeFee`;
- OKX without `params.fee` takes the fee from ccxt's currency data (`GET /asset/currencies`,
  merged with the load cache);
- WhiteBIT `flex` is the percentage component.

None of this makes the model confirmed.

## Account mode and available amount

Account test. Read the mode and the available amount with unified methods and
`includeInfo: true`, and quote the field you found in the plan.

| Exchange | Mode from | Available amount from | Deposit / withdrawal wallet (typical, verify) |
|---|---|---|---|
| Binance | `fetchBalance` by `type` (`spot`, `funding`, `linear`); Portfolio Margin from the account UI | raw `fetchBalance` of the right wallet (spot: `balances[].free`) | spot / `walletType` from the plan |
| Bybit | raw `fetchBalance` (UTA or classic) | raw `fetchBalance` `type: unified\|funding` | funding / `accountType` from the plan |
| Gate | raw `fetchBalance` (classic or unified) | raw `fetchBalance` | spot / spot |
| OKX | `fetchAccounts` (raw `acctLv`) | raw `fetchBalance` `type: funding\|trading` | funding / funding |
| Bitget | raw `fetchBalance` (classic or `uta`) | raw `fetchBalance` | spot / spot (`uta` from the plan) |
| WhiteBIT | — | none: `fetchBalance` returns no raw `info` on WhiteBIT and the raw read is a POST (verified offline), so the available field is not visible: hold | main / main |
| MEXC | — | raw `fetchBalance` | spot / spot |
| KuCoin | `fetchAccounts` (classic or UTA) | raw `fetchBalance` | main / main |

If the response lacks the field the exchange documents as available to transfer or withdraw
in that mode, stop. `free` is not such a field.

Typical route: A `transfer` from the trading wallet to the withdrawal wallet → A `withdraw` →
credit in B's deposit wallet → a separate plan in B's session for a B `transfer` to the
trading wallet ([SKILL.md, 2.8](../SKILL.md#28-settlement-on-b)). The deposit wallet column
is typical only; where a deposit actually lands is confirmed in B's session.

`fetchDeposits` and `fetchWithdrawals` exist on all eight exchanges; `fetchTransfers` is
missing on Gate and WhiteBIT, and `fetchLedger` on WhiteBIT and MEXC. Only WhiteBIT has
`certified: false`.

## Transfer proof

How to prove that one `transfer` call succeeded, per exchange. This was verified offline
through ccxt-mcp 0.1.3 with ccxt 4.5.85: real `transfer` and `call_read_method` calls, with
responses mocked in the shape that ccxt's own code comments show
([verification](ccxt-mcp.md#verification)). How the exchanges behave with a real key was not
tested. Every read is a `call_read_method` with `includeInfo: true`, where
`<since>` comes from the pre-dispatch snapshot
([SKILL.md, 2.5](../SKILL.md#25-executing-each-write)). Match the response `id` only against
the field named here; the success value is the raw one (pending and failed values:
[SKILL.md, 2.7](../SKILL.md#27-reconciliation)).

| Exchange | `transfer` result `id` | Result `status` | Proof read | Raw success | Route |
|---|---|---|---|---|---|
| Binance | `tranId` | `null` | `fetchTransfers` `["USDT",<since>,20]`, `params {"type":"<FROM>_<TO>"}`: the wallet ids the transfer sent, e.g. `FUNDING_MAIN` (funding → spot). Without `type`, ccxt asks for `MAIN_UMFUTURE` | `CONFIRMED` | API |
| Bybit | `transferId` (a UUID that ccxt generates and sends) | `ok` only means `retCode 0`, not a transfer status | `fetchTransfers` `["USDT",<since>,20]`, `params {"transferId":"<id>"}` | `SUCCESS` | API |
| OKX | `transId` | `null` | `fetchTransfer` `["<transId>","USDT"]` (`GET /asset/transfer-state`). Not `fetchTransfers`: it reads bills, whose `id` is a `billId`. Not found → every field `null` | `info.state: "success"` | API |
| Bitget classic | `transferId` | `null` | `fetchTransfers` `["USDT",<since>,20]`, `params {"fromAccount":"<plan's fromAccount>"}` (sent as `fromType`). The transfer itself uses `params {"uta":false}`, which is not sent | `Successful` | API |
| Bitget UTA | `transferId` (v3 UTA endpoint) | `null` | none: `fetchTransfers` reads only the classic v2 records | — | operator or manual |
| MEXC | `tranId` | `null` | `fetchTransfers` `["USDT",<since>,20]`, `params {"fromAccountType":"<FROM>","toAccountType":"<TO>"}` (both required, raw `SPOT`/`FUTURES` of the planned direction). Not `fetchTransfer`: it queries `asset/internal/transfer/record` by `transact_id` | `SUCCESS` | API |
| KuCoin | `orderId` | `ok`, filled in by ccxt from the request, not by the exchange | none: `fetchTransfers` reads account ledgers. Each entry has its own ledger `id` and no status; raw `context` may name the `orderId` (format unverified), so it is a candidate only | — | operator or manual |
| Gate | `tx_id` (Gate returns it since API v4.78.0); an empty body gives `null`, and then there is no proof route: operator or manual | `null` | `call_implicit_get {"exchange":"gate","account":"<alias>","method":"privateWalletGetTransfers","params":{"tx_id":"<id>"}}` (`GET /wallet/transfers`, Gate v4.106.113, 2026-08-03). One record with `tx_id`, `currency`, `amount`, `from_account`, `to_account`. `fetchTransfers` itself returns `NOT_SUPPORTED` | `success` (`pending`, `fail`) | API |
| WhiteBIT | none: the response is `[]` | `null` | none: `fetchTransfers` returns `NOT_SUPPORTED` | — | operator or manual |

A record with the right ID counts only with the planned amount and wallets. Other records in
the same read, even with the same amount and direction, are someone else's. "Operator"
means the operator route in [SKILL.md, 2.7](../SKILL.md#27-reconciliation), confirmed before
approval; otherwise the step is done manually in the UI. Withdrawals are proved by their own
`id` in `fetchWithdrawals`. WhiteBIT's withdrawal response is `[]` too, but ccxt generates
`uniqueId`, sends it and returns it as `id` (verified offline), and ccxt parses a history
record's `uniqueId` as its `id`.

## Hyperliquid

Watch-only. Public reads by `walletAddress` or `params.user` work without signing:
`fetchBalance` (perp, USDC), `fetchBalance` with `type: "spot"` and `fetchPositions`. Margin
fields (`marginSummary`, `crossMarginSummary`, `crossMaintenanceMarginUsed`, `withdrawable`)
arrive only with `includeInfo: true`. Before `fetchBalance`, ccxt queries `userAbstraction`.
If it is `unifiedAccount`, spot state without margin fields is read, and margin monitoring
stops. `fetchDepositWithdrawFee` is not supported, and there are no USDT routes.
