import crypto from 'node:crypto';
import {
  BSC_CHAIN_ID,
  BSC_USDT,
  BSC_USDT_DECIMALS,
  fractionDigits,
  fromBaseUnits,
  isAddress,
  sameAddress,
  toBaseUnits,
} from '../public/erc20.js';
import { checkToken, senderNonces, verifyTransfer } from './bsc.js';
import { SafeError, safeError } from './errors.js';
import {
  BybitError,
  DEPOSIT_STATUS,
  TRANSFER_DUPLICATE,
  TRANSFER_PERMANENT,
  classifyDeposit,
  deterministicUuid,
  normalizeTxId,
} from './bybit.js';
import { STATE_KIND, note, noteOnce, transition } from './state.js';

export const COIN = 'USDT';
export const CHAIN = 'BSC';
const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Errors whose message we wrote ourselves (safe to show in chat, logs and the page). */
export class FlowError extends SafeError {}
const fail = (msg, status) => {
  throw new FlowError(msg, status);
};

export { safeError };

// ---------------------------------------------------------------- preflight

/**
 * Account + key checks (least privilege). Before any link is issued:
 *  - the key belongs to a Bybit UID (bound into state), has no Withdraw permission
 *  - UNIFIED target: read-write key with Wallet:AccountTransfer, account is a Unified Trading Account
 *  - the key can actually read deposit records (and transfer records for UNIFIED) — probed
 */
export async function checkAccount(bybit, { target }) {
  const warnings = [];
  const key = await bybit.apiKeyInfo();
  const uid = String(key?.userID ?? '');
  if (!/^\d{1,20}$/.test(uid)) fail('Bybit API key info has no userID');
  const perms = key?.permissions && typeof key.permissions === 'object' ? key.permissions : {};
  const wallet = Array.isArray(perms.Wallet) ? perms.Wallet : [];
  if (wallet.includes('Withdraw')) fail('API key has the Withdraw permission; create a key without it');
  for (const [group, list] of Object.entries(perms)) {
    if (group !== 'Wallet' && Array.isArray(list) && list.length) warnings.push(`API key has unneeded ${group.slice(0, 20)} permissions`);
  }
  for (const p of wallet) if (p !== 'AccountTransfer') warnings.push(`API key has unneeded Wallet:${String(p).slice(0, 30)} permission`);
  const ips = Array.isArray(key?.ips) ? key.ips : [];
  if (!ips.length || ips.includes('*')) warnings.push('API key is not IP-restricted');
  const readOnly = Number(key?.readOnly);
  if (target === 'UNIFIED') {
    if (readOnly !== 0) fail('API key is read-only; the Funding->Unified transfer needs a read-write key');
    if (!wallet.includes('AccountTransfer')) fail('API key lacks Wallet:AccountTransfer permission');
    if (Number(key?.uta) !== 1) fail('Bybit account is not a Unified Trading Account (uta != 1)');
    const info = await bybit.accountInfo();
    if (![3, 4, 5, 6].includes(Number(info?.unifiedMarginStatus))) fail('Bybit account/info does not report a Unified Trading Account');
  } else if (readOnly === 0 || wallet.length) {
    warnings.push('target FUND only needs a read-only key without Wallet permissions');
  }
  try {
    await bybit.depositRecords({ coin: COIN, limit: 1 });
    if (target === 'UNIFIED') {
      const now = Date.now();
      await bybit.transferList({ coin: COIN, startTime: now - DAY, endTime: now, limit: 1 });
    }
  } catch (err) {
    fail(`API key cannot read deposit/transfer records (${safeError(err)})`);
  }
  return { uid, warnings };
}

function parseAmount(amount) {
  const s = String(amount ?? '').trim();
  if (!/^\d{1,12}(\.\d{1,18})?$/.test(s)) fail('amount must be a plain decimal like 25 or 25.5');
  return s;
}

