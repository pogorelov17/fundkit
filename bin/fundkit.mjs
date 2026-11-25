#!/usr/bin/env node
// fundkit: optional, session-only Doppler profiles for the pinned ccxt-mcp server.
//
//   fundkit install            one-time per machine: pinned ccxt-mcp, skill links, host registration
//   fundkit session [-- CMD]   private terminal step: hidden token prompt, holds the session
//   fundkit mcp                MCP server the host launches (registered by `install`)
//   fundkit status | stop      session state (no values) | end the session
//
// Node >= 20, standard library only. The Doppler service token is read only from the
// controlling terminal with echo off. It never goes into argv, the environment of any other
// process, a file, a log or an MCP message. Exchange credentials are fetched by fixed names
// derived from (exchange, role), passed only to the one ccxt-mcp child that needs them through
// its environment, and redacted from everything that child prints.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import tty from 'node:tty';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '0.1.0';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOPPLER_API = 'https://api.doppler.com';
const TOKEN_RE = /^dp\.st\.(?:[a-z0-9\-_]{2,35}\.)?[a-zA-Z0-9]{40,44}$/;
const PINS = { 'ccxt-mcp': '0.1.3', ccxt: '4.5.85', '@modelcontextprotocol/sdk': '1.32.2', zod: '3.25.76' };

// ccxt ids and the credential fields ccxt-mcp needs for each (security.md, venue profiles).
export const EXCHANGES = {
  binance: ['APIKEY', 'SECRET'],
  bybit: ['APIKEY', 'SECRET'],
  gate: ['APIKEY', 'SECRET'],
  okx: ['APIKEY', 'SECRET', 'PASSWORD'],
  bitget: ['APIKEY', 'SECRET', 'PASSWORD'],
  whitebit: ['APIKEY', 'SECRET'],
  bingx: ['APIKEY', 'SECRET'],
  mexc: ['APIKEY', 'SECRET'],
  kucoin: ['APIKEY', 'SECRET', 'PASSWORD'],
};
const SYNONYMS = { 'gate.io': 'gate', gateio: 'gate', 'kucoin.com': 'kucoin', 'binance.com': 'binance' };
export const ROLES = {
  'deposit-only': { tag: 'DEPOSIT', suffix: 'dst' },
  source: { tag: 'SOURCE', suffix: 'src' },
  settlement: { tag: 'SETTLEMENT', suffix: 'settle' },
};
// Only these tools may be forwarded. get_deposit_address is never forwarded (SKILL.md rule 2).
const WRITE_TOOLS = new Set(['withdraw', 'transfer']);
const NEVER_TOOLS = new Set(['get_deposit_address', 'call_implicit_write', 'call_write_method', 'create_order',
  'edit_order', 'cancel_order', 'cancel_all_orders', 'set_leverage', 'set_margin_mode']);
const PASS_ENV = ['PATH', 'HOME', 'XDG_CACHE_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy',
  'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'TZ', 'LANG'];

export function normExchange(x) {
  const k = String(x ?? '').trim().toLowerCase();
  return EXCHANGES[k] ? k : (SYNONYMS[k] ?? null);
}
export function secretNames(exchange, role) {
  const ex = exchange.toUpperCase();
  return EXCHANGES[exchange].map((field) => ({ doppler: `${ex}_${ROLES[role].tag}_${field}`, env: `${ex}_${field}` }));
}
export function aliasFor(exchange, role) { return `${exchange}-${ROLES[role].suffix}`; }

function home() { return process.env.HOME || os.homedir(); }
function runDir() { return process.env.FUNDKIT_RUN_DIR || path.join(home(), '.local', 'state', 'fundkit', 'run'); }
function sockPath() { return path.join(runDir(), 'session.sock'); }
function confDir() { return process.env.FUNDKIT_CONFIG_DIR || path.join(home(), '.config', 'fundkit'); }
function installInfo() {
  try { return JSON.parse(fs.readFileSync(path.join(confDir(), 'install.json'), 'utf8')); } catch { return {}; }
}
function ccxtServerPath() {
  if (process.env.FUNDKIT_CCXT_MCP) return process.env.FUNDKIT_CCXT_MCP;
  const app = installInfo().appDir;
  return app ? path.join(app, 'node_modules', 'ccxt-mcp', 'js', 'server.js') : null;
}
function apiBase() {
  const b = process.env.FUNDKIT_DOPPLER_API;
  if (!b) return DOPPLER_API;
  // Test hook: only a loopback mock may replace the official endpoint.
  if (/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(b)) return b;
  throw new Error('FUNDKIT_DOPPLER_API may only point to a loopback test server');
}
function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}
function nowIso() { return new Date().toISOString().replace(/\.\d+Z$/, 'Z'); }
function parseDuration(s) {
  const m = /^(\d+)(s|m|h)?$/.exec(String(s));
  if (!m) throw new Error(`bad duration: ${s}`);
  return Number(m[1]) * ({ s: 1, m: 60, h: 3600 }[m[2] ?? 's']) * 1000;
}

// ---------------------------------------------------------------- hidden terminal input

