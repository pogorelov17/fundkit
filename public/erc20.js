// Shared by the Node tools and the browser signing page. No dependencies, no secrets.

export const BSC_CHAIN_ID = 56;
export const BSC_CHAIN_ID_HEX = '0x38';
// Canonical Binance-Peg BSC-USD ("USDT") token contract on BNB Smart Chain.
// It is cross-checked at runtime against Bybit's coin-info `contractAddress` and on-chain symbol()/decimals().
export const BSC_USDT = '0x55d398326f99059fF775485246999027B3197955';
export const BSC_USDT_DECIMALS = 18;

export const SELECTOR = {
  transfer: '0xa9059cbb', // transfer(address,uint256)
  balanceOf: '0x70a08231', // balanceOf(address)
  decimals: '0x313ce567', // decimals()
  symbol: '0x95d89b41', // symbol()
};
// keccak256("Transfer(address,address,uint256)")
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export function isAddress(a) {
  return typeof a === 'string' && ADDR_RE.test(a);
}

export function sameAddress(a, b) {
  return isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
}

function pad32(hexNo0x) {
  if (hexNo0x.length > 64) throw new Error('value exceeds 32 bytes');
  return hexNo0x.padStart(64, '0');
}

export function encodeAddressArg(addr) {
  if (!isAddress(addr)) throw new Error(`invalid address: ${addr}`);
  return pad32(addr.slice(2).toLowerCase());
}

export function encodeUintArg(value) {
  const v = BigInt(value);
  if (v < 0n) throw new Error('negative uint');
  return pad32(v.toString(16));
}

/** Calldata for ERC-20 transfer(to, amountBaseUnits). */
export function encodeTransfer(to, amountBase) {
  return SELECTOR.transfer + encodeAddressArg(to) + encodeUintArg(amountBase);
}

export function encodeBalanceOf(owner) {
  return SELECTOR.balanceOf + encodeAddressArg(owner);
}

/** Decode calldata of transfer(to, amount); returns null if it is not a transfer call. */
export function decodeTransfer(data) {
  if (typeof data !== 'string') return null;
  const d = data.toLowerCase();
  if (!d.startsWith(SELECTOR.transfer) || d.length !== 10 + 128) return null;
  const to = '0x' + d.slice(10 + 24, 10 + 64);
  const amount = BigInt('0x' + d.slice(10 + 64));
  return { to, amount };
}

export function topicToAddress(topic) {
  return '0x' + topic.toLowerCase().slice(-40);
}

/** Decimal string -> base units (BigInt). Rejects more fractional digits than `decimals`. */
export function toBaseUnits(amount, decimals) {
  const s = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid amount: ${amount}`);
  const [int, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error(`amount ${s} has more than ${decimals} decimals`);
  return BigInt(int) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/** Base units (BigInt|string) -> trimmed decimal string. */
export function fromBaseUnits(base, decimals) {
  const v = BigInt(base);
  const d = 10n ** BigInt(decimals);
  const int = v / d;
  const frac = (v % d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${int}.${frac}` : `${int}`;
}

export function fractionDigits(amount) {
  const s = String(amount);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}
