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
import { checkToken, verifyTransfer } from './bsc.js';
import { DEPOSIT_STATUS, DEPOSIT_SUCCESS, DEPOSIT_TERMINAL_BAD, DEPOSIT_TYPE, deterministicUuid } from './bybit.js';
import { STATE_KIND, note, transition } from './state.js';

export const COIN = 'USDT';
export const CHAIN = 'BSC';

/**
 * Live checks before any link is produced:
 * API key permissions, Bybit deposit route for USDT/BSC (enabled, min, precision, limit),
 * canonical token contract (Bybit + on-chain), and the account's live deposit address.
 */
export async function preflight({ bybit, rpcs, amount, target = 'UNIFIED' }) {
  const warnings = [];
  const key = await bybit.apiKeyInfo();
  const walletPerms = key?.permissions?.Wallet || [];
  if (walletPerms.includes('Withdraw')) warnings.push('API key has Withdraw permission — create a key without it');
  if ((key?.ips || []).includes('*')) warnings.push('API key is not IP-restricted');
  if (target === 'UNIFIED') {
    if (Number(key?.readOnly) !== 0) throw new Error('API key is read-only; funding->unified transfer needs read-write');
    if (!walletPerms.includes('AccountTransfer')) throw new Error('API key lacks Wallet:AccountTransfer permission');
  }

  const info = await bybit.coinInfo(COIN);
  const row = (info?.rows || []).find((r) => r.coin === COIN);
  const chain = row?.chains?.find((c) => c.chain === CHAIN);
  if (!chain) throw new Error(`Bybit does not list ${COIN} on chain ${CHAIN}`);
  if (String(chain.chainDeposit) !== '1') throw new Error(`Bybit ${COIN}/${CHAIN} deposits are suspended`);
  if (!sameAddress(chain.contractAddress, BSC_USDT)) {
    throw new Error(`Bybit contract ${chain.contractAddress} != canonical BSC USDT ${BSC_USDT}`);
  }

  const decimals = BSC_USDT_DECIMALS;
  const minAccuracy = Number(chain.minAccuracy);
  const maxDigits = Number.isFinite(minAccuracy) ? Math.min(minAccuracy, decimals) : decimals;
  if (fractionDigits(amount) > maxDigits) throw new Error(`amount ${amount} exceeds Bybit precision of ${maxDigits} decimals`);
  const amountBase = toBaseUnits(amount, decimals);
  if (amountBase <= 0n) throw new Error('amount must be positive');
  if (chain.depositMin && amountBase < toBaseUnits(chain.depositMin, decimals)) {
    throw new Error(`amount ${amount} below Bybit minimum deposit ${chain.depositMin}`);
  }

  const addr = await bybit.depositAddress(COIN, CHAIN);
  const route = (addr?.chains || []).find((c) => c.chain === CHAIN);
  if (!route || !isAddress(route.addressDeposit)) throw new Error('Bybit returned no valid BSC deposit address');
  if (route.tagDeposit) throw new Error('Bybit requires a deposit tag/memo on this route; a plain token transfer cannot carry it');
  if (route.contractAddress && !BSC_USDT.toLowerCase().endsWith(route.contractAddress.toLowerCase())) {
    throw new Error('deposit-address contract suffix does not match canonical USDT');
  }
  const limit = route.batchReleaseLimit ?? '-1';
  if (limit !== '-1' && limit !== '' && amountBase > toBaseUnits(limit, decimals)) {
    throw new Error(`amount exceeds Bybit deposit limit ${limit} for this route`);
  }

  for (const rpc of rpcs) await checkToken(rpc, BSC_USDT, { symbol: COIN, decimals });

  let fundBaseline = null;
  if (target === 'UNIFIED') {
    const bal = await bybit.coinBalance('FUND', COIN);
    fundBaseline = bal?.balance?.transferBalance ?? '0';
  }

  return {
    warnings,
    amount: String(amount),
    amountBase: amountBase.toString(),
    decimals,
    token: BSC_USDT,
    chain: CHAIN,
    chainId: BSC_CHAIN_ID,
    depositAddress: route.addressDeposit,
    depositMin: chain.depositMin,
    minAccuracy: chain.minAccuracy,
    requiredConfirmations: Number(chain.confirmation) || null,
    batchReleaseLimit: limit,
    fundBaseline,
    target,
  };
}

