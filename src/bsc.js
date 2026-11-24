import {
  BSC_CHAIN_ID,
  SELECTOR,
  TRANSFER_TOPIC,
  encodeBalanceOf,
  encodeTransfer,
  sameAddress,
  topicToAddress,
} from '../public/erc20.js';

export class RpcClient {
  constructor(url, { timeoutMs = 10_000 } = {}) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.id = 0;
  }

  async call(method, params = []) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`RPC ${hostOf(this.url)} HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`RPC ${hostOf(this.url)} ${method}: ${body.error.message}`);
    return body.result;
  }

  async chainId() {
    return Number(BigInt(await this.call('eth_chainId')));
  }
  async blockNumber() {
    return Number(BigInt(await this.call('eth_blockNumber')));
  }
  async ethCall(to, data) {
    return this.call('eth_call', [{ to, data }, 'latest']);
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
  const h = hex.replace(/^0x/, '');
  if (h.length === 64) {
    // bytes32-style symbol
    return Buffer.from(h, 'hex').toString('utf8').replace(/\0+$/, '');
  }
  const len = Number(BigInt('0x' + h.slice(64, 128)));
  return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8');
}

/** Check the token contract is what we expect: right chain, code present, symbol and decimals. */
export async function checkToken(rpc, token, { symbol = 'USDT', decimals }) {
  const chainId = await rpc.chainId();
  if (chainId !== BSC_CHAIN_ID) throw new Error(`RPC is on chain ${chainId}, expected BSC ${BSC_CHAIN_ID}`);
  const code = await rpc.call('eth_getCode', [token, 'latest']);
  if (!code || code === '0x') throw new Error(`no contract code at ${token}`);
  const onchainDecimals = Number(BigInt(await rpc.ethCall(token, SELECTOR.decimals)));
  const onchainSymbol = decodeAbiString(await rpc.ethCall(token, SELECTOR.symbol));
  if (onchainDecimals !== decimals) throw new Error(`token decimals ${onchainDecimals} != expected ${decimals}`);
  if (onchainSymbol !== symbol) throw new Error(`token symbol ${onchainSymbol} != expected ${symbol}`);
  return { chainId, decimals: onchainDecimals, symbol: onchainSymbol };
}

/** Server-side balance + gas precheck for the wallet address the signing page reported. */
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
    tokenBalance: tokenBalance.toString(),
    bnbBalance: bnbBalance.toString(),
    gasNeededWei: gasNeeded.toString(),
    enoughToken: tokenBalance >= BigInt(amountBase),
    enoughGas: bnbBalance >= gasNeeded,
  };
}

/**
 * Verify a transfer tx from our own RPC(s), never trusting the wallet/page.
 * Returns { state: 'pending' | 'failed' | 'mismatch' | 'confirmed', ... }.
 * Every RPC in the list must agree, which guards against one lying/lagging endpoint.
 */
export async function verifyTransfer(rpcs, { txHash, token, to, amountBase, from, minConfirmations = 1 }) {
  const results = [];
  for (const rpc of rpcs) results.push(await verifyOne(rpc, { txHash, token, to, amountBase, from, minConfirmations }));
  const states = new Set(results.map((r) => r.state));
  if (states.size === 1) return results[0];
  if (states.has('mismatch') || states.has('failed')) return results.find((r) => r.state === 'mismatch' || r.state === 'failed');
  return { ...results.find((r) => r.state === 'pending'), note: 'RPCs disagree; treating as pending' };
}

async function verifyOne(rpc, { txHash, token, to, amountBase, from, minConfirmations }) {
  const chainId = await rpc.chainId();
  if (chainId !== BSC_CHAIN_ID) return { state: 'mismatch', reason: `RPC chain ${chainId} != ${BSC_CHAIN_ID}` };
  const tx = await rpc.call('eth_getTransactionByHash', [txHash]);
  if (!tx) return { state: 'pending', reason: 'tx not found yet' };
  if (tx.chainId && Number(BigInt(tx.chainId)) !== BSC_CHAIN_ID) return { state: 'mismatch', reason: 'tx chainId mismatch' };
  if (!sameAddress(tx.to, token)) return { state: 'mismatch', reason: `tx.to ${tx.to} is not the USDT contract` };
  if (from && !sameAddress(tx.from, from)) return { state: 'mismatch', reason: `tx.from ${tx.from} != connected wallet ${from}` };
  if (BigInt(tx.value || '0x0') !== 0n) return { state: 'mismatch', reason: 'tx carries native BNB value' };
  const receipt = await rpc.call('eth_getTransactionReceipt', [txHash]);
  if (!receipt || !receipt.blockNumber) return { state: 'pending', reason: 'no receipt yet', from: tx.from };
  if (BigInt(receipt.status) !== 1n) return { state: 'failed', reason: 'receipt status is 0 (reverted)', from: tx.from };
  const logs = (receipt.logs || []).filter(
    (l) => sameAddress(l.address, token) && l.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC,
  );
  if (logs.length !== 1) return { state: 'mismatch', reason: `expected exactly 1 USDT Transfer log, got ${logs.length}` };
  const log = logs[0];
  const logFrom = topicToAddress(log.topics[1]);
  const logTo = topicToAddress(log.topics[2]);
  const logAmount = BigInt(log.data);
  if (!sameAddress(logFrom, tx.from)) return { state: 'mismatch', reason: 'Transfer.from != tx.from' };
  if (!sameAddress(logTo, to)) return { state: 'mismatch', reason: `Transfer.to ${logTo} != Bybit deposit address` };
  if (logAmount !== BigInt(amountBase)) return { state: 'mismatch', reason: `Transfer amount ${logAmount} != ${amountBase}` };
  const head = await rpc.blockNumber();
  const confirmations = head - Number(BigInt(receipt.blockNumber)) + 1;
  return {
    state: confirmations >= minConfirmations ? 'confirmed' : 'pending',
    reason: confirmations >= minConfirmations ? 'ok' : `waiting confirmations ${confirmations}/${minConfirmations}`,
    from: tx.from,
    blockNumber: Number(BigInt(receipt.blockNumber)),
    confirmations,
  };
}
