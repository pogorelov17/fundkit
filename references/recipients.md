# Native recipient reads: deposit address and memo from the operator's own account

How the agent reads a verified USDT recipient (address, memo, chain, landing wallet) from the
operator's own exchange account through ccxt-mcp, so nobody copies an address by hand. Used by
[SKILL.md, Scenario 1](../SKILL.md#scenario-1-wallet--exchange-manual-send) (a top-up from any compatible wallet) and
[Scenario 2](../SKILL.md#scenario-2-exchange-a--exchange-b-semi-automatic). The exchange UI
stays an option the user may choose. It is never a required step on a path marked native below.

Every row was exercised offline only: ccxt-mcp 0.1.3 and ccxt 4.5.85, synthetic keys, `unshare -rn`
and a fixture transport ([verification](ccxt-mcp.md#verification)). The fixture responses follow
each venue's published API reference and ccxt's parsers. None was captured from a live account, and
no real key was used. Readiness for a real account is not established by these tests.

## Status by destination venue

`d` is B's deposit fee and `min` B's deposit minimum ([2.3](../SKILL.md#23-debit-withdraw-amount-and-credit)).
Where B's healthy lookup publishes no applicable `min` (marked "unknown" below), `min` is
[unknown](deposit-minimum.md): Fundkit sets no minimum of its own, any positive conservative
credit qualifies, and the plan or sheet says `Destination deposit minimum unknown. Fundkit
recommends depositing at least 1 USDT.` (advice, never a check). A published `min` is enforced
on the conservative credit, inclusive. A `min` field that is present but not an exact decimal,
or contrary evidence, holds. "Native" means the agent reads every recipient field itself (the read still relies on the
profile's setup-record lines: [prerequisites by route](#prerequisites-by-route)). "Hold" means
the route needs a fact that no live field or official source supplies, so the agent stops. For
B's minimum or deposit fee the user may choose to supply that one value as a
[per-plan human-read fact](../SKILL.md#per-plan-human-read-facts). A field counts only if the venue documents it, or if the
live field's own name states its meaning (basis "live field"). The agent never derives a field
from another field or from the address format. A source must be specific to the account's
entity: a value documented for one entity of a venue (for example Binance TH) does not establish
it for another (Binance.com).

| Destination | Recipient read | Key scope (no UID binding) | `d` | `min` | Status |
|---|---|---|---|---|---|
| Bybit | [SKILL.md flow](../SKILL.md#bybit-deposit-address) | `query-api`: `readOnly`, `permissions`, `isMaster` | 0, [Bybit fees page](https://www.bybit.com/en/help-center/article/Bybit-Fees-You-Need-to-Know) | `depositMin`; absent: unknown | native; `batchReleaseLimit` must be `"-1"` ([cap](#bybit-inbound-cap)) |
| OKX | currency-wide list, filtered to `ccy`, chain and `selected`, then exactly one | `account/config`: `perm`, `label`, `ip` | 0, [OKX help](https://www.okx.com/en-eu/help/do-i-need-to-pay-fees-for-deposit-and-withdrawal): no fee on deposits above the minimum | `minDep` from the raw currency rows; absent: unknown | native |
| Bitget (classic) | raw funds-gated address read alone, with the live chain id | `spot/account/info`: `authorities`, `ips` | 0, [Bitget article](https://www.bitget.com/support/articles/12560603820706): "Bitget does not charge any fees for deposits." | `minDepositAmount`; absent: unknown | native on all four, BEP20 included ([Bitget](#bitget)); UTA: hold |
| BingX | one row per network in the address list | `apiPermissions` (numeric codes) | 0, [BingX Learn](https://bingx.com/en/learn/how-to-deposit-crypto-with-bingx): "BingX does not charge fees for crypto deposits." (a venue article, not a fee schedule) | the chosen chain's live `depositMin` in `config/getall`, which [BingX's API docs](https://bingx-api.github.io/docs/#/en-us/common/wallet-api.html) define as "Minimum deposit amount" ([BingX](#bingx)); absent: unknown | native; deposit credit only on raw status `6` |
| Binance | default row of the address list | `apiRestrictions` flags | 0, [Binance fee page](https://www.binance.com/en/fee/cryptoFee): "Binance does not charge deposit fees." | none published (`depositDust` is not described in Binance's reference, only an example value, so it is never the minimum; unreadable holds, and a credit at or below a readable value is contrary evidence): unknown | native; `min` unknown |
| MEXC | raw funds-gated address list alone, rows matched by the config row's `network` string | `account` proves only that the key signs; key rights and IP allowlist from the setup record (`canWithdraw` is an account flag) | 0, [MEXC Learn, 2026-10-20](https://www.mexc.com/learn/article/mexc-fees-explained-complete-trading-futures-withdrawal-fees-guide/1): "MEXC does not charge to receive crypto deposits" (a venue article, not a fee schedule) | no API field (`depositTips` is free text): unknown | native; `min` unknown |
| KuCoin (classic) | v3 address list | `user/api-key`: `permission`, `isMaster` | live `depositFeeRate` × amount when it is a decimal and `depositTierFee` is empty; absent (both empty, as on the live read of 2026-11-25), a tier fee (undocumented semantics) or a non-decimal: unknown. KuCoin's fee pages say part of their content is outdated, and no entity-specific deposit-fee statement was found | `depositMinSize`; `null` (KuCoin's unset value) or absent: unknown | address native; `d` hold while the fields are empty; UTA: hold |
| WhiteBIT | address object for the requested network (may provision, [below](#provisioning-reads)) | none in ccxt 4.5.85 | `required.fixedFee` and `required.flexFee` in the same response | `required.minAmount`; absent: unknown | native with operator setup evidence: the contract is the operator's one-time reading pinned in the setup record, and the [entity line](exchanges.md#entity-lines) must give a jurisdiction outside the EEA and Turkey ([WhiteBIT](#whitebit)); without the pin: hold |
| Gate | `multichain_addresses` row (may provision, [below](#provisioning-reads)) | `account/detail`: `ip_whitelist`, `key.mode` (no permission fields) | `withdraw_status.deposit`, documented as "Deposit fee" (currency-level; there is no per-chain deposit-fee field) | top-level `min_deposit_amount` counts only when the unfiltered list has exactly one row, for the chosen chain, eligible ([Gate](#gate)); otherwise unknown (a credit below a currency-level value is contrary evidence) | native; `min` unknown unless single-chain |

Network ids for Bitget, KuCoin, Gate and WhiteBIT were also compared with their keyless public
endpoints on 2026-11-25. Fee and policy pages were checked on the same day. The sheet or plan names the page as the source of
`d`. If a live field, or a page the user chose to check, shows another value, `d` is unknown. A
credit that differs from the expected `C` holds the route ([2.7](../SKILL.md#27-reconciliation)).

## Prerequisites by route

What a read or a route relies on besides live fields, in three classes. The classes overlap:
one route can use all three, so per-class counts do not add up.

| Class | When | What |
|---|---|---|
| Common setup | once; every API route and every recipient read | one [setup-record](security.md#setup-record) line per registration (registration, alias, exchange, environment, `configPath`, `journal`, role); for every money-moving registration also the interactive-form line |
| Venue-specific setup | once; only the routes that touch that venue | whitelist entry in the setup record (sources other than Binance and Gate); [entity line](exchanges.md#entity-lines) (Binance, Bybit, OKX, BingX sources; WhiteBIT either side); key rights or IP line where no read shows them (key rights: Gate, MEXC, WhiteBIT; IP: MEXC, WhiteBIT); BingX permission-code meanings; provisioning consent (Gate, WhiteBIT as B); WhiteBIT contract pin |
| Per-plan fact | only if the user opts in, for one plan | B's deposit minimum or fee read on B's deposit page ([rule](../SKILL.md#per-plan-human-read-facts)) |

Measured result for the 72 directed USDT pairs, from the offline run of 2026-11-25 (synthetic
fixtures, each expectation fixed before the run; [verification](ccxt-mcp.md#verification)). That
run came **before** the [current minimum rule](deposit-minimum.md), and none of it shows that
a real route is ready:

- **36 settle after the one-time setup**, with the human's per-plan part limited to
  `APPROVE`, `WITHDRAW` and the native forms: A ∈ Binance, Bybit, Gate, OKX, Bitget, BingX,
  MEXC, KuCoin → B ∈ Bybit, OKX, Bitget, BingX, WhiteBIT (A ≠ B). Every one uses the common
  setup **and** at least one venue-specific fact; none runs on live fields alone. Of the 36:
  whitelist entry in the setup record 26, entity line 21, key rights from the setup record 16,
  IP allowlist from the setup record 12 (MEXC sources; WhiteBIT, which has no key read, as B),
  BingX permission codes 11, provisioning consent 8, WhiteBIT contract pin 8. 28 of them also run the separate settlement plan on B (Bybit, OKX, Bitget,
  BingX); the 8 to WhiteBIT end credited.
- **28 settle only with a per-plan human-read fact** the user opts to supply: every source
  except WhiteBIT → Binance or MEXC (minimum), Gate (minimum on a multi-chain address response)
  or KuCoin (deposit fee). Without it they held before any money call.
- **8 hold for an API withdrawal whatever the user supplies**: WhiteBIT as source (its
  available amount is not visible through these tools). The safer alternative that remains is
  the [manual withdrawal sheet](../SKILL.md#29-manual-withdrawal-in-exchange-as-ui) in
  WhiteBIT's UI, with B's recipient still read natively and B's deposit still matched by hash.
- Network: Bitget sources use TON (Bitget BEP20 outbound holds), Gate sources avoid TON
  (withdrawals disabled in the live capture); the rest use BEP20 as the cheapest network.

**Not measured since.** The unknown-minimum rule (no Fundkit minimum) replaces the minimum gate
on the routes into Binance, MEXC and Gate (multi-chain address response). Those documented-flow
routes were not re-run under the rule, so their outcome is not measured, and no updated count
is claimed. They are not reported as settling. KuCoin's deposit-fee hold does not depend on the
minimum. The rule's end-to-end proof is the native tools only (Binance and Bybit as B,
offline: [acceptance](deposit-minimum.md#acceptance)).

Recipient reads (Scenario 1, 9 venues × 4 networks), same measured run: all 36 verify address,
memo, chain and contract, each relying on the profile's registration line, and on Gate, MEXC and
WhiteBIT also on the key-rights line (MEXC and WhiteBIT also the IP line; BingX the permission
codes; Gate and WhiteBIT provisioning consent; WhiteBIT the contract pin). In that run a send
could be planned without a per-plan fact to 20 of them (Bybit, OKX, Bitget, BingX, WhiteBIT);
16 needed one (Binance, MEXC, multi-chain Gate minimum; KuCoin fee). The unknown-minimum
rule's effect on the Binance, MEXC and Gate sheets is not measured.

USDT only: a request for any other coin (USDC included) is refused, never read with these calls
([rule](deposit-minimum.md#scope-policy-versus-support)).

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
2. **Key check**: the venue's key-metadata read. For a deposit-only profile, require only what
   the read itself needs ([venue profiles](security.md#venue-profiles)) and report every right
   as shown; a write-enabled key is fine, and no separate read-only key is ever requested. The
   operator's mapping of the profile to its account is trusted: never fetch, report, record or
   compare an account UID to bind them, also where the key check's result happens to name one.
3. **Recipient read**: the calls in the venue row. Where the venue has a raw GET, that raw
   row is the address source. ccxt indexes addresses by network and keeps only the last one,
   so duplicates disappear from normalized reads (verified offline on Bybit, OKX, Gate, BingX,
   MEXC and KuCoin). How rows are counted depends on the endpoint:
   - **currency-wide** endpoints (OKX, Gate, BingX, MEXC) list every chain of the currency.
     First keep only the rows for USDT and the chosen chain (OKX: also `selected: true`; Gate:
     `obtain_failed: 0`), then require **exactly one**. Rows for other chains are normal there.
   - **chain-scoped** endpoints (Bybit `chainType`, Binance `network`, Bitget `chain`, KuCoin
     `chain`) are asked for one chain. Any row for another chain is a wrong row: hold.

   Where a gated normalized read is also made, its address, memo and chain must equal the raw
   row. On Bitget and MEXC the raw endpoint is itself funds-gated and is used alone, because
   ccxt's normalized read sends or parses the wrong network id there.
4. **Address check** ([below](#address-checks)) and [memo check](#memo-absent-versus-empty).
5. **Show** the address and the memo (or `none`) each in its own code block, copied
   character for character from the source row, with
   `<venue> alias <alias>, read <UTC>, chain <venue chain id>, lands in <wallet or unknown>`.

Hold on any of these: an empty result, several eligible rows, a row for the wrong chain, a failed
[address check](#address-checks), a contract that does not match the
[reference contract](../SKILL.md#chains), a missing, `null` or non-string memo where the network
requires one or the venue returns the field, or any field that differs between the reads. Repeat
step 3 just before OPEN or before the withdrawal. Any change needs a new sheet or plan.

### Address checks

- **EVM** (`BEP20`, `ERC20`): `0x` followed by exactly 40 hex characters. The format does not
  show which EVM chain the address belongs to. The chain comes only from the venue's raw row
  (or, on WhiteBIT, from the request: [WhiteBIT](#whitebit)), never from the address.
- **Tron**: `T` followed by 33 base58 characters that decode to 25 bytes: version byte `0x41`, a
  20-byte account id, and the first 4 bytes of a double SHA-256 over the first 21 bytes
  (base58check). Hold on a checksum mismatch.
- **TON**: the 48-character user-friendly form, in base64url (`-`, `_`) or standard base64
  (`+`, `/`), one alphabet per address; a string that mixes them, or has other characters or
  padding, fails. Copy and whitelist the form the venue's row shows, character for character.
  It decodes to 36 bytes:
  a tag byte, a workchain byte, a 32-byte account id and a CRC16-XMODEM checksum (big-endian)
  over the first 34 bytes. Require a tag byte of `0x11` (bounceable) or `0x51` (non-bounceable),
  workchain `0x00`, and a matching checksum. A tag byte with `0x80` set is a testnet address.
  Workchain `0xff` is the masterchain. Hold on either.

  The agent cannot compute a CRC or a SHA-256 by reading. For TON and Tron addresses it runs
  exactly this command, which reads only its argument and prints `OK` or `FAIL`. This is the only
  program the skill lets the agent run ([rule 1](../SKILL.md#hard-rules)). Any other output, an
  error included, counts as `FAIL`:

  ```bash
  python3 -I -c '
  import base64, hashlib, re, sys
  a = sys.argv[1]; ok = False
  if re.fullmatch(r"T[1-9A-HJ-NP-Za-km-z]{33}", a):
      B = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; n = 0
      for ch in a: n = n * 58 + B.index(ch)
      r = n.to_bytes(25, "big"); ok = r[0] == 0x41 and hashlib.sha256(hashlib.sha256(r[:21]).digest()).digest()[:4] == r[21:]
  elif re.fullmatch(r"[A-Za-z0-9_-]{48}|[A-Za-z0-9+/]{48}", a):
      r = base64.b64decode(a.replace("-", "+").replace("_", "/"), validate=True); c = 0
      for x in r[:34]:
          c ^= x << 8
          for _ in range(8): c = ((c << 1) ^ 0x1021) & 0xffff if c & 0x8000 else (c << 1) & 0xffff
      ok = len(r) == 36 and r[0] in (0x11, 0x51) and r[1] == 0 and c == int.from_bytes(r[34:], "big")
  print("OK" if ok else "FAIL")
  ' '<address>'
  ```

  | Example | Result |
  |---|---|
  | `EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs` (USDT master, bounceable) | `OK` |
  | `UQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_p0p` (same account, non-bounceable) | `OK` |
  | `EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id/sDs` (USDT master, standard base64) | `OK` |
  | `EQB5ss754loOqK06QDTi14zN42G/dN_oE-sW_jQ3tgTOS135` (synthetic, `/` mixed with `_` and `-`) | `FAIL`: mixed alphabets |
  | `EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDt` (last character changed) | `FAIL`: checksum |
  | `kQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_ntm` (testnet tag `0x91`) | `FAIL`: testnet |
  | `Ef-xE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_j-k` (workchain −1) | `FAIL`: masterchain |
  | `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` (USDT on Tron, contract) | `OK` |
  | `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u` (last character changed) | `FAIL`: checksum |

  These are format checks only. The address must still come from the raw row, and it must be the
  deposit address, never the token contracts above.

### Memo: absent versus empty

The memo is checked against the network's published flag (OKX, Bitget, KuCoin `needTag`; BingX
`needTagOrMemo`; Gate `is_tag`; WhiteBIT `is_memo`). Binance, Bybit and MEXC publish no flag, so
there the address row is the evidence.

- **Venues that put the memo field on every address row**: Binance `tag` (its reference example
  shows `"tag": ""`), Bybit `tagDeposit`, Bitget `tag`, BingX `tag`, KuCoin `memo`, Gate
  `payment_id`. `""` means none. A **missing** field is an incomplete response and holds, even
  on a chain without memos (verified offline on Binance).
- **Venues that add the field only when the currency needs it**: OKX (`tag`, `memo`, `pmtId` or
  `addrEx`), WhiteBIT (its reference: "Memo if currency requires memo"), MEXC (`memo`). A missing
  field means none when the published flag is false. It holds when the flag is true, and on a
  MEXC TON row, which has no flag.
- **MEXC `memo: null`.** MEXC's reference and ccxt's parser comment show address rows with
  `"memo": null`. On MEXC TRC20, BEP20 and ERC20, chains without memos, that `null` means none.
  This exception covers only those three MEXC chains. A MEXC TON row with `memo: null` holds. WhiteBIT's live `USDT.is_memo` was `false` on 2026-11-25, so a
  WhiteBIT TON address without `memo` is a no-memo address (verified offline: the only stop on
  that route is the contract).
- On every other venue and chain: `null`, a non-string or a whitespace-only memo holds. A memo required by the
  flag but empty holds. Any nonempty memo is preserved exactly, leading zeros included, also
  where the flag says none is needed (live Bitget TON shows `needTag: false`).

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
| key check | `call_implicit_get {"exchange":"binance","account":"<alias>","method":"sapiGetAccountApiRestrictions"}` | `enableReading: true`; report `enableWithdrawals`, `enableInternalTransfer`, `ipRestrict` and `permitsUniversalTransfer` as shown (a withdrawal-enabled key is fine on a deposit-only profile) |
| gated read | `call_read_method {"exchange":"binance","account":"<alias>","method":"fetchDepositAddress","args":["USDT"],"params":{"network":"<code>"},"includeInfo":true}` | sends only `GET /sapi/v1/capital/deposit/address` with `network=<id>`; unified `network` (derived by ccxt from the explorer `url`) must be the chosen code |
| raw read | `call_implicit_get {"exchange":"binance","account":"<alias>","method":"sapiGetCapitalDepositAddressList","params":{"coin":"USDT","network":"<id>"}}` | exactly one row with `isDefault: 1`; its `address` and `tag` equal the gated `info` |

- Memo: raw `tag`, where `""` means none and a missing `tag` holds ([memo rule](#memo-absent-versus-empty)).
  Binance publishes no deposit memo flag (`withdrawTag` is about withdrawals from Binance), so
  the address row is the evidence ("no published flag").
- Rows with `isDefault: 0` are older addresses of the account and are not eligible. Two rows
  with `isDefault: 1`: hold. Binance's docs say the list's `coin` can name the address space
  (`ETH` for EVM), so do not compare it.
- An explorer `url` for another chain changes the unified `network` (an `etherscan.io` URL
  gave `ERC20` for a `BEP20` request, verified offline): hold.
- **Minimum.** ccxt 4.5.85 maps `depositDust` to the deposit minimum. Binance's reference shows
  that field only as an example value and does not say what it means (`withdrawMin` and the
  other fields are named for what they are). A live field without documented meaning is not
  used as a minimum, so Binance publishes none on any chain and `min` is
  [unknown](deposit-minimum.md) (no Fundkit minimum; the 1 USDT recommendation is advice
  only). An unreadable `depositDust` holds (the row is not healthy); a readable one is bound
  into the plan, and a credit at or below it holds as contrary evidence. `busy: true` holds.
  A `depositMin` on the row, if Binance ever supplies one, is enforced instead whatever its
  value; an unreadable one holds. The user may supply the minimum from
  Binance's deposit page as a [per-plan human-read fact](../SKILL.md#per-plan-human-read-facts);
  it then wins. A description in
  another entity's documentation (for example Binance TH) does not apply to a Binance.com
  account. (BingX is different: its own API docs define `depositMin`, [below](#bingx).)
- Landing wallet: the response has none. Binance's typical deposit wallet is Spot
  ([account mode table](exchanges.md#account-mode-and-available-amount)). In a two-profile
  session the agent locates the credit by reading the wallets (2.8).

## Bybit

[SKILL.md, Bybit deposit address](../SKILL.md#bybit-deposit-address) holds the full flow. The raw
`privateGetV5AssetDepositQueryAddress` does not match ccxt-mcp's gate pattern, so always run the
gated `fetchDepositAddressesByNetwork` first on the same `funds` alias.

### Bybit inbound cap

Bybit's raw row carries `batchReleaseLimit`, its documented cap on credited deposits for the chain
(`"-1"` means unlimited). The cap applies to every send to Bybit: a wallet top-up (Scenario 1), an API
withdrawal from exchange A (Scenario 2) and a manual withdrawal in A's UI (2.9). Only `"-1"`
qualifies without more evidence. A finite limit requires the remaining allowance for the period,
after releases of older pending deposits against the same cap. No Bybit read in ccxt 4.5.85 shows
that allowance, so a finite, missing or malformed limit holds the plan or sheet. Repeat the check
in the recheck before OPEN or before the withdrawal, with a fresh raw read. A limit that was
`"-1"` at planning and is anything else at the recheck (for example `"1"`) means zero dispatch
and a new plan or sheet (verified offline).

## OKX

| Step | Call | Check |
|---|---|---|
| network data | `call_implicit_get {"exchange":"okx","account":"<alias>","method":"privateGetAssetCurrencies","params":{"ccy":"USDT"}}` | one raw row per chain: `chain` `USDT-TRC20`/`USDT-BSC`/`USDT-ERC20`/`USDT-TON`, `canDep`, `canWd`, `minDep`, `minWd`, `fee`, `wdTickSz`, `ctAddr`, `needTag`. Do not use `fetchDepositWithdrawFee` for OKX: its `info` keeps only one row (the last chain), verified offline |
| key check | `call_implicit_get {"exchange":"okx","account":"<alias>","method":"privateGetAccountConfig"}` | `data[0].perm` includes `read_only`; report the whole `perm` (for example `read_only,withdraw`), `label`, `ip` |
| gated read | `call_read_method {"exchange":"okx","account":"<alias>","method":"fetchDepositAddress","args":["USDT"],"params":{"network":"<code>"},"includeInfo":true}` | sends only `GET /api/v5/asset/deposit-address?ccy=USDT`; ccxt keeps only `selected: true` rows and one per network |
| raw read | `call_implicit_get {"exchange":"okx","account":"<alias>","method":"privateGetAssetDepositAddress","params":{"ccy":"USDT"}}` | `code: "0"`; the response lists every chain of the currency: keep rows with `ccy: "USDT"`, the chosen `chain` and `selected: true`, then require exactly one; its `addr`, memo and `chain` equal the gated `info` |

- Memo: OKX returns `tag`, `memo` or `pmtId`, or `addrEx` (TON: `addrEx.comment`). Use the
  field the raw row carries, exactly as a string. If `needTag` is true and no memo field is
  present, hold.
- `ctAddr` in the address row is a contract suffix. It must match the end of the reference
  contract, and the currency row's full `ctAddr` must equal it.
- `to` is the landing wallet: `6` funding, `18` trading. Record it as `Lands in`.
- Rows with `selected: false` are other addresses of the account and are not eligible.
  Two `selected: true` rows for one chain: ccxt silently kept the last one, so hold. No
  selected row for the chain, or a memo that differs between the gated and the raw read:
  hold (verified offline on a multi-chain response).
- Offline results: no key gives `AUTH_FAILED requires "apiKey" credential`, and no passphrase
  gives `requires "password" credential`, with nothing sent. A profile without `funds` gets
  `TIER_DISABLED` for both reads. Empty `data` makes the gated read fail with `InvalidAddress`
  and leaves the raw `data: []`. Key rejection `50120` comes back as `EXCHANGE_ERROR` (not
  `AUTH_FAILED`).

## Bitget

| Step | Call | Check |
|---|---|---|
| network data | `call_read_method {"exchange":"bitget","account":"<alias>","method":"fetchDepositWithdrawFee","args":["USDT"],"includeInfo":true}` (also works without a key) | `info.chains[]`: `chain`, `rechargeable`, `minDepositAmount`, `contractAddress`, `needTag` |
| key check | `call_implicit_get {"exchange":"bitget","account":"<alias>","method":"privateSpotGetV2SpotAccountInfo"}` | report `authorities` and `ips` as shown; an authority naming withdrawal is fine on a deposit-only profile |
| raw read (alone) | `call_implicit_get {"exchange":"bitget","account":"<alias>","method":"privateSpotGetV2SpotWalletDepositAddress","params":{"coin":"USDT","chain":"<live id>"}}` | `<live id>` is the `chain` of the network-data row whose contract matched the reference (`TRC20`, `BEP20`, `ERC20`, `TON`); `code: "00000"`; `data.chain` equals it, `data.coin` is `USDT`; `address` nonempty; `tag` a string |

- The raw method matches ccxt-mcp's gate pattern, so it is itself funds-gated
  (`TIER_DISABLED` without `funds`). It is the only recipient read on Bitget classic. Do not use
  `fetchDepositAddress`: for the code `BEP20` ccxt 4.5.85 sends `chain=BSC` (its source comments
  `'BEP20': 'BEP20'` out as "different for BEP20"), and Bitget's live public coin list names the
  chain `BEP20`. With the raw read and the live id, Bitget BEP20 is a native destination
  (verified offline; the fixture rejects `chain=BSC`, and the read never sent it).
- **Outbound BEP20 still holds.** A withdrawal from Bitget is built by ccxt, which sends `BSC`,
  and overriding it with `params.chain` would be invisible in the form
  ([rule 4](../SKILL.md#hard-rules)). No source shows that Bitget accepts `BSC`. Bitget sources
  use TRC20, ERC20 or TON ([outbound table](exchanges.md#outbound-withdraw)).
- Memo: `tag`. `needTag` in the network data is the published flag (live TON: `false`).
- The endpoint returns one object, so it cannot show duplicates. A row for another chain or an
  empty address: hold.
- Bitget UTA uses `privateUtaGetV3AccountDepositAddress`, which was not verified: hold, or the
  user chooses the UI.
- Landing wallet: not in the response; typically Spot.

## BingX

| Step | Call | Check |
|---|---|---|
| network data | `call_read_method {"exchange":"bingx","account":"<alias>","method":"fetchDepositWithdrawFee","args":["USDT"],"includeInfo":true}` (public response is `null`) | `info["<code>"].info`: `network`, `depositEnable`, `withdrawEnable`, `withdrawFee`, `withdrawMin`, `withdrawPrecision`, `contractAddress`, `needTagOrMemo` |
| key check | `call_implicit_get {"exchange":"bingx","account":"<alias>","method":"accountV1PrivateGetAccountApiPermissions"}` | report `permissions` (numeric codes), `ipAddresses`, `note`. The operator records once in the [setup record](security.md#setup-record) what the codes mean on BingX's API page |
| raw read | `call_implicit_get {"exchange":"bingx","account":"<alias>","method":"walletsV1PrivateGetCapitalDepositAddress","params":{"coin":"USDT","offset":0,"limit":1000}}` | rows in `data.data[]` with `network` equal to the chosen id: exactly one. The address is `addressWithPrefix` if nonempty, else `address`. EVM addresses must already carry `0x` in the raw row |
| gated read | `call_read_method {"exchange":"bingx","account":"<alias>","method":"fetchDepositAddress","args":["USDT"],"params":{"network":"<code>"},"includeInfo":true}` | same request; the unified `address` must equal the raw address exactly |

- ccxt adds `0x` to an unprefixed EVM address itself (verified offline). A raw row without the
  prefix therefore differs from the unified value: hold.
- Memo: `tag`. `needTagOrMemo` is the published flag.
- **Minimum: the chosen chain's live `depositMin`.** BingX's official API docs
  ([bingx-api.github.io/docs](https://bingx-api.github.io/docs/#/en-us/common/wallet-api.html),
  Wallet deposits and withdrawals → "Query currency deposit and withdrawal data",
  `GET /openApi/wallets/v1/capital/config/getall`) list `depositMin` (decimal) in the
  `Network` object as "Minimum deposit amount", one per network row. ccxt's
  `fetchDepositWithdrawFee` reads that endpoint, so `info["<code>"].info.depositMin` is the
  minimum for that chain. Use the row whose `network` equals the chosen id, never another
  chain's row. A `null`, non-decimal or negative value holds on `min`; a row without the field
  leaves the minimum [unknown](deposit-minimum.md); a changed value
  or `depositEnable: false` at the recheck means zero dispatch (verified offline). Captured
  2026-11-25 07:44 UTC: the docs page loads `static/js/app.4dcba784df17c52faa47.js`
  (sha256 `77094f2a99bdca9c1b8e41a260c3657a6ed6b8febe30818b486cb54fe0b14d8f`,
  `Last-Modified` 2026-01-22), which holds that table in English (module `zgmp`) and Chinese.
  The [api-ai-skills reference](https://github.com/bingx-api/api-ai-skills/blob/d40bcc6ab6e91ad7c2d801250425c2a973d2f95a/skills/spot-wallet/api-reference.md)
  omits the field; an omission is not a disagreement.
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
- **Contract: operator setup evidence.** No WhiteBIT API (assets, fee, address) publishes a
  token contract or an explorer mapping. WhiteBIT's help centre says that the network on the
  deposit page links to the explorer, where the token contract is shown. The operator reads it
  there once per network and pins it in the [setup record](security.md#setup-record)
  (`WhiteBIT contract <NET>: <contract>, pinned <UTC>`). The agent compares that pin with the
  reference contract. Every plan or sheet that uses it says "operator setup evidence, not an
  API field". Without a pin, or with a pin that differs from the reference: hold.
- **Entity.** WhiteBIT's compliance page says EEA accounts cannot deposit or withdraw USDT, and
  EEA and Turkey deposits can be frozen for the travel rule. The setup record's
  [entity line](exchanges.md#entity-lines) must name `WhiteBIT.com` with a jurisdiction
  outside the EEA and Turkey; otherwise hold (verified offline with Poland, France, Norway).
- No key-metadata read exists in ccxt 4.5.85, so the key's scope comes from the operator's setup
  record. Which account the alias is follows from the operator's mapping, as on every venue.
- `required.minAmount` is `min`. `fixedFee` plus the `flexFee` percentage (bounded by its
  `minFee` and `maxFee`) is `d`. WhiteBIT says a deposit below the minimum is recorded as
  uncredited and canceled after 7 days if it stays below. If `required` is missing, hold.

## MEXC

| Step | Call | Check |
|---|---|---|
| network data | `call_read_method {"exchange":"mexc","account":"<alias>","method":"fetchDepositWithdrawFee","args":["USDT"],"includeInfo":true}` | `info.networkList[]`: the row whose `netWork` is `TRX` / `BSC` / `ETH` / `TONCOIN`, with its `network` string, `depositEnable`, `contract`; no deposit minimum |
| key check | `call_implicit_get {"exchange":"mexc","account":"<alias>","method":"spotPrivateGetAccount"}` | proves only that the key signs. `canWithdraw`, `canTrade` and `permissions` describe the account, not the key, so the scope comes from the setup record's key rights: the recipient read needs `SPOT_ACCOUNT_READ` and `SPOT_WITHDRAW_READ` (MEXC's deposit-address and network reads need it); further rights such as `SPOT_WITHDRAW_WRITE` are fine, since the profile never calls a write |
| raw read (alone) | `call_implicit_get {"exchange":"mexc","account":"<alias>","method":"spotPrivateGetCapitalDepositAddress","params":{"coin":"USDT","network":"<network string of that row>"}}` | rows with `coin: "USDT"` and `network` equal to that string: exactly one; any other row: hold; memo in `memo` |

- MEXC's reference documents the address rows as `coin`, `network`, `address` and `memo`, with
  no `netWork`, and ccxt's parser comment shows `"memo": null`. ccxt's `fetchDepositAddress`
  maps the row by `netWork`, which such a row lacks, so it is not used. The raw method is
  itself funds-gated. The mapping from the chosen chain to the row's `network` string comes from
  the config row (sourced from the same network data), never from the network name.
- Memo: on TRC20, BEP20 and ERC20 a `memo: null` means none
  ([memo rule](#memo-absent-versus-empty)). A TON row without a string memo holds.
- **Minimum: unknown.** MEXC's [API reference](https://mexcdevelop.github.io/apidocs/spot_v3_en/)
  lists no deposit-minimum field for `capital/config/getall`. `depositTips` is free text with no
  defined format, so the skill does not read a minimum from it. `min` is
  [unknown](deposit-minimum.md), recorded as such with the 1 USDT recommendation, unless
  the user supplies MEXC's own minimum from its deposit page as a
  [per-plan human-read fact](../SKILL.md#per-plan-human-read-facts).
- **Rights.** MEXC documents a permission per endpoint: `GET /api/v3/capital/deposit/address`,
  `capital/config/getall` and the deposit and withdrawal histories need `SPOT_WITHDRAW_READ`,
  `GET /api/v3/account` needs `SPOT_ACCOUNT_READ`, while `POST /api/v3/capital/withdraw` and
  `POST /api/v3/capital/deposit/address` (generate an address) need `SPOT_WITHDRAW_WRITE`.
  A deposit-only key therefore has `SPOT_WITHDRAW_READ` but not `SPOT_WITHDRAW_WRITE`, and it
  cannot create an address.
- **Deposit record.** `fetchDeposits` returns MEXC's long `network` string raw (for example
  `BNB Smart Chain(BEP20)`), and ccxt 4.5.85 derives a unified network from it that is not a
  ccxt code (`BSC` for BEP20, the raw string for TON). Match the raw `network` with the config
  row's `network` string for the chosen chain; do not compare the unified field (verified
  offline: the matching string settles, another chain's string holds).
- Outbound: an outdated long id in `netWork` (for example `BNB Smart Chain(BEP20)`) holds the
  withdrawal. The withdrawal step comes from a valid live `withdrawIntegerMultiple`; `null`, as
  in MEXC's reference example, holds that network only ([outbound table](exchanges.md#outbound-withdraw)).

## KuCoin

| Step | Call | Check |
|---|---|---|
| network data | `call_implicit_get {"exchange":"kucoin","method":"publicGetCurrenciesCurrency","params":{"currency":"USDT"}}` | `data.chains[]`: `chainId`, `isDepositEnabled`, `depositMinSize`, `contractAddress`, `needTag` (the fields of KuCoin's published v3 schema) |
| key check | `call_implicit_get {"exchange":"kucoin","account":"<alias>","method":"privateGetUserApiKey"}` | `permission` includes `General`; report the whole `permission`, `isMaster`, `ipWhitelist`, `remark` (the server redacts `apiKey`) |
| raw read | `call_implicit_get {"exchange":"kucoin","account":"<alias>","method":"privateGetDepositAddresses","params":{"currency":"USDT","chain":"<chainId>","version":"v3"}}` | sends only `GET /api/v3/deposit-addresses`; chain-scoped: exactly one row, with `chainId` equal to the chosen id and `currency: "USDT"`, and no row for another chain; full `contractAddress` equals the reference; memo in `memo`; `expirationDate` `0` |

- ccxt's `fetchDepositAddress` uses KuCoin's v1 endpoint, which KuCoin lists as abandoned
  ([docs](https://www.kucoin.com/docs-new/abandoned-endpoints/account-funding/get-deposit-addresses-v1)).
  Do not use it. The raw name matches ccxt-mcp's gate, so the v3 read alone is funds-gated
  (`TIER_DISABLED` without `funds`, verified offline).
- **Expiration.** KuCoin's v3 schema says `expirationDate` applies only to the Lightning
  Network. On TRC20, BEP20, ERC20 or TON it must be `0` (or absent). Any other value is
  unexplained: hold (verified offline).
- `to` is the landing wallet (`MAIN` or `TRADE`). Record it as `Lands in`.
- **Deposit fee.** KuCoin's v3 currency schema has two optional chain fields:
  `depositFeeRate` ("Deposit fee rate (some currencies have this param; the default is
  empty)") and `depositTierFee` (no description). Use `d = depositFeeRate × amount` only when
  the rate is a decimal and the tier fee is empty. Both empty (the live public read of
  2026-11-25), a tier fee, or a value that is not a decimal: `d` is unknown and the route holds,
  unless the user supplies it from KuCoin's deposit page as a
  [per-plan human-read fact](../SKILL.md#per-plan-human-read-facts). An empty rate does not establish zero.
  Verified offline: rate `0` with no tier fee settles; a tier fee holds. KuCoin UTA accounts
  were not verified: hold.

## Gate

| Step | Call | Check |
|---|---|---|
| network data | `call_implicit_get {"exchange":"gate","method":"publicWalletGetCurrencyChains","params":{"currency":"USDT"}}` and `privateWalletGetWithdrawStatus` (above) | `chain`, `is_deposit_disabled`, `contract_address`, `is_tag`; `deposit` (fee) |
| key check | `call_implicit_get {"exchange":"gate","account":"<alias>","method":"privateAccountGetDetail"}` | report `ip_whitelist`, `key.mode`; the read has no permission fields, so the key scope rests on the setup record |
| raw read | `call_implicit_get {"exchange":"gate","account":"<alias>","method":"privateWalletGetDepositAddress","params":{"currency":"USDT"}}` | only with `provisioning: allowed` ([above](#provisioning-reads)); in `multichain_addresses`: exactly one row with the chosen `chain`, `obtain_failed: 0`; memo in `payment_id`; top-level `min_deposit_amount` |
| gated read | `call_read_method {"exchange":"gate","account":"<alias>","method":"fetchDepositAddress","args":["USDT"],"params":{"network":"<code>"},"includeInfo":true}` | equal to the raw row when it succeeds |

- ccxt validates every entry of `multichain_addresses`. One entry with `obtain_failed: 1`
  made the gated read fail for every chain (verified offline). The raw read is itself
  funds-gated, so it then stands alone as the source.
- **Minimum.** Gate's reference (and the official `gate-api` 7.2.184 SDK model) has an optional
  `min_deposit_amount` at the top level of the address response, next to `currency`, not per
  chain. It counts as the chain's minimum only when the unfiltered `multichain_addresses` list
  has exactly one row, that row is the chosen chain and it is eligible (`obtain_failed: 0`).
  A single row for another chain, several rows, or a failed row: Gate's minimum is not
  established for that chain (verified offline all three ways), so `min` is
  [unknown](deposit-minimum.md). A credit below a currency-level `min_deposit_amount` on such a
  response is contrary evidence and holds; an unreadable one holds.
- **Deposit fee.** `call_implicit_get {"exchange":"gate","account":"<alias>","method":"privateWalletGetWithdrawStatus","params":{"currency":"USDT"}}`
  returns `deposit`, which Gate's reference and the official SDK model describe as "Deposit fee".
  Gate has no per-chain deposit-fee field, so this currency-level value is `d` (verified offline,
  including a response without the field, which holds).
- Routes to Gate therefore use Gate's minimum when the address response is single-chain as
  above (verified offline), and an unknown minimum otherwise. The user may still supply
  Gate's own minimum from its deposit page as a
  [per-plan human-read fact](../SKILL.md#per-plan-human-read-facts); it then wins.

## Hyperliquid

Watch-only. A profile has only `walletAddress`, no `funds`, so every address method returns
`TIER_DISABLED` and the funds tools are not listed (verified offline). Hyperliquid is never a
USDT recipient or source.
