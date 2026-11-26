// USDT chains fundkit supports, with each venue's own id (SKILL.md, Chains).

export const NETWORKS = Object.freeze({
  TRC20: {
    code: 'TRC20',
    label: 'Tron (TRC20)',
    chainId: null,
    contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    evm: false,
    ids: { binance: 'TRX', bybit: 'TRX' },
    synonyms: ['TRC20', 'TRC-20', 'TRON', 'TRX'],
  },
  BEP20: {
    code: 'BEP20',
    label: 'BNB Smart Chain (BEP20)',
    chainId: 56,
    contract: '0x55d398326f99059fF775485246999027B3197955',
    evm: true,
    ids: { binance: 'BSC', bybit: 'BSC' },
    synonyms: ['BEP20', 'BEP-20', 'BSC', 'BNB SMART CHAIN', 'BNB CHAIN', 'BNBSMARTCHAIN'],
  },
  ERC20: {
    code: 'ERC20',
    label: 'Ethereum (ERC20)',
    chainId: 1,
    contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    evm: true,
    ids: { binance: 'ETH', bybit: 'ETH' },
    synonyms: ['ERC20', 'ERC-20', 'ETH', 'ETHEREUM'],
  },
  TON: {
    code: 'TON',
    label: 'TON',
    chainId: null,
    contract: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs',
    evm: false,
    ids: { binance: 'TON', bybit: 'TON' },
    synonyms: ['TON', 'THE OPEN NETWORK'],
  },
});

/** The canonical code for a user's network name ("BSC", "bep20", "BNB Smart Chain"), or null. */
export function normalizeNetwork(name) {
  const key = String(name ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
  return Object.values(NETWORKS).find((network) => network.synonyms.includes(key))?.code ?? null;
}

/** Whether a venue's contract string names the reference contract (EVM: any letter case). */
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
