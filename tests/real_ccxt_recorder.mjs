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
const KEY_CHECK_ANSWERS = {
  '/api/v5/account/config': { code: '0', data: [{ uid: 'UID-REAL-OKX', perm: 'read_only,withdraw' }] },
  '/v5/user/query-api': { retCode: 0, retMsg: 'OK', result: { userID: 'UID-REAL-BYBIT', readOnly: 0 } },
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
  return KEY_CHECK_ANSWERS[requestPath] ?? EMPTY_ANSWER;
};

await import(pathToFileURL(serverEntry).href);
