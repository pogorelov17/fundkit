import { RpcClient, assertRpcUrls } from './bsc.js';
import { BybitClient } from './bybit.js';
import {
  FlowError,
  createIntent,
  preflight,
  reattempt,
  recordTx,
  recoveryReport,
  replaceTx,
  safeError,
  settle,
} from './flow.js';
import { okxUniversalLink, parsePublicBase, qrTerminal, signingUrl } from './links.js';
import { createSigningServer, listen } from './server.js';
import { formatState, note, parseState, stateKeyFrom } from './state.js';

export const DEFAULT_RPCS = ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com'];

export function configFromEnv(env = process.env) {
  const rpcUrls = (env.BSC_RPC_URLS || DEFAULT_RPCS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  return {
    rpcUrls,
    publicBaseUrl: env.PUBLIC_BASE_URL || '',
    port: Number(env.PORT || 8787),
    host: env.HOST || '127.0.0.1',
    allowInsecure: env.FUNDKIT_ALLOW_INSECURE_LOCAL === '1',
    pollMs: Number(env.FUNDKIT_POLL_MS || 5000),
    timeoutMs: Number(env.FUNDKIT_TIMEOUT_MS || 30 * 60_000),
  };
}

export function makeDeps(env = process.env) {
  const cfg = configFromEnv(env);
  const bybit = BybitClient.fromEnv(env);
  const rpcs = assertRpcUrls(cfg.rpcUrls).map((u) => new RpcClient(u));
  return { cfg, bybit, rpcs, stateKey: stateKeyFrom({ bybit, env }) };
}

const baseOf = (cfg, addr) => (typeof cfg.publicBaseUrl === 'function' ? cfg.publicBaseUrl(addr) : cfg.publicBaseUrl);

/**
 * Serve the signing page for `state` (phase link_issued, fresh from start or a verified reattempt),
 * print link + QR, wait for the hash, then settle. The link dies with this process: resuming an old
 * link_issued/signing_claimed checkpoint never re-serves it.
 */
export async function serveAndSettle(state, deps, out = console.log) {
  const { cfg, bybit, rpcs } = deps;
  if (typeof cfg.publicBaseUrl !== 'function') parsePublicBase(cfg.publicBaseUrl, { allowInsecure: cfg.allowInsecure });
  const emit = (s) => out(formatState(s, deps.stateKey));
  let current = state;
  let wake;
  const woke = new Promise((r) => (wake = r));
  const alerts = []; // second hashes that arrive while settle() owns the state; merged into the final state
  let base = typeof cfg.publicBaseUrl === 'function' ? null : cfg.publicBaseUrl;
  const session = {
    get: () => current,
    update: (fn) => {
      const next = fn(current); // synchronous check-and-set
      if (next !== current) {
        current = next;
        emit(current);
        if (current.phase === 'tx_submitted' || current.phase === 'needs_attention') wake();
      }
      return current;
    },
    duplicate: (hash) => {
      alerts.push(hash);
      current = note(current, 'second_tx_rejected', hash);
      emit(current);
      out('WARNING: a second tx hash was reported for this intent. Check OKX Wallet history; do not sign again.');
    },
  };
  const server = createSigningServer({ session, bybit, rpcs, publicBase: () => base, log: out });
  const addr = await listen(server, cfg.port, cfg.host);
  try {
    base = baseOf(cfg, addr);
    parsePublicBase(base, { allowInsecure: cfg.allowInsecure });
    const signUrl = signingUrl(base, state.intentId);
    out(`Local helper listening on http://${addr.address}:${addr.port} (expose it as ${base})`);
    out(`Signing page: ${signUrl}`);
    out(`Open on phone in OKX Wallet: ${okxUniversalLink(signUrl)}`);
    out(await qrTerminal(okxUniversalLink(signUrl)));
    out('Waiting for the wallet to submit the transaction…');
    emit(current);
    let timer;
    const timeout = new Promise((r) => (timer = setTimeout(r, cfg.timeoutMs, 'timeout')));
    const winner = await Promise.race([woke, timeout]);
    clearTimeout(timer);
    if (winner === 'timeout') {
      current = note(current, 'link_closed', 'no tx hash received; resuming this line offers recovery only');
      emit(current);
      return current;
    }
    if (current.phase !== 'tx_submitted') return current;
    let final = await settle(current, { bybit, rpcs }, {
      pollMs: cfg.pollMs,
      timeoutMs: cfg.timeoutMs,
      onState: (s) => {
        current = s; // the page sees live progress
        emit(s);
      },
    });
    const late = alerts.filter((h) => !(final.history || []).some((e) => e[1] === 'second_tx_rejected' && e[2] === h));
    for (const h of late) final = note(final, 'second_tx_rejected', h);
    if (late.length) emit(final);
    return final;
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

export async function start({ amount, target = 'UNIFIED', confirmFundCredit = false }, deps, out = console.log) {
  if (typeof deps.cfg.publicBaseUrl !== 'function') parsePublicBase(deps.cfg.publicBaseUrl, { allowInsecure: deps.cfg.allowInsecure });
  await deps.bybit.syncTime?.().catch(() => {});
  const pre = await preflight({ bybit: deps.bybit, rpcs: deps.rpcs, amount, target, fundCreditConfirmed: confirmFundCredit });
  for (const w of pre.warnings) out(`WARNING: ${w}`);
  out(
    `Route OK: USDT on BSC, contract ${pre.token}, ${pre.decimals} decimals, min ${pre.depositMin}, ` +
      `limit ${pre.batchReleaseLimit}, Bybit confirmations ${pre.requiredConfirmations}, deposit address ${pre.depositAddress}, uid ${pre.uid}`,
  );
  return serveAndSettle(createIntent(pre), deps, out);
}

/**
 * Continue from a chat state line. Returns { state, recovery }.
 *  - unauthenticated line (edited / other credentials) or other account: read-only recovery report
 *  - no tx hash recorded (link_issued / signing_claimed): recovery only — it cannot prove nothing was sent
 *  - --tx <hash>: attach the hash the page could not report, or replace one via verification only
 *  - --reattempt: only after a finalized revert + nonce + deposit + live route checks, opens attempt N+1
 *  - otherwise: reconcile from evidence (chain, Bybit deposit, transfer by deterministic transferId)
 */
export async function resume(input, opts = {}, deps, out = console.log) {
  const { reattempt: wantReattempt = false, txHash, retryTransfer = false, confirmFundCredit = false, recheck = false } = opts;
  const { state, authentic } = parseState(input, deps.stateKey);
  const emit = (s) => out(formatState(s, deps.stateKey));
  await deps.bybit.syncTime?.().catch(() => {});
  let uid;
  try {
    uid = String((await deps.bybit.apiKeyInfo())?.userID ?? '');
  } catch (err) {
    throw new FlowError(`cannot verify which Bybit account this API key belongs to (${safeError(err)}); nothing was changed`);
  }
  if (!authentic) {
    await recoveryReport(state, deps, out, {
      reason: 'this state line is not authenticated with the current credentials (edited, or created under another API key / FUNDKIT_STATE_KEY)',
      sameAccount: uid === state.uid,
    });
    return { state, recovery: true };
  }
  if (uid !== state.uid) {
    await recoveryReport(state, deps, out, { reason: 'the API key belongs to a different Bybit account than this intent', sameAccount: false });
    return { state, recovery: true };
  }

  let s = state;
  if (confirmFundCredit && s.target === 'UNIFIED' && !s.fundCreditConfirmed) {
    s = note({ ...s, fundCreditConfirmed: true }, 'fund_credit_confirmed_by_user');
    emit(s);
  }
  if (txHash) {
    if (!s.txHash) s = recordTx(s, { txHash });
    else if (s.txHash !== String(txHash).toLowerCase()) s = await replaceTx(s, txHash, deps);
    emit(s);
  }
  if (wantReattempt) {
    s = await reattempt(s, deps);
    emit(s);
    return { state: await serveAndSettle(s, deps, out), recovery: false };
  }
  if (!s.txHash) {
    await recoveryReport(s, deps, out, { reason: `no tx hash is recorded (phase ${s.phase}), so this checkpoint cannot prove that nothing was sent`, sameAccount: true });
    return { state: s, recovery: true };
  }
  if (s.phase === 'tx_failed') {
    out('Previous tx reverted on-chain (no USDT moved). With the user\'s OK: fundkit resume --state <line> --reattempt');
    return { state: s, recovery: false };
  }
  if (s.phase === 'done' || s.phase === 'needs_attention') {
    if (!recheck && !(retryTransfer && s.phase === 'needs_attention')) {
      out(`Intent is ${s.phase}; nothing to do automatically. (--recheck re-reads the evidence; it never re-sends.)`);
      return { state: s, recovery: false };
    }
    s = note({ ...s, phase: 'tx_submitted' }, recheck ? 'recheck_requested' : 'retry_transfer_requested');
    emit(s);
  }
  const final = await settle(s, { bybit: deps.bybit, rpcs: deps.rpcs }, {
    pollMs: deps.cfg.pollMs,
    timeoutMs: deps.cfg.timeoutMs,
    onState: emit,
    retryTransfer,
  });
  return { state: final, recovery: false };
}

export { FlowError };
