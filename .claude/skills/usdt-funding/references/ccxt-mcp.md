# ccxt-mcp 0.1.3 — версия, инструменты, гейты, ограничения

Всё ниже проверено по опубликованному пакету `ccxt-mcp@0.1.3` (исходник `js/`), README
пакета, wiki `ccxt/ccxt` (`wiki/MCP.md`) и живому прогону по stdio (см. «Проверено»).

## Закрепление версии

| Что | Значение |
|---|---|
| npm | `ccxt-mcp@0.1.3` (dist-tag `latest`; опубликованы 0.1.0, 0.1.2, 0.1.3) |
| tarball sha1 / integrity | `b583b93e9fcecb6cc0700b48863dc7cbcb6ed99b` / `sha512-XGU7T/lXphackbxtukik6te2LfxuQsFUxshCUAXkaKnOKQFlwFJkaPjpZLZT/dSeScA6Wq2ipMhGhE2uxvrbqg==` |
| provenance | SLSA v1, `github.com/ccxt/ccxt`, `.github/workflows/mcp-release.yml`, `refs/heads/master`; gitHead `e0eaca51b25377491120ce9ca2943c71800d0d44` |
| исходник | `github.com/ccxt/ccxt/tree/master/mcp` (README в тарболе совпадает с `mcp/README.md` на gitHead) |
| зависимости | `@modelcontextprotocol/sdk ^1.29.0`, `ccxt ^4.5.75`, `zod ^3.25.76` — диапазоны, не пины |
| bin | `ccxt-mcp` → `js/server.js`, Node ≥ 18 (`--env-file` из fallback-лаунчера требует Node ≥ 20.6) |

Проверка перед установкой (в доверенном аккаунте):

```bash
npm view ccxt-mcp@0.1.3 dist.integrity dist.shasum gitHead
npm view ccxt-mcp versions
```

Установка с точным пином и lockfile (не `npx -y ccxt-mcp` при каждом старте — он берёт
`latest` и скачивает код заново):

```bash
npm --prefix /srv/fundkit-mcp/app install --save-exact --ignore-scripts ccxt-mcp@0.1.3
npm --prefix /srv/fundkit-mcp/app audit signatures
```

Транзитивные версии фиксирует `package-lock.json` в каталоге приложения; при обновлении
сравни `get_safety_status.version`/`ccxtVersion` с ожидаемыми. Пример наблюдения: при
`ccxt` 4.5.94 сервер сообщает `ccxtVersion: "4.5.93"` (внутренняя строка версии ccxt).

## Инструменты (32 по умолчанию)

| Тир | Инструменты | Тип |
|---|---|---|
| market (всегда) | `list_exchanges`, `describe_exchange`, `describe_method`, `search_markets`, `get_tickers`, `get_orderbook`, `get_ohlcv`, `get_trades`, `search_events`, `call_read_method`, `call_implicit_get`, `get_safety_status`, `watch_subscribe`, `watch_read`, `watch_unsubscribe`, `watch_list` | чтение |
| read (есть аккаунт) | `list_accounts`, `get_balance`, `get_orders`, `get_my_trades`, `get_positions` | чтение |
| trading | `create_order`, `edit_order`, `cancel_order`, `cancel_all_orders`, `set_leverage`, `set_margin_mode`, `call_write_method` | запись |
| funds | `transfer`, `withdraw`, `get_deposit_address` | запись |
| implicitWrites | `call_implicit_write` | запись (сырые POST/PUT/DELETE) |

Схемы записей (точно из `tools/list`):

- `transfer {account, code, amount>0, fromAccount, toAccount, params?, confirm?}`
- `withdraw {account, code, amount>0, address, tag?, network?, params?, confirm?}`
- `get_deposit_address {account, code, network?, params?}` — **нет** `confirm`.
- `call_read_method {exchange, method ^(fetch|load), args?, account?, includeInfo?, marketType?, prediction?, params?}`
  — `args` только скаляры (string/number/bool/null).

Полезные вызовы для навыка:

```text
get_safety_status {}
list_accounts {}
describe_exchange {"exchange":"okx"}                       # requiredCredentials, методы, sandbox
describe_method {"method":"transfer","exchange":"okx"}     # сигнатура
call_read_method {"exchange":"okx","account":"okx-main","method":"fetchCurrencies"}
call_read_method {"exchange":"okx","account":"okx-main","method":"fetchDepositWithdrawFee","args":["USDT"]}
call_read_method {"exchange":"okx","account":"okx-main","method":"fetchBalance","params":{"type":"funding"},"includeInfo":true}
call_read_method {"exchange":"okx","account":"okx-main","method":"fetchWithdrawals","args":["USDT"]}
call_read_method {"exchange":"bybit","account":"bybit-main","method":"fetchDeposits","args":["USDT"]}
transfer {"account":"okx-main","code":"USDT","amount":25,"fromAccount":"trading","toAccount":"funding"}
```

