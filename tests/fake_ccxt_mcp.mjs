// Synthetic stand-in for ccxt-mcp 0.1.3, used by the Python tests. It speaks MCP over stdio and
// records what it saw into $HOME/fake-ccxt-events.jsonl: its environment as names plus a sha256
// of each value (never a value), every tool call, and every native form answer.
//
// Behavior the tests rely on:
//   * key checks (call_implicit_get on a venue's key-check method) answer with key metadata that,
//     like the real venues', also names an account UID, from $HOME/fake-uids.json ({"okx": "..."})
//     or UID-<EXCHANGE>-1; exchanges listed in $HOME/fake-key-check-errors.json fail it (AUTH_FAILED);
//   * the UID-only reads older instructions used answer with just the UID;
//   * every other call_implicit_get echoes the credentials back, raw, JSON-escaped and
//     URL-encoded, the way a careless exchange error might;
//   * call_read_method sleeps for params.fakeDelayMs when given;
//   * withdraw and transfer ask for the native form like ccxt-mcp (elicitation/create with one
//     required boolean `confirm` and ccxt-mcp's exact message format), check maxTransferValue,
//     and record a dispatch only when not dryRun;
//   * $HOME/fake-ccxt-fixtures.json ({"<exchange>": {"<tool>:<method>[:<params JSON>]": data}})
//     answers call_implicit_get / call_read_method in ccxt-mcp's envelope {ok, data}; a value
//     {"__error": {code, message}} answers an error envelope. Fixtures are read on every call.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME || '/nonexistent';
const EVENTS_PATH = path.join(HOME, 'fake-ccxt-events.jsonl');
const UID_OVERRIDES_PATH = path.join(HOME, 'fake-uids.json');
const KEY_CHECK_ERRORS_PATH = path.join(HOME, 'fake-key-check-errors.json');
const FIXTURES_PATH = path.join(HOME, 'fake-ccxt-fixtures.json');

/** exchange -> [key-check method, the UID field its metadata also carries] */
const KEY_CHECKS = {
  binance: ['sapiGetAccountApiRestrictions', 'uid'],
  bybit: ['privateGetV5UserQueryApi', 'userID'],
  okx: ['privateGetAccountConfig', 'uid'],
  bitget: ['privateSpotGetV2SpotAccountInfo', 'userId'],
  mexc: ['spotPrivateGetAccount', 'uid'],
  kucoin: ['privateGetUserApiKey', 'uid'],
  gate: ['privateAccountGetDetail', 'user_id'],
};

const UID_ONLY_READS = new Set(['privateGetAccount', 'spotPrivateGetUid']);

const TOOL_NAMES = [
  'get_safety_status',
  'list_accounts',
  'get_balance',
  'call_read_method',
  'call_implicit_get',
  'call_implicit_write',
  'call_write_method',
  'create_order',
  'withdraw',
  'transfer',
  'get_deposit_address',
];

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const record = (event) =>
  fs.appendFileSync(EVENTS_PATH, `${JSON.stringify({ pid: process.pid, ...event })}\n`);
const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const textResult = (body, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(body) }],
  isError,
});

const configPath = process.env.CCXT_MCP_CONFIG;
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const [alias, account] = Object.entries(config.accounts)[0];
const exchange = account.exchange;
const envPrefix = exchange.toUpperCase();
const credential = (field) => process.env[`${envPrefix}_${field}`];

record({
  type: 'start',
  alias,
  argv: process.argv.slice(1),
  configPath,
  configMode: (fs.statSync(configPath).mode & 0o777).toString(8),
  config,
  envNames: Object.keys(process.env).sort(),
  envHashes: Object.fromEntries(Object.entries(process.env).map(([name, value]) => [name, sha256(value)])),
});

function accountUid() {
  try {
    const overrides = JSON.parse(fs.readFileSync(UID_OVERRIDES_PATH, 'utf8'));
    if (overrides[exchange]) return overrides[exchange];
  } catch {
    // no overrides file: the default UID
  }
  return `UID-${envPrefix}-1`;
}

let hostCapabilities = {};
let nextRequestId = 1;
const pendingAnswers = new Map();

function askHost(params) {
  const id = `srv-${nextRequestId++}`;
  return new Promise((resolve) => {
    pendingAnswers.set(id, resolve);
    write({ id, method: 'elicitation/create', params });
  });
}

function keyCheckFails() {
  try {
    return JSON.parse(fs.readFileSync(KEY_CHECK_ERRORS_PATH, 'utf8')).includes(exchange);
  } catch {
    return false;
  }
}

/** The fixture for this exchange and call, or undefined. */
function fixture(tool, args) {
  let fixtures;
  try {
    fixtures = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'))[exchange] ?? {};
  } catch {
    return undefined;
  }
  const base = `${tool}:${args.method}`;
  const specific = `${base}:${JSON.stringify(args.params ?? {})}`;
  return Object.hasOwn(fixtures, specific) ? fixtures[specific] : fixtures[base];
}

function envelope(data) {
  if (data && typeof data === 'object' && data.__error) {
    return textResult({ ok: false, error: { retryable: false, ...data.__error } }, true);
  }
  return textResult({ ok: true, data, meta: { exchange } });
}

function implicitGet(args) {
  const keyCheck = KEY_CHECKS[exchange];
  if (keyCheck && args.method === keyCheck[0]) {
    if (keyCheckFails()) return textResult({ error: 'AUTH_FAILED', message: 'invalid key' }, true);
    return textResult({
      data: { [keyCheck[1]]: accountUid(), method: args.method, permissions: ['read', 'withdraw'] },
    });
  }
  if (UID_ONLY_READS.has(args.method)) return textResult({ data: { uid: accountUid() } });
  const secret = credential('SECRET') ?? '';
  const passphrase = credential('PASSWORD') ?? '';
  return textResult({
    data: {
      method: args.method,
      echoed: credential('APIKEY'),
      nested: JSON.stringify({ secret, passphrase }),
      url: `https://x/?k=${encodeURIComponent(secret)}&p=${encodeURIComponent(passphrase)}`,
    },
  });
}

