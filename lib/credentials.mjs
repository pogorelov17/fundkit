// Exchange API credentials entered by hand: which fields a venue needs, their labels, the
// environment names ccxt-mcp reads them from, and the checks a value must pass.
//
// A manual entry uses the same per-venue scheme as Doppler: <EXCHANGE>_APIKEY and
// <EXCHANGE>_SECRET, plus <EXCHANGE>_PASSWORD (the API passphrase) for OKX, Bitget and KuCoin.
// Nothing here ever accepts a wallet private key or a seed phrase.

import { dopplerNames, exchangeLabel, needsPassphrase, passphraseEnvName } from './exchanges.mjs';

export const FIELDS = Object.freeze({
  apiKey: { label: 'API key' },
  secret: { label: 'API secret' },
  passphrase: { label: 'API passphrase' },
});

/** The fields of one venue, in the order they are asked: API key, API secret, API passphrase. */
export function manualFields(exchange) {
  return needsPassphrase(exchange) ? ['apiKey', 'secret', 'passphrase'] : ['apiKey', 'secret'];
}

/** The ccxt-mcp environment name of one field. */
export function fieldEnvName(exchange, field) {
  const [apiKeyName, secretName] = dopplerNames(exchange);
  if (field === 'apiKey') return apiKeyName;
  if (field === 'secret') return secretName;
  return passphraseEnvName(exchange);
}

export function fieldLabel(exchange, field) {
  return `${exchangeLabel(exchange)} ${FIELDS[field].label}`;
}

const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 512;
const MAX_PASSPHRASE_LENGTH = 256;
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;
// One line of printable text: no control characters (C0 or DEL).
const hasControl = (text) =>
  [...text].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);
const PREFIXED_PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const MNEMONIC = /^[a-z]+(?: [a-z]+){11,23}$/;
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const EXTENDED_PRIVATE_KEY = /^[tuvxyz]prv[1-9A-HJ-NP-Za-km-z]{100,}$/;

/**
 * Why `value` cannot be this field, or null when it can. API keys and secrets are one visible
 * ASCII word; a passphrase may contain spaces. A seed phrase or a 0x-prefixed private key is
 * refused for every field, because an exchange API credential is never one.
 */
export function fieldProblem(field, value) {
  if (typeof value !== 'string' || value.length === 0) return 'the value is empty';
  const trimmed = value.trim();
  if (MNEMONIC.test(trimmed)) return 'this looks like a wallet seed phrase, which fundkit never takes';
  if (
    PEM_PRIVATE_KEY.test(value) ||
    EXTENDED_PRIVATE_KEY.test(trimmed) ||
    PREFIXED_PRIVATE_KEY.test(trimmed)
  ) {
    return 'this looks like a wallet private key, which fundkit never takes';
  }
  if (field === 'passphrase') {
    if (value.length > MAX_PASSPHRASE_LENGTH || hasControl(value)) {
      return 'an API passphrase is one line of at most 256 characters';
    }
    return null;
  }
  if (!VISIBLE_ASCII.test(value) || value.length < MIN_KEY_LENGTH || value.length > MAX_KEY_LENGTH) {
    return `an API ${field === 'apiKey' ? 'key' : 'secret'} is one word of 8 to 512 visible ASCII characters`;
  }
  return null;
}

/** A manual credential set id as the agent passed it (the session checks it), or undefined. */
export function credentialsArg(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : undefined;
}
