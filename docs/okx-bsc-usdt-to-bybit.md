# USDT (BSC) from mobile OKX Wallet to your own Bybit account

## Flow

```
fundkit start ──preflight (key, account, route, ≥2 RPCs)──► intent (FUNDKIT_STATE line in chat)
      │
      ├─ local helper on HOST:PORT, exposed as PUBLIC_BASE_URL (https, optional path prefix)
      │    GET  <base>/s/<intent>            signing page (static, strict CSP, relative asset URLs)
      │    GET  <base>/api/intent/<intent>   public route data (token, to, amount, phase)
      │    POST …/precheck                   USDT balance + BNB gas via own RPC (UX only)
      │    POST …/claim                      ATOMIC single signing slot, binds sender,
      │                                      re-validates account + live route → tx params
      │    POST …/tx                         hash for the claimed slot (claim token required)
      │    POST …/release                    only after the wallet reported "user rejected" (4001)
      │
      ├─ phone: OKX universal link → OKX Wallet in-app browser → claim → wallet review → hash
      ├─ desktop: QR of the same link
      │
      └─ settle (evidence only): finalized tx on every RPC → Bybit deposit record for that txID
           → FUND→UNIFIED transfer with a deterministic transferId (UNIFIED target) → done
```

The link lives only as long as the `start` (or verified `--reattempt`) process. Resuming any
checkpoint **never** serves a signing link again.

## Checks and where they come from

| Check | Source |
|---|---|
| Key → account (`userID`, bound into state), no `Withdraw`, unneeded permissions / missing IP whitelist warned | `GET /v5/user/query-api` |
| UNIFIED target: read-write key with `Wallet: AccountTransfer`, `uta = 1`, `unifiedMarginStatus ∈ {3,4,5,6}` | `GET /v5/user/query-api`, `GET /v5/account/info` |
| Key can read deposit (and, for UNIFIED, transfer) records | probe calls of the two endpoints below |
| USDT/BSC deposits enabled, `depositMin`, `minAccuracy`, `confirmation`, `contractAddress` | `GET /v5/asset/coin/query-info?coin=USDT` (chain `BSC`) |
| Live deposit address, no tag, `batchReleaseLimit`, contract suffix | `GET /v5/asset/deposit/query-address?coin=USDT&chainType=BSC` |
| Canonical token `0x55d398326f99059fF775485246999027B3197955`, 18 decimals, symbol `USDT`, chain 56 | Bybit `contractAddress` **and** `eth_chainId`/`eth_getCode`/`decimals()`/`symbol()` on every RPC |
| Same account + same live route + same amount **right before the wallet prompt** | repeated at `/claim` (and before `--reattempt`) |
| Tx: chain 56, `to` = USDT, no BNB value, calldata `transfer(Bybit address, exact amount)`, `from` = sender bound at claim, receipt status, exactly one USDT `Transfer` log matching, block ≤ `finalized` and receipt block hash canonical | every RPC in `BSC_RPC_URLS` (≥ 2 distinct hosts), all must answer and agree |
| Bybit credit | `GET /v5/asset/deposit/query-record` by `txID` (with and without `0x`), else a bounded scan (< 30 days, ≤ 5 pages × 50) from the block time; `coin`, `chain`, `toAddress`, status, `depositType`, travel-rule fields, `amount + depositFee` = sent amount within `minAccuracy` |
| Transfer | `POST /v5/asset/transfer/inter-transfer` FUND→UNIFIED, amount = **credited** amount from the live deposit record; `GET /v5/asset/transfer/query-inter-transfer-list?transferId=…&startTime&endTime` in explicit ≤ 7-day windows from the deposit's `successAt` (≤ 8 windows) |

