// Exact decimal amounts as BigInt units of 1e-12, so fees, minimums and steps compare without
// floating-point error. Only plain decimal strings and finite numbers are accepted.

const SCALE = 12;
const UNIT = 10n ** BigInt(SCALE);
const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** Parse a nonnegative decimal ("300", "0.3", 1.5) into units; null when not exact or invalid. */
export function parseDecimal(value) {
  let text = value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    text = String(value);
    if (/e/i.test(text)) return null;
  }
  if (typeof text !== 'string') return null;
  const match = DECIMAL.exec(text.trim());
  if (!match) return null;
  const [, whole, fraction = ''] = match;
  if (fraction.length > SCALE) return null;
  return BigInt(whole) * UNIT + BigInt(fraction.padEnd(SCALE, '0'));
}

/** Units back to the shortest exact decimal string. */
export function formatDecimal(units) {
  const sign = units < 0n ? '-' : '';
  const absolute = units < 0n ? -units : units;
  const whole = absolute / UNIT;
  const fraction = (absolute % UNIT).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** The step for `decimals` places (Bybit `minAccuracy`), in units; null when invalid. */
export function stepFromDecimals(decimals) {
  const places = Number(decimals);
  if (!Number.isInteger(places) || places < 0 || places > SCALE) return null;
  return 10n ** BigInt(SCALE - places);
}

export function isMultiple(units, step) {
  return step > 0n && units % step === 0n;
}

/** Significant digits of an amount as sent in JSON; MCP passes it as a number. */
export function jsonSafe(units) {
  const text = formatDecimal(units);
  return text.replace('.', '').replace(/^0+/, '').length <= 15 && Number(text) >= 0.000001;
}
