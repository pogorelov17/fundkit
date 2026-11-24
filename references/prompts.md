# Copyable prompts

Paste one into a fresh Claude Code or Codex chat started from the repository root. The
read-only smoke checks make no writes: they call only `get_safety_status`, `list_accounts`,
key-metadata and address reads.

## Read-only smoke checks

```text
Read SKILL.md. Run Step 0 only: report version, configProblems, accounts, tiers and whether a native confirmation form is available. Do not plan anything.
```

```text
Read SKILL.md. For my OKX profile, run the key check and show the account UID and key permission scope. Read only, no plan.
```

```text
Read SKILL.md. Show my OKX USDT deposit address for TRC20 from my own account, with the raw-row check. Read only, no plan.
```

```text
Read SKILL.md. Show my Bybit USDT deposit address for BEP20 from my own account. Read only, no plan.
```

## Same prompts in Russian

```text
Прочитай SKILL.md. Выполни только Step 0: версия, configProblems, аккаунты, уровни доступа и есть ли нативная форма подтверждения. Ничего не планируй.
```

```text
Прочитай SKILL.md. Покажи мой адрес пополнения USDT на OKX в сети TRC20 из моего аккаунта, с проверкой сырой строки. Только чтение, без плана.
```

## Planning prompts

```text
Read SKILL.md. I want to top up OKX with 150 USDT from OKX Wallet on TRC20. Prepare the send sheet; I will paste and sign in the wallet.
```

```text
Прочитай SKILL.md. Хочу пополнить Bybit на 150 USDT из OKX Wallet. Подготовь лист отправки, я вставлю и подпишу в кошельке.
```
