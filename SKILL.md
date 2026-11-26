---
name: usdt-funding
description: >-
  Plan and semi-automatically execute USDT moves between centralized exchanges (Binance,
  Bybit, Gate, OKX, Bitget, WhiteBIT, BingX, MEXC, KuCoin) through the pinned ccxt-mcp 0.1.3
  server (ccxt 4.5.85), OKX Wallet deposits to an exchange address read from the operator's
  own account, and watch-only Hyperliquid margin checks. Use whenever the user wants to move,
  send, transfer, withdraw, top up or fund USDT between exchanges or wallets, in any language
  (for example "move 300 USDT from OKX to Bybit"), pick a network, get a verified deposit
  address, move funds between funding and trading wallets, or check Hyperliquid margin. Finds
  the connected exchange profiles itself and, with the optional fundkit server, connects
  missing ones for one session from a Doppler config after one private secret card (T3 Code) or
  a private terminal step. Native tools return a verified deposit address with an inline QR and
  prepare exchange-to-exchange transfers confirmed by one bound human confirmation. Enforces
  live network checks, an exact expiring plan, the host's native confirmation for every money
  move, and no retries on unknown outcomes.
---

# USDT funding: OKX Wallet → exchange, exchange A → exchange B, funding ↔ trading

Reply in the user's language, but keep the approval keywords below exactly as written. You
plan and execute writes only through `ccxt-mcp` servers: registered directly in the host, or
connected for one session through the optional `fundkit` MCP server
([session profiles](#session-profiles-optional-doppler)). Read the state first, then
build an exact plan. Execute writes only after explicit human approval. Do not write or run
programs or scripts of your own, and never run the `fundkit` command yourself. Two exceptions:
the exact `secretStep.then` command a fundkit result gives you, with the path from the host's
secret card ([native flows](#native-flows-start-here)), and the fixed TON address check in
[`recipients.md`](references/recipients.md#address-checks), which reads only its argument.

Detailed tables live in [`references/`](references/): pins, schemas and gates in
[`ccxt-mcp.md`](references/ccxt-mcp.md), per-exchange data in
[`exchanges.md`](references/exchanges.md), native recipient reads in
[`recipients.md`](references/recipients.md), environment and key setup in
[`security.md`](references/security.md), copyable user prompts in
[`prompts.md`](references/prompts.md). Read the reference a step points to before you act
on it. A new chat or host launch remembers nothing: it starts by reading this file again, and
only what the human pastes carries over.

## Native flows (start here)

When the `fundkit` MCP server is connected, these two requests go through its native tools.
They need no setup record, no UID, no typed `APPROVE`/`WITHDRAW`, no operator `--writes`
option and no questions about credentials, amounts, minimums or deposit pages.

**"My deposit address"**, for example `Show my Binance USDT deposit address on BSC`: call
`fundkit_deposit_address {"exchange":"binance","network":"BSC"}`. On `status: "verified"`,
answer in the user's language with, in this order:

1. If `memo.required`: the memo first, conspicuously, exactly as given (leading zeros kept),
   and that the QR carries only the address, so the memo must be entered separately.
2. The QR inline: paste `qr.markdown` exactly (a Markdown image with the absolute path).
3. The address as plain text in a code block, character for character from `address`.
4. The exact network: `network.label`, the exchange's network id `network.venueId`, and
   "memo: none" when no memo is needed.
5. Where and when it was read (`source.alias`, `source.readAt`). Never say anything was sent.

Never show a QR from another call, never re-use an image path from earlier in the chat for a
new answer, and never describe a QR without its `qr.markdown`. If `qr` is null, show the
address and network and say that no QR could be verified (`qrError`). An error result shows
no address: report its `message` as the exact reason.

**A transfer between the user's exchanges**, for example `Move 300 USDT from Bybit to
Binance`: call `fundkit_transfer_prepare {"from":"bybit","to":"binance","amount":"300"}`
(pass `network` only if the user named one). Then:

- `status: "hold"`: nothing was sent and nothing needs confirming. Tell the user each
  `reasons[].detail` plainly. Do not ask them to look up a value, open a deposit page or change
  a setting to get around it, and do not plan around it yourself.
- `status: "ready"`: show the `plan` fields in one message in the user's language (route,
  network, amount, fee, debit, credit, recipient and memo with their source, expiry,
  `exchangeMayReject`, `onward`) and call `fundkit_transfer_confirm {"planId":"…"}` right away.
  It opens exactly one confirmation card with every plan field. The card's labels are fixed
  English, so your message is where the user reads the plan in their own language. The human
  approves or declines on the card. Do not ask for a typed approval in the chat, and never
  answer the card yourself.
- The confirm result's `status` is final for that plan: `sent` (report `withdrawalId`; the
  credit still has to arrive), `not-sent` or `rejected` (nothing was sent: say so), `unknown`
  (do not retry; this plan can never be sent again; reconcile read-only). A plan is sent at
  most once: a repeated confirm, a restart or a timeout never sends again. Anything after the
  credit (for example moving it to another wallet) is a separate request that this
  confirmation did not authorize: say so if relevant and do not do it silently.
- Changed amount, network or recipient: prepare again; the old plan is not reused.

**No session yet.** A result with `error: "NO_SESSION"` (or `PASSPHRASE_NEEDED`) carries
`secretStep` and `resume`:

1. If you have a private secret card tool with file delivery (T3 Code: `request_secret`),
   call it once with exactly `secretStep.request` (label, reason, `delivery: "file"`).
2. Run `secretStep.then` in the shell with `<FILE>` replaced by the returned `file` path,
   unchanged. It reads the file once, deletes it and starts the session; it prints no value.
   Never read, print or copy the file yourself.
3. Call `resume.tool` with `resume.arguments` at once, in the same turn. Do not ask the user
   to say they are done, to run anything, or to open a terminal, Docker, SSH or a browser.

If the card is declined or times out, say so and stop. If you have no such tool, say plainly
that this host cannot take the token privately in chat (`secretStep.hostWithoutCard`); where
the operator has a terminal on that machine, `fundkit session` there is the alternative. If
the user already has configured `ccxt-mcp` profiles (Step 0 finds them), use those and never
push Doppler on them. Venues other than Binance and Bybit return `VENUE_NOT_NATIVE`: use the
manual flows below only if the user asks for them.

## Hard rules

1. **You never see or ask for keys.** You only know account aliases (`okx-main`) and tool
   results. If the user pastes an API key, secret, passphrase, seed or private key into the
   chat, do not use it and ask them to rotate it immediately. Never print the environment in
   any way: no `env`, `printenv`, `set`, `export -p`, `declare -x`, `ps e`, `/proc/*/environ`,
   `echo $…_SECRET`. Do not use the shell to read `.env` files, profile configs or the server
   journal. Diagnose setup only from tool results ([setup check](#setup-check)),
   and never ask whether a key is set or what it is. The same holds for a Doppler service
   token: the user enters it only in the host's private secret card or their own private
   terminal ([native flows](#native-flows-start-here)), never into the chat. If one is
   pasted here, do not use it, do not repeat it, and ask the user to revoke it in Doppler and
   create a new one. The same again for an exchange API passphrase (OKX, Bitget, KuCoin): it is
   typed only in the private terminal; one pasted here means the user replaces that API key.
2. **A plan is bound to exact arguments and an expiry.** Writes are `transfer`, `withdraw`,
   `create_order`, `cancel_*`, `set_*`, `call_write_method` and `call_implicit_write`. Before any
   write, show a plan with the **full JSON arguments** of every call and `expires <UTC>`, and get
   the reply `APPROVE <PLAN-ID>`. The one exception is `fundkit_transfer_confirm`: its plan is
   bound by fundkit (hash, expiry, single dispatch) and its one confirmation card shows every
   field, so it replaces `APPROVE` and `WITHDRAW` there ([native flows](#native-flows-start-here)). **Never call `get_deposit_address`**: when the read fails it
   creates an address on its own (KuCoin, MEXC, WhiteBIT), with no form and even under `dryRun`.
   Recipient reads ([`recipients.md`](references/recipients.md)) need no plan. Two of them are
   documented as provisioning reads that may create an address (Gate, WhiteBIT). Send those only
   when the [setup record](references/security.md#setup-record) allows provisioning for that
   alias. If any field changes (amount, network, address, memo, wallet, `params`, order) or the
   plan has expired, you need a new plan and a new approval.
3. **Withdrawals get their own approval, in advance.** Before the **first** `withdraw` call,
   show its exact JSON and get a separate `WITHDRAW <PLAN-ID>` from the human. **Every money
   move (`withdraw` and `transfer`) is confirmed by the human in the host's native form.** The
   call opens the form, and accepting it sends the write immediately. The server enforces only
   that answer: the form shows no `params`, no PLAN-ID and no expiry, so checking the full
   arguments and the clock against the plan is your and the human's procedure (2.5). A server
   that reports `elicitationSupported: false` gets no MCP money move at all, because its
   confirmation token could be redeemed by the model. Never redeem a `confirmToken`. Hold the
   move; the human may use the exchange UI instead. The skill assumes a cooperative, trusted
   host, operator and agent ([trust model](references/security.md#trust-model)). The hard
   control is the human's answer in that form, on an interactive host whose setup record says
   no hook or setting answers it. The plan, expiry and argument checks are procedures. Where the
   server process runs, and under which OS user, is neither a control nor a stop.
4. **API withdrawals require a native confirmation form and a verified request.** The pair "exchange A + network" must appear in
   the [outbound withdraw table](references/exchanges.md#outbound-withdraw). Pass `network` at
   the top level and the memo only in `tag`. Put exactly what the table requires for that
   exchange into `params`: `fee` for OKX, `accountType` for Bybit, `uta` for Bitget,
   `walletType` for Binance, `type: "fund"` for BingX, `{}` for the rest. Any other key (`chain`, `network`, `includeFee` and so on) goes to the exchange
   and overrides the request, and it is visible neither in the preview nor in the form. For
   example, `params.chain` on Bybit replaced BSC with ETH (verified). If the pair is not in the
   table, or the exchange is marked "manual only", the human withdraws in the exchange UI.
5. **Reconcile before considering another attempt.** On `UNKNOWN_OUTCOME`, a host timeout, a
   dropped connection, no response, or any error that is not on the
   [not-sent list](#26-responses-what-was-definitely-not-sent), retry nothing. For a potentially submitted operation, establish non-execution
   from a pre-dispatch response in 2.6 or an explicit operator finding from the exchange's
   records covering the snapshot through the present. An empty history, unchanged balance
   or empty `unresolvedIntents` cannot prove it. For a witnessed cancellation on a manual
   confirmation screen use the rule below. A new attempt needs fresh authorization; for
   a dispatched operation that failed, use the return-evidence rule in 2.7.
6. **Amounts are explicit.** Do not accept "all", "max" or "the rest" without a number. Every
   amount is a USDT number labeled with its meaning (debit, call argument or credit, see
   [2.3](#23-debit-withdraw-amount-and-credit)) and exactly representable in the currency,
   network and exchange steps (also 2.3). Never exceed the user's limit. `maxTransferValue`
   caps only MCP `transfer` and `withdraw` on that account; it does not cap a manual send
   (Scenario 1, 2.9), which is bound by the user's own amount and limit.
7. **Never guess the network, fee, minimum, contract or chain.** If a field did not come in a
   live response and [`exchanges.md`](references/exchanges.md) names no documented value for
   it, it is "unknown", and a network with an unknown field does not qualify. Sources that
   disagree make the field unknown too. The one exception is a
   [per-plan human-read fact](#per-plan-human-read-facts), which the user may choose to supply
   for B's deposit minimum or deposit fee only. Do not suggest small "test" transfers.
8. **Hyperliquid is watch-only** by public address. No transfers, withdrawals, orders or
   private keys (collateral there is USDC).
9. **Do not trust addresses from the chat.** The deposit address and memo have one source:
   the latest [native recipient read](references/recipients.md) of B's own account in this
   chat (for Bybit, the [Bybit address read](#bybit-deposit-address)), or B's deposit page if
   the user chose to copy it there. Text pasted into the chat is never a source. On the **final confirmation screen** of whatever sends (OKX Wallet,
   the host form, or exchange A's withdrawal page in a manual send), the human checks the
   **full** address character by character, the network, and the exact memo (or that none is
   required) against that source: B's page, or the host-displayed source row of the most
   recent native read (for Bybit, the step 4 raw row: chain, `addressDeposit` and
   `tagDeposit`). Any difference: do not confirm.
   The fix is a fresh copy from the source, and a changed address or memo needs a new plan or
   sheet and new approvals. For an API withdrawal, the full address must already be on A's
   withdrawal whitelist, and every whitelist record must show it character for character,
   letter case included (also for EVM addresses). That covers a venue's saved-address row
   (Binance, Gate) as much as a setup-record entry: a row that matches only when letter case
   is ignored is not the recipient. On every plan or sheet for a send, record the destination network's
   memo requirement (required, not required, or no published flag), its source and the UTC check time.
   "Not required" allows a recipient-specific memo. Preserve every supplied memo exactly
   through preview, submission, handoff and deposit reconciliation, including leading zeros.
   If the source publishes this field but omits it or returns an unknown value, hold even on
   the first lookup. Use "no published flag" only when the venue supplies no such field and
   the address-specific evidence establishes the memo. Before recording OPEN for a wallet send or any withdrawal,
   refresh the destination network's memo-required flag if the venue publishes one.
   Hold if a previously available flag is missing, a required memo is empty, or the flag
   conflicts with the current recipient details. A changed flag requires a fresh plan or sheet
   and authorization. Where the venue supplies no flag, use the address-specific memo evidence.
   Immediately before a manual send, refresh B's deposit availability on
   the selected network, fee (asset and amount), and applicable minimum from its live data or
   deposit page (deposit fee: a live field, or the venue's documented policy in the
   [destination status table](references/recipients.md#status-by-destination-venue), unless
   a live field or the page shows otherwise). Recalculate net credit. If anything changed, cancel, replace the sheet, and
   get fresh approval; if a field is unavailable or the minimum is missed, hold the send.

### Manual confirmation

For both manual routes, give each final sheet a unique ID and a UTC expiry 15 minutes after
creation. A replacement gets a new ID. Show the sheet to the person controlling the sending
wallet or exchange account. Use the following sequence:

1. Leave the transaction unsigned and unsubmitted while checking the final screen against
   the current sheet and the address source (rule 9). If a value changes or the sheet expires,
   cancel the screen. Prepare a replacement only after the destination and amounts qualify.
2. Once the checks pass, record `OPEN` with the exact sheet and its ID. The operator checks
   that the screen still matches and the UTC expiry has not arrived, then personally signs
   or submits that exact transaction. **That final action authorizes the manual send.**
   A sheet, chat message or past authorization alone does not authorize another submission.
3. If the operator instead deliberately cancels the still-unsigned, unsubmitted screen, they
   report the sheet ID, UTC time and that they personally observed cancellation before using
   any signing or submission control. Record this as `NOT SENT — canceled before submission`
   against that OPEN. If cancellation happens before OPEN, discard the unused sheet.
   If the operator pressed Sign or Submit, lost the screen, or cannot establish the ordering,
   keep OPEN and reconcile read-only. A missing hash or a later Cancel button proves nothing.

## Call syntax

`call_read_method` always has two required fields, `exchange` and `method`, even when
`account` is set. Without `exchange` the host returns `-32602 Required at exchange`. The
`exchange` value must match the account's exchange. Pass positional arguments in `args`, for
example `[code, since, limit]`, and use `null` for a skipped one.

```text
call_read_method {"exchange":"okx","account":"okx-main","method":"fetchDepositWithdrawFee","args":["USDT"],"includeInfo":true}
call_read_method {"exchange":"okx","account":"okx-main","method":"fetchBalance","params":{"type":"funding"},"includeInfo":true}
call_read_method {"exchange":"okx","account":"okx-main","method":"fetchWithdrawals","args":["USDT",null,20]}
call_read_method {"exchange":"okx","account":"okx-main","method":"fetchAccounts","includeInfo":true}
call_read_method {"exchange":"okx","account":"okx-main","method":"fetchTransfer","args":["<transId>","USDT"],"includeInfo":true}
call_implicit_get {"exchange":"kucoin","method":"publicGetCurrenciesCurrency","params":{"currency":"USDT"}}
call_implicit_get {"exchange":"gate","method":"publicWalletGetCurrencyChains","params":{"currency":"USDT"}}
```

With ccxt-mcp 0.1.3 and ccxt 4.5.85, `call_implicit_get` accepts only camelCase names
(snake_case returns `UNKNOWN_ENDPOINT`) and only GET endpoints. Use it only for the
[network data sources](references/exchanges.md#network-data-sources), the key checks and raw
recipient reads named in [`recipients.md`](references/recipients.md), and these two reads of
the [Bybit deposit address](#bybit-deposit-address) flow:

```text
call_implicit_get {"exchange":"bybit","account":"<alias>","method":"privateGetV5UserQueryApi"}
call_implicit_get {"exchange":"bybit","account":"<alias>","method":"privateGetV5AssetDepositQueryAddress","params":{"coin":"USDT","chainType":"<chain>"}}
```

Schemas:
[`references/ccxt-mcp.md`](references/ccxt-mcp.md#tools).

## Session profiles (optional, Doppler)

A route needs one profile per account and role: **source** on A (withdraws), **deposit-only**
on B (reads B's own recipient) and, only for 2.8, **settlement** on B. Find them in this
order, without asking the user for aliases:

1. **Connected servers first.** Call `get_safety_status {}` on every connected `ccxt-mcp`
   server and match the route's exchanges to the aliases it reports. Where those cover the
   route, use them and do not mention Doppler.
2. **Missing profiles, `fundkit` tools present.** Call `fundkit_profiles {"from":"<A>","to":"<B>"}`
   (ccxt ids or the user's own names: "OKX", "Gate.io"). It reads nothing secret.
   - `session: "active"`: call `fundkit_connect {"exchange":"<id>","role":"source"}` for A and
     `{"exchange":"<id>","role":"deposit-only"}` for B. Connect `settlement` only when 2.8
     needs a transfer on B. Each profile's alias is `<exchange>-src`, `-dst` or `-settle`.
   - `session: "none"`: tell the user, in their language, the `userStep` from the result: in
     a separate terminal on this machine they run `fundkit session` and paste a read-only
     Doppler service token there (the input is hidden), then say they are done. Do not ask
     for the token, do not wait in a loop, and do not run the command yourself. Then call
     `fundkit_profiles` again.
   - `PASSPHRASE_NEEDED` (OKX, Bitget, KuCoin): pass on the result's `userStep` in the user's
     language and stop until they say they are done; then call the same `fundkit_connect` again.
     The passphrase is typed only in their private terminal, never in the chat. For example
     (translate it into the user's language): "OKX needs its API passphrase. Switch to the
     terminal running `fundkit session`: it now shows the prompt `OKX API passphrase`. Type it
     there (the input is hidden), not in this chat, and then reply done." When the session runs
     the host (`-- claude`), the step is `fundkit passphrase okx` in another terminal: "…open a
     second terminal on this machine and run `fundkit passphrase okx`…". `PASSPHRASE_CANCELLED` or `PASSPHRASE_TIMEOUT`: the
     operator did not enter it; say so, and connect again only if the user asks for it.
3. **Neither.** Follow the last paragraph of [Step 0](#step-0-preflight-read-only).

How a session profile works. The operator's Doppler config holds one account per exchange,
under exactly `<EXCHANGE>_APIKEY` and `<EXCHANGE>_SECRET`
([scheme D](references/security.md#scheme-d-session-only-doppler-profiles-optional)). OKX,
Bitget and KuCoin also need their API passphrase, which is not in Doppler: the operator types it
in the private terminal once per exchange and session. `fundkit_connect` starts one pinned
`ccxt-mcp` process for that account and role, with only those values. No value ever reaches
you. Call every tool of a session profile through `fundkit_read
{"alias":"<alias>","tool":"<tool>","arguments":{…}}`, with exactly the JSON you would pass to
that tool directly ([call syntax](#call-syntax)). Money moves go only through `fundkit_write
{"alias":"<alias>","tool":"withdraw|transfer","arguments":{…}}`,
after `APPROVE <PLAN-ID>` and `WITHDRAW <PLAN-ID>` as in 2.5. The call opens the same native form
and the human's answer decides. Everything else in this skill applies unchanged: Step 0 runs on
every session profile, and so do the key checks, the setup record and the rules.

- **One key, several local roles.** Every role of one exchange uses the same key and account:
  `okx-src` on an OKX → Bybit route and `okx-dst` on the reversed route are the same OKX account,
  and the connect result's `account.sameAccountAs` says so. Never present them as two accounts.
  The key's exchange-side rights are whatever the operator granted (`keyCapability`): report what
  the venue key check shows and never call a key read-only unless the check shows that. The role
  is enforced by fundkit (`roleScope`): a deposit-only profile forwards only Step 0, key-check,
  network, recipient and deposit-history reads, and no money move; settlement forwards `transfer`
  but not `withdraw`; source forwards `withdraw` and `transfer`. `ROLE_DENIED` means you used the
  wrong profile: never retry it on another role to get around the refusal.
- **Key check, no UID binding.** Recipient reads and money moves need a successful key check
  on this profile first, where the venue has one (`KEY_CHECK_REQUIRED` names the call). fundkit
  does not bind a profile to an account UID: the operator's mapping of the selected exchange and
  profile to its two Doppler names is trusted. Never fetch, ask for, record or compare a UID for
  that, also where a key check happens to show one, and never ask for another identity proof in
  its place. `fundkit_write` takes no `uid` (an older caller's is ignored). Read `venueScope` and
  surface its restrictions to the user (WhiteBIT: no key read, so its key rights come from the
  setup record, and as a source its available amount is not visible, so an API withdrawal plan
  still holds; Gate and MEXC: key rights from the setup record; Gate and WhiteBIT provisioning
  reads need the session's `--allow-provisioning`, `PROVISIONING_NOT_AUTHORIZED` otherwise).
- The registration name is `fundkit/<alias>`. `configPath` and `journal` are what
  `get_safety_status` reports, and the setup record must name them for a money-moving role.
- `list_accounts` shows `credentials: []` on a session profile because the key comes from
  the process environment. The venue's key check is what shows the key and its scope.
- The session caps writes. A deposit-only profile is always `dryRun: true`. Source and
  settlement profiles are `dryRun: true` unless the operator started the session with
  `--writes --max-transfer <USD>`. Only the operator can change that, by starting a new
  session.
- Errors: `NO_SESSION`, `TOKEN_REJECTED` (the token is expired or revoked; the session has
  ended) and `SESSION_ENDED` mean the user repeats the private terminal step. `MISSING_SECRETS`
  lists the missing names (always the plain `<EXCHANGE>_APIKEY` / `<EXCHANGE>_SECRET`): the
  operator adds them to the Doppler config, and the session stays active.
  `DOPPLER_UNAVAILABLE`, `DOPPLER_RATE_LIMITED` and `DOPPLER_TIMEOUT`: try once later, then hold.
  `ALIAS_IN_USE`: another host session holds that profile.
- If the session ends while a `withdraw` or `transfer` is open, the result says the outcome
  is unknown. Retry nothing and reconcile ([2.7](#27-reconciliation)) on a new session.

## Step 0. Preflight (read-only)

Before preparing a plan or sheet in any fresh chat, including a manual wallet or exchange
UI send, ask the operator for the latest operation record for that source account or wallet
(see [journal line](#journal-line-in-the-chat)).
On first use, have them confirm there was no prior attempt. In either case, confirm that
no other send is outstanding and nobody else is acting on the route. If there is an
`OPEN` step, reconcile it first. Lost, stale or uncertain state means reads only. A carried record
serves as evidence for reconciliation. After recovery, any remaining action requires a fresh
plan or sheet and fresh authorization; a previous approval does not carry forward.

For each server involved:

1. Call `get_safety_status {}`. It must return `version: "0.1.3"` and `ccxtVersion: "4.5.84"`
   (that is how ccxt 4.5.85 reports itself). On any other version, **stop**: ccxt 4.5.87+ with
   ccxt-mcp 0.1.3 sends withdrawals without network, fee and memo (verified). `configProblems`
   must be empty; with `strictPermissions`, a config readable by other users (not
   `chmod 600`) shows `REFUSED` there. Note `elicitationSupported` and the `journal` path.
   **Crash hold.** Ask the operator whether a write hold is recorded for this `journal` path.
   If one is, or `unresolvedIntents` is not empty, a **terminal write hold** covers every
   profile that writes to that path (all profiles of that OS user, whatever alias an entry
   names). That means no writes on any of them, in this launch or any later one. Only reads
   and the operator's investigation in the exchanges' own records remain. Exchange history
   alone never clears the hold. Neither does the entry dropping off the list, because the
   server reads only the current and the previous month's file. Never delete, edit or move
   journal files, never point a profile at another journal, and never retry the intent.
   Report the path and the entries, and ask the operator to record the hold outside the
   chat. Resuming writes is outside this skill.
2. Call `list_accounts {}`: check the alias, `exchange`, `environment`, `funds`, `dryRun`,
   `confirm` (not `never`) and `maxTransferValue`. Aliases must be unique across all servers.
   `environment` must be the one the plan names (`live`, or `sandbox` for a sandbox walkthrough)
   on **every** server of the route. A mix is a stop.
   With `hideDisabledTools` and no accounts, `list_accounts` is not listed at all; then
   `get_safety_status` shows `accounts: []`, which means the server has no accounts.
3. **Launch scheme.** Ask the operator which scheme this launch uses
   ([environment contract](references/security.md#environment-contract)). In **scheme C**
   (the recommended one for exchange A → exchange B), every server's own `chmod 600`
   `config.json` holds that account's credentials, and the host launch environment holds no
   `<EXCHANGE>_*` key variables. Several keyed servers, also for the same exchange, may then be
   connected together; each signs only with its own config's key (verified offline). In
   **scheme A**, ccxt-mcp fills every account of an exchange from the same `<EXCHANGE>_*`
   variables, so two connected servers for one exchange (say `okx-main` and `okx-sub`) sign
   with the **same** key under different aliases (verified offline). In scheme A, if more
   than one connected server or alias has the keyed exchange, stop until the operator leaves
   exactly one registration enabled
   ([one registration](references/security.md#one-registration-per-keyed-exchange)).
   **Session profiles** (scheme D, [session profiles](#session-profiles-optional-doppler)) are
   separate processes, each started with only its own account's key, so several of them, also
   for one exchange in different roles, may be connected together, as in scheme C. You do not
   need to ask which scheme they use.
   **Money-moving registrations** (a source A that withdraws, a settlement registration on B)
   are the ones the [setup record](references/security.md#setup-record) names with that role
   ([money-moving registrations](references/security.md#money-moving-registrations)). The
   tool-visible check is the server's `journal` and `configPath` from `get_safety_status`: both
   must equal the setup record. Otherwise that profile is read-only for this launch. Which OS
   user or container runs a server is host configuration. The skill neither relies on it nor
   checks it. A money-moving server under the agent's own OS user is the normal case and no
   reason to stop ([trust model](references/security.md#trust-model)).
4. **Account mapping and key scope.** Which exchange account a key belongs to is the operator's
   mapping: the registration (or, on a session profile, the exchange's two Doppler names) they
   chose for that exchange. Trust it. Do not fetch, ask for, record or compare an account UID to
   bind the alias to an account, also where a key check happens to show one, and do not ask for
   another identity proof instead. Before the first write or recipient read in a launch, run the
   venue's key check from [`recipients.md`](references/recipients.md) and report the key's scope
   (rights, IP binding, main account where the venue shows it). The operator keeps the
   [setup record](references/security.md#setup-record): registration name, alias, exchange,
   environment, `configPath`, `journal` and role. Later chats compare those fields against that
   record without opening the exchange. Any difference is a stop. An account UID in an older
   setup record is ignored: never compare it and never ask for it. One key per exchange may
   serve every role, on all nine venues: a deposit-only profile on a write-enabled key is
   deposit-only because of its role (fundkit's allowlists on a session profile, `dryRun: true`
   and the skill's read-only calls on a registered one), not because of the key. Report the
   key's real rights ("withdrawal right present; deposit-only enforced locally"), never
   "read-only" unless the check shows that, and never ask the operator for a separate read-only
   key or to remove rights from a key. A source profile that will withdraw must show the
   withdrawal right (the exchange refuses a withdrawal without it). Where the venue has no
   such read (WhiteBIT), or its reads show no key permissions (Gate; MEXC, whose `canWithdraw`
   is an account flag, not a key right), the setup record's key-rights line stands behind the
   scope: say so. The deposit-only profile keeps `dryRun: true` in `list_accounts`, also when
   a separate settlement registration for B exists. `dryRun: false` on it is a stop.
5. Tell the user which profiles are read-only, which have `funds: "live"` and with what cap,
   and whether the native form is available. Every money-moving server needs
   `elicitationSupported: true` **and** the setup record's "Native form: interactive" line: a
   Claude Code `Elicitation` or `ElicitationResult` hook can answer a form without a dialog,
   and no tool shows hooks ([interactive form](references/security.md#interactive-native-form)).
   Never create or edit host settings, hooks or plugins. Only the operator can enable a missing tier, in the config; it cannot
   be done from the conversation.

If `fundkit` tools are available, missing profiles come from
[session profiles](#session-profiles-optional-doppler). If neither `ccxt-mcp` nor `fundkit`
tools are available, say that no server is connected to this chat (you
cannot see why), explain what the operator needs to set up for the named venues
([setup check](#setup-check), [`references/security.md`](references/security.md)), and stop
before any live data or plan numbers. You may still explain the flow in general terms.

## Scenario 1. OKX Wallet → exchange (manual send)

Start with the operation-record check in Step 0 for the sending wallet. Only the human
sends from OKX Wallet, using the checked sheet.

1. Ask the user for the destination exchange, the networks where they hold USDT in OKX
   Wallet, and the amount. Run the [setup check](#setup-check) for the destination first.
2. Read the destination's network data from the
   [source listed for that exchange](references/exchanges.md#network-data-sources): deposit
   enabled, deposit minimum, deposit fee and contract. Record the network's memo-required flag when supplied
   (for example Gate's `is_tag`). Obtain the actual memo with the address in step 4.
   An empty response or an error means
   "no data", not "network disabled". The deposit fee `d` comes from a live field or the
   venue's documented policy in the
   [destination status table](references/recipients.md#status-by-destination-venue), so the
   human does not open the exchange for it. BingX's minimum is the chosen chain's live
   `depositMin`, which BingX's API docs define as "Minimum deposit amount". If a field has
   neither (the Binance and MEXC deposit minimum, the Gate minimum unless the address response
   lists the chosen chain alone, the KuCoin deposit fee unless a live `depositFeeRate` without
   a `depositTierFee` gives it), hold and name the missing field. The user may then choose to
   supply that one value as a [per-plan human-read fact](#per-plan-human-read-facts). The
   WhiteBIT contract comes only from the operator's one-time pinned setup evidence, named as
   such on the sheet. If ccxt's id for the chain differs from the venue's live id on a call
   ccxt builds (Bitget BEP20 outbound), that network does not qualify: pick another one. If a
   live field or a page the user chose to check disagrees with the documented value, the field
   is unknown: hold.
3. A network qualifies if its chain is in the [chain table](#chains), deposits are enabled,
   the USDT contract on that chain matches both the wallet's contract and the reference, and
   the amounts below clear the minimum. Reject bridged variants and other contracts.
4. **Deposit address and memo.** Read them from the operator's own destination account with
   the venue's [native recipient read](references/recipients.md) (for Bybit, the
   [Bybit deposit address](#bybit-deposit-address) flow). Each of the nine exchanges has such a
   read; whether the network qualifies is decided by the gates in the
   [status table](references/recipients.md#status-by-destination-venue).
   The human does not open the exchange. Only if the user chooses the manual path do they
   copy the address and any required memo **themselves** in the exchange app
   (Deposit → USDT → network). If the read finds no address, the operator creates it once in
   the exchange app, and you read again. Never call `get_deposit_address`, even when asked: it
   creates an address on its own without a form, also under `dryRun` (rule 2). On Gate and
   WhiteBIT the read itself may create the address, so it runs only with provisioning allowed in
   the setup record ([provisioning reads](references/recipients.md#provisioning-reads)). Run the
   [address check](references/recipients.md#address-checks) (TON: checksum, mainnet tag,
   basechain). Hold if it fails, or if the memo is missing when required or conflicts with the
   network flag.
   Give the operator these details before asking them to prepare the unsigned wallet preview.
5. **Amounts.** Keep these apart:
   - `S`: the USDT amount the human enters in the wallet;
   - the wallet's network fee on its confirmation screen: record the exact quoted amount,
     its asset, and whether it
     is added on top of `S` or taken out of it. Gas in the chain's native coin (TRX, BNB,
     ETH, TON) is not USDT: it never enters the USDT math, but the wallet must hold enough of
     that coin. A USDT fee taken out of `S` lowers the on-chain amount. If the screen does
     not establish the amount, asset and fee treatment, hold the send. For variable gas,
     record the exact enforceable maximum in the native asset and label it as a cap;
     an estimate alone cannot bind the operator's maximum debit;
   - `N`: the on-chain USDT amount (`S`, or `S` minus a USDT fee taken out of it);
   - `d`: the exchange's deposit fee, and `C = N − d`: the expected credit.

   For Bybit, after the unsigned preview establishes `N` and before issuing the sheet,
   record the chain's `batchReleaseLimit` on the sheet. Bybit documents the string `"-1"`
   as unlimited. For a finite nonnegative decimal limit, verify that the incoming USDT amount
   `N` fits within the remaining credit allowance, accounting for other deposits in the
   applicable period and releases of older pending deposits against the same cap. Use
   verified remaining capacity after those releases; today's deposits alone do not establish it.
   No Bybit read in these tools shows that allowance, so in practice only `"-1"` qualifies.
   A missing or malformed limit, unknown remaining allowance, or amount
   above it holds the sheet. Repeat this check before OPEN; a changed limit requires a new
   sheet. On the user-selected UI path, obtain the equivalent limit from Bybit's deposit
   details. Excess deposits can remain pending. The same cap applies to every send to Bybit,
   including exchange A → Bybit in Scenario 2 and 2.9
   ([Bybit inbound cap](references/recipients.md#bybit-inbound-cap)). [Address response](https://bybit-exchange.github.io/docs/v5/asset/deposit/master-deposit-addr)
   · [Deposit limits](https://www.bybit.com/en/help-center/article/Bybit-Deposit-FAQ)

   Exchanges rarely say whether the deposit minimum applies to `N` or to `C`. Unless the
   exchange states it, require `C` ≥ minimum (that covers both). Example: `S = 150`, gas in
   TRX, `d = 1`, minimum 150: `C = 149` fails; `S = 151` gives `C = 150` and passes. Show the
   human a draft send sheet with the source wallet, destination account, network and contract,
   `S`, network fee <amount or cap, asset, treatment>, `N`, `d`, expected `C`, the minimum and its basis, and the recorded memo requirement. Include
   the sources and UTC time of the route checks. Include the full recipient
   and exact memo and issue `SEND SHEET <ID>, created <UTC>, expires <UTC + 15 min>`.
6. Follow [manual confirmation](#manual-confirmation). Refresh B's conditions, compare the
   wallet's send amount and quoted fee (or maximum), including its asset, with this sheet.
   A change from 1 TRX to 10 TRX requires a new sheet even if the USDT credit stays the same.
   If MCP supplied the address, repeat the recipient read (for Bybit, steps 3 and 4 of the
   [Bybit flow](#bybit-deposit-address)) just before OPEN: chain, address and memo must equal
   the sheet exactly. For a user-selected UI address, refresh it on the same deposit page. Verify the full address, network and exact memo before recording OPEN.
   Only the operator can sign the checked transaction.
7. After sending, ask for the full transaction hash from the wallet and credit the deposit by
   the [deposit rule](#27-reconciliation): the credited amount must equal the expected `C`. A
   deposit that is still confirming is polled read-only (2.7). If the funds must reach a
   trading wallet, run Scenario 3.

### Setup check

Run Step 0, then the venue's key check from [`recipients.md`](references/recipients.md),
before asking for amounts. One-time setup from a cold start is the
[venue profile](references/security.md#venue-profiles): the pinned server, an API key with the
venue's rights, the key in that profile's `config.json` (scheme C) or in the launch
environment (schemes A and B), and a registered server. The values never go into the chat.
Match what you see:

| You see | Tell the operator |
|---|---|
| `fundkit_profiles` says `session: "none"`, or `NO_SESSION`, `TOKEN_REJECTED`, `SESSION_ENDED` | Run `fundkit session` in a separate private terminal on this machine and paste the read-only Doppler service token there (input hidden); keep that terminal open ([session profiles](#session-profiles-optional-doppler)) |
| `MISSING_SECRETS` with names | Add exactly those names (`<EXCHANGE>_APIKEY`, `<EXCHANGE>_SECRET`) to the Doppler config the token reads; nothing else is fetched. The session stays active |
| `PASSPHRASE_NEEDED`, `PASSPHRASE_CANCELLED`, `PASSPHRASE_TIMEOUT` | Type the exchange's API passphrase where the `userStep` says: the `fundkit session` terminal, or `fundkit passphrase <exchange>` in another terminal; never in the chat ([session profiles](#session-profiles-optional-doppler)) |
| `ROLE_DENIED`, `KEY_CHECK_REQUIRED`, `PROVISIONING_NOT_AUTHORIZED`, `NOT_FORWARDED` | Quote the message. A local role, key-check or venue gate held; nothing reached the exchange ([session profiles](#session-profiles-optional-doppler)) |
| `SERVER_NOT_INSTALLED` | Run `fundkit install` once on this machine ([security.md](references/security.md#scheme-d-session-only-doppler-profiles-optional)) |
| no `ccxt-mcp` and no `fundkit` tools | No server is connected to this chat; you cannot see why. Set up the [venue profile](references/security.md#venue-profiles) for each named exchange, restart the host, start a new chat with the [setup prompt](references/prompts.md#setup-and-diagnosis) |
| `get_safety_status` lists no account for the venue (`list_accounts` may be missing: with `hideDisabledTools` and no accounts it is not listed), or `UNKNOWN_ACCOUNT` | The connected server has no account for this exchange: add it to its `config.json`, or register a server whose `CCXT_MCP_CONFIG` points to that profile; restart |
| `configProblems` names the account, or says `REFUSED (strictPermissions)` | Fix the config as the message says (`"funds": "live"` needs `maxTransferValue`; `"funds": true` is sandbox only; `chmod 600` the file); restart |
| `TIER_DISABLED` on a recipient read | Recipient reads need `"funds": "live"` and a `maxTransferValue` in the profile; restart |
| `AUTH_FAILED` with `requires "apiKey"`, `"secret"` or `"password"` credential | This server process received no such credential. Scheme C: add the field (`apiKey`, `secret`, and for OKX, Bitget and KuCoin also `password`, the API passphrase) to that profile's `config.json`. Schemes A and B: set the [variables](references/security.md#venue-profiles) where the server is launched (Codex: also list them in `env_vars`). Restart the host, start a new chat |
| `AUTH_FAILED`, `EXCHANGE_ERROR` or `BAD_REQUEST` quoting the venue's key error (Binance `-2015`, OKX `50120`, Bitget `40014`, KuCoin `400007`, BingX `100413`, MEXC `10072`, Gate `FORBIDDEN`, WhiteBIT `unauthorized`) | The exchange rejected the key or its permission for this read: check the key's rights, IP binding and passphrase against the [venue profile](references/security.md#venue-profiles); replace the key if needed |
| a key check shows a withdrawal right on a deposit-only profile | Not a problem: report it as shown; the role keeps the profile to reads |
| a key check shows no withdrawal right on a source profile that must withdraw | Stop the withdrawal: say exactly that this exchange's key cannot withdraw. Reads continue |
| any other error | Quote the code and message; do not guess the cause |

When a check fails or a value is unknown, hold. You may offer the manual path (the human
copies the address in the exchange app) only as an option the user chooses, never as a
required step.

### Bybit setup check

For Bybit, the setup check is Step 0, then steps 1 and 2 of the
[Bybit flow](#bybit-deposit-address) in that order (the coin-list read comes first, which
matters for `10005`). The Bybit-specific rows, with the
[Bybit deposit profile](references/security.md#bybit-deposit-profile):

| You see | Tell the operator |
|---|---|
| `fundkit_profiles` says `session: "none"`, or `NO_SESSION`, `TOKEN_REJECTED`, `SESSION_ENDED` | Run `fundkit session` in a separate private terminal on this machine and paste the read-only Doppler service token there (input hidden); keep that terminal open ([session profiles](#session-profiles-optional-doppler)) |
| `MISSING_SECRETS` with names | Add exactly those names (`<EXCHANGE>_APIKEY`, `<EXCHANGE>_SECRET`) to the Doppler config the token reads; nothing else is fetched. The session stays active |
| `PASSPHRASE_NEEDED`, `PASSPHRASE_CANCELLED`, `PASSPHRASE_TIMEOUT` | Type the exchange's API passphrase where the `userStep` says: the `fundkit session` terminal, or `fundkit passphrase <exchange>` in another terminal; never in the chat ([session profiles](#session-profiles-optional-doppler)) |
| `ROLE_DENIED`, `KEY_CHECK_REQUIRED`, `PROVISIONING_NOT_AUTHORIZED`, `NOT_FORWARDED` | Quote the message. A local role, key-check or venue gate held; nothing reached the exchange ([session profiles](#session-profiles-optional-doppler)) |
| `SERVER_NOT_INSTALLED` | Run `fundkit install` once on this machine ([security.md](references/security.md#scheme-d-session-only-doppler-profiles-optional)) |
| no `ccxt-mcp` and no `fundkit` tools | No server is connected to this chat; you cannot see why. Set up the [Bybit deposit profile](references/security.md#bybit-deposit-profile), restart the host and start a new chat |
| `get_safety_status` has no Bybit account (`list_accounts` may be missing: with `hideDisabledTools` and no accounts it is not listed), or `UNKNOWN_ACCOUNT` | The connected server has no Bybit account: add one to its `config.json`, or register a server whose `CCXT_MCP_CONFIG` points to the Bybit profile; restart |
| `configProblems` names the Bybit account | Fix the config as the message says (`"funds": "live"` needs `maxTransferValue`; `"funds": true` is sandbox only); restart |
| `TIER_DISABLED` | Address reads need `"funds": "live"` and a `maxTransferValue` in the profile; restart |
| `AUTH_FAILED` with `requires "apiKey" credential` or `requires "secret" credential` | This server process received no Bybit key or secret. Scheme C: put `apiKey` and `secret` into the Bybit profile's `config.json`. Schemes A and B: set `BYBIT_APIKEY` and `BYBIT_SECRET` where the server is launched ([environment contract](references/security.md#environment-contract); in Codex also list both in `env_vars`). Restart the host, start a new chat |
| `AUTH_FAILED` with `retCode` `10003` (invalid key), `10004` (signature) or `10010` (IP not bound) | Bybit rejected the key: check that both values belong to one live main-account key and the IP allowlist; replace the key if needed |
| `AUTH_FAILED` with `retCode` `10005` on the network data read (step 1) | Bybit denied this key its coin list (`/v5/asset/coin/query-info`). The key's rights are still unverified. If the initial market load failed, subsequent calls in this process repeat that error. A later coin-info denial alone does not establish that the initial load failed. Check the key in Bybit's API management, then restart the host |
| `AUTH_FAILED` with `retCode` `10005` on the key check (step 2) after step 1 succeeded | Bybit denied the key check itself, so the key's rights are unknown: stop the Bybit read |
| any other error | Quote the code and message; do not guess the cause |

For `10005`, ccxt adds a generic text naming "Account Transfer", "Subaccount Transfer" or
"Withdrawal": never tell the operator to add those rights. When a check fails or a value is
unknown, hold. You may offer the manual path (the human copies the address in the Bybit app)
only as an option the user chooses, never as a required step.

### Bybit deposit address

Use one alias with `"funds": "live"` for every read below.

1. **Network data.** Read Bybit's [network source](references/exchanges.md#network-data-sources).
   It is the first authenticated Bybit call, so a `10005` here is the coin-list denial in the
   [setup check](#bybit-setup-check). Bybit's deposit fee `d` is `0` by its
   [published policy](references/exchanges.md#bybit-deposit-address); name that source on the
   sheet.
2. **Key check.** `call_implicit_get {"exchange":"bybit","account":"<alias>","method":"privateGetV5UserQueryApi"}`.
   Require `isMaster: true` (Bybit gives deposit addresses only to main-account keys; without
   it, say exactly that). Report `readOnly` and `permissions` exactly as shown: the one Bybit key
   may be write-enabled, the deposit-only role keeps this profile to reads, and you never ask
   for a separate read-only key or a rights change ([session profiles](#session-profiles-optional-doppler)).
   Report `note`, `ips` and the permissions; never repeat `apiKey` (the server redacts it).
   The result also shows `userID`: it is not an account check, so do not report it as one, ask
   the operator to confirm it, or compare it with anything.
3. **Gated address read** for the chosen network:
   `call_read_method {"exchange":"bybit","account":"<alias>","method":"fetchDepositAddressesByNetwork","args":["USDT"],"params":{"network":"<code>"},"includeInfo":true}`.
   ccxt-mcp allows it only on a `funds` account. `dryRun` does not stop it; the client sends
   only `GET /v5/asset/deposit/query-address` ([details](references/exchanges.md#bybit-deposit-address)).
   `data` must have exactly one key, `<code>`. From its raw `info`:
   - `chain` is Bybit's id for the chain (`TRX`, `BSC`, `ETH`, `TON`) and must be the chosen one;
   - `addressDeposit` must be a nonempty string containing a full address valid for the chosen chain;
   - `tagDeposit` must be a string: only `""` means none. Preserve nonempty memo strings exactly,
     including leading zeros. Hold on missing, null, non-string or whitespace-only fields;
   - `contractAddress` shows the contract's last 6 characters, which must match the
     [reference contract](#chains) (in any letter case on EVM chains).
4. **Authoritative address response.** ccxt keeps one entry per network, so a second Bybit entry
   for the same chain silently replaces the first in step 3 (verified offline). Only after
   step 3 succeeded, on the same alias, call
   `call_implicit_get {"exchange":"bybit","account":"<alias>","method":"privateGetV5AssetDepositQueryAddress","params":{"coin":"USDT","chainType":"<chain>"}}`
   with `<chain>` from step 3. This raw endpoint is not funds-gated, so never use it alone or
   instead of step 3. Require `retCode: 0`, `result.coin: "USDT"` and exactly one entry in
   `result.chains`, whose `chain`, `addressDeposit`, `tagDeposit` and `contractAddress` equal
   step 3's `info`.

   Step 3 establishes permission and supplies a comparison value. Its normalized output cannot
   establish how many raw rows Bybit returned on that earlier request. Use only the unique
   raw row from step 4 as the address source. Empty data, multiple raw rows, a wrong chain
   or any conflicting field: stop. The client sends GETs only.
   Capture the raw limit for the later amount check. Show the verified recipient now so
   the operator can prepare the unsigned preview.
5. **Show it.** Put the address and the memo (or `none`) each in its own code block, copied
   character for character from the unique raw row in step 4, with the provenance
   `Bybit alias <alias>, read <UTC>, chain <chain>`. Copy the same values into
   the send sheet. The human pastes the address from your code block and later checks the
   wallet's final screen against the latest step 4 raw result (rule 9). To see the
   full tool result, they use their host's own view of the tool call: in Claude Code,
   `Ctrl+O` opens the detailed transcript. If the host truncates or hides the result, pause;
   the user may instead choose to copy the address and any required memo from Bybit's deposit page, which then is
   the source.

## Scenario 2. Exchange A → exchange B (semi-automatic)

**Two profiles, one session.** The default setup connects both accounts to the same host
session: a source profile for A (read + withdrawal, IP-bound, B's address whitelisted) and a
destination profile for B (reads only, on B's one key; `funds` for the recipient read), and, only if B must
move the credit, a separate settlement registration for the same B account (read + internal
transfer; it may use the same key), each in its own server
([scheme C](references/security.md#scheme-c-per-profile-credential-files-two-profile-session)).
With session profiles (scheme D) every role of one exchange uses that exchange's one Doppler key
instead, and fundkit enforces the roles ([session profiles](#session-profiles-optional-doppler)).
Every profile that moves money is a
[money-moving registration](references/security.md#money-moving-registrations), and every
registration matches the [setup record](references/security.md#setup-record) (Step 0).
You do the preparation: both preflights, both networks, B's recipient by its
[native read](references/recipients.md), fees and amounts, the plan, the withdrawal, the
proof on A, the deposit match on B and any settlement transfer on B. The user approves the
plan with `APPROVE`, approves the withdrawal with `WITHDRAW`, approves any settlement transfer
on B with its own `APPROVE <PLAN-ID>-B`, and then confirms each money move in its native form; a reply in the chat never replaces the form, and the form never
replaces the reply. The agent asks only for facts that no tool result and no setup record
supplies, and names each one. A route runs only when every gate below passes on live data and
the setup record. The
[destination status table](references/recipients.md#status-by-destination-venue) and the
[outbound table](references/exchanges.md#outbound-withdraw) name the venues where a documented
fact is missing, and those routes hold. Without a B profile in this session (scheme A), use the
[HANDOFF](#28-settlement-on-b) fallback.

**What a route relies on.** Report it on every plan in three classes, which can overlap
([prerequisites by route](references/recipients.md#prerequisites-by-route)):

- **Common setup** (one-time, every API route): one setup-record line per registration
  (registration, alias, exchange, environment, `configPath`, `journal`, role) and the
  interactive-form line. No API route runs on live
  fields alone.
- **Venue-specific setup** (one-time, only some routes): a whitelist entry in the setup record
  (every source except Binance and Gate, which have a saved-address read), an entity line
  (Binance, Bybit, OKX and BingX sources, WhiteBIT either side), a key-rights or IP line where
  no read shows it (Gate, MEXC, WhiteBIT), BingX permission-code meanings, provisioning consent
  (Gate and WhiteBIT as B), the WhiteBIT contract pin.
- **Per-plan facts** (only if the user opts in): a [human-read fact](#per-plan-human-read-facts).

After the one-time setup, the human's part in a plan is `APPROVE`, `WITHDRAW` and the native
forms, plus any per-plan fact they chose to supply. Never call a route "native" or "ready"
because it passes these gates offline.

### 2.1 Account mode and available amount (live data)

- **Account mode** comes from a live response, never a guess: Bybit UTA or classic, OKX
  `acctLv` (`fetchAccounts` with `includeInfo`), Binance classic or Portfolio Margin, Gate /
  Bitget / KuCoin classic or unified. The mode decides wallet names, the withdrawal wallet and
  the Bybit and Bitget `params`. Unknown mode: stop.
- **Available to transfer or withdraw** is the exchange's field for that mode in the raw
  `fetchBalance` response of the right wallet with `includeInfo: true`. Put the field name
  and value in the plan. `free` without such a field is not an available amount. No field:
  stop. Where to look: [account mode table](references/exchanges.md#account-mode-and-available-amount).
- **Margin reserve** is named by the user; suggest at least 20 % of used margin and at least
  10 USDT. Check positions with `get_positions`. The transferable amount is
  `min(exchange available, free − reserve)`. A transfer must not move a position closer to
  liquidation without explicit consent.

### 2.2 Network choice (both sides, live data)

1. On **each** side, read the network from that exchange's
   [network data source](references/exchanges.md#network-data-sources). Do not use
   `fetchCurrencies` to pick a network: a response over 80,000 characters is replaced whole
   by `{"truncated":true}`. Read B's fields with B's profile in this session. Only if this
   launch has no keyed profile for B (scheme A) and B's source needs a key, the human reads
   B's fields on B's deposit page under the same rules as a
   [per-plan human-read fact](#per-plan-human-read-facts) (source, UTC, at most 15 minutes old,
   restated at the recheck); without that, hold the route. That is a fallback, not the
   two-profile default.
   The landing wallet comes from B's recipient read where the venue returns it (OKX `to`,
   KuCoin `to`); otherwise it is located after the credit (2.8).
2. Enable flags, minimums, contract, memo and precision appear only in `info` (or in the
   `call_implicit_get` response), with different field names per exchange. A field with no
   live source and no documented value in
   [`recipients.md`](references/recipients.md#status-by-destination-venue) is unknown and the
   network does not qualify. Name the field. The user may supply it as a
   [per-plan human-read fact](#per-plan-human-read-facts) if it is B's minimum or deposit fee,
   or send manually ([2.9](#29-manual-withdrawal-in-exchange-as-ui)). Infer nothing from the
   network name.
3. For **every route**, verify that A allows withdrawal and B allows deposit on the same
   [reference chain and USDT contract](#chains). Record each venue's network ID or UI label,
   the source and UTC time of each check, and all applicable minima and maxima. Compare
   EVM contract addresses by their full 20-byte value, regardless of letter case. Use the deposit or withdrawal page
   for missing API fields. Check the full recipient and memo per rule 9.
   - **API withdrawal:** require a native form, API withdrawals enabled on A, and an
     [outbound table](references/exchanges.md#outbound-withdraw) entry whose wire value
     matches A's live network ID (BingX: the live id must equal the code). B's full address
     and memo must be on A's withdrawal whitelist for that chain. Adding it is the operator's
     one-time 2FA step in A's security settings per destination address. Never ask for or
     attempt to bypass that step. The plan records the evidence from the
     [whitelist evidence table](references/exchanges.md#withdrawal-whitelist-evidence): the
     saved-address row on Binance and Gate, otherwise the setup record entry and its UTC, in
     both cases equal to the recipient character for character.
     Binance, Bybit, OKX and BingX sources, and WhiteBIT accounts on either side, need the
     venue's [entity line](references/exchanges.md#entity-lines) in the setup record. One rule
     for all of them: the venue's global platform label exactly, an ISO 3166-1 alpha-2
     jurisdiction that the venue's official page does not list, "not required", and the
     evidence. Any other entity name, a regional entity, a missing or invalid jurisdiction, a
     listed jurisdiction (for Binance every EU country, Italy and Germany included, besides
     the other listed ones), "required" or "unknown" holds before any money call.
     If B is Bybit, apply the [Bybit inbound cap](references/recipients.md#bybit-inbound-cap).
   - **Manual withdrawal:** qualify the network using the UI labels, chain, contract,
     availability and the UI amount step. Confirm exact amounts from A's preview in
     [2.9](#29-manual-withdrawal-in-exchange-as-ui). The API table and ccxt serialization
     checks apply only to API calls.
4. Matching names (`BEP20` and `BSC`) prove nothing. The same contract address can exist on
   several EVM chains, so chain **and** contract decide together.
5. Network cost is A's withdrawal fee plus B's deposit fee plus internal transfers. Pick the
   cheapest; on a tie, the faster one.

#### Per-plan human-read facts

Where no live documented field and no documented policy gives B's **deposit minimum** or
**deposit fee** (Binance and MEXC minimum, Gate's minimum on a multi-chain address response,
KuCoin's fee while its fields are empty), the user may choose to read that one value on B's
deposit page for this plan. The same rule applies on every venue:

- only those two fields, only where nothing documented supplies them. A human value never
  replaces a network id, contract, recipient, available amount, A's fee or step, a whitelist
  entry or an entity line;
- the plan names it `source: human, <venue> deposit page, <network>, read <UTC>`. The reading
  must be at most 15 minutes old when the plan is made, and it binds that plan only;
- at the recheck before the withdrawal (2.5) the human reads it again and states the value.
  A different, missing or late restatement means zero dispatch and a new plan;
- if a documented value exists and the human's value differs, the field is unknown: hold.

A plan with such a fact is still an API withdrawal with `APPROVE`, `WITHDRAW` and the native
form. Report it as "with a per-plan human-read fact", never as automatic, and never presume
the value holds for the next plan.

#### Chains

Only these chains and contracts. A chain qualifies only if **both** sides (the wallet or A,
and B) support USDT on that exact chain at exactly that contract. The reference contracts
matched across Gate, KuCoin and Bitget.

| ccxt code | Chain | USDT reference contract |
|---|---|---|
| `TRC20` | Tron mainnet | `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` |
| `BEP20` | BNB Smart Chain, EVM chainId 56 only (not opBNB, not BNB Beacon Chain) | `0x55d398326f99059fF775485246999027B3197955`, the only allowed BSC token (BscScan: Binance-Peg BSC-USD, listed by exchanges as USDT BEP20/BSC); no other USDT-named BSC contract |
| `ERC20` | Ethereum mainnet, EVM chainId 1 | `0xdAC17F958D2ee523a2206206994597C13D831ec7` |
| `TON` | TON mainnet (memo required if the exchange asks for one) | `EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs` |

### 2.3 Debit, withdraw amount and credit

Keep three numbers apart:

- `D`: the **gross debit** on A (what leaves the balance);
- `W`: the **`amount` argument** of `withdraw`;
- `C`: the **net credit** on B.

Let `f` be A's withdrawal fee (fixed plus percentage, if any) and `d` be B's deposit fee.
Both must be exact: from a live exchange field or, for `d`, the documented policy in the
[destination status table](references/recipients.md#status-by-destination-venue), or, for
`d` only, a [per-plan human-read fact](#per-plan-human-read-facts) the user chose to supply.
Unknown `d`, or sources that disagree: stop.

| A's fee model | `D` | `C` |
|---|---|---|
| on top | `W + f` | `W − d` |
| deducted from amount | `W` | `W − f − d` |
| **unconfirmed** (default) | `W` to `W + f` | `W − f − d` to `W − d` |

Treat the model as unconfirmed until exchange fields or documentation show it directly. With
an unconfirmed model, require at least `W + f` available, and the lower bound of `C` must be
at least B's deposit minimum (that holds whichever amount B applies the minimum to). The plan
states `C` as bounds; any transfer on B is planned later from the actual credit
([2.8](#28-settlement-on-b)).

Example (debit budget): budget 100 USDT, `f = 1` on top, `d = 0`. Then `W = 99`, `D = 100`,
`C = 99`. If the model is unconfirmed, `W = 99` gives `D` from 99 to 100 and `C` from 98 to
99.

Example (target credit): B must receive 300 USDT, `f = 1`, `d = 0`, model unconfirmed. Use
`W = 300 + f + d = 301`: then `C` is 300 to 301, `D` is 301 to 302, and A must have at least
302 available.

- **Fee in another asset.** If `f` or `d` is charged in something other than USDT, do not add
  it into `D`/`W`/`C`. Check that asset's balance on the right side separately: it must cover
  the fee plus a reserve the user names. Unknown asset: stop.
- **OKX.** Pass `{"fee":"<f>"}` in `params`, where `f` is the exact fee for that network from
  the same live response the plan was built on. ccxt 4.5.85 sends it as `fee` (verified).
  Without `fee`, ccxt takes the fee from its own currency data (`GET /asset/currencies`,
  merged with the load cache), not from the plan. A call without `fee` is therefore not
  allowed. OKX's current withdrawal reference lists no `fee` parameter and says the fee is not
  included in `amt`. So passing `fee` is what ccxt sends, not a binding the server is shown to
  honor; whether OKX applies it exactly was not verified. A nonempty, nonzero `burningFeeRate`
  makes `f` inexact: hold.
- **Percentage fees.** A fee with a percentage part is exact only when its rate is zero (Bybit
  `withdrawPercentageFee`, Gate `withdraw_percent_on_chains`, KuCoin `withdrawFeeRate`, OKX
  `burningFeeRate`). Otherwise `f` is unknown: hold.
- **Minimums, maximums and quotas.** Check `W` against A's withdrawal minimum (Gate: the larger
  of `withdraw_amount_mini` and the chain's `withdraw_amount_min`) and `C` against B's deposit
  minimum. Check `W` against A's per-transaction maximum where the venue reports one (OKX
  `maxWd`, Bybit `remainAmount`), against OKX's 24 h USD quota (`wdQuota − usedWdQuota` at
  least 1.02 × `W`, a margin of this skill for the USD value of USDT) and against the
  profile's `maxTransferValue` and `maxDailyValue`. For OKX as B, a nonempty `depQuotaFixed`
  needs `depQuotaFixed − usedDepQuotaFixed` of at least 1.02 × the upper bound of `C`.
  Exceeded or unreadable: hold.
- **Entities.** The skill sends no travel-rule data: no Binance questionnaire, no OKX
  `rcvrInfo`, no Bybit `beneficiary`, no BingX KYC=KOR fields. Each such source, and WhiteBIT
  on either side, needs its [entity line](references/exchanges.md#entity-lines) under the one
  rule in 2.2; otherwise hold.
- **Representable amounts (before plan approval).** Every call amount (`W` and each
  `transfer` `amount`) must reach the exchange unchanged:
  - at most 15 significant digits and at least `0.000001`: MCP passes the amount as a JSON
    number, some exchanges receive it as a number too, and `0.0000001` went out as `1e-7`
    (verified offline);
  - the amount is a multiple of **every** step: currency, network, and the exchange's own
    step for that withdrawal or transfer. ccxt rounds some calls by the currency step and
    others by the network step, usually to nearest, so possibly up (see the
    [amount step table](references/exchanges.md#amount-steps)). Each step comes from a live
    field (name and value in the plan), from that table, or from the withdrawal page as read
    by the human. Any step unknown: stop;
  - if the amount fails, reject it and do not silently adjust it, neither yourself nor by
    letting ccxt round it. A smaller multiple is a new plan: recompute `D`, `W`, `C`, `f`,
    `d`, minimums, reserve, budget and target credit. Target no longer met: stop.

  Example: Gate, `W = 10.12349`, ccxt currency step `0.0001`, network step `0.00001`. Gate
  rounds by the currency step and would send `10.1235`, more than planned (verified offline).
  The original amount is rejected. `10.1234` is allowed only after recomputing: if B needs at
  least `X`, the lower bound of `C` at the new `W` must stay ≥ `X`, otherwise stop.

### 2.4 Plan

```text
PLAN <PLAN-ID>  (for example FK-20261124-1312-OKX-BYBIT), created <UTC>, expires <UTC + 15 min>
Route: <A-alias> (<mode>) → <B exchange> (B's mode, wallets and caps are read in B's session), USDT
Chain: <Tron mainnet | BNB Smart Chain 56 | Ethereum 1 | TON mainnet>, contract <…> (A: <source, UTC>, B: <source, UTC>)
Network: A network=<ccxt code> → outbound <field>=<value> = id in A's response <…>; B network id <…> (<source>)
Candidates: <network / A withdraw / B deposit / fee / min / field source>
Available on A: <field>=<value>, reserve <R>, transferable <T>; needs D_max + R
Amounts: D=<…>, W=<…>, C=<…> (fee model: <on top | deducted | unconfirmed>); f=<…> <asset>, d=<…> <asset>
Amount steps: currency <…>, network <…>, exchange <…> (<source>); W and transfer amounts are multiples of all, ≤ 15 significant digits, ≥ 0.000001
Registrations: A <registration> / <alias> / <environment> / journal <path>; B <same>  (each equal to the setup record)
B deposit: address <full address>, memo <none | exact memo>, source <native read: <venue> alias <B alias>, read <UTC> | B's UI, by the human>; address check <EVM format | TON OK>
Whitelist on A: <saved-address row: <fields> | setup record <UTC>>, equal character for character; entity line: <venue label / jurisdiction, not required, evidence | n/a>
Relies on: common setup <registration lines, interactive-form line>; venue-specific <whitelist entry | entity line | key rights or IP line | BingX codes | provisioning | WhiteBIT contract pin | none>; per-plan <B minimum or fee: value, source: human, <venue> deposit page, read <UTC> | none>
Memo requirement: <required | not required | no published flag>; evidence <source, UTC>
Bybit inbound cap: <batchReleaseLimit "-1" (unlimited), read <UTC> | n/a>
Expected on B: C=<C_min>…<C_max> USDT, lands in <B wallet> (source: <recipient read | typical, unverified>); d=<…> (<live field | documented policy URL>)
Calls on A (exactly these arguments):
  1. transfer {"account":"<A>","code":"USDT","amount":<…>,"fromAccount":"<…>","toAccount":"<…>","params":<{} | per transfer proof table>}
     proof: <API: <read from the transfer proof table> | operator: <A> UI transfer history, access and quiet window confirmed <UTC> | manual: the human transfers in A's UI>
  2. withdraw {"account":"<A>","code":"USDT","amount":<W>,"address":"<full address>","tag":"<memo as a string, preserve every character when the verified recipient supplies a memo; omit tag when it supplies none>","network":"<code>","params":<per table>}   ← separate WITHDRAW <PLAN-ID>
     proof: fetchWithdrawals record with the call's id, status ok, with a hash
Then: on final source success, B's profile in this session matches the deposit by hash (2.7, 2.8); any transfer on B is a separate plan <PLAN-ID>-B with its own approval (HANDOFF only without a B profile).
Before each write: expiry and that step's checks (2.5). Both networks are checked before the withdrawal.
Caps: maxTransferValue A=<…>; user limit <…> | target credit <…>
To approve: APPROVE <PLAN-ID>
```

### 2.5 Executing each write

1. **Expiry.** Before **every** dispatch, including accepting a native form, check that the current
   UTC time is strictly before `expires`. If `now ≥ expires`, the plan has expired, and the
   remaining steps go into a new plan with a new approval (and a new `WITHDRAW` for a
   withdrawal).
2. **Recheck before the call.** For every step, compare the exact arguments with the approved
   plan and check the account mode, available amount, reserve and caps on the debited
   exchange. What else to check depends on the step:
   - **Internal transfer** (on A, or on B per 2.8): both wallets, the exact amount and the
     step's **proof route**, fixed before approval. Use the API route only if the
     [transfer proof table](references/exchanges.md#transfer-proof) has a read for this
     exchange and mode. Otherwise use the operator route only if the operator has already
     confirmed access to the exchange's transfer history and the quiet window (2.7). If
     neither holds, the step is manual: the human does it in the exchange UI, and the agent
     does not call `transfer`.
   - **Withdrawal from A**, immediately before the call, with fresh reads: A's network row
     (withdraw enabled, id, fee, withdrawal minimum, steps, contract), B's network row (deposit
     enabled, id, deposit minimum, deposit fee, contract, memo-required flag), B's recipient
     read (address, memo, unique row, Bybit `batchReleaseLimit`, Gate's top-level minimum and
     its single-chain condition, WhiteBIT `required`), A's available field against
     `D_max + reserve`, `maxTransferValue` from `list_accounts`, and any per-plan human-read
     fact, read again and restated by the human. Every value must equal the approved plan. A Bybit limit that is no longer `"-1"`, or any other difference, means zero
     dispatch: do not call `withdraw`, and make a new plan with new approvals. If B's data is
     only available in B's app, the operator checks it there before the withdrawal.

   If any condition of the step is unknown, stop. If the conditions of the approved plan have
   changed, recompute the remaining steps and get a new approval.
3. **Snapshot.** Save the UTC time and `since` (that time in ms minus 60 000) for the proof
   read. Before a withdrawal, also save the latest IDs from `fetchWithdrawals` on A and the
   balance of the debited wallet. Before a transfer, also save both wallets' balances (they
   only locate funds; they prove nothing). After the withdrawal, find its record by ID and
   write the hash into the chat. Before dispatch, publish the [OPEN record](#journal-line-in-the-chat).
4. **Call with exactly the plan's arguments.**
   - `elicitationSupported: true`: the call opens the host's form. The form shows only a
     preview (amount, wallets or address and network, memo, environment) and one `confirm`
     field (yes/no); it has no PLAN-ID, no expiry and no `params`. So **before** the call,
     tell the human: `<PLAN-ID> step <n>: the form opens now, plan expires <UTC>`. The human
     accepts the form only if, at the moment of accepting, they have checked the clock
     themselves, it is strictly before that expiry, and every form field matches the plan. If
     `now ≥ expires` or a field cannot be checked, they decline. Accepting sends the write
     immediately. The server waits up to 300 s for an answer, then returns
     `CONFIRM_UNAVAILABLE` (nothing sent). The host's tool timeout must be longer than that
     ([host registration](references/security.md#host-registration)).
   - Confirmed decline (`CONFIRM_DECLINED`, `CONFIRM_CANCELED`): nothing was sent. Remaining
     steps only via a new plan with fresh data and new `APPROVE` (and `WITHDRAW`).
   - Form response lost or unknown (host timeout, dropped connection, no response): the write
     may have gone out. Reconcile per 2.7 only; do not repeat the call.
   - `elicitationSupported: false`: no MCP money move. Withdrawals go through the exchange UI
     (2.9) and internal transfers are done by the human in the exchange UI. Never call
     `withdraw` or `transfer` in token mode and never redeem a `confirmToken`: the model could
     redeem it itself, so it is not a human confirmation.
5. After each step, reconcile against history (2.7) and write a journal line.

### 2.6 Responses: what was definitely not sent

| Response | Meaning | Action |
|---|---|---|
| `CONFIRM_INVALID`, `CONFIRM_EXPIRED`, `CONFIRM_MISMATCH` | token rejected before dispatch (only seen if a token was redeemed, which this skill never does) | stop and report |
| `CONFIRM_DECLINED`, `CONFIRM_CANCELED` | the human declined or closed the form; nothing sent | stop; remaining steps need a new plan and new approvals |
| `CONFIRM_UNAVAILABLE` | the form did not open or got no answer within 300 s; nothing sent | stop; for a withdrawal use a fresh manual sheet after confirming non-execution |
| `TIER_DISABLED`, `TRANSFER_VALUE_CAP`, `DAILY_VALUE_CAP`, `UNVALUABLE_TRANSFER`, `UNKNOWN_ACCOUNT`, `-32602` | gate or schema rejection before dispatch | stop and report |
| **everything else**: `UNKNOWN_OUTCOME`, `EXCHANGE_ERROR`, `INSUFFICIENT_FUNDS`, `AUTH_FAILED`, `BAD_REQUEST`, `INTERNAL_ERROR`, host timeout, dropped connection, no response | the write may have gone out | reconcile per 2.7, no retries |

Inside `withdraw` and `transfer`, ccxt makes preliminary reads: account mode on Bybit,
currencies on OKX without `fee`, a UTA probe on Bitget and KuCoin. Their failure also comes
back as `UNKNOWN_OUTCOME` and cannot be told apart from a failure of the write itself.

### 2.7 Reconciliation

- **A step is done only with an attributable unique ID and a success status for that ID.**
  The ID is the `id` in the call's own response. It says which record is this step's, not
  that the step succeeded. Compare IDs only within the namespace the
  [transfer proof table](references/exchanges.md#transfer-proof) names. OKX `transId` is not
  a `billId`, KuCoin `orderId` is not a ledger `id`, BingX `transferId` is not `tranId`, and
  a withdrawal ID on A is not a deposit ID on B.
  - **Withdrawal:** the record with that `id` in `fetchWithdrawals` (WhiteBIT: the
    `uniqueId` that ccxt generates and returns as `id`), status `ok`, with a hash.
  - **Transfer, API route:** the table's read for that exchange, with `since` from the
    snapshot (2.5) and `includeInfo: true`. It must return exactly one record with that ID,
    the exchange's success value, and the planned amount and wallets.
  - **Transfer, operator route** (the table has no API proof for this exchange and mode).
    Before approval, the operator confirms two things. First, they can open this account's
    transfer history in the exchange UI, showing time, amount, from and to wallets, and
    status. Second, nobody else (other sessions, the UI, other people, automatic transfers)
    will move USDT between those wallets until reconciliation is done. After the call, the
    operator reports exactly one record in the window from the snapshot to now, with the
    planned amount and wallets and a final success status, plus the record ID if the UI
    shows one. The journal line names the source: `operator, <exchange> UI, <UTC>`.
- **Status handling** (transfers, withdrawals, deposits; values in any letter case). Nothing
  is ever re-issued:
  - success (`ok` or the table's success value): done; write the journal line.
  - **pending** (`pending`, `processing`, `WAIT`, or a deposit or withdrawal still
    confirming): poll read-only, at most once a minute. Re-read the same record by the same
    ID or hash. Do no write and take no next step. If it is still pending after the time the
    exchange states, the operator checks the UI, and polling continues.
  - **failed** (`failed`, `fail`, `canceled`, `rejected`): keep OPEN until the operator
    identifies the terminal failure and shows from attributable exchange or chain records
    that no debit was taken or how the debit was reversed or released. Record the returned amount and any retained fee.
    Close as FAILED-RECONCILED with the operation ID/hash, proof references and UTC time.
    An unexplained shortfall, pending refund or balance change alone keeps the step OPEN.
    Any further attempt needs a new plan or sheet and fresh authorization.
  - **missing** (the ID is not in the read, OKX returns all fields `null`, or the list is
    empty): this proves neither success nor non-execution. Poll read-only for a few minutes,
    then hold and ask the operator.
  - **ambiguous** (any other value or `null`, several candidates, a record that changed after
    reconciliation, or no ID because the outcome is unknown): hold. Only reads and operator
    investigation are allowed. If the operator attributes exactly one record to this step
    from the exchange's own records, its ID then goes through the same status handling.
- Matching amount, address, network or wallets, and balance shifts, are **not** proof, even
  when the timing matches: a parallel operation (another session, the UI, another person)
  looks the same. Report such records as "candidate" and go no further.
- An empty `get_safety_status.unresolvedIntents` **does not prove** nothing went out. On
  `UNKNOWN_OUTCOME` the journal closes the intent with an `error` entry, and the intent
  leaves the list. The server never sees a host timeout. The list shows only intents cut off
  by a process crash, and those trigger the crash hold (Step 0).
- **Deposit credit** (Scenarios 1 and 2). Read history with `includeInfo: true`:
  `call_read_method {"exchange":"<B>","account":"<B-alias>","method":"fetchDeposits","args":["USDT",null,20],"includeInfo":true}`.
  In the A session, read `fetchWithdrawals` with `includeInfo: true` and write the full hash
  into the chat.
  - `id` is an operation number inside one exchange. It links a call to a record on that
    same exchange. The only link across exchanges, or to the wallet, is the full on-chain
    transaction hash. Usually that is `txid`, but WhiteBIT puts the hash in raw
    `info.transactionHash`, while its unified `txid` is an internal WhiteBIT id (verified
    offline).
  - Compare networks within one namespace: raw with raw, unified with unified. KuCoin raw
    `info.chain: "bsc"` is the `chainId` from the network source, while unified
    `network: "BEP20"` is the ccxt code (verified offline). Do not compare `bsc` with
    `BEP20`.
  - Compare the full hash. For hex hashes, letter case and a leading `0x` do not matter.
    Any other difference (a suffix, a truncated value) is not a match; treat it as ambiguous
    and have the operator check.
  - A deposit counts only if there is **exactly one** record with that hash. The hash must
    equal A's withdrawal hash (or the hash from the wallet). On **both** venues (A's withdrawal
    record and B's deposit record) the asset must be USDT in the unified and the raw field, the
    unified network must be the plan's ccxt code and the raw chain field the venue's id for that
    chain (compare raw with raw ids, unified with unified codes), and the status terminal
    success: unified `ok` **and** the venue's raw success value
    (BingX: raw `status` `6` only, because ccxt maps BingX's "not credited" `1` to `ok`).
    MEXC deposits: ccxt 4.5.85 derives the unified network from MEXC's long network string
    (`BSC` for BEP20, the raw string itself for TON), which is not a ccxt code; there the raw
    `network` must equal the config row's `network` string for the chosen chain, and the
    unified network is not used (verified offline). The credited amount must be unambiguous and
    match the expectation: within the `C` bounds of the plan, handoff or sheet (Scenario 2)
    or equal to the send sheet's `C` (Scenario 1). Network gas is never part of it.
  - For both scenarios, match the full credited recipient and the exact memo on the send
    sheet or handoff. Preserve leading zeros. A withdrawal that was authorized and sent but
    whose receipt names another chain, another asset or another recipient is held: no onward
    step of any kind, reads and operator investigation only. If history omits a field, use corroborating
    evidence tied to that transaction, such as its destination-chain record or exchange
    receipt. Missing evidence or a mismatch holds settlement, even with the right hash and amount.
  - A record with the right hash that is still confirming is pending (poll as above). No
    hash, several candidates, no visible credited amount, a credit outside the expectation,
    or a record that changed after reconciliation is ambiguous: hold, report, and take no
    next step.
- Call only history methods the exchange has. Report any discrepancy over 0.01 USDT.

### 2.8 Settlement on B

B's mode, wallets, available amounts, steps and caps are read only with B's profile. In a
two-profile session (schemes B and C) that is this chat: after A's withdrawal record shows
its ID, a final successful status and the full on-chain hash (2.7), continue directly with
the steps below on B's alias, using the plan as the record (no block to paste). Without a B
profile (scheme A) it is a new launch and a new chat
([scheme A](references/security.md#scheme-a-one-keyed-account-per-launch)). That chat starts
by reading this file, and the human pastes the HANDOFF block plus the latest operation
record for any previously used account. For both API and manual withdrawals, issue the
block, or start the B steps, only when the same attributable source withdrawal record shows
its ID, a final successful status and the full on-chain hash (2.7). A hash can appear while
the withdrawal is pending: keep OPEN and poll read-only. Missing or uncertain status holds
the route even if B already displays a deposit.

```text
HANDOFF <PLAN-ID> A→B, written <UTC>
B: exchange <ccxt id>, account <B alias>
Lands in: <B wallet> (source: <B UI | typical, unverified>); then: <nothing | transfer to <B wallet>>
User: limit <USDT> | target credit <USDT>
Chain: <name>, EVM chainId <56 | 1 | none>, contract <…>, ccxt code <…>, B network id <…>
Pre-send verification: A <source, observed chain and contract, UTC>; B <source, observed chain and contract, UTC>
Deposit: address <full address>, memo <none | exact memo>
A: <exchange> <alias>, withdrawal id <…> (A's namespace), W=<…>, D=<…>, sent <UTC>
Source proof: <fetchWithdrawals or A withdrawal-history UI>, status <final success value>, checked <UTC>
Hash: <full on-chain hash from that source record>
Expected credit: C=<C_min>…<C_max> USDT, B deposit minimum <…> (<stated | assumed>)
```

1. Run Step 0 on B's server (in a two-profile session it already ran for the plan).
   Require the source proof above before advancing; an incomplete
   handoff is for read-only reconciliation. The alias must match the plan's route or the block's
   `B:` line; otherwise stop. The operator's mapping of that alias to B's account is trusted: no
   UID or other identity check.
2. A missing or unreadable field is re-established by a read (B's deposit history, or A's
   `fetchWithdrawals` in an A session), or by the operator reading it in the exchange UI.
   Never infer a missing value. Keep the pre-send A/B chain and token verification with
   its sources and times, which must precede the send. Recover lost evidence from the original chat or transaction-specific
   exchange or on-chain evidence. Today's coin listing alone cannot identify a past transfer.
3. Match one completed B deposit per 2.7: full hash, USDT, chain, receiving address, memo
   (exactly as recorded whenever the handoff supplies one), and unambiguous credit within the expected bounds. On Bybit the address
   may be in `addressTo` or `info.toAddress`. On OKX the record's `to` may read
   `<address>:<memo>` (the shape OKX uses for `toAddr`): split it at the last colon and compare both parts. For omitted receipt fields use evidence tied
   to this transaction (B's deposit details or its on-chain receipt on the verified chain).
   Bybit's deposit record omits the token contract: use the documented pre-send verification
   above. If the record supplies a contract it must agree. Missing evidence, conflicting
   values or multiple matching deposits hold the route.
4. Find where the credit sits. Start from the block's `Lands in` wallet, then the deposit
   wallet in the [account mode table](references/exchanges.md#account-mode-and-available-amount)
   (typical only: account settings can change it). Read that wallet's available field per
   2.1. A balance change only locates funds; the hash attributes them. If it is not clear
   which wallet holds the credit, the human checks B's UI.
5. If the block's `then` asks for a transfer, make a **new plan** with one `transfer`, its
   own PLAN-ID (`<PLAN-ID>-B`), a new expiry and its proof route (2.5). The A plan's approvals
   do not cover it. The transfer runs on B's **settlement registration**, never on the
   deposit-only profile, which keeps `dryRun: true` throughout (and whose key may be unable to
   transfer: Bybit refuses a `readOnly: 1` key with `10005`). Only the settlement
   registration has `dryRun` removed. The settlement registration must be a separate registration with role
   `settlement` in the setup record, show an internal-transfer right in
   its key check (a scheme D `<B>-settle` profile shares B's one key: report its rights as shown,
   since fundkit forwards no `withdraw` on it), and be the registration the setup record names for
   the same B account as the deposit-only profile (the operator's mapping; no UID is compared).
   Without such a registration, finish as credited and report that the transfer is held. If no onward transfer was requested, the route ends with the credit.
   Immediately before the plan, re-read B's deposit by the same hash (fresh credit: still one
   record, same amount and status) and the holding wallet's available field on the settlement
   registration. The amount is at most the attributed credit, that available field and the
   user's limit, and no more than the target needs. It must be a multiple of B's steps (2.3)
   and within the settlement registration's `maxTransferValue`. Then the human replies
   `APPROVE <PLAN-ID>-B` (a missing reply or another plan's ID holds), you check the expiry
   (2.5), and the human accepts the native form. A declined or expired form means nothing was
   sent. Prove the transfer by its ID per 2.7; the proof record must show USDT, the planned
   amount and both planned wallets. No funds in the holding wallet, a changed credit or any
   failed check: send nothing.

### 2.9 Manual withdrawal in exchange A's UI

Apply Step 0 to the source account before preparing a sheet. Use this path for a route that
holds on a fact no tool shows and the human cannot supply for an API plan (for example
WhiteBIT as source, whose available amount is not visible), a network outside the outbound API
table, a host or server without a native confirmation form, or a user-requested manual send.
B's recipient still comes from its native read, and B's deposit is still matched by hash.
A send to Bybit records the [Bybit inbound cap](references/recipients.md#bybit-inbound-cap). The human
selects the verified chain in A's UI. Keep the sheet in draft until A's preview gives the
exact debit, fee and amount sent to B; calculate the exact net credit after B's fee.
Check the UI step, limits, reserve, budget or target, and B's deposit minimum before sending.
For example, with 99 USDT entered, a 1 USDT fee on top and no deposit fee, the preview
must show debit 100 and receive 99. An unknown fee treatment or receive amount holds the sheet.

```text
WITHDRAWAL SHEET <PLAN-ID>, created <UTC>, expires <UTC + 15 min>
From: <A exchange> <wallet>; A's UI label <…> = chain <…>, contract <…>
Route evidence: A <source, observed chain/contract, UTC>; B <source, observed chain/contract, UTC>
To: <B exchange>, address <full address>, memo <none | exact memo> (from B's deposit page)
Memo requirement: <required | not required | no published flag>; evidence <source, UTC>
Enter: W=<…> (multiple of A's UI step, ≥ A's withdrawal minimum <…>)
Fee: f=<…> <asset>, model <on top | deducted>; exact debit D=<…>; exact receive amount on A's preview <…>
Expected on B: exact C=<…> USDT after deposit fee d=<…> <asset>, B deposit minimum <…> (<stated | assumed>)
User: limit <USDT> | target credit <USDT>
```

1. Follow [manual confirmation](#manual-confirmation) on A's withdrawal screen. Refresh B's
   deposit conditions and compare the full address, network and memo with B's page. Verify
   the exact debit, fee and receive amount before OPEN and before any submitting 2FA action.
2. Open the attributable withdrawal record in A's history (UI or `fetchWithdrawals`). Read
   its ID, displayed final status and full hash from that record. While pending, poll read-only.
3. Only on verified final success, continue in 2.8 with B's profile in this session, or copy the source proof and exact sheet into the HANDOFF (2.8) when there is none. B's side
   counts the deposit only by hash and the sheet's exact credit (set both bounds to `C`, 2.7).

## Scenario 3. funding ↔ trading/margin on one exchange

Same cycle: account mode → available amount and reserve → a plan with one `transfer`, an
expiry and a proof route (2.5) → `APPROVE <PLAN-ID>` → expiry check and recheck → call → ID
and success status (2.7). With no API or operator proof route, the transfer is manual in the
exchange UI. Take wallet names only from the [wallet table](references/exchanges.md#wallets-for-transfer).
On Gate and Bitget, `funding` is an alias of `spot`, so `funding → spot` is meaningless
there. On BingX, `future` is `stdFutures`, while USDT-M perpetual is `swap` or `linear`
(`USDTMPerp`).

## Scenario 4. Hyperliquid margin monitoring (watch-only)

The profile holds only a public `walletAddress`, with no keys and no `funds`/`trading`.
Margin fields appear **only** in `info`:

```text
call_read_method {"exchange":"hyperliquid","account":"hl-watch","method":"fetchBalance","includeInfo":true}
call_read_method {"exchange":"hyperliquid","account":"hl-watch","method":"fetchBalance","params":{"type":"spot"}}
get_positions {"account":"hl-watch"}
```

From `info`, report `marginSummary.accountValue`, `totalMarginUsed`,
`crossMaintenanceMarginUsed` and `withdrawable`; `get_balance` does not show them. If `info`
contains `balances` instead of `marginSummary`, the address runs in unified mode (ccxt then
reads spot state). Stop and say margin cannot be checked with this tool; do not derive it
from spot balances. Without a profile, read via
`call_read_method {"exchange":"hyperliquid","method":"fetchBalance","params":{"user":"0x…"},"includeInfo":true}`.

## Journal line in the chat

Before any potentially dispatching call or manual confirmation, put this record in the chat.
Use the approved arguments or the exact send sheet; omit secrets and confirmation tokens.

```text
OPEN <plan/step> | <journal path or manual wallet, exchange and account alias> | snapshot <UTC> | <exact arguments/sheet> | id/hash <known values or pending>
```

Keep it current on every response. Pending, missing, lost or ambiguous results keep the step
OPEN across chats, including when the server records an error and lists no unresolved intent.
Only reconcile read-only until the operator can establish the outcome under 2.7. Close the
record as DONE with attributable proof of completion, NOT SENT with proof of non-execution
under rule 5 (including a witnessed manual cancellation), or FAILED-RECONCILED with the failure and return evidence specified in 2.7.
For a deposit-address request use the verified address response. For `transfer` and
`withdraw`, an explicit `dryRun: true` result closes the step as NOT SENT. A completed step must never be sent again. Retain the latest record for Step 0; a crash
hold on the server journal still applies even after the exchange outcome is known.

Chat records depend on the operator carrying the latest state. They cannot lock parallel
chats or guarantee exactly-once execution if a record is lost or stale and the operator
mistakenly confirms there was no prior attempt. Example of a reconciliation entry:

```text
[<UTC>] <PLAN-ID> step <n> <tool|manual> <alias> → <ok|code> id=<…> status=<…> proof=<read | operator, <exchange> UI, <UTC>> txid=<…> D/W/C=<…>
```

## When to stop and ask

A required profile or tier is missing; the version is not `0.1.3` / `4.5.84`;
`configProblems` is not empty; a crash hold applies (`unresolvedIntents` not empty, or a hold
recorded for the journal path: reads only, permanently); more than one connected server or
alias has the keyed exchange in a scheme A launch; a Bybit key check or address read fails, or the gated and raw address reads
disagree ([Bybit deposit address](#bybit-deposit-address)), or any venue's recipient read
finds no unique eligible row or conflicting fields ([`recipients.md`](references/recipients.md));
a key check shows rights other than the profile's; a registration, `configPath`, `journal`,
or environment differs from the setup record, a money-moving server lacks the native form or
the setup record's interactive-form line, or the deposit-only profile reports `dryRun: false`;
the account mode, available amount, network flag, minimum, fee, chain, contract,
fee asset or amount step is unknown; an amount is not exactly representable; a transfer has
no proof route and is not done manually; the "exchange + network" pair is not in the outbound
withdraw table, or a gate in the destination or outbound table holds (missing minimum, fee or
contract; Bybit's finite release limit, also when it changes before dispatch; no whitelist
evidence equal character for character; an entity line that is missing, names an unknown or
regional entity, gives no valid or a listed jurisdiction, or says "required" or "unknown"; a
provisioning read without consent); a per-plan human-read fact that is stale, unsourced, not
restated at the recheck or disagrees with a documented value; any value
changed between the plan and the recheck before dispatch; a receipt on either venue with
another asset or chain; a settlement plan without its own approval, expiry, funds, fresh credit
or settlement registration for the same B account in the setup record; a TON address fails
its check; the full address, network or
memo differs anywhere; the preview, form or exchange confirmation screen does not match the
plan or sheet; the plan has expired; there was no explicit `APPROVE` or `WITHDRAW`; the
address is not on A's whitelist; a write's outcome is unknown, has no
attributable ID, or its status is failed, missing or ambiguous (pending is only polled); a
deposit's credit does not match the expected `C`; a HANDOFF field is missing and cannot be
re-established; Hyperliquid turned out to be a USDT source or recipient, or runs in unified
mode.
