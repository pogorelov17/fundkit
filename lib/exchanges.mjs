// Supported venues, local roles and the credential names derived from them.

/** ccxt ids and the credential fields ccxt-mcp needs (references/security.md, venue profiles). */
export const EXCHANGES = Object.freeze({
  binance: { fields: ['APIKEY', 'SECRET'] },
  bybit: { fields: ['APIKEY', 'SECRET'] },
  gate: { fields: ['APIKEY', 'SECRET'] },
  okx: { fields: ['APIKEY', 'SECRET', 'PASSWORD'] },
  bitget: { fields: ['APIKEY', 'SECRET', 'PASSWORD'] },
  whitebit: { fields: ['APIKEY', 'SECRET'] },
  bingx: { fields: ['APIKEY', 'SECRET'] },
  mexc: { fields: ['APIKEY', 'SECRET'] },
  kucoin: { fields: ['APIKEY', 'SECRET', 'PASSWORD'] },
});

const EXCHANGE_SYNONYMS = Object.freeze({
  'gate.io': 'gate',
  gateio: 'gate',
  'kucoin.com': 'kucoin',
  'binance.com': 'binance',
});

/** Local runtime roles of a session profile. */
export const ROLES = Object.freeze({
  'deposit-only': { tag: 'DEPOSIT', aliasSuffix: 'dst' },
  source: { tag: 'SOURCE', aliasSuffix: 'src' },
  settlement: { tag: 'SETTLEMENT', aliasSuffix: 'settle' },
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

export function aliasFor(exchange, role) {
  return `${exchange}-${ROLES[role].aliasSuffix}`;
}

/** Each credential as {doppler: name in the Doppler config, env: variable ccxt-mcp reads}. */
export function credentialNames(exchange, role) {
  const prefix = exchange.toUpperCase();
  return EXCHANGES[exchange].fields.map((field) => ({
    doppler: `${prefix}_${ROLES[role].tag}_${field}`,
    env: `${prefix}_${field}`,
  }));
}
