import {
  BSC_CHAIN_ID,
  SELECTOR,
  TRANSFER_TOPIC,
  decodeTransfer,
  encodeBalanceOf,
  encodeTransfer,
  sameAddress,
  topicToAddress,
} from '../public/erc20.js';
import { MOCK_ONLY } from './bybit.js';
import { SafeError } from './errors.js';

export class RpcError extends SafeError {}

/** Production RPCs must be HTTPS, without credentials in the URL, and on pairwise distinct hosts. */
export function assertRpcUrls(urls, { mockOnly } = {}) {
  if (!Array.isArray(urls) || urls.length < 2) throw new SafeError('BSC_RPC_URLS needs at least two independent endpoints');
  const origins = new Set();
  for (const raw of urls) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      throw new SafeError('BSC_RPC_URLS contains an invalid URL');
    }
    if (mockOnly !== MOCK_ONLY && (u.protocol !== 'https:' || u.username || u.password)) {
      throw new SafeError('BSC_RPC_URLS must be https:// without embedded credentials');
    }
    const key = mockOnly === MOCK_ONLY ? u.host : u.hostname;
    if (origins.has(key)) throw new SafeError('BSC_RPC_URLS must point at independent hosts');
    origins.add(key);
  }
  return urls;
}

export class RpcClient {
  constructor(url, { timeoutMs = 10_000 } = {}) {
    this.url = url;
    this.host = hostOf(url);
    this.timeoutMs = timeoutMs;
    this.id = 0;
  }

  async call(method, params = []) {
    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new RpcError(`RPC ${this.host} ${method}: unreachable`);
    }
    if (!res.ok) throw new RpcError(`RPC ${this.host} ${method}: HTTP ${res.status}`);
    let body;
    try {
      body = await res.json();
    } catch {
      throw new RpcError(`RPC ${this.host} ${method}: bad json`);
    }
    if (body?.error) throw new RpcError(`RPC ${this.host} ${method}: error ${Number(body.error.code) || '?'}`);
    return body?.result;
  }

  async chainId() {
    return Number(BigInt(await this.call('eth_chainId')));
  }
  async ethCall(to, data) {
    return this.call('eth_call', [{ to, data }, 'latest']);
  }
  async block(tag) {
    return this.call('eth_getBlockByNumber', [tag, false]);
  }
  async nonce(addr, tag) {
    return Number(BigInt(await this.call('eth_getTransactionCount', [addr, tag])));
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'rpc';
  }
}

function decodeAbiString(hex) {
  const h = String(hex).replace(/^0x/, '');
  if (h.length === 64) return Buffer.from(h, 'hex').toString('utf8').replace(/\0+$/, '');
  const len = Number(BigInt('0x' + h.slice(64, 128)));
  return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8');
}

/** Check the token contract is what we expect: right chain, code present, symbol and decimals. */
export async function checkToken(rpc, token, { symbol = 'USDT', decimals }) {
  const chainId = await rpc.chainId();
  if (chainId !== BSC_CHAIN_ID) throw new SafeError(`RPC ${rpc.host} is on chain ${chainId}, expected BSC ${BSC_CHAIN_ID}`);
  const code = await rpc.call('eth_getCode', [token, 'latest']);
  if (!code || code === '0x') throw new SafeError(`no contract code at ${token}`);
  const onchainDecimals = Number(BigInt(await rpc.ethCall(token, SELECTOR.decimals)));
  const onchainSymbol = decodeAbiString(await rpc.ethCall(token, SELECTOR.symbol));
  if (onchainDecimals !== decimals) throw new SafeError(`token decimals ${onchainDecimals} != expected ${decimals}`);
  if (onchainSymbol !== symbol) throw new SafeError('token symbol does not match USDT');
  return { chainId, decimals: onchainDecimals, symbol: onchainSymbol };
}

/** Server-side balance + gas precheck for the wallet address the signing page reported (UX only). */
export async function precheckSender(rpc, { token, from, to, amountBase, gasHeadroom = 1.5 }) {
  const [tokenBalHex, bnbHex, gasPriceHex] = await Promise.all([
    rpc.ethCall(token, encodeBalanceOf(from)),
    rpc.call('eth_getBalance', [from, 'latest']),
    rpc.call('eth_gasPrice'),
  ]);
  let gasLimit;
  try {
    gasLimit = BigInt(
      await rpc.call('eth_estimateGas', [{ from, to: token, data: encodeTransfer(to, amountBase), value: '0x0' }]),
    );
  } catch {
    gasLimit = 60_000n; // conservative fallback for a plain BEP-20 transfer
  }
  const tokenBalance = BigInt(tokenBalHex);
  const bnbBalance = BigInt(bnbHex);
  const gasPrice = BigInt(gasPriceHex);
  const gasNeeded = (gasLimit * gasPrice * BigInt(Math.round(gasHeadroom * 100))) / 100n;
  return {
    enoughToken: tokenBalance >= BigInt(amountBase),
    enoughGas: bnbBalance >= gasNeeded,
  };
}

/**
 * Verify a transfer tx from our own RPCs, never trusting the wallet/page.
 *
 * A verdict is only reached when EVERY configured RPC answered and they agree on finalized evidence:
 *   confirmed — same block hash, receipt status 1, exact USDT transfer to `to` (finalized)
 *   failed    — same block hash, receipt status 0 (finalized revert; nonce returned for reattempt checks)
 *   mismatch  — every RPC sees the same finalized tx but it is not the expected transfer
 * Anything else is `pending` (not found / not finalized / lagging / unreachable) or `disagree`
 * (RPCs return conflicting finalized evidence). Neither ever allows a reattempt.
 */
