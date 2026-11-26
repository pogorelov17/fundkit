// Test-only launcher for the pinned ccxt-mcp (tests/test_real_ccxt_mcp.py). It replaces ccxt's
// transport with a recorder before the real server starts: every request line and a sha256 of the
// API-key header go to $HOME/wire.jsonl, GETs are answered locally (key checks with metadata that
// also names a synthetic UID, which fundkit ignores), anything else throws, and nothing is sent.
// The test writes the two module paths to $HOME/real-ccxt-paths.json, because a profile process
// inherits no other variable. $HOME/recorder-overrides.json, when present, replaces answers by path
// for the requests after it is written (a venue changing between two reads). An answer keyed
// `<path>?coin=<COIN>` wins over `<path>` for a request with that `coin` query parameter, so the
// USDT and USDC address reads get their own answers; each wire line also records that `coin`.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOME = process.env.HOME;
const { ccxtEntry, serverEntry } = JSON.parse(
  fs.readFileSync(path.join(HOME, 'real-ccxt-paths.json'), 'utf8'),
);
const ccxt = await import(pathToFileURL(ccxtEntry).href);

const KEY_HEADERS = ['OK-ACCESS-KEY', 'X-BAPI-API-KEY', 'X-MBX-APIKEY'];
const BINANCE_BSC = '0x1b6C0d8D0aF0A3a0b6F6e4E5bC6a7F2d3C4e5F60';
const BINANCE_BSC_USDC = '0x3d4E5f60718293a4B5c6D7e8F9a0B1c2D3e4F5a6';
const USDC_BSC = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d';
const KEY_CHECK_ANSWERS = {
  '/api/v5/account/config': { code: '0', data: [{ uid: 'UID-REAL-OKX', perm: 'read_only,withdraw' }] },
  '/v5/user/query-api': {
    retCode: 0,
    retMsg: 'OK',
    result: {
      userID: 'UID-REAL-BYBIT',
      readOnly: 0,
      permissions: { Wallet: ['AccountTransfer', 'Withdraw'] },
      isMaster: true,
      ips: ['*'],
    },
  },
  // Binance: key check, coin list and the two address reads of fundkit_deposit_address (BSC).
  '/sapi/v1/account/apiRestrictions': { ipRestrict: true, enableReading: true, enableWithdrawals: true },
  '/sapi/v1/capital/config/getall': [
    {
      coin: 'USDT',
      name: 'TetherUS',
      networkList: [
        {
          network: 'BSC',
          coin: 'USDT',
          name: 'BNB Smart Chain (BEP20)',
          contractAddress: '0x55d398326f99059ff775485246999027b3197955',
          contractAddressUrl: 'https://bscscan.com/token/',
          depositEnable: true,
          withdrawEnable: true,
          withdrawFee: '0.29',
          withdrawMin: '10',
          withdrawMax: '9999999',
          withdrawIntegerMultiple: '0.00000001',
          isDefault: false,
        },
      ],
    },
    {
      coin: 'USDC',
      name: 'USD Coin',
      networkList: [
        {
          network: 'BSC',
          coin: 'USDC',
          name: 'BNB Smart Chain (BEP20)',
          contractAddress: USDC_BSC,
          contractAddressUrl: 'https://bscscan.com/token/',
          depositEnable: true,
          withdrawEnable: true,
          withdrawFee: '0.29',
          withdrawMin: '10',
          withdrawMax: '9999999',
          withdrawIntegerMultiple: '0.00000001',
          isDefault: false,
        },
      ],
    },
  ],
  '/sapi/v1/capital/deposit/address?coin=USDC': {
    address: BINANCE_BSC_USDC,
    coin: 'USDC',
    tag: '',
    url: `https://bscscan.com/address/${BINANCE_BSC_USDC}`,
  },
  '/sapi/v1/capital/deposit/address/list?coin=USDC': [
    { coin: 'USDC', address: BINANCE_BSC_USDC, tag: '', isDefault: 1 },
    { coin: 'USDC', address: '0x9999999999999999999999999999999999999999', tag: '', isDefault: 0 },
  ],
  '/sapi/v1/capital/deposit/address': {
    address: BINANCE_BSC,
    coin: 'USDT',
    tag: '',
    url: `https://bscscan.com/address/${BINANCE_BSC}`,
  },
  '/sapi/v1/capital/deposit/address/list': [
    { coin: 'USDT', address: BINANCE_BSC, tag: '', isDefault: 1 },
    { coin: 'USDT', address: '0x9999999999999999999999999999999999999999', tag: '', isDefault: 0 },
  ],
  // Bybit's coin list, so ccxt can build a withdrawal (which the recorder then refuses to send),
  // with the real thread's BSC withdrawal fee (0.15 on top) and minimum (10).
  '/v5/asset/coin/query-info': {
    retCode: 0,
    retMsg: 'OK',
    result: {
      rows: [
        {
          name: 'USDT',
          coin: 'USDT',
          remainAmount: '1000000',
          chains: [
            {
              chainType: 'BSC (BEP20)',
              confirmation: '15',
              withdrawFee: '0.15',
              depositMin: '1',
              withdrawMin: '10',
              chain: 'BSC',
              chainDeposit: '1',
              chainWithdraw: '1',
              minAccuracy: '4',
              withdrawPercentageFee: '0',
              contractAddress: '0x55d398326f99059ff775485246999027b3197955',
            },
          ],
        },
        {
          name: 'USDC',
          coin: 'USDC',
          remainAmount: '1000000',
          chains: [
            {
              chainType: 'BSC (BEP20)',
              confirmation: '15',
              withdrawFee: '0.15',
              depositMin: '1',
              withdrawMin: '10',
              chain: 'BSC',
              chainDeposit: '1',
              chainWithdraw: '1',
              minAccuracy: '4',
              withdrawPercentageFee: '0',
              contractAddress: USDC_BSC,
            },
          ],
        },
      ],
    },
  },
};
KEY_CHECK_ANSWERS['/v5/asset/transfer/query-account-coins-balance'] = {
  retCode: 0,
  retMsg: 'OK',
  result: {
    memberId: 'UID-REAL-BYBIT',
    accountType: 'FUND',
    balance: [
      { coin: 'USDT', transferBalance: '812.44', walletBalance: '812.44', bonus: '' },
      { coin: 'USDC', transferBalance: '812.44', walletBalance: '812.44', bonus: '' },
    ],
  },
};
const EMPTY_ANSWER = { retCode: 0, retMsg: 'OK', result: { list: [], rows: [] }, code: '0', data: [] };

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

