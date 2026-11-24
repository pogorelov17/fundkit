// Mock acceptance: full flow against an in-memory BSC + signature-checking Bybit mock.
// No network, no real keys, no real funds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resume, start } from '../src/app.js';
import { preflight } from '../src/flow.js';
import { parseState } from '../src/state.js';
import { TEST_KEY, TEST_SECRET } from './mocks/bybit.js';
import { fakeWalletProvider } from './mocks/bsc-chain.js';
import { WALLET, phone, setup } from './harness.js';

const states = (env) => env.lines.filter((l) => l.startsWith('FUNDKIT_STATE ')).map(parseState);

test('happy path: link -> hash captured -> verified -> credited to FUND -> moved to UNIFIED once', async () => {
  const env = await setup();
  try {
    const [final, ph] = await Promise.all([start({ amount: '25.5' }, env.deps, env.out), phone(env)]);
    assert.equal(final.phase, 'done');
    assert.equal(final.txHash, ph.txHash.toLowerCase());
    assert.equal(final.transfer.status, 'SUCCESS');
    assert.equal(env.bybitMock.balances.UNIFIED, 25.5);
    assert.equal(env.bybitMock.balances.FUND, 0);
    assert.equal(env.bybitMock.transferCalls, 1);
    assert.equal(env.bybitMock.badSignatures, 0, 'every Bybit request is correctly HMAC-signed');
    assert.equal(env.chain.sent, 1);
    assert.ok(env.lines.some((l) => l.startsWith('Open on phone in OKX Wallet: https://web3.okx.com/download?deeplink=okx%3A%2F%2Fwallet%2Fdapp%2Furl%3FdappUrl%3D')));
    const all = env.lines.join('\n');
    assert.ok(!all.includes(TEST_SECRET) && !all.includes(TEST_KEY), 'credentials never printed');
    const phases = states(env).map((s) => s.phase);
    for (const p of ['link_issued', 'tx_submitted', 'tx_confirmed', 'deposit_credited', 'transfer_pending', 'done']) {
      assert.ok(phases.includes(p), `emitted ${p}`);
    }
  } finally {
    await env.close();
  }
});

test('deposit credited straight to UNIFIED: no funding->unified transfer', async () => {
  const env = await setup({ bybitOpts: { creditToUnified: true } });
  try {
    const [final] = await Promise.all([start({ amount: '10' }, env.deps, env.out), phone(env)]);
    assert.equal(final.phase, 'done');
    assert.equal(final.transfer.needed, false);
    assert.equal(env.bybitMock.transferCalls, 0);
  } finally {
    await env.close();
  }
});

test('target FUND: stop after verified credit', async () => {
  const env = await setup();
  try {
    const [final] = await Promise.all([start({ amount: '10', target: 'FUND' }, env.deps, env.out), phone(env)]);
    assert.equal(final.phase, 'done');
    assert.equal(env.bybitMock.transferCalls, 0);
    assert.equal(env.bybitMock.balances.FUND, 10);
  } finally {
    await env.close();
  }
});

test('resume from any earlier chat state line never duplicates the transfer', async () => {
  const env = await setup();
  try {
    await Promise.all([start({ amount: '7' }, env.deps, env.out), phone(env)]);
    const emitted = states(env);
    for (const phase of ['tx_submitted', 'tx_confirmed', 'deposit_credited', 'transfer_pending']) {
      const s = emitted.find((x) => x.phase === phase);
      const again = await resume(s, {}, env.deps, () => {});
      assert.equal(again.phase, 'done', `resume from ${phase}`);
    }
    assert.equal(env.bybitMock.transferCalls, 1);
    assert.equal(env.bybitMock.balances.UNIFIED, 7);
    assert.equal(env.chain.sent, 1);
  } finally {
    await env.close();
  }
});

test('ambiguous transfer response (502) + lagging transfer list: still exactly one transfer', async () => {
  const env = await setup();
  env.bybitMock.ambiguousNextTransfer = true;
  env.bybitMock.listLag = 4;
  try {
    const [final] = await Promise.all([start({ amount: '12' }, env.deps, env.out), phone(env)]);
    assert.equal(final.phase, 'done');
    assert.equal(env.bybitMock.transferCalls, 1);
    assert.equal(env.bybitMock.balances.UNIFIED, 12);
    assert.ok(final.history.some((h) => h[1] === 'awaiting_transfer_record'));
  } finally {
    await env.close();
  }
});

test('duplicate signing is blocked: same browser, other browser, and a second hash', async () => {
  const env = await setup({ bybitOpts: { confirmPolls: 40 } });
  try {
    const run = start({ amount: '3' }, env.deps, env.out);
    const first = await phone(env);
    // the signing page is served with a strict CSP and exposes only public route data
    const page = await fetch(first.signUrl);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    for (const f of ['/sign.js', '/signflow.js', '/erc20.js', '/sign.css']) {
      assert.equal((await fetch(new URL(f, first.signUrl))).status, 200, f);
    }
    const view = await (await first.api.getIntent());
    assert.deepEqual(Object.keys(view).sort(), ['amount', 'amountBase', 'attempt', 'chainId', 'chainIdHex', 'decimals', 'intentId', 'mobileLink', 'phase', 'symbol', 'to', 'token', 'txHash']);
    const sameBrowser = await phone(env, { storage: first.storage });
    assert.equal(sameBrowser.reused, true);
    const otherBrowser = await phone(env); // fresh storage: server-side txHash guard
    assert.equal(otherBrowser.reused, true);
    assert.equal(otherBrowser.txHash, first.txHash.toLowerCase());
    await assert.rejects(first.api.submitTx('0x' + 'ee'.repeat(32), first.from), /refusing second hash/);
    assert.equal(env.chain.sent, 1, 'only one on-chain transfer ever requested');
    const final = await run;
    assert.equal(final.phase, 'done');
    assert.ok(final.history.some((h) => h[1] === 'second_tx_rejected'));
  } finally {
    await env.close();
  }
});

