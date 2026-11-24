// Mock of the Bybit V5 endpoints the flow uses, with real HMAC verification. Test credentials only.
// Error replies carry a deliberately "sensitive" retMsg to prove fundkit never copies remote text.
import http from 'node:http';
import crypto from 'node:crypto';
import { BSC_USDT, decodeTransfer, fromBaseUnits, sameAddress, toBaseUnits } from '../../public/erc20.js';
import { listen } from './bsc-chain.js';

export const TEST_KEY = 'mock-key-not-real';
export const TEST_SECRET = 'mock-secret-not-real';
export const LEAK_TEXT = 'SECRET-RETMSG-TEXT';
const DAY = 24 * 3600_000;

export class MockBybit {
  constructor(chain, opts = {}) {
    this.chain = chain;
    this.secret = opts.secret || TEST_SECRET;
    this.uid = opts.uid ?? 1001; // docs: userID is an integer
    this.uta = opts.uta ?? 1;
    this.unifiedMarginStatus = opts.unifiedMarginStatus ?? 5;
    this.readOnly = opts.readOnly ?? 0;
    this.permissions = opts.permissions || { Wallet: ['AccountTransfer'] };
    this.depositAddress = opts.depositAddress || '0x' + 'b0'.repeat(20);
    this.creditToUnified = !!opts.creditToUnified; // simulate an auto-transfer-after-deposit setting
    this.confirmPolls = opts.confirmPolls ?? 2; // record shows status 1 for N polls, then the final status
    this.finalStatus = opts.finalStatus ?? 3;
    this.depositType = opts.depositType ?? '0';
    this.extraRowFields = opts.extraRowFields || {};
    this.txIdForm = opts.txIdForm || '0x'; // '0x' | 'bare' | 'upper'
    this.txIdQueryBroken = !!opts.txIdQueryBroken; // txID filter returns nothing; only window scans work
    this.unrelatedDeposits = opts.unrelatedDeposits ?? 0; // noise rows for pagination
    this.contractAddress = opts.contractAddress ?? BSC_USDT;
    this.chainDeposit = opts.chainDeposit ?? '1';
    this.depositFee = opts.depositFee ?? '0';
    this.denyRead = !!opts.denyRead;
    const base = (x) => toBaseUnits(String(x), 18);
    this.balances = { FUND: base(opts.fund ?? 0), UNIFIED: 0n };
    this.deposits = new Map(); // txHash -> {polls, credited}
    this.transfers = new Map();
    this.transferCalls = 0;
    this.balanceCalls = 0;
    this.ambiguousNextTransfer = false; // perform transfer but answer HTTP 502
    this.failBeforeExecuteNext = false; // answer HTTP 502 WITHOUT performing the transfer
    this.listLag = 0; // hide transfer records from the list for N queries
    this.badSignatures = 0;
    this.windowViolations = 0;
    this.onAddressQuery = null;
  }

