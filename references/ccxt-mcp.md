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
| `withdraw` on each supported exchange, codes `TRC20`/`BEP20`/`ERC20`/`TON` + memo, offline | requests as in the [outbound withdraw table](exchanges.md#outbound-withdraw); OKX sends `fee` from `params`; Bybit reads `GET /v5/user/query-api` and `/v5/account/info` before the write; Bitget reads `GET /api/v3/account/settings` |
| same with ccxt 4.5.94 (control) | OKX without chain and `fee`, Bybit and Gate without chain; KuCoin memo split per character |
| `params.chain:"ETH"` on Bybit with `network:"BEP20"` | `chain: ETH` is sent |
| `ARBONE` with substituted live data | `ARBONE` comes from live data and cannot be verified offline |
| `transfer` on each supported exchange, offline | expected wallets; KuCoin reads `GET /api/ua/v1/account/mode` before the write |
| token (sandbox, dryRun) | different `params` → `CONFIRM_MISMATCH`; reuse → `CONFIRM_INVALID`; after 61.5 s → `CONFIRM_EXPIRED`; identical → `dryRun: true`; 100 > 50 → `TRANSFER_VALUE_CAP` |
| `amount` in `withdraw`/`transfer` on each supported exchange, mocked currency data (currency step `0.0001`, network `0.00001` and vice versa), `10.12349` | as in the [amount step table](exchanges.md#amount-steps); Gate `withdraw` → `10.1235` |
| deposit parsing, mocked raw records | WhiteBIT: unified `txid` = internal `transactionId`, hash only in `info.transactionHash`; KuCoin: `info.chain: "bsc"`, `network: "BEP20"` |
| dispatch cut off after `intent` | `UNKNOWN_OUTCOME`; `unresolvedIntents: []` |
| OKX `transfer` → `fetchTransfer` / `fetchTransfers`, mocked responses (`call_read_method`, `includeInfo`) | `transfer` result `id` = `transId`, `status: null`; `fetchTransfer` raw `state` `success` / `pending` / `failed` → `ok` / `pending` / `failed`; empty `data` → all fields `null`; `fetchTransfers` `id` = `billId` ([transfer proof](exchanges.md#transfer-proof)) |
| `transfer` + proof read on each supported exchange, token flow, `unshare -rn`, mocked raw responses with success / pending / failed / missing plus an unrelated record of the same amount (this revision) | as in the [transfer proof table](exchanges.md#transfer-proof): Binance read sends `type=FUNDING_MAIN`, default `MAIN_UMFUTURE`; Bybit `transferId` filter, transfer result `status: "ok"` while raw status was `PENDING`; Bitget `fromType=spot`, `uta` not sent; MEXC no params → `BAD_REQUEST`, `fetchTransfer` → `asset/internal/transfer/record?transact_id=…`; KuCoin ledger `id` ≠ `orderId`, `status: null`; Gate empty body → `id: null`; Gate and WhiteBIT `fetchTransfers` → `NOT_SUPPORTED`; WhiteBIT `withdraw` `id` = the `uniqueId` sent; no unmocked request |
| Bybit deposit address, `unshare -rn`, synthetic keys, mocked responses (previous revision) | `fetchDepositAddressesByNetwork` with `network` sends only `GET /v5/asset/deposit/query-address` (`chainType` `TRX`/`BSC`/`ETH`/`TON`); TON memo in raw `tagDeposit`, empty `tagDeposit` → unified `tag: null`; empty result → `data: {}`, and `get_deposit_address` → `NOT_SUPPORTED`, no create request; `query-api` shows `apiKey` as `[redacted:apiKey]`; no `funds`, `"funds": true` on live, or no `maxTransferValue` → `TIER_DISABLED` (the last two also in `configProblems`); no key → `requires "apiKey" credential`, no signed request sent; `10003` and `10005` → `AUTH_FAILED`; no non-GET request |
| Bybit address checks, real SDK client over stdio, `unshare -rn`, synthetic keys, mocked responses (this revision) | two raw `BSC` entries `0x1111…`/`0x2222…` → `fetchDepositAddressesByNetwork` `data` has one `BEP20` entry `0x2222…`, raw `privateGetV5AssetDepositQueryAddress` shows both; `ERC20` request answered with a `BSC` entry → `data` keyed `BEP20`, raw `chain` `BSC`; TON memo `987654321` and TRC20 `""` equal in both reads; empty → `data: {}`, raw `chains: []`; account without `funds`: gated read `TIER_DISABLED`, raw read returns the address; no accounts with `hideDisabledTools` → `list_accounts` not listed, `get_safety_status` `accounts: []`, key check `UNKNOWN_ACCOUNT`; coin list `10005` → network read and key check both `AUTH_FAILED` `10005`, only one request (`/v5/asset/coin/query-info`) in the whole process; coin list ok, `query-api` `10005` → network read ok, key check `10005` with `GET /v5/user/query-api`; no key → address read `requires "apiKey" credential`; 0 non-GET, 0 unmocked requests |
| documented-flow route packs, 2026-11-25 (previous revisions) | Their scenario and route counts predate the current venue set and the [current deposit minimum rule](deposit-minimum.md), so they are not reported here. The documented flows (agent procedures) have not been re-run since, and no route count is claimed for them. The current measured evidence is the fundkit test suite below |
| journal with a crash-cut intent for an alias not in this config, plus one two months old (this revision) | `unresolvedIntents` lists the foreign alias; the two-month-old intent is not listed |
| Bybit `fetchDeposits`, two records with the same amount and network, different hashes (this revision) | raw status `1` → `pending`, `3` → `ok`, `4` → `fail`; only the hash tells the records apart |
| two servers, aliases `okx-test` and `okx-sub`, one launch environment | both sign with the same `OK-ACCESS-KEY`; OKX `fetchAccounts` gives `id` = raw `uid`, plus raw `label` and `perm` |
| registrations in scratch homes | Codex: `enabled = false` → `codex mcp list` shows `disabled`; `codex mcp get` prints the registration, not a connection. Claude Code: `claude mcp remove <name> -s user` removes it; `claude mcp list` health-checks |
| public `fetchCurrencies` | Bitget, WhiteBIT, KuCoin, Gate → truncation marker; Binance, Bybit, OKX, MEXC → `{}` |
| public `fetchDepositWithdrawFee USDT includeInfo` | Bitget and WhiteBIT: flags, minimums and fees in `info`; the rest `AUTH_FAILED` |
| `call_implicit_get` | Gate `publicWalletGetCurrencyChains`, KuCoin `publicGetCurrenciesCurrency` → data; snake_case → `UNKNOWN_ENDPOINT` |
| Hyperliquid `fetchBalance` | `info.marginSummary`, `crossMaintenanceMarginUsed`, `withdrawable` only with `includeInfo` |
| server environment (a dummy server that records variable **names** only) | Claude Code 2.1.331: every server got the full host environment, including other accounts' prefixed and raw names; Codex 0.172.0: each server got only its own `env_vars` |
| fundkit session profiles ([scheme D](security.md#scheme-d-session-only-doppler-profiles-optional)), `tests/test_session_lifecycle.py`, `test_credentials.py`, `test_roles.py`, 2026-11-26, rerun 2026-11-27 on the current eight venues | Synthetic values only. Mock Doppler on loopback holding exactly `<EX>_APIKEY`/`<EX>_SECRET` for all eight venues plus decoys (`OKX_PASSWORD`, `OKX_SOURCE_APIKEY`, `OKX_SOURCE_PASSWORD`, `BYBIT_DEPOSIT_APIKEY`, an unrelated secret); private terminals on real pseudo-terminals (`pty.fork`); a simulated MCP host; a synthetic ccxt-mcp. **Venues**: the venue registries hold exactly Binance, Bybit, Gate, OKX, Bitget, WhiteBIT, MEXC and KuCoin (passphrase venues OKX, Bitget, KuCoin; key checks on all but WhiteBIT); other ccxt ids, near misses of supported ids, an alias used as a name and Hyperliquid → `UNKNOWN_EXCHANGE` on every role, `fundkit_profiles` marks them unsupported with no Doppler names, `--passphrase`, `--allow-provisioning` and `fundkit passphrase` refuse them before any prompt; with Doppler names and a stray ccxt-mcp profile present for an unlisted venue, its alias → `UNKNOWN_ALIAS` on `fundkit_read` and `fundkit_write`, and its name or alias through a connected profile → `WRONG_EXCHANGE`/`WRONG_ACCOUNT`; zero Doppler secret requests, servers started or calls forwarded for it. **Names**: every one of the 56 directed routes lists exactly the two plain names per profile, a passphrase note on OKX, Bitget and KuCoin only; connects fetch exactly `<EX>_APIKEY,<EX>_SECRET` after the metadata check, never a decoy and never a third name; old role-suffixed names alone → `MISSING_SECRETS` with the plain names, nothing started. Each child's environment holds exactly `PATH HOME LANG CCXT_MCP_CONFIG` plus its own names (plus `<EX>_PASSWORD` on the three passphrase venues), with matching value hashes; no `DOPPLER_*`, no token, not the host shell's `OKX_APIKEY`/`OKX_PASSWORD`. **Passphrase**: OKX, Bitget and KuCoin each answer `PASSPHRASE_NEEDED`, the session terminal prompts, the typed value (KuCoin's with a space) reaches only that exchange's processes; asked once per exchange and session across roles; Ctrl-C and an empty line → `PASSPHRASE_CANCELLED` once, the session survives, the next connect asks again; `--passphrase okx,bitget -- <host>` asks before the host; with `-- <host>` and no up-front value, `fundkit passphrase okx` from a second pseudo-terminal supplies it; a host-attached socket client cannot set one; the session's end forgets it. No echo; no value in the host transcript, broker stderr, `/proc/<pid>/environ` of the broker or the session, or any file. **Roles**: OKX → Bybit and Bybit → OKX in one session use the same key hashes for `okx-src`/`okx-dst` and `bybit-src`/`bybit-dst`; `okx-dst` stays `dryRun`, reads its recipient only after its key check, and gets `ROLE_DENIED` for `withdraw` and `transfer`; `okx-src` gets `ROLE_DENIED` for a recipient read. On deposit-only, 13 write and off-list surfaces (`withdraw`, `transfer`, `get_deposit_address`, `call_write_method`, `call_implicit_write`, `create_order`, `call_read_method createDepositAddress`/`fetchWithdrawals`, `call_implicit_get privatePost…`/withdraw history, `get_orders`, another exchange, another account) are refused and only the key check reaches the server. Settlement: `withdraw` and recipient reads refused, `transfer` forwarded. **No UID binding** (revised 2026-11-26): money moves take no `uid`; another `account` → `WRONG_ACCOUNT`, no form opened; without `uid` → form → dispatch; an older caller's `uid`, even one that differs from the key metadata, is ignored and never reaches ccxt-mcp; `fundkit_write`'s schema has no `uid`. A key check whose metadata names another UID mid-session changes nothing (recipient read and withdraw proceed); `fundkit status` shows `keyChecked`, no UID. Before a key check, Binance `withdraw` → `KEY_CHECK_REQUIRED` (message names `sapiGetAccountApiRestrictions`, no UID); a failed key check keeps it closed; a successful one opens it. The UID-only reads (Binance `privateGetAccount`, MEXC `spotPrivateGetUid`) → `NOT_FORWARDED`, none reaches the server; MEXC withdraws after its permission read. A raw socket client gets the same `ROLE_DENIED` (also with an old `uid` in its call) and `-32601` for a non-MCP-tool method. Gate's provisioning read → `PROVISIONING_NOT_AUTHORIZED` without `--allow-provisioning gate`, `KEY_CHECK_REQUIRED`, then forwarded. WhiteBIT (no key read): source `withdraw` reaches the native form (decline → `CONFIRM_DECLINED`, accept → dispatch), settlement `transfer` dispatches, settlement and deposit-only `withdraw` → `ROLE_DENIED`; `venueScope` keeps the source-balance route limit. **Kept from the previous revision**: no setup (0 Doppler requests), profiles already connected (no socket), the native form (decline, accept, no answer → "outcome is unknown"), redaction (raw, JSON-escaped, URL-encoded, also of the passphrase), expired token → exit 3 and reconnect of the running host, cancel / personal / unknown token / no terminal, Doppler ignoring the filter and `503`, `--ttl`, `SIGHUP`, `fundkit stop`, `-- <host>` without `DOPPLER_TOKEN`, `ALIAS_IN_USE`, usage errors before any prompt, file scans after each test |
| fundkit with the pinned ccxt-mcp 0.1.3 (`tests/test_real_ccxt_mcp.py`, `unshare -rn`, loopback only), 2026-11-26 | The real server behind the session, with ccxt's `Exchange.prototype.fetch` replaced by a test-only recorder (`tests/real_ccxt_recorder.mjs`): it stores the method, path and a sha256 of the key header, answers GETs locally (the two key checks with metadata that also names a synthetic UID) and sends nothing. Each child's `/proc/<pid>/environ` holds exactly its own names and values, `OKX_PASSWORD` the typed passphrase. `get_safety_status` reports `0.1.3`/`4.5.84`, `configProblems: []`, `elicitationSupported: true` and `configPath` `…/profiles/okx-src/config.json`. The OKX `account/config` and Bybit `query-api` key checks are signed with each profile's own key; `fundkit status` shows `keyChecked: true` for both and neither UID. `withdraw` 5 USDT without a `uid`: form forwarded, decline → `CONFIRM_DECLINED`, accept → `dryRun` preview. 300 USDT → `TRANSFER_VALUE_CAP` with no form. `withdraw` on `bybit-dst` → `ROLE_DENIED`. Only GETs were built |
| fundkit USDT-only destination minimum (no Fundkit minimum) on the pinned ccxt-mcp 0.1.3 / ccxt 4.5.85, same recorder, `unshare -rn`, 2026-11-27 (at 198836f) | 7/7 real-server tests pass. Bybit → Binance BSC, 10 USDT + 0.15 fee on top, 812.44 available: `ready` with `minimumNotice` "Destination deposit minimum unknown. Fundkit recommends depositing at least 1 USDT." before any card or write, one card with the same line, Binance read again before it, Cancel → zero POST, a repeated confirm sends nothing. 0.5 USDT (Bybit `withdrawMin` overridden to 0.0001): one card with the notice and no POST while it is open, Cancel → zero POST. A Binance `depositMin` of 20 that appears while the card is open → `DESTINATION_RECHECK_FAILED`, zero POST. `coin: "USDC"` on `fundkit_transfer_prepare` and `fundkit_deposit_address` → `UNSUPPORTED_COIN`: no profile started, zero wire requests, no form; the same session's USDT request then asks the venues for `coin=USDT` only |
| fundkit venue allowlist against the pinned ccxt 4.5.85 catalog, same recorder, `unshare -rn`, 2026-11-27 (this revision) | 9/9 real-server tests pass (the catalog test also runs in the plan-form class that inherits it). The catalog has 104 exchange ids; each of the 96 outside the eight supported venues, Hyperliquid included, gets `UNKNOWN_EXCHANGE` from `fundkit_connect` on all three roles and `UNKNOWN_ALIAS` for a `withdraw` on its `-src` alias, with Doppler names present for every one of them: zero Doppler secret requests, zero ccxt-mcp processes and zero wire requests. The full suite in the same namespace: 92 of 93 pass, none skipped; `test_install` needs network for `npm install` and times out there (it passes in the networked run) |
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
address-list shapes, Bitget `authorities` values, OKX settlement key `perm` values, WhiteBIT `required` fields, MEXC key rights,
and the KuCoin v3 list. No second OS user
or container was used, and host isolation was not tested. The planner does not model account
modes (it reads the wallets the fixtures name). No settled fixture route shows
operational readiness on a real account.
