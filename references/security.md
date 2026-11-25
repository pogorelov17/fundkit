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
here, so assume it can. Three launch schemes are supported. Scheme C is the recommended one
for exchange A → exchange B, because both accounts can then be connected in the same session
with separate credentials.

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
   matches B's account identity, attributes the deposit by hash, finds the wallet holding it
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
than one connected server or alias has the keyed exchange, and has the human match an account
identifier (OKX: UID and API key label from `fetchAccounts`) against the exchange UI.

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

### Money-moving registrations

A registration that can move money is a source A with a withdrawal key, or a settlement
registration on B with an internal-transfer key. The skill moves money through it only when all
of these hold:

- the [setup record](#setup-record) names it with role `source` or `settlement`, and Step 0
  shows the same registration, alias, exchange, environment, `configPath` and `journal`;
- its key check shows the role's rights and the account UID in the setup record. A settlement
  registration must show the same UID as B's deposit-only profile;
- `get_safety_status` reports `elicitationSupported: true`, so every `withdraw` and `transfer`
  opens the host's native form;
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
2. **Key.** In Bybit's API management, create a key on the **main** account (Bybit gives
   deposit addresses only to main-account keys) with **read-only** permission: no withdrawal,
   no transfer or trading write access. Read-only keys may list transfer or trading categories
   in their metadata. Verify the explicit read-only flag and exclude the Withdraw label. Bind your IP. Note your UID shown there.
3. **Profile** (`chmod 600`). `funds` is needed because ccxt-mcp gates the address read
   behind it, and `"funds": "live"` requires some `maxTransferValue`. That cap applies only
   to MCP `transfer` and `withdraw` on this account, which `dryRun: true` blocks and the
   read-only key makes Bybit refuse; it does not limit what you send from OKX Wallet:

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

### Venue profiles

