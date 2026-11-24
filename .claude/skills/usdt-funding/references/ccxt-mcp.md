# ccxt-mcp 0.1.3: пин, инструменты, гейты, проверки

Всё ниже проверено на опубликованном `ccxt-mcp@0.1.3` (исходник `js/`) с `ccxt@4.5.85` и в
прогоне по stdio. Подробности — в разделе «Проверено».

## Пин

| Что | Значение |
|---|---|
| npm | `ccxt-mcp@0.1.3` (опубликованы 0.1.0, 0.1.2, 0.1.3) |
| integrity / sha1 | `sha512-XGU7T/lXphackbxtukik6te2LfxuQsFUxshCUAXkaKnOKQFlwFJkaPjpZLZT/dSeScA6Wq2ipMhGhE2uxvrbqg==` / `b583b93e9fcecb6cc0700b48863dc7cbcb6ed99b` |
| provenance | SLSA v1, `github.com/ccxt/ccxt`, `.github/workflows/mcp-release.yml`, gitHead `e0eaca51b25377491120ce9ca2943c71800d0d44` (в монорепо на нём ccxt 4.5.77) |
| зависимости пакета | `@modelcontextprotocol/sdk ^1.29.0`, `ccxt ^4.5.75`, `zod ^3.25.76` — это диапазоны, их нужно закрепить отдельно |
| закрепляем | `ccxt@4.5.85`, `@modelcontextprotocol/sdk@1.32.2`, `zod@3.25.76` |
| версия в `get_safety_status` | `version: "0.1.3"`, `ccxtVersion: "4.5.84"` — внутренняя строка ccxt 4.5.85 |

**Почему 4.5.85.** ccxt-mcp 0.1.3 вызывает `exchange.withdraw(code, amount, address, tag, params)`.
В ccxt 4.5.87 коммит `edcbd16` («drop withdraw tag argument») убрал `tag`, и с 4.5.87 по 4.5.94
сигнатура стала `withdraw(code, amount, address, params)`. Тогда `tag` попадает на место
`params`, а настоящие `params` с `network` и `fee` отбрасываются. С 4.5.94 запрос OKX ушёл без
цепочки и без `fee`, запросы Bybit и Gate — без цепочки, а memo `"123456"` у KuCoin превратился в
`{"0":"1",…,"5":"6"}` (проверено). 4.5.85 — последняя версия со старой сигнатурой (4.5.86 в npm
нет). Диапазон `^4.5.75` сам по себе ставит новейшую, поэтому пин обязателен.

Установка в отдельный каталог оператора (не `npx -y`: он каждый раз берёт `latest`):

