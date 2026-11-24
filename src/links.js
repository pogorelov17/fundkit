import QRCode from 'qrcode';

/**
 * OKX Wallet "App Universal Link": opens an HTTPS dApp page inside OKX Wallet's in-app browser
 * (Discover), where the wallet injects its EIP-1193 provider. Pattern from OKX Wallet docs:
 *   deepLink = "okx://wallet/dapp/url?dappUrl=" + encodeURIComponent(dappUrl)
 *   universal = "https://web3.okx.com/download?deeplink=" + encodeURIComponent(deepLink)
 * The signing URL we wrap only uses [a-z0-9/:.-] (hex intent id), avoiding the known
 * double-encoding problems with '%' and '+' inside dappUrl.
 */
export function okxDeepLink(dappUrl) {
  return 'okx://wallet/dapp/url?dappUrl=' + encodeURIComponent(dappUrl);
}

export function okxUniversalLink(dappUrl) {
  return 'https://web3.okx.com/download?deeplink=' + encodeURIComponent(okxDeepLink(dappUrl));
}

export function signingUrl(publicBaseUrl, intentId) {
  return `${publicBaseUrl.replace(/\/$/, '')}/s/${intentId}`;
}

export function assertHttps(publicBaseUrl, { allowInsecure = false } = {}) {
  const u = new URL(publicBaseUrl);
  if (u.protocol === 'https:') return;
  if (allowInsecure && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return;
  throw new Error(`PUBLIC_BASE_URL must be https:// (got ${u.protocol}); wallets will not sign from plain http`);
}

export function qrTerminal(text) {
  return QRCode.toString(text, { type: 'terminal', small: true, errorCorrectionLevel: 'M' });
}

export function qrSvg(text) {
  return QRCode.toString(text, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
}
