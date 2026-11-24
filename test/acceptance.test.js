// Mock acceptance: full flow against independent in-memory BSC RPCs + a signature-checking Bybit mock.
// No network, no real keys, no real funds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { resume, start } from '../src/app.js';
import { preflight } from '../src/flow.js';
import { formatState, parseState } from '../src/state.js';
import { encodeTransfer } from '../public/erc20.js';
import { LEAK_TEXT, TEST_KEY, TEST_SECRET } from './mocks/bybit.js';
import { fakeWalletProvider } from './mocks/bsc-chain.js';
import { WALLET, mockDeps, openPage, phone, setup } from './harness.js';

const U = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n; // USDT -> base units (mock amounts only)
const OTHER_WALLET = '0x' + 'a2'.repeat(20);
const quiet = () => {};
const run = (env, opts = {}, phoneOpts) =>
  Promise.all([start({ amount: '10', confirmFundCredit: true, ...opts }, env.deps, env.out), phone(env, phoneOpts)]);

async function withEnv(opts, fn) {
  const env = await setup(opts);
  try {
    await fn(env);
  } finally {
    await env.close();
  }
}

function assertNoLeaks(env, extra = []) {
  const all = env.lines.join('\n') + JSON.stringify(env.states()) + extra.join('\n');
  for (const s of [TEST_SECRET, TEST_KEY, LEAK_TEXT, 'SECRET-RPC-TEXT']) assert.ok(!all.includes(s), `never printed: ${s}`);
}

// ------------------------------------------------------------------ happy paths

test('happy path: link -> claim -> hash -> finalized on all RPCs -> credited -> one FUND->UNIFIED transfer', async () => {
  await withEnv({}, async (env) => {
    const [final, ph] = await run(env, { amount: '25.5' });
    assert.equal(final.phase, 'done');
    assert.equal(final.txHash, ph.txHash.toLowerCase());
    assert.equal(final.from, WALLET);
    assert.equal(final.transfer.status, 'SUCCESS');
    assert.equal(env.bybitMock.balances.UNIFIED, U(25.5));
    assert.equal(env.bybitMock.balances.FUND, 0n);
    assert.equal(env.bybitMock.transferCalls, 1);
    assert.equal(env.bybitMock.balanceCalls, 0, 'no balance-delta attribution');
    assert.equal(env.bybitMock.badSignatures, 0, 'every Bybit request is correctly HMAC-signed');
    assert.equal(env.bybitMock.windowViolations, 0);
    assert.equal(env.chain.sent, 1);
    assert.ok(env.lines.some((l) => l.startsWith('Open on phone in OKX Wallet: https://web3.okx.com/download?deeplink=okx%3A%2F%2Fwallet%2Fdapp%2Furl%3FdappUrl%3D')));
    for (const l of env.stateLines()) assert.match(l, /^FUNDKIT_STATE 2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'shell-safe state transport');
    const phases = env.states().map((s) => s.phase);
    for (const p of ['link_issued', 'signing_claimed', 'tx_submitted', 'tx_confirmed', 'deposit_credited', 'transfer_pending', 'done']) {
      assert.ok(phases.includes(p), `emitted ${p}`);
    }
    assertNoLeaks(env);
  });
});

test('target FUND with a read-only key: stop after the verified credit, no transfer', async () => {
  await withEnv({ bybitOpts: { readOnly: 1, permissions: {} } }, async (env) => {
    const [final] = await run(env, { target: 'FUND', confirmFundCredit: false });
    assert.equal(final.phase, 'done');
    assert.equal(env.bybitMock.transferCalls, 0);
    assert.equal(env.bybitMock.balances.FUND, U(10));
  });
});

test('UNIFIED target needs the manual Funding-credit confirmation (no API evidence of the landing account)', async () => {
  await withEnv({}, async (env) => {
    await assert.rejects(start({ amount: '1' }, env.deps, quiet), /confirm-fund-credit/);
  });
});

test('nonzero deposit fee: transfers exactly the credited net amount', async () => {
  await withEnv({ bybitOpts: { depositFee: '0.5' } }, async (env) => {
    const [final] = await run(env);
    assert.equal(final.phase, 'done');
    assert.equal(final.deposit.fee, '0.5');
    assert.equal([...env.bybitMock.transfers.values()][0].amount, '9.5');
    assert.equal(env.bybitMock.balances.UNIFIED, U(9.5));
  });
});

