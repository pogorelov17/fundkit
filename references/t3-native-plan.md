# Implementation plan: native address and transfer flows on T3 Code (Hetzner)

Status: implemented on branch `feat/t3-native-address-transfer` (draft PR #5); automated
acceptance passes offline; the real-T3 acceptance on Hetzner below is still to be run. This file
is the contract for the change. **Limitations** are stated up front and kept current.

## Goal

Two requests in the user's own words must work end to end on the operator's persistent T3 Code
installation on Hetzner, with no operator command, no second terminal, no Docker or SSH step,
no browser, no "done" round trip, no UID, no setup record and no questions about
credentials, amounts, minimums or the deposit page:

1. **Address.** `Show my Binance USDT deposit address on BSC`
2. **Transfer.** `Move 300 USDT from Bybit to Binance`

The requests may be in any language; the agent replies in the user's language.

Boat sandboxes are only for development and tests. The user's runtime is the persistent
installation on the Hetzner host that runs T3 Code.

## Flow 1: deposit address

```text
user ─► agent: "Show my Binance USDT deposit address on BSC"
agent ─► fundkit_deposit_address {"exchange":"binance","coin":"USDT","network":"BSC"}
   ├─ session active ─► connect binance-dst (deposit-only) if needed
   │                   ─► key check ─► network data ─► gated read ─► raw read
   │                   ─► verify chain, contract, unique default row, memo field
   │                   ─► QR PNG from the exact address (local, offline, deterministic)
   │                   ─► decode the PNG file independently, compare byte for byte
   │                   ◄─ {status:"verified", address, network, memo, qr:{path, sha256}}
   └─ no session ─────► {error:"NO_SESSION", secretStep:{…}, resume:{tool, arguments}}
agent ─► (T3 only) request_secret {label:"Doppler service token", delivery:"file"}   ← one card
agent ─► shell: <node> <repo>/bin/fundkit.mjs unlock --token-file "<path from the card>"
agent ─► fundkit_deposit_address (same arguments, no user turn in between)
agent ─► reply: QR image inline, the address as copyable text, the exact network, memo or "none"
```

Reply shape (no memo; the agent writes it in the user's language):

```markdown
Your Binance USDT address on BNB Smart Chain (BEP20), Binance network `BSC`:

![QR: Binance USDT BSC address](/home/op/.local/state/fundkit/qr/3f…c1.png)

`0x1b6c…exact…address`

Network: BNB Smart Chain (BEP20, chain id 56). Memo/tag: none.
Read from your Binance account (binance-dst), 2026-11-26 12:03 UTC. The QR contains only this address.
```

With a memo (for example a TON address with memo `000123`), the reply adds, conspicuously and
before the QR: `⚠ MEMO REQUIRED: 000123` and states that the QR carries only the address,
so the memo must be entered separately. Leading zeros are preserved exactly.

The agent never says that anything was sent, never shows a QR for another address, and never
re-uses an older QR file: each tool result names its own file by the SHA-256 of the PNG
bytes, and the result's `qr.payload` must equal the `address` it is shown with.

### Secure token handoff (T3 `request_secret`, file delivery)

T3 Code's host tool `request_secret` with `delivery: "file"` shows the user a private card and
returns a path to a `0600` regular file in a `0700` directory; the model never sees the value.
The fundkit MCP server cannot call that host tool (an MCP server does not see the host's own
tools), so the agent runs one shell command after the card:

```bash
"/usr/bin/node" "/home/op/fundkit/bin/fundkit.mjs" unlock --token-file "/…/files/9f0c…"
```

`fundkit unlock`:

1. `lstat` the path: a regular file (no symlink, FIFO or device), owned by the current user,
   no group or other permission bits, at most 4 KiB; the parent directory is owned by the
   current user and not group- or world-writable.
2. Opens it with `O_NOFOLLOW`, checks that the opened file is the same inode, reads it, then
   **unlinks it** (single use). If the unlink fails, the value is not used.
3. Validates the Doppler service-token format (`dp.st.…`), then hands it to the session
   daemon over the private control socket (`0600` socket in a `0700` directory), or starts
   the daemon detached and passes the token on the daemon's stdin pipe. The token never
   appears in argv, the environment, a log, a file written by fundkit, or any output.
4. Prints one JSON line without values: `{"ok":true,"session":"active","doppler":{"project",
   "config"},"expires":…}` or an error code (`TOKEN_FORMAT`, `TOKEN_REJECTED`,
   `FILE_UNSAFE`, `FILE_NOT_CONSUMED`, `DOPPLER_UNAVAILABLE`, …).

The daemon keeps the token in memory only, for `--ttl` (default 8 h), survives the host's MCP
server restarts between turns, and drops everything on `fundkit stop`, the time limit or a
rejected token. API passphrases (OKX, Bitget, KuCoin) use the same path, one card per
exchange and session, only when that exchange is actually needed:
`fundkit unlock --passphrase okx --secret-file "<path>"`.

On hosts without such a card (Claude Code CLI, Codex) the result says so honestly
(`secretStep.hostWithoutCard`) and offers the existing private-terminal step
(`fundkit session`). Users whose ccxt-mcp profiles are already configured are never asked for
Doppler.

## Flow 2: exchange A → exchange B

```text
user ─► "Move 300 USDT from Bybit to Binance"
agent ─► fundkit_transfer_prepare {"from":"bybit","to":"binance","amount":"300","coin":"USDT"}
         (no session: same single card as above, then the same call again)
   ─► connects bybit source (dryRun, read only) and binance-dst (deposit-only)
   ─► reads on both ends: key checks, A's available balance in the withdrawal wallet,
      A's withdraw network rows (enabled, fee, percentage fee, minimum, maximum, step),
      B's deposit network rows (enabled, contract, minimum), B's own recipient (as Flow 1)
   ─► picks the network: the user's, or the cheapest network enabled on both ends with
      the same contract
   ◄─ {status:"ready", plan:{planId, expiresAt, hash, amount, fee, debit, credit, network,
       recipient:{address, memo}, args}}   or   {status:"hold", reasons:[{code, detail}]}
agent ─► shows the plan in one message and asks one plain question ("Confirm this transfer?")
agent ─► fundkit_transfer_confirm {"planId":"…"}
   ─► persists "dispatching" for the plan (exclusive create; a second call cannot pass)
   ─► starts a single-use source profile capped at this plan's amount (dryRun off)
   ─► calls withdraw with the plan's frozen arguments; the ccxt-mcp native form comes back
   ─► the broker re-shows THAT form to the human with every plan field and the plan hash
      (the one human confirmation; never answered automatically)
   ─► human Approve → the form is answered "confirm: true" → one withdrawal
      Decline / Cancel / timeout / expired plan → answered "decline" → nothing sent
   ◄─ {status:"sent", withdrawalId} | {status:"cancelled"} | {status:"unknown", …}
```

Binding: the plan hash is SHA-256 over the canonical JSON of `{planId, expiresAt, from, to,
coin, network, amount, fee, debit, credit, recipient, args}`. The daemon starts the
single-use profile only with that hash, forwards exactly one money call whose arguments hash
to it, and stops the profile after the call. Changed amount, network, recipient, fee or
params need a new `fundkit_transfer_prepare` and a new confirmation. A duplicate
`fundkit_transfer_confirm`, a restart of the broker or the daemon, or a timeout never
produces a second send: the dispatch marker is created with `O_EXCL` before the call and
never removed, and an open outcome is reported as `unknown` for read-only reconciliation.

No typed `APPROVE <PLAN-ID>`/`WITHDRAW <PLAN-ID>`, no operator `--writes`/`dryRun` options:
the single-use profile and the bound confirmation replace them. Money-moving profiles that are
not plan profiles stay `dryRun` exactly as before.

Example plan text (the agent shows it in the user's language; the confirmation card shows the
same fields with fixed English labels):

```text
Transfer FK-7Q2M9X (valid until 12:18 UTC)
Bybit (FUND) → Binance, USDT, network BNB Smart Chain (BEP20): Bybit BSC → Binance BSC
Amount to credit: 300 USDT; Bybit fee: 0.3 USDT on top; debit: 300.3 USDT
Recipient (read from your Binance account): 0x1b6c…  memo: none
Available on Bybit FUND: 812.44 USDT; withdrawal minimum 10; maximum 1 000 000; step 0.0001
```

## Revision 2026-11-27: no Fundkit minimum, any wallet

The owner asked that even 1 USDT not be a minimum, and that wallet top-ups not name a wallet
brand. They then asked that an unknown minimum be stated as such with a non-binding
recommendation of at least 1 USDT, for exchange transfers and wallet top-ups alike. Work items
for this revision:

1. `lib/venues/minimum.mjs`: drop the 1 USDT operator fallback. A healthy read with no
   published minimum gives `{value: null, basis: "venue-unpublished", venueMinimum: "unknown"}`
   and `depositMin: null`. The amount check then requires only a positive conservative credit;
   a published minimum (0 included) is enforced inclusively. The same rule for all eight
   destinations, USDT only.
2. Binance `depositDust`: no constant to compare with any more. It is never the minimum and
   never shown as one. An unreadable value holds as an unhealthy response; a readable value
   above the conservative credit holds as contrary evidence (fundkit does not know what it
   means, so it does not send below it); it is bound into the plan, so a change fails the
   recheck. `busy` still holds.
3. Plan, chat summary and card: `venue minimum unknown` plus the advisory line "The exchange
   has not published a minimum for this network. Fundkit recommends depositing at least
   1 USDT." The 1 USDT is a recommendation only: it is never compared with the amount, never a
   threshold, never a guarantee and never an extra confirmation. The agent may translate it in
   the chat; the card keeps the English. The recheck before the card and after the approval is
   unchanged: unknown → known fails with `DESTINATION_RECHECK_FAILED`.
4. Address and QR: still no amount, no prompt and no hold for a missing minimum. The result
   now carries `depositMinimum` from the network row it already reads: the venue's value and
   field when published, the same advisory when unpublished, and "could not be read" (with
   the advisory, never "not published") when the field is present but malformed. The QR and
   the copyable address and memo are unchanged.
5. Docs, skill triggers, prompts, README: wallet top-ups from any compatible wallet (mobile,
   hardware, desktop), bound to the selected network, the USDT contract and the memo; the user
   signs in their own wallet. OKX the exchange is kept where it matters.
6. Tests: the advisory on the address and on the plan and card when unknown, a sub-1 credit
   passing on both native destinations, a published minimum still enforced, no extra card;
   sub-1 and smallest-unit credits, zero and negative after fees, a known minimum,
   source minimum and Cancel, address-only QR, unknown → known recheck; the real pinned server
   for a sub-1 plan.

## Hard limits found while planning

- **Destination deposit minimum.** Binance documents no API deposit minimum on any chain
  (`depositDust` has no documented meaning; [recipients.md](recipients.md#binance)). Fundkit
  sets no minimum of its own for any of the eight destinations
  ([rule](deposit-minimum.md)). Where the destination's healthy lookup publishes none, the plan
  records the venue minimum as **unknown** (never 0 and never a credit guarantee), the plan and
  the card say `venue minimum unknown`, and any positive expected credit after fees qualifies,
  subject to every other gate. The destination is read again before the card and after the
  approval; a minimum that appears, whatever its value, stops the plan. A minimum the venue
  does publish (0, lower or higher) is enforced on the expected credit. A malformed minimum, an
  unhealthy read and contrary evidence still hold.
- **T3 elicitation forms.** T3 Code shows an MCP elicitation as an approval card (Approve,
  Decline, Cancel, "Always allow this session") and fills the accepted content itself. A
  required boolean field without an enum (ccxt-mcp's `confirm`) cannot be filled, so T3
  cancels ccxt-mcp's own form unconditionally. The broker therefore re-presents the
  downstream form with a single-option string field (`decision: "approve"`), which T3 can
  answer, and maps the human's answer back. "Always allow this session" caches by server and
  exact message; every confirmation message carries the plan id and hash, so no cached grant
  ever matches another transfer.
- **Native venues.** `fundkit_deposit_address` and the transfer tools support Binance and
  Bybit natively in this change. The other six venues return `VENUE_NOT_NATIVE` with the
  reason; their documented manual reads in [SKILL.md](../SKILL.md) are unchanged.
- **Inline images.** T3 renders Markdown images with absolute paths. Whether a given T3
  build also renders MCP `image` content in tool results is not relied on; the tool returns
  both and the skill uses the Markdown image.
- **Compliance fields.** fundkit sends no travel-rule or beneficiary data. Where the exchange
  requires it for the account's entity (Bybit KR/IN/TR/KZ/ID/AE, regional Binance entities),
  the exchange rejects the withdrawal before sending; the plan says so.

## Key rights (all eight venues)

One Doppler config, exactly `<EXCHANGE>_APIKEY` and `<EXCHANGE>_SECRET` per exchange. The same
key serves reads and withdrawals; fundkit enforces the local role on every call, including
the generic surfaces (`call_read_method`, `call_implicit_get`). The instructions no longer
ask for a dedicated read-only key or for removing rights from a key: the venue key check is
reported as it is, and only facts the API genuinely needs remain (OKX, Bitget, KuCoin API
passphrase; Bybit main-account key for deposit addresses).

## Work items

1. `lib/handoff.mjs`: safe single-use consumption of a host-delivered file.
2. `fundkit unlock` and `fundkit daemon`: detached session daemon without a terminal, token on
   a pipe or the control socket, passphrases over the control socket.
3. `lib/qr/`: QR encoder (byte mode, ECC M, versions 1–10, all eight masks scored), PNG writer
   and reader (zlib from Node), verification through the pinned independent decoder
   `jsqr@1.4.0` installed by `fundkit install`; atomic writes named by content hash.
4. `lib/venues/`: Binance and Bybit adapters: recipient read, source facts, destination
   facts, withdraw arguments.
5. Broker tools `fundkit_deposit_address`, `fundkit_transfer_prepare`,
   `fundkit_transfer_confirm`, `fundkit_transfer_status`; `NO_SESSION` results carry
   `secretStep` and `resume`.
6. Daemon plan profiles: per-plan cap, one forwarded money call bound to the plan hash;
   persistent plan journal under `~/.local/state/fundkit/plans` (no secrets).
7. SKILL.md, README.md, security.md, prompts.md: T3 flows first, key-rights wording across
   the eight venues, honest host matrix.
8. Tests (offline, synthetic): see Acceptance.

## Acceptance

Automated (Boat or any dev machine, no network beyond loopback, no real keys):

- `npm run check`, `ruff format --check tests && ruff check tests`, and
  `python3 -I -m unittest discover -s tests -t .` pass; the pinned ccxt-mcp test also runs
  inside `unshare -rn` with `FUNDKIT_REAL_CCXT_MCP`.
- **Handoff.** A T3-shaped file (`0600`, `0700` dir) is consumed once and deleted; a second
  `unlock` with the same path fails `FILE_MISSING`; symlink, FIFO, group-readable file,
  foreign directory, oversize and bad-format inputs are refused and nothing is sent to
  Doppler; the token never appears in argv (`/proc/*/cmdline`), any environment, any file
  under the test home, stdout or stderr; a running session is reused (`already: true`).
- **Address, active session.** Binance USDT BSC returns the exact address, network `BSC`/
  `BEP20`, memo `none`; the QR PNG decodes (jsQR on pixels from an independent Python PNG
  reader) to the exact address bytes; same input gives the same PNG bytes.
- **Address, no session.** Exactly one `secretStep` with `delivery: "file"`; after
  `unlock` the identical call succeeds without any other step.
- **Adversarial.** Wrong chain in the raw row, explorer URL of another chain, two default
  rows, missing `tag`, contract mismatch, deposit disabled: no QR, exact reason. Memo with
  leading zeros is kept and flagged; concurrent requests for two networks produce two
  different files whose payloads match their own addresses; a failed request after a good
  one returns no QR path.
- **USDT only.** Any coin but USDT (USDC included) is refused with `UNSUPPORTED_COIN` by both
  native tools, before any session, read or write; their schemas offer `coin: USDT` only.
- **Transfer.** Bybit → Binance reaches the card with the venue minimum unknown and no
  Fundkit minimum ([acceptance](deposit-minimum.md#acceptance)). Binance →
  Bybit prepares a plan; T3-shaped host: Decline, Cancel and no answer give zero dispatch;
  Approve gives exactly one dispatch with the frozen arguments; a second confirm, a new broker
  process and a confirm after expiry give no second dispatch; a changed amount needs a new
  plan; the ccxt-mcp boolean form is never forwarded raw and never answered without the
  human.

Manual (parent agent, real T3 on Hetzner): see
[Hetzner acceptance](#hetzner-acceptance-real-t3) below; filled in when the code lands.

## What is proven and what is simulated

| Claim | How it was shown | Status |
|---|---|---|
| Secret file consumed once, deleted, never in argv/env/files/logs/output | `tests/test_native.py` HandoffTests, `/proc` scans, file sweep | proven offline |
| T3 delivers a `0600` file in a `0700` dir, kept 24 h unless removed | read from T3 Code 0.1.11's runtime code (`writeSecretFile`, `sweepExpiredFiles`) | read, not run |
| One card, then the same call continues | T3-shaped host in tests; real T3 in UAT 1 | simulated until UAT |
| QR encodes the exact address; the delivered file decodes to it | Python PNG reader + jsQR in tests; runtime self-check with jsQR | proven offline |
| Binance BSC address parse and GET-only reads | real pinned ccxt-mcp, recorder transport, `unshare -rn` | proven offline |
| Plan card matches ccxt-mcp's real form; approval passes the real gate; one POST at most | real pinned ccxt-mcp, recorder refuses the POST | proven offline |
| No Fundkit minimum on Binance as B (venue minimum unknown on the card, recheck, sub-1 and smallest-unit credits, zero or negative credit holds), Bybit's own `depositMin` first | fake ccxt-mcp end to end; real pinned ccxt-mcp for the card, a sub-1 plan, the recheck and Cancel | proven offline (Binance and Bybit only) |
| Same rule on the other six venues as B | documented agent flow; policy table checked at function level | not run end to end |
| Any coin but USDT refused with zero reads and writes | fake: no Doppler secret request, no profile, no call; real server: zero wire requests | proven offline |
| T3 cannot answer ccxt-mcp's raw form; can answer the plan card | read from T3's `toMcpElicitationResponse` and emulated | read, not run |
| Inline QR renders in T3; the card renders the message in full | UAT 1 and 3 | not yet shown |
| Real Doppler, real exchange keys and responses, a real withdrawal | none | not done (by design) |

## Host limitations found

1. **ccxt-mcp's form is unanswerable in T3.** T3 pre-computes the accepted content of an
   elicitation; a required boolean without enum or default cannot be filled, so T3 cancels it
   without showing it. fundkit never forwards that raw form on a plan profile; it re-shows it as
   the plan card. The legacy `fundkit_write` path forwards the raw form and so cannot move money
   on T3 (it fails closed with `CONFIRM_CANCELED`).
2. **"Always allow this session"** caches approvals by server and exact message. Every plan card
   carries a unique plan id and hash, so a grant never matches another transfer (tested).
3. **One broker owns a profile.** If two T3 threads use fundkit at the same moment, the second
   gets `ALIAS_IN_USE` for a profile the first holds, until the first thread's MCP server stops.
4. **Tool permissions.** Depending on the T3 permission mode, the user may have to allow the
   agent's shell command (`fundkit unlock …`) or the fundkit tools once. That is a host
   permission prompt, not an operator step; approve it once per session or allowlist it.
5. **Custom Claude home.** T3 loads user-scope MCP servers and skills only when it runs Claude
   with the default home (`settingSources` user, project, local). With a custom home it loads
   project and local settings only; register `fundkit` there instead.
6. **Binance as destination** has no published deposit minimum on any chain (see above), so its
   plans show `venue minimum unknown` and are read again before the card and after the
   approval.

## Hetzner acceptance (real T3)

Run on the Hetzner host as the user that runs T3 Code. Real Doppler and exchange keys are used
only for reads; Scenario 2 is tested up to the card and **declined**, so no money moves.

**0. Install (once).**

```bash
cd ~ && (test -d fundkit || git clone https://github.com/pogorelov17/fundkit.git) && cd fundkit \
  && git fetch origin && git checkout feat/t3-native-address-transfer && git pull --ff-only \
  && node bin/fundkit.mjs install --no-codex
claude mcp get fundkit        # expect: command node, args […/bin/fundkit.mjs, mcp]
ls -l ~/.claude/skills/usdt-funding
node bin/fundkit.mjs status   # expect: "no fundkit session"
```

Pass: `ccxt-mcp`, `ccxt`, `jsqr` pinned in `~/.local/share/fundkit/app/node_modules`; the MCP
server and the skill link present. Start a **new** T3 thread afterwards (running threads do not
load new servers).

**1. Address, no session (the primary repro).** In the new thread, as the user, type exactly:
`Show my Binance USDT deposit address on BSC`.

Pass, in this order, with nothing typed by the user except the token in the card:
- exactly one private card titled "Doppler service token"; paste a Doppler service token whose
  config has `BINANCE_APIKEY`/`BINANCE_SECRET`;
- one shell call `…/node …/bin/fundkit.mjs unlock --token-file "<path>"` printing
  `{"ok":true,"session":"active",…}` and no value;
- `fundkit_deposit_address` called again by itself;
- the reply shows the QR image inline, the address as plain text under it, network "BNB Smart
  Chain (BEP20)" with Binance id `BSC`, and "memo: none" (or the memo first, conspicuously);
- the reply also says, without asking for an amount: "The exchange has not published a minimum
  for this network. Fundkit recommends depositing at least 1 USDT." (or its translation);
- scan the QR with a phone: it shows exactly the address in the reply; compare with Binance's
  deposit page for USDT/BSC once, by eye.

Then, on the host:

```bash
node ~/fundkit/bin/fundkit.mjs status                     # state active, doppler project/config
ls -la ~/.local/state/fundkit/qr/                          # one <sha256>.png per address
grep -c "dp.st." ~/.local/state/fundkit/run/daemon.log     # expect 0
ps -eo args | grep "[f]undkit.mjs daemon"                  # no token in argv
```

Also check that the card's file is gone (the path printed in the shell call no longer exists).

**2. Address, session active.** In the same or a new thread: `Show my Binance USDT deposit
address on TRC20`. Pass: no card, a new QR for the TRC20 address, the BSC QR not reused.

**3. Transfer up to the card, then Decline.**
`Move 10 USDT from Bybit to Binance on BSC` (with at least 10.15 USDT in Bybit Funding).
Expected: one plan message that already says "Destination deposit minimum unknown. Fundkit
recommends depositing at least 1 USDT." (or its translation), then one card with the same line;
no other question. Press **Decline** (pass as below). `Move 0.5 USDT from Bybit to Binance on
BSC` is held only by Bybit's own withdrawal minimum, never by a Fundkit minimum.
`Move 10 USDC from Bybit to Binance on BSC` is refused at once (USDT only): no card, no secret
card, nothing read. The reverse direction also
reaches the card with an amount the Binance account holds:
`Move 15 USDT from Binance to Bybit on BSC`. Pass: one plan message, then one T3
card showing plan id, amount, fee, debit/credit, the Bybit address read from Bybit, network,
expiry and the plan hash. Press **Decline**. Pass: the result says nothing was sent;
`fundkit_transfer_status` shows `dispatchAttempted: true` and result `not-sent`; Binance
withdrawal history shows nothing. Ask the agent to confirm the same plan again: it must answer
"already handled", with no new card.

**4. Cleanup.** `node ~/fundkit/bin/fundkit.mjs stop`; `status` says no session.

Report back for each step: pass/fail, the exact text of any error, and a screenshot of the
reply in step 1 and of the card in step 3.