/** Live Bybit route checks for USDT/BSC: enabled, canonical contract, precision, min, limit, address, no tag. */
export async function checkRoute(bybit, amount) {
  const decimals = BSC_USDT_DECIMALS;
  const info = await bybit.coinInfo(COIN);
  const row = (info?.rows || []).find((r) => r.coin === COIN);
  const chain = row?.chains?.find((c) => c.chain === CHAIN);
  if (!chain) fail(`Bybit does not list ${COIN} on chain ${CHAIN}`);
  if (String(chain.chainDeposit) !== '1') fail(`Bybit ${COIN}/${CHAIN} deposits are suspended`);
  if (!sameAddress(chain.contractAddress, BSC_USDT)) fail(`Bybit ${COIN}/${CHAIN} contract is not the canonical BSC USDT ${BSC_USDT}`);
  const minAccuracy = /^\d{1,2}$/.test(String(chain.minAccuracy)) ? String(chain.minAccuracy) : null;
  if (minAccuracy === null) fail('Bybit did not report minAccuracy for USDT/BSC');
  const maxDigits = Math.min(Number(minAccuracy), decimals);
  if (fractionDigits(amount) > maxDigits) fail(`amount ${amount} exceeds Bybit precision of ${maxDigits} decimals`);
  const amountBase = toBaseUnits(amount, decimals);
  if (amountBase <= 0n) fail('amount must be positive');
  if (chain.depositMin && amountBase < toBaseUnits(chain.depositMin, decimals)) fail(`amount ${amount} is below the Bybit minimum deposit`);

  const addr = await bybit.depositAddress(COIN, CHAIN);
  const route = (addr?.chains || []).find((c) => c.chain === CHAIN);
  if (!route || !isAddress(route.addressDeposit)) fail('Bybit returned no valid BSC deposit address');
  if (route.tagDeposit) fail('Bybit requires a deposit tag/memo on this route; a plain token transfer cannot carry it');
  if (route.contractAddress && !BSC_USDT.toLowerCase().endsWith(String(route.contractAddress).toLowerCase())) {
    fail('deposit-address contract suffix does not match canonical USDT');
  }
  const limit = String(route.batchReleaseLimit ?? '-1');
  if (limit !== '-1' && limit !== '' && amountBase > toBaseUnits(limit, decimals)) fail('amount exceeds the Bybit deposit limit for this route');
  return {
    amountBase: amountBase.toString(),
    depositAddress: route.addressDeposit.toLowerCase(),
    minAccuracy,
    depositMin: String(chain.depositMin ?? ''),
    requiredConfirmations: Number(chain.confirmation) || null,
    batchReleaseLimit: limit,
  };
}

export async function preflight({ bybit, rpcs, amount, target = 'UNIFIED', fundCreditConfirmed = false }) {
  if (target !== 'UNIFIED' && target !== 'FUND') fail('target must be UNIFIED or FUND');
  if (target === 'UNIFIED' && !fundCreditConfirmed) {
    fail(
      'Bybit has no API that reports which account an on-chain deposit is credited to. Confirm in the Bybit app that ' +
        'deposits go to the Funding account (the default; no auto-transfer to another account), then pass --confirm-fund-credit',
    );
  }
  amount = parseAmount(amount);
  const { uid, warnings } = await checkAccount(bybit, { target });
  const route = await checkRoute(bybit, amount);
  for (const rpc of rpcs) await checkToken(rpc, BSC_USDT, { symbol: COIN, decimals: BSC_USDT_DECIMALS });
  return { warnings, uid, amount, target, fundCreditConfirmed: target === 'UNIFIED', token: BSC_USDT, decimals: BSC_USDT_DECIMALS, ...route };
}

export function createIntent(pre) {
  const now = new Date().toISOString();
  return {
    v: 2,
    kind: STATE_KIND,
    intentId: crypto.randomBytes(16).toString('hex'),
    createdAt: now,
    updatedAt: now,
    uid: pre.uid,
    amount: pre.amount,
    amountBase: pre.amountBase,
    decimals: BSC_USDT_DECIMALS,
    token: BSC_USDT,
    chain: CHAIN,
    chainId: BSC_CHAIN_ID,
    depositAddress: pre.depositAddress,
    minAccuracy: pre.minAccuracy,
    target: pre.target,
    fundCreditConfirmed: pre.fundCreditConfirmed,
    phase: 'link_issued',
    attempt: 1,
    claim: null,
    txHash: null,
    from: null,
    failedTx: [],
    replacedTx: [],
    deposit: null,
    transfer: null,
    history: [[now, 'intent_created']],
  };
}