test('unrelated FUND balance is irrelevant: only the credited amount moves, balances never read', async () => {
  await withEnv({ bybitOpts: { fund: 1000 } }, async (env) => {
    const [final] = await run(env);
    assert.equal(final.phase, 'done');
    assert.equal(env.bybitMock.balances.FUND, U(1000));
    assert.equal(env.bybitMock.balances.UNIFIED, U(10));
    assert.equal(env.bybitMock.balanceCalls, 0);
  });
});

test('signing page works behind a path-prefixed PUBLIC_BASE_URL (proxy keeps or strips the prefix)', async () => {
  await withEnv({ prefix: '/fk/v1' }, async (env) => {
    const runP = start({ amount: '3', confirmFundCredit: true }, env.deps, env.out);
    const ph = await phone(env);
    assert.match(ph.signUrl, /\/fk\/v1\/s\/[0-9a-f]{32}$/);
    const page = await fetch(ph.signUrl);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    const html = await page.text();
    for (const rel of html.match(/(?:href|src)="(\.\.\/[^"]+)"/g).map((m) => m.split('"')[1])) {
      assert.equal((await fetch(new URL(rel, ph.signUrl))).status, 200, rel);
    }
    for (const f of ['/fk/v1/signflow.js', '/fk/v1/erc20.js', '/signflow.js']) assert.equal((await fetch(new URL(f, ph.signUrl))).status, 200, f);
    const stripped = new URL(ph.signUrl);
    stripped.pathname = stripped.pathname.replace('/fk/v1', '');
    assert.equal((await fetch(stripped)).status, 200, 'proxy that strips the prefix');
    const view = await ph.api.getIntent();
    assert.deepEqual(Object.keys(view).sort(), ['amount', 'amountBase', 'attempt', 'chainId', 'chainIdHex', 'claimed', 'decimals', 'intentId', 'mobileLink', 'phase', 'symbol', 'to', 'token', 'txHash']);
    assert.equal((await runP).phase, 'done');
  });
});

// ------------------------------------------------------------------ concurrency / duplicate signing

test('concurrent signing: one atomic claim, other tab/browser never gets a wallet prompt; concurrent tx callbacks', async () => {
  await withEnv({ bybitOpts: { confirmPolls: 3 } }, async (env) => {
    const runP = start({ amount: '3', confirmFundCredit: true }, env.deps, env.out);
    const { api } = await openPage(env);
    const claims = await Promise.allSettled([api.claim(WALLET), api.claim(OTHER_WALLET), api.claim(WALLET)]);
    const won = claims.filter((c) => c.status === 'fulfilled');
    assert.equal(won.length, 1, 'exactly one claim');
    for (const c of claims.filter((x) => x.status === 'rejected')) assert.equal(c.reason.status, 409);
    const { claimToken, tx } = won[0].value;
    assert.equal(tx.data, encodeTransfer(env.bybitMock.depositAddress, 3n * 10n ** 18n));

    // A second browser/phone running the real page logic is refused before any wallet prompt.
    env.chain.fund(OTHER_WALLET, { usdt: U(50), bnb: 10n ** 16n });
    const wallet2 = fakeWalletProvider(env.chain, OTHER_WALLET);
    await assert.rejects(phone(env, { provider: wallet2 }), (e) => e.status === 409);
    assert.ok(!wallet2.calls.includes('eth_sendTransaction'));

    // The claimer's wallet sends; two concurrent callbacks with different hashes: exactly one wins.
    const h1 = env.chain.sendTransaction(tx);
    const h2 = env.chain.sendTransaction(tx); // e.g. a buggy/rogue client reporting another hash
    const posts = await Promise.allSettled([api.submitTx(h1, claimToken), api.submitTx(h2, claimToken)]);
    assert.equal(posts.filter((p) => p.status === 'fulfilled').length, 1);
    assert.equal(posts.find((p) => p.status === 'rejected').reason.status, 409);
    await assert.rejects(api.submitTx(h1, 'not-the-token'), (e) => e.status === 403);
    const final = await runP;
    assert.equal(final.phase, 'done');
    assert.ok(final.history.some((h) => h[1] === 'second_tx_rejected'));
    assert.equal(env.bybitMock.transferCalls, 1);
  });
});

