# Secrets, host setup, key permissions

The agent sees only aliases and tool results. The operator gives each server its keys either
in that profile's own `chmod 600` `config.json` (scheme C) or through the launch environment
(schemes A and B). No values belong in the repository, host configs, argv or the chat.

## Environment contract

- **One MCP server = one account.** Each server has its own `config.json` with one account
  and a unique alias. Uniqueness is required across all servers because the journal is shared
  ([`ccxt-mcp.md`](ccxt-mcp.md#journal)).
- ccxt-mcp reads keys from `<EXCHANGE>_APIKEY` and `<EXCHANGE>_SECRET`, plus
  `<EXCHANGE>_PASSWORD` (API passphrase) for OKX, Bitget and KuCoin. Gate's id is `gate`
  (`GATE_*`). Hyperliquid gets no variables.
- Do not enable `loadEnvKeys` and do not set `CCXT_MCP_APIKEY*` / `CCXT_MCP_EXCHANGE*`: they
  create a `default` account. Two accounts of the same exchange in one process would get the
  same key.

**There is no automatic secret isolation between accounts.** Claude Code passes its whole
launch environment to every MCP server (verified), so prefixed names such as `OKX_MAIN_*` and
`${…}` substitution in `.mcp.json` isolate nothing: every server gets the values, and so does
the agent's shell. Codex passes a server only the names in its `env_vars` (verified), but the
values still sit in the host environment, and two servers listing the same names get the same
values. Whether the agent's shell can see them depends on Codex settings and was not tested
here, so assume it can. Three launch schemes are supported, plus an optional fourth. Scheme C
is the recommended file-based one for exchange A → exchange B, because both accounts can then
be connected in the same session with separate credentials. Scheme D does the same with
credentials fetched from one Doppler config for one session only, and nothing on disk.

### Scheme A: one keyed account per launch

The launch environment holds keys for **only one** account, and exactly one enabled server
uses that exchange ([below](#one-registration-per-keyed-exchange)); other servers run
without keys (for example Hyperliquid). The agent's shell sees that environment. A withdrawal
or transfer in step 1 or 2 below needs a [money-moving registration](#money-moving-registrations)
with the native form; otherwise it is done in the exchange UI. An A → B route is two separate launches, each with a fresh chat that starts with
`Read SKILL.md …` ([loading the skill](#loading-the-skill)):

1. **Launch with A's key (initial checks and withdrawal).** Check both networks, with B's
   fields from a public source or read by the human on B's deposit page, and run the A plan.
   It binds only A's writes, B's deposit route (network, full address, memo) and the
   expected credit bounds; the human notes where B credits deposits. The chat ends with the
   filled-in HANDOFF block ([SKILL.md, 2.8](../SKILL.md#28-settlement-on-b)).
2. **Launch with B's key (settlement).** The human pastes the HANDOFF block and follows Step 0 for prior operations. The agent
   checks that B's alias is the block's, attributes the deposit by hash, finds the wallet holding it
   and, if needed, makes a new plan with its own approval for the exact B transfer. B's
   wallets, steps and caps are read only here.

Until the B session runs, the funds sit in whichever B wallet takes deposits (often funding,
main or spot; see the [account mode table](exchanges.md#account-mode-and-available-amount)).

### One registration per keyed exchange

ccxt-mcp fills **every** account of an exchange in the process from the same
`<EXCHANGE>_*` variables. Claude Code passes them to every server, and Codex to every server
that lists them in `env_vars`. So two enabled registrations for one exchange in a scheme A
launch (for example `ccxt-okx-main` and `ccxt-okx-sub`) both sign with the launch's key under
different aliases (verified offline). An alias is a label: it cannot show which account a key
belongs to.

Before the launch, the operator leaves exactly one registration enabled for the keyed
exchange and removes or disables the others:

- Claude Code: `claude mcp remove <name> -s <scope>` (verified), or disable it for this project
  in interactive `/mcp`; then `claude mcp list` must show only one server for that exchange.
- Codex: `enabled = false` in that server's `[mcp_servers.<name>]` table; `codex mcp list`
  then shows it as `disabled` (verified).

In the session, Step 0 of [`SKILL.md`](../SKILL.md#step-0-preflight-read-only) stops if more
than one connected server or alias has the keyed exchange. With exactly one, the operator's
mapping of that registration to the account is trusted: no UID is read or compared.

The agent in such a launch can technically read that key (same OS user; rule 1 of
[`SKILL.md`](../SKILL.md#hard-rules) forbids it). The skill relies on the agent following that
rule ([trust model](#trust-model)), and exchange-side restrictions are mandatory.

The operator loads the values into their own shell by their own means, then starts the host
with only the allowed variables left (bash):

```bash
( unset $(compgen -e | grep -vxE 'HOME|PATH|TERM|LANG|OKX_APIKEY|OKX_SECRET|OKX_PASSWORD'); exec claude )
```

For Codex, end with `exec codex` instead. Values never reach argv. Verified on Claude Code
with a dummy server that records names only: other `BYBIT_*` and unrelated variables did not
reach the servers. If the host needs its own variable to sign in, add its name to the list.

### Scheme B: operator launcher per server

In the host config, `command` points to an operator launcher outside the repository. The
launcher starts ccxt-mcp with only its own account's variables. Neither the host environment
nor its config contains secrets. This separates credentials between profiles. It is not a
boundary against the agent ([trust model](#trust-model)). How to store secrets and what to launch with is the
operator's choice: the skill does not prescribe it, and the repository contains no code for
it.

### Scheme C: per-profile credential files (two-profile session)

ccxt-mcp 0.1.3 reads credentials from the account entry in `config.json` (`apiKey`, `secret`,
`password`), the way its own README describes. A value set there is never overridden by
`<EXCHANGE>_*` variables; those only fill fields the config leaves out (`js/pools.js`). So:

1. One profile directory per account, each with its own `config.json` holding exactly one
   account with **all** of the venue's required credential fields
   ([venue profiles](#venue-profiles)). A missing field would be filled from the environment.
2. `chmod 600`, owned by the server's user, and `"strictPermissions": true`: the server
   refuses a file readable by others (`REFUSED (strictPermissions)` in `configProblems`,
   verified).
3. One registered server per profile, each with only `CCXT_MCP_CONFIG` in its `env`
   ([host registration](#host-registration)). No `<EXCHANGE>_*` variables in the host
   launch environment.

Verified offline (two servers in one MCP session, synthetic keys): every request of each
server was signed with its own config's key, also for two OKX profiles side by side and when
the host environment carried another account's `OKX_*` values. ccxt-mcp registers config
credentials for redaction, so a key echoed by an exchange read comes back as
`[redacted:…]`. `list_accounts` shows only which credential fields are set.

What scheme C separates: each server process loads only its own file, so one profile's key
never signs another profile's requests (verified offline). What it does not do: keep the files
from the agent. The agent's shell runs as the same OS user and could read them (rule 1 of
[`SKILL.md`](../SKILL.md#hard-rules) forbids it). The skill relies on the agent following that
rule ([trust model](#trust-model)). The exchange-side restrictions below are mandatory.

### Scheme D: session-only Doppler profiles (optional)

For operators who keep every exchange key in one Doppler config and want no key on disk. It is
opt-in. Schemes A to C and already registered profiles keep working without it, and the agent
uses those first ([SKILL.md, session profiles](../SKILL.md#session-profiles-optional-doppler)).
`bin/fundkit.mjs` is a thin entry point for Node 20+; the code is in `lib/` and uses only
the standard library. It has five parts: `install`, the private terminal step `session`, the
passphrase step `passphrase`, the host-side MCP server `mcp`, and `status`/`stop`.

**Once per machine** (operator's shell, needs Node 20+, npm and network):

```bash
git clone https://github.com/pogorelov17/fundkit.git ~/fundkit && node ~/fundkit/bin/fundkit.mjs install
```

`install` does four things, each idempotent:

- It installs the [pins](ccxt-mcp.md#install) into `~/.local/share/fundkit/app` with
  `--save-exact --ignore-scripts`, or keeps an existing install with exactly those versions
  (`--app-dir <dir>` picks another directory).
- It writes the launcher `~/.local/bin/fundkit` and a non-secret `~/.config/fundkit/install.json`.
- It links the skill for automatic discovery: `~/.claude/skills/usdt-funding` for Claude Code
  and `~/.agents/skills/usdt-funding` for Codex.
- It registers one MCP server named `fundkit` with no `env`: `claude mcp add-json -s user`,
  and a `[mcp_servers.fundkit]` table with `tool_timeout_sec = 420` in `$CODEX_HOME/config.toml`.
  A host CLI that is missing is skipped.

Then start a **new** host session: a running Claude Code or Codex does not load a server
registered after it started. Both hosts document that they pick up new skill folders without a
restart. Whether the model picks the skill for a request is the host's choice. If it does not,
start with `Read SKILL.md` ([loading the skill](#loading-the-skill)), `/usdt-funding` (Claude
Code) or `$usdt-funding` (Codex). The `fundkit` server's `initialize` instructions and tool
descriptions also point to `SKILL.md`.

**The Doppler config.** One project config holds **one account per exchange**, under exactly
two names per venue and nothing else:

| Exchange | Doppler names |
|---|---|
| Binance | `BINANCE_APIKEY`, `BINANCE_SECRET` |
| Bybit | `BYBIT_APIKEY`, `BYBIT_SECRET` |
| Gate | `GATE_APIKEY`, `GATE_SECRET` |
| OKX | `OKX_APIKEY`, `OKX_SECRET` (+ API passphrase typed in the private terminal) |
| Bitget | `BITGET_APIKEY`, `BITGET_SECRET` (+ API passphrase typed in the private terminal) |
| WhiteBIT | `WHITEBIT_APIKEY`, `WHITEBIT_SECRET` |
| BingX | `BINGX_APIKEY`, `BINGX_SECRET` |
| MEXC | `MEXC_APIKEY`, `MEXC_SECRET` |
| KuCoin | `KUCOIN_APIKEY`, `KUCOIN_SECRET` (+ API passphrase typed in the private terminal) |

Only the exchanges a route uses need to exist. fundkit fetches exactly those two names for the
exchange it connects. There are no role suffixes (`_SOURCE_`, `_DEPOSIT_`, `_SETTLEMENT_`), no
third name and no fallback: a passphrase stored in Doppler (`OKX_PASSWORD` or any other name) is
never requested, and the old role-suffixed names do not stand in for the plain ones
(`MISSING_SECRETS` lists the plain names). Create a **service token** for that config: it is
read-only unless write access is granted, so do not grant it. An expiry is optional
([Doppler service tokens](https://docs.doppler.com/docs/service-tokens)). Only `dp.st.…`
tokens are accepted. Personal and CLI tokens reach every project of the account and are
refused.

**One key, several local roles.** Because the config has one key per exchange, the same key
serves that exchange as source A on one route and as destination B on the reversed route, and
as settlement on B. The key's **exchange-side capability** (what the exchange lets it do: read,
transfer, withdraw) is whatever the operator granted when creating it, and it is usually
write-enabled if the exchange is ever a source. The **local role** is what fundkit forwards on
one profile, and the session daemon (the process that holds the credentials) enforces it on
every call, whatever the key could do:

| Local role (alias) | fundkit forwards | Never forwarded |
|---|---|---|
| deposit-only (`<ex>-dst`) | `get_safety_status`, `list_accounts`, `get_balance`; `call_read_method` `fetchBalance`, `fetchDepositWithdrawFee`, `fetchAccounts`, `fetchDeposits`, `fetchDepositAddress`, `fetchDepositAddressesByNetwork`; `call_implicit_get` only the venue's documented key-check, network-data and recipient endpoints. Always `dryRun: true`, `maxTransferValue: 10` | `withdraw`, `transfer`, every other method |
| settlement (`<ex>-settle`) | the same state and network reads, `fetchTransfers`, `fetchTransfer`, `fetchLedger`, Gate's transfer-proof read; `transfer` after approval | `withdraw`, recipient reads |
| source (`<ex>-src`) | the same state and network reads, `fetchWithdrawals`, `fetchTransfers`, `fetchTransfer`, `fetchLedger`, the Binance and Gate saved-address reads; `withdraw` and `transfer` after approval | recipient reads |
| every role | | `get_deposit_address`, `call_write_method`, `call_implicit_write`, the trading tier, any tool or method not listed |

The allowlists are in [`lib/policy.mjs`](../lib/policy.mjs). Arguments must name the profile's
own `exchange` and `account`. There is no account-UID binding: one Doppler config is one
account per exchange, and the operator's mapping of the selected exchange and profile to
`<EX>_APIKEY`/`<EX>_SECRET` is trusted. fundkit never reads a UID for that purpose (the reads
that only return one, Binance `privateGetAccount`, BingX `accountV1PrivateGetUid` and MEXC
`spotPrivateGetUid`, are `NOT_FORWARDED`), never stores or compares one, and `fundkit_write`
takes no `uid` (an older caller's is ignored). A key check whose metadata also names a UID is
used for its key rights only.

- a recipient read (and a provisioning read), and every `withdraw` and `transfer`, runs only
  after a successful key check on this profile in this session, where the venue has a key read
  (`KEY_CHECK_REQUIRED` names the call). A failed key check opens nothing;
- WhiteBIT has no key read, so its key rights come from the setup record only, and its
  `withdraw` and `transfer` go to the native form like every other venue's. The route gates
  still apply: as a source its available amount is not visible through these tools, so an API
  withdrawal plan from WhiteBIT holds, and the manual sheet in WhiteBIT's UI remains;
- the Gate and WhiteBIT address reads that may create an address are forwarded only on a session
  started with `--allow-provisioning gate` (or `whitebit`, or both), in addition to the setup
  record's provisioning line.

A deposit-only profile on a write-enabled key is therefore deposit-only **locally**: the agent
reports what the venue key check shows (for example "withdrawal right present, deposit-only
role enforced by fundkit") and never calls such a key read-only. The same holds outside
Doppler: one key per exchange may serve every role, and no instruction asks for a separate
read-only key or for removing rights ([venue profiles](#venue-profiles)).

**API passphrase (OKX, Bitget, KuCoin).** These venues sign with a third credential. It is a real
credential, not a placeholder, and it is **not** in Doppler. The operator types it in a private
terminal, once per exchange and session; it stays in the session's memory and goes only to that
exchange's profile processes as `<EX>_PASSWORD`. It never goes to the chat, a native form, argv,
a file, a log, the host, `fundkit mcp` or Doppler, and it is redacted from everything a profile
prints. Three ways, all with hidden input:

| Launch | How the passphrase is entered |
|---|---|
| two terminals (`fundkit session` in terminal 2) | When a profile first needs it, `fundkit_connect` answers `PASSPHRASE_NEEDED`, and terminal 2 beeps and shows `OKX API passphrase (for the key in OKX_APIKEY):`. The operator types it there and tells the agent; the agent connects again. |
| up front, any launch | `fundkit session --passphrase okx,kucoin` asks for each right after the token, before the host starts. Enter on an empty line skips one; Ctrl-C cancels the session start. |
| `fundkit session -- claude` (the host runs in that terminal) | The session cannot prompt there. `PASSPHRASE_NEEDED` says to run `fundkit passphrase okx` in another terminal on the machine (for example a second SSH session), which sends it over the session's `0600` socket. |

Ctrl-C at the on-demand prompt (or an empty line) skips it without ending the session; the next
`fundkit_connect` reports `PASSPHRASE_CANCELLED` once, and the one after asks again. With no answer
for 300 s it reports `PASSPHRASE_TIMEOUT`. Nothing starts without the passphrase. A mistyped one
shows as the venue's key error at the key check: run `fundkit passphrase <exchange>` to replace
it, then disconnect and reconnect that profile. The host-side broker cannot set a passphrase.

**Once per session: the private terminal step.** When the agent needs a profile that is not
connected, it tells the user to run, in a second terminal on the same machine (over SSH, a
second SSH session):

```bash
fundkit session                                   # money-moving profiles dryRun
fundkit session --writes --max-transfer 300 --max-daily 600
fundkit session --passphrase okx -- claude        # or -- codex: ask first, then start the host here
fundkit passphrase okx                            # another terminal: OKX passphrase for a running session
```

The token is pasted at the hidden prompt. The terminal shows the Doppler project and config
it reads, then one line per profile with the names fetched (never values). Options: `--ttl`
(default `8h`), `--keep` (outlive the host session), `--writes` (only together with
`--max-transfer <USD>`; it sets `dryRun: false` and `maxTransferValue` on source and
settlement profiles), `--max-daily <USD>`, `--passphrase okx,bitget,kucoin` (ask those
passphrases up front), `--allow-provisioning gate,whitebit` (forward the address reads that may
create an address). Deposit-only profiles get `dryRun: true` and `maxTransferValue: 10` always.
Every profile gets `confirm: "always"`, `funds: "live"`, `strictPermissions` and
`hideDisabledTools`. With profiles already connected, nothing here runs and nothing asks.

**Where each value goes.**

| Value | Path | Never |
|---|---|---|
| service token | the session opens `/dev/tty` and turns echo off before it prints the prompt. The token stays in that process's memory and goes only as `Authorization: Bearer` to `https://api.doppler.com` (HTTPS, redirects refused) | argv, any process environment, files, logs, MCP messages, the host, the agent, ccxt-mcp, exchanges. It is not read from stdin, argv or the environment; a `DOPPLER_TOKEN` in the shell is ignored and removed from the environment of a host started with `--` |
| exchange keys | one `GET /v3/configs/config/secrets/download?format=json&secrets=<EX>_APIKEY,<EX>_SECRET` per profile ([Doppler API](https://docs.doppler.com/reference/secrets-download)), never a bulk download. A response that holds any unrequested name not starting with `DOPPLER_` is refused whole. The values go as `<EX>_APIKEY` and `<EX>_SECRET` into the environment of that profile's ccxt-mcp process only. That process gets a minimal environment: `PATH`, `HOME`, `LANG`, `TZ`, `XDG_CACHE_HOME`, proxy and CA variables, `CCXT_MCP_CONFIG` | other profiles' processes, argv, files, tool results. Everything the process prints is redacted (raw, JSON-escaped and URL-encoded forms) before it leaves the session, on top of ccxt-mcp's own redaction |
| API passphrase (OKX, Bitget, KuCoin) | typed hidden in the session terminal, before the session with `--passphrase`, or with `fundkit passphrase <ex>` over the session socket; kept in the session's memory, passed as `<EX>_PASSWORD` to that exchange's profile processes only, dropped when the session ends | Doppler, the chat, native forms, argv, files, logs, MCP messages, the host, other exchanges' processes |
| profile `config.json` | `~/.local/state/fundkit/run/profiles/<alias>/config.json`, `chmod 600`, in a `0700` directory, removed when the profile stops | no credentials in it |
| session control | a Unix socket `~/.local/state/fundkit/run/session.sock` (`0600`, directory `0700`). The host-side `fundkit mcp` holds neither the token nor any value. No message on the socket returns a secret, so the agent gets no generic secret reader: it can only name an exchange and a role | |

Before the token, the session checks it with one request for Doppler's own metadata names
(`DOPPLER_PROJECT`, `DOPPLER_CONFIG`, `DOPPLER_ENVIRONMENT`) and shows the project and config.

**End of a session.** Each of these drops the token, every fetched value and every typed passphrase. It also stops
every profile process and removes the profile files and the socket:

- Ctrl-C, closing the terminal (`SIGHUP`), `SIGTERM` or `fundkit stop`;
- the `--ttl` limit;
- Doppler answering `401` or `403` (expired or revoked token);
- the host session that used it closing (unless `--keep` was given);
- with `--`, the host exiting.

A transient Doppler error (`5xx`, `429`, a timeout) keeps the session, and the profile reports
it. A new session needs the token again. A host that is still running reconnects to the new
session on its next `fundkit` call, with no restart. Nothing from the old session carries
over.

**Native dialog versus private terminal.** The host's native form (MCP form elicitation) is
used only for what ccxt-mcp asks: the one-boolean confirmation of each `withdraw` and
`transfer`. `fundkit mcp` forwards it to the host unchanged, and only when the host declared
`elicitation`. The token never goes through it. The MCP specification says servers "MUST NOT
use form mode elicitation to request sensitive information such as passwords, API keys, access
tokens", and a form answer passes through the host
([MCP elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)).
URL mode is meant for secrets, but it opens a browser. No other secret-input dialog that Claude
Code or Codex offers an MCP server was found or used here. So the boundary is this: the
**native dialog** is the human's yes or no for a money move, and the **private terminal step**
(hidden input outside the agent's transcript) is the only place the token is typed.

**Limits.** These are the same as in [scheme C](#scheme-c-per-profile-credential-files-two-profile-session),
under the [trust model](#trust-model):

- The profile processes and the session run as the operator's user. That user, and so the
  agent's shell, can read `/proc/<pid>/environ` of a profile process, and can connect to the
  socket and drive a profile without the host's form. Rule 1 of
  [`SKILL.md`](../SKILL.md#hard-rules) forbids both; nothing prevents them.
- JavaScript cannot wipe strings, so the token, the values and the passphrases stay in process
  memory (and possibly swap) until the process exits.
- The role allowlists and the key-check gate run in the session daemon. A process of the operator's
  user that talks to the socket directly gets the same decisions, but it could also read a
  profile's `/proc/<pid>/environ` or start its own ccxt-mcp with the key; see the first point.
  Exchange-side rights stay the real limit: a write-enabled key is write-enabled.
- Which account a profile signs for is the operator's mapping, not something fundkit checks: a
  Doppler config whose names hold another account's key moves that account's funds (within the
  key's exchange-side rights, the caps and the human's form).
- Ending a session while a `withdraw` or `transfer` is open kills its process. Treat the
  outcome as unknown and reconcile ([SKILL.md, 2.7](../SKILL.md#27-reconciliation)).

**Verified offline** (2026-11-26, `tests/`, Node 24, Python 3.12). All values
were synthetic. The Doppler API was a disposable loopback mock, the private terminal a real
pseudo-terminal, and the host a simulated MCP client; the details are in
[ccxt-mcp.md](ccxt-mcp.md#verification). Not verified: the real Doppler service, real
exchange keys, a model choosing the skill or offering the step in a real Claude Code or Codex
chat, and isolation of any kind.

### Scheme D on T3 Code: one private card

On a host whose agent has a private secret card with file delivery (T3 Code's `request_secret`
with `delivery: "file"`), no terminal step is needed:

- The fundkit result names the card (`secretStep.request`) and one command
  (`secretStep.then`). The MCP server cannot open the card itself: a server does not see its
  host's tools, so the agent opens it.
- T3 writes the value to a `0600` regular file in a `0700` directory and returns the path. The
  agent runs `fundkit unlock --token-file <path>`. fundkit refuses anything but a private regular
  file of the current user in a directory only that user can change, opens it without following
  links, reads it once and deletes it before using the value; if it cannot delete it, it does not
  use it. T3 itself removes unclaimed secret files after 24 hours.
- The token goes to a detached session daemon on its stdin pipe (never argv, the environment, a
  file or a log). The daemon checks it with Doppler, keeps it in memory for `--ttl` (8 h), keeps
  running across T3's MCP restarts between turns, and ends on `fundkit stop`, the time limit or a
  rejected token. Its log (`~/.local/state/fundkit/run/daemon.log`) holds no value.
- OKX, Bitget and KuCoin passphrases arrive the same way, one card per exchange and session, with
  `fundkit unlock --passphrase <exchange> --secret-file <path>`.
- Trust boundary: the file and the control socket belong to the operator's user, like the agent's
  own shell. A cooperative agent never reads the file; nothing in the OS stops that user from
  reading it before fundkit deletes it ([trust model](#trust-model)).

Transfers on such a host use `fundkit_transfer_prepare` and `fundkit_transfer_confirm`: the
session starts a single-use source profile for one plan (`dryRun: false`, `maxTransferValue` equal
to the plan amount), forwards only its key check and one `withdraw` whose arguments hash to the
registered plan, and journals the dispatch with an exclusive create before forwarding it. Other
money-moving profiles keep the `--writes` rule above.

### Money-moving registrations

A registration that can move money is a source A with a withdrawal key, or a settlement
registration on B with an internal-transfer key. The skill moves money through it only when all
of these hold:

- the [setup record](#setup-record) names it with role `source` or `settlement`, and Step 0
  shows the same registration, alias, exchange, environment, `configPath` and `journal`;
- its key check shows the role's rights (WhiteBIT: the setup record's key-rights line). A
  settlement registration is the one the setup record names for the same B account as B's
  deposit-only profile; that mapping is the operator's, and no UID is compared;
- `get_safety_status` reports `elicitationSupported: true`, so every `withdraw` and `transfer`
  opens the host's native form, and the setup record states that the form is an interactive
  dialog nobody answers automatically ([interactive form](#interactive-native-form));
- the exchange-side limits are in place: IP allowlist, withdrawal whitelist, the venue's
  withdrawal limit and minimal key rights.

Where the server process runs is the operator's choice: the agent's OS user, another OS user
reached through a fixed `sudo` rule, a container or a system service. The skill does not depend
on that choice, and no tool result can show it ([trust model](#trust-model)).

### Profile `config.json`

In schemes A and B it holds no secrets; in scheme C it also holds the account's credentials
([venue profiles](#venue-profiles)). Only the operator edits it.

```json
{
  "settings": { "strictPermissions": true, "hideDisabledTools": true },
  "accounts": {
    "okx-main": {
      "exchange": "okx",
      "funds": "live",
      "maxTransferValue": 200,
      "maxDailyValue": 500,
      "confirm": "always",
      "dryRun": true
    }
  }
}
```

Set the file to `chmod 600`, owned by the server's user. With `strictPermissions: true` the
server refuses a file with other permissions, and `get_safety_status` shows
`REFUSED (strictPermissions)` in `configProblems` (verified). A read-only profile has no
`funds` and no `trading`. `environment` comes from the config (`"sandbox": true` gives
`sandbox`). Every server of one route must report the environment the plan names. Hyperliquid:
`{"accounts":{"hl-watch":{"exchange":"hyperliquid","walletAddress":"0x…"}}}`. Start with
`"dryRun": true` and remove it only after the plan has been walked through.

### Bybit deposit profile

One-time setup that lets the agent read the operator's own Bybit deposit address
([SKILL.md, Bybit deposit address](../SKILL.md#bybit-deposit-address)). It works from a cold
start with nothing installed:

1. **Server.** Install the pinned server once ([install](ccxt-mcp.md#install)).
2. **Key.** Use the Bybit key of the **main** account (Bybit gives deposit addresses only to
   main-account keys). Its other rights do not matter for this read: the profile is kept to
   reads by `dryRun: true` and the skill's read-only calls. Bind your IP.
3. **Profile** (`chmod 600`). `funds` is needed because ccxt-mcp gates the address read
   behind it, and `"funds": "live"` requires some `maxTransferValue`. That cap applies only
   to MCP `transfer` and `withdraw` on this account, which `dryRun: true` blocks; it does not
   limit what you send from your own wallet:

   ```json
   {
     "settings": { "strictPermissions": true, "hideDisabledTools": true },
     "accounts": {
       "bybit-main": {
         "exchange": "bybit",
         "funds": "live",
         "maxTransferValue": 10,
         "confirm": "always",
         "dryRun": true
       }
     }
   }
   ```

4. **Keys.** Scheme C: add `"apiKey"` and `"secret"` to the account entry in this profile's
   `config.json` ([scheme C](#scheme-c-per-profile-credential-files-two-profile-session)).
   Otherwise put the key and secret into `BYBIT_APIKEY` and `BYBIT_SECRET` in the environment
   the server is launched with, by your own means, never in the repository or the chat.
   Scheme A in Claude Code:
   `( unset $(compgen -e | grep -vxE 'HOME|PATH|TERM|LANG|BYBIT_APIKEY|BYBIT_SECRET'); exec claude )`.
   In Codex, also set `env_vars = ["BYBIT_APIKEY", "BYBIT_SECRET"]` in the registration.
   Scheme B: your launcher sets them.
5. **Register** the server with `CCXT_MCP_CONFIG` pointing to this profile
   ([host registration](#host-registration)), restart the host, start a new chat with the
   skill read. If something fails, the agent follows the
   [Bybit setup check](../SKILL.md#bybit-setup-check).

### Quick setup (cooperative scope)

A two-profile example for Claude Code with scheme C: OKX as source A, Bybit as destination B,
plus a Bybit settlement registration. Directory names are examples. Run it in the operator's
own shell, not through the agent. Replace `<APP_DIR>` with the install directory
([install](ccxt-mcp.md#install)).

```bash
mkdir -p ~/fundkit-profiles/okx-src ~/fundkit-profiles/bybit-dst ~/fundkit-profiles/bybit-settle
# write each config.json with an editor (examples below); keys go only into these files
chmod 600 ~/fundkit-profiles/*/config.json
for p in okx-src bybit-dst bybit-settle; do
  claude mcp add-json -s user "ccxt-$p" "{\"command\":\"/usr/bin/node\",\"args\":[\"<APP_DIR>/node_modules/ccxt-mcp/js/server.js\"],\"env\":{\"CCXT_MCP_CONFIG\":\"$HOME/fundkit-profiles/$p/config.json\"}}"
done
claude mcp list
```

The three config files are shown [below](#venue-profiles) (source, deposit-only destination,
settlement). Then check the Claude Code settings for hooks or plugins that answer forms
([interactive form](#interactive-native-form)), restart, start a new chat with the
[setup prompt](prompts.md#setup-and-diagnosis), and write the [setup record](#setup-record).
This setup separates the three keys from each other. It does not hide them from the agent,
and it relies on the agent following the rules ([trust model](#trust-model)). Running all
three servers under the operator's own OS user is fine.

### One-session read-only start (Bybit, or Bybit plus BingX)

The smallest useful first session reads only: it connects deposit-only profiles and lets the
agent check them, so nothing can move. For Bybit alone, follow the
[Bybit deposit profile](#bybit-deposit-profile) (one read-only main-account key, IP bound).
To add BingX in the same session, create a BingX key with read permission only and an IP
allowlist, put it in its own profile directory, and register a second server:

```bash
mkdir -p ~/fundkit-profiles/bybit-dst ~/fundkit-profiles/bingx-dst
# write both config.json files with an editor: "funds": "live", a small "maxTransferValue", "dryRun": true, keys in the file
chmod 600 ~/fundkit-profiles/*/config.json
for p in bybit-dst bingx-dst; do
  claude mcp add-json -s user "ccxt-$p" "{\"command\":\"/usr/bin/node\",\"args\":[\"<APP_DIR>/node_modules/ccxt-mcp/js/server.js\"],\"env\":{\"CCXT_MCP_CONFIG\":\"$HOME/fundkit-profiles/$p/config.json\"}}"
done
claude mcp list
```

Restart the host and paste the [read-only starting prompt](prompts.md#read-only-starting-prompt).
The agent reports the versions, both key checks (rights, no UIDs), the networks, and the verified
deposit addresses. Write the registration lines of the [setup record](#setup-record) from that
report (BingX: also the permission-code meanings shown on BingX's API page). Money-moving
registrations come later and need their own lines.

### Venue profiles

One-time setup per account, from a cold start with nothing installed. Install the pinned
server once ([install](ccxt-mcp.md#install)); then, per account:

| Venue (`exchange`) | Credential fields (scheme C `config.json`) | Variables (schemes A and B) | Deposit-only profile: what the [key check](recipients.md) needs (any further rights are fine; report them as shown) |
|---|---|---|---|
| Binance (`binance`) | `apiKey`, `secret` | `BINANCE_APIKEY`, `BINANCE_SECRET` | `enableReading: true` |
| Bybit (`bybit`) | `apiKey`, `secret` | `BYBIT_APIKEY`, `BYBIT_SECRET` | `isMaster: true` (Bybit serves deposit addresses only to main-account keys) |
| OKX (`okx`) | `apiKey`, `secret`, `password` (API passphrase) | `OKX_APIKEY`, `OKX_SECRET`, `OKX_PASSWORD` | `perm` includes `read_only` |
| Bitget (`bitget`) | `apiKey`, `secret`, `password` | `BITGET_APIKEY`, `BITGET_SECRET`, `BITGET_PASSWORD` | a successful read (report `authorities`) |
| BingX (`bingx`) | `apiKey`, `secret` | `BINGX_APIKEY`, `BINGX_SECRET` | a successful read (report the permission codes) |
| WhiteBIT (`whitebit`) | `apiKey`, `secret` | `WHITEBIT_APIKEY`, `WHITEBIT_SECRET` | no key read exists: say so |
| MEXC (`mexc`) | `apiKey`, `secret` | `MEXC_APIKEY`, `MEXC_SECRET` | `SPOT_WITHDRAW_READ` among the key's rights (MEXC's deposit-address read needs it); no read shows the rights (`canWithdraw` in `GET /api/v3/account` is an account flag), so the setup record names them |
| KuCoin (`kucoin`) | `apiKey`, `secret`, `password` | `KUCOIN_APIKEY`, `KUCOIN_SECRET`, `KUCOIN_PASSWORD` | `permission` includes `General` |
| Gate (`gate`) | `apiKey`, `secret` | `GATE_APIKEY`, `GATE_SECRET` | the read has no permission fields: say so |
| Hyperliquid | none: `walletAddress` only | none | watch-only |

Rights a money move needs, per venue (the exchange refuses the move without them; a key
with more rights is fine for every role). The deposit-only need is in the table above. The offline tests
exercised settlement on Bybit, OKX, Bitget and BingX only. Names follow each
venue's API key page; confirm them there once and record them in the setup record:

| Venue | Source A (withdraws) | Settlement on B (internal transfer) |
|---|---|---|
| Binance | Enable Withdrawals (Binance requires an IP restriction for it); `enableInternalTransfer` or universal transfer only if A moves funds first | `permitsUniversalTransfer: true` |
| Bybit | `readOnly: 0`, `Wallet: Withdraw` (plus `AccountTransfer` if needed), main account | `readOnly: 0`, `Wallet: AccountTransfer` |
| OKX | `perm` includes `withdraw` | `perm` includes `trade` (OKX grants transfers with trade) |
| Bitget | an authority naming withdrawal | an authority naming transfer |
| BingX | the permission code recorded for withdrawal | the code recorded for transfer |
| MEXC | setup record key rights `SPOT_ACCOUNT_READ`, `SPOT_WITHDRAW_READ`, `SPOT_WITHDRAW_WRITE` | setup record key rights `SPOT_TRANSFER_READ` and `SPOT_TRANSFER_WRITE` |
| KuCoin | `permission` includes `Withdrawal` | `permission` includes `Transfer`; proof is operator or manual ([transfer proof](exchanges.md#transfer-proof)) |
| Gate | withdrawal right per the setup record (the key read has no permission fields) | transfer right per the setup record |
| WhiteBIT | per the setup record (no key read) | per the setup record; proof is operator or manual |

One key per exchange may serve every role, in every scheme; an IP allowlist is recommended
where the venue offers one. In [scheme D](#scheme-d-session-only-doppler-profiles-optional)
fundkit enforces the roles locally; in schemes A to C the profile settings and the skill do:

- **Destination (B) recipient profile**: reads only. The profile needs `"funds": "live"` and a
  `maxTransferValue` because ccxt-mcp gates address reads behind `funds`; keep
  `"dryRun": true`, which stops any MCP money move on it whatever the key could do.
- **Destination settlement**: a second registration for the same B account (it may use the
  same key), with role `settlement` in the setup record, only if the credit must move from the
  deposit wallet to another B wallet. The agent never uses the deposit-only profile for a
  transfer.
- **Source (A)**: read + withdrawal (+ internal transfer when A moves funds into its
  withdrawal wallet), an exchange-side withdrawal limit and B's address on A's withdrawal
  whitelist. The operator adds that address once in A's security settings with 2FA; the agent
  never does and never asks to skip it.

Example (scheme C) for the three registrations of an A → B route with settlement on B, one
file per registration (source, deposit-only destination, settlement):

```json
{
  "settings": { "strictPermissions": true, "hideDisabledTools": true },
  "accounts": {
    "okx-src": {
      "exchange": "okx", "apiKey": "<from OKX>", "secret": "<from OKX>", "password": "<passphrase>",
      "funds": "live", "maxTransferValue": 300, "maxDailyValue": 600, "confirm": "always", "dryRun": true
    }
  }
}
```

```json
{
  "settings": { "strictPermissions": true, "hideDisabledTools": true },
  "accounts": {
    "bybit-dst": {
      "exchange": "bybit", "apiKey": "<from Bybit>", "secret": "<from Bybit>",
      "funds": "live", "maxTransferValue": 300, "confirm": "always", "dryRun": true
    }
  }
}
```

```json
{
  "settings": { "strictPermissions": true, "hideDisabledTools": true },
  "accounts": {
    "bybit-settle": {
      "exchange": "bybit", "apiKey": "<second Bybit key: read + AccountTransfer, no Withdraw>", "secret": "<from Bybit>",
      "funds": "live", "maxTransferValue": 300, "maxDailyValue": 600, "confirm": "always", "dryRun": true
    }
  }
}
```

The operator fills in the values with an editor, never through the chat or the agent's shell,
then sets `chmod 600`. The source file and the settlement file are
[money-moving registrations](#money-moving-registrations). All three start with
`"dryRun": true`. Remove it from the source profile only after a plan has been walked through,
and from the settlement registration only when B will run settlement transfers. The
deposit-only destination profile keeps `"dryRun": true` always, also when a settlement
registration exists: Step 0 stops if it reports `dryRun: false`. Register the servers
([host registration](#host-registration)), restart the host, start a new chat with the
[setup prompt](prompts.md#setup-and-diagnosis), and have the agent run Step 0 and the key checks.
Then fill in the [setup record](#setup-record) outside the chat. The agent compares later chats
against it.

### Setup record

A short text the operator keeps outside the repository and pastes at the start of a chat
together with the latest operation record (Step 0). It holds facts that only the operator can
establish once, so no chat has to collect them again. It holds no secrets. The agent never
writes it and treats it as the operator's statement, not as a tool result.

```text
SETUP RECORD, written <UTC> by <operator>
Profile <registration name>: alias <alias>, exchange <id>, environment <live|sandbox>, role <deposit-only | settlement | source>
  (a settlement registration names the deposit-only registration of the same account)
  configPath <path>, journal <path>
  key rights <as shown on the exchange's API page, e.g. MEXC SPOT_ACCOUNT_READ, SPOT_WITHDRAW_READ>, IP allowlist <yes>
  provisioning: <allowed | not allowed>            (Gate, WhiteBIT: their address read may create an address)
  BingX permission codes: <code → right>
  Entity <Binance | Bybit | OKX | BingX | WhiteBIT>: <Binance.com | Bybit.com | OKX.com | BingX.com | WhiteBIT.com | other entity name>, jurisdiction <ISO 3166-1 alpha-2>,
    <travel-rule questionnaire | beneficiary information | rcvrInfo | KYC=KOR recipient fields | EEA/Turkey USDT restriction>: <not required | required | unknown>; evidence <source, UTC>
  Native form: interactive dialog; no Elicitation/ElicitationResult hook or auto-answer; checked <UTC>
  WhiteBIT contract <TRC20 | BEP20 | ERC20 | TON>: <full contract>, pinned from the explorer linked on WhiteBIT's deposit page <UTC>
  Whitelist on this source: <full address, character for character as in the agent's code block> memo <none | exact> chain <code> → <B venue>, added with 2FA <UTC>
```

For a [scheme D](#scheme-d-session-only-doppler-profiles-optional) session profile, the
registration name is `fundkit/<alias>` (aliases `<exchange>-src`, `-dst`, `-settle`). The
`configPath` is the stable `~/.local/state/fundkit/run/profiles/<alias>/config.json`, with
`~` expanded as `get_safety_status` shows it. The `journal` is the one it reports. All roles of
one exchange use the one key in `<EX>_APIKEY`/`<EX>_SECRET`, so they share one account and
one key-rights line, written as that key's real exchange-side rights (for example `withdraw,
read`), never as read-only unless the key is. The role line says which local roles are used
on it. The key-rights line stays valid across sessions while the Doppler names hold the same
key; a replaced key needs a new line:

```text
Profile fundkit/okx-src and fundkit/okx-dst: exchange okx, environment live, roles source and deposit-only (deposit-only enforced locally by fundkit)
  Doppler OKX_APIKEY/OKX_SECRET, passphrase typed in the private terminal; configPath ~/.local/state/fundkit/run/profiles/<alias>/config.json, journal <path>
  key rights <perm as shown on OKX's API page, e.g. read_only,withdraw>, IP allowlist <yes>
```

A missing line means "not established": the gate that needs it holds. The record has no
account-UID line: the operator's mapping of each registration to its account stands, and an
`account UID` line in an older record is ignored (never compared, never asked for again). A
changed key, alias, registration, entity, pinned contract or whitelist entry needs a new record
line. Entity lines
follow one rule on every venue ([entity lines](exchanges.md#entity-lines)): the venue's global
platform label exactly, a jurisdiction the venue's official page does not list, "not required"
and its evidence. Any other or regional entity, a missing or invalid jurisdiction, or a listed
one holds (fail closed). A WhiteBIT contract line is the operator's one-time reading, labeled
as such on every plan and sheet that uses it; it is not an API field. A per-plan human-read
value ([SKILL.md](../SKILL.md#per-plan-human-read-facts)) never goes into this record: it binds
one plan only.

## Interactive native form

`elicitationSupported: true` says only that the host can show a form. Claude Code also has
`Elicitation` and `ElicitationResult` hooks: a hook runs when an MCP server asks for input,
and Claude Code applies its output, so a hook can answer or change the form's response
without a dialog ([Claude Code hooks](https://code.claude.com/docs/en/hooks)). Hooks come
from user, project and local settings, plugins, skill frontmatter and managed settings, and
they merge across those levels. No tool result shows them.

Before the first money move, the operator checks once, outside the chat, that no hook,
plugin or setting answers or rewrites a form for the money-moving servers, and records it. With
[scheme D](#scheme-d-session-only-doppler-profiles-optional) the host sees every session
profile's form as coming from the server `fundkit`, so the check covers that server name:

```text
Native form: interactive dialog for <registration names>; no Elicitation/ElicitationResult hook or auto-answer in user, project, local, plugin or managed settings; checked <UTC>
```

Without that line the skill holds every money move. The operator may set
`"disableAllHooks": true` (or, as an administrator, `allowManagedHooksOnly` in managed settings)
to make the check simpler. The agent never creates, edits or deletes host settings, hooks or
plugins. Under the [trust model](#trust-model) that is a rule the agent follows, not something
it is prevented from doing, and the skill cannot detect a hook added later. Even an interactive
form shows no PLAN-ID, expiry or `params`, so it does not bind the full plan.

## Trust model

The skill assumes a **cooperative, trusted** host, operator and agent. Its controls stop
mistakes and stale data. They are not a security boundary against an agent that decides to
break the rules. Three kinds of control are kept apart:

- **Hard human confirmation.** In form mode, ccxt-mcp sends a `withdraw` or `transfer` only
  after the human accepts the host's native form. That is the only outcome the server
  enforces, and it is a human confirmation only on an **interactive host** where no hook,
  plugin or setting answers the form. The operator records that once
  ([interactive native form](#interactive-native-form)); without the line every money move
  holds. Without the native form the server issues a `confirmToken` that the model could
  redeem itself, so the skill never redeems a token: the move holds and the human may use the
  exchange UI.
- **Procedural checks.** The form's preview omits `params`, the PLAN-ID and the plan's expiry.
  The plan, the `APPROVE` and `WITHDRAW` replies, the expiry, the full recheck and the
  comparison of every form field with the plan are steps the agent and the human follow
  ([SKILL.md, 2.5](../SKILL.md#25-executing-each-write)). So are the setup record's
  comparisons in Step 0.
- **Where the credentials and the server process live is not a control.** The same OS user,
  a fixed `sudo -u <user> <command>` rule, a separate `HOME` or a container all run what the
  host's `command` names, and an uncooperative agent that can run that command or edit the host
  config could start its own server copy. The skill therefore neither requires another OS user
  nor stops when a money-moving server runs under the agent's own user, which is the normal
  setup ([scheme C](#scheme-c-per-profile-credential-files-two-profile-session)). What it
  requires of credentials is procedural: the agent never reads them (rule 1 of
  [`SKILL.md`](../SKILL.md#hard-rules)), and each profile signs only with its own key.
- **Host isolation is separate and unverified.** An operator may still configure a separate OS
  user, a container or the host's own sandbox and permission rules. Whether that keeps the
  credentials or the server from the agent depends on the host and was not verified here. The
  offline tests ran each server with its own `HOME` only to keep journals apart. They show
  nothing about isolation.
- **What protects the funds** apart from the rules: exchange-side restrictions
  ([table below](#exchange-key-permissions)), above all the withdrawal whitelist, the IP
  allowlist, the venue's withdrawal limit, minimal key rights and `maxTransferValue`.

## Host registration

No secrets. Substitute your own `<APP_DIR>` (install directory, see
[`ccxt-mcp.md`](ccxt-mcp.md#install)) and `<PROFILES>`.

**Claude Code**: `.mcp.json` in the project, or `claude mcp add-json -s user <name> '<json>'`:

```json
{
  "mcpServers": {
    "ccxt-okx-main": {
      "command": "/usr/bin/node",
      "args": ["<APP_DIR>/node_modules/ccxt-mcp/js/server.js"],
      "env": { "CCXT_MCP_CONFIG": "<PROFILES>/okx-main/config.json" }
    }
  }
}
```

The server takes keys from its profile's `config.json` (scheme C), the launch environment
(scheme A) or the launcher (scheme B). For a two-profile session, add one entry per profile
(for example `ccxt-okx-src` and `ccxt-bybit-dst`), each with only its own `CCXT_MCP_CONFIG`.
Servers from a project `.mcp.json` must be approved once in interactive `claude`.

**Codex**: `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`):

```toml
[mcp_servers.ccxt-okx-main]
command = "/usr/bin/node"
args = ["<APP_DIR>/node_modules/ccxt-mcp/js/server.js"]
env = { CCXT_MCP_CONFIG = "<PROFILES>/okx-main/config.json" }
env_vars = ["OKX_APIKEY", "OKX_SECRET", "OKX_PASSWORD"]
startup_timeout_sec = 30
tool_timeout_sec = 420
```

In scheme C omit `env_vars`: the credentials are in the profile file, and each further
profile gets its own `[mcp_servers.<name>]` table with its own `CCXT_MCP_CONFIG`.
`tool_timeout_sec` must be longer than the server's 300 s wait for the confirmation form
plus the exchange call ([gates](ccxt-mcp.md#gates-and-approval)). With a shorter timeout,
the host can report a timeout while the server is still waiting on the form. The server
never sees the host timeout, so if the form is still answered, the write is sent. `env_vars` forwards only the listed
names to the server (verified). Codex does **not** expand
`${…}` inside `env`. A second account of the same exchange needs a separate launch with only
its own registration enabled ([one registration](#one-registration-per-keyed-exchange)).
Everything else follows schemes A and B.

A host timeout does not stop the dispatch on the server (verified). After a timeout, only
reconcile ([SKILL.md, 2.7](../SKILL.md#27-reconciliation)).

## Loading the skill

**Explicit read (the supported way).** Start Claude Code or Codex from the repository root
and ask:

```text
Read SKILL.md and help me plan a USDT transfer.
```

The agent reads `SKILL.md` from the working directory and opens the files in `references/`
when a step points to them. Nothing needs to be installed, linked or copied. Start **every**
fresh chat or host launch with this read, including B's launch in scheme A. There, paste
the whole HANDOFF block and bring the latest operation record for any previously used account per Step 0: `Read SKILL.md and settle <PLAN-ID> on B.` followed by the block.

**Automatic discovery** means the host finds and loads a skill from its own skills directory
without being asked. Only `fundkit install`
([scheme D](#scheme-d-session-only-doppler-profiles-optional)) sets it up, by linking this
directory as `~/.claude/skills/usdt-funding` and `~/.agents/skills/usdt-funding`. Nothing
else here depends on it. The
`SKILL.md` frontmatter is standard, so if you set up discovery yourself, follow your host's
documentation.

## Smoke check

Run on each host before the first real session. No keys are needed for the first three rows.

| Check | Claude Code | Codex |
|---|---|---|
| registration (one enabled server per keyed exchange) | `claude mcp list` lists `ccxt-okx-main` | `codex mcp list` shows `ccxt-okx-main … enabled`; `codex mcp get ccxt-okx-main` prints the registration (`env` values masked as `*****`) |
| connection | `claude mcp list` health-checks: `ccxt-okx-main … ✔ Connected` | `codex mcp list` / `get` show registration only, not a connection; the server state row below proves it |
| skill readable | from the repository root: `Read SKILL.md and help me plan a USDT transfer.` | same |
| server state | ask the agent to call `get_safety_status` and `list_accounts` | same |

Expect `version: "0.1.3"`, `ccxtVersion: "4.5.84"`, an empty `configProblems`,
`elicitationSupported: true` (both hosts declare `elicitation.form`, verified via
`initialize` on Claude Code 2.1.331 and Codex 0.172.0) and the expected unique aliases.

## Exchange key permissions

| Profile | Permissions | Required |
|---|---|---|
| reads (any profile) | read; more rights are fine, the role keeps the profile to reads | IP allowlist recommended |
| Bybit deposit address (Scenario 1) | read, main account; profile with `funds` and `dryRun` ([above](#bybit-deposit-profile)) | main-account key (Bybit's own requirement) |
| recipient read, any venue (Scenario 1, and B in Scenario 2) | read; profile with `funds` and `dryRun` ([venue profiles](#venue-profiles)) | MEXC: `SPOT_WITHDRAW_READ`; Gate and WhiteBIT: provisioning consent |
| internal transfer | read + internal transfer; [money-moving registration](#money-moving-registrations) | IP allowlist recommended |
| withdrawal (exchange A) | read + withdrawal (+ transfer); [money-moving registration](#money-moving-registrations) | IP allowlist, address whitelist (the human adds B's address with 2FA), exchange-side withdrawal limit |
| Hyperliquid | no key needed | public address only |

Also: `maxTransferValue` and `maxDailyValue` in the profile, `implicitWrites` off, `confirm`
not `never`.

## Rotation

Rotate on a schedule, and immediately on suspicion. Delete the key in the exchange account,
issue a new one with the same minimal permissions and allowlist, and update the value only
for that account's launch. If a key ever reached a chat, a log or a repository, treat it as
compromised: revoke it and review the withdrawal history and the whitelist. A Doppler service token that
reached a chat, a log or a file is revoked in Doppler's Access tab and replaced; revocation
takes effect immediately. A running session ends at its next fetch with `TOKEN_REJECTED`.