One-time setup per account, from a cold start with nothing installed. Install the pinned
server once ([install](ccxt-mcp.md#install)); then, per account:

| Venue (`exchange`) | Credential fields (scheme C `config.json`) | Variables (schemes A and B) | What the [key check](recipients.md) must show for a deposit-only profile |
|---|---|---|---|
| Binance (`binance`) | `apiKey`, `secret` | `BINANCE_APIKEY`, `BINANCE_SECRET` | `enableReading: true`, `enableWithdrawals: false`, `ipRestrict: true`; `uid` |
| Bybit (`bybit`) | `apiKey`, `secret` | `BYBIT_APIKEY`, `BYBIT_SECRET` | `readOnly: 1`, no `Withdraw`, `isMaster: true` (main-account key); `userID` |
| OKX (`okx`) | `apiKey`, `secret`, `password` (API passphrase) | `OKX_APIKEY`, `OKX_SECRET`, `OKX_PASSWORD` | `perm: "read_only"`; `uid` |
| Bitget (`bitget`) | `apiKey`, `secret`, `password` | `BITGET_APIKEY`, `BITGET_SECRET`, `BITGET_PASSWORD` | no withdrawal authority; `userId` |
| BingX (`bingx`) | `apiKey`, `secret` | `BINGX_APIKEY`, `BINGX_SECRET` | permission codes confirmed once on BingX's API page; `uid` |
| WhiteBIT (`whitebit`) | `apiKey`, `secret` | `WHITEBIT_APIKEY`, `WHITEBIT_SECRET` | no key read exists: the operator confirms the scope once |
| MEXC (`mexc`) | `apiKey`, `secret` | `MEXC_APIKEY`, `MEXC_SECRET` | `canWithdraw: false`; `uid` |
| KuCoin (`kucoin`) | `apiKey`, `secret`, `password` | `KUCOIN_APIKEY`, `KUCOIN_SECRET`, `KUCOIN_PASSWORD` | `permission: "General"` (no `Withdrawal`); `uid` |
| Gate (`gate`) | `apiKey`, `secret` | `GATE_APIKEY`, `GATE_SECRET` | the read has no permission fields: the operator confirms the scope once; `user_id` |
| Hyperliquid | none: `walletAddress` only | none | watch-only |

Rights by role. Create a separate key per role, each with an IP allowlist:

- **Destination (B) recipient profile**: read only. The profile needs `"funds": "live"` and a
  `maxTransferValue` because ccxt-mcp gates address reads behind `funds`; keep
  `"dryRun": true`. With a read-only key the exchange also refuses any write.
- **Destination settlement**: a second registration for the same B account (its own key with
  read + internal transfer, no withdrawal, same UID), with role `settlement` in the setup record, only if the credit must
  move from the deposit wallet to another B wallet. The deposit-only recipient key stays
  read-only: a read-only key cannot transfer (Bybit `readOnly: 1` is refused), and the agent
  never uses it for one.
- **Source (A)**: read + withdrawal (+ internal transfer when A moves funds into its
  withdrawal wallet), an exchange-side withdrawal limit and B's address on A's withdrawal
  whitelist. The operator adds that address once in A's security settings with 2FA; the agent
  never does and never asks to skip it.

Two-profile example (scheme C), one file per account:

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

The operator fills in the values with an editor, never through the chat or the agent's shell,
then sets `chmod 600`. The source file and a settlement file are
[money-moving registrations](#money-moving-registrations). Both examples start with
`"dryRun": true`. Remove it from the source profile only after a plan has been walked through,
and from the destination profile only if B will run a settlement transfer. Register both servers
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
  (a settlement registration names the deposit-only registration of the same account UID)
  configPath <path>, journal <path>
  account UID <id> (confirmed on the exchange's API page <UTC>), key rights <as shown there>, IP allowlist <yes>
  provisioning: <allowed | not allowed>            (Gate, WhiteBIT: their address read may create an address)
  BingX permission codes: <code → right>; BingX KYC jurisdiction: <non-KOR | KOR>
  Binance entity: <entity name>; travel-rule questionnaire on withdrawal: <not required | required | unknown>; evidence <source, UTC>
  WhiteBIT entity: <non-EEA, non-Turkey | EEA | Turkey>; evidence <source, UTC>
  WhiteBIT contract <TRC20 | BEP20 | ERC20 | TON>: <full contract>, pinned from the explorer linked on WhiteBIT's deposit page <UTC>
  Whitelist on this source: <full address> memo <none | exact> chain <code> → <B venue>, added with 2FA <UTC>
```

A missing line means "not established": the gate that needs it holds. A changed key, alias,
registration, entity, pinned contract or whitelist entry needs a new record line. The Binance
entity proceeds only when it is named, it is not one of the local entities that Binance lists
for its travel-rule questionnaire, the line says "not required" and names its evidence
([outbound table](exchanges.md#withdrawal-whitelist-evidence)). A WhiteBIT contract line is
the operator's one-time reading, labeled as such on every plan and sheet that uses it; it is not
an API field.

## Trust model

The skill assumes a **cooperative, trusted** host, operator and agent. Its controls stop
mistakes and stale data. They are not a security boundary against an agent that decides to
break the rules.

- **What the server enforces.** In form mode, ccxt-mcp sends a `withdraw` or `transfer` only
  after the human accepts the host's native form. That is the only outcome it enforces. The
  form's preview omits `params`, the PLAN-ID and the plan's expiry. Comparing the full
  arguments with the plan and checking the clock are procedural steps for the agent and the
  human ([SKILL.md, 2.5](../SKILL.md#25-executing-each-write)).
- **No tokens.** Without the native form the server issues a `confirmToken` that the model
  could redeem itself. The skill never redeems a token. Where the form is unavailable, the
  money move is held and the human uses the exchange UI.
- **Process placement is not a boundary.** The same OS user, a fixed `sudo -u <user> <command>`
  rule, a separate `HOME` or a container all run what the host's `command` names. An agent that
  can run that command, or edit the host config, can start its own server copy. That copy has no
  native form and issues tokens. Running money-moving servers under another OS user therefore
  does not stop an uncooperative agent, and the skill does not rely on it.
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
without being asked. This repository does not set that up and nothing here depends on it. The
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
| read-only | read | IP allowlist |
| Bybit deposit address (Scenario 1) | read-only, main account; profile with `funds` and `dryRun` ([above](#bybit-deposit-profile)) | IP allowlist, no Withdraw label, no transfer or trading write access |
| recipient read, any venue (Scenario 1, and B in Scenario 2) | read only; profile with `funds` and `dryRun` ([venue profiles](#venue-profiles)) | IP allowlist, no withdrawal, no transfer or trading write access; Gate and WhiteBIT: provisioning consent in the setup record |
| internal transfer | read + internal transfer; [money-moving registration](#money-moving-registrations) | IP allowlist, no withdrawal |
| withdrawal (exchange A) | read + withdrawal (+ transfer); [money-moving registration](#money-moving-registrations) | IP allowlist, address whitelist (the human adds B's address with 2FA), exchange-side withdrawal limit |
| Hyperliquid | no key needed | public address only |

Also: `maxTransferValue` and `maxDailyValue` in the profile, `implicitWrites` off, `confirm`
not `never`.

## Rotation

Rotate on a schedule, and immediately on suspicion. Delete the key in the exchange account,
issue a new one with the same minimal permissions and allowlist, and update the value only
for that account's launch. If a key ever reached a chat, a log or a repository, treat it as
compromised: revoke it and review the withdrawal history and the whitelist.