export function readHiddenFromTty(prompt, timeoutMs = 300000) {
  let fd;
  try { fd = fs.openSync('/dev/tty', 'r+'); } catch {
    return Promise.reject(Object.assign(new Error('no controlling terminal'), { code: 'NO_TTY' }));
  }
  const input = new tty.ReadStream(fd);
  const out = new tty.WriteStream(fd);
  input.setRawMode(true); // echo off before the prompt appears, so typed-ahead input is never shown
  out.write(prompt);
  input.resume();
  return new Promise((resolve, reject) => {
    let buf = [];
    let esc = 0; // 0 none, 1 after ESC, 2 inside CSI
    const finish = (err, val) => {
      clearTimeout(timer);
      try { input.setRawMode(false); } catch {}
      out.write('\n');
      input.removeAllListeners('data');
      input.destroy();
      try { fs.closeSync(fd); } catch {}
      buf.fill(0); buf = [];
      if (err) reject(err); else resolve(val);
    };
    const timer = setTimeout(() => finish(Object.assign(new Error('timed out'), { code: 'TIMEOUT' })), timeoutMs);
    input.on('data', (chunk) => {
      for (const b of chunk) {
        if (esc === 1) { esc = b === 0x5b ? 2 : 0; continue; }
        if (esc === 2) { if (b >= 0x40 && b <= 0x7e) esc = 0; continue; }
        if (b === 0x1b) { esc = 1; continue; }
        if (b === 3 || (b === 4 && buf.length === 0)) return finish(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
        if (b === 13 || b === 10) { const v = Buffer.from(buf).toString('utf8'); return finish(null, v); }
        if (b === 127 || b === 8) { buf.pop(); continue; }
        if (b === 21) { buf.fill(0); buf = []; continue; }
        if (b >= 0x21 && b <= 0x7e) buf.push(b);
      }
      chunk.fill(0);
    });
  });
}

// ---------------------------------------------------------------- Doppler client

class DopplerError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

// Fetch exactly `names` from the token's config. Returns a Map name -> value. Throws DopplerError.
async function dopplerFetch(token, names, timeoutMs = 15000) {
  const url = new URL('/v3/configs/config/secrets/download', apiBase());
  url.searchParams.set('format', 'json');
  url.searchParams.set('include_dynamic_secrets', 'false');
  url.searchParams.set('secrets', names.join(','));
  let res;
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
  } catch (e) {
    throw new DopplerError(e?.name === 'TimeoutError' ? 'DOPPLER_TIMEOUT' : 'DOPPLER_UNAVAILABLE',
      e?.name === 'TimeoutError' ? `Doppler did not answer within ${timeoutMs / 1000} s` : 'Doppler is unreachable');
  }
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel();
    throw new DopplerError('TOKEN_REJECTED', `Doppler rejected the service token (HTTP ${res.status}: expired, revoked or wrong)`);
  }
  if (res.status === 429) { await res.body?.cancel(); throw new DopplerError('DOPPLER_RATE_LIMITED', 'Doppler rate limit (HTTP 429)'); }
  if (!res.ok) { await res.body?.cancel(); throw new DopplerError('DOPPLER_UNAVAILABLE', `Doppler answered HTTP ${res.status}`); }
  let body;
  try { body = await res.json(); } catch { throw new DopplerError('DOPPLER_BAD_RESPONSE', 'Doppler returned no JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DopplerError('DOPPLER_BAD_RESPONSE', 'unexpected Doppler response');
  const wanted = new Set(names);
  const out = new Map();
  let unexpected = 0;
  for (const [k, v] of Object.entries(body)) {
    if (wanted.has(k)) { if (typeof v === 'string' && v.length > 0) out.set(k, v); }
    else if (!k.startsWith('DOPPLER_')) unexpected++;
  }
  for (const k of Object.keys(body)) body[k] = null;
  if (unexpected > 0) {
    out.clear();
    throw new DopplerError('DOPPLER_UNEXPECTED_SECRETS', `Doppler returned ${unexpected} secret(s) that were not requested; refusing them all`);
  }
  const missing = names.filter((n) => !out.has(n));
  if (missing.length) { out.clear(); throw new DopplerError('MISSING_SECRETS', `missing or empty in the Doppler config: ${missing.join(', ')}`, { missing }); }
  return out;
}

async function dopplerIdentify(token) {
  // Reads only Doppler's own non-secret metadata names to check the token.
  const url = new URL('/v3/configs/config/secrets/download', apiBase());
  url.searchParams.set('format', 'json');
  url.searchParams.set('secrets', 'DOPPLER_PROJECT,DOPPLER_CONFIG,DOPPLER_ENVIRONMENT');
  let res;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(15000), redirect: 'error' });
  } catch { throw new DopplerError('DOPPLER_UNAVAILABLE', 'Doppler is unreachable'); }
  if (res.status === 401 || res.status === 403) { await res.body?.cancel(); throw new DopplerError('TOKEN_REJECTED', `Doppler rejected the token (HTTP ${res.status})`); }
  if (!res.ok) { await res.body?.cancel(); throw new DopplerError('DOPPLER_UNAVAILABLE', `Doppler answered HTTP ${res.status}`); }
  const body = await res.json().catch(() => ({}));
  const unexpected = Object.keys(body).filter((k) => !k.startsWith('DOPPLER_')).length;
  const id = { project: String(body.DOPPLER_PROJECT ?? '?'), config: String(body.DOPPLER_CONFIG ?? '?') };
  for (const k of Object.keys(body)) body[k] = null;
  if (unexpected) throw new DopplerError('DOPPLER_UNEXPECTED_SECRETS', 'Doppler ignored the name filter; refusing this token');
  return id;
}

// ---------------------------------------------------------------- redaction

function makeRedactor(values) {
  const forms = [];
  for (const v of values) {
    if (typeof v !== 'string' || v.length < 4) continue;
    forms.push(v);
    const j = JSON.stringify(v).slice(1, -1); if (j !== v) forms.push(j);
    const u = encodeURIComponent(v); if (u !== v) forms.push(u);
  }
  forms.sort((a, b) => b.length - a.length);
  return (text) => {
    let t = text;
    for (const f of forms) if (t.includes(f)) t = t.split(f).join('[redacted:fundkit]');
    return t;
  };
}

// ---------------------------------------------------------------- line framing

function lineReader(stream, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  });
}
function send(stream, obj) { if (stream && !stream.destroyed && stream.writable) stream.write(JSON.stringify(obj) + '\n'); }

// ---------------------------------------------------------------- session daemon

class Session {
  constructor(token, opts) {
    this.token = token;
    this.opts = opts;
    this.started = Date.now();
    this.expires = this.started + opts.ttlMs;
    this.clients = new Set();
    this.children = new Map(); // alias -> {proc, client, exchange, role, redact, configDir}
    this.everAttached = false;
    this.ending = false;
    this.log = opts.log;
  }

  info() {
    return {
      state: 'active', started: new Date(this.started).toISOString(), expires: new Date(this.expires).toISOString(),
      doppler: this.opts.identity, writes: this.opts.writes,
      maxTransferValue: this.opts.maxTransfer, maxDailyValue: this.opts.maxDaily ?? null,
      profiles: [...this.children.entries()].map(([alias, c]) => ({ alias, exchange: c.exchange, role: c.role, dryRun: c.dryRun })),
    };
  }

