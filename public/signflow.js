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
    if (!r.ok) throw Object.assign(new Error(typeof data.error === 'string' ? data.error.slice(0, 200) : `HTTP ${r.status}`), { status: r.status });
    return data;
  };
  return {
    getIntent: () => j('GET', ''),
    precheck: (from) => j('POST', '/precheck', { from }),
    claim: (from) => j('POST', '/claim', { from }),
    release: (claimToken) => j('POST', '/release', { claimToken }),
    submitTx: (txHash, claimToken) => j('POST', '/tx', { txHash, claimToken }),
  };
}

/** Page URL <base>/s/<intentId> -> API base <base>/api/intent/<intentId> (works behind a path prefix). */
export function apiBaseFromPath(pathname) {
  const m = /^(.*)\/s\/([0-9a-f]{32})\/?$/.exec(pathname);
  if (!m) throw new Error('not a signing link');
  return { intentId: m[2], api: `${m[1]}/api/intent/${m[2]}` };
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

/** A hash this browser already obtained for this attempt (re-report it, never send again). */
export function storedSend(intent, storage) {
  const raw = safeGet(storage, storageKey(intent));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return /^0x[0-9a-fA-F]{64}$/.test(v?.txHash) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Ask the wallet to send exactly one USDT transfer for this intent attempt.
 * 1. server already has a hash, or this browser already sent -> no send (re-report)
 * 2. server-side atomic claim (binds `from`, re-checks the live Bybit route) BEFORE the wallet prompt;
 *    a second tab/browser/phone gets 409 and never sees a prompt
 * 3. the claimed tx must equal what this page shows; only then the wallet prompt
 * 4. only an explicit wallet rejection (4001) releases the claim
 */
export async function send(provider, intent, from, storage, api) {
  if (intent.txHash) return { txHash: intent.txHash, reused: true };
  const prior = storedSend(intent, storage);
  if (prior) return { ...prior, reused: true };
  const chain = await provider.request({ method: 'eth_chainId' });
  if (Number(chain) !== intent.chainId) throw new Error('wallet switched away from BNB Smart Chain');
  const claim = await api.claim(from);
  const tx = claim.tx || {};
  const expected = encodeTransfer(intent.to, intent.amountBase);
  if (!sameAddress(tx.from, from) || !sameAddress(tx.to, intent.token) || tx.value !== '0x0' || String(tx.data).toLowerCase() !== expected.toLowerCase()) {
    throw new Error('helper returned a transaction that differs from this page; not signing');
  }
  let txHash;
  try {
    txHash = await provider.request({ method: 'eth_sendTransaction', params: [{ from, to: intent.token, value: '0x0', data: expected }] });
  } catch (err) {
    if (err?.code === 4001) await api.release(claim.claimToken).catch(() => {});
    throw err;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error('wallet returned an invalid tx hash');
  safeSet(storage, storageKey(intent), JSON.stringify({ txHash, claimToken: claim.claimToken }));
  return { txHash, claimToken: claim.claimToken, reused: false };
}

/** Report the hash to the helper; retries on network errors, never re-sends the tx. */
export async function report(api, txHash, claimToken, { tries = 8, delayMs = 1500, sleep = defaultSleep } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await api.submitTx(txHash, claimToken);
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
    /* private mode: server-side claim still applies */
  }
}
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
