// Shared mock environment for acceptance tests and `npm run demo`.
import { RpcClient, assertRpcUrls } from '../src/bsc.js';
import { BybitClient, MOCK_ONLY } from '../src/bybit.js';
import { parseState, stateKeyFrom } from '../src/state.js';
import { MockChain, fakeWalletProvider, startRpcServer } from './mocks/bsc-chain.js';
import { MockBybit, TEST_KEY, TEST_SECRET, startBybitServer } from './mocks/bybit.js';
import { apiBaseFromPath, connect, makeApi, report, send, validateIntent } from '../public/signflow.js';

// Mock-only addresses; they belong to nobody.
export const WALLET = '0x' + 'a1'.repeat(20);

/** Build deps the way production does, but with mocks injected through code (MOCK_ONLY), never env. */
export function mockDeps(env, { secret = TEST_SECRET, stateEnv = {} } = {}) {
  const bybit = new BybitClient({ apiKey: TEST_KEY, apiSecret: secret, baseUrl: env.bybitUrl, mockOnly: MOCK_ONLY });
  return {
    cfg: env.cfg,
    bybit,
    rpcs: assertRpcUrls(env.cfg.rpcUrls, { mockOnly: MOCK_ONLY }).map((u) => new RpcClient(u)),
    stateKey: stateKeyFrom({ bybit, env: stateEnv }),
  };
}

export async function setup({ bybitOpts = {}, usdt = 100n * 10n ** 18n, bnb = 10n ** 16n, rpcViews = [{}, {}], prefix = '' } = {}) {
  const chain = new MockChain();
  chain.fund(WALLET, { usdt, bnb });
  const bybitMock = new MockBybit(chain, bybitOpts);
  const rpcSrvs = await Promise.all(rpcViews.map((v) => startRpcServer(chain, v)));
  const bybitSrv = await startBybitServer(bybitMock);
  const cfg = {
    rpcUrls: rpcSrvs.map((s) => s.url),
    // Port 0: the OS picks a free port; the public base follows the actual port (mock only).
    publicBaseUrl: (addr) => `http://127.0.0.1:${addr.port}${prefix}`,
    port: 0,
    host: '127.0.0.1',
    allowInsecure: true, // mock only; real runs require https PUBLIC_BASE_URL
    pollMs: 5,
    timeoutMs: 10_000,
  };
  const env = { chain, bybitMock, cfg, bybitUrl: bybitSrv.url, rpcViews };
  env.deps = mockDeps(env);
  const lines = [];
  let onLine = () => {};
  env.out = (l) => {
    lines.push(String(l));
    onLine(String(l));
  };
  env.lines = lines;
  env.waitFor = (re) =>
    new Promise((resolve) => {
      const hit = lines.find((l) => re.test(l));
      if (hit) return resolve(hit);
      const prev = onLine;
      onLine = (l) => {
        prev(l);
        if (re.test(l)) resolve(l);
      };
    });
  env.states = (key = env.deps.stateKey) => lines.filter((l) => l.startsWith('FUNDKIT_STATE ')).map((l) => parseState(l, key).state);
  env.stateLines = () => lines.filter((l) => l.startsWith('FUNDKIT_STATE '));
  env.lineFor = (phase) => env.stateLines().find((l) => parseState(l, env.deps.stateKey).state.phase === phase);
  env.close = async () => {
    await Promise.all(rpcSrvs.map((s) => s.close()));
    await bybitSrv.close();
  };
  return env;
}

/** Opens the page's API like the signing page would (from the signing URL path). */
export async function openPage(env) {
  const line = await env.waitFor(/^Signing page: /);
  const signUrl = line.replace(/^Signing page: /, '');
  const u = new URL(signUrl);
  const api = makeApi(u.origin + apiBaseFromPath(u.pathname).api);
  return { signUrl, api };
}

/** Plays the phone: opens the signing URL's API, connects the fake OKX provider, claims, sends, reports. */
export async function phone(env, { storage = new Map(), provider } = {}) {
  const { signUrl, api } = await openPage(env);
  const store = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
  const intent = validateIntent(await api.getIntent());
  const wallet = provider || fakeWalletProvider(env.chain, WALLET);
  const from = await connect(wallet, intent);
  const pre = await api.precheck(from);
  if (!pre.enoughToken || !pre.enoughGas) return { intent, pre, sent: null, api, signUrl };
  const { txHash, claimToken, reused } = await send(wallet, intent, from, store, api);
  // Like the page: a hash the server already knows is not re-reported.
  const reported = claimToken ? await report(api, txHash, claimToken, { sleep: async () => {} }) : null;
  return { intent, pre, txHash, claimToken, reused, reported, api, from, wallet, storage, signUrl };
}
