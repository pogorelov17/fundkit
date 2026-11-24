// Chat-carried state. There is no database: every change prints one `FUNDKIT_STATE 2.<payload>.<mac>`
// line, the agent keeps the latest line in the conversation, and `fundkit resume --state '<line>'`
// continues from it.
//
// - Transport: base64url(JSON) + base64url(HMAC-SHA256) — only [A-Za-z0-9._-], safe inside shell quotes.
// - Authentication: the MAC key is derived from the Bybit API secret (or FUNDKIT_STATE_KEY), so a line
//   that was edited, or that was produced under other credentials, is recognised and is only ever used
//   for read-only recovery. It never contains API keys, secrets, claim tokens or raw remote messages.
// - Even an authentic line may be an OLDER snapshot. The flow therefore treats `phase` as a hint and
//   re-derives every money-relevant fact (chain, Bybit deposit, Bybit transfer) before acting.
import crypto from 'node:crypto';
import { SafeError } from './errors.js';
import { BSC_CHAIN_ID, BSC_USDT, BSC_USDT_DECIMALS, isAddress, toBaseUnits } from '../public/erc20.js';

export const STATE_PREFIX = 'FUNDKIT_STATE ';
export const STATE_KIND = 'okx-bsc-usdt-to-bybit';
const VERSION = '2';

export const PHASES = [
  'link_issued', // signing link served, nobody has claimed the signing slot yet
  'signing_claimed', // a browser claimed the single signing slot; a wallet prompt may have been shown
  'tx_submitted', // hash captured, waiting for finalized on-chain evidence
  'tx_failed', // all RPCs agree: finalized and reverted (no USDT moved)
  'tx_confirmed', // all RPCs agree: finalized exact USDT transfer to the Bybit address
  'deposit_credited', // Bybit deposit record success, amount reconciled
  'transfer_pending', // FUND->UNIFIED transfer prepared/submitted with a deterministic transferId
  'done',
  'needs_attention', // stop: something did not match or cannot be proven; a human must look
];

const HEX32 = /^[0-9a-f]{32}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class StateError extends SafeError {}

// ---------- authentication ----------

