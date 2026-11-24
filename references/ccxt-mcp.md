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
    model can redeem the token too. Fundkit uses this branch only for internal transfers; withdrawals use the exchange UI when native confirmation is unavailable.
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
  ([SKILL.md, 2.5](../SKILL.md#25-executing-each-write)).

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
  stopped it). A dryRun response is a local preview: the exchange checks no balance, wallets
  or minimums, and the final request is not built.
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
| `ARBONE` and BingX codes with substituted live data | the value comes from live data, so it cannot be verified offline |
| `transfer` on 9 exchanges, offline | expected wallets; KuCoin reads `GET /api/ua/v1/account/mode` before the write |
| token (sandbox, dryRun) | different `params` → `CONFIRM_MISMATCH`; reuse → `CONFIRM_INVALID`; after 61.5 s → `CONFIRM_EXPIRED`; identical → `dryRun: true`; 100 > 50 → `TRANSFER_VALUE_CAP` |
| `amount` in `withdraw`/`transfer` on 9 exchanges, mocked currency data (currency step `0.0001`, network `0.00001` and vice versa), `10.12349` | as in the [amount step table](exchanges.md#amount-steps); Gate `withdraw` → `10.1235` |
| deposit parsing, mocked raw records | WhiteBIT: unified `txid` = internal `transactionId`, hash only in `info.transactionHash`; KuCoin: `info.chain: "bsc"`, `network: "BEP20"` |
| dispatch cut off after `intent` | `UNKNOWN_OUTCOME`; `unresolvedIntents: []` |
| OKX `transfer` → `fetchTransfer` / `fetchTransfers`, mocked responses (`call_read_method`, `includeInfo`) | `transfer` result `id` = `transId`, `status: null`; `fetchTransfer` raw `state` `success` / `pending` / `failed` → `ok` / `pending` / `failed`; empty `data` → all fields `null`; `fetchTransfers` `id` = `billId` ([transfer proof](exchanges.md#transfer-proof)) |
| `transfer` + proof read on 9 exchanges, token flow, `unshare -rn`, mocked raw responses with success / pending / failed / missing plus an unrelated record of the same amount (this revision) | as in the [transfer proof table](exchanges.md#transfer-proof): Binance read sends `type=FUNDING_MAIN`, default `MAIN_UMFUTURE`; Bybit `transferId` filter, transfer result `status: "ok"` while raw status was `PENDING`; Bitget `fromType=spot`, `uta` not sent; BingX `GET /api/v3/asset/transferRecord?transferId=…`, no params → `EXCHANGE_ERROR`; MEXC no params → `BAD_REQUEST`, `fetchTransfer` → `asset/internal/transfer/record?transact_id=…`; KuCoin ledger `id` ≠ `orderId`, `status: null`; Gate empty body → `id: null`; Gate and WhiteBIT `fetchTransfers` → `NOT_SUPPORTED`; WhiteBIT `withdraw` `id` = the `uniqueId` sent; 39 requests recorded, none unmocked |
| Bybit deposit address, `unshare -rn`, synthetic keys, mocked responses (previous revision) | `fetchDepositAddressesByNetwork` with `network` sends only `GET /v5/asset/deposit/query-address` (`chainType` `TRX`/`BSC`/`ETH`/`TON`); TON memo in raw `tagDeposit`, empty `tagDeposit` → unified `tag: null`; empty result → `data: {}`, and `get_deposit_address` → `NOT_SUPPORTED`, no create request; `query-api` shows `apiKey` as `[redacted:apiKey]`; no `funds`, `"funds": true` on live, or no `maxTransferValue` → `TIER_DISABLED` (the last two also in `configProblems`); no key → `requires "apiKey" credential`, no signed request sent; `10003` and `10005` → `AUTH_FAILED`; no non-GET request |
| Bybit address checks, real SDK client over stdio, `unshare -rn`, synthetic keys, mocked responses (this revision) | two raw `BSC` entries `0x1111…`/`0x2222…` → `fetchDepositAddressesByNetwork` `data` has one `BEP20` entry `0x2222…`, raw `privateGetV5AssetDepositQueryAddress` shows both; `ERC20` request answered with a `BSC` entry → `data` keyed `BEP20`, raw `chain` `BSC`; TON memo `987654321` and TRC20 `""` equal in both reads; empty → `data: {}`, raw `chains: []`; account without `funds`: gated read `TIER_DISABLED`, raw read returns the address; no accounts with `hideDisabledTools` → `list_accounts` not listed, `get_safety_status` `accounts: []`, key check `UNKNOWN_ACCOUNT`; coin list `10005` → network read and key check both `AUTH_FAILED` `10005`, only one request (`/v5/asset/coin/query-info`) in the whole process; coin list ok, `query-api` `10005` → network read ok, key check `10005` with `GET /v5/user/query-api`; no key → address read `requires "apiKey" credential`; 0 non-GET, 0 unmocked requests |
| journal with a crash-cut intent for an alias not in this config, plus one two months old (this revision) | `unresolvedIntents` lists the foreign alias; the two-month-old intent is not listed |
| Bybit `fetchDeposits`, two records with the same amount and network, different hashes (this revision) | raw status `1` → `pending`, `3` → `ok`, `4` → `fail`; only the hash tells the records apart |
| two servers, aliases `okx-test` and `okx-sub`, one launch environment | both sign with the same `OK-ACCESS-KEY`; OKX `fetchAccounts` gives `id` = raw `uid`, plus raw `label` and `perm` |
| registrations in scratch homes | Codex: `enabled = false` → `codex mcp list` shows `disabled`; `codex mcp get` prints the registration, not a connection. Claude Code: `claude mcp remove <name> -s user` removes it; `claude mcp list` health-checks |
| public `fetchCurrencies` | Bitget, WhiteBIT, KuCoin, Gate → truncation marker; Binance, Bybit, OKX, MEXC, BingX → `{}` |
| public `fetchDepositWithdrawFee USDT includeInfo` | Bitget and WhiteBIT: flags, minimums and fees in `info`; BingX `null`; the rest `AUTH_FAILED` |
| `call_implicit_get` | Gate `publicWalletGetCurrencyChains`, KuCoin `publicGetCurrenciesCurrency` → data; snake_case → `UNKNOWN_ENDPOINT` |
| Hyperliquid `fetchBalance` | `info.marginSummary`, `crossMaintenanceMarginUsed`, `withdrawable` only with `includeInfo` |
| server environment (a dummy server that records variable **names** only) | Claude Code 2.1.331: every server got the full host environment, including other accounts' prefixed and raw names; Codex 0.172.0: each server got only its own `env_vars` |

Verified earlier on the same ccxt-mcp 0.1.3 (the logic does not depend on ccxt): the native
form (`decline` / `accept`, schema has only `confirm: boolean`), a host timeout does not stop
the dispatch, `get_deposit_address` on a dryRun account signs the request, and server
registration in Claude Code 2.1.331 and Codex 0.172.0 ([`security.md`](security.md#host-registration)).

Not verified (no keys, by design): real accounts, modes, available-amount fields, fee models,
whitelists, exchange responses to writes, actual withdrawals and deposits.
