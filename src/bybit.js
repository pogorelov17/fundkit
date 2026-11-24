import crypto from 'node:crypto';
import { SafeError } from './errors.js';

// Bybit V5 REST client (HMAC). Docs: https://bybit-exchange.github.io/docs/v5/guide
// Credentials come only from the environment (.env / Doppler); they are never logged,
// returned to the browser, or written into chat state. Remote free text (retMsg, statusText,
// bodies) is never copied into errors, logs or state — only numeric codes.

/** Official mainnet REST hosts listed in the V5 guide (global + regional entities). */
export const BYBIT_PRODUCTION_HOSTS = new Set([
  'api.bybit.com',
  'api.bytick.com',
  'api.bybit.tr',
  'api.bybit.kz',
  'api.bybitgeorgia.ge',
  'api.bybit.ae',
  'api.bybit.eu',
  'api.bybit.id',
  'api.manepa.jp',
  'api.spark-fintech.com',
]);

/**
 * Only code (never env/config) can point the client at a mock: pass `mockOnly: MOCK_ONLY`.
 * Environment-provided BYBIT_BASE_URL must be one of the production HTTPS hosts above.
 */
export const MOCK_ONLY = Symbol('fundkit-mock-only');

export function assertBybitBaseUrl(baseUrl) {
  let u;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new SafeError('BYBIT_BASE_URL is not a URL');
  }
  if (u.protocol !== 'https:' || !BYBIT_PRODUCTION_HOSTS.has(u.hostname) || u.port || u.username || u.password ||
      (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
    throw new SafeError(`BYBIT_BASE_URL must be one of: ${[...BYBIT_PRODUCTION_HOSTS].map((h) => 'https://' + h).join(', ')}`);
  }
  return `https://${u.hostname}`;
}

export class BybitError extends SafeError {
  constructor(path, retCode) {
    super(`Bybit ${path} failed (retCode ${retCode})`);
    this.retCode = retCode;
    this.path = path;
  }
}

export class BybitClient {
  constructor({ apiKey, apiSecret, baseUrl = 'https://api.bybit.com', recvWindow = 5000, timeoutMs = 10_000, mockOnly }) {
    if (!apiKey || !apiSecret) throw new SafeError('BYBIT_API_KEY and BYBIT_API_SECRET must be set in the environment');
    this.baseUrl = mockOnly === MOCK_ONLY ? String(baseUrl).replace(/\/$/, '') : assertBybitBaseUrl(baseUrl);
    this.recvWindow = String(recvWindow);
    this.timeoutMs = timeoutMs;
    this.timeOffset = 0;
    // Keep secrets off enumerable props so accidental JSON.stringify(client) cannot leak them.
    Object.defineProperty(this, '_key', { value: apiKey, enumerable: false });
    Object.defineProperty(this, '_secret', { value: apiSecret, enumerable: false });
  }

  static fromEnv(env = process.env) {
    return new BybitClient({
      apiKey: env.BYBIT_API_KEY,
      apiSecret: env.BYBIT_API_SECRET,
      baseUrl: env.BYBIT_BASE_URL || 'https://api.bybit.com',
    });
  }

  toJSON() {
    return { baseUrl: this.baseUrl };
  }

  /** Purpose-bound key derived from the API secret (used to authenticate chat state). */
  deriveKey(label) {
    return crypto.createHmac('sha256', this._secret).update(label).digest();
  }

  sign(payload, timestamp) {
    return crypto
      .createHmac('sha256', this._secret)
      .update(timestamp + this._key + this.recvWindow + payload)
      .digest('hex');
  }

  async syncTime() {
    const res = await fetch(`${this.baseUrl}/v5/market/time`, { signal: AbortSignal.timeout(this.timeoutMs) });
    const body = await res.json();
    const serverMs = Number(body?.result?.timeNano ? BigInt(body.result.timeNano) / 1_000_000n : body.time);
    if (Number.isFinite(serverMs)) this.timeOffset = serverMs - Date.now();
  }

