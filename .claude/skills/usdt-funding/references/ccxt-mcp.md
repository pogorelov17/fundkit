# ccxt-mcp 0.1.3: пин, инструменты, гейты, проверки

Всё ниже проверено на опубликованном `ccxt-mcp@0.1.3` (исходник `js/`) и в живом прогоне
по stdio. Подробности прогона — в разделе «Проверено».

## Пин

| Что | Значение |
|---|---|
| npm | `ccxt-mcp@0.1.3` (опубликованы 0.1.0, 0.1.2, 0.1.3) |
| integrity / sha1 | `sha512-XGU7T/lXphackbxtukik6te2LfxuQsFUxshCUAXkaKnOKQFlwFJkaPjpZLZT/dSeScA6Wq2ipMhGhE2uxvrbqg==` / `b583b93e9fcecb6cc0700b48863dc7cbcb6ed99b` |
| provenance | SLSA v1, `github.com/ccxt/ccxt`, `.github/workflows/mcp-release.yml`, gitHead `e0eaca51b25377491120ce9ca2943c71800d0d44` |
| зависимости пакета | `@modelcontextprotocol/sdk ^1.29.0`, `ccxt ^4.5.75`, `zod ^3.25.76` — это диапазоны, их нужно закрепить отдельно |
| закрепляем | `ccxt@4.5.94`, `@modelcontextprotocol/sdk@1.32.2`, `zod@3.25.76` |
| версия в `get_safety_status` | `version: "0.1.3"`, `ccxtVersion: "4.5.93"` — внутренняя строка ccxt 4.5.94 |

Установка в отдельный каталог оператора (не `npx -y`: он каждый раз берёт `latest`):

```bash
npm view ccxt-mcp@0.1.3 dist.integrity gitHead
npm --prefix <APP_DIR> install --save-exact --ignore-scripts \
  ccxt-mcp@0.1.3 ccxt@4.5.94 @modelcontextprotocol/sdk@1.32.2 zod@3.25.76
npm --prefix <APP_DIR> ls ccxt            # одна копия ccxt@4.5.94 (deduped)
npm --prefix <APP_DIR> audit signatures   # проверка подписей и attestations
```

## Инструменты (32; с `hideDisabledTools: true` видны только доступные тиры)

| Тир | Инструменты |
|---|---|
| market | `list_exchanges`, `describe_exchange`, `describe_method`, `search_markets`, `get_tickers`, `get_orderbook`, `get_ohlcv`, `get_trades`, `search_events`, `call_read_method`, `call_implicit_get`, `get_safety_status`, `watch_*` (4) |
| read | `list_accounts`, `get_balance`, `get_orders`, `get_my_trades`, `get_positions` |
| trading (запись) | `create_order`, `edit_order`, `cancel_order`, `cancel_all_orders`, `set_leverage`, `set_margin_mode`, `call_write_method` |
| funds (запись) | `transfer`, `withdraw`, `get_deposit_address` |
| implicitWrites (запись) | `call_implicit_write` |

Схемы (из `tools/list`, обязательные поля **жирным**):

- `call_read_method {`**`exchange`**`, `**`method`**` ^(fetch|load), args?, account?, includeInfo?, marketType?, prediction?, params?}`.
  Если указан `account`, используется биржа аккаунта, но `exchange` всё равно обязателен.
  `args` принимает только скаляры и `null`.
- `call_implicit_get {`**`exchange`**`, `**`method`**`, account?, params?}`.
- `get_balance {`**`account`**`, nonzeroOnly?, marketType?, params?}` — `includeInfo` нет,
  поэтому raw-поля читай через `call_read_method fetchBalance`.
- `transfer {`**`account, code, amount>0, fromAccount, toAccount`**`, params?, confirm?}`.
- `withdraw {`**`account, code, amount>0, address`**`, tag?, network?, params?, confirm?}`.
  Сервер кладёт `network` в `params.network`, а ccxt затем объединяет `params` с запросом, так
  что лишний ключ в `params` (например, `chain`) переопределит сеть. WhiteBIT передаёт
  `network` на биржу без перевода в свой код.
- `get_deposit_address {`**`account, code`**`, network?, params?}` — без `confirm`. Если
  `fetchDepositAddress` не сработал, сервер вызывает `createDepositAddress`.

## Гейты и подтверждение

- Тиры включаются **только** в конфиге оператора. `funds: true` и `trading: true` работают
  лишь в `sandbox`/`demo`; на live сервер понижает их и пишет `configProblems`. Для
  `funds: "live"` нужен `maxTransferValue` (USD), при превышении — `TRANSFER_VALUE_CAP`.
- Адресные методы (`/deposit.?address|withdraw.?address|withdrawal.?whitelist/i`) требуют
  `funds` везде.
- `withdraw`, `transfer` и `call_implicit_write` всегда требуют подтверждения, если
  `confirm` ≠ `"never"`.
  - **Хост с elicitation.** Первый же вызов показывает форму. В ней текст preview и одно поле
    `confirm: boolean`; `params` не показаны. На `accept` с `true` запись **сразу**
    отправляется, на `decline` приходит `CONFIRM_DECLINED`. Если форма не открылась —
    `CONFIRM_UNAVAILABLE`; в режим токена сервер при этом не переходит.
  - **Хост без elicitation.** Возвращается preview и `confirmToken`: UUID, HMAC от точного
    payload вместе с `params`, одноразовый, живёт 60 с. Ошибки погашения —
    `CONFIRM_INVALID`, `CONFIRM_EXPIRED`, `CONFIRM_MISMATCH`. Токен может погасить и модель.