test('same browser re-reports its stored hash; wallet rejection (4001) releases the claim for a retry', async () => {
  await withEnv({ bybitOpts: { confirmPolls: 3 } }, async (env) => {
    const runP = start({ amount: '2', confirmFundCredit: true }, env.deps, env.out);
    const rejecting = fakeWalletProvider(env.chain, WALLET, { reject: true });
    await assert.rejects(phone(env, { provider: rejecting }), (e) => e.code === 4001);
    const first = await phone(env);
    assert.equal(first.reused, false);
    const again = await phone(env, { storage: first.storage });
    assert.equal(again.reused, true);
    assert.equal(again.txHash, first.txHash);
    assert.equal(env.chain.sent, 1, 'only one on-chain transfer ever sent');
    assert.equal((await runP).phase, 'done');
  });
});

test('live route is re-validated at claim time: changed deposit address -> no wallet prompt', async () => {
  await withEnv({}, async (env) => {
    const runP = start({ amount: '2', confirmFundCredit: true }, env.deps, env.out);
    const { api } = await openPage(env);
    env.bybitMock.depositAddress = '0x' + 'b9'.repeat(20);
    await assert.rejects(api.claim(WALLET), (e) => e.status === 409);
    const final = await runP;
    assert.equal(final.phase, 'needs_attention');
    assert.equal(final.history.at(-1)[1], 'route_check_failed_before_signing');
    assert.equal(env.chain.sent, 0);
  });
});

// ------------------------------------------------------------------ resume / stale checkpoints

test('resume from every earlier snapshot never duplicates the transfer', async () => {
  await withEnv({}, async (env) => {
    await run(env, { amount: '7' });
    for (const phase of ['tx_submitted', 'tx_confirmed', 'deposit_credited', 'transfer_pending']) {
      const { state, recovery } = await resume(env.lineFor(phase), {}, env.deps, quiet);
      assert.equal(recovery, false);
      assert.equal(state.phase, 'done', `resume from ${phase}`);
    }
    assert.equal(env.bybitMock.transferCalls, 1);
    assert.equal(env.bybitMock.balances.UNIFIED, U(7));
    assert.equal(env.chain.sent, 1);
  });
});

test('older snapshot + lagging transfer list: re-POST gets documented 131214 and only reconciles', async () => {
  await withEnv({}, async (env) => {
    await run(env, { amount: '7' });
    env.bybitMock.listLag = 2;
    const { state } = await resume(env.lineFor('transfer_pending'), {}, env.deps, quiet);
    assert.equal(state.phase, 'done');
    assert.ok(state.history.some((h) => h[1] === 'transfer_submit_duplicate'));
    assert.equal(env.bybitMock.transfers.size, 1);
    assert.equal(env.bybitMock.balances.UNIFIED, U(7));
  });
});

test('stale link_issued / signing_claimed checkpoints never rearm signing (recovery only)', async () => {
  await withEnv({}, async (env) => {
    const [final] = await run(env, { amount: '5' });
    for (const phase of ['link_issued', 'signing_claimed']) {
      const out = [];
      const { state, recovery } = await resume(env.lineFor(phase), {}, env.deps, (l) => out.push(l));
      assert.equal(recovery, true, phase);
      assert.equal(state.phase, phase);
      assert.ok(!out.some((l) => /Signing page|Open on phone/.test(l)), 'no link served');
      assert.ok(out.some((l) => l.includes(final.txHash)), 'points at the matching Bybit deposit');
      await assert.rejects(resume(env.lineFor(phase), { reattempt: true }, env.deps, quiet), /no tx recorded/);
    }
    assert.equal(env.chain.sent, 1);
  });
});

