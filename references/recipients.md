# Native recipient reads: deposit address and memo from the operator's own account

How the agent reads a verified USDT recipient (address, memo, chain, landing wallet) from the
operator's own exchange account through ccxt-mcp, so nobody copies an address by hand. Used by
[SKILL.md, Scenario 1](../SKILL.md#scenario-1-okx-wallet--exchange-manual-send) and
[Scenario 2](../SKILL.md#scenario-2-exchange-a--exchange-b-semi-automatic). The exchange UI
stays an option the user may choose. It is never a required step on a path marked native below.

All rows were verified offline (ccxt-mcp 0.1.3, ccxt 4.5.85, synthetic keys, `unshare -rn`,
fixture transport; [verification](ccxt-mcp.md#verification)). The fixture responses follow
each venue's API docs and ccxt's parsers. They were not captured live, and no real key was
used. Whether a venue creates an address server-side on a read is not documented anywhere
the skill relies on.

## Status by destination venue

`d` is B's deposit fee and `min` B's deposit minimum ([2.3](../SKILL.md#23-debit-withdraw-amount-and-credit)).
"Native" means the agent reads every recipient field itself. "Hold" means the route needs a
fact that no live field or official source supplies, so the agent stops unless the user chooses
to read that one value in the exchange UI.

| Destination | Recipient read | Key scope and identity | `d` | `min` | Status |
|---|---|---|---|---|---|
| Binance | default row of the address list | `apiRestrictions` flags; `uid` from `/api/v3/account` | 0, [Binance fee page](https://www.binance.com/en/fee/cryptoFee): "Binance does not charge deposit fees." | `depositDust` (ccxt's deposit minimum; Binance does not call it a minimum: basis "assumed") | native |
| Bybit | [SKILL.md flow](../SKILL.md#bybit-deposit-address) | `query-api`: `readOnly`, `permissions`, `userID`, `isMaster` | 0, [Bybit fees page](https://www.bybit.com/en/help-center/article/Bybit-Fees-You-Need-to-Know) | `depositMin` | native |
| OKX | `selected` row | `account/config`: `perm`, `uid`, `label`, `ip` | 0, [OKX help](https://www.okx.com/en-eu/help/do-i-need-to-pay-fees-for-deposit-and-withdrawal): no fee on deposits above the minimum | `minDep` | native |
| Bitget (classic) | single address object | `spot/account/info`: `userId`, `authorities`, `ips` | 0, [Bitget article](https://www.bitget.com/support/articles/12560603820706): "Bitget does not charge any fees for deposits." | `minDepositAmount` | native; UTA: hold |
| BingX | one row per network in the address list | `apiPermissions` (numeric codes), `uid` | 0, [BingX Learn](https://bingx.com/en/learn/how-to-deposit-crypto-with-bingx): "BingX does not charge fees for crypto deposits." (a venue article, not a fee schedule) | `depositMin` (private network data) | native |
| WhiteBIT | address object for the requested network | none in ccxt 4.5.85 | `required.fixedFee` and `required.flexFee` in the same address response | `required.minAmount` | native except the contract: hold |
| KuCoin (classic) | v3 address list | `user/api-key`: `permission`, `uid`, `isMaster` | unknown: KuCoin pages disagree (a free-quota rule with 0.1 % above it, and general no-fee pages) | `depositMinSize` (`null` = unknown) | address native; `d` hold unless a live fee field is nonnull |
| MEXC | address list rows for the network | `account`: `canWithdraw`, `permissions`; `uid` | unknown: no official statement found | no API field | address native; `d` and `min` hold |
| Gate | `multichain_addresses` row | `account/detail`: `user_id`, `ip_whitelist` (no permission fields) | no source verified here | no API field | address native; API withdrawals to Gate never; `min` hold |

Fee and policy pages were checked on 2026-11-25. The sheet or plan names the page as the source
of `d`. A live field or a page the user chose to check that shows another value makes `d`
unknown, and a credit that differs from the expected `C` holds the route
([2.7](../SKILL.md#27-reconciliation)).

## Common procedure

Use one alias with `"funds": "live"` and a deposit-only key (read permission only) for every
read. ccxt-mcp gates address methods (`/deposit.?address|withdraw.?address|withdrawal.?whitelist/i`)
behind `funds` in both `call_read_method` and `call_implicit_get`. `dryRun` does not stop
reads. Never call `get_deposit_address`: on KuCoin, MEXC and WhiteBIT it falls back to
`createDepositAddress` (verified offline). Use only the calls in the venue rows.

1. **Network data** for the venue ([network data sources](exchanges.md#network-data-sources)):
   deposit enabled, minimum, contract, memo-required flag, and any deposit-fee field.
2. **Key check**: the venue's key-metadata read. For a deposit-only profile, require the
   read-only scope in the venue row and no withdrawal right. Report the account identifier.
   The operator confirms it **once** at setup against the exchange's API-management page.
   After that, every chat compares it with the value recorded at setup in the operation
   record. A changed identifier is a stop.
3. **Recipient read**: the calls in the venue row. Where the venue has a raw GET, that raw
   row is the address source. ccxt indexes addresses by network and keeps only the last one,
   so duplicates disappear from normalized reads (verified offline on Bybit, OKX, Gate, BingX,
   MEXC and KuCoin). The raw response must contain **exactly one** eligible row for the
   chosen chain. Its address, memo and chain must equal the normalized read where the row
   lists one.
4. **Show** the address and the memo (or `none`) each in its own code block, copied
   character for character from the source row, with
   `<venue> UID <id>, alias <alias>, read <UTC>, chain <venue chain id>, lands in <wallet or unknown>`.

Hold on any of these: an empty result (these tools cannot and must not create an address,
so the operator creates one in the exchange and the agent reads again), several eligible rows,
a wrong chain, an address that is not valid for the chain (EVM: `0x` plus 40 hex; Tron: `T…`,
34 characters; TON: 48-character user-friendly form), a contract that does not match the
[reference contract](../SKILL.md#chains), a missing, `null` or non-string memo where the
network requires one, or any field that differs between the reads. Repeat step 3 just before
OPEN or before the withdrawal; any change needs a new sheet or plan.

## Binance

| Step | Call | Check |
|---|---|---|
| network data | `call_read_method {"exchange":"binance","account":"<alias>","method":"fetchDepositWithdrawFee","args":["USDT"],"includeInfo":true}` | `info.networkList[]`: `network` (`BSC`, `TRX`, `ETH`, `TON`), `depositEnable`, `depositDust`, `contractAddress`, `sameAddress` |
| key check | `call_implicit_get {"exchange":"binance","account":"<alias>","method":"sapiGetAccountApiRestrictions"}` | `enableReading: true`, `ipRestrict: true`; deposit-only: `enableWithdrawals: false`, `enableInternalTransfer: false`; `permitsUniversalTransfer` only when B will run a settlement transfer |
| identity | `call_implicit_get {"exchange":"binance","account":"<alias>","method":"privateGetAccount","params":{"omitZeroBalances":true}}` | report `uid` |
| gated read | `call_read_method {"exchange":"binance","account":"<alias>","method":"fetchDepositAddress","args":["USDT"],"params":{"network":"<code>"},"includeInfo":true}` | sends only `GET /sapi/v1/capital/deposit/address` with `network=<id>`; unified `network` (derived by ccxt from the explorer `url`) must be the chosen code |
| raw read | `call_implicit_get {"exchange":"binance","account":"<alias>","method":"sapiGetCapitalDepositAddressList","params":{"coin":"USDT","network":"<id>"}}` | exactly one row with `isDefault: 1`; its `address` and `tag` equal the gated `info` |

- Memo: raw `tag`; `""` means none. Binance publishes no memo-required flag, so the address
  row is the evidence ("no published flag").
- Rows with `isDefault: 0` are older addresses of the account and are not eligible. Two rows
  with `isDefault: 1`: hold. Binance's docs say the list's `coin` can name the address space
  (`ETH` for EVM), so do not compare it.
- An explorer `url` for another chain changes the unified `network` (an `etherscan.io` URL
  gave `ERC20` for a `BEP20` request, verified offline): hold.
- Landing wallet: the response has none. Binance's typical deposit wallet is Spot
  ([account mode table](exchanges.md#account-mode-and-available-amount)); in a two-profile
  session the agent locates the credit by reading both wallets (2.8).
- Hard limitation: the `uid` field and the list endpoint shape follow Binance's docs and were
  checked only on fixtures.

## Bybit

[SKILL.md, Bybit deposit address](../SKILL.md#bybit-deposit-address) holds the full flow. The raw
`privateGetV5AssetDepositQueryAddress` does not match ccxt-mcp's gate pattern, so always run the
gated `fetchDepositAddressesByNetwork` first on the same `funds` alias.

## OKX

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
  for both reads; empty `data` → gated read `InvalidAddress`, raw `data: []`; a row for
  another chain only → `InvalidAddress`; key rejection `50120` → `EXCHANGE_ERROR` (not
  `AUTH_FAILED`); only GET requests.

## Bitget

| Step | Call | Check |
|---|---|---|
| network data | `call_read_method {"exchange":"bitget","account":"<alias>","method":"fetchDepositWithdrawFee","args":["USDT"],"includeInfo":true}` (also works without a key) | `info.chains[]`: `chain`, `rechargeable`, `minDepositAmount`, `contractAddress`, `needTag` |
| key check | `call_implicit_get {"exchange":"bitget","account":"<alias>","method":"privateSpotGetV2SpotAccountInfo"}` | report `userId`, `authorities`, `ips`, `parentId`; deposit-only: no authority naming withdrawal. Other values are compared once with Bitget's API page |
| gated read | `call_read_method {"exchange":"bitget","account":"<alias>","method":"fetchDepositAddress","args":["USDT"],"params":{"network":"<code>"},"includeInfo":true}` | classic account: `GET /api/v2/spot/wallet/deposit-address?coin=USDT&chain=<id>` |
| raw read | `call_implicit_get {"exchange":"bitget","account":"<alias>","method":"privateSpotGetV2SpotWalletDepositAddress","params":{"coin":"USDT","chain":"<id>"}}` | `code: "00000"`; `data.chain` is the chosen id; `address` nonempty; `tag` a string; equal to the gated `info` |

- Memo: `tag`; `needTag` in the network data is the published flag.
- The endpoint returns one object, so it cannot show duplicates. An empty `data` returned
  `ok: true` with no address in the gated read (verified offline): hold on an empty address.
- Bitget UTA uses `privateUtaGetV3AccountDepositAddress`, which was not verified: hold, or the
  user chooses the UI.
- Landing wallet: not in the response; typical Spot.

## BingX

| Step | Call | Check |
|---|---|---|
| network data | `call_read_method {"exchange":"bingx","account":"<alias>","method":"fetchDepositWithdrawFee","args":["USDT"],"includeInfo":true}` (public response is `null`) | `info.networkList[]`: `network`, `depositEnable`, `depositMin`, `contractAddress`, `needTagOrMemo` |
| key check | `call_implicit_get {"exchange":"bingx","account":"<alias>","method":"accountV1PrivateGetAccountApiPermissions"}` | report `permissions` (numeric codes), `ipAddresses`, `note`; the operator confirms once what the codes mean on BingX's API page |
| identity | `call_implicit_get {"exchange":"bingx","account":"<alias>","method":"accountV1PrivateGetUid"}` | report `data.uid` |
| raw read | `call_implicit_get {"exchange":"bingx","account":"<alias>","method":"walletsV1PrivateGetCapitalDepositAddress","params":{"coin":"USDT","offset":0,"limit":1000}}` | rows in `data.data[]` with `network` equal to the chosen id: exactly one; address = `addressWithPrefix` if nonempty, else `address`; EVM addresses must already carry `0x` in the raw row |
| gated read | `call_read_method {"exchange":"bingx","account":"<alias>","method":"fetchDepositAddress","args":["USDT"],"params":{"network":"<code>"},"includeInfo":true}` | same request; unified `address` must equal the raw address exactly |

- ccxt adds `0x` to an unprefixed EVM address itself (verified offline). A raw row without the
  prefix therefore differs from the unified value: hold.
- Memo: `tag`; `needTagOrMemo` is the published flag.
- `walletType` is recorded as given; its meaning was not verified here, so the credit is
  located by reading B's wallets (2.8).
- An empty list gave `ok: true` with `data: null` in the gated read (verified offline): hold.
- BingX is native as a destination only. BingX outbound stays manual (no verified withdraw
  mapping; [outbound table](exchanges.md#outbound-withdraw)).

## WhiteBIT

| Step | Call | Check |
|---|---|---|
| network data | `call_read_method {"exchange":"whitebit","account":"<alias>","method":"fetchDepositWithdrawFee","args":["USDT"],"includeInfo":true}` (also works without a key) | `info["USDT (<NET>)"]`: `is_depositable`, `is_api_depositable`, `deposit.min_amount`; **no contract** |
| recipient read | `call_read_method {"exchange":"whitebit","account":"<alias>","method":"fetchDepositAddress","args":["USDT"],"params":{"network":"<NET>"},"includeInfo":true}` | sends a signed `POST /api/v4/main-account/address` with `ticker` and `network` (WhiteBIT's read is a POST); `info.account.address`, `info.account.memo`, `info.required.minAmount`, `fixedFee`, `flexFee` |

- There is no raw GET for this read (`call_implicit_get` refuses POST endpoints), so the gated
  normalized read is the source. The response does not name a chain: the chain is bound only
  by the request's `network` and the address-format check. A Tron address answered to a `BEP20`
  request was not detectable by ccxt (verified offline); the format check catches it.
- WhiteBIT publishes no USDT contract in the API. Hard limitation: the route holds until the
  user reads the contract on WhiteBIT's deposit page for that network.
- No key-metadata or UID read exists in ccxt 4.5.85, so only the operator's setup check
  stands behind the alias.
- `required.minAmount` is `min`; `fixedFee` plus the `flexFee` percentage (bounded by its
  `minFee` and `maxFee`) is `d`. If `required` is missing, hold.
- The response is a single object; duplicates cannot appear.

## MEXC

| Step | Call | Check |
|---|---|---|
| network data | `call_read_method {"exchange":"mexc","account":"<alias>","method":"fetchDepositWithdrawFee","args":["USDT"],"includeInfo":true}` | `info.networkList[]`: `network` (long id), `netWork` (short id), `depositEnable`, `contract`; no deposit minimum |
| key check | `call_implicit_get {"exchange":"mexc","account":"<alias>","method":"spotPrivateGetAccount"}` | deposit-only: `canWithdraw: false`; report `permissions`, `canTrade` |
| identity | `call_implicit_get {"exchange":"mexc","account":"<alias>","method":"spotPrivateGetUid"}` | report `uid` |
| raw read | `call_implicit_get {"exchange":"mexc","account":"<alias>","method":"spotPrivateGetCapitalDepositAddress","params":{"coin":"USDT","network":"<network from the network data>"}}` | rows with that `network`: exactly one; `netWork` is `BSC` / `TRX` / `ETH` / `TONCOIN`; memo in `memo` |
| gated read | `call_read_method {"exchange":"mexc","account":"<alias>","method":"fetchDepositAddress","args":["USDT"],"params":{"network":"<code>"},"includeInfo":true}` | equal to the raw row |

- A `TON` row without a `memo` field: hold. A missing `memo` on a non-memo chain means none.
- Hard limitation: MEXC supplies no deposit minimum by API and no official deposit-fee
  statement was found, so both hold unless the user reads them on MEXC's deposit page.
- An outdated long id in `netWork` (for example `BNB Smart Chain(BEP20)`) made the gated read
  fail (verified offline): hold.

## KuCoin

| Step | Call | Check |
|---|---|---|
| network data | `call_implicit_get {"exchange":"kucoin","method":"publicGetCurrenciesCurrency","params":{"currency":"USDT"}}` | `data.chains[]`: `chainId`, `isDepositEnabled`, `depositMinSize`, `contractAddress`, `needTag`, `depositFeeRate`, `depositTierFee` |
| key check | `call_implicit_get {"exchange":"kucoin","account":"<alias>","method":"privateGetUserApiKey"}` | deposit-only: `permission` is `General` with no `Withdrawal`; report `uid`, `isMaster`, `ipWhitelist`, `remark` (the server redacts `apiKey`) |
| raw read | `call_implicit_get {"exchange":"kucoin","account":"<alias>","method":"privateGetDepositAddresses","params":{"currency":"USDT","chain":"<chainId>","version":"v3"}}` | sends only `GET /api/v3/deposit-addresses`; rows with `chainId` equal to the chosen id: exactly one; full `contractAddress` equals the reference; memo in `memo` |

- ccxt's `fetchDepositAddress` uses KuCoin's v1 endpoint, which KuCoin lists as abandoned
  ([docs](https://www.kucoin.com/docs-new/abandoned-endpoints/account-funding/get-deposit-addresses-v1)).
  Do not use it. The raw name matches ccxt-mcp's gate, so the v3 read alone is funds-gated
  (`TIER_DISABLED` without `funds`, verified offline).
- `to` is the landing wallet (`MAIN` or `TRADE`). Record it as `Lands in`.
- Hard limitation: `d` holds unless `depositFeeRate` or `depositTierFee` is nonnull and
  KuCoin's quota state is shown for the account. KuCoin UTA accounts were not verified: hold.

## Gate

| Step | Call | Check |
|---|---|---|
| network data | `call_implicit_get {"exchange":"gate","method":"publicWalletGetCurrencyChains","params":{"currency":"USDT"}}` | `chain`, `is_deposit_disabled`, `contract_address`, `is_tag`; **no deposit minimum** |
| key check | `call_implicit_get {"exchange":"gate","account":"<alias>","method":"privateAccountGetDetail"}` | report `user_id`, `ip_whitelist`, `key.mode`; the read has no permission fields, so the key scope rests on the operator's setup check |
| raw read | `call_implicit_get {"exchange":"gate","account":"<alias>","method":"privateWalletGetDepositAddress","params":{"currency":"USDT"}}` | in `multichain_addresses`: exactly one row with the chosen `chain`, `obtain_failed: 0`; memo in `payment_id` |
| gated read | `call_read_method {"exchange":"gate","account":"<alias>","method":"fetchDepositAddress","args":["USDT"],"params":{"network":"<code>"},"includeInfo":true}` | equal to the raw row when it succeeds |

- ccxt validates every entry of `multichain_addresses`. One entry with `obtain_failed: 1`
  made the gated read fail for every chain (verified offline). The raw read is itself
  funds-gated, so it then stands alone as the source.
- Hard limitation: Gate's deposit minimum is not in any Gate API the skill uses. The agent
  never calls `withdraw` to Gate ([Gate as recipient](exchanges.md#gate-as-recipient-manual-only)).
  A send to Gate holds until the user reads the minimum on Gate's deposit page.

## Hyperliquid

Watch-only. A profile has only `walletAddress`, no `funds`, so every address method returns
`TIER_DISABLED` and the funds tools are not listed (verified offline). Hyperliquid is never a
USDT recipient or source.