/** Re-check account and live route right before a wallet prompt; throws FlowError if anything moved. */
export async function revalidateBeforeSigning(bybit, state) {
  const { uid } = await checkAccount(bybit, { target: state.target });
  if (uid !== state.uid) fail('API key now belongs to a different Bybit account');
  const route = await checkRoute(bybit, state.amount);
  if (!sameAddress(route.depositAddress, state.depositAddress)) fail('Bybit deposit address changed since the intent was created');
  if (route.amountBase !== state.amountBase) fail('amount no longer matches');
  return route;
}

// ---------------------------------------------------------------- signing slot (synchronous, atomic in-process)

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** One signing slot per attempt. Claimed BEFORE the wallet prompt; binds the sender. */
export function claimSigning(state, from) {
  if (!isAddress(from)) fail('invalid address');
  if (state.phase !== 'link_issued' || state.claim || state.txHash) fail('signing is already claimed or closed for this intent', 409);
  return transition({ ...state, claim: { from: from.toLowerCase(), at: new Date().toISOString() } }, 'signing_claimed', 'signing_claimed', from);
}

/** Only after the wallet explicitly reported "user rejected" (EIP-1193 4001) for this claim. */
export function releaseSigning(state) {
  if (state.phase !== 'signing_claimed' || state.txHash) fail('nothing to release', 409);
  return transition({ ...state, claim: null }, 'link_issued', 'signing_released_after_wallet_reject');
}

/** Record the hash for the current attempt. One hash per attempt; never overwrite (see replaceTx). */
export function recordTx(state, { txHash }) {
  if (!HASH_RE.test(txHash || '')) fail('invalid tx hash');
  const h = txHash.toLowerCase();
  if (state.txHash) {
    if (state.txHash === h) return state; // idempotent re-post from page retry
    const err = new FlowError('intent already has a tx hash; refusing second hash', 409);
    err.duplicate = h;
    throw err;
  }
  if (state.phase !== 'link_issued' && state.phase !== 'signing_claimed') fail(`intent is ${state.phase}, not accepting a tx`, 409);
  return transition({ ...state, txHash: h, from: state.claim?.from ?? null }, 'tx_submitted', 'tx_captured', h);
}

const expectFor = (state, txHash = state.txHash, from = state.from ?? state.claim?.from ?? null) => ({
  txHash,
  token: state.token,
  to: state.depositAddress,
  amountBase: state.amountBase,
  from,
});

/**
 * Hash correction/replacement (wallet speed-up/cancel, or a wrong hash pasted). Verification only:
 * the recorded hash must NOT be a finalized success (or disputed), and the new hash must be a finalized,
 * exact transfer to the Bybit address from the bound sender, agreed by every RPC.
 */
export async function replaceTx(state, newHash, { rpcs }) {
  if (!HASH_RE.test(newHash || '')) fail('invalid tx hash');
  const h = newHash.toLowerCase();
  const old = await verifyTransfer(rpcs, expectFor(state, state.txHash, null));
  if (old.state === 'confirmed') fail('the recorded tx is a finalized successful transfer; refusing to replace it');
  if (old.state === 'disagree') fail('RPCs disagree about the recorded tx; refusing to replace it');
  if (old.state === 'pending' && old.unavailable) fail('not every RPC answered about the recorded tx; try again later');
  const v = await verifyTransfer(rpcs, expectFor(state, h));
  if (v.state !== 'confirmed') fail(`replacement tx is not a finalized exact transfer agreed by every RPC (${v.state}: ${v.reason})`);
  return transition(
    { ...state, txHash: h, from: v.from, replacedTx: [...state.replacedTx, state.txHash].slice(-20), deposit: null, transfer: null },
    'tx_submitted',
    'tx_replaced',
    `${state.txHash.slice(0, 10)} -> ${h.slice(0, 10)} (old: ${old.state})`,
  );
}

/**
 * Deposits on this account's BSC USDT address since the intent was created that could belong to it
 * (any status, amount + fee within precision of the intent amount), excluding known hashes.
 * Bounded: one <30 day window, at most 10 pages of 50.
 */