test('page never reported the hash: --tx attaches it (sender bound by claim), verifies, settles', async () => {
  await withEnv({}, async (env) => {
    env.cfg.timeoutMs = 300;
    let sent;
    const wallet = fakeWalletProvider(env.chain, WALLET, { onSend: () => {} });
    const dying = {
      async request(a) {
        if (a.method !== 'eth_sendTransaction') return wallet.request(a);
        sent = await wallet.request(a);
        throw new Error('in-app browser was killed'); // hash never reaches the page
      },
    };
    const [timedOut] = await Promise.all([start({ amount: '6', confirmFundCredit: true }, env.deps, env.out), phone(env, { provider: dying }).catch(() => null)]);
    assert.equal(timedOut.phase, 'signing_claimed');
    env.cfg.timeoutMs = 10_000;
    const line = env.stateLines().at(-1);
    const { state } = await resume(line, { txHash: sent }, env.deps, quiet);
    assert.equal(state.phase, 'done');
    assert.equal(env.bybitMock.balances.UNIFIED, U(6));
    await assert.rejects(resume(formatState(state, env.deps.stateKey), { txHash: '0x' + 'ef'.repeat(32) }, env.deps, quiet), /finalized successful/);
  });
});

test('hash correction/replacement is verification-only (wrong sender refused, speed-up replacement accepted)', async () => {
  await withEnv({}, async (env) => {
    env.cfg.timeoutMs = 300;
    env.chain.fund(OTHER_WALLET, { usdt: U(50), bnb: 10n ** 16n });
    let hidden;
    const base = fakeWalletProvider(env.chain, WALLET);
    const speedUp = {
      async request(a) {
        if (a.method !== 'eth_sendTransaction') return base.request(a);
        hidden = env.chain.sendTransaction(a.params[0], { hidden: true }); // later replaced by a speed-up
        throw new Error('page lost');
      },
    };
    const [claimed] = await Promise.all([start({ amount: '4', confirmFundCredit: true }, env.deps, env.out), phone(env, { provider: speedUp }).catch(() => null)]);
    const tx = { to: claimed.token, data: encodeTransfer(claimed.depositAddress, claimed.amountBase) };
    const r1 = await resume(env.stateLines().at(-1), { txHash: hidden }, env.deps, env.out);
    assert.equal(r1.state.phase, 'tx_submitted', 'original hash never shows up (dropped/replaced)');
    env.rpcViews[1].override = (m, p, r) => {
      if (m === 'eth_chainId') throw new Error('down');
      return r;
    };
    await assert.rejects(resume(env.stateLines().at(-1), { txHash: '0x' + '77'.repeat(32) }, env.deps, quiet), /not every RPC answered/);
    env.rpcViews[1].override = undefined;
    const foreign = env.chain.sendTransaction({ ...tx, from: OTHER_WALLET });
    env.chain.mine(5);
    await assert.rejects(resume(env.stateLines().at(-1), { txHash: foreign }, env.deps, quiet), /mismatch: tx.from is not the wallet bound/);
    const replacement = env.chain.sendTransaction({ ...tx, from: WALLET });
    await assert.rejects(resume(env.stateLines().at(-1), { txHash: replacement }, env.deps, quiet), /pending: .*not finalized/, 'unfinalized replacement refused');
    env.chain.mine(5);
    env.cfg.timeoutMs = 10_000;
    const r2 = await resume(env.stateLines().at(-1), { txHash: replacement }, env.deps, quiet);
    assert.equal(r2.state.phase, 'done');
    assert.deepEqual(r2.state.replacedTx, [hidden]);
  });
});

// ------------------------------------------------------------------ authentication of checkpoints

