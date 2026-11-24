import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BSC_CHAIN_ID_HEX, isAddress } from '../public/erc20.js';
import { precheckSender } from './bsc.js';
import { recordTx } from './flow.js';
import { okxUniversalLink, qrSvg, signingUrl } from './links.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC = {
  '/sign.js': 'text/javascript',
  '/signflow.js': 'text/javascript',
  '/erc20.js': 'text/javascript',
  '/sign.css': 'text/css',
};
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
};

/**
 * Local helper server for exactly one intent. It serves the signing page and receives the tx hash.
 * It holds no secrets in responses: the page only ever sees public route data.
 * Put it behind an HTTPS tunnel/reverse proxy (PUBLIC_BASE_URL) for the phone to reach it.
 */
export function createSigningServer({ session, rpcs, publicBaseUrl, log = () => {} }) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local');
      const p = url.pathname;
      if (req.method === 'GET' && STATIC[p]) return sendFile(res, p.slice(1), STATIC[p]);
      const m = p.match(/^\/(s|api\/intent)\/([0-9a-f]{32})(\/[a-z.]+)?$/);
      const state = session.get();
      if (!m || m[2] !== state.intentId) return send(res, 404, { error: 'not found' });
      const sub = m[3] || '';

      if (req.method === 'GET' && m[1] === 's' && !sub) return sendFile(res, 'sign.html', 'text/html; charset=utf-8');
      if (req.method === 'GET' && sub === '') return send(res, 200, publicView(state, publicBaseUrl));
      if (req.method === 'GET' && sub === '/qr.svg') {
        const svg = await qrSvg(okxUniversalLink(signingUrl(publicBaseUrl, state.intentId)));
        return send(res, 200, svg, 'image/svg+xml');
      }
      if (req.method === 'POST' && sub === '/precheck') {
        const { from } = await readJson(req);
        if (!isAddress(from)) return send(res, 400, { error: 'invalid address' });
        const r = await precheckSender(rpcs[0], {
          token: state.token,
          from,
          to: state.depositAddress,
          amountBase: state.amountBase,
        });
        return send(res, 200, r);
      }
      if (req.method === 'POST' && sub === '/tx') {
        const body = await readJson(req);
        try {
          const next = recordTx(state, body);
          if (next !== state) session.set(next, 'tx');
          return send(res, 200, publicView(next, publicBaseUrl));
        } catch (err) {
          if (err.duplicate) session.duplicate(err.duplicate);
          return send(res, err.status || 400, { error: err.message });
        }
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      log(`server error: ${err.message}`);
      return send(res, 500, { error: 'internal error' });
    }
  });
  return server;
}

/** What the browser may know. No API keys, no balances, no history. */
export function publicView(state, publicBaseUrl) {
  return {
    intentId: state.intentId,
    chainId: state.chainId,
    chainIdHex: BSC_CHAIN_ID_HEX,
    token: state.token,
    symbol: 'USDT',
    decimals: state.decimals,
    to: state.depositAddress,
    amount: state.amount,
    amountBase: state.amountBase,
    phase: state.phase,
    attempt: state.attempt,
    txHash: state.txHash,
    mobileLink: okxUniversalLink(signingUrl(publicBaseUrl, state.intentId)),
  };
}

async function sendFile(res, name, type) {
  const body = await readFile(path.join(PUBLIC_DIR, name));
  res.writeHead(200, { 'content-type': type, ...SECURITY_HEADERS });
  res.end(body);
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, ...SECURITY_HEADERS });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readJson(req, limit = 4096) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}