export async function candidateDeposits(bybit, state, exclude = []) {
  const start = Date.parse(state.createdAt) - 10 * 60_000;
  const now = Date.now();
  if (now - start > 29 * DAY) fail('intent is older than Bybit\'s 30-day deposit window; check deposits manually');
  const skip = new Set(exclude.map(normalizeTxId));
  const out = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const res = await bybit.depositRecords({ coin: COIN, startTime: start, endTime: now, limit: 50, cursor });
    for (const r of res?.rows || []) {
      const id = normalizeTxId(r.txID);
      if (r.chain !== CHAIN || !sameAddress(r.toAddress, state.depositAddress) || (id && skip.has(id))) continue;
      if (amountCheck(state, r).ok) out.push(id ? '0x' + id : 'unknown-txid');
    }
    cursor = res?.nextPageCursor;
    if (!cursor) return out;
  }
  out.push('more-pages-unchecked');
  return out;
}

/**
 * Open attempt N+1 on the same intent. Only when every precondition is proven right now:
 * finalized revert on every RPC, the bound sender has sent nothing since (latest == pending == nonce+1),
 * no other matching Bybit deposit since the intent was created, live route unchanged.
 */
export async function reattempt(state, { bybit, rpcs }) {
  if (!state.txHash) fail('no tx recorded; nothing to re-attempt (this checkpoint can only be recovered)');
  const v = await verifyTransfer(rpcs, expectFor(state));
  if (v.state !== 'failed') fail(`re-attempt needs a finalized revert agreed by every RPC; the recorded tx is ${v.state}`);
  const n = await senderNonces(rpcs, v.from);
  if (!n || n.latest !== v.nonce + 1 || n.pending !== v.nonce + 1) {
    fail('the sending wallet has other transactions after the reverted one (or RPCs disagree); cannot rule out an earlier send — recovery only');
  }
  const cands = await candidateDeposits(bybit, state, [state.txHash, ...state.failedTx.map((f) => f.hash), ...state.replacedTx]);
  if (cands.length) fail(`Bybit shows deposits that may belong to this intent (${cands.slice(0, 3).join(', ')}); use resume --tx <hash> instead`);
  await revalidateBeforeSigning(bybit, state);
  return transition(
    {
      ...state,
      attempt: state.attempt + 1,
      claim: null,
      txHash: null,
      from: null,
      failedTx: [...state.failedTx, { hash: state.txHash, from: v.from, nonce: v.nonce }].slice(-20),
      deposit: null,
      transfer: null,
    },
    'link_issued',
    'reattempt_verified',
    state.txHash,
  );
}

// ---------------------------------------------------------------- Bybit deposit evidence

function amountCheck(state, row) {
  try {
    const credited = toBaseUnits(String(row.amount), state.decimals);
    const fee = toBaseUnits(String(row.depositFee || '0'), state.decimals);
    const sent = BigInt(state.amountBase);
    const tol = 10n ** BigInt(Math.max(0, state.decimals - Number(state.minAccuracy)));
    const ok = credited > 0n && credited + fee <= sent && sent - credited - fee < tol;
    return { ok, credited, fee };
  } catch {
    return { ok: false };
  }
}

/** Deposit rows for our tx: by txID (with and without 0x), then a bounded scan around the block time. */
export async function findDeposit(bybit, state, blockTimestampSec) {
  const want = normalizeTxId(state.txHash);
  const match = (res) => (res?.rows || []).filter((r) => normalizeTxId(r.txID) === want);
  for (const txID of [state.txHash, want]) {
    const rows = match(await bybit.depositRecords({ coin: COIN, txID }));
    if (rows.length) return rows;
  }
  if (!blockTimestampSec) return [];
  const start = blockTimestampSec * 1000 - 10 * 60_000;
  const end = Math.min(Date.now(), start + 29 * DAY);
  if (end <= start) return [];
  let cursor;
  for (let page = 0; page < 5; page++) {
    const res = await bybit.depositRecords({ coin: COIN, startTime: start, endTime: end, limit: 50, cursor });
    const rows = match(res);
    if (rows.length) return rows;
    cursor = res?.nextPageCursor;
    if (!cursor) break;
  }
  return [];
}

const safeId = (x) => (/^[A-Za-z0-9_-]{1,40}$/.test(String(x ?? '')) ? String(x) : '?');

