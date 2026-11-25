// What the `fundkit` MCP server shows the host: tool definitions, instructions, user steps.

import path from 'node:path';
import { REPO_ROOT } from '../constants.mjs';
import { aliasFor, credentialNames, normalizeExchange, ROLE_NAMES } from '../exchanges.mjs';

export const WRITE_TOOLS = Object.freeze(['withdraw', 'transfer']);

/** ccxt-mcp tools fundkit never forwards (SKILL.md rule 2 and the trading tier). */
export const NEVER_FORWARDED = new Set([
  'get_deposit_address',
  'call_implicit_write',
  'call_write_method',
  'create_order',
  'edit_order',
  'cancel_order',
  'cancel_all_orders',
  'set_leverage',
  'set_margin_mode',
]);

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
      'Connect one session profile (a pinned ccxt-mcp server for one exchange account and role) using ' +
      "the active Doppler session. The session fetches only that exchange+role's fixed credential names " +
      'and gives them to that server only; no value is returned. Roles: deposit-only (read-only key on ' +
      'B), source (A, withdrawal key), settlement (B, internal-transfer key). Returns the alias for ' +
      'fundkit_read/fundkit_write.',
    inputSchema: objectSchema({ exchange: { type: 'string' }, role: { type: 'string', enum: ROLE_NAMES } }, [
      'exchange',
      'role',
    ]),
  },
  {
    name: 'fundkit_read',
    description:
      'Call a read tool (get_safety_status, list_accounts, get_balance, call_read_method, ' +
      'call_implicit_get, …) of a connected session profile. Arguments are passed unchanged. Refuses ' +
      'write tools and get_deposit_address.',
    inputSchema: objectSchema(
      { alias: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object' } },
      ['alias', 'tool'],
    ),
  },
  {
    name: 'fundkit_write',
    description:
      'Money move on a connected session profile: only withdraw or transfer, only after the ' +
      "usdt-funding plan approval. The server opens the host's native confirmation form for the " +
      'human; nothing is sent unless the human accepts it. Arguments are passed unchanged.',
    inputSchema: objectSchema(
      {
        alias: { type: 'string' },
        tool: { type: 'string', enum: WRITE_TOOLS },
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
    'Never ask for, accept or repeat a Doppler token or exchange key in the chat.',
  ].join(' ');
}

/** What the user does to start a session; returned with every "no session" answer. */
export const START_STEP = Object.freeze({
  userStep:
    'In a separate terminal on this machine (not in this chat), run: fundkit session   and paste the ' +
    'read-only Doppler service token there (input is hidden). Keep that terminal open; then continue ' +
    'here. Alternative for the next launch: fundkit session -- claude  (or -- codex), which asks ' +
    'first and then starts the host.',
  forRealWrites:
    'add --writes --max-transfer <USD> [--max-daily <USD>] to that command; without it money-moving ' +
    'profiles are dryRun',
  never:
    'Do not ask for the token in the chat. If the user pastes it here anyway, do not use it; tell ' +
    'them to revoke it in Doppler and create a new one.',
});

export const NAMING_HINT =
  'Doppler names: <EXCHANGE>_<DEPOSIT|SOURCE|SETTLEMENT>_<APIKEY|SECRET|PASSWORD>; PASSWORD only for ' +
  'OKX, Bitget, KuCoin';

function need(exchange, role, when) {
  return {
    exchange,
    role,
    alias: aliasFor(exchange, role),
    dopplerNames: credentialNames(exchange, role).map((name) => name.doppler),
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