export function createIntent(pre) {
  const now = new Date().toISOString();
  const { warnings, ...route } = pre;
  return {
    v: 1,
    kind: STATE_KIND,
    intentId: crypto.randomBytes(16).toString('hex'),
    createdAt: now,
    updatedAt: now,
    ...route,
    phase: 'link_issued',
    attempt: 1,
    txHash: null,
    from: null,
    history: [[now, 'intent_created', ...(warnings.length ? [warnings.join('; ')] : [])]],
  };
}

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** Record the hash captured from the signing page. One hash per intent attempt; never overwrite. */
export function recordTx(state, { txHash, from }) {
  if (!HASH_RE.test(txHash || '')) throw Object.assign(new Error('invalid tx hash'), { status: 400 });
  if (from && !isAddress(from)) throw Object.assign(new Error('invalid from address'), { status: 400 });
  const h = txHash.toLowerCase();
  if (state.txHash) {
    if (state.txHash === h) return state; // idempotent re-post from page retry
    throw Object.assign(new Error(`intent already has tx ${state.txHash}; refusing second hash`), {
      status: 409,
      duplicate: h,
    });
  }
  if (state.phase !== 'link_issued') {
    throw Object.assign(new Error(`intent is ${state.phase}, not accepting a tx`), { status: 409 });
  }
  return transition({ ...state, txHash: h, from: from || null }, 'tx_submitted', 'tx_captured', h);
}

/** After a reverted tx, open a fresh attempt on the same intent (same Bybit route, re-verified). */
export function reopenAfterFailure(state) {
  if (state.phase !== 'tx_failed') throw new Error('only a failed (reverted) tx can be re-attempted');
  const prev = state.txHash;
  return transition(
    { ...state, txHash: null, from: null, attempt: (state.attempt || 1) + 1, failedTx: [...(state.failedTx || []), prev] },
    'link_issued',
    'reattempt',
    prev,
  );
}

function abs(x) {
  return x < 0n ? -x : x;
}

/** One idempotent step of settlement. Safe to call repeatedly / after crashes. */
export async function settleStep(state, { bybit, rpcs }) {
  switch (state.phase) {
    case 'tx_submitted': {
      if (!state.routeRechecked) {
        const addr = await bybit.depositAddress(COIN, CHAIN);
        const route = (addr?.chains || []).find((c) => c.chain === CHAIN);
        if (!route || !sameAddress(route.addressDeposit, state.depositAddress)) {
          return transition(state, 'needs_attention', 'deposit_address_changed', route?.addressDeposit || 'none');
        }
        state = { ...state, routeRechecked: true };
      }
      const v = await verifyTransfer(rpcs, {
        txHash: state.txHash,
        token: state.token,
        to: state.depositAddress,
        amountBase: state.amountBase,
        from: state.from,
        minConfirmations: 1,
      });
      if (v.state === 'confirmed') {
        return transition(
          { ...state, from: v.from, onchain: { blockNumber: v.blockNumber, confirmations: v.confirmations } },
          'tx_confirmed',
          'onchain_verified',
          `block ${v.blockNumber}`,
        );
      }
      if (v.state === 'failed') return transition(state, 'tx_failed', 'onchain_reverted', v.reason);
      if (v.state === 'mismatch') return transition(state, 'needs_attention', 'onchain_mismatch', v.reason);
      return state;
    }

    case 'tx_confirmed': {
      let res = await bybit.depositRecords({ coin: COIN, txID: state.txHash });
      if (!res?.rows?.length) {
        // Fallback in case Bybit indexes the hash in a different form: scan the time window locally.
        const startTime = Date.parse(state.createdAt) - 10 * 60_000;
        if (Date.now() - startTime < 29 * 24 * 3600_000) res = await bybit.depositRecords({ coin: COIN, startTime, endTime: Date.now() });
      }
      const rows = (res?.rows || []).filter(
        (r) =>
          String(r.txID).toLowerCase() === state.txHash &&
          r.coin === COIN &&
          r.chain === CHAIN &&
          sameAddress(r.toAddress, state.depositAddress),
      );
      if (rows.length === 0) return state;
      if (rows.length > 1) return transition(state, 'needs_attention', 'multiple_deposit_records', String(rows.length));
      const r = rows[0];
      const status = Number(r.status);
      const deposit = {
        id: r.id,
        amount: r.amount,
        depositFee: r.depositFee || '0',
        status: DEPOSIT_STATUS[status] || String(status),
        depositType: DEPOSIT_TYPE[r.depositType] || String(r.depositType ?? '0'),
        confirmations: r.confirmations,
      };
      const changed = JSON.stringify(deposit) !== JSON.stringify(state.deposit);
      let next = { ...state, deposit };
      if (r.depositType && String(r.depositType) !== '0') {
        return transition(next, 'needs_attention', 'bybit_deposit_held', deposit.depositType);
      }
      if (DEPOSIT_TERMINAL_BAD.has(status)) return transition(next, 'needs_attention', 'bybit_deposit_failed', deposit.status);
      if (!DEPOSIT_SUCCESS.has(status)) return changed ? note(next, 'bybit_deposit_seen', deposit.status) : next;
      // Credited amount (+ fee) must account for what we sent, within Bybit precision.
      const dec = state.decimals;
      const credited = toBaseUnits(r.amount, dec);
      const fee = toBaseUnits(deposit.depositFee || '0', dec);
      const tol = 10n ** BigInt(Math.max(0, dec - (Number(state.minAccuracy) || dec)));
      if (credited > BigInt(state.amountBase) || abs(BigInt(state.amountBase) - credited - fee) > tol) {
        return transition(next, 'needs_attention', 'bybit_amount_mismatch', `${r.amount}+fee ${deposit.depositFee}`);
      }
      return transition(next, 'deposit_credited', 'bybit_credited', r.amount);
    }

    case 'deposit_credited':
    case 'transfer_pending': {
      if (state.target !== 'UNIFIED') return transition(state, 'done', 'no_transfer_requested');
      const transferId =
        state.transfer?.transferId || deterministicUuid(`fundkit:${state.intentId}:${state.txHash}:${state.transferAttempt || 1}`);
      let next = { ...state, transfer: { ...(state.transfer || {}), transferId } };

      // Always look before acting: a previous run may have submitted it already.
      const existing = await findTransfer(bybit, transferId);
      if (existing) return applyTransferStatus(next, existing.status);
      const bal = await bybit.coinBalance('FUND', COIN);
      const fund = toBaseUnits(bal?.balance?.transferBalance ?? '0', state.decimals);
      const credited = toBaseUnits(state.deposit.amount, state.decimals);
      const baseline = toBaseUnits(state.fundBaseline ?? '0', state.decimals);
      const fundHasDeposit = fund >= credited && fund - baseline >= credited;
      if (!state.transfer?.submitted) {
        if (!fundHasDeposit) {
          return transition(
            { ...next, transfer: { ...next.transfer, needed: false } },
            'done',
            'transfer_not_needed',
            'deposit is not sitting in FUND (credited to UNIFIED directly, or already moved)',
          );
        }
        // Two-phase: first persist (print) the transferId as "prepared", then submit on the next step.
        // A crash between the two can only ever lead to submitting this same transferId.
        return transition(
          { ...next, transfer: { ...next.transfer, needed: true, amount: state.deposit.amount, submitted: true } },
          'transfer_pending',
          'transfer_prepared',
          transferId,
        );
      }
      // Submitted/prepared but Bybit has no record. If the funds already left FUND, an earlier
      // submit most likely went through: wait for the record instead of sending again.
      if (!fundHasDeposit) return noteOnce(next, 'awaiting_transfer_record', transferId);
      try {
        // Re-submits always reuse the SAME transferId (never a new id), so Bybit can de-duplicate.
        const r = await bybit.interTransfer({
          transferId,
          coin: COIN,
          amount: next.transfer.amount,
          fromAccountType: 'FUND',
          toAccountType: 'UNIFIED',
        });
        return applyTransferStatus(next, r?.status || 'PENDING');
      } catch (err) {
        // Ambiguous outcome (timeout / duplicate id): re-query, never blind-retry with a new id.
        const again = await findTransfer(bybit, transferId).catch(() => null);
        if (again) return applyTransferStatus(next, again.status);
        return noteOnce(next, 'transfer_submit_error', err.message.slice(0, 200));
      }
    }
    default:
      return state;
  }
}

