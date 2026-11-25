# Copyable prompts

Paste one into a fresh Claude Code or Codex chat started from the repository root. Replace the
parts in angle brackets. Read-only prompts make no writes: they call only `get_safety_status`,
`list_accounts`, key checks, network data and recipient reads
([`recipients.md`](recipients.md)). On Gate and WhiteBIT the recipient read may create a
deposit address, so it runs only if your setup record allows provisioning. Prompts that end in a
send stop at the plan or sheet: the user still approves with the keywords from
[`SKILL.md`](../SKILL.md#hard-rules) and confirms every money move in the native form, or signs
in the wallet. Where a prompt says `<setup record>`, paste your
[setup record](security.md#setup-record) (no secrets in it).

## Setup and diagnosis

Use these first, on a host where nothing has worked yet.

```text
Read SKILL.md. Check my setup for <exchange>: which ccxt-mcp servers and accounts you see, the versions, configProblems, tiers and whether a native confirmation form is available. If something is missing, tell me exactly what to set up, without asking for any key. Do not plan anything.
```

```text
Read SKILL.md. Run Step 0 and the key check for every connected profile. For each alias report the registration, environment, configPath, journal, account UID, the key's permissions and IP binding, and whether it fits its role (deposit-only, settlement or source). Then list which lines of a setup record I still need to write. Read only, no plan.
```

```text
Read SKILL.md. Here is my setup record: <setup record>. Run Step 0 and the key checks and compare every field with the record: registration, alias, environment, configPath, journal (money-moving profiles must not run as your OS user), UID, role, provisioning consent, whitelist entries, Binance entity, BingX jurisdiction. Report each difference. Read only, no plan.
```

```text
Read SKILL.md. I see no ccxt-mcp tools in this chat. Explain what I have to install and register for a two-profile session with <exchange A> as source and <exchange B> as destination, which credential fields go into each profile's config.json, and which key rights each key needs.
```

## Read-only smoke checks

```text
Read SKILL.md. Show my <exchange> USDT deposit address for <TRC20 | BEP20 | ERC20 | TON> from my own account, with the venue's raw-row check, the memo (or none), the landing wallet and the account UID. Read only, no plan.
```

```text
Read SKILL.md. For my <exchange> profile, list the USDT networks with deposit enabled, minimum, contract, memo requirement and deposit fee, with the source of each value. Read only, no plan.
```

## Planning

```text
Read SKILL.md. I want to top up <exchange> with <amount> USDT from OKX Wallet. I hold USDT on <networks>. Pick the network, read the address and memo from my account, and prepare the send sheet. I will paste it into OKX Wallet and sign.
```

```text
Read SKILL.md. Both accounts are connected: <A alias> is the source and <B alias> the destination. Setup record: <setup record>. Latest operation record: <record or "first use, no prior attempt">. <amount> USDT must arrive on <exchange B>; keep a <reserve> USDT reserve on <exchange A>. Prepare everything and give me the plan to approve, or name the exact gate that holds. After the withdrawal, match the deposit on B and settle it into <B wallet>.
```

```text
Read SKILL.md. The last withdrawal from <A alias> has an unknown outcome. Reconcile it read-only on both accounts without repeating anything, and tell me what is proven.
```

## Same prompts in Russian

Keep the approval keywords (`APPROVE`, `WITHDRAW`) in English.

```text
Прочитай SKILL.md. Проверь мою настройку для <биржа>: какие серверы ccxt-mcp и аккаунты ты видишь, версии, configProblems, уровни доступа и есть ли нативная форма подтверждения. Если чего-то не хватает, скажи точно, что настроить, не спрашивая ключей. Ничего не планируй.
```

```text
Прочитай SKILL.md. Выполни Step 0 и проверку ключа для каждого подключённого профиля. Для каждого алиаса покажи регистрацию, окружение, configPath, journal, UID аккаунта, права ключа, привязку к IP и подходит ли он своей роли (только пополнение, перевод на B или источник). Затем перечисли, какие строки setup record мне ещё нужно записать. Только чтение, без плана.
```

```text
Прочитай SKILL.md. Вот мой setup record: <setup record>. Выполни Step 0 и проверки ключей и сравни каждое поле с записью: регистрация, алиас, окружение, configPath, journal (профили с движением денег не должны работать от твоего пользователя ОС), UID, роль, согласие на provisioning, записи белого списка, entity Binance, юрисдикция BingX. Покажи каждое расхождение. Только чтение, без плана.
```

```text
Прочитай SKILL.md. В этом чате нет инструментов ccxt-mcp. Объясни, что установить и зарегистрировать для сессии с двумя профилями: <биржа A> источник, <биржа B> получатель; какие поля учётных данных идут в config.json каждого профиля и какие права нужны каждому ключу.
```

```text
Прочитай SKILL.md. Покажи мой адрес пополнения USDT на <биржа> в сети <TRC20 | BEP20 | ERC20 | TON> из моего аккаунта, с проверкой сырой строки, мемо (или его отсутствием), кошельком зачисления и UID аккаунта. Только чтение, без плана.
```

```text
Прочитай SKILL.md. Хочу пополнить <биржа> на <сумма> USDT из OKX Wallet. USDT у меня в сетях <сети>. Выбери сеть, прочитай адрес и мемо из моего аккаунта и подготовь лист отправки. Я вставлю его в OKX Wallet и подпишу.
```

Prepared accounts (both profiles already connected and checked):

```text
Прочитай SKILL.md. Оба аккаунта подключены: <алиас A> источник, <алиас B> получатель. Setup record: <setup record>. Последняя запись операции: <запись или «первый запуск, попыток не было»>. На <биржа B> должно прийти <сумма> USDT, на <биржа A> оставь резерв <резерв> USDT. Подготовь всё сам и дай план на утверждение или назови точный шлюз, который держит маршрут. После вывода сверь зачисление на B и переведи его в <кошелёк B>.
```

```text
Прочитай SKILL.md. Профиль <алиас B> уже настроен. Прочитай адрес и мемо USDT в сети <сеть>, комиссию и минимум пополнения, и рассчитай, сколько придёт при отправке <сумма> USDT из OKX Wallet. Только чтение, без плана.
```

```text
Прочитай SKILL.md. Результат последнего вывода с <алиас A> неизвестен. Сверь его только чтением на обоих аккаунтах, ничего не повторяя, и скажи, что доказано.
```
