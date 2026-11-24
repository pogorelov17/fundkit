---
name: okx-bsc-usdt-to-bybit
description: Move USDT on BNB Smart Chain from the user's mobile OKX Wallet to the user's own Bybit account (Funding, then Unified Trading if requested). Use when asked to fund Bybit from OKX Wallet with USDT/BEP20. Produces an HTTPS signing link + QR, captures the tx hash, verifies on-chain and on Bybit, and keeps all state in the chat.
---

# USDT (BSC) from OKX Wallet → own Bybit account

Tooling: the `fundkit` CLI in this repository (`node src/cli.js …`, or `fundkit …` after `npm link`).
Full reference, evidence sources and limitations: `docs/okx-bsc-usdt-to-bybit.md`. Nothing here has
been tested on a real phone, a real Bybit account or with real funds; say so if asked.

## Hard rules

- Never ask for, accept, print, or store a seed phrase, private key, or Bybit API secret.
  Credentials live only in the environment (`.env` or `doppler run --`). If a user pastes a secret
  into chat, tell them to rotate it.
- The user signs in OKX Wallet; you never sign. Do not add addresses to code or config.
- Only the user's **own** Bybit account (deposit address comes live from their API key).
- Confirm the amount with the user before `start`. **Never start a new intent while an earlier one is
  unresolved** (no hash, pending, or `needs_attention`) unless the user has checked OKX Wallet history
  and confirms nothing was sent for it.
- A `RECOVERY ONLY` result means: do not try to get another signature. Follow its "Next:" line.
- Stop at `needs_attention` and explain; do not improvise workarounds that move funds.

## Steps

1. **Environment check** (no money moves): `fundkit preflight --amount <USDT> [--target FUND]`.
   It checks the key (account id, no Withdraw, permissions it can actually read with), Unified
   Trading Account (for UNIFIED), the canonical USDT contract on Bybit and on every RPC, deposits
   enabled, minimum, precision, limit and the live deposit address. Relay any `WARNING:` lines.
2. **Landing account (UNIFIED target only).** Bybit's API cannot tell where a deposit is credited.
   Ask the user to check in the Bybit app that USDT deposits go to the **Funding** account (default,
   no auto-transfer). Only then pass `--confirm-fund-credit`. Otherwise use `--target FUND`.
3. **HTTPS**: `PUBLIC_BASE_URL` must be an https URL (optionally with a path prefix) forwarding to
   `HOST:PORT`. Plain http is refused. `BSC_RPC_URLS` needs ≥ 2 independent https endpoints.
4. **Start**: `fundkit start --amount <USDT> [--target UNIFIED|FUND] [--confirm-fund-credit]`.
   Give the user the `Open on phone in OKX Wallet:` link (tap on phone) or the QR (scan from desktop).
   Tell them to check, in OKX Wallet's confirmation screen, that the token is USDT on BNB Chain, the
   amount, and that the recipient matches the USDT/BSC deposit address in their Bybit app. Only one
   tab/device can sign; others are refused before any wallet prompt.
5. **State in chat**: after every change the CLI prints `FUNDKIT_STATE 2.<payload>.<mac>`. Always keep
   the **latest** line in your reply (in a code block). It is the only state (no DB); it is
   authenticated, so do not edit it.
6. **Automatic settlement**: finalized tx agreed by every RPC (exact USDT transfer from the bound
   wallet to the Bybit address) → Bybit deposit record for that txID (credited, fee accounted) → for
   UNIFIED, a FUND→UNIFIED transfer of exactly the credited amount with a deterministic transferId.
   Exit code 0 = done, 2 = needs attention / recovery only, 3 = still pending/timeout.
7. **Recovery**: `fundkit resume --state '<latest line>'`.
   - No hash recorded (`link_issued` / `signing_claimed`): recovery only. Ask the user for the hash
     from OKX Wallet history → `resume --state '<line>' --tx <hash>`.
   - Hash recorded: continues verification and the transfer (looked up before any submit).
   - Wallet sped up/replaced the tx: `--tx <new hash>` (accepted only after verification).
   - `tx_failed` (finalized revert, no USDT moved): only with the user's OK, `--reattempt`; it is
     refused if the wallet sent anything since or a matching deposit exists.
   - Transfer outcome unknown after timeout, or rejected (e.g. insufficient Funding balance, IP not
     whitelisted): check the Bybit app (transfer history for the printed transferId, balances); only
     after the cause is clear/fixed and with the user's OK, `--retry-transfer` (same transferId).
   - Held/failed deposit fixed on Bybit's side, or RPCs disagreed earlier: `--recheck` (never re-sends).
8. `fundkit status --state '<line>'` summarizes a state line and says whether it is authentic.
