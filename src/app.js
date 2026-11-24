import { RpcClient } from './bsc.js';
import { BybitClient } from './bybit.js';
import { createIntent, preflight, recordTx, reopenAfterFailure, settle } from './flow.js';
import { assertHttps, okxUniversalLink, qrTerminal, signingUrl } from './links.js';
import { createSigningServer } from './server.js';
import { formatState, note } from './state.js';

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
  return { cfg, bybit: BybitClient.fromEnv(env), rpcs: cfg.rpcUrls.map((u) => new RpcClient(u)) };
}

/** Prints one chat-carried state line. */
export const emitState = (out) => (state) => out(formatState(state));

/**
 * Serve the signing page for `state` (phase link_issued), print link + QR, wait for the hash,
 * then settle. Resolves with the final state.
 */
export async function serveAndSettle(state, { bybit, rpcs, cfg }, out = console.log) {
  assertHttps(cfg.publicBaseUrl, { allowInsecure: cfg.allowInsecure });
  const emit = emitState(out);
  let current = state;
  let resolveTx;
  const alerts = []; // events that arrive while settle() owns the state; merged into the final state
  const gotTx = new Promise((r) => (resolveTx = r));
  const session = {
    get: () => current,
    set: (next) => {
      current = next;
      emit(current);
      resolveTx();
    },
    duplicate: (hash) => {
      alerts.push(hash);
      current = note(current, 'second_tx_rejected', hash);
      emit(current);
      out(`WARNING: a second tx hash ${hash} was reported for this intent. Check the wallet; it may need manual recovery.`);
    },
  };
  const server = createSigningServer({ session, rpcs, publicBaseUrl: cfg.publicBaseUrl, log: out });
  await new Promise((r) => server.listen(cfg.port, cfg.host, r));
  const addr = server.address();
  try {
    const signUrl = signingUrl(cfg.publicBaseUrl, state.intentId);
    const mobile = okxUniversalLink(signUrl);
    out(`Local helper listening on http://${addr.address}:${addr.port} (expose it as ${cfg.publicBaseUrl})`);
    out(`Signing page: ${signUrl}`);
    out(`Open on phone in OKX Wallet: ${mobile}`);
    out(await qrTerminal(mobile));
    out('Waiting for the wallet to submit the transaction…');
    emit(current);
    let timer;
    const timeout = new Promise((r) => (timer = setTimeout(r, cfg.timeoutMs, 'timeout')));
    const winner = await Promise.race([gotTx, timeout]);
    clearTimeout(timer);
    if (winner === 'timeout') {
      current = note(current, 'timeout', 'no tx hash received; resume with the same state to re-serve the same link');
      emit(current);
      return current;
    }
    const captured = current;
    let final = await settle(captured, { bybit, rpcs }, {
      pollMs: cfg.pollMs,
      timeoutMs: cfg.timeoutMs,
      onState: (s) => {
        current = s; // the page sees live progress
        emit(s);
      },
    });
    const lateAlerts = alerts.filter((h) => !(final.history || []).some((e) => e[1] === 'second_tx_rejected' && e[2] === h));
    for (const h of lateAlerts) final = note(final, 'second_tx_rejected', h);
    if (lateAlerts.length) emit(final);
    return final;
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

export async function start({ amount, target = 'UNIFIED' }, deps, out = console.log) {
  assertHttps(deps.cfg.publicBaseUrl, { allowInsecure: deps.cfg.allowInsecure });
  await deps.bybit.syncTime?.().catch(() => {});
  const pre = await preflight({ bybit: deps.bybit, rpcs: deps.rpcs, amount, target });
  for (const w of pre.warnings) out(`WARNING: ${w}`);
  out(
    `Route OK: USDT on BSC, contract ${pre.token}, ${pre.decimals} decimals, min ${pre.depositMin}, ` +
      `limit ${pre.batchReleaseLimit}, Bybit confirmations ${pre.requiredConfirmations}, deposit address ${pre.depositAddress}`,
  );
  return serveAndSettle(createIntent(pre), deps, out);
}

/**
 * Continue from a chat state line. Never creates a second payment for an intent that has a hash:
 *  - link_issued: re-serve the SAME intent/link (page refuses to send if a hash already exists)
 *  - tx_failed + reattempt: open attempt N+1 (previous tx reverted, so no funds moved)
 *  - --tx <hash>: attach a hash the page could not report (same one-hash rule applies)
 *  - otherwise: settle (verify chain, Bybit credit, funding->unified transfer)
 */
export async function resume(state, { reattempt = false, txHash } = {}, deps, out = console.log) {
  await deps.bybit.syncTime?.().catch(() => {});
  if (txHash) {
    // Hash recovered by hand (e.g. from OKX Wallet history) when the page could not report it.
    state = recordTx(state, { txHash });
    out(formatState(state));
  }
  if (state.phase === 'tx_failed') {
    if (!reattempt) {
      out('Previous tx reverted on-chain (no USDT moved). Re-run with --reattempt to issue a fresh signing link.');
      return state;
    }
    // Re-verify the live route before asking for another signature.
    const pre = await preflight({ bybit: deps.bybit, rpcs: deps.rpcs, amount: state.amount, target: state.target });
    if (pre.depositAddress.toLowerCase() !== state.depositAddress.toLowerCase()) {
      throw new Error('Bybit deposit address changed since the intent was created; start a new intent');
    }
    state = reopenAfterFailure(state);
  }
  if (state.phase === 'link_issued') return serveAndSettle(state, deps, out);
  if (state.phase === 'needs_attention' || state.phase === 'done') {
    out(`Intent is ${state.phase}; nothing to do automatically.`);
    return state;
  }
  return settle(state, { bybit: deps.bybit, rpcs: deps.rpcs }, {
    pollMs: deps.cfg.pollMs,
    timeoutMs: deps.cfg.timeoutMs,
    onState: emitState(out),
  });
}