  async listen() {
    ensurePrivateDir(runDir());
    const sp = sockPath();
    if (fs.existsSync(sp)) {
      if (await pingSocket(sp)) throw new Error('a fundkit session is already running (fundkit stop ends it)');
      fs.unlinkSync(sp);
    }
    this.server = net.createServer((c) => this.onClient(c));
    const old = process.umask(0o077);
    await new Promise((res, rej) => { this.server.once('error', rej); this.server.listen(sp, res); });
    process.umask(old);
    fs.chmodSync(sp, 0o600);
    this.ttlTimer = setTimeout(() => this.end('session time limit reached'), this.opts.ttlMs);
    this.ttlTimer.unref?.();
  }

  onClient(c) {
    const client = { sock: c, name: 'host', aliases: new Set() };
    this.clients.add(client);
    lineReader(c, (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      this.onMessage(client, m).catch((e) => send(c, { t: 'error', id: m.id, code: 'INTERNAL', message: String(e?.message ?? e) }));
    });
    const gone = () => {
      if (!this.clients.delete(client)) return;
      for (const a of client.aliases) this.stopChild(a, 'host session closed');
      if (client.attached) this.log(`host session ${client.name} detached`);
      if (client.attached && !this.opts.keep && !this.opts.wrapped && ![...this.clients].some((x) => x.attached)) {
        this.end('the host session ended');
      }
    };
    c.on('close', gone); c.on('error', gone);
  }

  async onMessage(client, m) {
    const c = client.sock;
    switch (m.t) {
      case 'ping': return send(c, { t: 'pong', id: m.id });
      case 'status': return send(c, { t: 'status', id: m.id, session: this.info() });
      case 'stop': send(c, { t: 'stopping', id: m.id }); return this.end('fundkit stop');
      case 'hello':
        client.attached = true; this.everAttached = true;
        client.name = String(m.host ?? 'host').slice(0, 60).replace(/[^\w .\-/()]/g, '');
        this.log(`host session ${client.name} attached`);
        return send(c, { t: 'hello', id: m.id, session: this.info() });
      case 'connect': return this.connect(client, m);
      case 'disconnect':
        if (client.aliases.has(m.alias)) this.stopChild(m.alias, 'disconnected by the host');
        return send(c, { t: 'disconnected', id: m.id, alias: m.alias });
      case 'rpc': {
        const ch = this.children.get(m.alias);
        if (!ch || ch.client !== client) return;
        if (ch.proc.stdin.writable) ch.proc.stdin.write(JSON.stringify(m.msg) + '\n');
        return;
      }
      default: return send(c, { t: 'error', id: m.id, code: 'BAD_REQUEST', message: 'unknown message' });
    }
  }

  async connect(client, m) {
    const c = client.sock;
    const fail = (code, message, extra = {}) => send(c, { t: 'error', id: m.id, code, message, ...extra });
    const exchange = normExchange(m.exchange);
    if (!exchange) return fail('UNKNOWN_EXCHANGE', `unsupported exchange: ${String(m.exchange).slice(0, 40)}`);
    const role = m.role;
    if (!ROLES[role]) return fail('UNKNOWN_ROLE', 'role must be deposit-only, source or settlement');
    const alias = aliasFor(exchange, role);
    if (this.children.has(alias)) {
      const ch = this.children.get(alias);
      if (ch.client === client) return send(c, { t: 'connected', id: m.id, alias, exchange, role, dryRun: ch.dryRun, already: true });
      return fail('ALIAS_IN_USE', `${alias} is connected to another host session`);
    }
    const server = ccxtServerPath();
    if (!server || !fs.existsSync(server)) return fail('SERVER_NOT_INSTALLED', 'pinned ccxt-mcp not found; run fundkit install');
    const names = secretNames(exchange, role);
    let values;
    try {
      values = await dopplerFetch(this.token, names.map((n) => n.doppler));
    } catch (e) {
      if (e.code === 'TOKEN_REJECTED') {
        fail(e.code, `${e.message}. The session has ended; start a new one with: fundkit session`);
        this.log(`Doppler rejected the token while fetching for ${alias}`);
        return this.end('Doppler rejected the token');
      }
      if (e.code === 'MISSING_SECRETS') {
        const pw = e.missing.some((n) => n.endsWith('_PASSWORD'));
        this.log(`${alias}: missing in Doppler: ${e.missing.join(', ')}`);
        return fail(e.code, e.message + (pw ? ` (${exchange} needs its API passphrase as ${names.find((n) => n.env.endsWith('_PASSWORD')).doppler})` : ''), { missing: e.missing });
      }
      return fail(e.code ?? 'DOPPLER_ERROR', e.message);
    }
    if (this.ending) { values.clear(); return fail('SESSION_ENDED', 'the session is ending'); }
    const dryRun = role === 'deposit-only' ? true : !this.opts.writes;
    const account = { exchange, funds: 'live', maxTransferValue: role === 'deposit-only' ? 10 : this.opts.maxTransfer, confirm: 'always', dryRun };
    if (role !== 'deposit-only' && this.opts.maxDaily) account.maxDailyValue = this.opts.maxDaily;
    const configDir = path.join(runDir(), 'profiles', alias);
    ensurePrivateDir(path.join(runDir(), 'profiles'));
    ensurePrivateDir(configDir);
    const configPath = path.join(configDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ settings: { strictPermissions: true, hideDisabledTools: true }, accounts: { [alias]: account } }, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(configPath, 0o600);
    const env = {};
    for (const k of PASS_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
    env.CCXT_MCP_CONFIG = configPath;
    const secretVals = [];
    for (const n of names) { env[n.env] = values.get(n.doppler); secretVals.push(values.get(n.doppler)); }
    values.clear();
    const proc = spawn(process.execPath, [server], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    for (const n of names) env[n.env] = null;
    const redact = makeRedactor([...secretVals, this.token]);
    secretVals.length = 0;
    const ch = { proc, client, exchange, role, redact, configDir, dryRun };
    this.children.set(alias, ch);
    client.aliases.add(alias);
    lineReader(proc.stdout, (line) => {
      let msg; try { msg = JSON.parse(redact(line)); } catch { return; }
      send(client.sock, { t: 'rpc', alias, msg });
    });
    proc.stderr.on('data', (d) => { if (this.opts.debug) this.log(`${alias} stderr: ${redact(String(d)).trim().slice(0, 500)}`); });
    proc.on('exit', (code, sig) => {
      if (this.children.get(alias) === ch) this.children.delete(alias);
      client.aliases.delete(alias);
      ch.redact = null;
      fs.rmSync(configDir, { recursive: true, force: true });
      send(client.sock, { t: 'exit', alias, code, signal: sig });
      this.log(`${alias} stopped`);
    });
    proc.on('error', () => {});
    this.log(`${alias} connected for ${client.name} (${exchange}, ${role}, dryRun ${dryRun}); fetched ${names.map((n) => n.doppler).join(', ')}`);
    send(c, { t: 'connected', id: m.id, alias, exchange, role, dryRun, configPath, fetched: names.map((n) => n.doppler) });
  }

  stopChild(alias, why) {
    const ch = this.children.get(alias);
    if (!ch) return;
    this.log(`${alias}: ${why}`);
    try { ch.proc.stdin.end(); } catch {}
    try { ch.proc.kill('SIGTERM'); } catch {}
    const t = setTimeout(() => { try { ch.proc.kill('SIGKILL'); } catch {} }, 2000);
    t.unref?.();
  }

  async end(reason) {
    if (this.ending) return;
    this.ending = true;
    this.token = null;
    this.log(`session ended: ${reason}`);
    clearTimeout(this.ttlTimer);
    for (const cl of this.clients) send(cl.sock, { t: 'end', reason });
    const exits = [...this.children.values()].map((ch) => new Promise((r) => { if (ch.proc.exitCode !== null || ch.proc.signalCode) r(); else ch.proc.once('exit', r); }));
    for (const a of [...this.children.keys()]) this.stopChild(a, 'session ending');
    await Promise.race([Promise.all(exits), new Promise((r) => setTimeout(r, 3000))]);
    for (const ch of this.children.values()) { try { ch.proc.kill('SIGKILL'); } catch {} fs.rmSync(ch.configDir, { recursive: true, force: true }); }
    try { this.server?.close(); } catch {}
    try { fs.unlinkSync(sockPath()); } catch {}
    try { fs.rmSync(path.join(runDir(), 'profiles'), { recursive: true, force: true }); } catch {}
    for (const cl of this.clients) { try { cl.sock.end(); } catch {} }
    this.opts.onEnd?.(reason);
  }
}

function pingSocket(sp, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = net.connect(sp);
    const t = setTimeout(() => { s.destroy(); resolve(null); }, timeoutMs);
    s.on('error', () => { clearTimeout(t); resolve(null); });
    s.on('connect', () => send(s, { t: 'status', id: 1 }));
    lineReader(s, (line) => { clearTimeout(t); s.end(); try { resolve(JSON.parse(line).session ?? {}); } catch { resolve({}); } });
  });
}

