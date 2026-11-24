# Секреты и граница процесса

Цель: агент видит **только алиасы и результаты инструментов**. Ключи живут у отдельного
доверенного процесса, запущенного под отдельным ОС-пользователем, и попадают туда из
Doppler (read-only service token на конкретный config) или из внешнего `.env` с
правами `0600`. В репозитории, аргументах командной строки и чате секретов нет.

## Почему важна граница процесса

`ccxt-mcp` не принимает ключи как параметры инструментов и редактирует их в выводе. Но
если сервер запущен **под тем же UID**, что и терминал агента, агент своими shell-тулзами
может прочитать конфиг/`.env`, Doppler-токен (`~/.doppler`), `/proc/<pid>/environ`
(туда попадают переменные от `doppler run`), журнал, или подключиться отладчиком. Deny-
правила хоста полезны, но это не граница. Граница = другой ОС-пользователь
(`fundkit-mcp`), каталоги `0700`, файлы `0600`, а агенту разрешён только запуск ровно
одной команды сервера через `sudo` (stdio остаётся у хоста).

Остаточный риск: агент, которому разрешён этот `sudo`, может сам запустить сервер и
вызвать те же инструменты в обход UI-подтверждения хоста. Поэтому обязательны
биржевые backstop'ы: права ключа, IP allowlist, whitelist адресов вывода, `maxTransferValue`.

## Профили: один сервер = один аккаунт = один набор прав

- Один MCP-сервер на пару (аккаунт биржи, уровень прав): `ccxt-okx-main-read`,
  `ccxt-okx-main-funds`, `ccxt-bybit-main-funds`, `ccxt-hl-watch`.
- У каждого — свой каталог `/srv/fundkit-mcp/profiles/<profile>/`, свой `config.json`
  с **одним** аккаунтом, свой Doppler config и свой service token (или свой `.env`).
- Не кладите два аккаунта одной биржи в один процесс: сервер заполняет недостающие ключи
  из `<EXCHANGEID>_<CREDENTIAL>` для **каждого** аккаунта этой биржи — субаккаунт молча
  получит ключ основного. Не включайте `loadEnvKeys` и не используйте `CCXT_MCP_APIKEY*`
  / `CCXT_MCP_EXCHANGE*` (создают аккаунт `default`).
- Алиас аккаунта не должен намекать на ключ другого аккаунта; при ротации меняйте ключ
  только в его Doppler config.

## Секреты (env) vs флаги оператора (файл)

| Где | Что | Кто меняет |
|---|---|---|
| Doppler config / внешний `.env` (секрет) | `BINANCE_APIKEY`, `BINANCE_SECRET`, `BYBIT_APIKEY`, `BYBIT_SECRET`, `GATE_APIKEY`, `GATE_SECRET`, `OKX_APIKEY`, `OKX_SECRET`, `OKX_PASSWORD`, `BITGET_APIKEY`, `BITGET_SECRET`, `BITGET_PASSWORD`, `WHITEBIT_APIKEY`, `WHITEBIT_SECRET`, `BINGX_APIKEY`, `BINGX_SECRET`, `MEXC_APIKEY`, `MEXC_SECRET`, `KUCOIN_APIKEY`, `KUCOIN_SECRET`, `KUCOIN_PASSWORD` — только переменные своей биржи в своём профиле | человек в Doppler / в файле |
| `config.json` профиля (не секрет, `0600`, владелец `fundkit-mcp`) | алиас, `exchange`, `funds`, `trading`, `dryRun`, `confirm`, `maxTransferValue`, `maxDailyValue`, `settings.strictPermissions`, `settings.hideDisabledTools`; для Hyperliquid — публичный `walletAddress` | только оператор, агент не может |
| launcher (`.mcp.json` хоста) | путь к профилю, имя пользователя, команда | оператор; секретов нет |

`*_PASSWORD` = API passphrase (OKX, Bitget, KuCoin). Hyperliquid private key в этом
навыке не используется никогда (`HYPERLIQUID_PRIVATEKEY` не задавать).

### Пример `config.json` профиля (без секретов)

