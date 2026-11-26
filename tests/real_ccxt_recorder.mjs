// Test-only launcher for the pinned ccxt-mcp (tests/test_real_ccxt_mcp.py). It replaces ccxt's
// transport with a recorder before the real server starts: every request line and a sha256 of the
// API-key header go to $HOME/wire.jsonl, GETs are answered locally (key checks with metadata that
// also names a synthetic UID, which fundkit ignores), anything else throws, and nothing is sent.
// The test writes the two module paths to $HOME/real-ccxt-paths.json, because a profile process
// inherits no other variable.

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
const KEY_CHECK_ANSWERS = {
  '/api/v5/account/config': { code: '0', data: [{ uid: 'UID-REAL-OKX', perm: 'read_only,withdraw' }] },
  '/v5/user/query-api': { retCode: 0, retMsg: 'OK', result: { userID: 'UID-REAL-BYBIT', readOnly: 0 } },
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
  // Bybit's coin list, so ccxt can build a withdrawal (which the recorder then refuses to send).
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
              withdrawFee: '0.3',
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
      ],
    },
  },
};
const EMPTY_ANSWER = { retCode: 0, retMsg: 'OK', result: { list: [], rows: [] }, code: '0', data: [] };

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

ccxt.Exchange.prototype.fetch = async function recordInsteadOfSending(url, method = 'GET', headers = {}) {
  const upper = Object.fromEntries(
    Object.entries(headers ?? {}).map(([name, value]) => [name.toUpperCase(), value]),
  );
  const key = KEY_HEADERS.map((name) => upper[name]).find(Boolean);
  const requestPath = new URL(url).pathname;
  const line = {
    id: this.id,
    method,
    path: requestPath,
    signed: Boolean(key),
    keyHash: key ? sha256(key) : null,
  };
  fs.appendFileSync(path.join(HOME, 'wire.jsonl'), `${JSON.stringify(line)}\n`);
  if (method !== 'GET') throw new ccxt.NetworkError('recorder: only GET is answered, nothing is sent');
  // Binance's market and currency endpoints expect lists where the other venues expect objects.
  return KEY_CHECK_ANSWERS[requestPath] ?? (this.id === 'binance' ? [] : EMPTY_ANSWER);
};

await import(pathToFileURL(serverEntry).href);
