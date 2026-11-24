# Биржи: кошельки, сети, исходящие запросы (ccxt 4.5.85)

**Проверено** — без ключей: по коду ccxt 4.5.85, публичным ответом через ccxt-mcp или офлайн
по собранному запросу (синтетические ключи, сеть отключена, см. [`ccxt-mcp.md`](ccxt-mcp.md)).
**Тест на аккаунте** — то, что видно только с ключом пользователя: режим аккаунта, права ключа,
включённость сетей, реальные комиссии и минимумы, поле доступной суммы. Пока такой тест не
сделан, всё это **неизвестно**.

## Кошельки для `transfer` (`options.accountsByType`)

Слева имя, которое передаётся в `fromAccount`/`toAccount`, справа id кошелька на бирже.
Разные имена с одним id — **алиасы одного кошелька**.

| Биржа (`exchange`) | Имена → id кошелька |
|---|---|
| Binance (`binance`) | `main`,`spot`→MAIN · `funding`→FUNDING · `margin`,`cross`→MARGIN · `linear`,`swap`,`future`→UMFUTURE (USDⓈ-M) · `inverse`,`delivery`→CMFUTURE · `option`→OPTION |
| Bybit (`bybit`) | `funding`,`fund`→FUND · `unified`→UNIFIED (UTA) · `spot`,`margin`→SPOT · `contract`,`swap`,`future`→CONTRACT (classic) · `option` · `investment` |
| Gate (`gate`) | **`funding`,`spot`→spot** (отдельного funding нет) · `margin`,`isolated`→margin · `cross_margin`,`cross`→cross_margin · `swap`,`futures`→futures · `future`,`delivery`→delivery · `option`,`options`→options |
| OKX (`okx`) | `funding`→6 · `trading`,`spot`,`swap`,`future`,`futures`,`margin`,`option`→18 (торговый) |
| Bitget (`bitget`) | **`funding`,`spot`→spot** · `swap`→usdt_futures (USDT-M) · `usdc_swap`→usdc_futures · `future`→coin_futures (**не** USDT-M) · `cross`→crossed_margin · `isolated`→isolated_margin · `p2p` · `uta`,`unified`→uta |
| WhiteBIT (`whitebit`) | `funding`,`main`→main · `spot`,`trade`→spot · `margin`→collateral |
| BingX (`bingx`) | `funding`→fund · `spot`→spot · **`future`→stdFutures** (стандартные фьючерсы) · **`swap`,`linear`→USDTMPerp** (USDT-M perpetual) · `inverse`→coinMPerp |
| MEXC (`mexc`) | `spot`→SPOT · `swap`,`future`→FUTURES (маппинг внутри `transfer`, офлайн-запрос проверен) |
| KuCoin (`kucoin`) | `funding`,`main`→main · `spot`→trade · `hf`→trade_hf · `margin`,`cross`,`marginV2`→margin · `isolated` · `future`,`swap`,`contract`→contract · `uta`,`unified`→unified · `mining`→pool |
| Hyperliquid | не используется (только мониторинг) |

Перед переводом Bitget и KuCoin сами проверяют режим UTA, а Bybit генерирует свой
`transferId`. Переменные окружения ключей описаны в [`security.md`](security.md).

## Где брать данные сети

| Биржа | Источник | Поля | Статус |
|---|---|---|---|
| Bitget | `call_read_method … fetchDepositWithdrawFee ["USDT"] includeInfo` | `info.chains[]`: `chain`, `withdrawable`, `rechargeable`, `minWithdrawAmount`, `minDepositAmount`, `withdrawFee`, `extraWithdrawFee`, `contractAddress`, `needTag`, `browserUrl` | проверено публично |
| WhiteBIT | то же | `info["USDT (<NET>)"]`: `is_withdrawal`, `is_api_withdrawal`, `is_depositable`, `is_api_depositable`, `withdraw.min_amount/max_amount/fixed/flex` (`flex` — процентная часть), `deposit.min_amount`; **контракта нет** | проверено публично |
| KuCoin | `call_implicit_get {"exchange":"kucoin","method":"publicGetCurrenciesCurrency","params":{"currency":"USDT"}}` | `data.chains[]`: `chainId` (`trx`,`bsc`,`eth`,`ton`), `chainName`, `isDepositEnabled`, `isWithdrawEnabled`, `depositMinSize` (`null` = неизвестно), `withdrawalMinSize`, `withdrawalMinFee`, `contractAddress`, `needTag` | проверено публично |
| KuCoin, комиссия | `fetchDepositWithdrawFee` с `"params":{"network":"<код>"}` | только вывод; без `network` — цепочка по умолчанию (проверено: `chain` уходит только с `network`) | тест на аккаунте |
| Gate | `call_implicit_get {"exchange":"gate","method":"publicWalletGetCurrencyChains","params":{"currency":"USDT"}}` | `chain`, `is_deposit_disabled`, `is_withdraw_disabled`, `contract_address`, `withdraw_amount_min`, `is_tag`; **минимума депозита нет** | проверено публично |
| Gate, комиссия | `fetchDepositWithdrawFee` (withdraw status) | только комиссии вывода, флагов депозита нет | тест на аккаунте |
| Binance, Bybit, OKX, MEXC | `fetchDepositWithdrawFee ["USDT"] includeInfo` | без ключа `AUTH_FAILED` | тест на аккаунте |
| BingX | то же | публичный ответ `null` | тест на аккаунте |

