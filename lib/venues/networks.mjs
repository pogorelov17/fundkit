// Chains and tokens fundkit supports, with each venue's own chain id (SKILL.md, Chains).
//
// A chain alone carries no token: `tokenOn(coin, code)` gives the chain with that coin's reference
// contract, or null when fundkit does not support the coin on that chain. Every read, contract
// check, fee, balance, QR and withdrawal works on that token object, so a USDC request never
// borrows a USDT contract or id.

const CHAINS = Object.freeze({
  TRC20: {
    code: 'TRC20',
    label: 'Tron (TRC20)',
    chainId: null,
    evm: false,
    ids: { binance: 'TRX', bybit: 'TRX' },
    synonyms: ['TRC20', 'TRC-20', 'TRON', 'TRX'],
  },
  BEP20: {
    code: 'BEP20',
    label: 'BNB Smart Chain (BEP20)',
    chainId: 56,
    evm: true,
    ids: { binance: 'BSC', bybit: 'BSC' },
    synonyms: ['BEP20', 'BEP-20', 'BSC', 'BNB SMART CHAIN', 'BNB CHAIN', 'BNBSMARTCHAIN'],
  },
  ERC20: {
    code: 'ERC20',
    label: 'Ethereum (ERC20)',
    chainId: 1,
    evm: true,
    ids: { binance: 'ETH', bybit: 'ETH' },
    synonyms: ['ERC20', 'ERC-20', 'ETH', 'ETHEREUM'],
  },
  TON: {
    code: 'TON',
    label: 'TON',
    chainId: null,
    evm: false,
    ids: { binance: 'TON', bybit: 'TON' },
    synonyms: ['TON', 'THE OPEN NETWORK'],
  },
});

/**
 * Reference token contracts by coin and chain. USDT on the four chains; USDC only where one
 * contract is the token the supported venues list for that chain: Circle's native USDC on
 * Ethereum, and Binance-Peg USD Coin on BNB Smart Chain (listed by Binance and Bybit as USDC
 * BSC). USDC on Tron or TON is not supported (no variant is substituted).
 */
export const TOKENS = Object.freeze({
  USDT: Object.freeze({
    TRC20: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    BEP20: '0x55d398326f99059fF775485246999027B3197955',
    ERC20: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    TON: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs',
  }),
  USDC: Object.freeze({
    BEP20: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    ERC20: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  }),
});

export const COINS = Object.freeze(Object.keys(TOKENS));

/** The chains fundkit knows, without any token (labels, chain ids, venue ids, synonyms). */
export const NETWORKS = CHAINS;

/** The canonical coin for a user's coin name ("usdc"), or null. */
export function normalizeCoin(name) {
  const key = String(name ?? '')
    .trim()
    .toUpperCase();
  return COINS.includes(key) ? key : null;
}

/** The chain codes fundkit supports for a coin, in chain order. */
export function networksFor(coin) {
  const contracts = TOKENS[coin];
  return contracts ? Object.keys(CHAINS).filter((code) => Object.hasOwn(contracts, code)) : [];
}

/** The chain with the coin's reference contract (`coin`, `contract` added), or null. */
export function tokenOn(coin, code) {
  const contract = TOKENS[coin]?.[code];
  const chain = CHAINS[code];
  if (!contract || !chain) return null;
  return Object.freeze({ ...chain, coin, contract });
}

/** Whether a string is any reference token contract on that chain (never a deposit address). */
export function isTokenContract(code, value) {
  return COINS.some((coin) => {
    const token = tokenOn(coin, code);
    return token !== null && sameContract(token, value);
  });
}

/** The canonical code for a user's network name ("BSC", "bep20", "BNB Smart Chain"), or null. */
export function normalizeNetwork(name) {
  const key = String(name ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
  return Object.values(NETWORKS).find((network) => network.synonyms.includes(key))?.code ?? null;
}

/** Whether a venue's contract string names the token's reference contract (EVM: any letter case). */
export function sameContract(network, value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const reference = network.contract;
  return network.evm ? value.toLowerCase() === reference.toLowerCase() : value === reference;
}

/** Whether a contract suffix (Bybit shows the last 6 characters) ends the reference contract. */
export function contractSuffixMatches(network, suffix) {
  if (typeof suffix !== 'string' || suffix.length < 6) return false;
  const reference = network.evm ? network.contract.toLowerCase() : network.contract;
  const tail = network.evm ? suffix.toLowerCase() : suffix;
  return reference.endsWith(tail);
}

/** A plausible address format for the chain; never a substitute for reading the address. */
export function addressShapeOk(network, address) {
  if (typeof address !== 'string' || address !== address.trim() || address.length === 0) return false;
  if (network.evm) return /^0x[0-9a-fA-F]{40}$/.test(address);
  if (network.code === 'TRC20') return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
  if (network.code === 'TON') {
    return /^[A-Za-z0-9_-]{48}$/.test(address) || /^-?\d:[0-9a-fA-F]{64}$/.test(address);
  }
  return false;
}