```json
{
  "settings": { "strictPermissions": true, "hideDisabledTools": false },
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

Read-профиль: без `funds`/`trading`, `"hideDisabledTools": true` (остаётся 21 инструмент
вместо 32). Hyperliquid: `{"exchange":"hyperliquid","walletAddress":"0x…"}` и ничего
больше. Начинайте с `"dryRun": true`; уберите его только после прогона плана.

## Установка доверенной стороны (выполняет человек с правами администратора)

```bash
sudo useradd --system --create-home --home-dir /srv/fundkit-mcp --shell /usr/sbin/nologin fundkit-mcp
sudo chmod 0700 /srv/fundkit-mcp
sudo -u fundkit-mcp -H mkdir -m 0700 -p /srv/fundkit-mcp/app /srv/fundkit-mcp/profiles/okx-main
sudo -u fundkit-mcp -H npm --prefix /srv/fundkit-mcp/app install --save-exact --ignore-scripts ccxt-mcp@0.1.3
```

### Вариант A: Doppler (рекомендуется)

Отдельный Doppler config на профиль (например проект `fundkit`, config `prd_okx_main`),
в нём только переменные этой биржи. Service token даёт **read-only** доступ к одному
config. Создайте его в дашборде или (с вашей учётки, не из агента):

```bash
doppler configs tokens create okx-main-mcp --project fundkit --config prd_okx_main --plain
```

Сохраните токен только под `fundkit-mcp`, со scope на каталог профиля, не через аргументы
и историю shell — передайте через stdin:

```bash
sudo -u fundkit-mcp -H doppler configure set token --scope /srv/fundkit-mcp/profiles/okx-main
```

(вставьте токен в stdin, затем Ctrl-D). Регистрация сервера в хосте агента — без секретов:

```json
{
  "mcpServers": {
    "ccxt-okx-main": {
      "command": "/usr/bin/sudo",
      "args": [
        "-n", "-H", "-u", "fundkit-mcp", "--",
        "/usr/bin/doppler", "run", "--no-check-version", "--no-read-env", "--no-fallback",
        "--scope", "/srv/fundkit-mcp/profiles/okx-main",
        "--",
        "/usr/bin/env", "CCXT_MCP_CONFIG=/srv/fundkit-mcp/profiles/okx-main/config.json",
        "/usr/bin/node", "/srv/fundkit-mcp/app/node_modules/ccxt-mcp/js/server.js"
      ]
    }
  }
}
```

Правило sudo ровно на эту команду (`sudo visudo -f /etc/sudoers.d/fundkit-mcp`; в
sudoers `=` в аргументах экранируется `\=`; `agentuser` — ваш пользователь агента):

```text
agentuser ALL=(fundkit-mcp) NOPASSWD: /usr/bin/doppler run --no-check-version --no-read-env --no-fallback --scope /srv/fundkit-mcp/profiles/okx-main -- /usr/bin/env CCXT_MCP_CONFIG\=/srv/fundkit-mcp/profiles/okx-main/config.json /usr/bin/node /srv/fundkit-mcp/app/node_modules/ccxt-mcp/js/server.js
```

Пути к `doppler`/`node` подставьте свои (`command -v doppler node` под `fundkit-mcp`).
`--no-fallback` отключает зашифрованный fallback-файл и кэш на диске (нужна связь с
Doppler при каждом старте); если нужен офлайн-старт — вместо него `--fallback
/srv/fundkit-mcp/profiles/okx-main/doppler-fallback.json` (каталог `0700`).
`--no-read-env` не даёт переменным окружения (например чужому `DOPPLER_TOKEN`) подменить
сохранённый scoped-токен. `sudo` сам сбрасывает окружение вызывающего.

### Вариант B: внешний `.env` (fallback без Doppler)

Файл вне репозитория, владелец `fundkit-mcp`, права `0600`, каталог `0700`:

```text
/srv/fundkit-mcp/profiles/okx-main/secrets.env
OKX_APIKEY=…
OKX_SECRET=…
OKX_PASSWORD=…
```

Запуск — Node ≥ 20.6 читает файл сам, секреты не попадают в argv:

```json
{
  "mcpServers": {
    "ccxt-okx-main": {
      "command": "/usr/bin/sudo",
      "args": [
        "-n", "-H", "-u", "fundkit-mcp", "--",
        "/usr/bin/env", "-i", "HOME=/srv/fundkit-mcp", "PATH=/usr/bin:/bin",
        "CCXT_MCP_CONFIG=/srv/fundkit-mcp/profiles/okx-main/config.json",
        "/usr/bin/node", "--env-file=/srv/fundkit-mcp/profiles/okx-main/secrets.env",
        "/srv/fundkit-mcp/app/node_modules/ccxt-mcp/js/server.js"
      ]
    }
  }
}
```

Для sudoers — такое же точное правило на эту команду (`HOME\=…`, `PATH\=…`,
`CCXT_MCP_CONFIG\=…`, `--env-file\=…` с экранированным `=`). Проверено в scratch: в
argv процесса виден только путь к файлу, значения из файла не попадают ни в argv, ни в
результаты инструментов.

Никогда: `.env` в репозитории или в `$HOME` агента, ключи в `args`, `export KEY=…` в
терминале агента, ключи в чате.

## Права ключей на бирже (least privilege)

| Профиль | Права ключа | Обязательно |
|---|---|---|
| read | только чтение | IP allowlist |
| internal transfer | чтение + внутренний/универсальный перевод (название права у каждой биржи своё) | IP allowlist, без вывода |
| withdraw (источник A) | чтение + вывод (+перевод, если нужен шаг 1) | IP allowlist; whitelist адресов вывода, адрес B добавлен человеком с 2FA; лимит вывода на бирже |
| Hyperliquid watch | ключ не нужен | только публичный адрес |

Плюс `maxTransferValue`/`maxDailyValue` в профиле, явные суммы в каждом плане,
`implicitWrites` выключен, `confirm` ≠ `never`.

## Ротация и отзыв

- Плановая ротация ключей бирж и service token'ов; при любом подозрении — сразу.
- Отзыв токена Doppler: `doppler configs tokens revoke -p fundkit -c prd_okx_main <token-slug>`
  или вкладка Access у config. Если использовался `--fallback`, удалите fallback-файл
  профиля: CLI может отдать из него последние секреты.
- Ключ на бирже: удалить ключ в кабинете биржи (а не только в Doppler), выпустить новый
  с теми же минимальными правами и allowlist, обновить только его профиль.
- Ключ попал в чат/лог/репозиторий → считать скомпрометированным: отозвать, проверить
  историю выводов и whitelist адресов.

## Тестирование без доступа к кредам

Изолированный `HOME`/`XDG_*`, `env -i`, синтетические значения (`SYNTHETIC-NOT-A-KEY`),
только публичная интроспекция (`tools/list`, `describe_*`, публичные `fetch*`),
`dryRun: true` и сетевой guard, блокирующий подписанные запросы. Реальные переводы и
чтение реальных аккаунтов в тестах не выполняются.
