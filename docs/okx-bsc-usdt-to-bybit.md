# USDT (BSC) from mobile OKX Wallet to your own Bybit account

## Flow

```
fundkit start ──preflight (Bybit + BSC RPC)──► intent (FUNDKIT_STATE in chat)
      │
      ├─ local helper on HOST:PORT, exposed as PUBLIC_BASE_URL (https)
      │    GET  /s/<intent>            signing page (static, strict CSP, no secrets)
      │    GET  /api/intent/<intent>   public route data (token, to, amount, phase)
      │    POST …/precheck             server checks USDT balance + BNB gas via own RPC
      │    POST …/tx                   wallet tx hash captured (one per attempt)
      │
      ├─ phone: OKX universal link → OKX Wallet in-app browser → wallet review → hash
      ├─ desktop: QR of the same link
      │
      └─ settle: on-chain verify → Bybit deposit by txID → FUND→UNIFIED (only if needed) → done
```

## Checks and where they come from

| Check | Source |
|---|---|
| USDT/BSC deposits enabled, `depositMin`, `minAccuracy`, `confirmation`, `contractAddress` | `GET /v5/asset/coin/query-info?coin=USDT` (chain `BSC`) |
| Live deposit address, no tag, `batchReleaseLimit`, contract suffix | `GET /v5/asset/deposit/query-address?coin=USDT&chainType=BSC` |
| Canonical token `0x55d398326f99059fF775485246999027B3197955`, 18 decimals, symbol `USDT`, chain id 56 | Bybit `contractAddress` **and** `eth_chainId`/`eth_getCode`/`decimals()`/`symbol()` on every `BSC_RPC_URLS` endpoint |
| Wallet USDT balance and BNB gas (`estimateGas × gasPrice × 1.5`) | helper's own RPC, before Send is enabled |
| Tx: found, chain 56, `to` = USDT, no BNB value, receipt `status=1`, exactly one USDT `Transfer` log with `from = tx.from`, `to` = Bybit address, `value` = exact base units | every RPC must agree |
| Bybit credit | `GET /v5/asset/deposit/query-record?coin=USDT&txID=…`: chain BSC, `toAddress` match, `status` 3 (or 70012), `depositType` 0, `amount + depositFee` = sent amount |
| Where it landed | `GET /v5/asset/transfer/query-account-coin-balance?accountType=FUND&coin=USDT` vs. baseline captured at intent creation |
| Transfer | `POST /v5/asset/transfer/inter-transfer` FUND→UNIFIED, deterministic `transferId`; `GET /v5/asset/transfer/query-inter-transfer-list?transferId=…` before every submit |
| API key | `GET /v5/user/query-api`: read-write + `Wallet:AccountTransfer` required for UNIFIED target; warns on `Withdraw` permission or no IP whitelist |

Signing follows the [Bybit V5 guide](https://bybit-exchange.github.io/docs/v5/guide):
`HMAC_SHA256(timestamp + apiKey + recvWindow + queryString|jsonBody)` hex, headers
`X-BAPI-API-KEY / -TIMESTAMP / -SIGN / -RECV-WINDOW`, clock offset from `/v5/market/time`.

Amounts are handled as decimal strings → `BigInt` base units (no floats). The amount must fit
both token decimals (18) and Bybit `minAccuracy`.

## Duplicate protection and recovery

- **On-chain:** one hash per intent attempt. The page refuses to send if the server already has
  a hash, or if this browser already stored one for the attempt (it re-reports instead). The
  server rejects a different second hash (409) and records `second_tx_rejected` in state.
  A new attempt is only possible after the previous tx **reverted** (`tx_failed`), with
  explicit `--reattempt`, and after re-checking the live deposit address.
- **Bybit transfer:** two-phase — `transfer_prepared` (transferId printed to chat) before the
  submit. Every step looks the transferId up first; an ambiguous submit (timeout/5xx) is
  re-queried, and if the funds already left FUND it waits for the record instead of
  resubmitting. Re-submits always reuse the same transferId.
- **State:** the latest `FUNDKIT_STATE` line in chat is the only state (no SQLite, no files).
  It contains route data and the tx hash, never credentials. Everything in it is re-verified
  before it is trusted.

## Setup

```bash
npm install
cp .env.example .env        # or: doppler run -- node src/cli.js …
node src/cli.js preflight --amount 25
# expose HOST:PORT over HTTPS (e.g. on a Boat sandbox: `host 8787 --localhost`), set PUBLIC_BASE_URL
node src/cli.js start --amount 25
```

Bybit API key: create on your own account, permission **Assets → Account Transfer** only, IP
restricted, no Withdraw. `--target FUND` works with a read-only key.

## Mock acceptance

`npm test` runs everything offline: an in-memory BSC chain + JSON-RPC server, a Bybit V5 mock
that verifies HMAC signatures, and a fake EIP-1193 provider that drives the real
`public/signflow.js`. Covered: happy path, credit straight to UNIFIED, FUND target, resume from
every intermediate state line, 502 + lagging transfer list, duplicate signing (same/other
browser, second hash), tampered recipient, reverted tx + reattempt, missing gas, preflight
rejections (wrong contract, suspended route, min, precision, permissions, non-https).
`npm run demo` prints a full mock run (link, QR, state lines).

## Real-device limitations (not verified by the mocks)

- **Not tested on a real phone or with real funds.** The OKX universal link
  (`https://web3.okx.com/download?deeplink=okx://wallet/dapp/url?dappUrl=…`) follows OKX's
  App Universal Link docs; behaviour differs by OS/OKX version. If the link opens the app store
  or a plain browser, open OKX Wallet → Discover/browser and paste the `Signing page:` URL.
- The in-app browser must reach `PUBLIC_BASE_URL` over valid HTTPS; self-signed certs,
  captive portals or tunnels that inject interstitial pages (some free tunnels do) will break it.
- `window.okxwallet`/`window.ethereum` injection, `wallet_switchEthereumChain`, and returning the
  hash from `eth_sendTransaction` are standard EIP-1193 but were exercised only with a fake
  provider. If the wallet app is backgrounded/killed after broadcasting, the page may never
  report the hash: copy it from OKX Wallet history and `resume --state … --tx <hash>`.
- Wallet-side review is the user's protection against a tampered page: compare the recipient
  with the Bybit app's USDT/BSC deposit address. The helper also re-verifies after the fact, but
  cannot undo an on-chain transfer.
- Bybit behaviour on a duplicate `transferId` is not documented; the flow never relies on it
  (look-up-before-submit + balance check). Bybit `minAccuracy`, fees and limits are read live.
- Bybit credits only after its own confirmation count (`confirmation`, typically ~15 blocks on
  BSC) and may hold deposits (`depositType` 10/20/50, travel-rule) → `needs_attention`.
- Deposit-to-UTA account setting: if deposits go straight to UNIFIED, no transfer is made.
  If FUND has unrelated movement during the run, the tool errs on the side of *not*
  transferring and says so.
- The helper serves one intent per process and keeps it in memory; state survives only via chat.