export function evaluateDeposit(state, rows) {
  if (!rows.length) return { kind: 'pending', why: 'no Bybit deposit record yet' };
  if (new Set(rows.map((r) => safeId(r.id))).size > 1) return { kind: 'mismatch', why: 'multiple Bybit deposit records for one tx' };
  const r = rows[0];
  if (r.coin !== COIN || r.chain !== CHAIN || !sameAddress(r.toAddress, state.depositAddress)) {
    return { kind: 'mismatch', why: 'deposit record coin/chain/address does not match' };
  }
  const c = classifyDeposit(r);
  const a = amountCheck(state, r);
  const info = {
    id: safeId(r.id),
    amount: a.credited !== undefined ? fromBaseUnits(a.credited, state.decimals) : '?',
    fee: a.fee !== undefined ? fromBaseUnits(a.fee, state.decimals) : '?',
    status: DEPOSIT_STATUS[Number(r.status)] || 'unknown-code',
    successAt: /^\d{10,16}$/.test(String(r.successAt ?? '')) ? String(r.successAt) : '',
  };
  if (c.kind !== 'credited') return { ...c, info };
  if (!a.ok) return { kind: 'mismatch', why: `credited ${info.amount} + fee ${info.fee} does not account for ${state.amount}`, info };
  return { kind: 'credited', why: c.why, credited: a.credited, info };
}

// ---------------------------------------------------------------- Bybit transfer evidence

export const transferIdFor = (state) => deterministicUuid(`fundkit:v2:${state.intentId}:${state.txHash}`);

/**
 * Look up our transferId in explicit <=7-day windows starting just before the deposit was credited
 * (a transfer cannot precede it). Bounded to 8 windows (~8 weeks); beyond that -> 'expired'.
 */
export async function findTransfer(bybit, transferId, sinceMs) {
  const now = Date.now();
  let start = sinceMs - HOUR;
  for (let i = 0; i < 8 && start <= now; i++) {
    const end = Math.min(start + 7 * DAY - 1000, now + 60_000);
    const res = await bybit.transferList({ transferId, coin: COIN, startTime: start, endTime: end, limit: 50 });
    const hit = (res?.list || []).find((t) => t.transferId === transferId);
    if (hit) return hit;
    start = end + 1;
  }
  return start <= now ? 'expired' : null;
}

function applyTransferRecord(state, rec, credited) {
  let amountOk = false;
  try {
    amountOk = toBaseUnits(String(rec.amount), state.decimals) === credited;
  } catch {
    /* unparsable -> mismatch */
  }
  if (rec.coin !== COIN || rec.fromAccountType !== 'FUND' || rec.toAccountType !== 'UNIFIED' || !amountOk) {
    return transition(state, 'needs_attention', 'transfer_record_mismatch', state.transfer?.transferId);
  }
  const status = ['SUCCESS', 'PENDING', 'FAILED'].includes(rec.status) ? rec.status : 'STATUS_UNKNOWN';
  const next = { ...state, transfer: { ...state.transfer, status } };
  if (status === 'SUCCESS') return transition(next, 'done', 'transferred_to_unified', state.transfer.transferId);
  if (status === 'FAILED') return transition(next, 'needs_attention', 'transfer_failed', state.transfer.transferId);
  return state.phase === 'transfer_pending' && state.transfer?.status === status ? next : transition(next, 'transfer_pending', 'transfer_status', status);
}

// ---------------------------------------------------------------- settlement (evidence-driven)

export const TERMINAL = new Set(['done', 'needs_attention', 'tx_failed']);

/**
 * One idempotent reconcile step. `phase` is only a hint: chain evidence is re-verified once per run,
 * the Bybit deposit is re-read until credited, and the transfer is looked up before any submit.
 * `ctx` holds per-run, in-memory evidence (never persisted, never trusted across runs).
 */
