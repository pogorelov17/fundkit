import QRCode from 'qrcode';
import { SafeError } from './errors.js';

/**
 * OKX Wallet "App Universal Link": opens an HTTPS dApp page inside OKX Wallet's in-app browser
 * (Discover), where the wallet injects its EIP-1193 provider. Pattern from OKX Wallet docs:
 *   deepLink = "okx://wallet/dapp/url?dappUrl=" + encodeURIComponent(dappUrl)
 *   universal = "https://web3.okx.com/download?deeplink=" + encodeURIComponent(deepLink)
 * The signing URL we wrap only uses [A-Za-z0-9/:._-] (validated base + hex intent id), avoiding the
 * known double-encoding problems with '%' and '+' inside dappUrl.
 */
export function okxDeepLink(dappUrl) {
  return 'okx://wallet/dapp/url?dappUrl=' + encodeURIComponent(dappUrl);
}

export function okxUniversalLink(dappUrl) {
  return 'https://web3.okx.com/download?deeplink=' + encodeURIComponent(okxDeepLink(dappUrl));
}

/**
 * Validate and normalise PUBLIC_BASE_URL. Accepts an optional path prefix (e.g. a reverse proxy at
 * https://host/fundkit). Rejects credentials, query, fragment, '..' and characters that need escaping.
 * Returns { origin, prefix, base } with no trailing slash.
 */
export function parsePublicBase(publicBaseUrl, { allowInsecure = false } = {}) {
  let u;
  try {
    u = new URL(publicBaseUrl);
  } catch {
    throw new SafeError('PUBLIC_BASE_URL is not a valid URL');
  }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(allowInsecure && local && u.protocol === 'http:')) {
    throw new SafeError(`PUBLIC_BASE_URL must be https:// (got ${u.protocol}); wallets will not sign from plain http`);
  }
  if (u.username || u.password) throw new SafeError('PUBLIC_BASE_URL must not contain credentials');
  if (u.search || u.hash || /[?#]/.test(publicBaseUrl)) throw new SafeError('PUBLIC_BASE_URL must not have a query or fragment');
  const prefix = u.pathname.replace(/\/+$/, '');
  if (prefix && !/^(\/[A-Za-z0-9._-]+)+$/.test(prefix)) throw new SafeError('PUBLIC_BASE_URL path may only use [A-Za-z0-9._-] segments');
  if (prefix.split('/').some((seg) => seg === '.' || seg === '..')) throw new SafeError('PUBLIC_BASE_URL path must not contain . or ..');
  return { origin: u.origin, prefix, base: u.origin + prefix };
}

export function assertHttps(publicBaseUrl, opts) {
  parsePublicBase(publicBaseUrl, opts);
}

export function signingUrl(publicBaseUrl, intentId) {
  return `${parsePublicBase(publicBaseUrl, { allowInsecure: true }).base}/s/${intentId}`;
}

export function qrTerminal(text) {
  return QRCode.toString(text, { type: 'terminal', small: true, errorCorrectionLevel: 'M' });
}

export function qrSvg(text) {
  return QRCode.toString(text, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
}
