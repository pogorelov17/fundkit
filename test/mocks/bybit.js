// Mock of the Bybit V5 endpoints the flow uses, with real HMAC verification. Test credentials only.
import http from 'node:http';
import crypto from 'node:crypto';
import { BSC_USDT, decodeTransfer, fromBaseUnits, sameAddress } from '../../public/erc20.js';
import { listen } from './bsc-chain.js';

export const TEST_KEY = 'mock-key-not-real';
export const TEST_SECRET = 'mock-secret-not-real';

export class MockBybit {
  constructor(chain, opts = {}) {
    this.chain = chain;
    this.depositAddress = opts.depositAddress || '0x' + 'b0'.repeat(20);
    this.creditToUnified = !!opts.creditToUnified; // simulate "deposit to UTA" account setting
    this.confirmPolls = opts.confirmPolls ?? 2; // record shows status 1 for N polls, then 3
    this.contractAddress = opts.contractAddress ?? BSC_USDT;
    this.chainDeposit = opts.chainDeposit ?? '1';
    this.depositFee = opts.depositFee ?? '0';
    this.balances = { FUND: opts.fund ?? 0, UNIFIED: 0 }; // in USDT, numeric is fine for a mock
    this.deposits = new Map(); // txHash -> {polls, credited}
    this.transfers = new Map();
    this.transferCalls = 0;
    this.ambiguousNextTransfer = false; // perform transfer but answer HTTP 502
    this.listLag = 0; // hide transfer records from the list for N queries
    this.permissions = opts.permissions || { Wallet: ['AccountTransfer'] };
    this.badSignatures = 0;
  }

  handle(method, path, params) {
    switch (`${method} ${path}`) {
      case 'GET /v5/user/query-api':
        return { readOnly: 0, permissions: this.permissions, ips: ['127.0.0.1'] };
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
        if (params.chainType !== 'BSC') return { coin: 'USDT', chains: [] };
        return {
          coin: 'USDT',
          chains: [{ chain: 'BSC', chainType: 'BSC (BEP20)', addressDeposit: this.depositAddress, tagDeposit: '', batchReleaseLimit: '-1', contractAddress: BSC_USDT.slice(-6) }],
        };
      case 'GET /v5/asset/deposit/query-record':
        return { rows: this.depositRows(params.txID), nextPageCursor: '' };
      case 'GET /v5/asset/transfer/query-account-coin-balance':
        return { accountType: params.accountType, balance: { coin: 'USDT', walletBalance: String(this.balances[params.accountType]), transferBalance: String(this.balances[params.accountType]) } };
      case 'POST /v5/asset/transfer/inter-transfer': {
        this.transferCalls++;
        if (this.transfers.has(params.transferId)) throw new ApiErr(131214, 'duplicate transferId');
        const amt = Number(params.amount);
        if (this.balances[params.fromAccountType] < amt) throw new ApiErr(131212, 'insufficient balance');
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
        if (this.listLag > 0) {
          this.listLag--;
          return { list: [], nextPageCursor: '' };
        }
        const t = this.transfers.get(params.transferId);
        return { list: t ? [t] : [], nextPageCursor: '' };
      }
      default:
        throw new ApiErr(10001, `mock: unknown ${method} ${path}`);
    }
  }

  depositRows(txID) {
    const tx = txID && this.chain.txs.get(txID.toLowerCase());
    if (!tx || tx.status !== 1) return [];
    const t = decodeTransfer(tx.data);
    if (!t || !sameAddress(t.to, this.depositAddress) || !sameAddress(tx.to, BSC_USDT)) return [];
    const d = this.deposits.get(tx.hash) || { polls: 0, credited: false };
    d.polls++;
    const success = d.polls > this.confirmPolls;
    const gross = fromBaseUnits(t.amount, 18);
    const net = String(Number(gross) - Number(this.depositFee));
    if (success && !d.credited) {
      d.credited = true;
      this.balances[this.creditToUnified ? 'UNIFIED' : 'FUND'] += Number(net);
    }
    this.deposits.set(tx.hash, d);
    return [
      { id: 'dep-' + tx.hash.slice(2, 10), coin: 'USDT', chain: 'BSC', amount: net, txID: tx.hash, status: success ? 3 : 1, toAddress: this.depositAddress, tag: '', depositFee: this.depositFee, confirmations: String(this.chain.head - tx.block + 1), depositType: '0', fromAddress: tx.from },
    ];
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
    const expect = crypto.createHmac('sha256', TEST_SECRET).update(ts + TEST_KEY + recv + payload).digest('hex');
    if (req.headers['x-bapi-api-key'] !== TEST_KEY || req.headers['x-bapi-sign'] !== expect) {
      mock.badSignatures++;
      return reply(200, { retCode: 10004, retMsg: 'error sign!', result: {} });
    }
    if (Math.abs(Date.now() - Number(ts)) > Number(recv)) return reply(200, { retCode: 10002, retMsg: 'timestamp outside recv_window', result: {} });
    const params = req.method === 'GET' ? Object.fromEntries(url.searchParams) : JSON.parse(body || '{}');
    try {
      reply(200, { retCode: 0, retMsg: 'OK', result: mock.handle(req.method, url.pathname, params), time: Date.now() });
    } catch (err) {
      if (err.http) return reply(err.http, {});
      reply(200, { retCode: err.code || 10016, retMsg: err.message, result: {} });
    }
  });
  return listen(server);
}
