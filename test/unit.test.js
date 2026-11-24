import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BSC_USDT, decodeTransfer, encodeTransfer, fromBaseUnits, toBaseUnits } from '../public/erc20.js';
import { deterministicUuid } from '../src/bybit.js';
import { okxDeepLink, okxUniversalLink } from '../src/links.js';
import { recordTx } from '../src/flow.js';
import { formatState, parseState } from '../src/state.js';

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
  assert.equal(BSC_USDT.length, 42);
});

test('OKX universal link wraps the encoded deeplink', () => {
  const url = 'https://helper.example/s/' + 'a'.repeat(32);
  assert.equal(okxDeepLink(url), 'okx://wallet/dapp/url?dappUrl=https%3A%2F%2Fhelper.example%2Fs%2F' + 'a'.repeat(32));
  const u = new URL(okxUniversalLink(url));
  assert.equal(u.origin, 'https://web3.okx.com');
  assert.equal(u.searchParams.get('deeplink'), okxDeepLink(url));
});

test('deterministic transferId is a stable UUID', () => {
  const a = deterministicUuid('x');
  assert.equal(a, deterministicUuid('x'));
  assert.notEqual(a, deterministicUuid('y'));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('state line round trip and one-hash-per-attempt rule', () => {
  const s = { v: 1, kind: 'okx-bsc-usdt-to-bybit', intentId: 'i', phase: 'link_issued', txHash: null, history: [] };
  const line = 'some chat text\n' + formatState(s);
  assert.deepEqual(parseState(line), s);
  const h = '0x' + 'ab'.repeat(32);
  const s2 = recordTx(s, { txHash: h });
  assert.equal(s2.phase, 'tx_submitted');
  assert.equal(recordTx(s2, { txHash: h.toUpperCase().replace('0X', '0x') }), s2, 'same hash is idempotent');
  assert.throws(() => recordTx(s2, { txHash: '0x' + 'cd'.repeat(32) }), /refusing second hash/);
  assert.throws(() => recordTx(s, { txHash: '0x12' }), /invalid tx hash/);
});
