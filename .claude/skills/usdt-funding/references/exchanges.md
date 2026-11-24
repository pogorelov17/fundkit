# Биржи: возможности ccxt-mcp vs тест на аккаунте

**Возможность** = метод есть в ccxt 4.5.9x под `ccxt-mcp@0.1.3` (проверено
`describe_exchange`, оффлайн, без ключей). **Тест на аккаунте** = то, что можно узнать
только с ключами конкретного пользователя: режим аккаунта, права ключа, включённые сети,
реальные комиссии/минимумы, откуда разрешён вывод и куда зачисляется депозит. Ячейки
«типично» — ориентир, а не факт; в плане они должны быть подтверждены чтением на аккаунте.

## Сводная таблица

| Биржа (`exchange`) | Секреты (env) | sandbox | `transfer` кошельки (`fromAccount`/`toAccount`) | Адрес депозита | `fetchTransfers` | Сети USDT публично |
|---|---|---|---|---|---|---|
| Binance (`binance`) | `BINANCE_APIKEY`, `BINANCE_SECRET` | да | `spot`/`main`, `funding`, `margin`/`cross`, `linear`/`swap` (USDⓈ-M), `inverse`, `option` | fetch | да | нет (нужен ключ) |
| Bybit (`bybit`) | `BYBIT_APIKEY`, `BYBIT_SECRET` | да | `funding`/`fund`, `unified` (UTA), `spot`, `contract`/`swap`/`future` (classic), `option`, `investment` | fetch, по сетям | да | нет (нужен ключ) |
| Gate (`gate`) | `GATE_APIKEY`, `GATE_SECRET` | да | `spot`, `funding`, `margin`, `cross_margin`/`cross`, `isolated`, `swap`/`futures`, `delivery`, `options` | fetch, по сетям | нет | не подтверждено |
| OKX (`okx`) | `OKX_APIKEY`, `OKX_SECRET`, `OKX_PASSWORD` (passphrase) | да | `funding` (6), `trading` (18; также `spot`/`swap`/`margin`…) | fetch, по сетям | да | нет (нужен ключ) |
| Bitget (`bitget`) | `BITGET_APIKEY`, `BITGET_SECRET`, `BITGET_PASSWORD` | нет | `spot`, `funding`, `swap` (USDT-M), `usdc_swap`, `future`, `cross`, `isolated`, `p2p`, `uta`/`unified` | fetch | да | да (`fetchDepositWithdrawFee`) |
| WhiteBIT (`whitebit`) | `WHITEBIT_APIKEY`, `WHITEBIT_SECRET` | нет | `main`/`funding`, `spot`/`trade`, `margin` (collateral) | fetch + create | нет | да (`fetchDepositWithdrawFee`) |
| BingX (`bingx`) | `BINGX_APIKEY`, `BINGX_SECRET` | да | `funding`, `spot`, `swap`/`linear`/`future`, `inverse` | fetch, по сетям | да | пусто без ключа |
| MEXC (`mexc`) | `MEXC_APIKEY`, `MEXC_SECRET` | нет | `spot` ↔ `swap`/`future` (FUTURES) | fetch + create, по сетям | да | нет (нужен ключ) |
| KuCoin (`kucoin`) | `KUCOIN_APIKEY`, `KUCOIN_SECRET`, `KUCOIN_PASSWORD` | нет | `main`/`funding`, `spot`/`trade`, `margin`/`cross`, `isolated`, `future`/`contract`/`swap`, `hf`, `uta`/`unified` | fetch + create, по сетям | да | частично (`fetchCurrencies` большой, усекается) |
| Hyperliquid (`hyperliquid`) | **нет секретов в навыке**; в конфиге только публичный `walletAddress` | да | — (в ccxt: только USDC `spot`↔`swap` и main↔sub, требует private key — **запрещено навыком**) | нет | нет | — |

Все 9 CEX и Hyperliquid сообщают `fetchBalance`, `fetchPositions`, `fetchDeposits`,
`fetchWithdrawals`, `withdraw`, `transfer`; `fetchDepositWithdrawFees` есть у всех 9 CEX.
`fetchLedger` нет у WhiteBIT, BingX, MEXC. `certified: false` только у WhiteBIT.

