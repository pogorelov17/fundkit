// Synthetic stand-in for ccxt-mcp 0.1.3 used by tests/test_session.py. Speaks MCP over stdio,
// records its environment as names plus sha256 of each value (never the values) into
// $HOME/fake-ccxt-events.jsonl, and asks for the native confirmation form on withdraw and
// transfer the way ccxt-mcp does (elicitation/create with one boolean `confirm`).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const events = path.join(process.env.HOME || '/nonexistent', 'fake-ccxt-events.jsonl');
const record = (e) => fs.appendFileSync(events, JSON.stringify({ pid: process.pid, ...e }) + '\n');
const configPath = process.env.CCXT_MCP_CONFIG;
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const [alias, account] = Object.entries(config.accounts)[0];
const EX = account.exchange.toUpperCase();
const stat = fs.statSync(configPath);
record({
  type: 'start', alias, argv: process.argv.slice(1), configPath, configMode: (stat.mode & 0o777).toString(8),
  config, envNames: Object.keys(process.env).sort(),
  envHashes: Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, sha(v)])),
});

let caps = {};
let nextId = 1;
const pending = new Map();
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const text = (o, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(o) }], isError });
const credFields = ['APIKEY', 'SECRET', 'PASSWORD'].filter((f) => process.env[`${EX}_${f}`]);

const tools = ['get_safety_status', 'list_accounts', 'get_balance', 'call_read_method', 'withdraw', 'transfer', 'get_deposit_address', 'debug_echo_key', 'slow_read']
  .map((name) => ({ name, description: name, inputSchema: { type: 'object' } }));

function ask(params) {
  const id = `srv-${nextId++}`;
  return new Promise((resolve) => { pending.set(id, resolve); out({ jsonrpc: '2.0', id, method: 'elicitation/create', params }); });
}

async function call(name, args) {
  record({ type: 'call', name, args });
  switch (name) {
    case 'get_safety_status':
      return text({ version: '0.1.3', ccxtVersion: '4.5.84', configProblems: [], elicitationSupported: Boolean(caps.elicitation), configPath, journal: path.join(process.env.HOME, '.cache/ccxt-mcp/journal'), unresolvedIntents: [], accounts: [alias] });
    case 'list_accounts':
      return text({ accounts: [{ alias, exchange: account.exchange, environment: 'live', funds: account.funds, dryRun: account.dryRun, confirm: account.confirm, maxTransferValue: account.maxTransferValue, credentials: credFields }] });
    case 'get_balance':
      return text({ USDT: { free: 1000, used: 0, total: 1000 } });
    case 'debug_echo_key': // an exchange echoing the key back, raw and JSON-escaped
      return text({ echoed: process.env[`${EX}_APIKEY`], nested: JSON.stringify({ secret: process.env[`${EX}_SECRET`] }), url: `https://x/?k=${encodeURIComponent(process.env[`${EX}_SECRET`] ?? '')}` });
    case 'slow_read':
      await new Promise((r) => setTimeout(r, Number(args.ms ?? 5000)));
      return text({ slow: true });
    case 'withdraw':
    case 'transfer': {
      if (!caps.elicitation) return text({ preview: true, meta: { confirmToken: 'tok-' + nextId } });
      const r = await ask({ mode: 'form', message: `${name} ${args.amount} ${args.code} on ${alias}`, requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] } });
      record({ type: 'form', name, answer: r.result ?? r.error ?? null });
      if (r.error) return text({ code: 'CONFIRM_UNAVAILABLE' }, true);
      if (r.result?.action !== 'accept' || r.result?.content?.confirm !== true) return text({ code: 'CONFIRM_DECLINED' }, true);
      if (account.dryRun) return text({ dryRun: true, wouldSend: { name, args } });
      record({ type: 'dispatch', name, args });
      return text({ id: name === 'withdraw' ? 'W-1' : 'T-1', status: 'pending' });
    }
    default:
      return text({ code: 'UNKNOWN_TOOL' }, true);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === undefined) { const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } continue; }
    if (m.method === 'initialize') { caps = m.params.capabilities ?? {}; record({ type: 'init', caps, clientInfo: m.params.clientInfo }); out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'ccxt-mcp', version: '0.1.3-fake' } } }); }
    else if (m.method === 'tools/list') out({ jsonrpc: '2.0', id: m.id, result: { tools } });
    else if (m.method === 'tools/call') call(m.params.name, m.params.arguments ?? {}).then((result) => out({ jsonrpc: '2.0', id: m.id, result }));
    else if (m.method === 'notifications/cancelled') record({ type: 'cancelled', params: m.params });
    else if (m.id !== undefined) out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nf' } });
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => { record({ type: 'sigterm' }); process.exit(0); });
