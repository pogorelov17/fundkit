// What the `fundkit` MCP server shows the host: tool definitions, instructions, user steps.

import path from 'node:path';
import { REPO_ROOT } from '../constants.mjs';
import { aliasFor, dopplerNames, needsPassphrase, normalizeExchange, ROLE_NAMES } from '../exchanges.mjs';
import { MONEY_TOOLS } from '../policy.mjs';

const objectSchema = (properties, required = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'fundkit_profiles',
    description:
      'Fundkit session profiles for moving USDT between crypto exchanges (Binance, Bybit, Gate, OKX, ' +
      'Bitget, WhiteBIT, BingX, MEXC, KuCoin), any language, e.g. "переведи 300 USDT с OKX на Bybit". ' +
      'Read-only: shows whether a session-only Doppler credential session is active, which session ' +
      'profiles are connected, and (with from/to) which exchange+role profiles a route needs. Never ' +
      'returns or accepts secret values. Read the usdt-funding skill first.',
    inputSchema: objectSchema({
      from: { type: 'string', description: 'source exchange, e.g. okx' },
      to: { type: 'string', description: 'destination exchange, e.g. bybit' },
    }),
  },
  {
    name: 'fundkit_connect',
    description:
      'Connect one session profile: a pinned ccxt-mcp server for the one account of that exchange in the ' +
      'Doppler config, in one local role. The session fetches only <EXCHANGE>_APIKEY and <EXCHANGE>_SECRET ' +
      'and gives them to that server only; OKX, Bitget and KuCoin also need their API passphrase, which ' +
      'the operator types in the private terminal (PASSPHRASE_NEEDED says where). No value is returned. ' +
      'Roles are enforced by fundkit, not by the key: deposit-only (reads on B, no money move), source ' +
      '(A: withdraw, transfer), settlement (B: transfer only). Returns the alias for fundkit_read/fundkit_write.',
    inputSchema: objectSchema({ exchange: { type: 'string' }, role: { type: 'string', enum: ROLE_NAMES } }, [
      'exchange',
      'role',
    ]),
  },
  {
    name: 'fundkit_read',
    description:
      'Call a read tool of a connected session profile (get_safety_status, list_accounts, get_balance, and ' +
      "call_read_method / call_implicit_get methods allowed for the profile's role and venue). Arguments " +
      'are passed unchanged. Refuses money moves, generic writes and get_deposit_address.',
    inputSchema: objectSchema(
      { alias: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object' } },
      ['alias', 'tool'],
    ),
  },
  {
    name: 'fundkit_write',
    description:
      'Money move on a connected source or settlement profile: withdraw (source) or transfer (source, ' +
      'settlement), only after the usdt-funding plan approval and, where the venue has one, the key check ' +
      "on that alias. No account UID is needed: fundkit trusts the operator's mapping of the profile to its " +
      "key. The server opens the host's native confirmation form for the human; nothing is sent unless the " +
      'human accepts it. Arguments are passed unchanged.',
    inputSchema: objectSchema(
      {
        alias: { type: 'string' },
        tool: { type: 'string', enum: MONEY_TOOLS },
        arguments: { type: 'object' },
      },
      ['alias', 'tool', 'arguments'],
    ),
  },
  {
    name: 'fundkit_disconnect',
    description: 'Stop a connected session profile (its server process and its credentials).',
    inputSchema: objectSchema({ alias: { type: 'string' } }, ['alias']),
  },
]);

export function serverInstructions() {
  return [
    'fundkit moves USDT between crypto exchanges with a human approving every write.',
    'For any request to move, transfer, withdraw, top up or deposit USDT between exchanges or wallets ' +
      '(in any language, e.g. "переведи 300 USDT с OKX на Bybit"), first read and follow the ' +
      `usdt-funding skill: ${path.join(REPO_ROOT, 'SKILL.md')}.`,
    'Use connected ccxt-mcp profiles first. Only for a profile the route needs that is not connected, ' +
      'call fundkit_profiles; if no session is active, offer the user the private terminal step it ' +
      'describes.',
    'Never ask for, accept or repeat a Doppler token, exchange key or API passphrase in the chat.',
  ].join(' ');
}

/** What the user does to start a session; returned with every "no session" answer. */
export const START_STEP = Object.freeze({
  userStep:
    'In a separate terminal on this machine (not in this chat), run: fundkit session   and paste the ' +
    'read-only Doppler service token there (input is hidden). Keep that terminal open: it also asks for ' +
    'the OKX, Bitget or KuCoin API passphrase when a profile needs one. Then continue here. Alternative ' +
    'for the next launch: fundkit session --passphrase okx -- claude  (or -- codex), which asks first ' +
    'and then starts the host.',
  forRealWrites:
    'add --writes --max-transfer <USD> [--max-daily <USD>] to that command; without it money-moving ' +
    'profiles are dryRun',
  never:
    'Do not ask for the token or a passphrase in the chat. If the user pastes one here anyway, do not ' +
    'use it; tell them to revoke the token in Doppler (or change the exchange API key) and create a new one.',
});

export const NAMING_HINT =
  'Doppler names: exactly <EXCHANGE>_APIKEY and <EXCHANGE>_SECRET per exchange (one account per exchange, ' +
  'every role uses it). OKX, Bitget and KuCoin API passphrases are not in Doppler: the operator types ' +
  'them in the private terminal.';

function need(exchange, role, when) {
  return {
    exchange,
    role,
    alias: aliasFor(exchange, role),
    dopplerNames: dopplerNames(exchange),
    ...(needsPassphrase(exchange) ? { passphrase: 'typed by the operator in the private terminal' } : {}),
    when,
  };
}

/** The profiles an A → B route needs, in the order they are used. */
export function routeNeeds(from, to) {
  const needs = [];
  const source = from ? normalizeExchange(from) : null;
  const destination = to ? normalizeExchange(to) : null;
  if (from && !source) needs.push({ exchange: from, error: 'unsupported exchange' });
  if (to && !destination) needs.push({ exchange: to, error: 'unsupported exchange' });
  if (source) needs.push(need(source, 'source', 'withdraws from A'));
  if (destination) {
    needs.push(need(destination, 'deposit-only', "reads B's own deposit address"));
    needs.push(
      need(destination, 'settlement', 'only if the credit must move to another B wallet (plan <PLAN-ID>-B)'),
    );
  }
  return needs;
}