export async function settleStep(state, { bybit, rpcs }, ctx = {}) {
  if (!state.txHash || TERMINAL.has(state.phase)) return state;

  // 1. Chain: finalized, coherent evidence from every RPC.
  if (!ctx.onchain) {
    const v = await verifyTransfer(rpcs, expectFor(state));
    if (v.state === 'pending') return noteOnce(state, 'onchain_waiting', v.reason);
    if (v.state === 'failed') {
      return state.phase === 'tx_submitted'
        ? transition(state, 'tx_failed', 'onchain_reverted', v.reason)
        : transition(state, 'needs_attention', 'onchain_contradiction', 'checkpoint is past confirmation but tx reverted');
    }
    if (v.state === 'mismatch') return transition(state, 'needs_attention', 'onchain_mismatch', v.reason);
    if (v.state === 'disagree') return transition(state, 'needs_attention', 'onchain_disagree', v.reason);
    ctx.onchain = v;
    if (state.phase === 'tx_submitted' || !sameAddress(state.from ?? '', v.from)) {
      const phase = state.phase === 'tx_submitted' ? 'tx_confirmed' : state.phase;
      return transition({ ...state, from: v.from }, phase, 'onchain_verified', `block ${v.blockNumber} finalized`);
    }
  }

  // 2. Bybit deposit record for this exact tx on this account (live, not from the checkpoint).
  if (!ctx.deposit) {
    const e = evaluateDeposit(state, await findDeposit(bybit, state, ctx.onchain.timestamp));
    const next = e.info ? { ...state, deposit: e.info } : state;
    if (e.kind === 'pending') {
      return JSON.stringify(next.deposit) === JSON.stringify(state.deposit) ? noteOnce(next, 'bybit_deposit_waiting', e.why) : note(next, 'bybit_deposit_seen', e.why);
    }
    if (e.kind === 'held') return transition(next, 'needs_attention', 'bybit_deposit_held', e.why);
    if (e.kind === 'failed') return transition(next, 'needs_attention', 'bybit_deposit_failed', e.why);
    if (e.kind === 'mismatch') return transition(next, 'needs_attention', 'bybit_deposit_mismatch', e.why);
    ctx.deposit = e;
    if (state.phase === 'tx_confirmed' || state.phase === 'tx_submitted') return transition(next, 'deposit_credited', 'bybit_credited', e.info.amount);
    state = next;
  }

  // 3. Target FUND: the verified credit is the end.
  if (state.target === 'FUND') return transition(state, 'done', 'credited_on_bybit');

  // 4. Funding -> Unified, only on documented, account-specific evidence (transfer record by transferId).
  if (!state.fundCreditConfirmed) {
    ctx.stop = true;
    return noteOnce(state, 'awaiting_fund_credit_confirmation', 'confirm in the Bybit app that the deposit is in Funding, then resume --confirm-fund-credit');
  }
  const credited = ctx.deposit.credited;
  const transferId = transferIdFor(state);
  if (state.transfer && state.transfer.transferId !== transferId) return transition(state, 'needs_attention', 'transfer_id_mismatch');
  const since = Number(ctx.deposit.info.successAt) || ctx.onchain.timestamp * 1000;
  const found = await findTransfer(bybit, transferId, since);
  if (found === 'expired') return transition(state, 'needs_attention', 'transfer_lookup_window_exceeded', transferId);
  const base = state.transfer || { transferId, submits: [], outcome: null, status: null };
  if (found) return applyTransferRecord({ ...state, transfer: base }, found, credited);

  if (!state.transfer) {
    // Two-phase: persist (print) the transferId first; a crash after this can only ever reuse it.
    return transition({ ...state, transfer: base }, 'transfer_pending', 'transfer_prepared', transferId);
  }
  const t = state.transfer;
  if (t.outcome !== null) {
    // An earlier POST was rejected, or got an answer we cannot rely on (ambiguous / duplicate / accepted but
    // not yet listed): reconcile only. Explicit --retry-transfer (after the lookup above still found nothing)
    // re-POSTs the SAME transferId once; Bybit answers 131214 if it already exists.
    const retryable = t.outcome === 'ambiguous' || t.outcome === 'rejected';
    if (!(ctx.retryTransfer && retryable && !ctx.retried)) {
      return t.outcome === 'rejected'
        ? transition(state, 'needs_attention', 'transfer_rejected', transferId)
        : noteOnce(state, 'awaiting_transfer_record', transferId);
    }
    ctx.retried = true;
  }
  if (t.submits.length >= 10) return transition(state, 'needs_attention', 'transfer_submit_limit', transferId);

  const at = Date.now();
  let outcome;
  let status = t.status;
  let code = '';
  try {
    const r = await bybit.interTransfer({ transferId, coin: COIN, amount: fromBaseUnits(credited, state.decimals), fromAccountType: 'FUND', toAccountType: 'UNIFIED' });
    outcome = 'accepted';
    status = ['SUCCESS', 'PENDING', 'FAILED'].includes(r?.status) ? r.status : 'STATUS_UNKNOWN';
  } catch (err) {
    code = err instanceof BybitError ? String(err.retCode) : 'network';
    if (err instanceof BybitError && err.retCode === TRANSFER_DUPLICATE) outcome = 'duplicate';
    else if (err instanceof BybitError && TRANSFER_PERMANENT.has(err.retCode)) outcome = 'rejected';
    else outcome = 'ambiguous';
  }
  const next = { ...state, transfer: { ...t, submits: [...t.submits, at], outcome, status } };
  if (outcome === 'rejected') return transition(next, 'needs_attention', 'transfer_rejected', `retCode ${code}`);
  return transition(next, 'transfer_pending', `transfer_submit_${outcome}`, code ? `${transferId} code ${code}` : transferId);
}

