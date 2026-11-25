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
  aliases, UIDs, key rights, network data, recipients, whitelist rows where a venue has a read,
  and history. It asks only for a fact that neither a tool nor the setup record supplies, and
  names that fact. It does not promise a route without questions when such a fact is missing.

## Setup and diagnosis

Use these first, on a host where nothing has worked yet.

```text
Read SKILL.md. Check my setup for <exchange>: which ccxt-mcp servers and accounts you see, the versions, configPath, journal, configProblems, tiers and whether a native confirmation form is available. If something is missing, tell me exactly what to set up, without asking for any key. Do not plan anything.
```

```text
Read SKILL.md. Run Step 0 and the key check for every connected profile. For each alias report the registration, environment, configPath, journal, account UID, the key's permissions and IP binding, and whether it fits its role (deposit-only, settlement or source). Then list which lines of a setup record I still need to write. Read only, no plan.
```

```text
Read SKILL.md. Here is my setup record: <setup record>. Run Step 0 and the key checks and compare every field with the record: registration, alias, environment, configPath, journal, UID, role, provisioning consent, whitelist entries (read them from the exchange where a read exists), Binance entity and travel-rule line, BingX jurisdiction, WhiteBIT entity and pinned contracts. Report each difference. Read only, no plan.
```

```text
Read SKILL.md. I see no ccxt-mcp tools in this chat. Explain what I have to install and register for a two-profile session with <exchange A> as source and <exchange B> as destination (plus a settlement registration if B must move the credit), which credential fields go into each profile's config.json, which setup-record lines each money-moving registration needs, and which key rights each key needs.
```

## Read-only checks

```text
Read SKILL.md. Show my <exchange> USDT deposit address for <TRC20 | BEP20 | ERC20 | TON> from my own account, with the venue's raw-row check, the address check, the memo (or none), the landing wallet and the account UID. Read only, no plan.
```

```text
Read SKILL.md. For my <exchange> profile, list the USDT networks with deposit enabled, minimum, contract, memo requirement and deposit fee, with the source of each value, and say which networks hold and why. Read only, no plan.
```

## Planning

```text
Read SKILL.md. Setup record: <setup record>. Operation record: <operation record>. I want to top up <exchange> with <amount> USDT from OKX Wallet. I hold USDT on <networks>. Pick the network, read the address and memo from my account, and prepare the send sheet, or name the exact gate that holds. I will paste it into OKX Wallet and sign.
```

```text
Read SKILL.md. Both accounts are connected: <A alias> is the source and <B alias> the destination<, and <B settlement alias> settles on B>. Setup record: <setup record>. Operation record: <operation record>. <amount> USDT must arrive on <exchange B>; keep a <reserve> USDT reserve on <exchange A>. Prepare everything and give me the plan to approve, or name the exact gate that holds. After the withdrawal, match the deposit on B<, then give me a separate plan for the transfer into <B wallet> on the settlement registration>.
```

```text
Read SKILL.md. Operation record: <operation record>. The last withdrawal from <A alias> has an unknown outcome. Reconcile it read-only on both accounts without repeating anything, and tell me what is proven.
```
