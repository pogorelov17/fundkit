import crypto from 'node:crypto';

// Bybit V5 REST client (HMAC). Docs: https://bybit-exchange.github.io/docs/v5/guide
// Credentials come only from the environment (.env / Doppler); they are never logged,
// returned to the browser, or written into chat state.

export class BybitError extends Error {
  constructor(path, retCode, retMsg) {
    super(`Bybit ${path}: retCode=${retCode} ${retMsg}`);
    this.retCode = retCode;
    this.path = path;
  }
}

export class BybitClient {
  constructor({ apiKey, apiSecret, baseUrl = 'https://api.bybit.com', recvWindow = 5000, timeoutMs = 10_000 }) {
    if (!apiKey || !apiSecret) throw new Error('BYBIT_API_KEY and BYBIT_API_SECRET must be set in the environment');
    this.baseUrl = baseUrl.replace(/\/$/, '');
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
      headers: {
        'content-type': 'application/json',
        'X-BAPI-API-KEY': this._key,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': this.recvWindow,
        'X-BAPI-SIGN': this.sign(payload, timestamp),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new BybitError(path, `HTTP${res.status}`, res.statusText);
    const json = await res.json();
    if (json.retCode !== 0) throw new BybitError(path, json.retCode, json.retMsg);
    return json.result;
  }

  // --- endpoints used by the flow ---
  apiKeyInfo() {
    return this.request('GET', '/v5/user/query-api');
  }
  coinInfo(coin) {
    return this.request('GET', '/v5/asset/coin/query-info', { coin });
  }
  depositAddress(coin, chain) {
    // `chainType` takes the `chain` value from coin-info (per docs).
    return this.request('GET', '/v5/asset/deposit/query-address', { coin, chainType: chain });
  }
  depositRecords({ coin, txID, startTime, endTime, limit = 50 }) {
    return this.request('GET', '/v5/asset/deposit/query-record', { coin, txID, startTime, endTime, limit });
  }
  coinBalance(accountType, coin) {
    return this.request('GET', '/v5/asset/transfer/query-account-coin-balance', { accountType, coin });
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
  transferList({ transferId, coin }) {
    return this.request('GET', '/v5/asset/transfer/query-inter-transfer-list', { transferId, coin });
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
export const DEPOSIT_SUCCESS = new Set([3, 70012]);
export const DEPOSIT_TERMINAL_BAD = new Set([4, 70011]);
export const DEPOSIT_TYPE = { 0: 'normal', 10: 'dailyLimitReached', 20: 'amlHit', 50: 'complianceBlocked' };

/** Deterministic UUID from a seed so a retried funding->unified transfer reuses the same transferId. */
export function deterministicUuid(seed) {
  const h = crypto.createHash('sha256').update(seed).digest();
  h[6] = (h[6] & 0x0f) | 0x50; // version 5-style
  h[8] = (h[8] & 0x3f) | 0x80; // RFC 4122 variant
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
