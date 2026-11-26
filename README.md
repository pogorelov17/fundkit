# fundkit

An Agent Skill that lets an AI agent move USDT between a crypto wallet and exchanges with a
human approving every write. The skill itself is Markdown. The agent talks to exchanges through
the official MCP server [`ccxt-mcp@0.1.3`](https://github.com/ccxt/ccxt/tree/master/mcp),
pinned with `ccxt@4.5.85`, the last ccxt release with which the server's `withdraw` still
passes network, fee and memo to the exchange. Works in T3 Code, Claude Code and Codex. An
optional helper, [`bin/fundkit.mjs`](bin/fundkit.mjs) (Node 20+; standard library plus the
pinned QR decoder `jsqr@1.4.0` at run time), connects exchange profiles for one session from a
single Doppler config and adds native tools: a verified deposit address with an inline QR, and
exchange-to-exchange transfers confirmed by one bound human confirmation.

## Quick start

**T3 Code on your own server (recommended).** Once, on the server that runs T3 Code, as the
user T3 runs as:

```bash
git clone https://github.com/pogorelov17/fundkit.git ~/fundkit && node ~/fundkit/bin/fundkit.mjs install
```

Then, in a new T3 chat, ask in your own words: `Дай мой адрес Binance для USDT в BSC`. If no
session is active, T3 shows **one private card** for the Doppler service token; the agent never
sees it, and the same request continues by itself. The answer is the QR image inline, the
address as copyable text, the exact network and the memo (or "none"). `Переведи 300 USDT с
Bybit на Binance` reads both accounts, prepares an exact plan (or says exactly why it holds) and
opens one confirmation card; only Approve sends, once. How it works and its limits:
[native plan](references/t3-native-plan.md).

**Option 1 (Claude Code or Codex in a terminal): session-only Doppler profiles.** On the
server, in the operator's shell:

```bash
git clone https://github.com/pogorelov17/fundkit.git ~/fundkit && node ~/fundkit/bin/fundkit.mjs install
```

This installs the pinned server, links the skill for Claude Code and Codex, and registers one
MCP server, `fundkit`. Start a new Claude Code or Codex session and ask in your own words, for
example `переведи 300 USDT с OKX на Bybit`. The agent first uses any exchange profiles that are
already connected. If the route needs one that is not, it asks you to run `fundkit session` in
a second terminal on that machine and paste a read-only Doppler service token at the hidden
prompt, once per session. It then connects exactly the profiles the route needs, under aliases
it picks itself (`okx-src`, `bybit-dst`).

The Doppler config holds one account per exchange under exactly two names, and nothing else:

```text
BINANCE_APIKEY   BINANCE_SECRET
BYBIT_APIKEY     BYBIT_SECRET
GATE_APIKEY      GATE_SECRET
OKX_APIKEY       OKX_SECRET
BITGET_APIKEY    BITGET_SECRET
WHITEBIT_APIKEY  WHITEBIT_SECRET
BINGX_APIKEY     BINGX_SECRET
MEXC_APIKEY      MEXC_SECRET
KUCOIN_APIKEY    KUCOIN_SECRET
```

The same key serves an exchange as source on one route and as destination on the reversed
one; fundkit enforces the local role (a destination profile forwards no money move, whatever
the key could do). OKX, Bitget and KuCoin also need their API passphrase, which is not in
Doppler: when a profile first needs it, the `fundkit session` terminal asks for it with hidden
input, once per exchange and session (or up front with `--passphrase okx`, or from another
terminal with `fundkit passphrase okx` when the session runs the host). Data flow, roles and
limits: [scheme D](references/security.md#scheme-d-session-only-doppler-profiles-optional).

**Option 2: explicit read with your own profiles.** From the repository root, in Claude Code
or Codex:

```text
Read SKILL.md and help me plan a USDT transfer.
```

That explicit read is all the skill needs. Start every fresh chat or host launch with it,
including the second (B) launch of scheme A. Without exchange servers the agent can explain the
flow but stops before live data. To let it read live data and execute approved writes, the
operator sets up:

1. **Server.** Install the pinned server ([install](references/ccxt-mcp.md#install)) and create
   one `config.json` per account, starting with `"dryRun": true`
   ([venue profiles](references/security.md#venue-profiles): credential fields, variable
   names and key rights for all nine exchanges).
2. **Host.** Register one server per profile and pick a launch scheme. Scheme C keeps each
   account's key in its own `chmod 600` profile file, so exchange A and exchange B are both
   connected in one session
   ([environment contract](references/security.md#environment-contract),
   [host registration](references/security.md#host-registration)).
3. **Check.** Run the [smoke check](references/security.md#smoke-check), then paste a
   [setup prompt](references/prompts.md#setup-and-diagnosis) as the first request.

Either way, the first money move on a route still needs the one-time
[setup record](references/security.md#setup-record) (key rights, the native-form line,
the whitelist entry), and every money move needs `APPROVE`, `WITHDRAW` and the host's native
form. Automatic skill discovery is host behavior. Without `fundkit install` this repository
does not set it up ([loading the skill](references/security.md#loading-the-skill)).

## What it does

- **OKX Wallet → exchange.** Picks a network from the exchange's live data. On each of the nine
  exchanges the agent reads the address, network and memo from the operator's own account
  with the exchange's one key, which fundkit (or the profile's `dryRun`) limits to deposit-only reads
  ([native recipient reads](references/recipients.md)). Whether a network
  qualifies depends on the documented facts per venue (some hold). The operator
  enters the amount, pastes the verified address and memo into OKX Wallet and signs. Send amount, network fee
  (quoted amount or cap, asset and treatment) and expected credit are kept apart. The deposit is matched by transaction
  hash and expected credit.
- **Exchange A → exchange B** (semi-automatic). Both accounts are connected in the same
  session with separate credentials. The agent prepares everything: account modes, available
  amount minus margin reserve, a network enabled on both sides, B's recipient read from B's
  own account, and debit, withdraw amount and credit computed separately. The user approves
  the plan and the withdrawal and confirms each native form. The agent then proves the
  withdrawal on A, matches the deposit on B by hash and plans any transfer on B for its own
  approval. A HANDOFF block to a second chat is only the fallback without a B profile. A route
  runs only when every documented gate passes on live data and the operator's one-time setup
  record. Where a venue documents no value for B's deposit minimum or fee (Binance and MEXC
  minimum, the Gate minimum on a multi-chain address response, the KuCoin fee), the route holds,
  unless the user supplies that value from B's deposit page for that one plan (a per-plan
  human-read fact, re-read before the withdrawal). BingX's minimum is its documented live
  `depositMin`. WhiteBIT's token contract exists in no API; it qualifies only from the
  operator's one-time pinned setup evidence, named as such.
- **funding ↔ trading/margin** on one exchange.
- **Hyperliquid**: watch-only margin and position monitoring by public address.

Exchanges: Binance, Bybit, Gate, OKX, Bitget, WhiteBIT, BingX, MEXC, KuCoin, plus Hyperliquid
(read-only).

## Safety model

- **Doppler (optional).** The service token and the OKX, Bitget and KuCoin API passphrases are
  typed only into a private terminal (`/dev/tty`, echo off), never into the chat, a native form,
  argv, a file or any other process. Each profile gets only its own exchange's two names,
  fetched for that session, plus that exchange's passphrase, all dropped when it ends. One key
  per exchange may be write-enabled, so fundkit enforces each profile's local role with
  per-venue method allowlists and a key check before recipient reads and money moves. It
  binds no account UID: the operator's mapping of each exchange to its two Doppler names is
  trusted ([scheme D](references/security.md#scheme-d-session-only-doppler-profiles-optional)).
- **Keys.** The agent knows only account aliases and never reads the environment. One server
  per account. Claude Code passes its whole environment to every server; Codex forwards only
  each server's `env_vars`, but the values stay in the host environment. So either put each
  account's credentials into its own `chmod 600` profile file and keep exchange keys out of
  the host environment (scheme C, both accounts in one session), keep one account's keys and
  one enabled registration for that exchange per host launch (scheme A), or have the operator
  launch each server separately (scheme B)
  ([environment contract](references/security.md#environment-contract)).
- **Approvals.** MCP writes run only from a plan with exact arguments and an expiry, after the
  reply `APPROVE <PLAN-ID>`. The first `withdraw` call also needs a separate
  `WITHDRAW <PLAN-ID>`. Every money move (`withdraw`, `transfer`) is confirmed by the human in
  the host's native form. A server without the form gets no money move, and the agent never
  redeems a confirmation token. The server enforces only the form's answer; the form shows no
  `params`, PLAN-ID or expiry, so those checks are procedural. A transfer on B after the credit
  is a separate plan with its own `APPROVE <PLAN-ID>-B`. `get_deposit_address` is never called, because it can create an
  address on its own even under `dryRun`. The Gate and WhiteBIT address reads may create an
  address, so they run only with provisioning consent in the operator's setup record. The
  operator authorizes a manual send by signing or submitting the exact transaction on the
  current sheet before its expiry.
- **Execution.** No retries on an unknown outcome. A step counts only with an attributable ID
  and a success status, a deposit only by its full on-chain hash and expected credit. Pending
  records are polled read-only; failed, missing or ambiguous ones hold the route. Internal
  transfer proof is venue-specific: an API read on Binance, Bybit, OKX, Bitget classic, BingX,
  MEXC and Gate (`GET /wallet/transfers` by `tx_id`); on WhiteBIT, KuCoin and Bitget UTA only
  operator evidence agreed in advance, or the transfer is manual. Amounts are explicit and exact multiples of the currency,
  network and exchange steps. Network, chain, contract, fee and minimums are never guessed.
  API withdrawals run only for offline-verified "exchange + network" pairs, with whitelist
  evidence (Binance and Gate saved-address reads, otherwise the setup record). The full address, network and memo are checked on the final
  confirmation screen against their source (the native recipient read's tool result, or the
  deposit page if the user chose it), never against text pasted into the chat.
- **Fresh chats.** Carry the latest operation record forward. An open or unknown send is reconciled read-only. API withdrawals require a native confirmation form; otherwise use the exchange UI.
- **Crash hold.** A crash-cut entry in the shared ccxt-mcp journal stops all writes on every
  profile that shares it, for good: reads and operator investigation only.
- **Exchange side.** Minimal key permissions, IP allowlist and a withdrawal address whitelist
  ([key permissions](references/security.md#exchange-key-permissions)).
- **Trust model.** The skill assumes a cooperative, trusted host, operator and agent. The hard
  control is the human's answer in the native form on an interactive host with no auto-answer
  hook (recorded once by the operator); plans, expiries and rechecks are procedures. Which OS
  user runs a server is neither a control nor a stop: running all servers under the operator's
  own user is the normal setup. Host isolation was not verified
  ([trust model](references/security.md#trust-model)).

## Example requests

```text
Check which exchange profiles are connected and what they are allowed to do.
I want to top up Bybit with 150 USDT from OKX Wallet. Which network fits and what should I check before sending?
Give me my Bybit USDT deposit address for TRC20 so I can paste it into OKX Wallet.
Both accounts are connected: move 300 USDT from okx-src to bybit-dst, then settle it into the unified wallet with bybit-settle.
Make a plan: 300 USDT must arrive on Bybit (UTA) from OKX (trading account), keep a 100 USDT margin reserve on OKX.
Move 50 USDT from main to trade on KuCoin. Plan first.
How much free margin and which positions are on Hyperliquid for address 0x…?
The last withdrawal is stuck. Reconcile what actually happened without repeating anything.
```

## Files

| File | Contents |
|---|---|
| [`SKILL.md`](SKILL.md) | agent rules and scenarios |
| [`references/ccxt-mcp.md`](references/ccxt-mcp.md) | pins, tool schemas, approval gates, journal, limitations, verification |
| [`references/exchanges.md`](references/exchanges.md) | wallets, network data, outbound withdraw table, amount steps, account modes |
| [`references/security.md`](references/security.md) | environment contract, host registration, loading the skill, smoke check, key permissions |
| [`references/recipients.md`](references/recipients.md) | native recipient reads (address, memo, landing wallet), deposit fee and minimum sources and hard limits per venue |
| [`bin/fundkit.mjs`](bin/fundkit.mjs), [`lib/`](lib/) | optional: `install`, the private terminal `session`, `unlock` (host secret card), `passphrase`, the `fundkit` MCP server, `status`, `stop`; role allowlists in [`lib/policy.mjs`](lib/policy.mjs); native flows in [`lib/broker/native.mjs`](lib/broker/native.mjs), venue reads in [`lib/venues/`](lib/venues/), QR in [`lib/qr/`](lib/qr/) |
| [`references/t3-native-plan.md`](references/t3-native-plan.md) | the native address and transfer flows on T3 Code: contract, acceptance tests, limits, Hetzner acceptance steps |
| [`tests/`](tests/) | offline tests for the session: mock Doppler, pseudo-terminals, simulated host, synthetic and pinned ccxt-mcp |
| [`references/prompts.md`](references/prompts.md) | copyable prompts for setup, diagnosis, read-only checks and planning (the agent replies in the user's language) |

## Verification and limits

Verified in a scratch environment with no real keys and no live writes: pins, schemas and
gates, the approval token (including 60 s expiry) and the 300 s form wait, and the final
`withdraw` and `transfer` requests, built offline without sending; transfer proof reads,
journal crash entries and deposit hash matching; the Bybit deposit-address read; two
same-exchange registrations sharing one key; public network data, `call_implicit_get`, the
server environment and registration commands on Claude Code 2.1.331 and Codex 0.172.0.

On 2026-11-25 the BingX revision of the offline pack (`fundkit-bingx-results`) replaced the
earlier runs. A reference planner follows this skill's gates on tool results only, over real
ccxt-mcp servers and a fixture transport. Every expected disposition, hold phase, exact failed
set and, for settled routes, the set of venue-specific setup facts was fixed from the
documented venue facts before the run (381 scenarios, 5422 checks, 0 failures,
[details](references/ccxt-mcp.md#verification)):

- **72 directed exchange pairs**, network chosen among TRC20, BEP20, ERC20 and TON
  ([prerequisites by route](references/recipients.md#prerequisites-by-route)). **36 settle after
  the one-time setup**, with only `APPROVE`, `WITHDRAW` and the native forms per plan: A ∈
  Binance, Bybit, Gate, OKX, Bitget, BingX, MEXC, KuCoin → B ∈ Bybit, OKX, Bitget, BingX,
  WhiteBIT. All 36 use the common setup attestations (registration lines, interactive-form
  line) and at least one venue-specific setup fact (whitelist entry in the setup record 26,
  entity line 21, key rights from the setup record 16, IP allowlist from the setup record 12,
  BingX permission codes 11, provisioning 8, WhiteBIT contract pin 8; these overlap). **28 more settle only with a
  per-plan human-read fact** the user opts to supply (B = Binance, MEXC, Gate or KuCoin).
  **8 hold** for any API plan: WhiteBIT as source (available amount not visible); the manual
  sheet in WhiteBIT's UI remains. Settled routes run a full recheck, one native-form withdrawal,
  proof by id, a deposit matched by hash with USDT and chain checked on both venues, and, on
  Bybit, OKX, Bitget and BingX, a separate settlement plan on its own registration, proven by id.
- **36 recipient reads** (9 venues × 4 networks): all 36 verify the address, memo, chain and
  contract. A send can be planned without a per-plan fact to 20 of them (Bybit, OKX, Bitget,
  BingX, WhiteBIT); 16 need one (Binance, MEXC, multi-chain Gate minimum; KuCoin fee).
- Isolated gates with positive twins: BingX minimum (missing, null, malformed, negative, above
  the credit, another chain's row, changed or deposits suspended at the recheck), per-plan
  facts (stale, unsourced, changed, not restated, disagreeing), exact whitelist characters on
  Binance and Gate saved-address rows, the entity rule (Italy, Germany, France, Poland, unknown
  and regional entities, missing or non-ISO jurisdiction, Bybit India, WhiteBIT Norway), `dryRun`
  on the deposit-only profile, MEXC key rights, TON alphabets, plus every earlier gate and the
  independent review's probes, imported unchanged.

**Session profiles** (`python3 -I -m unittest discover -s tests -t .`, 63 tests in all; the
pinned-server test also runs inside `unshare -rn` with `FUNDKIT_REAL_CCXT_MCP`) cover these
cases:

- no prior setup, and profiles already connected (no Doppler request, no prompt);
- the private terminal steps on real pseudo-terminals, with nothing echoed;
- exactly `<EXCHANGE>_APIKEY` and `<EXCHANGE>_SECRET` fetched for every venue, no third name,
  no role-suffixed alias, values forwarded only to that profile's process;
- the API passphrase on OKX, Bitget and KuCoin: asked in the session terminal, up front, or with
  `fundkit passphrase` beside a wrapped host; once per exchange and session; cancel and empty
  input; never in Doppler, the host, a file or another process;
- one key in both roles when a route reverses, wrong-role denial on every write surface,
  a successful key check before recipient reads and money moves, no UID asked for, read,
  kept or compared (an old caller's `uid` ignored, UID-only reads refused), WhiteBIT money moves
  reaching the native form, provisioning, and the same decisions for a raw socket client;
- redaction, and the native form forwarded with decline, accept and no answer;
- an expired token, Ctrl-C at the prompt, a refused token type, no terminal, Doppler ignoring
  the name filter, outages, `--ttl`, `SIGHUP` and `fundkit stop`;
- cleanup of processes, files and socket, and reconnecting a running host to a new session;
- `install` against the real `claude` and `codex` CLIs in a scratch home.

**Native flows** (`tests/test_native.py`, 21 tests, on a host that answers forms and secret
cards the way T3 Code 0.1.11 does, as read from its runtime):

- the T3 secret file consumed once and deleted; symlink, FIFO, group-readable, oversized, foreign
  or world-writable locations and non-tokens refused with nothing sent to Doppler; the token in
  no argv, environment, file, log or output; the background session reused across host restarts;
  passphrases by the same card;
- no session → exactly one `secretStep` with `delivery: "file"` → the same call succeeds;
- the Binance BSC address, network and memo; TON with memo `000123`; the delivered PNG read by
  the test's own PNG reader and decoded by jsQR to the exact address bytes; identical input,
  identical PNG; three concurrent requests without mixing; wrong chain, two default rows,
  missing tag, the contract as address, contract mismatch and disabled deposits show no address
  and no QR;
- Bybit → Binance holds on Binance's undocumented minimum with zero dispatch; Binance → Bybit
  prepares, and one Approve sends exactly once with the plan's arguments on a single-use profile
  capped at the amount; decline, cancel and no answer send nothing; repeated confirms, a new
  host process, concurrent confirms, a session restart, an expired plan and edited plans (even
  with recomputed hashes) send nothing more; "Always allow this session" on one plan does not
  approve the next; a host without forms cannot confirm.

With the **real pinned ccxt-mcp** (`unshare -rn`, recorder transport): the Binance BSC address
reads parse through real ccxt and send only GETs signed with the Binance key; the plan card
matches the real server's own form text and is shown once; decline returns the real
`CONFIRM_DECLINED` with no request; approval passes the real gate and the one
`POST /v5/asset/withdraw/create` is refused by the recorder, reported `unknown`, never sent again.

Simulated, not proven: T3 itself (its card behavior is emulated from its code), Doppler,
every exchange response (synthetic, shaped after the venues' references) and every outcome of a
real withdrawal.

Development checks: `npm ci`, then `npm run check` (Prettier, ESLint, `node --check`) and
`ruff format --check tests && ruff check tests` (ruff 0.14.5).

No real Doppler service, exchange key or model run was used.

Every response in those runs is synthetic, shaped after venue references and ccxt's parsers.
Not verified: real accounts, modes, available amounts, fee models, exchange responses to writes
and reads with a real key, whether a read-only key may read the deposit address on each venue,
and actual transfers. A settled fixture route does not show that a real route is ready, and
no route here is "native" in the sense of running on live fields alone. Hard
limits per venue are listed in
[`recipients.md`](references/recipients.md#status-by-destination-venue). Network flags and fees
are visible only with a key on most exchanges, so plans are built from live data at request
time. The skill gives no execution guarantees. Use at your own risk and start with `dryRun`.