Имена переменных строятся сервером как `(exchange + '_' + credential).toUpperCase()`;
`password` — это API passphrase. Для `gate` используйте id `gate` (env `GATE_*`), не алиас.

## Режим аккаунта и маршрут денег (тест на аккаунте)

Сначала найди точное имя эндпоинта: `describe_method {"query":"<слово>","exchange":"<id>"}`;
затем читай через `call_implicit_get` (только GET) или `call_read_method`.

| Биржа | Как узнать режим | Депозит зачисляется (типично) | Вывод идёт из (типично) |
|---|---|---|---|
| Binance | classic vs Portfolio Margin — по кабинету и `fetchBalance` по типам (`spot`, `funding`, `linear`) | `spot` (настраивается на `funding`) | `spot` (или `funding` через параметр) |
| Bybit | v5 account info (`unifiedMarginStatus`): UTA → `unified`+`funding`; classic → `spot`/`contract`/`funding` | `funding` | `funding` (UTA — проверить) |
| Gate | unified mode endpoint (`unified`/classic) | `spot` | `spot` |
| OKX | `privateGetAccountConfig` → `acctLv` (1 спот, 2 single-currency margin, 3 multi-currency, 4 portfolio); макс. вывод — `privateGetAccountMaxWithdrawal` | `funding` | `funding` |
| Bitget | classic vs UTA (`uta`) по кабинету/балансам | `spot` | `spot` |
| WhiteBIT | — (main/trade/collateral) | `main` | `main` |
| BingX | балансы `funding`/`spot`/`swap` | проверить | проверить |
| MEXC | — (spot/futures) | `spot` | `spot` |
| KuCoin | classic vs UTA по балансам `main`/`trade`/`unified` | `main` | `main` |

Типовой маршрут A → B: A `transfer <trading> → <кошелёк вывода>` → A `withdraw` →
депозит в `<кошелёк зачисления B>` → B `transfer → <торговый кошелёк>`.

## Свободная маржа и «доступно к переводу»

- Деривативный кошелёк: доступное к переводу ≠ `free`. Используй биржевое поле, если оно
  есть (`includeInfo: true` в `fetchBalance`, OKX `maxWithdrawal`, Bybit UTA
  transferable/withdrawable в `info`), и всегда вычитай резерв пользователя.
- Открытые позиции (`get_positions`) и ордера (`get_orders`) уменьшают доступное;
  перевод «впритык» может сдвинуть ликвидацию.

## Hyperliquid (только мониторинг)

Проверено публично: `fetchBalance` (perp, коллатерал USDC), `fetchBalance` с
`params.type: "spot"`, `fetchPositions` — с публичным адресом (`params.user` или аккаунт с
одним `walletAddress`) работают без подписи. `fetchDepositAddress` без funds-аккаунта →
`TIER_DISABLED`; `transfer` на read-аккаунте → `TIER_DISABLED`. `fetchDepositWithdrawFee`
не поддерживается. USDT-маршрутов нет.

## Что проверено, а что нет (2026-11-24)

| Биржа | `describe_exchange` | публичные сети/комиссии USDT | аккаунт-тест |
|---|---|---|---|
| Binance, Bybit, OKX, MEXC | да | `fetchCurrencies` → `{}` без ключа, `fetchDepositWithdrawFee` → `AUTH_FAILED` | не выполнялся (нет ключей по условию) |
| Gate | да | `fetchDepositWithdrawFee` → `AUTH_FAILED`; `fetchCurrencies` заблокирован тестовым guard'ом (публичный заголовок `X-Gate-Channel-Id`) — не подтверждено | не выполнялся |
| Bitget, WhiteBIT | да | да: сети и комиссии вывода USDT | не выполнялся |
| BingX | да | `fetchDepositWithdrawFee` → пусто, `fetchCurrencies` → `{}` | не выполнялся |
| KuCoin | да | `fetchCurrencies` есть, но усечён по размеру; `fetchDepositWithdrawFee` → `AUTH_FAILED` | не выполнялся |
| Hyperliquid | да | — | публичное чтение маржи/позиций по синтетическому адресу — да |

Вывод для плана: на большинстве бирж включённость сетей и комиссии **нельзя** взять
публично — нужен read-профиль с ключом, и только живые данные на момент плана.
