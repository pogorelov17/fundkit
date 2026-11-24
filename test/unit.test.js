import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { BSC_USDT, decodeTransfer, encodeTransfer, fromBaseUnits, toBaseUnits } from '../public/erc20.js';
import { apiBaseFromPath, send, storageKey } from '../public/signflow.js';
import { assertRpcUrls } from '../src/bsc.js';
import { BybitClient, MOCK_ONLY, classifyDeposit, deterministicUuid, normalizeTxId } from '../src/bybit.js';
import { makeDeps } from '../src/app.js';
import { claimSigning, recordTx, releaseSigning } from '../src/flow.js';
import { okxDeepLink, okxUniversalLink, parsePublicBase, signingUrl } from '../src/links.js';
import { formatState, parseState, safeDetail, validateState } from '../src/state.js';

const KEY = crypto.randomBytes(32);
const sample = () => ({
  v: 2,
  kind: 'okx-bsc-usdt-to-bybit',
  intentId: 'ab'.repeat(16),
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  uid: '1001',
  amount: '25.5',
  amountBase: '25500000000000000000',
  decimals: 18,
  token: BSC_USDT,
  chain: 'BSC',
  chainId: 56,
  depositAddress: '0x' + 'b0'.repeat(20),
  minAccuracy: '8',
  target: 'UNIFIED',
  fundCreditConfirmed: true,
  phase: 'link_issued',
  attempt: 1,
  claim: null,
  txHash: null,
  from: null,
  failedTx: [],
  replacedTx: [],
  deposit: null,
  transfer: null,
  history: [],
});

test('decimal <-> base units with 18 decimals, no floats', () => {
  assert.equal(toBaseUnits('25.5', 18), 25_500_000_000_000_000_000n);
  assert.equal(toBaseUnits('0.000000000000000001', 18), 1n);
  assert.equal(fromBaseUnits(25_500_000_000_000_000_000n, 18), '25.5');
  assert.throws(() => toBaseUnits('1.0000000000000000001', 18), /decimals/);
  assert.throws(() => toBaseUnits('1e3', 18), /invalid/);
  assert.throws(() => toBaseUnits('-1', 18), /invalid/);
});

test('ERC-20 transfer calldata round trip', () => {
  const to = '0x' + 'b0'.repeat(20);
  const data = encodeTransfer(to, 123n);
  assert.equal(data.length, 138);
  assert.ok(data.startsWith('0xa9059cbb'));
  assert.deepEqual(decodeTransfer(data), { to, amount: 123n });
});

test('OKX universal link wraps the encoded deeplink; signing URL keeps a path prefix', () => {
  const url = 'https://helper.example/s/' + 'a'.repeat(32);
  assert.equal(okxDeepLink(url), 'okx://wallet/dapp/url?dappUrl=https%3A%2F%2Fhelper.example%2Fs%2F' + 'a'.repeat(32));
  const u = new URL(okxUniversalLink(url));
  assert.equal(u.origin, 'https://web3.okx.com');
  assert.equal(u.searchParams.get('deeplink'), okxDeepLink(url));
  assert.equal(signingUrl('https://h.example/fk/', 'a'.repeat(32)), 'https://h.example/fk/s/' + 'a'.repeat(32));
  assert.deepEqual(apiBaseFromPath('/fk/s/' + 'a'.repeat(32)), { intentId: 'a'.repeat(32), api: '/fk/api/intent/' + 'a'.repeat(32) });
});

test('PUBLIC_BASE_URL validation', () => {
  assert.equal(parsePublicBase('https://h.example/a/b/').prefix, '/a/b');
  for (const bad of ['http://example.com', 'https://u:p@h.example', 'https://h.example/a?x=1', 'https://h.example/#f', 'https://h.example/a%20b', 'nope']) {
    assert.throws(() => parsePublicBase(bad), /PUBLIC_BASE_URL/, bad);
  }
  assert.equal(parsePublicBase('http://127.0.0.1:9', { allowInsecure: true }).base, 'http://127.0.0.1:9');
});

test('Bybit base URL allowlist; mocks only via code-level MOCK_ONLY injection', () => {
  const mk = (baseUrl, extra = {}) => new BybitClient({ apiKey: 'k', apiSecret: 's', baseUrl, ...extra });
  assert.equal(mk('https://api.bybit.com/').baseUrl, 'https://api.bybit.com');
  assert.equal(mk('https://api.bytick.com').baseUrl, 'https://api.bytick.com');
  for (const bad of ['http://api.bybit.com', 'https://evil.example', 'https://api.bybit.com.evil.example', 'https://api.bybit.com:8443', 'https://api-testnet.bybit.com', 'http://127.0.0.1:1']) {
    assert.throws(() => mk(bad), /BYBIT_BASE_URL/, bad);
  }
  assert.equal(mk('http://127.0.0.1:1', { mockOnly: MOCK_ONLY }).baseUrl, 'http://127.0.0.1:1');
  assert.throws(() => mk('http://127.0.0.1:1', { mockOnly: 'MOCK_ONLY' }), /BYBIT_BASE_URL/);
  assert.throws(() => makeDeps({ BYBIT_API_KEY: 'k', BYBIT_API_SECRET: 's', BYBIT_BASE_URL: 'http://127.0.0.1:1' }), /BYBIT_BASE_URL/);
  assert.ok(!JSON.stringify(mk('https://api.bybit.com')).includes('"s"'));
});

