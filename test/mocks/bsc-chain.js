// In-memory BNB Smart Chain + JSON-RPC servers for mock acceptance. Not a real chain; no keys.
import http from 'node:http';
import crypto from 'node:crypto';
import { BSC_USDT, SELECTOR, TRANSFER_TOPIC, decodeTransfer, encodeAddressArg, encodeUintArg, sameAddress } from '../../public/erc20.js';

const hex = (n) => '0x' + BigInt(n).toString(16);
const lc = (a) => a.toLowerCase();

export class MockChain {
  constructor({ chainId = 56, decimals = 18, symbol = 'USDT', finalityDepth = 2 } = {}) {
    this.chainId = chainId;
    this.decimals = decimals;
    this.symbol = symbol;
    this.head = 1000;
    this.finalityDepth = finalityDepth;
    this.t0 = Math.floor(Date.now() / 1000) - 60; // block timestamps stay in the recent past
    this.token = new Map(); // addr -> bigint
    this.bnb = new Map();
    this.nonces = new Map(); // addr -> next nonce (incl. pending)
    this.txs = new Map();
    this.revertNext = false;
    this.autoMine = true;
    this.sent = 0;
  }

  fund(addr, { usdt = 0n, bnb = 0n }) {
    this.token.set(lc(addr), usdt);
    this.bnb.set(lc(addr), bnb);
  }

  blockHash(n) {
    return '0x' + crypto.createHash('sha256').update(`mock-block-${n}`).digest('hex');
  }

  /** `hidden`: broadcast but never mined/visible (dropped, or replaced by a speed-up). */
  sendTransaction({ from, to, data, value = '0x0' }, { hidden = false } = {}) {
    this.sent++;
    const nonce = this.nonces.get(lc(from)) || 0;
    this.nonces.set(lc(from), nonce + 1);
    const hash = '0x' + crypto.randomBytes(32).toString('hex');
    if (hidden) return hash;
    this.txs.set(hash, { hash, from: lc(from), to: lc(to), data, value, nonce, block: null, status: null, logs: [] });
    if (this.autoMine) this.mine();
    return hash;
  }

  mine(blocks = 1) {
    for (const tx of this.txs.values()) {
      if (tx.block !== null) continue;
      tx.block = this.head + 1;
      const t = sameAddress(tx.to, BSC_USDT) ? decodeTransfer(tx.data) : null;
      const bal = this.token.get(tx.from) || 0n;
      if (this.revertNext || !t || bal < t.amount) {
        this.revertNext = false;
        tx.status = 0;
        continue;
      }
      this.token.set(tx.from, bal - t.amount);
      this.token.set(lc(t.to), (this.token.get(lc(t.to)) || 0n) + t.amount);
      tx.status = 1;
      tx.logs = [
        {
          address: BSC_USDT,
          topics: [TRANSFER_TOPIC, '0x' + encodeAddressArg(tx.from), '0x' + encodeAddressArg(t.to)],
          data: '0x' + encodeUintArg(t.amount),
        },
      ];
    }
    this.head += blocks;
  }

  block(n) {
    if (n > this.head || n < 0) return null;
    return { number: hex(n), hash: this.blockHash(n), timestamp: hex(this.blockTime(n)) };
  }

  blockTime(n) {
    return this.t0 + Math.floor((n - 1000) / 100);
  }

  rpc(method, params) {
    switch (method) {
      case 'eth_chainId':
        return hex(this.chainId);
      case 'eth_blockNumber':
        return hex(this.head);
      case 'eth_getBlockByNumber': {
        const tag = params[0];
        if (tag === 'latest') return this.block(this.head);
        if (tag === 'finalized') {
          this.head++; // time passes as the verifier polls
          return this.block(this.head - this.finalityDepth);
        }
        return this.block(Number(BigInt(tag)));
      }
      case 'eth_getTransactionCount': {
        const a = lc(params[0]);
        if (params[1] === 'pending') return hex(this.nonces.get(a) || 0);
        return hex([...this.txs.values()].filter((t) => t.from === a && t.block !== null).length);
      }
      case 'eth_getCode':
        return sameAddress(params[0], BSC_USDT) ? '0x6080604052' : '0x';
      case 'eth_gasPrice':
        return hex(1_000_000_000n);
      case 'eth_estimateGas':
        return hex(55_000);
      case 'eth_getBalance':
        return hex(this.bnb.get(lc(params[0])) || 0n);
      case 'eth_call': {
        const { to, data } = params[0];
        if (!sameAddress(to, BSC_USDT)) return '0x';
        if (data === SELECTOR.decimals) return '0x' + encodeUintArg(this.decimals);
        if (data === SELECTOR.symbol) {
          const b = Buffer.from(this.symbol).toString('hex');
          return '0x' + encodeUintArg(32) + encodeUintArg(this.symbol.length) + b.padEnd(64, '0');
        }
        if (data.startsWith(SELECTOR.balanceOf)) return '0x' + encodeUintArg(this.token.get('0x' + data.slice(-40)) || 0n);
        return '0x';
      }
      case 'eth_getTransactionByHash': {
        const tx = this.txs.get(lc(params[0]));
        if (!tx) return null;
        return {
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          input: tx.data,
          value: tx.value,
          nonce: hex(tx.nonce),
          chainId: hex(this.chainId),
          blockNumber: tx.block === null ? null : hex(tx.block),
        };
      }
      case 'eth_getTransactionReceipt': {
        const tx = this.txs.get(lc(params[0]));
        if (!tx || tx.block === null) return null;
        return { transactionHash: tx.hash, blockNumber: hex(tx.block), blockHash: this.blockHash(tx.block), status: hex(tx.status), logs: tx.logs };
      }
      default:
        throw new Error(`unsupported ${method}`);
    }
  }
}

/**
 * One independent RPC endpoint over the shared chain. `view.override(method, params, result)` lets a
 * test make this endpoint lag, lie or fail without affecting the others.
 */
export function startRpcServer(chain, view = {}) {
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const { id, method, params } = JSON.parse(body);
    let out;
    try {
      let result = chain.rpc(method, params);
      if (view.override) result = view.override(method, params, result);
      out = { jsonrpc: '2.0', id, result };
    } catch (err) {
      out = { jsonrpc: '2.0', id, error: { code: -32601, message: `mock rpc: ${err.message} SECRET-RPC-TEXT` } };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  });
  return listen(server);
}

/** EIP-1193 provider standing in for OKX Wallet. The "user" approves everything unless told otherwise. */
export function fakeWalletProvider(chain, account, { startChainId = '0x1', reject = false, onSend } = {}) {
  let current = startChainId;
  const calls = [];
  return {
    calls,
    async request({ method, params }) {
      calls.push(method);
      if (method === 'eth_requestAccounts') return [account];
      if (method === 'eth_chainId') return current;
      if (method === 'wallet_switchEthereumChain') return void (current = params[0].chainId);
      if (method === 'eth_sendTransaction') {
        if (reject) throw Object.assign(new Error('User rejected'), { code: 4001 });
        if (Number(current) !== 56) throw new Error('wrong chain');
        if (onSend) await onSend(params[0]);
        return chain.sendTransaction(params[0]);
      }
      throw new Error(`fake wallet: unsupported ${method}`);
    },
  };
}

export async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
