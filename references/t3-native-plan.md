# Implementation plan: native address and transfer flows on T3 Code (Hetzner)

Status: in progress on branch `feat/t3-native-address-transfer`. This file is the contract for
the change. Sections marked **Acceptance** list the tests that must pass before the PR leaves
draft. **Limitations** are stated up front and kept current.

## Goal

Two requests in the user's own words must work end to end on the operator's persistent T3 Code
installation on Hetzner, with no operator command, no second terminal, no Docker or SSH step,
no browser, no "готово" round trip, no UID, no setup record and no questions about
credentials, amounts, minimums or the deposit page:

1. **Address.** `Дай мой адрес Binance для USDT в BSC`
2. **Transfer.** `Переведи 300 USDT с Bybit на Binance`

Boat sandboxes are only for development and tests. The user's runtime is the persistent
installation on the Hetzner host that runs T3 Code.

## Flow 1: deposit address

```text
user ─► agent: "Дай мой адрес Binance для USDT в BSC"
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

Reply shape (Russian user, no memo):

```markdown
Ваш адрес Binance для USDT в сети BNB Smart Chain (BEP20), сеть Binance `BSC`:

![QR: адрес Binance USDT BSC](/home/op/.local/state/fundkit/qr/3f…c1.png)

`0x1b6c…exact…address`

Сеть: BNB Smart Chain (BEP20, chain id 56). Мемо/тег: не нужен.
Прочитано из вашего аккаунта Binance (binance-dst), 2026-11-26 12:03 UTC. QR содержит только этот адрес.
```

With a memo (for example a TON address with memo `000123`), the reply adds, conspicuously and
before the QR: `⚠ МЕМО ОБЯЗАТЕЛЬНО: 000123` and states that the QR carries only the address,
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
user ─► "Переведи 300 USDT с Bybit на Binance"
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
agent ─► shows the plan in one message and asks one plain question ("Подтвердить перевод?")
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

Example plan text (the confirmation shows the same fields):

```text
Перевод FK-7Q2M9X (до 12:18 UTC)
Bybit (FUND) → Binance, USDT, сеть BNB Smart Chain (BEP20): Bybit BSC → Binance BSC
Сумма к зачислению: 300 USDT; комиссия Bybit: 0.3 USDT сверху; списание: 300.3 USDT
Получатель (из вашего аккаунта Binance): 0x1b6c…  мемо: нет
Доступно на Bybit FUND: 812.44 USDT; минимум вывода 10; максимум 1 000 000; шаг 0.0001
```

## Hard limits found while planning

- **Binance deposit minimum.** Binance documents no API deposit minimum (`depositDust` has no
  documented meaning; [recipients.md](recipients.md#binance)). Flow 2 with Binance as B
  therefore stops before any dispatch with `DESTINATION_MINIMUM_UNDOCUMENTED`, says exactly
  that, and does not send the user to look it up. The reverse route (Binance → Bybit) uses
  Bybit's documented `depositMin` and reaches the confirmation.
- **T3 elicitation forms.** T3 Code shows an MCP elicitation as an approval card (Approve,
  Decline, Cancel, "Always allow this session") and fills the accepted content itself. A
  required boolean field without an enum (ccxt-mcp's `confirm`) cannot be filled, so T3
  cancels ccxt-mcp's own form unconditionally. The broker therefore re-presents the
  downstream form with a single-option string field (`decision: "approve"`), which T3 can
  answer, and maps the human's answer back. "Always allow this session" caches by server and
  exact message; every confirmation message carries the plan id and hash, so no cached grant
  ever matches another transfer.
- **Native venues.** `fundkit_deposit_address` and the transfer tools support Binance and
  Bybit natively in this change. The other seven venues return `VENUE_NOT_NATIVE` with the
  reason; their documented manual reads in [SKILL.md](../SKILL.md) are unchanged.
- **Inline images.** T3 renders Markdown images with absolute paths. Whether a given T3
  build also renders MCP `image` content in tool results is not relied on; the tool returns
  both and the skill uses the Markdown image.
- **Compliance fields.** fundkit sends no travel-rule or beneficiary data. Where the exchange
  requires it for the account's entity (Bybit KR/IN/TR/KZ/ID/AE, regional Binance entities),
  the exchange rejects the withdrawal before sending; the plan says so.

## Key rights (all nine venues)

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
   the nine venues, honest host matrix.
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
- **Transfer.** Bybit → Binance holds on the Binance minimum with zero dispatch. Binance →
  Bybit prepares a plan; T3-shaped host: Decline, Cancel and no answer give zero dispatch;
  Approve gives exactly one dispatch with the frozen arguments; a second confirm, a new broker
  process and a confirm after expiry give no second dispatch; a changed amount needs a new
  plan; the ccxt-mcp boolean form is never forwarded raw and never answered without the
  human.

Manual (parent agent, real T3 on Hetzner): see
[Hetzner acceptance](#hetzner-acceptance-real-t3) below; filled in when the code lands.

## Hetzner acceptance (real T3)

Filled in with the final commands once the implementation is pushed.