`fetchCurrencies` для выбора сети не годится. У Gate, Bitget, WhiteBIT и KuCoin ответ целиком
заменяется маркером усечения, а Binance, Bybit, OKX, MEXC и BingX без ключа вернули `{}`.

**Gate как получатель — только вручную.** Минимум депозита Gate по API недоступен, поэтому
агент не вызывает `withdraw` на Gate. Человек открывает страницу депозита Gate (сеть, минимум,
контракт, адрес) и сам отправляет вывод из интерфейса биржи A или из кошелька. Агент даёт
данные `currency_chains`, сверяет депозит Gate по хешу транзакции (SKILL.md, 2.7) и дальше может
выполнить сценарий 3 на Gate.

## Исходящий withdraw (проверено офлайн, ccxt-mcp 0.1.3 + ccxt 4.5.85)

Ниже — что реально уходит в запросе биржи при `network: "<код>"` и `tag`. Значения не зависят
от живых данных: у кода есть статический маппинг, а у WhiteBIT строка передаётся без изменений.
Других пар нет. В частности, `ARBONE` у всех бирж и `TRC20`/`BEP20`/`ERC20`/`TON` у BingX
зависят от живых данных и **не проверены**, поэтому вывод там только вручную.

| Биржа | `TRC20` | `BEP20` | `ERC20` | `TON` | memo уходит как | `params` (ровно) |
|---|---|---|---|---|---|---|
| Binance | `network=TRX` | `BSC` | `ETH` | `TON` | `addressTag` | `{}` |
| Bybit | `chain=TRX` | `BSC` | `ETH` | `TON` | `tag` | `{"accountType":"FUND"}` или `{"accountType":"UTA"}` — кошелёк, где лежат USDT; без него ccxt сам выбирает UTA или SPOT по своему запросу режима |
| Gate | `chain=TRX` | `BSC` | `ETH` | `TON` | `memo` | `{}` |
| OKX | `chain=USDT-TRC20` | `USDT-BSC` | `USDT-ERC20` | `USDT-TON` | `toAddr=<адрес>:<memo>` | `{"fee":"<точная f>"}` (уходит как `fee`) |
| Bitget | `chain=TRC20` | `BSC` | `ERC20` | `TON` | `tag` | `{"uta":true}` или `{"uta":false}` по проверенному режиму; без него ccxt считает аккаунт classic при любой ошибке проверки |
| WhiteBIT | `network=` ровно переданная строка: передавай `<NET>` из ключа `"USDT (<NET>)"` (`TRC20`, `BEP20`, `ERC20`, `TON`) | | | | `memo` | `{}` |
| BingX | только вручную | | | | — | — |
| MEXC | `netWork=TRX` | `BSC`¹ | `ETH` | `TONCOIN`¹ | `memo` | `{}` |
| KuCoin | `chain=trx` | `bsc` | `eth` | `ton` | `memo` | `{}`; `network` обязателен, без него уходит цепочка по умолчанию |

Исходящее значение должно совпасть с id этой сети в живом ответе A. Иначе — стоп.
¹ MEXC может отдавать для BEP20 и TON устаревший длинный id (например,
`BNB Smart Chain(BEP20)`). Пара годится, только если в живом ответе A id ровно `BSC` или
`TONCOIN`; иначе вывод вручную.

## Шаг суммы (ccxt 4.5.85, проверено офлайн)

Как ccxt меняет `amount` перед отправкой. «Валюта» и «сеть» — шаги из данных валют ccxt;
округление математическое (может вверх), у Binance — вниз.