test('BSC RPC config: >= 2 independent https endpoints', () => {
  assert.throws(() => assertRpcUrls(['https://a.example']), /at least two/);
  assert.throws(() => assertRpcUrls(['https://a.example', 'http://b.example']), /https/);
  assert.throws(() => assertRpcUrls(['https://a.example/x', 'https://a.example/y']), /independent/);
  assert.throws(() => assertRpcUrls(['https://u:p@a.example', 'https://b.example']), /credentials/);
  assert.doesNotThrow(() => assertRpcUrls(['https://a.example', 'https://b.example']));
});

test('deterministic transferId is a stable UUID', () => {
  const a = deterministicUuid('x');
  assert.equal(a, deterministicUuid('x'));
  assert.notEqual(a, deterministicUuid('y'));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('deposit classification and txID normalisation', () => {
  const k = (status, extra = {}) => classifyDeposit({ status, depositType: '0', ...extra }).kind;
  assert.equal(k(3), 'credited');
  assert.equal(k(70012), 'credited');
  for (const s of [0, 1, 2, 10011]) assert.equal(k(s), 'pending', String(s));
  for (const s of [7, 70013, 10012, 99999]) assert.equal(k(s), 'held', String(s));
  for (const s of [4, 70011]) assert.equal(k(s), 'failed', String(s));
  assert.equal(k(3, { depositType: '20' }), 'held');
  assert.equal(k(3, { travelRuleStatus: '2' }), 'held');
  assert.equal(k(3, { travelRuleStatus: '0' }), 'credited');
  const h = 'Ab'.repeat(32);
  assert.equal(normalizeTxId('0x' + h), h.toLowerCase());
  assert.equal(normalizeTxId(h), h.toLowerCase());
  assert.equal(normalizeTxId('0x12'), null);
});

test('state transport: shell-safe, authenticated, schema-checked, last line wins', () => {
  const s = sample();
  const line = formatState(s, KEY);
  assert.match(line, /^FUNDKIT_STATE 2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const older = formatState({ ...s, attempt: 1 }, KEY);
  const parsed = parseState(`chat text\n${older}\nmore\n${line}`, KEY);
  assert.equal(parsed.authentic, true);
  assert.deepEqual(parsed.state, s);
  assert.equal(parseState(line, crypto.randomBytes(32)).authentic, false, 'other key');
  assert.equal(parseState(line).authentic, false, 'no key');
  assert.throws(() => validateState({ ...s, token: '0x' + '11'.repeat(20) }), /route/);
  assert.throws(() => validateState({ ...s, amountBase: '1' }), /amountBase/);
  assert.throws(() => validateState({ ...s, apiSecret: 'x' }), /unexpected field/);
  assert.throws(() => validateState({ ...s, phase: 'whatever' }), /phase/);
  assert.throws(() => parseState('FUNDKIT_STATE {"v":1}', KEY), /no FUNDKIT_STATE 2/);
  assert.equal(safeDetail('ok <b>\n"x"'), 'ok <b>??x?');
});

test('signing slot: claim binds sender, one hash per attempt, release only from claimed', () => {
  const s = sample();
  const from = '0x' + 'a1'.repeat(20);
  const c = claimSigning(s, from);
  assert.equal(c.phase, 'signing_claimed');
  assert.throws(() => claimSigning(c, from), /already claimed/);
  assert.equal(releaseSigning(c).phase, 'link_issued');
  const h = '0x' + 'ab'.repeat(32);
  const t = recordTx(c, { txHash: h });
  assert.equal(t.from, from);
  assert.equal(recordTx(t, { txHash: h.toUpperCase().replace('0X', '0x') }), t, 'same hash is idempotent');
  assert.throws(() => recordTx(t, { txHash: '0x' + 'cd'.repeat(32) }), /refusing second hash/);
  assert.throws(() => releaseSigning(t), /nothing to release/);
  assert.throws(() => recordTx(s, { txHash: '0x12' }), /invalid tx hash/);
});

test('page: a hash this browser already sent for the attempt is re-reported, never re-sent or re-claimed', async () => {
  const intent = { intentId: 'ab'.repeat(16), attempt: 1, chainId: 56, txHash: null };
  const h = '0x' + '12'.repeat(32);
  const storage = new Map([[storageKey(intent), JSON.stringify({ txHash: h, claimToken: 't' })]]);
  const store = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
  const boom = () => {
    throw new Error('must not be called');
  };
  const r = await send({ request: boom }, intent, '0x' + 'a1'.repeat(20), store, { claim: boom });
  assert.deepEqual(r, { txHash: h, claimToken: 't', reused: true });
});