async function cmdSession(argv) {
  const sep = argv.indexOf('--');
  const hostCmd = sep >= 0 ? argv.slice(sep + 1) : null;
  const args = sep >= 0 ? argv.slice(0, sep) : argv;
  const opts = { ttlMs: parseDuration('8h'), writes: false, maxTransfer: 10, maxDaily: null, keep: false, debug: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--ttl') opts.ttlMs = parseDuration(args[++i]);
    else if (a === '--writes') opts.writes = true;
    else if (a === '--max-transfer') opts.maxTransfer = Number(args[++i]);
    else if (a === '--max-daily') opts.maxDaily = Number(args[++i]);
    else if (a === '--keep') opts.keep = true;
    else if (a === '--debug') opts.debug = true;
    else { process.stderr.write(`unknown option ${a}\n`); return 2; }
  }
  if (!(opts.maxTransfer > 0) || (opts.maxDaily !== null && !(opts.maxDaily > 0))) { process.stderr.write('limits must be positive numbers\n'); return 2; }
  if (opts.writes && !args.includes('--max-transfer')) { process.stderr.write('--writes needs an explicit --max-transfer <USD>\n'); return 2; }
  if (hostCmd && hostCmd.length === 0) { process.stderr.write('nothing to run after --\n'); return 2; }
  const existing = await pingSocket(sockPath());
  if (existing) { process.stderr.write(`a fundkit session is already active until ${existing.expires}\n`); return 1; }
  const say = (s) => process.stderr.write(s + '\n');
  say('fundkit session: exchange credentials for this session come from one Doppler config.');
  say('Paste a read-only Doppler service token (dp.st.…). Input is hidden; Enter submits, Ctrl-C cancels.');
  let token;
  try {
    token = await readHiddenFromTty('Doppler service token: ');
  } catch (e) {
    say(e.code === 'NO_TTY' ? 'No terminal: run fundkit session in an interactive terminal (the token is never read from stdin, argv or the environment).' : `Cancelled (${e.message}). Nothing was stored.`);
    return e.code === 'NO_TTY' ? 2 : 130;
  }
  if (!TOKEN_RE.test(token)) { token = null; say('That is not a Doppler service token (dp.st.…). Nothing was sent or stored.'); return 2; }
  let identity;
  try { identity = await dopplerIdentify(token); } catch (e) { token = null; say(`${e.message}. Nothing was stored.`); return 3; }
  const wrapped = Boolean(hostCmd);
  const quiet = wrapped;
  const log = (s) => { if (!quiet) process.stderr.write(`[${nowIso()}] ${s}\n`); };
  let resolveEnd;
  const ended = new Promise((r) => { resolveEnd = r; });
  const session = new Session(token, { ...opts, identity, wrapped, log, onEnd: (r) => resolveEnd(r) });
  token = null;
  try { await session.listen(); } catch (e) { session.token = null; say(e.message); return 1; }
  say(`Session active: Doppler project ${identity.project}, config ${identity.config}; until ${new Date(session.expires).toISOString()}.`);
  say(`Money-moving profiles: ${opts.writes ? `writes enabled, cap ${opts.maxTransfer} USD per call` : 'dryRun (start with --writes --max-transfer <USD> to allow real writes)'}. Deposit-only profiles always dryRun.`);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => session.end(`signal ${sig}`));
  process.on('uncaughtException', (e) => { session.end(`error: ${e?.message ?? e}`); });
  let hostExited = Promise.resolve();
  if (wrapped) {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('DOPPLER_')) delete env[k];
    const host = spawn(hostCmd[0], hostCmd.slice(1), { stdio: 'inherit', env });
    hostExited = new Promise((r) => { host.on('exit', r); host.on('error', r); });
    host.on('exit', () => session.end('the host exited'));
    host.on('error', (e) => session.end(`could not start ${hostCmd[0]}: ${e.message}`));
    process.removeAllListeners('SIGINT'); process.on('SIGINT', () => {}); // Ctrl-C belongs to the host
  } else {
    say('Keep this terminal open. Ctrl-C (or closing it) ends the session; it also ends when the host session that used it closes.');
  }
  const reason = await ended;
  await hostExited; // a session that ends early (token rejected, time limit) leaves the host running until it exits
  say(`fundkit session ended (${reason}). Token and fetched credentials dropped; profile processes stopped.`);
  return reason.startsWith('error') || reason.includes('rejected') ? 3 : 0;
}

