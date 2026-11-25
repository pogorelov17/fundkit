# Copyable prompts

Paste one into a fresh Claude Code or Codex chat started from the repository root. Replace the
parts in angle brackets. Each English prompt has a Russian twin below that asks for the same
thing.

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
Read SKILL.md. Here is my setup record: <setup record>. Run Step 0 and the key checks and compare every field with the record: registration, alias, environment, configPath, journal (money-moving profiles must not run as your OS user), UID, role, provisioning consent, whitelist entries (read them from the exchange where a read exists), Binance entity, BingX jurisdiction. Report each difference. Read only, no plan.
```

```text
Read SKILL.md. I see no ccxt-mcp tools in this chat. Explain what I have to install and register for a two-profile session with <exchange A> as source and <exchange B> as destination (plus a settlement registration if B must move the credit), which credential fields go into each profile's config.json, which OS user each server runs as, and which key rights each key needs.
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
Read SKILL.md. Both accounts are connected: <A alias> is the source and <B alias> the destination<, and <B settlement alias> settles on B>. Setup record: <setup record>. Operation record: <operation record>. <amount> USDT must arrive on <exchange B>; keep a <reserve> USDT reserve on <exchange A>. Prepare everything and give me the plan to approve, or name the exact gate that holds. After the withdrawal, match the deposit on B<, then plan the transfer into <B wallet> on the settlement registration>.
```

```text
Read SKILL.md. Operation record: <operation record>. The last withdrawal from <A alias> has an unknown outcome. Reconcile it read-only on both accounts without repeating anything, and tell me what is proven.
```

## Same prompts in Russian

Keep the approval keywords (`APPROVE`, `WITHDRAW`) in English. `<setup record>` and
`<запись операции>` mean the same as above.

```text
Прочитай SKILL.md. Проверь мою настройку для <биржа>: какие серверы ccxt-mcp и аккаунты ты видишь, версии, configPath, journal, configProblems, уровни доступа и есть ли нативная форма подтверждения. Если чего-то не хватает, скажи точно, что настроить, не спрашивая ключей. Ничего не планируй.
```

```text
Прочитай SKILL.md. Выполни Step 0 и проверку ключа для каждого подключённого профиля. Для каждого алиаса покажи регистрацию, окружение, configPath, journal, UID аккаунта, права ключа, привязку к IP и подходит ли он своей роли (только пополнение, перевод на B или источник). Затем перечисли, какие строки setup record мне ещё нужно записать. Только чтение, без плана.
```

```text
Прочитай SKILL.md. Вот мой setup record: <setup record>. Выполни Step 0 и проверки ключей и сравни каждое поле с записью: регистрация, алиас, окружение, configPath, journal (профили с движением денег не должны работать от твоего пользователя ОС), UID, роль, согласие на provisioning, записи белого списка (прочитай их на бирже, где такое чтение есть), entity Binance, юрисдикция BingX. Покажи каждое расхождение. Только чтение, без плана.
```

```text
Прочитай SKILL.md. В этом чате нет инструментов ccxt-mcp. Объясни, что установить и зарегистрировать для сессии с двумя профилями: <биржа A> источник, <биржа B> получатель (и регистрация для перевода на B, если зачисление нужно перенести); какие поля учётных данных идут в config.json каждого профиля, от какого пользователя ОС работает каждый сервер и какие права нужны каждому ключу.
```

```text
Прочитай SKILL.md. Покажи мой адрес пополнения USDT на <биржа> в сети <TRC20 | BEP20 | ERC20 | TON> из моего аккаунта, с проверкой сырой строки, проверкой адреса, мемо (или его отсутствием), кошельком зачисления и UID аккаунта. Только чтение, без плана.
```

```text
Прочитай SKILL.md. Для моего профиля <биржа> перечисли сети USDT: пополнение включено, минимум, контракт, нужен ли мемо и комиссия за пополнение, с источником каждого значения, и скажи, какие сети задержаны и почему. Только чтение, без плана.
```

```text
Прочитай SKILL.md. Setup record: <setup record>. Запись операции: <запись операции>. Хочу пополнить <биржа> на <сумма> USDT из OKX Wallet. USDT у меня в сетях <сети>. Выбери сеть, прочитай адрес и мемо из моего аккаунта и подготовь лист отправки или назови точный шлюз, который его задерживает. Я вставлю его в OKX Wallet и подпишу.
```

```text
Прочитай SKILL.md. Оба аккаунта подключены: <алиас A> источник, <алиас B> получатель<, а <алиас перевода на B> делает перевод на B>. Setup record: <setup record>. Запись операции: <запись операции>. На <биржа B> должно прийти <сумма> USDT, на <биржа A> оставь резерв <резерв> USDT. Подготовь всё и дай план на утверждение или назови точный шлюз, который держит маршрут. После вывода сверь зачисление на B<, затем подготовь план перевода в <кошелёк B> через регистрацию для перевода>.
```

```text
Прочитай SKILL.md. Запись операции: <запись операции>. Результат последнего вывода с <алиас A> неизвестен. Сверь его только чтением на обоих аккаунтах, ничего не повторяя, и скажи, что доказано.
```