const failure = (code) => textResult({ ok: false, code, error: { code, message: code } }, true);

/** ccxt-mcp's form text: `Confirm: <action> on <exchange> (account "<alias>", LIVE)` + preview. */
function formMessage(name, args) {
  const preview =
    name === 'withdraw'
      ? {
          currency: args.code,
          amount: args.amount,
          estimatedValueUsd: args.amount,
          destinationAddress: args.address,
          tag: args.tag,
          network: args.network ?? '(exchange default)',
          environment: 'live',
          warning: 'withdrawals are IRREVERSIBLE — verify the address and network character by character',
        }
      : { currency: args.code, amount: args.amount, from: args.fromAccount, to: args.toAccount };
  const action = name === 'withdraw' ? 'withdrawal' : 'transfer';
  return `Confirm: ${action} on ${exchange} (account ${JSON.stringify(alias)}, LIVE)\n${JSON.stringify(preview, null, 2)}`;
}

async function moneyMove(name, args) {
  // The real server checks the cap on every account before its form; the older session tests
  // exercise form forwarding on dryRun profiles with the default cap, so only live ones check it here.
  if (
    !account.dryRun &&
    typeof account.maxTransferValue === 'number' &&
    args.amount > account.maxTransferValue
  ) {
    return failure('TRANSFER_VALUE_CAP');
  }
  if (!hostCapabilities.elicitation) {
    return textResult({ preview: true, meta: { confirmToken: `tok-${nextRequestId}` } });
  }
  const answer = await askHost({
    message: formMessage(name, args),
    requestedSchema: {
      type: 'object',
      properties: { confirm: { type: 'boolean', description: 'approve this action' } },
      required: ['confirm'],
    },
  });
  record({ type: 'form', name, answer: answer.result ?? answer.error ?? null });
  if (answer.error) return failure('CONFIRM_UNAVAILABLE');
  if (answer.result?.action !== 'accept' || answer.result?.content?.confirm !== true) {
    return failure(answer.result?.action === 'cancel' ? 'CONFIRM_CANCELED' : 'CONFIRM_DECLINED');
  }
  if (account.dryRun) {
    return textResult({ ok: true, dryRun: true, data: { dryRun: true }, wouldSend: { name, args } });
  }
  record({ type: 'dispatch', name, args });
  const id = name === 'withdraw' ? 'W-1' : 'T-1';
  return textResult({ ok: true, id, status: 'pending', data: { id, status: 'pending' } });
}

async function callTool(name, args) {
  record({ type: 'call', name, args });
  switch (name) {
    case 'get_safety_status':
      return textResult({
        version: '0.1.3',
        ccxtVersion: '4.5.84',
        configProblems: [],
        elicitationSupported: Boolean(hostCapabilities.elicitation),
        configPath,
        journal: path.join(HOME, '.cache/ccxt-mcp/journal'),
        unresolvedIntents: [],
        accounts: [alias],
      });
    case 'list_accounts': {
      const credentials = ['APIKEY', 'SECRET', 'PASSWORD'].filter((field) => credential(field));
      const { funds, dryRun, confirm, maxTransferValue } = account;
      const entry = {
        alias,
        exchange,
        environment: 'live',
        funds,
        dryRun,
        confirm,
        maxTransferValue,
        credentials,
      };
      return textResult({ accounts: [entry] });
    }
    case 'get_balance':
      return textResult({ USDT: { free: 1000, used: 0, total: 1000 } });
    case 'call_implicit_get': {
      const data = fixture(name, args);
      return data === undefined ? implicitGet(args) : envelope(data);
    }
    case 'call_read_method': {
      const data = fixture(name, args);
      if (data !== undefined) return envelope(data);
      const delayMs = Number(args.params?.fakeDelayMs ?? 0);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return textResult({ method: args.method, rows: [] });
    }
    case 'withdraw':
    case 'transfer':
      return moneyMove(name, args);
    default:
      return textResult({ code: 'WOULD_HAVE_RUN', name }, true);
  }
}

function initialize(message) {
  hostCapabilities = message.params.capabilities ?? {};
  record({ type: 'init', caps: hostCapabilities, clientInfo: message.params.clientInfo });
  write({
    id: message.id,
    result: {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'ccxt-mcp', version: '0.1.3-fake' },
    },
  });
}

function onMessage(message) {
  if (message.method === undefined) {
    const resolve = pendingAnswers.get(message.id);
    pendingAnswers.delete(message.id);
    resolve?.(message);
    return;
  }
  switch (message.method) {
    case 'initialize':
      initialize(message);
      return;
    case 'notifications/initialized':
      return;
    case 'tools/list': {
      const tools = TOOL_NAMES.map((name) => ({ name, description: name, inputSchema: { type: 'object' } }));
      write({ id: message.id, result: { tools } });
      return;
    }
    case 'tools/call':
      callTool(message.params.name, message.params.arguments ?? {}).then((result) =>
        write({ id: message.id, result }),
      );
      return;
    case 'notifications/cancelled':
      record({ type: 'cancelled', params: message.params });
      return;
    default:
      record({ type: 'unexpected', method: message.method });
      if (message.id !== undefined) write({ id: message.id, error: { code: -32601, message: 'not found' } });
  }
}

let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  let newline;
  while ((newline = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (line.trim()) onMessage(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => {
  record({ type: 'sigterm' });
  process.exit(0);
});