// ---------------------------------------------------------------- MCP broker (host side)

const TOOLS = [
  {
    name: 'fundkit_profiles',
    description: 'Fundkit session profiles for moving USDT between crypto exchanges (Binance, Bybit, Gate, OKX, Bitget, WhiteBIT, BingX, MEXC, KuCoin), any language, e.g. "переведи 300 USDT с OKX на Bybit". Read-only: shows whether a session-only Doppler credential session is active, which session profiles are connected, and (with from/to) which exchange+role profiles a route needs. Never returns or accepts secret values. Read the usdt-funding skill first.',
    inputSchema: { type: 'object', properties: { from: { type: 'string', description: 'source exchange, e.g. okx' }, to: { type: 'string', description: 'destination exchange, e.g. bybit' } }, additionalProperties: false },
  },
  {
    name: 'fundkit_connect',
    description: 'Connect one session profile (a pinned ccxt-mcp server for one exchange account and role) using the active Doppler session. The session fetches only that exchange+role\'s fixed credential names and gives them to that server only; no value is returned. Roles: deposit-only (read-only key on B), source (A, withdrawal key), settlement (B, internal-transfer key). Returns the alias for fundkit_read/fundkit_write.',
    inputSchema: { type: 'object', properties: { exchange: { type: 'string' }, role: { type: 'string', enum: Object.keys(ROLES) } }, required: ['exchange', 'role'], additionalProperties: false },
  },
  {
    name: 'fundkit_read',
    description: 'Call a read tool (get_safety_status, list_accounts, get_balance, call_read_method, call_implicit_get, …) of a connected session profile. Arguments are passed unchanged. Refuses write tools and get_deposit_address.',
    inputSchema: { type: 'object', properties: { alias: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object' } }, required: ['alias', 'tool'], additionalProperties: false },
  },
  {
    name: 'fundkit_write',
    description: 'Money move on a connected session profile: only withdraw or transfer, only after the usdt-funding plan approval. The server opens the host\'s native confirmation form for the human; nothing is sent unless the human accepts it. Arguments are passed unchanged.',
    inputSchema: { type: 'object', properties: { alias: { type: 'string' }, tool: { type: 'string', enum: [...WRITE_TOOLS] }, arguments: { type: 'object' } }, required: ['alias', 'tool', 'arguments'], additionalProperties: false },
  },
  {
    name: 'fundkit_disconnect',
    description: 'Stop a connected session profile (its server process and its credentials).',
    inputSchema: { type: 'object', properties: { alias: { type: 'string' } }, required: ['alias'], additionalProperties: false },
  },
];

function instructions() {
  return [
    'fundkit moves USDT between crypto exchanges with a human approving every write.',
    `For any request to move, transfer, withdraw, top up or deposit USDT between exchanges or wallets (in any language, e.g. "переведи 300 USDT с OKX на Bybit"), first read and follow the usdt-funding skill: ${path.join(REPO, 'SKILL.md')}.`,
    'Use connected ccxt-mcp profiles first. Only for a profile the route needs that is not connected, call fundkit_profiles; if no session is active, offer the user the private terminal step it describes.',
    'Never ask for, accept or repeat a Doppler token or exchange key in the chat.',
  ].join(' ');
}

function routeNeeds(from, to) {
  const out = [];
  const a = from ? normExchange(from) : null; const b = to ? normExchange(to) : null;
  if (from && !a) out.push({ exchange: from, error: 'unsupported exchange' });
  if (to && !b) out.push({ exchange: to, error: 'unsupported exchange' });
  if (a) out.push({ exchange: a, role: 'source', alias: aliasFor(a, 'source'), dopplerNames: secretNames(a, 'source').map((n) => n.doppler), when: 'withdraws from A' });
  if (b) {
    out.push({ exchange: b, role: 'deposit-only', alias: aliasFor(b, 'deposit-only'), dopplerNames: secretNames(b, 'deposit-only').map((n) => n.doppler), when: 'reads B\'s own deposit address' });
    out.push({ exchange: b, role: 'settlement', alias: aliasFor(b, 'settlement'), dopplerNames: secretNames(b, 'settlement').map((n) => n.doppler), when: 'only if the credit must move to another B wallet (plan <PLAN-ID>-B)' });
  }
  return out;
}

const START_STEP = {
  userStep: 'In a separate terminal on this machine (not in this chat), run: fundkit session   and paste the read-only Doppler service token there (input is hidden). Keep that terminal open; then continue here. Alternative for the next launch: fundkit session -- claude  (or -- codex), which asks first and then starts the host.',
  forRealWrites: 'add --writes --max-transfer <USD> [--max-daily <USD>] to that command; without it money-moving profiles are dryRun',
  never: 'Do not ask for the token in the chat. If the user pastes it here anyway, do not use it; tell them to revoke it in Doppler and create a new one.',
};

class Broker {
  constructor() {
    this.hostCaps = {};
    this.hostInfo = {};
    this.protocol = '2025-06-18';
    this.nextHostId = 1;
    this.hostPending = new Map(); // our request id to host -> resolver
    this.daemon = null; // {sock, pending: Map}
    this.ctlId = 1;
    this.children = new Map(); // alias -> {nextId, pending, exchange, role, tools}
    this.callMap = new Map(); // host request id -> {alias, childId}
    this.lastEnd = null;
  }

  out(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

  start() {
    lineReader(process.stdin, (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      this.onHost(m).catch((e) => { if (m.id !== undefined && m.method) this.out({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: String(e?.message ?? e) } }); });
    });
    process.stdin.on('end', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  shutdown() { try { this.daemon?.sock.end(); } catch {} setTimeout(() => process.exit(0), 50); }

  async onHost(m) {
    if (m.method === undefined && m.id !== undefined) { // response to our request
      const p = this.hostPending.get(m.id); if (p) { this.hostPending.delete(m.id); p(m); }
      return;
    }
    const reply = (result) => this.out({ jsonrpc: '2.0', id: m.id, result });
    switch (m.method) {
      case 'initialize':
        this.hostCaps = m.params?.capabilities ?? {};
        this.hostInfo = m.params?.clientInfo ?? {};
        if (typeof m.params?.protocolVersion === 'string') this.protocol = m.params.protocolVersion;
        return reply({ protocolVersion: this.protocol, capabilities: { tools: {} }, serverInfo: { name: 'fundkit', version: VERSION }, instructions: instructions() });
      case 'notifications/initialized': return;
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS });
      case 'notifications/cancelled': {
        const c = this.callMap.get(m.params?.requestId);
        if (c) this.ctl({ t: 'rpc', alias: c.alias, msg: { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: c.childId, reason: m.params?.reason } } });
        return;
      }
      case 'tools/call': return reply(await this.call(m.id, m.params?.name, m.params?.arguments ?? {}));
      default:
        if (m.id !== undefined) this.out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
    }
  }

  // ---- daemon link
  async attach() {
    if (this.daemon) return this.daemon;
    const sp = sockPath();
    const sock = await new Promise((resolve) => {
      const s = net.connect(sp); s.once('connect', () => resolve(s)); s.once('error', () => resolve(null));
    });
    if (!sock) return null;
    const d = { sock, pending: new Map() };
    this.daemon = d;
    lineReader(sock, (line) => { let m; try { m = JSON.parse(line); } catch { return; } this.onDaemon(m); });
    const lost = () => {
      if (this.daemon !== d) return;
      this.daemon = null;
      for (const [, r] of d.pending) r({ t: 'error', code: 'SESSION_ENDED', message: 'the fundkit session ended' });
      d.pending.clear();
      for (const alias of [...this.children.keys()]) this.childGone(alias, this.lastEnd ?? 'the fundkit session ended');
    };
    sock.on('close', lost); sock.on('error', lost);
    const hello = await this.ctl({ t: 'hello', host: `${this.hostInfo.name ?? 'host'} ${this.hostInfo.version ?? ''}`.trim() });
    if (hello.t !== 'hello') return null;
    this.lastEnd = null;
    return d;
  }

  ctl(msg) {
    const d = this.daemon;
    if (!d) return Promise.resolve({ t: 'error', code: 'NO_SESSION' });
    if (msg.t === 'rpc') { send(d.sock, msg); return Promise.resolve(); }
    const id = this.ctlId++;
    return new Promise((resolve) => { d.pending.set(id, resolve); send(d.sock, { ...msg, id }); });
  }

  onDaemon(m) {
    if (m.t === 'rpc') return this.onChild(m.alias, m.msg);
    if (m.t === 'exit') return this.childGone(m.alias, 'the profile server stopped');
    if (m.t === 'end') { this.lastEnd = `the fundkit session ended: ${m.reason}`; return; }
    if (m.id !== undefined && this.daemon?.pending.has(m.id)) { const r = this.daemon.pending.get(m.id); this.daemon.pending.delete(m.id); r(m); }
  }

  childGone(alias, why) {
    const ch = this.children.get(alias); if (!ch) return;
    this.children.delete(alias);
    for (const [, p] of ch.pending) p({ error: { code: -32000, message: `${why}. If this was a withdraw or transfer, its outcome is unknown: reconcile (SKILL.md 2.7), do not retry.` } });
    ch.pending.clear();
  }

  childRequest(alias, method, params, timeoutMs) {
    const ch = this.children.get(alias);
    if (!ch) return Promise.resolve({ error: { code: -32000, message: 'profile not connected' } });
    const id = ch.nextId++;
    return new Promise((resolve) => {
      let timer = null;
      ch.pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
      if (timeoutMs) timer = setTimeout(() => { if (ch.pending.delete(id)) resolve({ error: { code: -32001, message: `no answer within ${timeoutMs / 1000} s` } }); }, timeoutMs);
      this.ctl({ t: 'rpc', alias, msg: { jsonrpc: '2.0', id, method, params } });
    });
  }

  async onChild(alias, msg) {
    const ch = this.children.get(alias); if (!ch) return;
    if (msg.method === undefined && msg.id !== undefined) { const p = ch.pending.get(msg.id); if (p) { ch.pending.delete(msg.id); p(msg); } return; }
    if (msg.method && msg.id !== undefined) { // server -> client request from ccxt-mcp
      const answer = (body) => this.ctl({ t: 'rpc', alias, msg: { jsonrpc: '2.0', id: msg.id, ...body } });
      if (msg.method === 'ping') return answer({ result: {} });
      if (msg.method === 'elicitation/create' && this.hostCaps.elicitation) {
        // Forward the native confirmation form to the host unchanged; relay the human's answer.
        const hid = `fk-${this.nextHostId++}`;
        const res = await new Promise((resolve) => { this.hostPending.set(hid, resolve); this.out({ jsonrpc: '2.0', id: hid, method: 'elicitation/create', params: msg.params }); });
        return answer(res.error ? { error: res.error } : { result: res.result });
      }
      return answer({ error: { code: -32601, message: 'not supported by the fundkit broker' } });
    }
    // notifications from the child are not forwarded
  }

  text(obj, isError = false) { return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], isError }; }

  async call(hostId, name, args) {
    switch (name) {
      case 'fundkit_profiles': {
        const d = await this.attach();
        const needs = (args.from || args.to) ? routeNeeds(args.from, args.to) : undefined;
        if (!d) return this.text({ session: 'none', note: this.lastEnd ?? 'no fundkit session is running', needs, ...START_STEP, naming: 'Doppler names: <EXCHANGE>_<DEPOSIT|SOURCE|SETTLEMENT>_<APIKEY|SECRET|PASSWORD>; PASSWORD only for OKX, Bitget, KuCoin' });
        const st = await this.ctl({ t: 'status' });
        const s = st.session ?? {};
        const mine = [...this.children.entries()].map(([alias, c]) => ({ alias, exchange: c.exchange, role: c.role, dryRun: c.dryRun, registration: `fundkit/${alias}`, configPath: c.configPath }));
        if (needs) for (const n of needs) n.connected = Boolean(n.alias && this.children.has(n.alias));
        return this.text({ session: 'active', expires: s.expires, doppler: s.doppler, writes: s.writes, maxTransferValue: s.maxTransferValue, maxDailyValue: s.maxDailyValue, profiles: mine, needs });
      }
      case 'fundkit_connect': {
        const d = await this.attach();
        if (!d) return this.text({ error: 'NO_SESSION', message: this.lastEnd ?? 'no fundkit session is running', ...START_STEP }, true);
        const r = await this.ctl({ t: 'connect', exchange: args.exchange, role: args.role });
        if (r.t === 'error') return this.text({ error: r.code, message: r.message, missing: r.missing, ...(r.code === 'TOKEN_REJECTED' || r.code === 'SESSION_ENDED' || r.code === 'NO_SESSION' ? START_STEP : {}) }, true);
        if (r.already && this.children.has(r.alias)) return this.text({ alias: r.alias, already: true });
        const ch = { nextId: 1, pending: new Map(), exchange: r.exchange, role: r.role, dryRun: r.dryRun, configPath: r.configPath };
        this.children.set(r.alias, ch);
        const caps = this.hostCaps.elicitation ? { elicitation: this.hostCaps.elicitation } : {};
        const init = await this.childRequest(r.alias, 'initialize', { protocolVersion: this.protocol, capabilities: caps, clientInfo: { name: `fundkit-broker (${this.hostInfo.name ?? 'host'})`, version: VERSION } }, 60000);
        if (init.error) { await this.ctl({ t: 'disconnect', alias: r.alias }); this.children.delete(r.alias); return this.text({ error: 'SERVER_START_FAILED', message: init.error.message }, true); }
        this.ctl({ t: 'rpc', alias: r.alias, msg: { jsonrpc: '2.0', method: 'notifications/initialized' } });
        const tl = await this.childRequest(r.alias, 'tools/list', {}, 30000);
        ch.tools = (tl.result?.tools ?? []).map((t) => t.name);
        return this.text({
          alias: r.alias, exchange: r.exchange, role: r.role, registration: `fundkit/${r.alias}`, configPath: r.configPath, dryRun: r.dryRun,
          server: init.result?.serverInfo, tools: ch.tools, fetchedNames: r.fetched,
          next: 'Run Step 0 on this alias with fundkit_read (get_safety_status, list_accounts) and the venue key check before any plan.',
        });
      }
      case 'fundkit_disconnect': {
        if (!this.children.has(args.alias)) return this.text({ error: 'UNKNOWN_ALIAS' }, true);
        await this.ctl({ t: 'disconnect', alias: args.alias });
        this.childGone(args.alias, 'disconnected');
        return this.text({ disconnected: args.alias });
      }
      case 'fundkit_read':
      case 'fundkit_write': {
        const tool = String(args.tool ?? '');
        const isWrite = name === 'fundkit_write';
        if (NEVER_TOOLS.has(tool)) return this.text({ error: 'NOT_FORWARDED', message: `${tool} is never called by fundkit` }, true);
        if (isWrite !== WRITE_TOOLS.has(tool)) return this.text({ error: 'NOT_FORWARDED', message: isWrite ? 'fundkit_write forwards only withdraw and transfer' : `${tool} is a money move: use fundkit_write after approval` }, true);
        if (!this.children.has(args.alias)) {
          await this.attach();
          return this.text({ error: 'UNKNOWN_ALIAS', message: `${args.alias} is not a connected session profile (fundkit_profiles lists them)`, ...(this.daemon ? {} : START_STEP) }, true);
        }
        const ch = this.children.get(args.alias);
        const p = this.childRequest(args.alias, 'tools/call', { name: tool, arguments: args.arguments ?? {} }, isWrite ? 0 : 180000);
        this.callMap.set(hostId, { alias: args.alias, childId: ch.nextId - 1 });
        const r = await p;
        this.callMap.delete(hostId);
        if (r.error) return this.text({ error: 'PROFILE_ERROR', code: r.error.code, message: r.error.message }, true);
        return r.result;
      }
      default:
        return this.text({ error: 'UNKNOWN_TOOL' }, true);
    }
  }
}