test('credential change, other account, or edited line -> read-only recovery, no transfer, no new state', async () => {
  await withEnv({}, async (env) => {
    await run(env, { amount: '5' });
    const line = env.lineFor('deposit_credited');
    const calls = env.bybitMock.transferCalls;

    // rotated API secret: old MAC no longer verifies
    env.bybitMock.secret = 'rotated-mock-secret';
    const rotated = mockDeps(env, { secret: 'rotated-mock-secret' });
    const out = [];
    const r = await resume(line, {}, rotated, (l) => out.push(l));
    assert.equal(r.recovery, true);
    assert.ok(out.some((l) => /RECOVERY ONLY: .*not authenticated/.test(l)));
    assert.ok(!out.some((l) => l.startsWith('FUNDKIT_STATE')), 'never re-signs an unauthenticated line');
    env.bybitMock.secret = TEST_SECRET;

    // same credentials, but the key now belongs to another UID
    env.bybitMock.uid = '2002';
    assert.equal((await resume(line, {}, env.deps, quiet)).recovery, true);
    env.bybitMock.uid = 1001;

    // edited payload (recipient swapped) keeps the old MAC -> not authentic
    const [, payload, mac] = line.match(/^FUNDKIT_STATE 2\.([^.]+)\.(.+)$/);
    const edited = JSON.parse(Buffer.from(payload, 'base64url').toString());
    edited.depositAddress = '0x' + 'dd'.repeat(20);
    edited.phase = 'transfer_pending';
    const forged = `FUNDKIT_STATE 2.${Buffer.from(JSON.stringify(edited)).toString('base64url')}.${mac}`;
    assert.equal(parseState(forged, env.deps.stateKey).authentic, false);
    assert.equal((await resume(forged, {}, env.deps, quiet)).recovery, true);
    assert.equal(env.bybitMock.transferCalls, calls);

    // schema: unknown fields / bad types are rejected outright
    const bad = `FUNDKIT_STATE 2.${Buffer.from(JSON.stringify({ ...edited, extra: 1 })).toString('base64url')}.${mac}`;
    await assert.rejects(resume(bad, {}, env.deps, quiet), /unexpected field/);
  });
});

test('FUNDKIT_STATE_KEY keeps checkpoints valid across API key rotation', async () => {
  await withEnv({}, async (env) => {
    const stateEnv = { FUNDKIT_STATE_KEY: 'k'.repeat(40) };
    env.deps = mockDeps(env, { stateEnv });
    await run(env, { amount: '5' });
    env.bybitMock.secret = 'rotated-mock-secret';
    const rotated = mockDeps(env, { secret: 'rotated-mock-secret', stateEnv });
    const { state, recovery } = await resume(env.lineFor('tx_confirmed'), {}, rotated, quiet);
    assert.equal(recovery, false);
    assert.equal(state.phase, 'done');
    assert.equal(env.bybitMock.transferCalls, 1);
  });
});

// ------------------------------------------------------------------ RPC evidence

test('RPC disagreement on the receipt -> needs_attention; never a reattempt opportunity', async () => {
  const liar = { override: (m, p, r) => (m === 'eth_getTransactionReceipt' && r ? { ...r, status: '0x0', logs: [] } : r) };
  await withEnv({ rpcViews: [{}, liar] }, async (env) => {
    const [final] = await run(env);
    assert.equal(final.phase, 'needs_attention');
    assert.equal(final.history.at(-1)[1], 'onchain_disagree');
    assert.equal(env.bybitMock.transferCalls, 0);
    await assert.rejects(resume(env.stateLines().at(-1), { reattempt: true }, env.deps, quiet), /finalized revert/);
  });
});

test('lagging / unavailable / not-yet-finalized RPC: waits, then settles once every RPC agrees', async () => {
  const seen = { tx: 0, fin: 0, chain: 0 };
  const lagging = {
    override: (m, p, r) => {
      if (m === 'eth_getTransactionByHash' && seen.tx++ < 4) return null; // not propagated yet
      if (m === 'eth_getBlockByNumber' && p[0] === 'finalized' && seen.fin++ < 4) return { ...r, number: '0x1' }; // finality lag
      if (m === 'eth_chainId' && seen.chain++ === 12) throw new Error('down'); // one outage
      return r;
    },
  };
  await withEnv({ rpcViews: [{}, lagging] }, async (env) => {
    const [final] = await run(env);
    assert.equal(final.phase, 'done');
    assert.ok(env.states().some((s) => s.history.some((h) => h[1] === 'onchain_waiting')));
    assertNoLeaks(env);
  });
});

test('reverted tx -> tx_failed; --reattempt re-verifies (finalized revert, nonce, deposits, route) and completes', async () => {
  await withEnv({}, async (env) => {
    env.chain.revertNext = true;
    const [failed] = await run(env, { amount: '4' });
    assert.equal(failed.phase, 'tx_failed');
    const failedLine = env.stateLines().at(-1);
    const blocked = await resume(failedLine, {}, env.deps, quiet);
    assert.equal(blocked.state.phase, 'tx_failed', 'no new link without explicit --reattempt');
    env.lines.length = 0;
    const [{ state: final }, ph] = await Promise.all([resume(failedLine, { reattempt: true }, env.deps, env.out), phone(env)]);
    assert.equal(ph.intent.attempt, 2);
    assert.equal(final.phase, 'done');
    assert.equal(final.failedTx.length, 1);
    assert.equal(env.bybitMock.balances.UNIFIED, U(4));
    // the older tx_failed snapshot can never open a third signing opportunity
    await assert.rejects(resume(failedLine, { reattempt: true }, env.deps, quiet), /other transactions|may belong/);
  });
});