  handle(method, path, params) {
    switch (`${method} ${path}`) {
      case 'GET /v5/user/query-api':
        return { id: '1', userID: this.uid, readOnly: this.readOnly, permissions: this.permissions, ips: ['127.0.0.1'], uta: this.uta, isMaster: true, type: 1 };
      case 'GET /v5/account/info':
        return { unifiedMarginStatus: this.unifiedMarginStatus, marginMode: 'REGULAR_MARGIN' };
      case 'GET /v5/asset/coin/query-info':
        return {
          rows: [
            {
              coin: 'USDT',
              name: 'USDT',
              chains: [
                { chain: 'ETH', chainType: 'ERC20', chainDeposit: '1', contractAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7', depositMin: '0', minAccuracy: '8', confirmation: '6' },
                { chain: 'BSC', chainType: 'BSC (BEP20)', chainDeposit: this.chainDeposit, contractAddress: this.contractAddress, depositMin: '0.0001', minAccuracy: '8', confirmation: '15' },
              ],
            },
          ],
        };
      case 'GET /v5/asset/deposit/query-address':
        this.onAddressQuery?.();
        if (params.chainType !== 'BSC') return { coin: 'USDT', chains: [] };
        return {
          coin: 'USDT',
          chains: [{ chain: 'BSC', chainType: 'BSC (BEP20)', addressDeposit: this.depositAddress, tagDeposit: '', batchReleaseLimit: '-1', contractAddress: BSC_USDT.slice(-6) }],
        };
      case 'GET /v5/asset/deposit/query-record':
        if (this.denyRead) throw new ApiErr(10005, `permission denied ${LEAK_TEXT}`);
        return this.depositQuery(params);
      case 'GET /v5/asset/transfer/query-account-coin-balance':
        this.balanceCalls++;
        return { accountType: params.accountType, balance: { coin: 'USDT', walletBalance: fromBaseUnits(this.balances[params.accountType], 18), transferBalance: fromBaseUnits(this.balances[params.accountType], 18) } };
      case 'POST /v5/asset/transfer/inter-transfer': {
        this.transferCalls++;
        if (this.failBeforeExecuteNext) {
          this.failBeforeExecuteNext = false;
          throw new HttpErr(502);
        }
        if (this.transfers.has(params.transferId)) throw new ApiErr(131214, `TransferId exist ${LEAK_TEXT}`);
        const amt = toBaseUnits(params.amount, 18);
        if (this.balances[params.fromAccountType] < amt) throw new ApiErr(131212, `Insufficient balance ${LEAK_TEXT}`);
        this.balances[params.fromAccountType] -= amt;
        this.balances[params.toAccountType] += amt;
        this.transfers.set(params.transferId, { ...params, status: 'SUCCESS', timestamp: String(Date.now()) });
        if (this.ambiguousNextTransfer) {
          this.ambiguousNextTransfer = false;
          throw new HttpErr(502);
        }
        return { transferId: params.transferId, status: 'SUCCESS' };
      }
      case 'GET /v5/asset/transfer/query-inter-transfer-list': {
        if (this.denyRead) throw new ApiErr(10005, `permission denied ${LEAK_TEXT}`);
        const s = Number(params.startTime);
        const e = Number(params.endTime);
        if (!s || !e || e < s || e - s > 7 * DAY) {
          this.windowViolations++;
          throw new ApiErr(10001, 'window');
        }
        if (this.listLag > 0 && params.transferId) {
          this.listLag--;
          return { list: [], nextPageCursor: '' };
        }
        const t = this.transfers.get(params.transferId);
        const inWindow = t && Number(t.timestamp) >= s && Number(t.timestamp) <= e;
        return { list: inWindow ? [t] : [], nextPageCursor: '' };
      }
      default:
        throw new ApiErr(10001, `mock: unknown ${method} ${path}`);
    }
  }

  formatTxId(hash) {
    if (this.txIdForm === 'bare') return hash.slice(2);
    if (this.txIdForm === 'upper') return '0x' + hash.slice(2).toUpperCase();
    return hash;
  }

  /** All rows visible right now (advances the per-tx confirmation counters). */
  allRows() {
    const rows = [];
    for (let i = 0; i < this.unrelatedDeposits; i++) {
      rows.push({ id: `noise${i}`, coin: 'USDT', chain: 'BSC', amount: '1', txID: crypto.createHash('sha256').update(`n${i}`).digest('hex'), status: 3, toAddress: '0x' + 'c0'.repeat(20), depositFee: '', depositType: '0', successAt: String(Date.now() - 1000) });
    }
    for (const tx of this.chain.txs.values()) {
      if (tx.status !== 1 || !sameAddress(tx.to, BSC_USDT)) continue;
      const t = decodeTransfer(tx.data);
      if (!t || !sameAddress(t.to, this.depositAddress)) continue;
      const d = this.deposits.get(tx.hash) || { polls: 0, credited: false };
      d.polls++;
      const done = d.polls > this.confirmPolls;
      const fee = toBaseUnits(this.depositFee || '0', 18);
      const net = t.amount - fee;
      if (done && !d.credited && (this.finalStatus === 3 || this.finalStatus === 70012)) {
        d.credited = true;
        if (this.creditToUnified) this.balances.UNIFIED += net;
        else this.balances.FUND += net;
      }
      this.deposits.set(tx.hash, d);
      const blockMs = this.chain.blockTime(tx.block) * 1000;
      rows.push({
        id: 'dep' + tx.hash.slice(2, 10),
        coin: 'USDT',
        chain: 'BSC',
        amount: fromBaseUnits(net, 18),
        txID: this.formatTxId(tx.hash),
        status: done ? this.finalStatus : 1,
        toAddress: this.depositAddress,
        tag: '',
        depositFee: this.depositFee === '0' ? '' : this.depositFee,
        successAt: done ? String(blockMs + 60_000) : '',
        confirmations: String(this.chain.head - tx.block + 1),
        depositType: done ? this.depositType : '0',
        ...(done ? this.extraRowFields : {}),
        _time: blockMs,
      });
    }
    return rows;
  }

  depositQuery(params) {
    const limit = Number(params.limit || 50);
    if (limit < 1 || limit > 50) throw new ApiErr(10001, 'limit');
    let rows = this.allRows();
    if (params.txID) {
      if (this.txIdQueryBroken) return { rows: [], nextPageCursor: '' };
      rows = rows.filter((r) => r.txID === params.txID); // exact string match, like an index lookup
    } else {
      const now = Date.now();
      const s = params.startTime ? Number(params.startTime) : now - 30 * DAY + 1000; // docs: last 30 days by default
      const e = params.endTime ? Number(params.endTime) : now;
      if (e - s >= 30 * DAY) {
        this.windowViolations++;
        throw new ApiErr(10001, 'window');
      }
      rows = rows.filter((r) => r._time === undefined || (r._time >= s && r._time <= e));
    }
    const offset = Number(params.cursor || 0);
    const page = rows.slice(offset, offset + limit).map(({ _time, ...r }) => r);
    return { rows: page, nextPageCursor: offset + limit < rows.length ? String(offset + limit) : '' };
  }
}

class ApiErr extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}
class HttpErr extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.http = status;
  }
}

