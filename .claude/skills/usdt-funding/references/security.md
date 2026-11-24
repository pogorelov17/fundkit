# Секреты, подключение к хостам, права ключей

Агент видит только алиасы и результаты инструментов. Ключи передаёт серверу оператор через
своё внешнее окружение. В репозитории, конфигах хоста, argv и чате значений нет.

## Контракт окружения

- **Один MCP-сервер = один аккаунт.** У каждого сервера свой `config.json` с одним аккаунтом
  и уникальным алиасом. Уникальность нужна среди всех серверов, потому что журнал общий
  (см. [`ccxt-mcp.md`](ccxt-mcp.md)).
- Процесс сервера получает **только** переменные своей биржи:
  `<EXCHANGE>_APIKEY`, `<EXCHANGE>_SECRET`, а для OKX, Bitget и KuCoin ещё
  `<EXCHANGE>_PASSWORD`. Значения берутся из внешнего окружения оператора, способ хранения он
  выбирает сам. Hyperliquid переменных не получает.
- `loadEnvKeys` не включайте и `CCXT_MCP_APIKEY*` / `CCXT_MCP_EXCHANGE*` не задавайте: они
  создают аккаунт `default`. Два аккаунта одной биржи в одном процессе получат один и тот же
  ключ.

### `config.json` профиля (секретов нет, меняет только оператор)

```json
{
  "settings": { "strictPermissions": true, "hideDisabledTools": true },
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

Профиль только для чтения — без `funds` и `trading`. Hyperliquid:
`{"accounts":{"hl-watch":{"exchange":"hyperliquid","walletAddress":"0x…"}}}`. Начинайте с
`"dryRun": true` и снимайте его только после того, как план прогнан.

## Граница: тот же ОС-пользователь или отдельный

- **Тот же пользователь, что и shell агента.** Агент может прочитать окружение сервера
  (`/proc/<pid>/environ`; проверено, значения в `ps` не видны, а в `environ` видны), его файлы
  и журнал. Deny-правила хоста границей не являются. Такой режим подходит для профилей только
  для чтения или при жёстких ограничениях на стороне биржи.
- **Отдельный пользователь или контейнер на стороне оператора.** Shell агента не читает
  окружение и файлы сервера; как это устроить, решает оператор. Риск остаётся: если агент может
  сам запустить сервер, у его клиента нет нативной формы, сервер выдаст токен, и агент
  подтвердит запись сам.
- В обоих случаях ограничения на бирже обязательны (таблица ниже).

## Регистрация в хостах (без секретов)

Пути `<APP_DIR>` (каталог установки, см. [`ccxt-mcp.md`](ccxt-mcp.md)) и `<PROFILES>`
подставьте свои.

**Claude Code** — `.mcp.json` в проекте или `claude mcp add-json -s user <name> '<json>'`:

```json
{
  "mcpServers": {
    "ccxt-okx-main": {
      "command": "/usr/bin/node",
      "args": ["<APP_DIR>/node_modules/ccxt-mcp/js/server.js"],
      "env": {
        "CCXT_MCP_CONFIG": "<PROFILES>/okx-main/config.json",
        "OKX_APIKEY": "${OKX_MAIN_APIKEY}",
        "OKX_SECRET": "${OKX_MAIN_SECRET}",
        "OKX_PASSWORD": "${OKX_MAIN_PASSWORD}"
      }
    }
  }
}
```

Claude Code подставляет `${…}` из окружения, в котором запущен хост. Сервер к тому же
**наследует всё окружение хоста** (проверено). Поэтому в окружении хоста держите только имена
с префиксом аккаунта (`OKX_MAIN_*`) и никогда «сырые» `OKX_APIKEY`. ccxt-mcp читает только
`<EXCHANGE>_<CREDENTIAL>`, так что префиксные имена он игнорирует. Серверы из `.mcp.json`
проекта нужно один раз одобрить в интерактивном `claude`.

**Codex** — `~/.codex/config.toml` (или `$CODEX_HOME/config.toml`):

```toml
[mcp_servers.ccxt-okx-main]
command = "/usr/bin/node"
args = ["<APP_DIR>/node_modules/ccxt-mcp/js/server.js"]
env = { CCXT_MCP_CONFIG = "<PROFILES>/okx-main/config.json" }
env_vars = ["OKX_APIKEY", "OKX_SECRET", "OKX_PASSWORD"]
startup_timeout_sec = 30
tool_timeout_sec = 120
```

Codex запускает сервер с урезанным окружением и пробрасывает только имена из `env_vars`
(проверено: `BYBIT_APIKEY` из окружения хоста не дошёл). `${…}` внутри `env` Codex **не**
раскрывает. Поэтому на один запуск Codex — один аккаунт каждой биржи; второй аккаунт той же
биржи требует отдельного окружения запуска.

Таймаут хоста не останавливает отправку на сервере (проверено). После него — только сверка,
см. SKILL.md, 2.7.

## Подключение навыка

- **Claude Code** находит `.claude/skills/usdt-funding/` в проекте. Для всех проектов
  скопируйте папку в `~/.claude/skills/`.
- **Codex** `.claude/skills` **не** читает (проверено). Сделайте в репозитории
  `mkdir -p .agents/skills && ln -s ../../.claude/skills/usdt-funding .agents/skills/usdt-funding`
  (симлинк проверен) или скопируйте папку в `~/.codex/skills/`.

## Smoke-check на каждом хосте (без модели и без ключей)

| Хост | Навык найден | Сервер подключён |
|---|---|---|
| Claude Code 2.1.331 | `claude --debug-file <log>` → в логе `Loaded … skills (… project: 1 …)` | `claude mcp list` → `ccxt-okx-main … ✔ Connected` |
| Codex 0.172.0 | `codex debug prompt-input \| grep -c usdt-funding` ≥ 1 | `codex mcp get ccxt-okx-main` (значения `env` замаскированы `*****`); `codex debug prompt-input` запускает сервер |

Затем в сессии попросите агента вызвать `get_safety_status`. Должно быть `version: "0.1.3"`,
`ccxtVersion: "4.5.93"`, пустой `configProblems` и `elicitationSupported: true`; оба хоста
объявляют `elicitation.form` (проверено по `initialize`).

## Права ключей на бирже

| Профиль | Права | Обязательно |
|---|---|---|
| только чтение | чтение | IP allowlist |
| внутренний перевод | чтение + внутренний перевод | IP allowlist, без вывода |
| вывод (биржа A) | чтение + вывод (+ перевод) | IP allowlist, whitelist адресов (адрес B вносит человек с 2FA), лимит вывода на бирже |
| Hyperliquid | ключ не нужен | только публичный адрес |

Плюс `maxTransferValue` и `maxDailyValue` в профиле, `implicitWrites` выключен,
`confirm` ≠ `never`.

## Ротация

Плановая ротация, а при подозрении — немедленная. Удалите ключ в кабинете биржи, выпустите
новый с теми же минимальными правами и allowlist и обновите значение во внешнем окружении
только этого аккаунта. Если ключ попал в чат, лог или репозиторий, считайте его
скомпрометированным: отзовите и проверьте историю выводов и whitelist.
