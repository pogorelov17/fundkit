# Native recipient reads: deposit address and memo from the operator's own account

How the agent reads a verified USDT recipient (address, memo, chain, landing wallet) from the
operator's own exchange account through ccxt-mcp, so nobody copies an address by hand. Used by
[SKILL.md, Scenario 1](../SKILL.md#scenario-1-okx-wallet--exchange-manual-send) and
[Scenario 2](../SKILL.md#scenario-2-exchange-a--exchange-b-semi-automatic). The exchange UI
stays an option the user may choose. It is never a required step on a path marked native below.

Every row was exercised offline only: ccxt-mcp 0.1.3 and ccxt 4.5.85, synthetic keys, `unshare -rn`
and a fixture transport ([verification](ccxt-mcp.md#verification)). The fixture responses follow
each venue's published API reference and ccxt's parsers. None was captured from a live account, and
no real key was used. Readiness for a real account is not established by these tests.

## Status by destination venue

`d` is B's deposit fee and `min` B's deposit minimum ([2.3](../SKILL.md#23-debit-withdraw-amount-and-credit)).
"Native" means the agent reads every recipient field itself. "Hold" means the route needs a fact
that no live field or official source supplies, so the agent stops. The user may still choose to
read that one value in the exchange UI. A field counts only if the venue documents it, or if the
live field's own name states its meaning (basis "live field"). The agent never derives a field
from another field or from the address format.

| Destination | Recipient read | Key scope and identity | `d` | `min` | Status |
|---|---|---|---|---|---|
| Bybit | [SKILL.md flow](../SKILL.md#bybit-deposit-address) | `query-api`: `readOnly`, `permissions`, `userID`, `isMaster` | 0, [Bybit fees page](https://www.bybit.com/en/help-center/article/Bybit-Fees-You-Need-to-Know) | `depositMin` | native; `batchReleaseLimit` must be `"-1"` ([cap](#bybit-inbound-cap)) |
| OKX | `selected` row | `account/config`: `perm`, `uid`, `label`, `ip` | 0, [OKX help](https://www.okx.com/en-eu/help/do-i-need-to-pay-fees-for-deposit-and-withdrawal): no fee on deposits above the minimum | `minDep` from the raw currency rows | native |
| Bitget (classic) | single address object | `spot/account/info`: `userId`, `authorities`, `ips` | 0, [Bitget article](https://www.bitget.com/support/articles/12560603820706): "Bitget does not charge any fees for deposits." | `minDepositAmount` | native; UTA: hold |
| BingX | one row per network in the address list | `apiPermissions` (numeric codes), `uid` | 0, [BingX Learn](https://bingx.com/en/learn/how-to-deposit-crypto-with-bingx): "BingX does not charge fees for crypto deposits." (a venue article, not a fee schedule) | `depositMin` (basis "live field": it is not in BingX's [published wallet reference](https://github.com/bingx-api/api-ai-skills/blob/d40bcc6ab6e91ad7c2d801250425c2a973d2f95a/skills/spot-wallet/api-reference.md)) | native; deposit credit only on raw status `6` |
| Binance | default row of the address list | `apiRestrictions` flags; `uid` from `/api/v3/account` | 0, [Binance fee page](https://www.binance.com/en/fee/cryptoFee): "Binance does not charge deposit fees." | `depositDust` is not described in Binance's reference (only an example value), so it is not a minimum | address native; `min` hold |
| MEXC | address list rows for the network | `account`: `canWithdraw`, `permissions`; `uid` | 0, [MEXC Learn, 2026-10-20](https://www.mexc.com/learn/article/mexc-fees-explained-complete-trading-futures-withdrawal-fees-guide/1): "MEXC does not charge to receive crypto deposits" (a venue article, not a fee schedule) | no API field; `depositTips` is free text | address native; `min` hold |
| KuCoin (classic) | v3 address list | `user/api-key`: `permission`, `uid`, `isMaster` | unknown: KuCoin's v3 currency schema has no deposit-fee field, no read shows a remaining free quota, and KuCoin's pages disagree | `depositMinSize` (`null` = unknown) | address native; `d` hold; UTA: hold |
| WhiteBIT | address object for the requested network (may provision, [below](#provisioning-reads)) | none in ccxt 4.5.85 | `required.fixedFee` and `required.flexFee` in the same response | `required.minAmount` | contract hold, in both directions ([WhiteBIT](#whitebit)) |
| Gate | `multichain_addresses` row (may provision, [below](#provisioning-reads)) | `account/detail`: `user_id`, `ip_whitelist` (no permission fields) | no source verified | top-level `min_deposit_amount` counts only when the response lists the chosen chain alone ([Gate](#gate)) | address native; `min` and `d` hold |

Fee and policy pages were checked on 2026-11-25. The sheet or plan names the page as the source of
`d`. If a live field, or a page the user chose to check, shows another value, `d` is unknown. A
credit that differs from the expected `C` holds the route ([2.7](../SKILL.md#27-reconciliation)).

## Common procedure

Use one alias with `"funds": "live"` and a deposit-only key (read permission only) for every
read. ccxt-mcp gates address methods (`/deposit.?address|withdraw.?address|withdrawal.?whitelist/i`)
behind `funds` in both `call_read_method` and `call_implicit_get`. `dryRun` does not stop reads.

**Never call `get_deposit_address`.** When `fetchDepositAddress` fails, it falls back to
`createDepositAddress` on its own (KuCoin, MEXC, WhiteBIT; verified offline). It does that without
a confirmation form and even on a `dryRun` account. Use only the calls in the venue rows. If the
read finds no address, the operator creates one once in the exchange app, and the agent reads again.

1. **Network data** for the venue ([network data sources](exchanges.md#network-data-sources)):
   deposit enabled, minimum, contract, memo-required flag, and any deposit-fee field.
2. **Key check**: the venue's key-metadata read. For a deposit-only profile, require the
   read-only scope in the venue row and no withdrawal right. Report the account identifier and
   compare it with the [setup record](security.md#setup-record). A changed identifier is a stop.
3. **Recipient read**: the calls in the venue row. Where the venue has a raw GET, that raw
   row is the address source. ccxt indexes addresses by network and keeps only the last one,
   so duplicates disappear from normalized reads (verified offline on Bybit, OKX, Gate, BingX,
   MEXC and KuCoin). The raw response must contain **exactly one** eligible row for the
   chosen chain and no row for another chain. Its address, memo and chain must equal the
   normalized read where the row lists one.
4. **Address check** ([below](#address-checks)) and memo check.
5. **Show** the address and the memo (or `none`) each in its own code block, copied
   character for character from the source row, with
   `<venue> UID <id>, alias <alias>, read <UTC>, chain <venue chain id>, lands in <wallet or unknown>`.

Hold on any of these: an empty result, several eligible rows, a row for the wrong chain, a failed
[address check](#address-checks), a contract that does not match the
[reference contract](../SKILL.md#chains), a missing, `null` or non-string memo where the network
requires one or the venue returns the field, or any field that differs between the reads. Repeat
step 3 just before OPEN or before the withdrawal. Any change needs a new sheet or plan.

### Address checks

- **EVM** (`BEP20`, `ERC20`): `0x` followed by exactly 40 hex characters. The format does not
  show which EVM chain the address belongs to. The chain comes only from the venue's raw row
  (or, on WhiteBIT, from the request: [WhiteBIT](#whitebit)), never from the address.
- **Tron**: `T` followed by 33 base58 characters.
- **TON**: the 48-character user-friendly form, base64url (or base64). It decodes to 36 bytes:
  a tag byte, a workchain byte, a 32-byte account id and a CRC16-XMODEM checksum (big-endian)
  over the first 34 bytes. Require a tag byte of `0x11` (bounceable) or `0x51` (non-bounceable),
  workchain `0x00`, and a matching checksum. A tag byte with `0x80` set is a testnet address.
  Workchain `0xff` is the masterchain. Hold on either.

  The agent cannot compute a CRC by reading. It runs exactly this command, which reads only its
  argument and prints `OK` or `FAIL`. This is the only program the skill lets the agent run
  ([rule 1](../SKILL.md#hard-rules)). Any other output, an error included, counts as `FAIL`:

  ```bash
  python3 -I -c '
  import base64, sys
  a = sys.argv[1]; r = base64.urlsafe_b64decode(a) if len(a) == 48 else b""; c = 0
  for x in r[:34]:
      c ^= x << 8
      for _ in range(8): c = ((c << 1) ^ 0x1021) & 0xffff if c & 0x8000 else (c << 1) & 0xffff
  print("OK" if len(r) == 36 and r[0] in (0x11, 0x51) and r[1] == 0 and c == int.from_bytes(r[34:], "big") else "FAIL")
  ' '<address>'
  ```

  | Example | Result |
  |---|---|
  | `EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs` (USDT master, bounceable) | `OK` |
  | `UQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_p0p` (same account, non-bounceable) | `OK` |
  | `EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDt` (last character changed) | `FAIL`: checksum |
  | `kQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_ntm` (testnet tag `0x91`) | `FAIL`: testnet |
  | `Ef-xE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_j-k` (workchain −1) | `FAIL`: masterchain |

  These are format checks only. The address must still come from the raw row, and it must be the
  deposit address, never the jetton master above.

### Provisioning reads

Two venues document their address read as one that can create an address:

- **Gate**: its API reference titles `GET /wallet/deposit_address` "Generate currency deposit
  address".
- **WhiteBIT**: its [reference](https://docs.whitebit.com/api-reference/account-wallet/get-cryptocurrency-deposit-address)
  says the endpoint "creates the address when none exists".

These reads move no funds and only create a deposit address in the operator's own account. The
agent sends them only when the [setup record](security.md#setup-record) says
`provisioning: allowed` for that alias. Without it, the agent holds the route and sends nothing.
Every other venue row here is a plain GET. Whether those venues create an address server-side on
a read is not documented.

## Binance

| Step | Call | Check |
|---|---|---|
| network data | `call_read_method {"exchange":"binance","account":"<alias>","method":"fetchDepositWithdrawFee","args":["USDT"],"includeInfo":true}` | `info.networkList[]`: `network` (`BSC`, `TRX`, `ETH`, `TON`), `depositEnable`, `contractAddress`, `withdrawTag` |
| key check | `call_implicit_get {"exchange":"binance","account":"<alias>","method":"sapiGetAccountApiRestrictions"}` | `enableReading: true`, `ipRestrict: true`; deposit-only: `enableWithdrawals: false`, `enableInternalTransfer: false`; `permitsUniversalTransfer` only when B will run a settlement transfer |
| identity | `call_implicit_get {"exchange":"binance","account":"<alias>","method":"privateGetAccount","params":{"omitZeroBalances":true}}` | report `uid` |
| gated read | `call_read_method {"exchange":"binance","account":"<alias>","method":"fetchDepositAddress","args":["USDT"],"params":{"network":"<code>"},"includeInfo":true}` | sends only `GET /sapi/v1/capital/deposit/address` with `network=<id>`; unified `network` (derived by ccxt from the explorer `url`) must be the chosen code |
| raw read | `call_implicit_get {"exchange":"binance","account":"<alias>","method":"sapiGetCapitalDepositAddressList","params":{"coin":"USDT","network":"<id>"}}` | exactly one row with `isDefault: 1`; its `address` and `tag` equal the gated `info` |

- Memo: raw `tag`, where `""` means none. Binance publishes no deposit memo flag (`withdrawTag` is
  about withdrawals from Binance), so the address row is the evidence ("no published flag").
- Rows with `isDefault: 0` are older addresses of the account and are not eligible. Two rows
  with `isDefault: 1`: hold. Binance's docs say the list's `coin` can name the address space
  (`ETH` for EVM), so do not compare it.
- An explorer `url` for another chain changes the unified `network` (an `etherscan.io` URL
  gave `ERC20` for a `BEP20` request, verified offline): hold.
- **Minimum.** ccxt 4.5.85 maps `depositDust` to the deposit minimum. Binance's reference shows
  that field only as an example value and does not say what it means (`withdrawMin` and the
  other fields are named for what they are). The route holds on `min` unless the user reads the
  minimum on Binance's deposit page.
- Landing wallet: the response has none. Binance's typical deposit wallet is Spot
  ([account mode table](exchanges.md#account-mode-and-available-amount)). In a two-profile
  session the agent locates the credit by reading the wallets (2.8).

## Bybit

[SKILL.md, Bybit deposit address](../SKILL.md#bybit-deposit-address) holds the full flow. The raw
`privateGetV5AssetDepositQueryAddress` does not match ccxt-mcp's gate pattern, so always run the
gated `fetchDepositAddressesByNetwork` first on the same `funds` alias.

### Bybit inbound cap

Bybit's raw row carries `batchReleaseLimit`, its documented cap on credited deposits for the chain
(`"-1"` means unlimited). The cap applies to every send to Bybit: OKX Wallet (Scenario 1), an API
withdrawal from exchange A (Scenario 2) and a manual withdrawal in A's UI (2.9). Only `"-1"`
qualifies without more evidence. A finite limit requires the remaining allowance for the period,
after releases of older pending deposits against the same cap. No Bybit read in ccxt 4.5.85 shows
that allowance, so a finite, missing or malformed limit holds the plan or sheet. Repeat the check
in the recheck before OPEN. A changed limit needs a new plan or sheet.

## OKX

| Step | Call | Check |
|---|---|---|
| network data | `call_implicit_get {"exchange":"okx","account":"<alias>","method":"privateGetAssetCurrencies","params":{"ccy":"USDT"}}` | one raw row per chain: `chain` `USDT-TRC20`/`USDT-BSC`/`USDT-ERC20`/`USDT-TON`, `canDep`, `canWd`, `minDep`, `minWd`, `fee`, `wdTickSz`, `ctAddr`, `needTag`. Do not use `fetchDepositWithdrawFee` for OKX: its `info` keeps only one row (the last chain), verified offline |
| key check | `call_implicit_get {"exchange":"okx","account":"<alias>","method":"privateGetAccountConfig"}` | `data[0].perm` exactly `read_only` for a deposit-only key; report `uid`, `mainUid`, `label`, `ip` |
| gated read | `call_read_method {"exchange":"okx","account":"<alias>","method":"fetchDepositAddress","args":["USDT"],"params":{"network":"<code>"},"includeInfo":true}` | sends only `GET /api/v5/asset/deposit-address?ccy=USDT`; ccxt keeps only `selected: true` rows and one per network |
| raw read | `call_implicit_get {"exchange":"okx","account":"<alias>","method":"privateGetAssetDepositAddress","params":{"ccy":"USDT"}}` | `code: "0"`; exactly one row with the chosen `chain` and `selected: true`; equal `addr`, memo and `chain` to the gated `info` |

- Memo: OKX returns `tag`, `memo` or `pmtId`, or `addrEx` (TON: `addrEx.comment`). Use the
  field the raw row carries, exactly as a string. If `needTag` is true and no memo field is
  present, hold.
- `ctAddr` in the address row is a contract suffix. It must match the end of the reference
  contract, and the currency row's full `ctAddr` must equal it.
- `to` is the landing wallet: `6` funding, `18` trading. Record it as `Lands in`.
- Rows with `selected: false` are other addresses of the account and are not eligible.
  Two `selected: true` rows for one chain: ccxt silently kept the last one, so hold.
- Offline results: no key gives `AUTH_FAILED requires "apiKey" credential`, and no passphrase
  gives `requires "password" credential`, with nothing sent. A profile without `funds` gets
  `TIER_DISABLED` for both reads. Empty `data` makes the gated read fail with `InvalidAddress`
  and leaves the raw `data: []`. Key rejection `50120` comes back as `EXCHANGE_ERROR` (not
  `AUTH_FAILED`).

## Bitget

| Step | Call | Check |
|---|---|---|
| network data | `call_read_method {"exchange":"bitget","account":"<alias>","method":"fetchDepositWithdrawFee","args":["USDT"],"includeInfo":true}` (also works without a key) | `info.chains[]`: `chain`, `rechargeable`, `minDepositAmount`, `contractAddress`, `needTag` |
| key check | `call_implicit_get {"exchange":"bitget","account":"<alias>","method":"privateSpotGetV2SpotAccountInfo"}` | report `userId`, `authorities`, `ips`, `parentId`; deposit-only: no authority naming withdrawal. Other values are compared once with Bitget's API page |
| gated read | `call_read_method {"exchange":"bitget","account":"<alias>","method":"fetchDepositAddress","args":["USDT"],"params":{"network":"<code>"},"includeInfo":true}` | classic account: `GET /api/v2/spot/wallet/deposit-address?coin=USDT&chain=<id>` |
| raw read | `call_implicit_get {"exchange":"bitget","account":"<alias>","method":"privateSpotGetV2SpotWalletDepositAddress","params":{"coin":"USDT","chain":"<id>"}}` | `code: "00000"`; `data.chain` is the chosen id; `address` nonempty; `tag` a string; equal to the gated `info` |

- Memo: `tag`. `needTag` in the network data is the published flag.
- The endpoint returns one object, so it cannot show duplicates. An empty `data` returned
  `ok: true` with no address in the gated read (verified offline): hold on an empty address.
- Bitget UTA uses `privateUtaGetV3AccountDepositAddress`, which was not verified: hold, or the
  user chooses the UI.
- Landing wallet: not in the response; typically Spot.

## BingX

| Step | Call | Check |
|---|---|---|
| network data | `call_read_method {"exchange":"bingx","account":"<alias>","method":"fetchDepositWithdrawFee","args":["USDT"],"includeInfo":true}` (public response is `null`) | `info["<code>"].info`: `network`, `depositEnable`, `withdrawEnable`, `depositMin`, `withdrawFee`, `withdrawMin`, `withdrawPrecision`, `contractAddress`, `needTagOrMemo` |
| key check | `call_implicit_get {"exchange":"bingx","account":"<alias>","method":"accountV1PrivateGetAccountApiPermissions"}` | report `permissions` (numeric codes), `ipAddresses`, `note`. The operator records once in the [setup record](security.md#setup-record) what the codes mean on BingX's API page |
| identity | `call_implicit_get {"exchange":"bingx","account":"<alias>","method":"accountV1PrivateGetUid"}` | report `data.uid` |
| raw read | `call_implicit_get {"exchange":"bingx","account":"<alias>","method":"walletsV1PrivateGetCapitalDepositAddress","params":{"coin":"USDT","offset":0,"limit":1000}}` | rows in `data.data[]` with `network` equal to the chosen id: exactly one. The address is `addressWithPrefix` if nonempty, else `address`. EVM addresses must already carry `0x` in the raw row |
| gated read | `call_read_method {"exchange":"bingx","account":"<alias>","method":"fetchDepositAddress","args":["USDT"],"params":{"network":"<code>"},"includeInfo":true}` | same request; the unified `address` must equal the raw address exactly |

- ccxt adds `0x` to an unprefixed EVM address itself (verified offline). A raw row without the
  prefix therefore differs from the unified value: hold.
- Memo: `tag`. `needTagOrMemo` is the published flag.
- **Deposit status.** BingX's reference defines deposit status `0` in progress, `1` not credited,
  `2` wrong amount and `6` confirmed. ccxt 4.5.85 maps raw `1` to unified `ok`. Count a BingX
  deposit only on raw `info.status` `6` (verified offline: raw `1` holds).
- An empty list gave `ok: true` with `data: null` in the gated read (verified offline): hold.
- BingX outbound (BingX as A) is an API route now: [outbound table](exchanges.md#outbound-withdraw).

## WhiteBIT

| Step | Call | Check |
|---|---|---|
| network data | `call_implicit_get {"exchange":"whitebit","method":"v4PublicGetFee"}` and `call_implicit_get {"exchange":"whitebit","method":"v4PublicGetAssets"}` | fee: `"USDT (<NET>)"` with `is_depositable`, `is_api_depositable`, `is_withdrawal`, `is_api_withdrawal`, `withdraw.min_amount`, `withdraw.fixed`, `withdraw.flex`; assets: `USDT.currency_precision`, `limits.deposit.<NET>.min`, `is_memo`; **no contract** in either |
| recipient read | `call_read_method {"exchange":"whitebit","account":"<alias>","method":"fetchDepositAddress","args":["USDT"],"params":{"network":"<NET>"},"includeInfo":true}` | only with `provisioning: allowed` ([above](#provisioning-reads)); sends a signed `POST /api/v4/main-account/address` with `ticker` and `network`; `info.account.address`, `info.account.memo`, `info.required.minAmount`, `fixedFee`, `flexFee` |

- WhiteBIT signs every private read as a POST, and `call_implicit_get` refuses POST endpoints. So
  the gated normalized read is the source. The response does not name a chain. The request's
  `network` is the only chain evidence, and the address format cannot replace it: an EVM address
  looks the same on BSC and Ethereum.
- **Contract: hold in both directions.** No WhiteBIT API (assets, fee, address) publishes a token
  contract, and no official WhiteBIT page with the USDT contract per network was verified here.
  The chain and contract therefore stay unverified. Routes to and from WhiteBIT hold until the
  user reads the contract on WhiteBIT's deposit or withdrawal page for that network.
- No key-metadata or UID read exists in ccxt 4.5.85, so only the operator's setup record stands
  behind the alias and its scope.
- `required.minAmount` is `min`. `fixedFee` plus the `flexFee` percentage (bounded by its
  `minFee` and `maxFee`) is `d`. WhiteBIT says a deposit below the minimum is recorded as
  uncredited and canceled after 7 days if it stays below. If `required` is missing, hold.

## MEXC

| Step | Call | Check |
|---|---|---|
| network data | `call_read_method {"exchange":"mexc","account":"<alias>","method":"fetchDepositWithdrawFee","args":["USDT"],"includeInfo":true}` | `info.networkList[]`: `network` (long id), `netWork` (short id), `depositEnable`, `contract`; no deposit minimum |
| key check | `call_implicit_get {"exchange":"mexc","account":"<alias>","method":"spotPrivateGetAccount"}` | deposit-only: `canWithdraw: false`; report `permissions`, `canTrade` |
| identity | `call_implicit_get {"exchange":"mexc","account":"<alias>","method":"spotPrivateGetUid"}` | report `uid` |
| raw read | `call_implicit_get {"exchange":"mexc","account":"<alias>","method":"spotPrivateGetCapitalDepositAddress","params":{"coin":"USDT","network":"<network from the network data>"}}` | rows with that `network`: exactly one; `netWork` is `BSC` / `TRX` / `ETH` / `TONCOIN`; memo in `memo` |
| gated read | `call_read_method {"exchange":"mexc","account":"<alias>","method":"fetchDepositAddress","args":["USDT"],"params":{"network":"<code>"},"includeInfo":true}` | equal to the raw row |

- A `TON` row without a `memo` field: hold. A missing `memo` on a non-memo chain means none.
- **Minimum: hold.** MEXC's [API reference](https://mexcdevelop.github.io/apidocs/spot_v3_en/)
  lists no deposit-minimum field for `capital/config/getall`. `depositTips` is free text with no
  defined format, so the skill does not read a minimum from it. The route holds on `min` unless
  the user reads it on MEXC's deposit page.
- An outdated long id in `netWork` (for example `BNB Smart Chain(BEP20)`) made the gated read
  fail (verified offline): hold.

## KuCoin

| Step | Call | Check |
|---|---|---|
| network data | `call_implicit_get {"exchange":"kucoin","method":"publicGetCurrenciesCurrency","params":{"currency":"USDT"}}` | `data.chains[]`: `chainId`, `isDepositEnabled`, `depositMinSize`, `contractAddress`, `needTag` (the fields of KuCoin's published v3 schema) |
| key check | `call_implicit_get {"exchange":"kucoin","account":"<alias>","method":"privateGetUserApiKey"}` | deposit-only: `permission` is `General` with no `Withdrawal`; report `uid`, `isMaster`, `ipWhitelist`, `remark` (the server redacts `apiKey`) |
| raw read | `call_implicit_get {"exchange":"kucoin","account":"<alias>","method":"privateGetDepositAddresses","params":{"currency":"USDT","chain":"<chainId>","version":"v3"}}` | sends only `GET /api/v3/deposit-addresses`; rows with `chainId` equal to the chosen id: exactly one; full `contractAddress` equals the reference; memo in `memo`; `expirationDate` `0` |

- ccxt's `fetchDepositAddress` uses KuCoin's v1 endpoint, which KuCoin lists as abandoned
  ([docs](https://www.kucoin.com/docs-new/abandoned-endpoints/account-funding/get-deposit-addresses-v1)).
  Do not use it. The raw name matches ccxt-mcp's gate, so the v3 read alone is funds-gated
  (`TIER_DISABLED` without `funds`, verified offline).
- **Expiration.** KuCoin's v3 schema says `expirationDate` applies only to the Lightning
  Network. On TRC20, BEP20, ERC20 or TON it must be `0` (or absent). Any other value is
  unexplained: hold (verified offline).
- `to` is the landing wallet (`MAIN` or `TRADE`). Record it as `Lands in`.
- **Deposit fee: hold.** KuCoin's published v3 currency schema has no deposit-fee field. No read
  in ccxt 4.5.85 shows the account's remaining free deposit quota, which differs by KuCoin entity.
  KuCoin's pages disagree. `d` stays unknown unless the user reads it on KuCoin's deposit page.
  KuCoin UTA accounts were not verified: hold.

## Gate

| Step | Call | Check |
|---|---|---|
| network data | `call_implicit_get {"exchange":"gate","method":"publicWalletGetCurrencyChains","params":{"currency":"USDT"}}` | `chain`, `is_deposit_disabled`, `contract_address`, `is_tag` |
| key check | `call_implicit_get {"exchange":"gate","account":"<alias>","method":"privateAccountGetDetail"}` | report `user_id`, `ip_whitelist`, `key.mode`; the read has no permission fields, so the key scope rests on the setup record |
| raw read | `call_implicit_get {"exchange":"gate","account":"<alias>","method":"privateWalletGetDepositAddress","params":{"currency":"USDT"}}` | only with `provisioning: allowed` ([above](#provisioning-reads)); in `multichain_addresses`: exactly one row with the chosen `chain`, `obtain_failed: 0`; memo in `payment_id`; top-level `min_deposit_amount` |
| gated read | `call_read_method {"exchange":"gate","account":"<alias>","method":"fetchDepositAddress","args":["USDT"],"params":{"network":"<code>"},"includeInfo":true}` | equal to the raw row when it succeeds |

- ccxt validates every entry of `multichain_addresses`. One entry with `obtain_failed: 1`
  made the gated read fail for every chain (verified offline). The raw read is itself
  funds-gated, so it then stands alone as the source.
- **Minimum.** Gate's reference (and the official `gate-api` 7.2.184 SDK model) has an optional
  `min_deposit_amount` at the top level of the address response, next to `currency`, not per
  chain. It counts as the chain's minimum only when `multichain_addresses` lists the chosen chain
  and no other. Otherwise it is not established for that chain, and the send holds on `min`
  (verified offline both ways).
- **Deposit fee: hold.** No Gate source for USDT deposit fees was verified here.
- Routes to Gate therefore hold. With the user's own UI reading of the missing values, a send to
  Gate is the [withdrawal sheet](../SKILL.md#29-manual-withdrawal-in-exchange-as-ui) or Scenario 1.

## Hyperliquid

Watch-only. A profile has only `walletAddress`, no `funds`, so every address method returns
`TIER_DISABLED` and the funds tools are not listed (verified offline). Hyperliquid is never a
USDT recipient or source.
