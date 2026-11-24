// DOM-free signing logic (runs in OKX Wallet's in-app browser; unit-tested in Node with a fake provider).
// The page never sees private keys or API keys: the wallet signs, and the user reviews the
// token, recipient and amount on the wallet's own confirmation screen.
import { encodeTransfer, fromBaseUnits, isAddress, sameAddress, toBaseUnits, BSC_USDT } from './erc20.js';

export function makeApi(base, fetchImpl = fetch) {
  const j = async (method, path, body) => {
    const r = await fetchImpl(base + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status });
    return data;
  };
  return {
    getIntent: () => j('GET', ''),
    precheck: (from) => j('POST', '/precheck', { from }),
    submitTx: (txHash, from) => j('POST', '/tx', { txHash, from }),
  };
}

/** Defensive checks on what the server told us, so a tampered intent cannot redirect funds silently. */
export function validateIntent(intent) {
  if (intent.chainId !== 56) throw new Error('intent is not for BNB Smart Chain');
  if (!sameAddress(intent.token, BSC_USDT)) throw new Error('intent token is not canonical BSC USDT');
  if (!isAddress(intent.to)) throw new Error('intent recipient is not an address');
  if (toBaseUnits(intent.amount, intent.decimals).toString() !== intent.amountBase) throw new Error('amount mismatch');
  return { ...intent, display: fromBaseUnits(intent.amountBase, intent.decimals) };
}

export const storageKey = (intent) => `fundkit:${intent.intentId}:${intent.attempt}`;

export async function connect(provider, intent) {
  const [from] = await provider.request({ method: 'eth_requestAccounts' });
  if (!isAddress(from)) throw new Error('wallet returned no account');
  let chain = await provider.request({ method: 'eth_chainId' });
  if (Number(chain) !== intent.chainId) {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: intent.chainIdHex }] });
    chain = await provider.request({ method: 'eth_chainId' });
    if (Number(chain) !== intent.chainId) throw new Error('wallet is not on BNB Smart Chain');
  }
  return from;
}

/**
 * Ask the wallet to send exactly one USDT transfer for this intent attempt.
 * Duplicate guards: server says a hash already exists -> no send; this browser already sent
 * for this attempt -> no send (just re-report the stored hash).
 */
export async function send(provider, intent, from, storage) {
  if (intent.txHash) return { txHash: intent.txHash, reused: true };
  const prior = safeGet(storage, storageKey(intent));
  if (prior) return { txHash: prior, reused: true };
  const chain = await provider.request({ method: 'eth_chainId' });
  if (Number(chain) !== intent.chainId) throw new Error('wallet switched away from BNB Smart Chain');
  const txHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from, to: intent.token, value: '0x0', data: encodeTransfer(intent.to, intent.amountBase) }],
  });
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error('wallet returned an invalid tx hash');
  safeSet(storage, storageKey(intent), txHash);
  return { txHash, reused: false };
}

/** Report the hash to the helper; retries on network errors, never re-sends the tx. */
export async function report(api, txHash, from, { tries = 8, delayMs = 1500, sleep = defaultSleep } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await api.submitTx(txHash, from);
    } catch (err) {
      if (err.status && err.status < 500) throw err; // 4xx: do not retry (e.g. duplicate)
      lastErr = err;
      await sleep(delayMs * (i + 1));
    }
  }
  throw lastErr;
}

function safeGet(storage, k) {
  try {
    return storage?.getItem(k) || null;
  } catch {
    return null;
  }
}
function safeSet(storage, k, v) {
  try {
    storage?.setItem(k, v);
  } catch {
    /* private mode: server-side guard still applies */
  }
}
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