test('tampered wallet tx (wrong recipient) is caught on-chain and stops for a human', async () => {
  const env = await setup();
  const honest = fakeWalletProvider(env.chain, WALLET);
  const evil = {
    async request(args) {
      if (args.method === 'eth_sendTransaction') {
        const p = { ...args.params[0] };
        p.data = p.data.slice(0, 10) + '0'.repeat(24) + 'dd'.repeat(20) + p.data.slice(74);
        return env.chain.sendTransaction(p);
      }
      return honest.request(args);
    },
  };
  try {
    const [final] = await Promise.all([start({ amount: '5' }, env.deps, env.out), phone(env, { provider: evil })]);
    assert.equal(final.phase, 'needs_attention');
    assert.match(final.history.at(-1)[2], /Bybit deposit address/);
    assert.equal(env.bybitMock.transferCalls, 0);
  } finally {
    await env.close();
  }
});

test('reverted tx -> tx_failed; --reattempt re-verifies route and completes with attempt 2', async () => {
  const env = await setup();
  env.chain.revertNext = true;
  try {
    const [failed] = await Promise.all([start({ amount: '4' }, env.deps, env.out), phone(env)]);
    assert.equal(failed.phase, 'tx_failed');
    const blocked = await resume(failed, {}, env.deps, () => {});
    assert.equal(blocked.phase, 'tx_failed', 'no new link without explicit --reattempt');
    env.lines.length = 0;
    const [final, ph] = await Promise.all([resume(failed, { reattempt: true }, env.deps, env.out), phone(env)]);
    assert.equal(ph.intent.attempt, 2);
    assert.equal(final.phase, 'done');
    assert.equal(final.failedTx.length, 1);
    assert.equal(env.bybitMock.balances.UNIFIED, 4);
  } finally {
    await env.close();
  }
});

test('precheck refuses to enable sending without BNB for gas or enough USDT', async () => {
  const env = await setup({ bnb: 0n, bybitOpts: {} });
  env.deps.cfg.timeoutMs = 300;
  try {
    const [final, ph] = await Promise.all([start({ amount: '1' }, env.deps, env.out), phone(env)]);
    assert.equal(ph.pre.enoughGas, false);
    assert.equal(ph.pre.enoughToken, true);
    assert.equal(final.phase, 'link_issued');
    assert.equal(env.chain.sent, 0);
  } finally {
    await env.close();
  }
});

test('preflight rejects bad routes, amounts and non-https links', async () => {
  const cases = [
    [{ contractAddress: '0x' + '12'.repeat(20) }, '1', /canonical/],
    [{ chainDeposit: '0' }, '1', /suspended/],
    [{}, '0.00001', /below Bybit minimum/],
    [{}, '1.123456789', /precision/],
    [{ permissions: { Wallet: [] } }, '1', /AccountTransfer/],
  ];
  for (const [bybitOpts, amount, re] of cases) {
    const env = await setup({ bybitOpts });
    try {
      await assert.rejects(preflight({ bybit: env.deps.bybit, rpcs: env.deps.rpcs, amount }), re);
    } finally {
      await env.close();
    }
  }
  const env = await setup({ bybitOpts: { permissions: { Wallet: ['AccountTransfer', 'Withdraw'] } } });
  try {
    const pre = await preflight({ bybit: env.deps.bybit, rpcs: env.deps.rpcs, amount: '1' });
    assert.match(pre.warnings.join(), /Withdraw/);
    env.deps.cfg.publicBaseUrl = 'http://example.com';
    await assert.rejects(start({ amount: '1' }, env.deps, () => {}), /https/);
  } finally {
    await env.close();
  }
});

test('page never reported the hash: resume --tx attaches it, verifies, settles', async () => {
  const env = await setup();
  env.deps.cfg.timeoutMs = 200;
  try {
    const timedOut = await start({ amount: '6' }, env.deps, env.out);
    assert.equal(timedOut.phase, 'link_issued');
    // user sent from OKX Wallet but the page died before reporting; hash copied from wallet history
    const { encodeTransfer } = await import('../public/erc20.js');
    const hash = env.chain.sendTransaction({ from: WALLET, to: timedOut.token, data: encodeTransfer(timedOut.depositAddress, timedOut.amountBase) });
    env.deps.cfg.timeoutMs = 10_000;
    const final = await resume(timedOut, { txHash: hash }, env.deps, () => {});
    assert.equal(final.phase, 'done');
    assert.equal(env.bybitMock.balances.UNIFIED, 6);
    await assert.rejects(resume(final, { txHash: '0x' + 'ef'.repeat(32) }, env.deps, () => {}), /refusing second hash/);
  } finally {
    await env.close();
  }
});