## Гейты (из `safety.js`, `config.js`, `funds.js`)

- Тиры включаются **только** в конфиг-файле оператора; инструмента для правки конфига нет.
- `funds: true` / `trading: true` работают только для `sandbox`/`demo`; на live аккаунте
  сервер понижает их до `false` и пишет `configProblems`.
- `funds: "live"` требует `maxTransferValue` (USD; `null` = осознанный отказ от лимита —
  не рекомендуем). Превышение → `TRANSFER_VALUE_CAP`, запись в журнал `rejected`.
- `get_deposit_address` и любые методы/эндпоинты, совпадающие с
  `/deposit.?address|withdraw.?address|withdrawal.?whitelist/i`, требуют `funds` — и в
  `call_read_method`, и в `call_implicit_get`. `get_deposit_address` при неудаче
  `fetchDepositAddress` вызывает `createDepositAddress` (может **создать** адрес на бирже).
- Подтверждение записей `withdraw`/`transfer`/`call_implicit_write` обязательно, пока
  `confirm` ≠ `"never"`. Без elicitation: preview + `confirmToken` (UUID, HMAC от точного
  payload, одноразовый, TTL 60 с). **Важно:** такой токен может погасить и сама модель —
  поэтому человеческое подтверждение плана в чате обязательно до погашения.
- Поток записи: `intent` (fsync) → вызов → `result`/`error`; таймаут после отправки =
  `UNKNOWN_OUTCOME`, без авто-повтора. Журнал: `<cache>/ccxt-mcp/journal/YYYY-MM.jsonl`
  у пользователя, под которым работает сервер; `get_safety_status.unresolvedIntents`.
- Секреты не принимаются ни одним инструментом; результаты и логи проходят редактор
  секретов; `info` вырезается, пока не запрошен `includeInfo`.

## Ограничения `dryRun`

`dryRun: true` в аккаунте соблюдают **только** `withdraw`, `transfer`, `create_order`,
`edit_order`. Не соблюдают: `get_deposit_address` (может создать адрес),
`cancel_order`, `cancel_all_orders`, `set_leverage`, `set_margin_mode`,
`call_write_method`, `call_implicit_write`. dryRun-ответ — локальный preview: он **не**
проверяет на бирже баланс, права ключа, имена кошельков, минимумы, whitelist. Перед
dryRun всё равно загружаются рынки (публичная сеть) и требуется подтверждение.

## Неточности публичной документации (на 0.1.3)

- README: «Unregistered tiers do not even appear in the tool list» — верно только при
  `"settings": {"hideDisabledTools": true}`; по умолчанию все 32 инструмента видны, а
  вызов отключённого тира возвращает `TIER_DISABLED` (проверено).
- `mcp/server.json` на gitHead релиза 0.1.3 указывает версию `0.1.2` (метаданные реестра
  отстают от npm).
- Переменные `<EXCHANGEID>_<CREDENTIAL>` заполняют **все** аккаунты одной биржи в
  процессе — два аккаунта одной биржи в одном сервере без ключей в файле получат один и
  тот же ключ (см. `security.md`, «Профили»).

## Проверено (2026-11-24, изолированный HOME, синтетические данные, без ключей)

- Официальный клиент `@modelcontextprotocol/sdk` 1.32.2 по stdio и
  `@modelcontextprotocol/inspector` 2.16.0 `--cli --method tools/list` → 32 инструмента;
  `serverInfo` `ccxt-mcp 0.1.3`.
- `describe_exchange` для всех 10 бирж (оффлайн) — см. таблицу в `exchanges.md`.
- Синтетический конфиг: `TIER_DISABLED` для `transfer`/`withdraw`/`get_deposit_address`/
  `fetchDepositAddress` на read-профиле; понижение `funds: true` на live и `funds: "live"`
  без лимита; `TRANSFER_VALUE_CAP` (100 > 50); `CONFIRM_MISMATCH` (сумма 6 вместо 5),
  `CONFIRM_INVALID` (повтор токена); dryRun-`transfer` → `dryRun: true`, intent в журнал не
  пишется; `call_implicit_write` без `implicitWrites` → `TIER_DISABLED`;
  `createDepositAddress` через `call_read_method` → `NOT_A_READ_METHOD`.
- Сетевой guard в тестовом процессе: 0 подписанных запросов ушло на биржи.
