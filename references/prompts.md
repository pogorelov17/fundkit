# Copyable prompts

Paste one into a fresh Claude Code or Codex chat started from the repository root. Replace the
parts in angle brackets. You may write the request in any language; the agent replies in the
user's language and keeps the approval keywords (`APPROVE`, `WITHDRAW`) in English.

- Read-only prompts make no writes. They call only `get_safety_status`, `list_accounts`, key
  checks, network data and recipient reads ([`recipients.md`](recipients.md)). On Gate and
  WhiteBIT the recipient read may create a deposit address, so it runs only if your setup record
  allows provisioning.
- Prompts that end in a send stop at the plan or sheet. Plan approval and the native form are
  two separate steps. You approve the plan in the chat with the keywords from
  [`SKILL.md`](../SKILL.md#hard-rules) (`APPROVE <PLAN-ID>`, and `WITHDRAW <PLAN-ID>` for a
  withdrawal). Then you confirm each money move in the host's native form, or sign in the wallet.
- `<setup record>` is your [setup record](security.md#setup-record) (no secrets in it).
  `<operation record>` is the latest operation record (Step 0), or "first use, no prior attempt".
  The agent reads everything a tool can show by itself: versions, `configPath`, `journal`,
  aliases, key rights, network data, recipients, whitelist rows where a venue has a read,
  and history. It asks only for a fact that neither a tool nor the setup record supplies, and
  names that fact. It does not promise a route without questions when such a fact is missing.
- After the one-time setup, a route's per-plan human part is `APPROVE`, `WITHDRAW` and the
  native forms. Where B publishes no deposit minimum (Binance, MEXC, multi-chain Gate), the
  agent uses Fundkit's [operator fallback](deposit-minimum-fallback.md) of 1 unit and says it is
  not the exchange's figure; you may instead add B's own minimum from its deposit page. Where
  B's deposit fee has no documented source (KuCoin), you may add it. Either value is a
  [per-plan human-read fact](../SKILL.md#per-plan-human-read-facts) with its read time, and the
  agent asks you to read it again just before the withdrawal.

## Native requests (fundkit server connected; T3 Code first)

Ask in your own words; the agent needs nothing else from you except, once per session, the
token in T3's private card.

```text
Show my Binance USDT deposit address on BSC.
Give me my Bybit USDT deposit address on TRC20.
Move 300 USDT from Bybit to Binance.
Move 15 USDT from Binance to Bybit on BSC.
What happened to transfer FK-XXXXXXXX?
```

## Natural request (fundkit installed)

After `fundkit install` ([scheme D](security.md#scheme-d-session-only-doppler-profiles-optional))
a fresh Claude Code or Codex session needs no `Read SKILL.md` line and no aliases. Just ask:

```text
move 300 USDT from OKX to Bybit
```

The agent uses connected profiles first. If OKX (source) or Bybit (deposit-only) is missing, it
asks you to run `fundkit session` in a second terminal on that machine and paste a read-only
Doppler service token there (hidden), then connects `okx-src` and `bybit-dst` itself. The
Doppler config needs only `OKX_APIKEY`, `OKX_SECRET`, `BYBIT_APIKEY` and `BYBIT_SECRET`.
OKX also needs its API passphrase: the agent tells you, in your language, to type it in that
second terminal, which is already asking for it, for example:

```text
OKX needs its API passphrase. Switch to the terminal running `fundkit session`: it now shows the prompt `OKX API passphrase (for the key in OKX_APIKEY):`. Type it there (the input is hidden), not in this chat, and then reply "done".
```

You type it there once per session, reply `done` (in any language), and the agent continues. It runs Step 0 and
the key checks, asks for the operation record, and stops at the plan. The reverse route
(`move 200 USDT from Bybit to OKX`) in the same session uses the same two keys in the other
roles (`bybit-src`, `okx-dst`) and asks for nothing new. If the host does not pick the skill by
itself, start with `/usdt-funding` (Claude Code), `$usdt-funding` (Codex) or `Read SKILL.md` and
the same sentence.

One terminal instead of two: `fundkit session --passphrase okx -- claude` asks for the token and
the OKX passphrase first, then starts Claude Code there. If a passphrase is needed later in that
setup, the agent asks you to run `fundkit passphrase <exchange>` in another terminal on the
machine.

## Read-only starting prompt

The first session after the [one-session read-only start](security.md#one-session-read-only-start-bybit-or-bybit-plus-bingx).
Nothing can move: only deposit-only profiles are connected, and they keep `"dryRun": true`.

Bybit only:

```text
Read SKILL.md. This is my first session and it is read only. Check the Bybit profile: versions, configPath, journal, configProblems and whether a native form is available, then the Bybit key check (main account; report readOnly, permissions and IP binding as shown; no UID). Then list Bybit's USDT networks with deposit enabled, minimum, contract, memo requirement and deposit fee with their sources, and show my verified Bybit USDT deposit address for TRC20, BEP20, ERC20 and TON with the raw-row check, the address check, the memo (or none) and batchReleaseLimit. Finish with the setup-record lines I should write from this, and the ones still missing for a withdrawal later. No plan, no writes.
```

Bybit and BingX in one session (alternative):

```text
Read SKILL.md. This is my first session and it is read only. Two deposit-only profiles are connected: Bybit and BingX. For each: Step 0 (versions, configPath, journal, configProblems, dryRun, native form), the key check with the key's rights and IP binding (BingX: report the numeric permission codes so I can record what they mean), the USDT networks with deposit enabled, the deposit minimum (BingX: the chosen network's depositMin), contract, memo requirement and deposit fee with their sources, and my verified USDT deposit address and memo per network. Then tell me which setup-record lines to write from this and which facts a later withdrawal between the two would still need (whitelist entry, entity line, interactive-form line, source and settlement registrations). No plan, no writes.
```

## Setup and diagnosis

Use these first, on a host where nothing has worked yet.

```text
Read SKILL.md. Check my setup for <exchange>: which ccxt-mcp servers and accounts you see, the versions, configPath, journal, configProblems, tiers and whether a native confirmation form is available. If something is missing, tell me exactly what to set up, without asking for any key. Do not plan anything.
```

```text
Read SKILL.md. Run Step 0 and the key check for every connected profile. For each alias report the registration, environment, configPath, journal, the key's permissions and IP binding, and whether it fits its role (deposit-only, settlement or source). Then list which lines of a setup record I still need to write. Read only, no plan.
```

```text
Read SKILL.md. Here is my setup record: <setup record>. Run Step 0 and the key checks and compare every field with the record: registration, alias, environment, configPath, journal, role, provisioning consent, whitelist entries character for character (read them from the exchange where a read exists), key-rights lines where no read shows them (Gate, MEXC, WhiteBIT), entity lines (Binance, Bybit, OKX, BingX, WhiteBIT) under the one entity rule, the interactive-form line and WhiteBIT pinned contracts. Report each difference. Read only, no plan.
```

```text
Read SKILL.md. I see no ccxt-mcp tools in this chat. Explain what I have to install and register for a two-profile session with <exchange A> as source and <exchange B> as destination (plus a settlement registration if B must move the credit), which credential fields go into each profile's config.json, which setup-record lines each money-moving registration needs, and which key rights each key needs.
```

## Read-only checks

```text
Read SKILL.md. Show my <exchange> USDT deposit address for <TRC20 | BEP20 | ERC20 | TON> from my own account, with the venue's raw-row check, the address check, the memo (or none) and the landing wallet. Read only, no plan.
```

```text
Read SKILL.md. For my <exchange> profile, list the USDT networks with deposit enabled, minimum, contract, memo requirement and deposit fee, with the source of each value, and say which networks hold and why. Read only, no plan.
```

## Planning

```text
Read SKILL.md. Setup record: <setup record>. Operation record: <operation record>. I want to top up <exchange> with <amount> USDT from OKX Wallet. I hold USDT on <networks>. Pick the network, read the address and memo from my account, and prepare the send sheet, or name the exact gate that holds. I will paste it into OKX Wallet and sign.
```

```text
Read SKILL.md. Both accounts are connected: <A alias> is the source and <B alias> the destination<, and <B settlement alias> settles on B>. Setup record: <setup record>. Operation record: <operation record>. <amount> USDT must arrive on <exchange B>; keep a <reserve> USDT reserve on <exchange A>.< B's deposit minimum from its deposit page: <value>, read <UTC>.> Prepare everything and give me the plan to approve, with what it relies on (common setup, venue-specific setup, per-plan facts), or name the exact gate that holds. After the withdrawal, match the deposit on B<, then give me a separate plan for the transfer into <B wallet> on the settlement registration>.
```

```text
Read SKILL.md. Operation record: <operation record>. The last withdrawal from <A alias> has an unknown outcome. Reconcile it read-only on both accounts without repeating anything, and tell me what is proven.
```
