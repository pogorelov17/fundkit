---
name: okx-bsc-usdt-to-bybit
description: Move USDT on BNB Smart Chain from the user's mobile OKX Wallet to the user's own Bybit account (Funding, then Unified Trading if needed). Use when asked to fund Bybit from OKX Wallet with USDT/BEP20. Produces an HTTPS signing link + QR, captures the tx hash, verifies on-chain and on Bybit, and keeps all state in the chat.
---

# USDT (BSC) from OKX Wallet → own Bybit account

Tooling: the `fundkit` CLI in this repository (`node src/cli.js …`, or `fundkit …` after `npm link`).
Full reference and real-device limitations: `docs/okx-bsc-usdt-to-bybit.md`.

## Hard rules

- Never ask for, accept, print, or store a seed phrase, private key, or Bybit API secret.
  Bybit credentials live only in the environment (`.env` or `doppler run --`). If a user
  pastes a secret into chat, tell them to rotate it.
- The user signs in OKX Wallet; you never sign. Do not add addresses to code or config.
- Only the user's **own** Bybit account (deposit address comes live from their API key).
- Confirm the amount with the user before `start`. Never start a second intent for an amount
  that already has a `txHash` in chat state — use `resume` instead.
- Stop at `needs_attention` and explain; do not improvise workarounds that move funds.

## Steps

1. **Environment check** (no money moves): `fundkit preflight --amount <USDT>`.
   Reports: canonical USDT contract (Bybit coin-info and on-chain must both match
   `0x55d398326f99059fF775485246999027B3197955`, 18 decimals), deposits enabled, minimum,
   precision, route limit, Bybit confirmations, live deposit address, API key permissions
   (warns on Withdraw permission / no IP whitelist). Relay any `WARNING:` lines.
2. **HTTPS**: `PUBLIC_BASE_URL` must be an https origin forwarding to `HOST:PORT`
   (a tunnel or reverse proxy). Plain http is refused.
3. **Start**: `fundkit start --amount <USDT> [--target UNIFIED|FUND]`.
   Give the user the `Open on phone in OKX Wallet:` link (tap on phone) or the QR (scan from
   desktop). Tell them to check, in OKX Wallet's confirmation screen, that the token is USDT on
   BNB Chain, the amount, and that the recipient matches the USDT/BSC deposit address in their
   Bybit app. The page checks USDT balance and BNB gas before enabling Send.
4. **State in chat**: after every change the CLI prints `FUNDKIT_STATE {…}`. Always keep the
   **latest** line in your reply (in a code block) — it is the only state; there is no DB.
5. **Automatic settlement**: once the wallet returns the hash the CLI verifies, from its own
   RPCs, chain 56, receipt success, the USDT contract, sender, recipient = Bybit address, and
   exact amount; then waits for the Bybit deposit record with that `txID` (status success,
   amount + fee matches), then moves exactly the credited amount FUND → UNIFIED only if it
   landed in FUND. Exit code 0 = done, 2 = needs attention, 3 = still pending/timeout.
6. **Recovery** (crash, timeout, closed laptop): `fundkit resume --state '<latest line>'`.
   - `link_issued`: re-serves the same link; the page refuses to sign if a hash already exists.
   - `tx_submitted`/`tx_confirmed`/`deposit_credited`/`transfer_pending`: continues verification;
     the transfer reuses a deterministic `transferId` and is looked up before any submit.
   - `tx_failed` (reverted, no USDT moved): only with explicit user OK, `--reattempt`.
   - If the page could not reach the helper, the user copies the hash from OKX Wallet history:
     `fundkit resume --state '<line>' --tx <hash>` — it is verified like any other.
7. `fundkit status --state '<line>'` summarizes a state line for the user.
