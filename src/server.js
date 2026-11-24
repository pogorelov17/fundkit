import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BSC_CHAIN_ID_HEX, encodeTransfer, isAddress } from '../public/erc20.js';
import { precheckSender } from './bsc.js';
import { SafeError } from './errors.js';
import { claimSigning, recordTx, releaseSigning, revalidateBeforeSigning, safeError } from './flow.js';
import { okxUniversalLink, parsePublicBase, qrSvg, signingUrl } from './links.js';
import { transition } from './state.js';

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

const sameToken = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

/**
 * Local helper server for exactly one intent attempt. Serves the signing page and owns the single
 * signing slot. Every state change goes through `session.update(fn)`, which is synchronous: the
 * check-and-set for claim / tx / release cannot interleave with another request in this process.
 *
 * session: { get(): state, update(fn): state, duplicate(hash) }
 * publicBase(): the validated PUBLIC_BASE_URL (may include a path prefix the proxy may or may not strip)
 */
export function createSigningServer({ session, bybit, rpcs, publicBase, log = () => {} }) {
  let active = null; // { token, from } — only in memory, never in chat state or logs
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local');
      let p = url.pathname;
      const { prefix } = parsePublicBase(publicBase(), { allowInsecure: true });
      if (prefix && (p === prefix || p.startsWith(prefix + '/'))) p = p.slice(prefix.length) || '/';
      if (req.method === 'GET' && STATIC[p]) return sendFile(res, p.slice(1), STATIC[p]);
      const m = p.match(/^\/(s|api\/intent)\/([0-9a-f]{32})(\/[a-z.]+)?$/);
      if (!m || m[2] !== session.get().intentId) return send(res, 404, { error: 'not found' });
      const sub = m[3] || '';

      if (req.method === 'GET' && m[1] === 's' && !sub) return sendFile(res, 'sign.html', 'text/html; charset=utf-8');
      if (m[1] !== 'api/intent') return send(res, 404, { error: 'not found' });
      if (req.method === 'GET' && sub === '') return send(res, 200, publicView(session.get(), publicBase()));
      if (req.method === 'GET' && sub === '/qr.svg') {
        const svg = await qrSvg(okxUniversalLink(signingUrl(publicBase(), session.get().intentId)));
        return send(res, 200, svg, 'image/svg+xml');
      }
      if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
      const body = await readJson(req);

      if (sub === '/precheck') {
        if (!isAddress(body.from)) return send(res, 400, { error: 'invalid address' });
        const s = session.get();
        return send(res, 200, await precheckSender(rpcs[0], { token: s.token, from: body.from, to: s.depositAddress, amountBase: s.amountBase }));
      }

      if (sub === '/claim') {
        // Atomic claim BEFORE any wallet prompt; binds the sender address.
        const token = crypto.randomBytes(24).toString('base64url');
        session.update((s) => claimSigning(s, body.from));
        active = { token, from: body.from.toLowerCase() };
        try {
          // Live re-check right before signing: same account, same deposit address, route still open.
          await revalidateBeforeSigning(bybit, session.get());
        } catch (err) {
          active = null;
          session.update((s) => transition(s, 'needs_attention', 'route_check_failed_before_signing', safeError(err)));
          return send(res, 409, { error: 'live route check failed; nothing to sign. Ask in the chat.' });
        }
        const s = session.get();
        if (s.phase !== 'signing_claimed' || s.claim?.from !== active.from) return send(res, 409, { error: 'signing slot changed' });
        return send(res, 200, {
          claimToken: token,
          tx: { from: active.from, to: s.token, value: '0x0', data: encodeTransfer(s.depositAddress, s.amountBase) },
          view: publicView(s, publicBase()),
        });
      }

      if (sub === '/tx') {
        if (!active || !sameToken(body.claimToken, active.token)) return send(res, 403, { error: 'no active signing claim for this browser' });
        try {
          session.update((s) => recordTx(s, { txHash: body.txHash }));
        } catch (err) {
          if (err.duplicate) session.duplicate(err.duplicate);
          throw err;
        }
        return send(res, 200, publicView(session.get(), publicBase()));
      }

      if (sub === '/release') {
        if (!active || !sameToken(body.claimToken, active.token)) return send(res, 403, { error: 'no active signing claim for this browser' });
        session.update((s) => releaseSigning(s));
        active = null;
        return send(res, 200, publicView(session.get(), publicBase()));
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof SafeError) return send(res, err.status || 400, { error: err.message });
      log(`server error: ${safeError(err)}`);
      return send(res, err.status === 413 ? 413 : 500, { error: 'internal error' });
    }
  });
  return server;
}

/** What the browser may know. No API keys, no balances, no history, no account id. */
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
    claimed: !!state.claim,
    txHash: state.txHash,
    mobileLink: okxUniversalLink(signingUrl(publicBaseUrl, state.intentId)),
  };
}

/** listen() that rejects on EADDRINUSE / EACCES instead of hanging. */
export function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(new SafeError(`cannot listen on ${host}:${port} (${err.code || 'error'})`));
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address());
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
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
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