function noteOnce(state, event, detail) {
  const last = state.history?.at(-1);
  return last?.[1] === event && last?.[2] === detail ? state : note(state, event, detail);
}

async function findTransfer(bybit, transferId) {
  const r = await bybit.transferList({ transferId, coin: COIN });
  return (r?.list || []).find((t) => t.transferId === transferId) || null;
}

function applyTransferStatus(state, status) {
  const next = { ...state, transfer: { ...state.transfer, status } };
  if (status === 'SUCCESS') return transition(next, 'done', 'transferred_to_unified', state.transfer.transferId);
  if (status === 'FAILED') return transition(next, 'needs_attention', 'transfer_failed', state.transfer.transferId);
  return state.phase === 'transfer_pending' && state.transfer?.status === status
    ? next
    : transition(next, 'transfer_pending', 'transfer_status', status);
}

export const TERMINAL = new Set(['done', 'needs_attention', 'tx_failed']);

/** Poll settleStep until a terminal phase or timeout, reporting each state change. */
export async function settle(state, deps, { pollMs = 5000, timeoutMs = 30 * 60_000, onState = () => {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = JSON.stringify(state);
  while (!TERMINAL.has(state.phase) && state.phase !== 'link_issued') {
    try {
      state = await settleStep(state, deps);
    } catch (err) {
      // Network/API hiccup: keep state, try again next poll. Nothing irreversible happened.
      const msg = err.message.slice(0, 200);
      state = noteOnce(state, 'transient_error', msg);
    }
    const cur = JSON.stringify(state);
    if (cur !== last) {
      onState(state);
      last = cur;
    }
    if (TERMINAL.has(state.phase)) break;
    if (Date.now() > deadline) {
      state = note(state, 'timeout', 'resume later with: fundkit resume --state ...');
      onState(state);
      break;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return state;
}

export function displayAmount(state) {
  return fromBaseUnits(state.amountBase, state.decimals);
}