ccxt.Exchange.prototype.fetch = async function recordInsteadOfSending(url, method = 'GET', headers = {}) {
  const upper = Object.fromEntries(
    Object.entries(headers ?? {}).map(([name, value]) => [name.toUpperCase(), value]),
  );
  const key = KEY_HEADERS.map((name) => upper[name]).find(Boolean);
  const parsed = new URL(url);
  const requestPath = parsed.pathname;
  const coin = parsed.searchParams.get('coin');
  const line = {
    id: this.id,
    method,
    path: requestPath,
    coin,
    signed: Boolean(key),
    keyHash: key ? sha256(key) : null,
  };
  fs.appendFileSync(path.join(HOME, 'wire.jsonl'), `${JSON.stringify(line)}\n`);
  if (method !== 'GET') throw new ccxt.NetworkError('recorder: only GET is answered, nothing is sent');
  // Binance's market and currency endpoints expect lists where the other venues expect objects.
  let overrides = {};
  try {
    overrides = JSON.parse(fs.readFileSync(path.join(HOME, 'recorder-overrides.json'), 'utf8'));
  } catch {
    // no overrides
  }
  const byCoin = coin ? `${requestPath}?coin=${coin}` : null;
  for (const answers of [overrides, KEY_CHECK_ANSWERS]) {
    if (byCoin && Object.hasOwn(answers, byCoin)) return answers[byCoin];
    if (Object.hasOwn(answers, requestPath)) return answers[requestPath];
  }
  return this.id === 'binance' ? [] : EMPTY_ANSWER;
};

await import(pathToFileURL(serverEntry).href);