export function startBybitServer(mock) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    for await (const c of req) body += c;
    const reply = (status, json) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (url.pathname === '/v5/market/time') {
      return reply(200, { retCode: 0, retMsg: 'OK', result: { timeSecond: String(Math.floor(Date.now() / 1000)), timeNano: String(BigInt(Date.now()) * 1_000_000n) }, time: Date.now() });
    }
    const ts = req.headers['x-bapi-timestamp'];
    const recv = req.headers['x-bapi-recv-window'];
    const payload = req.method === 'GET' ? url.search.slice(1) : body;
    const expect = crypto.createHmac('sha256', mock.secret).update(ts + TEST_KEY + recv + payload).digest('hex');
    if (req.headers['x-bapi-api-key'] !== TEST_KEY || req.headers['x-bapi-sign'] !== expect) {
      mock.badSignatures++;
      return reply(200, { retCode: 10004, retMsg: `error sign! ${LEAK_TEXT}`, result: {} });
    }
    if (Math.abs(Date.now() - Number(ts)) > Number(recv)) return reply(200, { retCode: 10002, retMsg: 'timestamp outside recv_window', result: {} });
    const params = req.method === 'GET' ? Object.fromEntries(url.searchParams) : JSON.parse(body || '{}');
    try {
      reply(200, { retCode: 0, retMsg: 'OK', result: mock.handle(req.method, url.pathname, params), time: Date.now() });
    } catch (err) {
      if (err.http) return reply(err.http, { note: LEAK_TEXT });
      reply(200, { retCode: err.code || 10016, retMsg: err.message, result: {} });
    }
  });
  return listen(server);
}
