// What the `fundkit` MCP server shows the host: tool definitions, instructions, user steps.

import path from 'node:path';
import { REPO_ROOT } from '../constants.mjs';
import { aliasFor, dopplerNames, needsPassphrase, normalizeExchange, ROLE_NAMES } from '../exchanges.mjs';
import { MONEY_TOOLS } from '../policy.mjs';
import { COINS } from '../venues/networks.mjs';

const objectSchema = (properties, required = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'fundkit_deposit_address',
    description:
      "The user's own verified USDT or USDC deposit address on an exchange; the request may be in any " +
      'language, e.g. "Show my Binance USDT deposit address on BSC". USDT: TRC20, BEP20, ERC20, TON; ' +
      'USDC: BEP20, ERC20 only. Reads the address, exact coin, network and memo from ' +
      'the account itself and returns a locally generated QR image that was decoded back to the exact ' +
      'address. Native: Binance, Bybit. Without a session it returns one secretStep; do it, then call ' +
      'this tool again with the same arguments. Read-only: nothing is sent.',
    inputSchema: objectSchema(
      {
        exchange: { type: 'string', description: 'e.g. binance' },
        network: { type: 'string', description: 'BSC/BEP20, TRC20, ERC20 or TON, as the user said it' },
        coin: { type: 'string', enum: COINS, description: 'USDT (default) or USDC, as the user said it' },
      },
      ['exchange', 'network'],
    ),
  },
  {
    name: 'fundkit_transfer_prepare',
    description:
      "Prepare a USDT or USDC withdrawal from one of the user's exchanges to their own account on another, " +
      'e.g. "Move 300 USDT from Bybit to Binance". Reads both ends live for that coin (balance, network, fee, minimums, ' +
      'limits, and the recipient from the destination account itself) and returns a plan bound to exact ' +
      'fields with an expiry (including the destination minimum and its basis), or a hold with the exact ' +
      'reason. Sends nothing. Native: Binance, Bybit.',
    inputSchema: objectSchema(
      {
        from: { type: 'string' },
        to: { type: 'string' },
        amount: { type: 'string', description: 'decimal amount of the coin, e.g. "300"' },
        network: {
          type: 'string',
          description: 'optional; the cheapest network valid on both ends otherwise',
        },
        coin: { type: 'string', enum: COINS, description: 'USDT (default) or USDC, as the user said it' },
      },
      ['from', 'to', 'amount'],
    ),
  },
  {
    name: 'fundkit_transfer_confirm',
    description:
      'Execute one prepared plan: opens exactly one confirmation card with every plan field; the human ' +
      'approves or declines there and only approval sends the one withdrawal. A plan is sent at most once, ' +
      'whatever is repeated or restarted. Never answer the card yourself.',
    inputSchema: objectSchema({ planId: { type: 'string' } }, ['planId']),
  },
  {
    name: 'fundkit_transfer_status',
    description: 'Read-only: a plan, whether its dispatch was attempted, and its recorded outcome.',
    inputSchema: objectSchema({ planId: { type: 'string' } }, ['planId']),
  },
  {
    name: 'fundkit_profiles',
    description:
      'Fundkit session profiles for moving USDT between crypto exchanges (Binance, Bybit, Gate, OKX, ' +
      'Bitget, WhiteBIT, BingX, MEXC, KuCoin), any language, e.g. "move 300 USDT from OKX to Bybit". ' +
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
    'fundkit moves USDT between crypto exchanges with a human approving every write; its native ' +
      'address and transfer tools also take USDC (BEP20, ERC20) on Binance and Bybit.',
    'For any request to move, transfer, withdraw, top up or deposit USDT between exchanges or wallets ' +
      '(in any language, e.g. "move 300 USDT from OKX to Bybit"), first read and follow the ' +
      `usdt-funding skill: ${path.join(REPO_ROOT, 'SKILL.md')}.`,
    'For "my deposit address" use fundkit_deposit_address; for a transfer between two of the user\'s ' +
      'exchanges use fundkit_transfer_prepare, then fundkit_transfer_confirm (one confirmation card).',
    "Reply in the user's language. The confirmation card is fixed English, so show the plan in the " +
      "user's language in the chat before it opens.",
    'When a result has secretStep and you have a private secret card tool with file delivery (T3 Code: ' +
      'request_secret with delivery "file"), open exactly that one card, run the given command with the ' +
      'returned path, then repeat the same call (resume) in the same turn, without asking the user ' +
      'anything. Without such a tool, say so and use the alternative the result names.',
    'Use already configured ccxt-mcp profiles first; never push Doppler on a user who has them.',
    'Never ask for, accept or repeat a Doppler token, exchange key or API passphrase in the chat, and ' +
      'never read the secret file.',
  ].join(' ');
}

/** What the user does to start a session; returned with every "no session" answer. */
export const START_STEP = Object.freeze({
  userStep:
    'Only on a host without a private secret card (secretStep cannot be done): in a separate terminal on ' +
    'this machine (not in this chat), run: fundkit session   and paste the ' +
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
