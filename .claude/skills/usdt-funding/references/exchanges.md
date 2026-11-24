# Биржи: кошельки, сети, режимы (ccxt 4.5.94)

**Проверено** — без ключей: по коду ccxt 4.5.94 или публичным ответом через ccxt-mcp.
**Тест на аккаунте** — то, что видно только с ключом пользователя: режим аккаунта, права ключа,
включённость сетей, реальные комиссии и минимумы, поле доступной суммы. Пока такой тест не
сделан, всё это **неизвестно**.

## Кошельки для `transfer` (`options.accountsByType`)

Слева имя, которое передаётся в `fromAccount`/`toAccount`, справа id кошелька на бирже.
Разные имена с одним id — **алиасы одного кошелька**.

| Биржа (`exchange`) | Имена → id кошелька |
|---|---|
| Binance (`binance`) | `main`,`spot`→MAIN · `funding`→FUNDING · `margin`,`cross`→MARGIN · `linear`,`swap`→UMFUTURE (USDⓈ-M) · `inverse`→CMFUTURE · `option`→OPTION |
| Bybit (`bybit`) | `funding`,`fund`→FUND · `unified`→UNIFIED (UTA) · `spot`,`margin`→SPOT · `contract`,`swap`,`future`→CONTRACT (classic) · `option` · `investment` |
| Gate (`gate`) | **`funding`,`spot`→spot** (отдельного funding нет) · `margin`,`isolated`→margin · `cross_margin`,`cross`→cross_margin · `swap`,`futures`→futures · `future`,`delivery`→delivery · `option`,`options`→options |
| OKX (`okx`) | `funding`→6 · `trading`,`spot`,`swap`,`future`,`futures`,`margin`,`option`→18 (торговый) |
| Bitget (`bitget`) | **`funding`,`spot`→spot** · `swap`→usdt_futures (USDT-M) · `usdc_swap`→usdc_futures · `future`→coin_futures (**не** USDT-M) · `cross`→crossed_margin · `isolated`→isolated_margin · `p2p` · `uta`,`unified`→uta |
| WhiteBIT (`whitebit`) | `funding`,`main`→main · `spot`,`trade`→spot · `margin`→collateral |
| BingX (`bingx`) | `funding`→fund · `spot`→spot · **`future`→stdFutures** (стандартные фьючерсы) · **`swap`,`linear`→USDTMPerp** (USDT-M perpetual) · `inverse`→coinMPerp |
| MEXC (`mexc`) | `spot`→SPOT · `swap`,`future`→FUTURES |
| KuCoin (`kucoin`) | `funding`,`main`→main · `spot`→trade · `hf`→trade_hf · `margin`,`cross`,`marginV2`→margin · `isolated` · `future`,`swap`,`contract`→contract · `uta`,`unified`→unified · `mining`→pool |
| Hyperliquid | не используется (только мониторинг) |

Env-переменные сервера: `<EXCHANGE>_APIKEY`, `<EXCHANGE>_SECRET`, а для OKX, Bitget и KuCoin
ещё `<EXCHANGE>_PASSWORD` (API passphrase). Для Gate id — `gate` (`GATE_*`); алиаса `gateio` в
4.5.94 нет.

## Сети USDT: где лежат поля

Пользуйся `fetchDepositWithdrawFee` с `args:["USDT"]` и `includeInfo:true`. В unified-части
есть только `networks.<NET>.withdraw.fee` и `deposit.fee`, остальное ищи в `info`.

| Биржа | Поля в `info` | Статус |
|---|---|---|
| Bitget | `chains[]`: `withdrawable`, `rechargeable`, `minWithdrawAmount`, `minDepositAmount`, `withdrawFee`, `extraWithdrawFee`, `contractAddress`, `needTag`, `withdrawMinScale` | проверено публично |
| WhiteBIT | `"USDT (<NET>)"`: `is_withdrawal`, `is_api_withdrawal`, `is_depositable`, `is_api_depositable`, `withdraw.min_amount/max_amount/fixed/flex` (`flex` — процентная часть), `deposit.min_amount`; **контракта нет** | проверено публично |
| BingX | публичный ответ пуст | тест на аккаунте |
| Binance, Bybit, OKX, Gate, KuCoin, MEXC | без ключа `AUTH_FAILED` | тест на аккаунте |

Если биржа не отдаёт контракт (как WhiteBIT), напиши в плане «контракт не подтверждён
<биржей>» и попроси человека сверить его в интерфейсе. Не додумывай.

`fetchCurrencies` для выбора сети не годится: ответ целиком заменяется маркером усечения. Без
ключа так было у Bitget, WhiteBIT, KuCoin и Gate, а Binance, Bybit, OKX, MEXC и BingX вернули
`{}`.

## Модель комиссии вывода

По умолчанию она **не подтверждена** (см. SKILL.md, 2.3). Что известно из кода ccxt 4.5.94:

- KuCoin отправляет `feeDeductType: "INTERNAL"` только при `params.includeFee: true`; иначе
  действует умолчание биржи;
- OKX сам подставляет `fee` из кэша валют, если его нет в `params`;
- WhiteBIT `flex` — процентная составляющая.

Ни одно из этого не делает модель подтверждённой.

## Режим аккаунта и доступная сумма (тест на аккаунте)

Raw-эндпоинты (`call_implicit_get`) в закреплённой связке недоступны, поэтому режим и доступную
сумму читай unified-методами с `includeInfo: true` и цитируй найденное поле в плане.

| Биржа | Откуда режим | Откуда доступная сумма | Депозит / вывод (типично, проверить) |
|---|---|---|---|
| Binance | `fetchBalance` по `type` (`spot`, `funding`, `linear`); Portfolio Margin — по кабинету | raw `fetchBalance` нужного кошелька | spot / spot |
| Bybit | raw `fetchBalance` (UTA или classic) | raw `fetchBalance` `type: unified|funding` | funding / funding |
| Gate | raw `fetchBalance` (classic или unified) | raw `fetchBalance` | spot / spot |
| OKX | `fetchAccounts` (raw `acctLv`) | raw `fetchBalance` `type: funding|trading` | funding / funding |
| Bitget | raw `fetchBalance` (classic или `uta`) | raw `fetchBalance` | spot / spot |
| WhiteBIT | — | raw `fetchBalance` | main / main |
| BingX | raw `fetchBalance` по кошелькам | raw `fetchBalance` | проверить / проверить |
| MEXC | — | raw `fetchBalance` | spot / spot |
| KuCoin | `fetchAccounts` (classic или UTA) | raw `fetchBalance` | main / main |

Если в ответе нет поля, которое биржа документирует как доступное к переводу или выводу в этом
режиме, — стоп. `free` таким полем не считается.

Типовой маршрут: A `transfer` из торгового кошелька в кошелёк вывода → A `withdraw` →
зачисление в кошелёк депозита B → B `transfer` в торговый кошелёк.
`fetchTransfers` отсутствует у Gate и WhiteBIT. `fetchLedger` отсутствует у WhiteBIT, BingX и
MEXC. `certified: false` только у WhiteBIT.

## Hyperliquid (только мониторинг)

Публичные чтения по `walletAddress` или `params.user` работают без подписи. Это
`fetchBalance` (perp, USDC), `fetchBalance` с `type: "spot"` и `fetchPositions`. Поля маржи
(`marginSummary`, `crossMarginSummary`, `crossMaintenanceMarginUsed`, `withdrawable`) приходят
только с `includeInfo: true`. `fetchDepositWithdrawFee` не поддерживается, USDT-маршрутов нет.