  async request(method, path, params = {}) {
    const timestamp = String(Date.now() + this.timeOffset);
    let url = `${this.baseUrl}${path}`;
    let body;
    let payload;
    if (method === 'GET') {
      const qs = new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
      ).toString();
      payload = qs;
      if (qs) url += `?${qs}`;
    } else {
      body = JSON.stringify(params);
      payload = body;
    }
    const res = await fetch(url, {
      method,
      body,
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'X-BAPI-API-KEY': this._key,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': this.recvWindow,
        'X-BAPI-SIGN': this.sign(payload, timestamp),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new BybitError(path, `HTTP${res.status}`);
    let json;
    try {
      json = await res.json();
    } catch {
      throw new BybitError(path, 'BADJSON');
    }
    if (json?.retCode !== 0) throw new BybitError(path, Number.isInteger(json?.retCode) ? json.retCode : 'UNKNOWN');
    return json.result;
  }

  // --- endpoints used by the flow ---
  apiKeyInfo() {
    return this.request('GET', '/v5/user/query-api');
  }
  accountInfo() {
    return this.request('GET', '/v5/account/info');
  }
  coinInfo(coin) {
    return this.request('GET', '/v5/asset/coin/query-info', { coin });
  }
  depositAddress(coin, chain) {
    // `chainType` takes the `chain` value from coin-info (per docs).
    return this.request('GET', '/v5/asset/deposit/query-address', { coin, chainType: chain });
  }
  /** startTime/endTime ms, endTime-startTime < 30 days; limit <= 50; cursor pagination. */
  depositRecords({ coin, txID, startTime, endTime, limit = 50, cursor }) {
    return this.request('GET', '/v5/asset/deposit/query-record', { coin, txID, startTime, endTime, limit, cursor });
  }
  interTransfer({ transferId, coin, amount, fromAccountType, toAccountType }) {
    return this.request('POST', '/v5/asset/transfer/inter-transfer', {
      transferId,
      coin,
      amount,
      fromAccountType,
      toAccountType,
    });
  }
  /** Window is mandatory here: endTime-startTime <= 7 days (docs); defaults would only cover the last 7 days. */
  transferList({ transferId, coin, startTime, endTime, limit = 50, cursor }) {
    return this.request('GET', '/v5/asset/transfer/query-inter-transfer-list', { transferId, coin, startTime, endTime, limit, cursor });
  }
}

// https://bybit-exchange.github.io/docs/v5/enum#depositstatus
export const DEPOSIT_STATUS = {
  0: 'unknown',
  1: 'toBeConfirmed',
  2: 'processing',
  3: 'success',
  4: 'failed',
  7: 'rollbackProcessing',
  70011: 'rolledBack',
  70012: 'rollbackNoClawback',
  70013: 'rollbackFailedManualReview',
  10011: 'pendingFundingPool',
  10012: 'creditedFundingPool',
};
export const DEPOSIT_TYPE = { 0: 'normal', 10: 'dailyLimitReached', 20: 'amlHit', 50: 'complianceBlocked' };

/**
 * Classify a deposit row. Conservative: only 3 (success) and 70012 (remains successful after rollback
 * review) count as credited. 7 / 70013 (rollback in progress / manual review) and 10012 (funding pool,
 * not a plain account credit) are held; unknown codes are held too.
 */
export function classifyDeposit(row) {
  const status = Number(row.status);
  const type = String(row.depositType ?? '0');
  if (type !== '0' && type !== '') return { kind: 'held', why: `depositType ${DEPOSIT_TYPE[type] || type}` };
  for (const [k, v] of Object.entries(row)) {
    if (/travel/i.test(k) && v !== null && v !== '' && String(v) !== '0') return { kind: 'held', why: 'travel rule review' };
  }
  if (status === 3 || status === 70012) return { kind: 'credited', why: DEPOSIT_STATUS[status] };
  if ([0, 1, 2, 10011].includes(status)) return { kind: 'pending', why: DEPOSIT_STATUS[status] };
  if (status === 4 || status === 70011) return { kind: 'failed', why: DEPOSIT_STATUS[status] };
  return { kind: 'held', why: DEPOSIT_STATUS[status] || `status ${Number.isFinite(status) ? status : '?'}` };
}

/** Bybit may report a BSC txID with or without 0x and in any case. */
export function normalizeTxId(id) {
  const s = String(id ?? '').trim().toLowerCase();
  const h = s.startsWith('0x') ? s.slice(2) : s;
  return /^[0-9a-f]{64}$/.test(h) ? h : null;
}

// Error classification for POST inter-transfer (https://bybit-exchange.github.io/docs/v5/error)
export const TRANSFER_DUPLICATE = 131214; // "TransferId exist"
export const TRANSFER_PERMANENT = new Set([
  10001, 10003, 10004, 10005, 10010, 33004, 131202, 131203, 131204, 131206, 131207, 131208, 131209, 131210, 131211,
  131212, 131213, 131215, 131217, 131226, 131227, 131228, 131229, 131231, 131232, 131233,
]);

/** Deterministic UUID from a seed so every resume (any snapshot, any process) reuses the same transferId. */
export function deterministicUuid(seed) {
  const h = crypto.createHash('sha256').update(seed).digest();
  h[6] = (h[6] & 0x0f) | 0x50; // version 5-style
  h[8] = (h[8] & 0x3f) | 0x80; // RFC 4122 variant
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