Deposit statuses ([enum](https://bybit-exchange.github.io/docs/v5/enum#depositstatus)): `3` success and
`70012` (stays successful after rollback review) count as credited. `0/1/2/10011` wait. `7` (rollback
processing), `70013` (rollback failed, manual review), `10012` (credited to funding *pool*), any
`depositType ≠ 0` (daily limit / AML / compliance), any non-zero travel-rule field and unknown codes →
`needs_attention` (held). `4` and `70011` → failed.

Signing follows the [Bybit V5 guide](https://bybit-exchange.github.io/docs/v5/guide):
`HMAC_SHA256(timestamp + apiKey + recvWindow + queryString|jsonBody)` hex, headers
`X-BAPI-API-KEY / -TIMESTAMP / -SIGN / -RECV-WINDOW`, clock offset from `/v5/market/time`.
`BYBIT_BASE_URL` must be one of the official mainnet hosts from that guide (`api.bybit.com`,
`api.bytick.com`, `api.bybit.tr`, `api.bybit.kz`, `api.bybitgeorgia.ge`, `api.bybit.ae`, `api.bybit.eu`,
`api.bybit.id`, `api.manepa.jp`, `api.spark-fintech.com`); mocks can only be injected in code.

Amounts are decimal strings → `BigInt` base units (no floats).

## Which account did the deposit land in? (manual verification)

Bybit credits on-chain deposits to the **Funding** account by default, but the user can configure an
auto-transfer to another account ([Set Deposit Account](https://bybit-exchange.github.io/docs/v5/asset/deposit/set-deposit-acct)
is write-only; there is no documented API to read the setting). The deposit record has no account
field, and the Funding history (`/v5/asset/fundinghistory`) rows carry neither txID nor transferId.
So fundkit does **not** guess from balance deltas. Instead:

- `--target FUND`: done once the deposit record is credited (works with a read-only key).
- `--target UNIFIED`: the user confirms in the Bybit app that deposits go to Funding
  (`--confirm-fund-credit`, at `start` or later at `resume`). The account-specific evidence of the
  trading credit is Bybit's own transfer record for our `transferId` (`FUND → UNIFIED`, coin, exact
  amount, `SUCCESS`). If the deposit was auto-moved anyway, the transfer is rejected (e.g. `131212`
  insufficient balance) → `needs_attention`, never retried; check *Assets → Funding / Unified
  Trading* in the app. Residual risk: if Funding also holds other USDT of at least that amount, the
  transfer moves that amount between the user's own accounts.

## Duplicate protection and recovery

- **Signing slot.** `/claim` is a synchronous check-and-set in the helper: exactly one browser gets
  the claim (others get 409 before any wallet prompt); it binds the sender and re-validates the live
  route first. `/tx` needs the claim token; a second hash is rejected (409) and recorded as
  `second_tx_rejected`. Only an explicit wallet rejection (4001) releases the claim.
- **Stale checkpoints.** `link_issued` / `signing_claimed` lines cannot prove nothing was sent, so
  `resume` only reports (it lists matching Bybit deposits) and suggests `--tx <hash>` from OKX
  Wallet history. To pay again, start a **new** intent only after the user confirmed nothing was sent.
- **Re-attempt** (`--reattempt`) only when, at that moment: every RPC agrees the tx is finalized and
  reverted; the bound sender's `latest` and `pending` nonce are both exactly `nonce + 1` (nothing sent
  since); no other matching Bybit deposit since the intent was created; and the live route is unchanged.
  Successful, pending/unknown, replaced or disputed txs never allow it.
- **Hash correction / replacement** (`--tx <new>` when a hash is already recorded, e.g. after a wallet
  speed-up): refused if the recorded tx is a finalized success or disputed; accepted only if the new
  hash is a finalized exact transfer from the bound sender agreed by every RPC.
- **Transfer.** `transferId = uuid(intentId, txHash)`: every snapshot and every process computes the
  same id. It is printed (`transfer_prepared`) before the first POST and looked up before every POST.
  POST outcomes: `131214` ("TransferId exist", [documented](https://bybit-exchange.github.io/docs/v5/error))
  → reconcile only; documented permanent errors (e.g. `131212`, `131210`, `10005`, `10010`) →
  `needs_attention`, no further POST; timeout/5xx/other → *ambiguous*: reconcile only. After the user
  fixed the cause (or checked the app), `--retry-transfer` re-POSTs the **same** id once, only after
  the lookup still shows nothing.
- **Authenticated state.** `FUNDKIT_STATE 2.<base64url JSON>.<HMAC>` — shell-safe, schema-validated,
  MAC key derived from the Bybit API secret (or `FUNDKIT_STATE_KEY` to survive key rotation), account
  (`userID`) bound. An edited line, a line from other credentials, or another account → read-only
  recovery report, no new state line. No secrets, claim tokens or remote free text are stored; only
  numeric Bybit `retCode`s are ever shown (never `retMsg`).
- **Phase is a hint.** Each resume re-verifies the chain, re-reads the deposit record, and takes the
  transfer amount from the live record — never from the checkpoint.

### Limits of chat-carried state (no database)

- Two processes started from the same line are not coordinated. The signing slot is per helper
  process, and only `start` / a verified `--reattempt` ever serves a link, so one intent attempt has
  at most one signing page. Two concurrent `resume`s compute the same `transferId`; Bybit's `131214`
  is what prevents a second transfer.
- An **older authentic snapshot** is still authentic. The protections above (no link from resume,
  nonce + deposit checks before a reattempt, deterministic transferId + lookup) are what make it
  safe; the latest line in chat remains the one to use.
- Two separate intents for the same amount are not linked. If the user sends twice (two intents),
  fundkit cannot undo it; the agent must not start a new intent while an older one is unresolved.

## Setup

```bash
npm install
cp .env.example .env        # or: doppler run -- node src/cli.js …
node src/cli.js preflight --amount 25 --confirm-fund-credit
# expose HOST:PORT over HTTPS (e.g. on a Boat sandbox: `host 8787 --localhost`), set PUBLIC_BASE_URL
node src/cli.js start --amount 25 --confirm-fund-credit
```

Bybit API key (least privilege): your own main account, IP-restricted, **no Withdraw**.
`--target UNIFIED`: read-write with only *Assets → Wallet → Account Transfer*.
`--target FUND`: read-only, no permissions ticked. Account must be a Unified Trading Account for UNIFIED.

## Mock acceptance

`npm test` runs everything offline: an in-memory BSC chain with finality, nonces and two independent
JSON-RPC endpoints (each can lag, fail or disagree), a Bybit V5 mock that verifies HMAC signatures,
enforces query windows and pagination and returns poisoned `retMsg`s, and a fake EIP-1193 provider
driving the real `public/signflow.js`. Covered, among others: happy path, FUND target with a read-only
key, nonzero fee, unrelated FUND balance, path-prefixed base URL, concurrent claims and callbacks,
wallet reject/release, route change at claim, resume from every snapshot, 131214 from an older
snapshot, stale `link_issued`/`signing_claimed`, `--tx` attach and replacement, credential rotation /
other account / edited line, RPC disagreement, lagging/unavailable/unfinalized RPC, revert + reattempt
(and refusal from an older snapshot or after another send), held/failed/mismatched deposits, txID
without `0x`, paginated scan, ambiguous transfers (executed or not), permanent transfer errors,
preflight and config rejections, listen errors. `npm run demo` prints a full mock run.

## Not verified (real-device / real-account limitations)

- **Not tested on a real phone, a real Bybit account or with real funds.** Only mocks.
- The OKX universal link (`https://web3.okx.com/download?deeplink=okx://wallet/dapp/url?dappUrl=…`)
  follows OKX's App Universal Link docs; behaviour differs by OS/OKX version. If it opens the app store
  or a plain browser, open OKX Wallet → Discover/browser and paste the `Signing page:` URL.
- The in-app browser must reach `PUBLIC_BASE_URL` over valid HTTPS; self-signed certs, captive portals
  or tunnels that inject interstitial pages break it. Path-prefixed bases are supported whether the
  proxy strips the prefix or not.
- Wallet injection, `wallet_switchEthereumChain` and the returned hash were exercised only with a
  fake EIP-1193 provider. If the wallet app is killed after broadcasting, copy the hash from OKX
  Wallet history: `resume --state … --tx <hash>`.
- BSC `finalized` block tag support is assumed on the configured RPCs (BSC fast finality); an RPC that
  does not support it never yields a verdict (the flow waits, then times out safely).
- Bybit's real txID format for BSC deposits (with/without `0x`), the travel-rule field name in
  deposit records, and the transfer-list path (the docs page shows two spellings; we use
  `/v5/asset/transfer/query-inter-transfer-list`) are handled defensively but unverified live.
- Wallet-side review is the user's protection against a tampered page: compare the recipient with the
  USDT/BSC deposit address in the Bybit app. The helper re-verifies after the fact but cannot undo an
  on-chain transfer.