test('reattempt refused when the sender sent anything after the reverted tx', async () => {
  await withEnv({}, async (env) => {
    env.chain.revertNext = true;
    const [failed] = await run(env, { amount: '4' });
    env.chain.sendTransaction({ from: WALLET, to: '0x' + 'cc'.repeat(20), data: '0x' }, { hidden: true }); // pending elsewhere
    await assert.rejects(resume(env.stateLines().at(-1), { reattempt: true }, env.deps, quiet), /other transactions/);
    assert.equal(failed.attempt, 1);
  });
});

// ------------------------------------------------------------------ Bybit deposit evidence

test('held / rolled-back / funding-pool / travel-rule deposits stop for a human, no transfer', async () => {
  const cases = [
    [{ finalStatus: 7 }, 'bybit_deposit_held', /rollbackProcessing/],
    [{ finalStatus: 70013 }, 'bybit_deposit_held', /rollbackFailedManualReview/],
    [{ finalStatus: 10012 }, 'bybit_deposit_held', /creditedFundingPool/],
    [{ finalStatus: 3, depositType: '10' }, 'bybit_deposit_held', /dailyLimitReached/],
    [{ finalStatus: 3, extraRowFields: { travelRuleStatus: '1' } }, 'bybit_deposit_held', /travel rule/],
    [{ finalStatus: 4 }, 'bybit_deposit_failed', /failed/],
    [{ finalStatus: 70011 }, 'bybit_deposit_failed', /rolledBack/],
    [{ finalStatus: 3, extraRowFields: { amount: '11' } }, 'bybit_deposit_mismatch', /does not account/],
  ];
  for (const [bybitOpts, event, re] of cases) {
    await withEnv({ bybitOpts: { confirmPolls: 0, ...bybitOpts } }, async (env) => {
      const [final] = await run(env);
      assert.equal(final.phase, 'needs_attention', JSON.stringify(bybitOpts));
      assert.equal(final.history.at(-1)[1], event);
      assert.match(final.history.at(-1)[2], re);
      assert.equal(env.bybitMock.transferCalls, 0);
    });
  }
  await withEnv({ bybitOpts: { finalStatus: 70012 } }, async (env) => {
    assert.equal((await run(env))[0].phase, 'done', '70012 = remains successful after rollback review');
  });
});

test('Bybit txID without 0x / upper-case, and bounded paginated scan when txID lookup finds nothing', async () => {
  for (const bybitOpts of [{ txIdForm: 'bare' }, { txIdForm: 'upper' }, { txIdQueryBroken: true, unrelatedDeposits: 120 }]) {
    await withEnv({ bybitOpts }, async (env) => {
      const [final] = await run(env);
      assert.equal(final.phase, 'done', JSON.stringify(bybitOpts));
      assert.equal(env.bybitMock.windowViolations, 0);
    });
  }
});

// ------------------------------------------------------------------ Bybit transfer evidence

test('ambiguous transfer (executed, 502) + lagging list: reconcile only, exactly one POST', async () => {
  await withEnv({}, async (env) => {
    env.bybitMock.ambiguousNextTransfer = true;
    env.bybitMock.listLag = 4;
    const [final] = await run(env, { amount: '12' });
    assert.equal(final.phase, 'done');
    assert.equal(env.bybitMock.transferCalls, 1);
    assert.equal(env.bybitMock.balances.UNIFIED, U(12));
    assert.ok(final.history.some((h) => h[1] === 'awaiting_transfer_record'));
    assertNoLeaks(env);
  });
});