/** Derive the state MAC key. Explicit FUNDKIT_STATE_KEY survives API key rotation; otherwise tied to the secret. */
export function stateKeyFrom({ bybit, env = process.env }) {
  if (env.FUNDKIT_STATE_KEY) {
    if (env.FUNDKIT_STATE_KEY.length < 32) throw new StateError('FUNDKIT_STATE_KEY must be at least 32 characters');
    return crypto.createHash('sha256').update('fundkit/state-key/v2\0' + env.FUNDKIT_STATE_KEY).digest();
  }
  return bybit.deriveKey('fundkit/state-mac/v2');
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const mac = (key, payload) => crypto.createHmac('sha256', key).update(`${STATE_PREFIX}${VERSION}.${payload}`).digest();

export function formatState(state, key) {
  if (!key) throw new StateError('state key required');
  validateState(state);
  const payload = b64(JSON.stringify(state));
  return `${STATE_PREFIX}${VERSION}.${payload}.${b64(mac(key, payload))}`;
}

/**
 * Parse the LAST state line in `input`. Returns { state, authentic }.
 * `authentic=false` (bad MAC / other credentials) means: recovery report only, never act on it.
 */
export function parseState(input, key) {
  if (!input) throw new StateError('missing state');
  const re = /FUNDKIT_STATE\s+2\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/g;
  let m;
  let last = null;
  while ((m = re.exec(String(input)))) last = m;
  if (!last) throw new StateError('no FUNDKIT_STATE 2.<payload>.<mac> line found');
  const [, payload, sig] = last;
  if (payload.length > 24_000) throw new StateError('state line too large');
  let state;
  try {
    state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new StateError('state payload is not valid');
  }
  validateState(state);
  let authentic = false;
  if (key) {
    const want = mac(key, payload);
    const got = Buffer.from(sig, 'base64url');
    authentic = got.length === want.length && crypto.timingSafeEqual(got, want);
  }
  return { state, authentic };
}

// ---------- schema ----------

const ALLOWED = new Set([
  'v', 'kind', 'intentId', 'createdAt', 'updatedAt', 'uid', 'amount', 'amountBase', 'decimals', 'token', 'chain',
  'chainId', 'depositAddress', 'minAccuracy', 'target', 'fundCreditConfirmed', 'phase', 'attempt', 'claim', 'txHash',
  'from', 'failedTx', 'replacedTx', 'deposit', 'transfer', 'history',
]);

function req(cond, what) {
  if (!cond) throw new StateError(`invalid state: ${what}`);
}

export function validateState(s) {
  req(s && typeof s === 'object' && !Array.isArray(s), 'not an object');
  for (const k of Object.keys(s)) req(ALLOWED.has(k), `unexpected field ${k.slice(0, 30)}`);
  req(s.v === 2 && s.kind === STATE_KIND, 'not a fundkit v2 state');
  req(HEX32.test(s.intentId), 'intentId');
  req(ISO.test(s.createdAt) && ISO.test(s.updatedAt), 'timestamps');
  req(typeof s.uid === 'string' && /^\d{1,20}$/.test(s.uid), 'uid');
  req(s.decimals === BSC_USDT_DECIMALS && s.token === BSC_USDT && s.chain === 'BSC' && s.chainId === BSC_CHAIN_ID, 'route');
  req(typeof s.amount === 'string' && /^\d{1,12}(\.\d{1,18})?$/.test(s.amount), 'amount');
  req(typeof s.amountBase === 'string' && toBaseUnits(s.amount, s.decimals).toString() === s.amountBase, 'amountBase');
  req(BigInt(s.amountBase) > 0n, 'amount must be positive');
  req(isAddress(s.depositAddress), 'depositAddress');
  req(typeof s.minAccuracy === 'string' && /^\d{1,2}$/.test(s.minAccuracy), 'minAccuracy');
  req(s.target === 'UNIFIED' || s.target === 'FUND', 'target');
  req(typeof s.fundCreditConfirmed === 'boolean', 'fundCreditConfirmed');
  req(PHASES.includes(s.phase), 'phase');
  req(Number.isInteger(s.attempt) && s.attempt >= 1 && s.attempt <= 20, 'attempt');
  req(s.claim === null || (isAddress(s.claim?.from) && ISO.test(s.claim?.at) && Object.keys(s.claim).length === 2), 'claim');
  req(s.txHash === null || HASH.test(s.txHash), 'txHash');
  req(s.from === null || isAddress(s.from), 'from');
  req(Array.isArray(s.failedTx) && s.failedTx.length <= 20, 'failedTx');
  for (const f of s.failedTx) req(HASH.test(f?.hash) && isAddress(f?.from) && Number.isInteger(f?.nonce) && Object.keys(f).length === 3, 'failedTx entry');
  req(Array.isArray(s.replacedTx) && s.replacedTx.length <= 20 && s.replacedTx.every((h) => HASH.test(h)), 'replacedTx');
  req(s.deposit === null || (typeof s.deposit === 'object' && Object.keys(s.deposit).length <= 6), 'deposit');
  if (s.transfer !== null) {
    const t = s.transfer;
    req(typeof t === 'object' && UUID.test(t.transferId), 'transfer.transferId');
    req(Array.isArray(t.submits) && t.submits.length <= 10 && t.submits.every((x) => Number.isSafeInteger(x)), 'transfer.submits');
    req([null, 'ambiguous', 'duplicate', 'rejected', 'accepted'].includes(t.outcome), 'transfer.outcome');
    req(Object.keys(t).every((k) => ['transferId', 'submits', 'outcome', 'status'].includes(k)), 'transfer fields');
  }
  req(Array.isArray(s.history) && s.history.length <= 40, 'history');
  for (const h of s.history) req(Array.isArray(h) && h.length <= 3 && h.every((x) => typeof x === 'string' && x.length <= 200), 'history entry');
  return s;
}

// ---------- transitions ----------

/** History details are restricted to a safe charset: no remote free text, no control characters. */
export function safeDetail(d) {
  return String(d).replace(/[^A-Za-z0-9 _.:,=+/#()<>-]/g, '?').slice(0, 160);
}

export function transition(state, phase, event, detail) {
  if (!PHASES.includes(phase)) throw new StateError(`unknown phase ${phase}`);
  const next = { ...state, phase, updatedAt: new Date().toISOString() };
  next.history = [...(state.history || []), [next.updatedAt, event, ...(detail ? [safeDetail(detail)] : [])]].slice(-30);
  return next;
}

export function note(state, event, detail) {
  return transition(state, state.phase, event, detail);
}

export function noteOnce(state, event, detail) {
  const last = state.history?.at(-1);
  const d = detail ? safeDetail(detail) : undefined;
  return last?.[1] === event && last?.[2] === d ? state : note(state, event, detail);
}

export function summarize(state) {
  const lines = [
    `intent ${state.intentId}: ${state.amount} USDT (BSC) -> Bybit ${state.target} (uid ${state.uid}), attempt ${state.attempt}`,
    `phase: ${state.phase}`,
  ];
  if (state.claim) lines.push(`signing claimed by ${state.claim.from} at ${state.claim.at}`);
  if (state.txHash) lines.push(`tx: ${state.txHash}`);
  if (state.deposit) lines.push(`bybit deposit: ${JSON.stringify(state.deposit)}`);
  if (state.transfer) lines.push(`funding->unified: ${JSON.stringify(state.transfer)}`);
  const last = state.history?.at(-1);
  if (last) lines.push(`last: ${last.join(' ')}`);
  return lines.join('\n');
}