| Биржа | `withdraw` | `transfer` |
|---|---|---|
| Binance | по шагу сети, вниз | по шагу валюты, вниз |
| Bybit | без изменений | по шагу валюты |
| Gate | по шагу валюты, в ccxt зашит `0.0001` | то же |
| OKX | без изменений | по шагу валюты |
| Bitget | по шагу сети | без изменений, числом |
| WhiteBIT | по шагу валюты | по шагу валюты |
| BingX | только вручную | по шагу валюты |
| MEXC | без изменений, числом | без изменений, числом |
| KuCoin | по шагу сети, затем числом | по шагу валюты |

Шаг сети ccxt берёт из поля биржи: Binance `withdrawIntegerMultiple`, Bybit `minAccuracy`, OKX
`wdTickSz`, Bitget `withdrawMinScale`, BingX и KuCoin `withdrawPrecision`; у Gate зашит
`0.0001`, у MEXC не задан. Шаг валюты — явное поле (KuCoin `precision`, WhiteBIT
`currency_precision`, Gate `0.0001`), иначе самый крупный шаг среди всех сетей USDT этой биржи.
«Без изменений» не отменяет шаг самой биржи: его тоже нужно знать (SKILL.md, 2.3).

## Модель комиссии вывода

По умолчанию она **не подтверждена** (см. SKILL.md, 2.3). Что известно из кода ccxt 4.5.85:

- KuCoin отправляет `feeDeductType: "INTERNAL"` только при `params.includeFee: true` (проверено),
  иначе действует умолчание биржи. `includeFee` не используем;
- OKX без `params.fee` берёт комиссию из данных валют ccxt (`GET /asset/currencies`, объединённый
  с кешем загрузки);
- WhiteBIT `flex` — процентная составляющая.

Ни одно из этого не делает модель подтверждённой.

## Режим аккаунта и доступная сумма (тест на аккаунте)

Режим и доступную сумму читай unified-методами с `includeInfo: true` и цитируй найденное поле в
плане.

| Биржа | Откуда режим | Откуда доступная сумма | Депозит / вывод (типично, проверить) |
|---|---|---|---|
| Binance | `fetchBalance` по `type` (`spot`, `funding`, `linear`); Portfolio Margin — по кабинету | raw `fetchBalance` нужного кошелька | spot / spot |
| Bybit | raw `fetchBalance` (UTA или classic) | raw `fetchBalance` `type: unified|funding` | funding / `accountType` из плана |
| Gate | raw `fetchBalance` (classic или unified) | raw `fetchBalance` | spot / spot |
| OKX | `fetchAccounts` (raw `acctLv`) | raw `fetchBalance` `type: funding|trading` | funding / funding |
| Bitget | raw `fetchBalance` (classic или `uta`) | raw `fetchBalance` | spot / spot (`uta` из плана) |
| WhiteBIT | — | raw `fetchBalance` | main / main |
| BingX | raw `fetchBalance` по кошелькам | raw `fetchBalance` | проверить / только вручную |
| MEXC | — | raw `fetchBalance` | spot / spot |
| KuCoin | `fetchAccounts` (classic или UTA) | raw `fetchBalance` | main / main |

Если в ответе нет поля, которое биржа документирует как доступное к переводу или выводу в этом
режиме, — стоп. `free` таким полем не считается.

Типовой маршрут: A `transfer` из торгового кошелька в кошелёк вывода → A `withdraw` →
зачисление в кошелёк депозита B → B `transfer` в торговый кошелёк.
`fetchDeposits` и `fetchWithdrawals` есть у всех девяти; `fetchTransfers` отсутствует у Gate и
WhiteBIT, `fetchLedger` — у WhiteBIT, BingX и MEXC. `certified: false` только у WhiteBIT.

## Hyperliquid (только мониторинг)

Публичные чтения по `walletAddress` или `params.user` работают без подписи. Это
`fetchBalance` (perp, USDC), `fetchBalance` с `type: "spot"` и `fetchPositions`. Поля маржи
(`marginSummary`, `crossMarginSummary`, `crossMaintenanceMarginUsed`, `withdrawable`) приходят
только с `includeInfo: true`. Перед `fetchBalance` ccxt запрашивает `userAbstraction`. Если он
равен `unifiedAccount`, читается spot-состояние без полей маржи, и мониторинг маржи
останавливается. `fetchDepositWithdrawFee` не поддерживается, USDT-маршрутов нет.