/** Poll settleStep until a terminal phase, a stop condition, or timeout, reporting each state change. */
export async function settle(state, deps, { pollMs = 5000, timeoutMs = 30 * 60_000, onState = () => {}, retryTransfer = false } = {}) {
  const deadline = Date.now() + timeoutMs;
  const ctx = { retryTransfer };
  let last = JSON.stringify(state);
  while (state.txHash && !TERMINAL.has(state.phase)) {
    try {
      state = await settleStep(state, deps, ctx);
    } catch (err) {
      // Network/API hiccup: keep state, try again next poll. Nothing irreversible happened in this step
      // except a possible transfer POST, whose outcome is recorded inside settleStep itself.
      state = noteOnce(state, 'transient_error', safeError(err));
    }
    const cur = JSON.stringify(state);
    if (cur !== last) {
      onState(state);
      last = cur;
    }
    if (TERMINAL.has(state.phase) || ctx.stop) break;
    if (Date.now() > deadline) {
      state = note(state, 'timeout', 'resume later with: fundkit resume --state ...');
      onState(state);
      break;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return state;
}

// ---------------------------------------------------------------- read-only recovery

/** Report what the evidence says, without serving a link or submitting anything. */
export async function recoveryReport(state, { bybit, rpcs }, out, { reason, sameAccount }) {
  out(`RECOVERY ONLY: ${reason}.`);
  out('No signing link is served and no transfer is submitted from this checkpoint.');
  try {
    if (state.txHash) {
      const v = await verifyTransfer(rpcs, expectFor(state));
      out(`on-chain ${state.txHash}: ${v.state} (${v.reason})`);
      if (v.state === 'confirmed' && sameAccount) {
        const e = evaluateDeposit(state, await findDeposit(bybit, state, v.timestamp));
        out(`bybit deposit: ${e.kind} (${e.why})${e.info ? ` amount ${e.info.amount} fee ${e.info.fee}` : ''}`);
        if (e.kind === 'credited' && state.target === 'UNIFIED') {
          const id = transferIdFor(state);
          const t = await findTransfer(bybit, id, Number(e.info.successAt) || v.timestamp * 1000);
          out(`funding->unified transferId ${id}: ${t === null ? 'no record found' : t === 'expired' ? 'outside lookup window' : `status ${safeId(t.status)}`}`);
        }
      }
    } else if (sameAccount) {
      const cands = await candidateDeposits(bybit, state, [...state.failedTx.map((f) => f.hash), ...state.replacedTx]);
      out(cands.length ? `Bybit deposits that may belong to this intent: ${cands.join(', ')}` : 'No matching Bybit deposit found yet (a tx may still be pending or not indexed).');
    }
  } catch (err) {
    out(`recovery lookup incomplete: ${safeError(err)}`);
  }
  out(
    state.txHash
      ? 'Next: continue with the original credentials (or FUNDKIT_STATE_KEY), or finish manually in the Bybit app.'
      : 'Next: find the transfer in OKX Wallet history and run: fundkit resume --state <line> --tx <hash>. ' +
          'Only if you are certain nothing was sent, start a NEW intent.',
  );
}

export function displayAmount(state) {
  return fromBaseUnits(state.amountBase, state.decimals);
}