```bash
npm view ccxt-mcp@0.1.3 dist.integrity gitHead
npm --prefix <APP_DIR> install --save-exact --ignore-scripts \
  ccxt-mcp@0.1.3 ccxt@4.5.85 @modelcontextprotocol/sdk@1.32.2 zod@3.25.76
npm --prefix <APP_DIR> ls --all ccxt      # ровно одна копия ccxt@4.5.85 (deduped)
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
- `call_implicit_get {`**`exchange`**`, `**`method`**`, account?, params?}`. С ccxt 4.5.85
  принимает camelCase-имена raw-эндпоинтов (`publicWalletGetCurrencyChains`); snake_case —
  `UNKNOWN_ENDPOINT`. Имена ищи через `describe_method {"exchange":…,"query":"CurrencyChains"}`.
- `get_balance {`**`account`**`, nonzeroOnly?, marketType?, params?}` — `includeInfo` нет,
  поэтому raw-поля читай через `call_read_method fetchBalance`.
- `transfer {`**`account, code, amount>0, fromAccount, toAccount`**`, params?, confirm?}`.
- `withdraw {`**`account, code, amount>0, address`**`, tag?, network?, params?, confirm?}`.
  Сервер кладёт `network` в `params.network` и вызывает `withdraw(code, amount, address, tag, params)`.
  ccxt затем объединяет `params` с запросом, так что лишний ключ (например, `chain`)
  переопределит сеть. Что уходит у каждой биржи, см. в
  [`exchanges.md`](exchanges.md#исходящий-withdraw-проверено-офлайн-ccxt-mcp-013--ccxt-4585).
- `get_deposit_address {`**`account, code`**`, network?, params?}` — без `confirm`. Если
  `fetchDepositAddress` не сработал, сервер вызывает `createDepositAddress`.

## Гейты и подтверждение

- Тиры включаются **только** в конфиге оператора. `funds: true` и `trading: true` работают
  лишь в `sandbox`/`demo`; на live сервер понижает их и пишет `configProblems`. Для
  `funds: "live"` нужен `maxTransferValue` (USD), при превышении — `TRANSFER_VALUE_CAP`.
- `settings.strictPermissions: true`: конфиг, доступный группе или другим (не `chmod 600`),
  сервер отвергает с `REFUSED (strictPermissions)` в `configProblems`.
- Адресные методы (`/deposit.?address|withdraw.?address|withdrawal.?whitelist/i`) требуют
  `funds` везде.
- `withdraw`, `transfer` и `call_implicit_write` всегда требуют подтверждения, если
  `confirm` ≠ `"never"`.
  - **Хост с elicitation.** Первый же вызов показывает форму. В ней текст preview и одно поле
    `confirm: boolean`; `params` не показаны. На `accept` с `true` запись **сразу**
    отправляется, на `decline` приходит `CONFIRM_DECLINED`. Если форма не открылась —
    `CONFIRM_UNAVAILABLE`; в режим токена сервер при этом не переходит.
  - **Хост без elicitation.** Возвращается preview и `meta.confirmToken`: UUID, HMAC от точного
    payload вместе с `params`, одноразовый, живёт 60 с. Ошибки погашения —
    `CONFIRM_INVALID`, `CONFIRM_EXPIRED`, `CONFIRM_MISMATCH`. Токен может погасить и модель.
- Порядок проверок: гейт тира → лимиты → подтверждение → `dryRun` → `intent` (fsync) → вызов
  биржи → `result` или `error`. Всё, что отвергнуто до `intent`, гарантированно не отправлено.
- `UNKNOWN_OUTCOME` приходит, когда после `intent` случился таймаут или сетевая ошибка, в том
  числе в предварительном чтении внутри ccxt. Его подсказка ссылается на `get_orders`; для
  переводов и выводов вместо этого сверяйся по SKILL.md, 2.7.
- В форме нет PLAN-ID и срока плана, поэтому навык показывает их до вызова (SKILL.md, 2.5).

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
  кошельки, ни минимумы, а итоговый запрос не строится.
- Ответ больше 80 000 символов: массив обрезается, а объект (например, `fetchCurrencies`)
  целиком заменяется на `{"truncated":true,…}`.
- `describe_method withdraw` модель комиссии не показывает (`paramsKeys: null`).
- Переменные `<EXCHANGEID>_<CREDENTIAL>` заполняют **все** аккаунты этой биржи в процессе, а
  хост может передать серверу всё своё окружение ([`security.md`](security.md)).
- В README: «Unregistered tiers do not even appear» верно только при `hideDisabledTools: true`.
  `mcp/server.json` на gitHead 0.1.3 указывает версию 0.1.2.

## Проверено (2026-11-24, scratch, без настоящих ключей, без live-записей)

Окружение: изолированные `HOME`/`XDG_*`, синтетические значения `SYNTHETIC-…`, конфиг
`chmod 600`. Для записей сервер запускался в сетевом namespace без интерфейсов
(`unshare -rn`), а `Exchange.prototype.fetch` заменялся записью запроса без отправки. Публичные
чтения шли без ключей, и guard пропускал только неподписанные GET, плюс публичный
`POST /info` Hyperliquid.

| Проверка | Результат |
|---|---|
| установка пина, `npm ls --all`, `audit signatures` | одна копия `ccxt@4.5.85`; 24 пакета с подтверждёнными attestations |
| `tools/list` (SDK 1.32.2) | 32 инструмента при `hideDisabledTools: false`; у `call_read_method` обязательны `["exchange","method"]` |
| `call_read_method` без `exchange` | `-32602 … Required at exchange` |
| `get_safety_status` | `0.1.3` / `ccxtVersion 4.5.84`; `configProblems: []` при `chmod 600` |
| `withdraw` у 9 бирж, коды `TRC20`/`BEP20`/`ERC20`/`TON` + memo, офлайн | запросы как в таблице exchanges.md; у OKX `fee` из `params`, у Bybit до записи `GET /v5/user/query-api` и `/v5/account/info`, у Bitget `GET /api/v3/account/settings` |
| то же с ccxt 4.5.94 (контроль) | OKX без цепочки и `fee`, Bybit и Gate без цепочки; memo KuCoin разобран посимвольно |
| `params.chain:"ETH"` у Bybit при `network:"BEP20"` | уходит `chain: ETH` |
| `ARBONE` и коды BingX при подмене живых данных | значение берётся из живых данных — не проверяемо офлайн |
| `transfer` у 9 бирж, офлайн | ожидаемые кошельки; KuCoin до записи `GET /api/ua/v1/account/mode` |
| токен (sandbox, dryRun) | другой `params` → `CONFIRM_MISMATCH`; повтор → `CONFIRM_INVALID`; через 61,5 с → `CONFIRM_EXPIRED`; идентичный → `dryRun: true`; 100 > 50 → `TRANSFER_VALUE_CAP` |
| `amount` в `withdraw`/`transfer` у 9 бирж, мок данных валют (шаг валюты `0.0001`, сети `0.00001` и наоборот), `10.12349` | как в таблице «Шаг суммы» exchanges.md; Gate `withdraw` → `10.1235` |
| разбор депозитов, мок raw-записей | WhiteBIT: unified `txid` = внутренний `transactionId`, хеш только в `info.transactionHash`; KuCoin: `info.chain: "bsc"`, `network: "BEP20"` |
| отправка, оборванная после `intent` | `UNKNOWN_OUTCOME`; `unresolvedIntents: []` |
| публично `fetchCurrencies` | Bitget, WhiteBIT, KuCoin, Gate → маркер усечения; Binance, Bybit, OKX, MEXC, BingX → `{}` |
| публично `fetchDepositWithdrawFee USDT includeInfo` | Bitget и WhiteBIT: флаги, минимумы, комиссии в `info`; BingX `null`; остальные `AUTH_FAILED` |
| `call_implicit_get` | Gate `publicWalletGetCurrencyChains`, KuCoin `publicGetCurrenciesCurrency` → данные; snake_case → `UNKNOWN_ENDPOINT` |
| Hyperliquid `fetchBalance` | `info.marginSummary`, `crossMaintenanceMarginUsed`, `withdrawable` только с `includeInfo` |
| окружение серверов (фиктивный сервер пишет только **имена** переменных) | Claude Code 2.1.331: каждый сервер получил всё окружение хоста, включая чужие префиксные и сырые имена; Codex 0.172.0: каждый сервер получил только свои `env_vars` |

Проверено раньше на том же ccxt-mcp 0.1.3, логика не зависит от ccxt: нативная форма
(`decline` / `accept`, в схеме только `confirm: boolean`), таймаут хоста не останавливает
отправку, `get_deposit_address` на dryRun-аккаунте подписывает запрос, обнаружение навыка и
сервера в Claude Code 2.1.331 и Codex 0.172.0 ([`security.md`](security.md)).

Не проверено (нет ключей по условию): реальные аккаунты, режимы, поля доступной суммы,
модели комиссий, whitelist, ответы бирж на запись, фактические выводы и депозиты.