export async function verifyTransfer(rpcs, expect) {
  if (rpcs.length < 2) throw new SafeError('need at least two independent RPCs');
  const results = await Promise.all(
    rpcs.map((rpc) => verifyOne(rpc, expect).catch((err) => ({ state: 'unavailable', reason: err instanceof RpcError ? err.message : `RPC ${rpc.host}: error` }))),
  );
  const states = new Set(results.map((r) => r.state));
  const first = results[0];
  if (states.size === 1 && ['confirmed', 'failed', 'mismatch'].includes(first.state)) {
    const same = results.every((r) => r.blockHash === first.blockHash && r.status === first.status && r.digest === first.digest);
    if (same) return first;
    return { state: 'disagree', reason: 'RPCs disagree on finalized block/receipt' };
  }
  const final = results.filter((r) => ['confirmed', 'failed', 'mismatch'].includes(r.state));
  if (new Set(final.map((r) => `${r.state}:${r.blockHash}:${r.digest}`)).size > 1) {
    return { state: 'disagree', reason: 'RPCs disagree on finalized block/receipt' };
  }
  const why = results.find((r) => r.state !== (final[0]?.state ?? ''))?.reason || 'waiting';
  const unavailable = results.some((r) => r.state === 'unavailable');
  return { state: 'pending', unavailable, reason: final.length ? `not all RPCs agree yet: ${why}` : why };
}

async function verifyOne(rpc, { txHash, token, to, amountBase, from }) {
  const chainId = await rpc.chainId();
  if (chainId !== BSC_CHAIN_ID) return { state: 'unavailable', reason: `RPC ${rpc.host} on chain ${chainId}` };
  const tx = await rpc.call('eth_getTransactionByHash', [txHash]);
  if (!tx) return { state: 'pending', reason: 'tx not found yet' };
  if (String(tx.hash).toLowerCase() !== txHash) return { state: 'unavailable', reason: `RPC ${rpc.host} returned another tx` };
  const receipt = await rpc.call('eth_getTransactionReceipt', [txHash]);
  if (!receipt || !receipt.blockNumber || !receipt.blockHash) return { state: 'pending', reason: 'no receipt yet' };
  const blockNumber = Number(BigInt(receipt.blockNumber));
  const finalized = await rpc.block('finalized');
  if (!finalized || Number(BigInt(finalized.number)) < blockNumber) return { state: 'pending', reason: 'not finalized yet' };
  const canonical = await rpc.block('0x' + blockNumber.toString(16));
  if (!canonical || String(canonical.hash).toLowerCase() !== String(receipt.blockHash).toLowerCase()) {
    return { state: 'pending', reason: 'receipt block not canonical on this RPC' };
  }
  const base = {
    blockHash: String(receipt.blockHash).toLowerCase(),
    blockNumber,
    timestamp: Number(BigInt(canonical.timestamp)),
    status: Number(BigInt(receipt.status)),
    from: String(tx.from).toLowerCase(),
    nonce: Number(BigInt(tx.nonce)),
  };
  base.digest = `${base.from}:${base.nonce}:${String(tx.to).toLowerCase()}:${String(tx.input).toLowerCase()}:${JSON.stringify(receipt.logs || [])}`;
  const mismatch = (reason) => ({ ...base, state: 'mismatch', reason });
  if (tx.chainId && Number(BigInt(tx.chainId)) !== BSC_CHAIN_ID) return mismatch('tx chainId mismatch');
  if (from && !sameAddress(tx.from, from)) return mismatch('tx.from is not the wallet bound before signing');
  if (base.status === 0) return { ...base, state: 'failed', reason: 'finalized receipt status 0 (reverted)' };
  if (base.status !== 1) return mismatch('unexpected receipt status');
  if (!sameAddress(tx.to, token)) return mismatch('tx.to is not the USDT contract');
  if (BigInt(tx.value || '0x0') !== 0n) return mismatch('tx carries native BNB value');
  const call = decodeTransfer(tx.input);
  if (!call || !sameAddress(call.to, to) || call.amount !== BigInt(amountBase)) return mismatch('calldata is not transfer(Bybit address, exact amount)');
  const logs = (receipt.logs || []).filter((l) => sameAddress(l.address, token) && l.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC);
  if (logs.length !== 1) return mismatch(`expected exactly 1 USDT Transfer log, got ${logs.length}`);
  const log = logs[0];
  if (!sameAddress(topicToAddress(log.topics[1]), tx.from)) return mismatch('Transfer.from != tx.from');
  if (!sameAddress(topicToAddress(log.topics[2]), to)) return mismatch('Transfer.to != Bybit deposit address');
  if (BigInt(log.data) !== BigInt(amountBase)) return mismatch('Transfer amount != intent amount');
  return { ...base, state: 'confirmed', reason: 'ok' };
}

/** Sender nonces (latest and pending) on every RPC; null if any RPC cannot answer or they disagree. */
export async function senderNonces(rpcs, addr) {
  try {
    const all = await Promise.all(rpcs.map(async (r) => [await r.nonce(addr, 'latest'), await r.nonce(addr, 'pending')]));
    const key = JSON.stringify(all[0]);
    return all.every((x) => JSON.stringify(x) === key) ? { latest: all[0][0], pending: all[0][1] } : null;
  } catch {
    return null;
  }
}
