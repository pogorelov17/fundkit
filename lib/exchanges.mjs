// Supported venues, local roles and the credential names derived from them.
//
// One Doppler config holds one account per exchange, under exactly two names:
// <EXCHANGE>_APIKEY and <EXCHANGE>_SECRET. Every local role on that exchange uses that one key.
// OKX, Bitget and KuCoin also need an API passphrase; it is never read from Doppler but typed
// by the operator in a private terminal (lib/session/passphrases.mjs).

/** ccxt ids, display names and whether ccxt-mcp needs `<EXCHANGE>_PASSWORD` for the venue. */
export const EXCHANGES = Object.freeze({
  binance: { label: 'Binance', passphrase: false },
  bybit: { label: 'Bybit', passphrase: false },
  gate: { label: 'Gate', passphrase: false },
  okx: { label: 'OKX', passphrase: true },
  bitget: { label: 'Bitget', passphrase: true },
  whitebit: { label: 'WhiteBIT', passphrase: false },
  bingx: { label: 'BingX', passphrase: false },
  mexc: { label: 'MEXC', passphrase: false },
  kucoin: { label: 'KuCoin', passphrase: true },
});

export const PASSPHRASE_EXCHANGES = Object.freeze(
  Object.keys(EXCHANGES).filter((exchange) => EXCHANGES[exchange].passphrase),
);

const EXCHANGE_SYNONYMS = Object.freeze({
  'gate.io': 'gate',
  gateio: 'gate',
  'kucoin.com': 'kucoin',
  'binance.com': 'binance',
});

/**
 * Local runtime roles. A role is what fundkit forwards on a profile, not what the exchange key
 * can do: the same key serves every role of its exchange (references/security.md, scheme D).
 */
export const ROLES = Object.freeze({
  'deposit-only': { aliasSuffix: 'dst' },
  source: { aliasSuffix: 'src' },
  settlement: { aliasSuffix: 'settle' },
});

export const ROLE_NAMES = Object.freeze(Object.keys(ROLES));

/** The ccxt id for a user-supplied exchange name ("OKX", "Gate.io"), or null. */
export function normalizeExchange(name) {
  const key = String(name ?? '')
    .trim()
    .toLowerCase();
  if (Object.hasOwn(EXCHANGES, key)) return key;
  return EXCHANGE_SYNONYMS[key] ?? null;
}

export function isRole(role) {
  return Object.hasOwn(ROLES, role);
}

export function needsPassphrase(exchange) {
  return EXCHANGES[exchange].passphrase;
}

export function exchangeLabel(exchange) {
  return EXCHANGES[exchange].label;
}

export function aliasFor(exchange, role) {
  return `${exchange}-${ROLES[role].aliasSuffix}`;
}

/** The two Doppler names of an exchange; ccxt-mcp reads the same names from its environment. */
export function dopplerNames(exchange) {
  const prefix = exchange.toUpperCase();
  return [`${prefix}_APIKEY`, `${prefix}_SECRET`];
}

/** The variable ccxt-mcp reads the API passphrase from, or null for venues without one. */
export function passphraseEnvName(exchange) {
  return needsPassphrase(exchange) ? `${exchange.toUpperCase()}_PASSWORD` : null;
}