test('ambiguous transfer that did NOT execute: no blind re-POST; explicit --retry-transfer reuses the same transferId', async () => {
  await withEnv({}, async (env) => {
    env.bybitMock.failBeforeExecuteNext = true;
    env.cfg.timeoutMs = 400;
    const [pending] = await run(env, { amount: '8' });
    assert.equal(pending.phase, 'transfer_pending');
    assert.equal(pending.transfer.outcome, 'ambiguous');
    assert.equal(env.bybitMock.transferCalls, 1);
    const again = await resume(env.stateLines().at(-1), {}, env.deps, quiet);
    assert.equal(again.state.phase, 'transfer_pending');
    assert.equal(env.bybitMock.transferCalls, 1, 'plain resume only reconciles');
    env.cfg.timeoutMs = 10_000;
    const { state } = await resume(env.stateLines().at(-1), { retryTransfer: true }, env.deps, quiet);
    assert.equal(state.phase, 'done');
    assert.equal(env.bybitMock.transferCalls, 2);
    assert.deepEqual([...env.bybitMock.transfers.keys()], [pending.transfer.transferId]);
  });
});

test('permanent transfer error (deposit auto-moved, 131212): stop, never re-POST, no raw retMsg', async () => {
  await withEnv({ bybitOpts: { creditToUnified: true } }, async (env) => {
    const [final] = await run(env);
    assert.equal(final.phase, 'needs_attention');
    assert.deepEqual(final.history.at(-1).slice(1), ['transfer_rejected', 'retCode 131212']);
    const out = [];
    await resume(env.stateLines().at(-1), {}, env.deps, (l) => out.push(l));
    const re = await resume(env.stateLines().at(-1), { recheck: true }, env.deps, (l) => out.push(l));
    assert.equal(re.state.phase, 'needs_attention');
    assert.equal(env.bybitMock.transferCalls, 1, 'recheck never re-POSTs a rejected transfer');
    // user fixed it (moved the deposit back to Funding in the app); explicit retry reuses the same transferId once
    env.bybitMock.balances.UNIFIED -= U(10);
    env.bybitMock.balances.FUND += U(10);
    const fixed = await resume(formatState(re.state, env.deps.stateKey), { retryTransfer: true }, env.deps, (l) => out.push(l));
    assert.equal(fixed.state.phase, 'done');
    assert.equal(env.bybitMock.transferCalls, 2);
    assert.equal(env.bybitMock.transfers.size, 1);
    assertNoLeaks(env, out);
  });
});

// ------------------------------------------------------------------ preflight / config

test('preflight rejects bad routes, non-UTA accounts, risky or unreadable keys; never echoes retMsg', async () => {
  const cases = [
    [{ contractAddress: '0x' + '12'.repeat(20) }, '1', /canonical/],
    [{ chainDeposit: '0' }, '1', /suspended/],
    [{}, '0.00001', /below the Bybit minimum/],
    [{}, '1.123456789', /precision/],
    [{ permissions: { Wallet: [] } }, '1', /AccountTransfer/],
    [{ permissions: { Wallet: ['AccountTransfer', 'Withdraw'] } }, '1', /Withdraw/],
    [{ uta: 0 }, '1', /Unified Trading Account/],
    [{ unifiedMarginStatus: 1 }, '1', /Unified Trading Account/],
    [{ readOnly: 1 }, '1', /read-only/],
    [{ denyRead: true }, '1', /cannot read deposit\/transfer records \(Bybit .* failed \(retCode 10005\)\)/],
  ];
  for (const [bybitOpts, amount, re] of cases) {
    await withEnv({ bybitOpts }, async (env) => {
      await assert.rejects(preflight({ bybit: env.deps.bybit, rpcs: env.deps.rpcs, amount, fundCreditConfirmed: true }), (err) => {
        assert.match(err.message, re);
        assert.ok(!err.message.includes(LEAK_TEXT));
        return true;
      });
    });
  }
  await withEnv({ bybitOpts: { permissions: { Wallet: ['AccountTransfer'], Spot: ['SpotTrade'] } } }, async (env) => {
    const pre = await preflight({ bybit: env.deps.bybit, rpcs: env.deps.rpcs, amount: '1', fundCreditConfirmed: true });
    assert.match(pre.warnings.join(), /unneeded Spot/);
  });
});

test('listen error (port in use) rejects instead of hanging', async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const { port } = blocker.address();
  try {
    await withEnv({}, async (env) => {
      env.cfg.port = port;
      await assert.rejects(start({ amount: '1', confirmFundCredit: true }, env.deps, quiet), /cannot listen .*EADDRINUSE/);
    });
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});