- Порядок проверок: гейт тира → лимиты → подтверждение → `dryRun` → `intent` (fsync) → вызов
  биржи → `result` или `error`. Всё, что отвергнуто до `intent`, гарантированно не отправлено.
- `UNKNOWN_OUTCOME` приходит, когда после отправки случился таймаут или сетевая ошибка. Его
  подсказка ссылается на `get_orders`; для переводов и выводов вместо этого сверяйся через
  `fetchTransfers`, `fetchWithdrawals`, `fetchDeposits` и балансы.

## Журнал

- Путь: `$XDG_CACHE_HOME/ccxt-mcp/journal/YYYY-MM.jsonl`, по умолчанию
  `~/.cache/ccxt-mcp/journal/YYYY-MM.jsonl` пользователя, под которым работает сервер.
  **Журнал общий** для всех профилей этого пользователя.
- Дневной лимит (`maxDailyValue`) и intents привязаны к **алиасу**. Поэтому алиасы должны быть
  уникальны среди всех профилей, иначе лимиты и записи смешаются.
- `unresolvedIntents` — это intents без `result` или `error`, то есть только оборванные падением
  процесса, причём на всех алиасах. `UNKNOWN_OUTCOME` и таймаут хоста туда не попадают.

## Ограничения

- `dryRun: true` соблюдают только `withdraw`, `transfer`, `create_order` и `edit_order`.
  `get_deposit_address` на dryRun-аккаунте отправил настоящий подписанный запрос (в тесте его
  остановил guard). dryRun-ответ — локальный preview, биржа не проверяет ни баланс, ни
  кошельки, ни минимумы.
- Ответ больше 80 000 символов: массив обрезается, а объект (например, `fetchCurrencies`)
  целиком заменяется на `{"truncated":true,…}`.
- `call_implicit_get` и `call_implicit_write` с ccxt 4.5.94 неприменимы. Raw-эндпоинты в ccxt
  стали собственными свойствами в snake_case, а camelCase-версии лежат в прототипе. Проверка
  `isImplicitMethod` (собственное свойство + camelCase-глагол) отвергает обе формы с
  `UNKNOWN_ENDPOINT`, а `describe_method {"query":"…"}` возвращает `implicit: []`.
- `describe_method withdraw` модель комиссии не показывает (`paramsKeys: null`).
- Переменные `<EXCHANGEID>_<CREDENTIAL>` заполняют **все** аккаунты этой биржи в процессе,
  поэтому на один сервер — один аккаунт ([`security.md`](security.md)).
- В README: «Unregistered tiers do not even appear» верно только при `hideDisabledTools: true`.
  `mcp/server.json` на gitHead 0.1.3 указывает версию 0.1.2.

## Проверено (2026-11-24, scratch, без ключей, без live-записей)

Окружение: изолированные `HOME`/`XDG_*` и синтетические значения `SYNTHETIC-…`. Сеть
ограничивал guard (preload `undici`), который до сокета блокирует любой подписанный запрос
и любой не-GET, кроме публичного `POST /info` Hyperliquid. Ни один подписанный запрос из
процесса не ушёл.

| Проверка | Результат |
|---|---|
| установка пина, `npm ls`, `audit signatures` | одна копия `ccxt@4.5.94`; 24 пакета с подтверждёнными attestations |
| `tools/list` (SDK 1.32.2) | 32 инструмента; у `call_read_method` обязательны `["exchange","method"]` |
| `call_read_method` без `exchange` | `-32602 … Required at exchange` |
| `get_safety_status` | `0.1.3` / `ccxtVersion 4.5.93`; без elicitation `false`, с elicitation `true` |
| `withdraw` без `confirm` (sandbox, dryRun) | preview + токен 60 с; preview с `params.chain` совпадает с preview без него |
| погашение токена | другой `params` → `CONFIRM_MISMATCH`; повтор → `CONFIRM_INVALID`; через 61,5 с → `CONFIRM_EXPIRED`; идентичный → `dryRun: true` |
| лимит | 100 > 50 → `TRANSFER_VALUE_CAP`, запись `rejected` |
| отправка в обход dryRun (подпись блокирует guard) | `UNKNOWN_OUTCOME`; журнал `intent` + `error`; `unresolvedIntents: []` |
| elicitation: `decline` / `accept` при первом вызове | `CONFIRM_DECLINED` / запись сразу отправлена (`UNKNOWN_OUTCOME` от guard); в схеме формы только `confirm: boolean` |
| таймаут хоста 3 с при зависшей отправке, затем kill | клиент получает `-32001 Request timed out`; профиль с другим алиасом на том же кэше видит intent убитого профиля |
| `get_deposit_address` на dryRun-аккаунте | ушёл бы подписанный `GET /api/v5/asset/deposit-address` (заблокирован) |
| публично `fetchCurrencies` | Bitget, WhiteBIT, KuCoin, Gate → маркер усечения; Binance, Bybit, OKX, MEXC, BingX → `{}` |
| публично `fetchDepositWithdrawFee USDT includeInfo` | Bitget и WhiteBIT: флаги, минимумы, комиссии в `info`; BingX пусто; остальные `AUTH_FAILED` |
| `call_implicit_get` (`publicGetTime` и др.) | `UNKNOWN_ENDPOINT` для camelCase и snake_case |
| Hyperliquid `fetchBalance` | `info.marginSummary`, `crossMaintenanceMarginUsed`, `withdrawable` есть только с `includeInfo` |
| хосты | Claude Code 2.1.331 и Codex 0.172.0 находят навык и подключают сервер без секретов в конфиге, оба объявляют `elicitation.form` ([`security.md`](security.md)) |

Не проверено (нет ключей по условию): реальные аккаунты, режимы, поля доступной суммы,
модели комиссий, whitelist, фактические выводы и депозиты.