// ---------------------------------------------------------------- install

function which(cmd) {
  for (const d of (process.env.PATH ?? '').split(':')) { const p = path.join(d, cmd); try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {} }
  return null;
}
function pinnedInstalled(appDir) {
  try {
    for (const [pkg, v] of Object.entries(PINS)) {
      if (JSON.parse(fs.readFileSync(path.join(appDir, 'node_modules', pkg, 'package.json'), 'utf8')).version !== v) return false;
    }
    return true;
  } catch { return false; }
}
function linkDir(link, target) {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  let st = null; try { st = fs.lstatSync(link); } catch {}
  if (st) {
    if (st.isSymbolicLink() && path.resolve(path.dirname(link), fs.readlinkSync(link)) === target) return 'present';
    return 'exists (left unchanged)';
  }
  fs.symlinkSync(target, link, 'dir');
  return 'linked';
}

function cmdInstall(argv) {
  const opt = { appDir: path.join(home(), '.local', 'share', 'fundkit', 'app'), claude: null, codex: null, skills: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--app-dir') opt.appDir = path.resolve(argv[++i]);
    else if (a === '--no-claude') opt.claude = false;
    else if (a === '--no-codex') opt.codex = false;
    else if (a === '--no-skills') opt.skills = false;
    else { process.stderr.write(`unknown option ${a}\n`); return 2; }
  }
  const say = (s) => process.stdout.write(s + '\n');
  const [maj] = process.versions.node.split('.').map(Number);
  if (maj < 20) { say(`Node ${process.versions.node} is too old; fundkit needs Node 20+`); return 1; }
  // 1. pinned server
  if (pinnedInstalled(opt.appDir)) say(`ccxt-mcp: pinned versions already in ${opt.appDir}`);
  else {
    const npm = which('npm');
    if (!npm) { say('npm not found'); return 1; }
    fs.mkdirSync(opt.appDir, { recursive: true });
    say(`ccxt-mcp: installing pinned ${Object.entries(PINS).map(([k, v]) => `${k}@${v}`).join(' ')} into ${opt.appDir}`);
    const r = spawnSync(npm, ['--prefix', opt.appDir, 'install', '--save-exact', '--ignore-scripts', '--no-fund', '--no-audit', ...Object.entries(PINS).map(([k, v]) => `${k}@${v}`)], { stdio: 'inherit' });
    if (r.status !== 0 || !pinnedInstalled(opt.appDir)) { say('npm install failed'); return 1; }
  }
  // 2. launcher + install record (no secrets)
  const bin = path.join(home(), '.local', 'bin', 'fundkit');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(REPO, 'bin', 'fundkit.mjs')}" "$@"\n`, { mode: 0o755 });
  ensurePrivateDir(confDir());
  fs.writeFileSync(path.join(confDir(), 'install.json'), JSON.stringify({ repo: REPO, appDir: opt.appDir, node: process.execPath, installed: nowIso(), version: VERSION }, null, 2) + '\n', { mode: 0o600 });
  say(`launcher: ${bin}${(process.env.PATH ?? '').split(':').includes(path.dirname(bin)) ? '' : ` (add ${path.dirname(bin)} to PATH, or call it by full path)`}`);
  // 3. skill links (automatic discovery)
  if (opt.skills) {
    say(`skill (Claude Code): ~/.claude/skills/usdt-funding ${linkDir(path.join(home(), '.claude', 'skills', 'usdt-funding'), REPO)}`);
    say(`skill (Codex): ~/.agents/skills/usdt-funding ${linkDir(path.join(home(), '.agents', 'skills', 'usdt-funding'), REPO)}`);
  }
  // 4. host registration of the broker (no secrets, no env)
  const entry = { command: process.execPath, args: [path.join(REPO, 'bin', 'fundkit.mjs'), 'mcp'] };
  const claude = opt.claude === false ? null : which('claude');
  if (claude) {
    const have = spawnSync(claude, ['mcp', 'get', 'fundkit'], { encoding: 'utf8' });
    if (have.status === 0) say('Claude Code: server "fundkit" already registered (left unchanged)');
    else {
      const r = spawnSync(claude, ['mcp', 'add-json', '-s', 'user', 'fundkit', JSON.stringify(entry)], { encoding: 'utf8' });
      say(r.status === 0 ? 'Claude Code: registered user-scope server "fundkit"' : `Claude Code: registration failed: ${(r.stderr || r.stdout).trim()}`);
    }
  } else say('Claude Code: not found (skipped)');
  const codex = opt.codex === false ? null : which('codex');
  if (codex) {
    const cfgDir = process.env.CODEX_HOME || path.join(home(), '.codex');
    const cfg = path.join(cfgDir, 'config.toml');
    const text = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : '';
    if (/^\[mcp_servers\.fundkit\]/m.test(text)) say('Codex: [mcp_servers.fundkit] already present (left unchanged)');
    else {
      fs.mkdirSync(cfgDir, { recursive: true });
      const q = (s) => JSON.stringify(s);
      fs.appendFileSync(cfg, `${text && !text.endsWith('\n') ? '\n' : ''}\n[mcp_servers.fundkit]\ncommand = ${q(entry.command)}\nargs = [${entry.args.map(q).join(', ')}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 420\n`);
      say(`Codex: added [mcp_servers.fundkit] to ${cfg} (tool_timeout_sec = 420 for the 300 s confirmation form)`);
    }
  } else say('Codex: not found (skipped)');
  say('');
  say('Done. Start a new Claude Code or Codex session (an already running one does not load new servers) and ask in your own words,');
  say('e.g. "переведи 300 USDT с OKX на Bybit". Existing ccxt-mcp profiles keep working; Doppler is only needed for missing ones.');
  return 0;
}

