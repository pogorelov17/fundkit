// Shared mock environment for acceptance tests and `npm run demo`.
import { RpcClient } from '../src/bsc.js';
import { BybitClient } from '../src/bybit.js';
import { MockChain, fakeWalletProvider, startRpcServer } from './mocks/bsc-chain.js';
import { MockBybit, TEST_KEY, TEST_SECRET, startBybitServer } from './mocks/bybit.js';
import { connect, makeApi, report, send, validateIntent } from '../public/signflow.js';

// Mock-only addresses; they belong to nobody.
export const WALLET = '0x' + 'a1'.repeat(20);

export async function setup({ bybitOpts = {}, usdt = 100n * 10n ** 18n, bnb = 10n ** 16n, rpcCount = 2 } = {}) {
  const chain = new MockChain();
  chain.fund(WALLET, { usdt, bnb });
  const bybitMock = new MockBybit(chain, bybitOpts);
  const rpcSrv = await startRpcServer(chain);
  const bybitSrv = await startBybitServer(bybitMock);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const cfg = {
    rpcUrls: Array(rpcCount).fill(rpcSrv.url),
    publicBaseUrl: `http://127.0.0.1:${port}`,
    port,
    host: '127.0.0.1',
    allowInsecure: true, // mock only; real runs require https PUBLIC_BASE_URL
    pollMs: 10,
    timeoutMs: 10_000,
  };
  const deps = {
    cfg,
    bybit: new BybitClient({ apiKey: TEST_KEY, apiSecret: TEST_SECRET, baseUrl: bybitSrv.url }),
    rpcs: cfg.rpcUrls.map((u) => new RpcClient(u)),
  };
  const lines = [];
  let onLine = () => {};
  const out = (l) => {
    lines.push(String(l));
    onLine(String(l));
  };
  const waitFor = (re) =>
    new Promise((resolve) => {
      const hit = lines.find((l) => re.test(l));
      if (hit) return resolve(hit);
      const prev = onLine;
      onLine = (l) => {
        prev(l);
        if (re.test(l)) resolve(l);
      };
    });
  return {
    chain,
    bybitMock,
    deps,
    out,
    lines,
    waitFor,
    close: async () => {
      await rpcSrv.close();
      await bybitSrv.close();
    },
  };
}

/** Plays the phone: opens the signing URL's API, connects the fake OKX provider, sends, reports. */
export async function phone(env, { storage = new Map(), provider } = {}) {
  const line = await env.waitFor(/^Signing page: /);
  const signUrl = line.replace(/^Signing page: /, '');
  const u = new URL(signUrl);
  const api = makeApi(`${u.origin}/api/intent/${u.pathname.split('/').pop()}`);
  const store = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
  const intent = validateIntent(await api.getIntent());
  const wallet = provider || fakeWalletProvider(env.chain, WALLET);
  const from = await connect(wallet, intent);
  const pre = await api.precheck(from);
  if (!pre.enoughToken || !pre.enoughGas) return { intent, pre, sent: null };
  const { txHash, reused } = await send(wallet, intent, from, store);
  const reported = await report(api, txHash, from, { sleep: async () => {} });
  return { intent, pre, txHash, reused, reported, api, from, wallet, storage, signUrl };
}
