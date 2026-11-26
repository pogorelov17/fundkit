# ccxt-mcp 0.1.3: pins, tools, gates, verification

Everything below was checked against the published `ccxt-mcp@0.1.3` (`js/` source) with
`ccxt@4.5.85`, including runs over stdio. Details are in [Verification](#verification).

## Pins

| Item | Value |
|---|---|
| npm | `ccxt-mcp@0.1.3` (published: 0.1.0, 0.1.2, 0.1.3) |
| integrity / sha1 | `sha512-XGU7T/lXphackbxtukik6te2LfxuQsFUxshCUAXkaKnOKQFlwFJkaPjpZLZT/dSeScA6Wq2ipMhGhE2uxvrbqg==` / `b583b93e9fcecb6cc0700b48863dc7cbcb6ed99b` |
| provenance | SLSA v1, `github.com/ccxt/ccxt`, `.github/workflows/mcp-release.yml`, gitHead `e0eaca51b25377491120ce9ca2943c71800d0d44` (the monorepo has ccxt 4.5.77 at that commit) |
| package dependencies | `@modelcontextprotocol/sdk ^1.29.0`, `ccxt ^4.5.75`, `zod ^3.25.76`: these are ranges and must be pinned separately |
| pinned | `ccxt@4.5.85`, `@modelcontextprotocol/sdk@1.32.2`, `zod@3.25.76` |
| version in `get_safety_status` | `version: "0.1.3"`, `ccxtVersion: "4.5.84"` (the internal version string of ccxt 4.5.85) |

**Why 4.5.85.** ccxt-mcp 0.1.3 calls `exchange.withdraw(code, amount, address, tag, params)`.
In ccxt 4.5.87, commit `edcbd16` ("drop withdraw tag argument") removed `tag`, and from 4.5.87
through 4.5.94 the signature is `withdraw(code, amount, address, params)`. The `tag` then
lands in the `params` slot, and the real `params` with `network` and `fee` are dropped. With
4.5.94 the OKX request went out without a chain and without `fee`, the Bybit and Gate
requests without a chain, and KuCoin's memo `"123456"` became `{"0":"1",…,"5":"6"}`
(verified). 4.5.85 is the last version with the old signature (4.5.86 is not on npm). The
`^4.5.75` range alone installs the newest version, so the pin is mandatory.

### Install

Install into a separate operator directory. Do not use `npx -y`: it fetches `latest` every
time.

```bash
npm view ccxt-mcp@0.1.3 dist.integrity gitHead
npm --prefix <APP_DIR> install --save-exact --ignore-scripts \
  ccxt-mcp@0.1.3 ccxt@4.5.85 @modelcontextprotocol/sdk@1.32.2 zod@3.25.76
npm --prefix <APP_DIR> ls --all ccxt      # exactly one ccxt@4.5.85 (deduped)
npm --prefix <APP_DIR> audit signatures   # checks signatures and attestations
```

## Tools

32 tools; with `hideDisabledTools: true` only the enabled tiers are listed.

| Tier | Tools |
|---|---|
| market | `list_exchanges`, `describe_exchange`, `describe_method`, `search_markets`, `get_tickers`, `get_orderbook`, `get_ohlcv`, `get_trades`, `search_events`, `call_read_method`, `call_implicit_get`, `get_safety_status`, `watch_*` (4) |
| read | `list_accounts`, `get_balance`, `get_orders`, `get_my_trades`, `get_positions` |
| trading (write) | `create_order`, `edit_order`, `cancel_order`, `cancel_all_orders`, `set_leverage`, `set_margin_mode`, `call_write_method` |
| funds (write) | `transfer`, `withdraw`, `get_deposit_address` |
| implicitWrites (write) | `call_implicit_write` |

Schemas from `tools/list` (required fields in **bold**):

- `call_read_method {`**`exchange`**`, `**`method`**` ^(fetch|load), args?, account?, includeInfo?, marketType?, prediction?, params?}`.
  With `account` set, the account's exchange is used, but `exchange` is still required.
  `args` accepts only scalars and `null`.
- `call_implicit_get {`**`exchange`**`, `**`method`**`, account?, params?}`. With ccxt 4.5.85
  it accepts camelCase raw endpoint names (`publicWalletGetCurrencyChains`); snake_case
  returns `UNKNOWN_ENDPOINT`. Find names with
  `describe_method {"exchange":…,"query":"CurrencyChains"}`.
- `get_balance {`**`account`**`, nonzeroOnly?, marketType?, params?}`. It has no
  `includeInfo`, so read raw fields through `call_read_method fetchBalance`.
- `transfer {`**`account, code, amount>0, fromAccount, toAccount`**`, params?, confirm?}`.
- `withdraw {`**`account, code, amount>0, address`**`, tag?, network?, params?, confirm?}`.
  The server puts `network` into `params.network` and calls
  `withdraw(code, amount, address, tag, params)`. ccxt then merges `params` into the request,
  so an extra key (for example `chain`) overrides the network. What each exchange actually
  receives: [outbound withdraw](exchanges.md#outbound-withdraw).
- `get_deposit_address {`**`account, code`**`, network?, params?}`, with no `confirm`. If
  `fetchDepositAddress` fails, the server calls `createDepositAddress` where ccxt has it
  (not on Bybit). `call_read_method` with an address method calls only that method, with no
  create fallback ([Bybit deposit address](exchanges.md#bybit-deposit-address)).

## Gates and approval

- Tiers are enabled **only** in the operator's config. `funds: true` and `trading: true` work
  only in `sandbox`/`demo`; on live the server downgrades them and reports `configProblems`.
  `funds: "live"` requires `maxTransferValue` (USD); exceeding it gives
  `TRANSFER_VALUE_CAP`. Only `transfer` and `withdraw` check it; it does not limit a manual
  send outside the server.
- `settings.strictPermissions: true`: a config readable by group or others (not `chmod 600`)
  is refused with `REFUSED (strictPermissions)` in `configProblems`.
- Address methods (`/deposit.?address|withdraw.?address|withdrawal.?whitelist/i`) require
  `funds` in `call_read_method` and `call_implicit_get`. A raw name outside that pattern is
  not gated: Bybit's `privateGetV5AssetDepositQueryAddress` returned an address on an
  account without `funds` ([Bybit deposit address](exchanges.md#bybit-deposit-address)).
- `withdraw`, `transfer` and `call_implicit_write` always require confirmation unless
  `confirm` is `"never"`.
  - **Host with elicitation.** The first call shows a form with the preview text and one
    `confirm: boolean` field; `params` are not shown. On `accept` with `true` the write is
    sent **immediately**; on `decline` the result is `CONFIRM_DECLINED`. The server waits up
    to 300 s (`elicitInput` with `timeout: 300000` in `js/factory.js`). If the form fails to
    open or times out: `CONFIRM_UNAVAILABLE`, and the server does not fall back to token
    mode. A host tool timeout shorter than that leaves the form open after the agent has
    seen a timeout, so a later accept still sends the write.
  - **Host without elicitation.** The call returns a preview and `meta.confirmToken`: a UUID
    with an HMAC over the exact payload including `params`, single-use, valid for 60 s.
    Redemption errors are `CONFIRM_INVALID`, `CONFIRM_EXPIRED` and `CONFIRM_MISMATCH`. The
    model can redeem the token too, so it is not a human confirmation. Fundkit never redeems a
    token: without native confirmation, withdrawals and internal transfers go through the
    exchange UI.
- Check order: tier gate → caps → confirmation → `dryRun` → `intent` (fsync) → exchange call
  → `result` or `error`. Anything rejected before `intent` was definitely not sent.
- `UNKNOWN_OUTCOME` comes when a timeout or network error happens after `intent`, including
  in a preliminary read inside ccxt. Its hint points to `get_orders`; for transfers and
  withdrawals reconcile per [SKILL.md, 2.7](../SKILL.md#27-reconciliation) instead.
- A successful `transfer` or `withdraw` result has the exchange's ID; that attributes the
  record but is not a success status. OKX `transfer` returns `status: null`; Bybit's
  `status: "ok"` means only `retCode 0`, and KuCoin's is filled in by ccxt
  ([transfer proof](exchanges.md#transfer-proof)).
- The form has no PLAN-ID and no plan expiry, so the skill shows them before the call
  ([SKILL.md, 2.5](../SKILL.md#25-executing-each-write)). The server enforces only the form's
  answer; argument and expiry checks are procedural
  ([trust model](security.md#trust-model)).

## Journal

- Path: `$XDG_CACHE_HOME/ccxt-mcp/journal/YYYY-MM.jsonl`, by default
  `~/.cache/ccxt-mcp/journal/YYYY-MM.jsonl` of the user the server runs as. **The journal is
  shared** by all profiles of that user.
- The daily cap (`maxDailyValue`) and intents are keyed by **alias**. Aliases must therefore
  be unique across all profiles, or caps and records get mixed.
- `unresolvedIntents` are intents without `result` or `error`, which means only those cut off
  by a process crash, across all aliases (also aliases this server does not configure).
  `UNKNOWN_OUTCOME` and host timeouts do not appear there. The server reads only the current
  and the previous month's file, so an old entry drops off the list without being resolved.
  `get_safety_status` also returns the `journal` path. The skill treats any entry as a
  terminal write hold ([SKILL.md, Step 0](../SKILL.md#step-0-preflight-read-only)).

## Limitations

- `dryRun: true` is honored only by `withdraw`, `transfer`, `create_order` and `edit_order`.
  `get_deposit_address` on a dryRun account sent a real signed request (the test guard
  stopped it), and it falls back to `createDepositAddress` without a form. The skill never
  calls it. A dryRun response is a local preview: the exchange checks no balance, wallets or
  minimums, and the final request is not built.
- Some `info` payloads are lossy or absent. OKX `fetchDepositWithdrawFee` keeps one row (the last
  chain) under `info`, so OKX network data comes from the raw currency rows. WhiteBIT
  `fetchBalance` returns no `info` at all, and its raw balance read is a POST, so WhiteBIT's
  available field is not visible through these tools.
- ccxt maps some codes to a fixed wire id that the venue no longer lists (Bitget `BEP20` →
  `BSC`, while Bitget's live list says `BEP20`). For calls ccxt builds (withdrawals, gated
  reads) the skill requires that the id ccxt sends equal the venue's live id. Bitget's and
  MEXC's recipient reads therefore use their raw, funds-gated endpoints with the venue's own
  id ([recipients.md](recipients.md#bitget)).
- MEXC address rows follow MEXC's reference (`coin`, `network`, `address`, `memo`, no
  `netWork`); ccxt's `fetchDepositAddress` maps rows by `netWork`, so it is not used there.
- `withdraw` on BingX: a `walletType` key in `params` is dropped, and ccxt sends its default
  `15`. `params {"type":"fund"}` sends `walletType=1` (verified offline).
- A response over 80,000 characters: an array is truncated, and an object (for example
  `fetchCurrencies`) is replaced whole by `{"truncated":true,…}`.
- `describe_method withdraw` does not show the fee model (`paramsKeys: null`).
- `<EXCHANGEID>_<CREDENTIAL>` variables fill **every** account of that exchange in the
  process, and the host may pass its whole environment to the server
  ([`security.md`](security.md#environment-contract)).
- In the upstream README, "Unregistered tiers do not even appear" holds only with
  `hideDisabledTools: true`. `mcp/server.json` at the 0.1.3 gitHead says version 0.1.2.

## Verification

2026-11-24, scratch only, no real keys, no live writes.

Setup: isolated `HOME`/`XDG_*`, synthetic `SYNTHETIC-…` values, config at `chmod 600`. For
writes, the server ran in a network namespace without interfaces (`unshare -rn`), and
`Exchange.prototype.fetch` was replaced by a recorder that never sends. Public reads used no
keys, and a guard allowed only unsigned GET plus Hyperliquid's public `POST /info`.

| Check | Result |
|---|---|
| pin install, `npm ls --all`, `audit signatures` | one copy of `ccxt@4.5.85`; 24 packages with verified attestations |
| `tools/list` (SDK 1.32.2) | 32 tools with `hideDisabledTools: false`; `call_read_method` requires `["exchange","method"]` |
| `call_read_method` without `exchange` | `-32602 … Required at exchange` |
| `get_safety_status` | `0.1.3` / `ccxtVersion 4.5.84`; `configProblems: []` at `chmod 600` |
| `withdraw` on 9 exchanges, codes `TRC20`/`BEP20`/`ERC20`/`TON` + memo, offline | requests as in the [outbound withdraw table](exchanges.md#outbound-withdraw); OKX sends `fee` from `params`; Bybit reads `GET /v5/user/query-api` and `/v5/account/info` before the write; Bitget reads `GET /api/v3/account/settings` |
| same with ccxt 4.5.94 (control) | OKX without chain and `fee`, Bybit and Gate without chain; KuCoin memo split per character |
| `params.chain:"ETH"` on Bybit with `network:"BEP20"` | `chain: ETH` is sent |
| `ARBONE` and BingX codes with substituted live data | `ARBONE` comes from live data and cannot be verified offline. BingX: with a live row whose `network` equals the code, the request carries that id (BEP20, ERC20, TON exercised; repair pack below), with `params {"type":"fund"}` → `walletType=1` and memo as `addressTag` |
| `transfer` on 9 exchanges, offline | expected wallets; KuCoin reads `GET /api/ua/v1/account/mode` before the write |
| token (sandbox, dryRun) | different `params` → `CONFIRM_MISMATCH`; reuse → `CONFIRM_INVALID`; after 61.5 s → `CONFIRM_EXPIRED`; identical → `dryRun: true`; 100 > 50 → `TRANSFER_VALUE_CAP` |
| `amount` in `withdraw`/`transfer` on 9 exchanges, mocked currency data (currency step `0.0001`, network `0.00001` and vice versa), `10.12349` | as in the [amount step table](exchanges.md#amount-steps); Gate `withdraw` → `10.1235` |
| deposit parsing, mocked raw records | WhiteBIT: unified `txid` = internal `transactionId`, hash only in `info.transactionHash`; KuCoin: `info.chain: "bsc"`, `network: "BEP20"` |
| dispatch cut off after `intent` | `UNKNOWN_OUTCOME`; `unresolvedIntents: []` |
| OKX `transfer` → `fetchTransfer` / `fetchTransfers`, mocked responses (`call_read_method`, `includeInfo`) | `transfer` result `id` = `transId`, `status: null`; `fetchTransfer` raw `state` `success` / `pending` / `failed` → `ok` / `pending` / `failed`; empty `data` → all fields `null`; `fetchTransfers` `id` = `billId` ([transfer proof](exchanges.md#transfer-proof)) |
| `transfer` + proof read on 9 exchanges, token flow, `unshare -rn`, mocked raw responses with success / pending / failed / missing plus an unrelated record of the same amount (this revision) | as in the [transfer proof table](exchanges.md#transfer-proof): Binance read sends `type=FUNDING_MAIN`, default `MAIN_UMFUTURE`; Bybit `transferId` filter, transfer result `status: "ok"` while raw status was `PENDING`; Bitget `fromType=spot`, `uta` not sent; BingX `GET /api/v3/asset/transferRecord?transferId=…`, no params → `EXCHANGE_ERROR`; MEXC no params → `BAD_REQUEST`, `fetchTransfer` → `asset/internal/transfer/record?transact_id=…`; KuCoin ledger `id` ≠ `orderId`, `status: null`; Gate empty body → `id: null`; Gate and WhiteBIT `fetchTransfers` → `NOT_SUPPORTED`; WhiteBIT `withdraw` `id` = the `uniqueId` sent; 39 requests recorded, none unmocked |
| Bybit deposit address, `unshare -rn`, synthetic keys, mocked responses (previous revision) | `fetchDepositAddressesByNetwork` with `network` sends only `GET /v5/asset/deposit/query-address` (`chainType` `TRX`/`BSC`/`ETH`/`TON`); TON memo in raw `tagDeposit`, empty `tagDeposit` → unified `tag: null`; empty result → `data: {}`, and `get_deposit_address` → `NOT_SUPPORTED`, no create request; `query-api` shows `apiKey` as `[redacted:apiKey]`; no `funds`, `"funds": true` on live, or no `maxTransferValue` → `TIER_DISABLED` (the last two also in `configProblems`); no key → `requires "apiKey" credential`, no signed request sent; `10003` and `10005` → `AUTH_FAILED`; no non-GET request |
| Bybit address checks, real SDK client over stdio, `unshare -rn`, synthetic keys, mocked responses (this revision) | two raw `BSC` entries `0x1111…`/`0x2222…` → `fetchDepositAddressesByNetwork` `data` has one `BEP20` entry `0x2222…`, raw `privateGetV5AssetDepositQueryAddress` shows both; `ERC20` request answered with a `BSC` entry → `data` keyed `BEP20`, raw `chain` `BSC`; TON memo `987654321` and TRC20 `""` equal in both reads; empty → `data: {}`, raw `chains: []`; account without `funds`: gated read `TIER_DISABLED`, raw read returns the address; no accounts with `hideDisabledTools` → `list_accounts` not listed, `get_safety_status` `accounts: []`, key check `UNKNOWN_ACCOUNT`; coin list `10005` → network read and key check both `AUTH_FAILED` `10005`, only one request (`/v5/asset/coin/query-info`) in the whole process; coin list ok, `query-api` `10005` → network read ok, key check `10005` with `GET /v5/user/query-api`; no key → address read `requires "apiKey" credential`; 0 non-GET, 0 unmocked requests |
| 2026-11-25 `fundkit-native` pack (previous revision): correction | That pack drove the calls but did not enforce the route gates. Its "57 full runs" skipped the deposit-minimum, deposit-fee, contract, outbound-id and step gates, and its synthetic TON address failed the TON checksum (workchain 4). Those runs are superseded by the repair pack below |
| repair pack, 2026-11-25 (`fundkit-repair-results`, previous revision) | 212 scenarios, 1294 checks, 0 failures; its expected outcomes were not fixed before the run, and independent probes found four routes it settled that should hold (wrong receipt chain, Bybit cap changed at recheck, settlement without funds, Binance questionnaire). Superseded by the adjudicated pack below |
| adjudicated pack, 2026-11-25 (`fundkit-adjudicated-results`, previous revision): correction | 291 scenarios, 3698 checks, 0 failures, but its report called 18 routes "settled on documented facts alone". All 18 used the setup record's interactive-form and registration lines, 12 a whitelist entry from the setup record, 10 an entity line and 3 key scope from the setup record. Its BingX minimum hold was wrong (BingX's official docs define `depositMin`), and two independent probes showed Binance and Gate saved-address rows that differ only in letter case settling with a withdrawal and a transfer. Superseded by the BingX pack below |
| BingX pack, 2026-11-25 (`fundkit-bingx-results`): setup | as in the adjudicated pack: real SDK client over stdio, one MCP client per server, `unshare -rn`, fixture transport with phase-keyed responses, synthetic keys only in each profile's `chmod 600` `config.json`, separate `HOME` per server only to keep journals apart (no isolation claim). The reference planner evaluates every gate as a named predicate (`P01`…`P35` without `P06`, `Q01`…`Q03`, `S01`…`S08`) and records every non-live fact it relied on as common setup, venue-specific setup or per-plan fact. Expected outcome, hold phase, exact failed set (where claimed) and, for settled routes, the venue-specific setup kinds are written into the plan from documented facts before the run. 381 scenarios, 5422 checks, 0 failures. A first full run (380 scenarios) had 23 failing checks: the fixed expectation table had omitted that WhiteBIT as B takes its IP allowlist from the setup record (no key read exists; the planner was right, the table was corrected), and MEXC deposits failed the receipt gate because ccxt 4.5.85 reports MEXC's unified deposit network as `BSC` or the raw long string; the rule now compares MEXC's raw `network` with the config row's string, with a new negative test, and everything was rerun |
| BingX pack: 72 directed routes | 36 settle after the one-time setup (A ∈ Binance, Bybit, Gate, OKX, Bitget, BingX, MEXC, KuCoin → B ∈ Bybit, OKX, Bitget, BingX, WhiteBIT), each on the common setup plus at least one venue-specific fact; 36 hold with zero money-moving calls (B minimum Binance, MEXC, multi-chain Gate; B fee KuCoin; WhiteBIT source). A second run of the 32 pairs whose B minimum or fee has no documented source, with a per-plan human-read fact: 28 settle, 4 hold (WhiteBIT source). Settled routes: full recheck, one withdrawal with the documented network id, address, memo and amount on the wire, A record by id, B deposit by hash, settlement plan `<PLAN-ID>-B` on Bybit, OKX, Bitget and BingX |
| BingX pack: new gates | BingX `depositMin` of the chosen row (missing, `null`, `"1,5"`, `"-1"`, above the credit, TRC20 row 500 → hold; another chain's row 500 → settles; changed or `depositEnable: false` at the recheck → `P30`, `depositEnable: false` at planning → `P13`); per-plan facts (fresh → settles; 20 or 16 min old, no source, changed or not restated at the recheck, disagreeing with a documented value → hold); Binance and Gate saved-address rows upper-cased → `P23` with zero wire writes, exact rows settle; entity rule (Italy, Germany, France, Poland, unknown entity, regional entity name, missing or non-ISO jurisdiction, Bybit India, Bybit EU, OKX TR, WhiteBIT Norway → hold; `Binance.com` in an unlisted jurisdiction settles); deposit-only profile with `dryRun: false` beside a settlement registration → `P35`; MEXC key rights (source without `SPOT_WITHDRAW_WRITE`, deposit-only without `SPOT_WITHDRAW_READ` or with `SPOT_WITHDRAW_WRITE`) → `P08`; TON standard base64 → verified, mixed alphabets → `P18` |
| BingX pack: probes | the adjudicated pack's 12 probes as before, plus the independent review's second round run unchanged on the regenerated plan (`mkprobes.py`, `mkprobes2.py`): settlement UID differs → `S02` (that gate is withdrawn since 2026-11-26: fundkit and the skill compare no UIDs), A receipt with another asset → `Q01`, OKX duplicate selected rows on another chain → read verified, chosen chain with another currency → `P17`, Bybit cap missing at the recheck → `P30`, Binance entity in Italy → `P24`, settlement funds one step short → `S04`, dispatch at minute 16 → `P29`, Binance and Gate saved-address rows upper-cased → `P23` |
| BingX pack: inherited checks | every gate scenario of the adjudicated pack, rerun on the new record shape: recheck changes (fee, address, Bybit cap −1 → 1, deposits disabled, minimum raised, contract, memo flag, balance) hold with no `withdraw` call; receipts with another chain or asset hold after exactly one withdrawal with no settlement-phase call; settlement without approval, with another plan id, expired, declined, without funds, above the cap or with a changed credit sends no transfer. 36 recipient reads (Bitget raw read with the live id, `BSC` never sent; MEXC raw read with the config row's `network` string; OKX multi-chain filtered to `ccy`, chain and `selected`) and the recipient gates; Gate `tx_id` and Binance `tranId` transfer proofs, Bybit read-only key refused |
| journal with a crash-cut intent for an alias not in this config, plus one two months old (this revision) | `unresolvedIntents` lists the foreign alias; the two-month-old intent is not listed |
| Bybit `fetchDeposits`, two records with the same amount and network, different hashes (this revision) | raw status `1` → `pending`, `3` → `ok`, `4` → `fail`; only the hash tells the records apart |
| two servers, aliases `okx-test` and `okx-sub`, one launch environment | both sign with the same `OK-ACCESS-KEY`; OKX `fetchAccounts` gives `id` = raw `uid`, plus raw `label` and `perm` |
| registrations in scratch homes | Codex: `enabled = false` → `codex mcp list` shows `disabled`; `codex mcp get` prints the registration, not a connection. Claude Code: `claude mcp remove <name> -s user` removes it; `claude mcp list` health-checks |
| public `fetchCurrencies` | Bitget, WhiteBIT, KuCoin, Gate → truncation marker; Binance, Bybit, OKX, MEXC, BingX → `{}` |
| public `fetchDepositWithdrawFee USDT includeInfo` | Bitget and WhiteBIT: flags, minimums and fees in `info`; BingX `null`; the rest `AUTH_FAILED` |
| `call_implicit_get` | Gate `publicWalletGetCurrencyChains`, KuCoin `publicGetCurrenciesCurrency` → data; snake_case → `UNKNOWN_ENDPOINT` |
| Hyperliquid `fetchBalance` | `info.marginSummary`, `crossMaintenanceMarginUsed`, `withdrawable` only with `includeInfo` |
| server environment (a dummy server that records variable **names** only) | Claude Code 2.1.331: every server got the full host environment, including other accounts' prefixed and raw names; Codex 0.172.0: each server got only its own `env_vars` |
| fundkit session profiles ([scheme D](security.md#scheme-d-session-only-doppler-profiles-optional)), `tests/test_session_lifecycle.py`, `test_credentials.py`, `test_roles.py`, 2026-11-26 | Synthetic values only. Mock Doppler on loopback holding exactly `<EX>_APIKEY`/`<EX>_SECRET` for all nine venues plus decoys (`OKX_PASSWORD`, `OKX_SOURCE_APIKEY`, `OKX_SOURCE_PASSWORD`, `BYBIT_DEPOSIT_APIKEY`, an unrelated secret); private terminals on real pseudo-terminals (`pty.fork`); a simulated MCP host; a synthetic ccxt-mcp. **Names**: every one of the 72 directed routes lists exactly the two plain names per profile, a passphrase note on OKX, Bitget and KuCoin only; connects fetch exactly `<EX>_APIKEY,<EX>_SECRET` after the metadata check, never a decoy and never a third name; old role-suffixed names alone → `MISSING_SECRETS` with the plain names, nothing started. Each child's environment holds exactly `PATH HOME LANG CCXT_MCP_CONFIG` plus its own names (plus `<EX>_PASSWORD` on the three passphrase venues), with matching value hashes; no `DOPPLER_*`, no token, not the host shell's `OKX_APIKEY`/`OKX_PASSWORD`. **Passphrase**: OKX, Bitget and KuCoin each answer `PASSPHRASE_NEEDED`, the session terminal prompts, the typed value (KuCoin's with a space) reaches only that exchange's processes; asked once per exchange and session across roles; Ctrl-C and an empty line → `PASSPHRASE_CANCELLED` once, the session survives, the next connect asks again; `--passphrase okx,bitget -- <host>` asks before the host; with `-- <host>` and no up-front value, `fundkit passphrase okx` from a second pseudo-terminal supplies it; a host-attached socket client cannot set one; the session's end forgets it. No echo; no value in the host transcript, broker stderr, `/proc/<pid>/environ` of the broker or the session, or any file. **Roles**: OKX → Bybit and Bybit → OKX in one session use the same key hashes for `okx-src`/`okx-dst` and `bybit-src`/`bybit-dst`; `okx-dst` stays `dryRun`, reads its recipient only after its key check, and gets `ROLE_DENIED` for `withdraw` and `transfer`; `okx-src` gets `ROLE_DENIED` for a recipient read. On deposit-only, 13 write and off-list surfaces (`withdraw`, `transfer`, `get_deposit_address`, `call_write_method`, `call_implicit_write`, `create_order`, `call_read_method createDepositAddress`/`fetchWithdrawals`, `call_implicit_get privatePost…`/withdraw history, `get_orders`, another exchange, another account) are refused and only the key check reaches the server. Settlement: `withdraw` and recipient reads refused, `transfer` forwarded. **No UID binding** (revised 2026-11-26): money moves take no `uid`; another `account` → `WRONG_ACCOUNT`, no form opened; without `uid` → form → dispatch; an older caller's `uid`, even one that differs from the key metadata, is ignored and never reaches ccxt-mcp; `fundkit_write`'s schema has no `uid`. A key check whose metadata names another UID mid-session changes nothing (recipient read and withdraw proceed); `fundkit status` shows `keyChecked`, no UID. Before a key check, Binance `withdraw` → `KEY_CHECK_REQUIRED` (message names `sapiGetAccountApiRestrictions`, no UID); a failed key check keeps it closed; a successful one opens it. The UID-only reads (Binance `privateGetAccount`, BingX `accountV1PrivateGetUid`, MEXC `spotPrivateGetUid`) → `NOT_FORWARDED`, none reaches the server; BingX and MEXC withdraw after their permission reads. A raw socket client gets the same `ROLE_DENIED` (also with an old `uid` in its call) and `-32601` for a non-MCP-tool method. Gate's provisioning read → `PROVISIONING_NOT_AUTHORIZED` without `--allow-provisioning gate`, `KEY_CHECK_REQUIRED`, then forwarded. WhiteBIT (no key read): source `withdraw` reaches the native form (decline → `CONFIRM_DECLINED`, accept → dispatch), settlement `transfer` dispatches, settlement and deposit-only `withdraw` → `ROLE_DENIED`; `venueScope` keeps the source-balance route limit. **Kept from the previous revision**: no setup (0 Doppler requests), profiles already connected (no socket), the native form (decline, accept, no answer → "outcome is unknown"), redaction (raw, JSON-escaped, URL-encoded, also of the passphrase), expired token → exit 3 and reconnect of the running host, cancel / personal / unknown token / no terminal, Doppler ignoring the filter and `503`, `--ttl`, `SIGHUP`, `fundkit stop`, `-- <host>` without `DOPPLER_TOKEN`, `ALIAS_IN_USE`, usage errors before any prompt, file scans after each test |
| fundkit with the pinned ccxt-mcp 0.1.3 (`tests/test_real_ccxt_mcp.py`, `unshare -rn`, loopback only), 2026-11-26 | The real server behind the session, with ccxt's `Exchange.prototype.fetch` replaced by a test-only recorder (`tests/real_ccxt_recorder.mjs`): it stores the method, path and a sha256 of the key header, answers GETs locally (the two key checks with metadata that also names a synthetic UID) and sends nothing. Each child's `/proc/<pid>/environ` holds exactly its own names and values, `OKX_PASSWORD` the typed passphrase. `get_safety_status` reports `0.1.3`/`4.5.84`, `configProblems: []`, `elicitationSupported: true` and `configPath` `…/profiles/okx-src/config.json`. The OKX `account/config` and Bybit `query-api` key checks are signed with each profile's own key; `fundkit status` shows `keyChecked: true` for both and neither UID. `withdraw` 5 USDT without a `uid`: form forwarded, decline → `CONFIRM_DECLINED`, accept → `dryRun` preview. 300 USDT → `TRANSFER_VALUE_CAP` with no form. `withdraw` on `bybit-dst` → `ROLE_DENIED`. Only GETs were built |
| fundkit install, scratch `HOME`, Claude Code 2.1.332 and Codex 0.172.0 | `claude mcp list` → `fundkit … ✔ Connected` (lazy: no session needed). `codex mcp get fundkit` → `tool_timeout_sec: 420`, `env: -`. Both skill links are created. A second run leaves everything unchanged |

Verified earlier on the same ccxt-mcp 0.1.3 (the logic does not depend on ccxt): the native
form (`decline` / `accept`, schema has only `confirm: boolean`), a host timeout does not stop
the dispatch, `get_deposit_address` on a dryRun account signs the request, and server
registration in Claude Code 2.1.331 and Codex 0.172.0 ([`security.md`](security.md#host-registration)).

Not verified (no keys, by design): real accounts, modes, available-amount fields, fee models,
whitelists, exchange responses to writes, actual withdrawals and deposits. The fixture
responses were shaped from venue references and ccxt's parsers, not captured from accounts.
Network ids for Bitget, KuCoin, Gate and WhiteBIT were compared with their keyless public
endpoints. Still unverified against real accounts are, among others, the Binance
address-list shapes, Bitget `authorities` values, BingX permission codes and live `depositMin`
values, OKX settlement key `perm` values, WhiteBIT `required` fields, MEXC key rights,
and the KuCoin v3 list. No second OS user
or container was used, and host isolation was not tested. The planner does not model account
modes (it reads the wallets the fixtures name). No settled fixture route shows
operational readiness on a real account.