// ---------------------------------------------------------------- status / stop

async function cmdStatus() {
  const s = await pingSocket(sockPath());
  if (!s) { process.stdout.write('no fundkit session\n'); return 1; }
  const { state, expires, doppler, writes, maxTransferValue, profiles } = s;
  process.stdout.write(JSON.stringify({ state, expires, doppler, writes, maxTransferValue, profiles }, null, 2) + '\n');
  return 0;
}
async function cmdStop() {
  const sp = sockPath();
  const ok = await new Promise((resolve) => {
    const s = net.connect(sp);
    s.on('error', () => resolve(false));
    s.on('connect', () => send(s, { t: 'stop', id: 1 }));
    lineReader(s, () => { s.end(); resolve(true); });
  });
  process.stdout.write(ok ? 'fundkit session stopping\n' : 'no fundkit session\n');
  return ok ? 0 : 1;
}

// ---------------------------------------------------------------- main

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'mcp': new Broker().start(); return null;
    case 'session': return cmdSession(rest);
    case 'install': return cmdInstall(rest);
    case 'status': return cmdStatus();
    case 'stop': return cmdStop();
    case '--version': process.stdout.write(VERSION + '\n'); return 0;
    default:
      process.stdout.write('usage: fundkit install | session [--writes --max-transfer USD] [--max-daily USD] [--ttl 8h] [--keep] [-- host-command] | status | stop | mcp\n');
      return cmd ? 2 : 0;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { if (code !== null && code !== undefined) process.exit(code); });
}
