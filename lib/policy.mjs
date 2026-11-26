// What a session profile may forward, decided by its local role, not by the exchange key.
//
// One Doppler config gives one key per exchange, and that key may be able to withdraw. The role
// is enforced here, in the session daemon that owns the credentials, on every `tools/call`:
//   * an allowlist of ccxt-mcp tools per role, and for the generic surfaces
//     (`call_read_method`, `call_implicit_get`) an allowlist of methods per venue and purpose;
//   * `call_write_method`, `call_implicit_write`, `get_deposit_address` and the trading tier are
//     never forwarded, on any role;
//   * account-bound reads (recipient and provisioning reads) need this profile's key check first,
//     and every money move needs the caller to name the exact account UID that key check showed.

import { exchangeLabel } from './exchanges.mjs';

/** Raw endpoints (`call_implicit_get`) per venue, grouped by what they are for. */
const IMPLICIT_ENDPOINTS = Object.freeze({
  binance: {
    keyCheck: ['sapiGetAccountApiRestrictions', 'privateGetAccount'],
    recipient: ['sapiGetCapitalDepositAddressList'],
    whitelist: ['sapiGetCapitalWithdrawAddressList'],
  },
  bybit: {
    keyCheck: ['privateGetV5UserQueryApi'],
    recipient: ['privateGetV5AssetDepositQueryAddress'],
  },
  okx: {
    keyCheck: ['privateGetAccountConfig'],
    network: ['privateGetAssetCurrencies'],
    recipient: ['privateGetAssetDepositAddress'],
  },
  bitget: {
    keyCheck: ['privateSpotGetV2SpotAccountInfo'],
    recipient: ['privateSpotGetV2SpotWalletDepositAddress'],
  },
  bingx: {
    keyCheck: ['accountV1PrivateGetAccountApiPermissions', 'accountV1PrivateGetUid'],
    recipient: ['walletsV1PrivateGetCapitalDepositAddress'],
  },
  mexc: {
    keyCheck: ['spotPrivateGetAccount', 'spotPrivateGetUid'],
    recipient: ['spotPrivateGetCapitalDepositAddress'],
  },
  kucoin: {
    keyCheck: ['privateGetUserApiKey'],
    network: ['publicGetCurrenciesCurrency'],
    recipient: ['privateGetDepositAddresses'],
  },
  gate: {
    keyCheck: ['privateAccountGetDetail'],
    network: ['publicWalletGetCurrencyChains', 'privateWalletGetWithdrawStatus'],
    provisioning: ['privateWalletGetDepositAddress'],
    transferProof: ['privateWalletGetTransfers'],
    whitelist: ['privateWalletGetSavedAddress'],
  },
  whitebit: {
    network: ['v4PublicGetAssets', 'v4PublicGetFee'],
  },
});

/** Unified methods (`call_read_method`), grouped the same way. */
const READ_METHODS = Object.freeze({
  common: ['fetchBalance', 'fetchDepositWithdrawFee', 'fetchAccounts', 'fetchDeposits'],
  recipient: ['fetchDepositAddress', 'fetchDepositAddressesByNetwork'],
  history: ['fetchWithdrawals', 'fetchTransfers', 'fetchTransfer', 'fetchLedger'],
  settlementHistory: ['fetchTransfers', 'fetchTransfer', 'fetchLedger'],
});

/** Address reads that the venue documents as able to create an address. */
const PROVISIONING_READ_METHODS = Object.freeze({
  gate: ['fetchDepositAddress'],
  whitebit: ['fetchDepositAddress'],
});

/** Where the account UID is in each venue's key check (references/recipients.md). */
const UID_SOURCES = Object.freeze({
  binance: { method: 'privateGetAccount', field: 'uid' },
  bybit: { method: 'privateGetV5UserQueryApi', field: 'userID' },
  okx: { method: 'privateGetAccountConfig', field: 'uid' },
  bitget: { method: 'privateSpotGetV2SpotAccountInfo', field: 'userId' },
  bingx: { method: 'accountV1PrivateGetUid', field: 'uid' },
  mexc: { method: 'spotPrivateGetUid', field: 'uid' },
  kucoin: { method: 'privateGetUserApiKey', field: 'uid' },
  gate: { method: 'privateAccountGetDetail', field: 'user_id' },
  whitebit: null,
});

const STATE_TOOLS = new Set(['get_safety_status', 'list_accounts', 'get_balance']);
const METADATA_TOOLS = new Set(['list_exchanges', 'describe_exchange', 'describe_method']);
const GENERIC_READ_TOOLS = new Set(['call_read_method', 'call_implicit_get']);
export const MONEY_TOOLS = Object.freeze(['withdraw', 'transfer']);

/** Never forwarded on any role (SKILL.md rule 2: no create fallback, no trading, no generic writes). */
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

/** What each local role may do. Purposes name the groups above. */
const ROLE_POLICIES = Object.freeze({
  'deposit-only': {
    moneyTools: [],
    readMethodGroups: ['common', 'recipient'],
    implicitPurposes: ['keyCheck', 'network', 'recipient', 'provisioning'],
    summary: "Step 0, key check, network data, B's own recipient read and deposit history; no money move",
  },
  settlement: {
    moneyTools: ['transfer'],
    readMethodGroups: ['common', 'settlementHistory'],
    implicitPurposes: ['keyCheck', 'network', 'transferProof'],
    summary: 'reads plus internal transfer on this account after approval; no withdrawal, no recipient read',
  },
  source: {
    moneyTools: ['withdraw', 'transfer'],
    readMethodGroups: ['common', 'history'],
    implicitPurposes: ['keyCheck', 'network', 'transferProof', 'whitelist'],
    summary: 'reads plus withdraw and internal transfer on this account after approval; no recipient read',
  },
});

const allow = (purpose, extra = {}) => ({ allowed: true, purpose, ...extra });
const deny = (code, message) => ({ allowed: false, code, message });

function implicitPurpose(exchange, method) {
  const endpoints = IMPLICIT_ENDPOINTS[exchange] ?? {};
  return Object.keys(endpoints).find((purpose) => endpoints[purpose].includes(method)) ?? null;
}

function readMethodPurpose(exchange, role, method) {
  if (PROVISIONING_READ_METHODS[exchange]?.includes(method)) return 'provisioning';
  const groups = ROLE_POLICIES[role].readMethodGroups;
  const group = groups.find((name) => READ_METHODS[name].includes(method));
  if (group) return group === 'recipient' ? 'recipient' : 'read';
  return null;
}

function roleDenied(profile, what) {
  const { alias, role } = profile;
  return deny(
    'ROLE_DENIED',
    `${alias} is a ${role} profile: fundkit does not forward ${what} on it (${ROLE_POLICIES[role].summary}). ` +
      'The exchange key itself may allow more; the local role decides what is forwarded.',
  );
}

function checkTarget(profile, args) {
  if (args.account !== undefined && args.account !== profile.alias) {
    return deny('WRONG_ACCOUNT', `arguments.account must be "${profile.alias}" on this profile`);
  }
  if (args.exchange !== undefined && args.exchange !== profile.exchange) {
    return deny('WRONG_EXCHANGE', `arguments.exchange must be "${profile.exchange}" on this profile`);
  }
  return null;
}

/**
 * Decide one `tools/call` on a session profile.
 *
 * @param {object} request
 * @param {{alias: string, exchange: string, role: string}} request.profile
 * @param {'read'|'write'} request.channel     fundkit_read or fundkit_write
 * @param {string} request.tool                ccxt-mcp tool name
 * @param {object} request.args                ccxt-mcp arguments
 * @param {string|undefined} request.expectedUid  UID the caller names for a money move
 * @param {{uid: string|null, conflict: boolean}} request.identity  what this profile's key check showed
 * @param {Set<string>} request.provisioning   exchanges the operator allowed provisioning reads for
 * @returns {{allowed: true, purpose: string, capturesUid?: string}|{allowed: false, code: string, message: string}}
 */
export function authorizeCall({ profile, channel, tool, args, expectedUid, identity, provisioning }) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return deny('BAD_ARGUMENTS', 'arguments must be an object');
  }
  if (NEVER_FORWARDED.has(tool)) return deny('NOT_FORWARDED', `${tool} is never called by fundkit`);

  const isMoneyTool = MONEY_TOOLS.includes(tool);
  if (channel === 'write' && !isMoneyTool) {
    return deny('NOT_FORWARDED', 'fundkit_write forwards only withdraw and transfer');
  }
  if (channel === 'read' && isMoneyTool) {
    return deny('NOT_FORWARDED', `${tool} is a money move: use fundkit_write after approval`);
  }

  const targetProblem = checkTarget(profile, args);
  if (targetProblem) return targetProblem;

  if (isMoneyTool) return authorizeMoneyMove(profile, tool, args, expectedUid, identity);
  if (STATE_TOOLS.has(tool)) return allow('state');
  if (METADATA_TOOLS.has(tool)) return allow('metadata');
  if (!GENERIC_READ_TOOLS.has(tool)) return roleDenied(profile, `the tool ${tool}`);
  return authorizeGenericRead(profile, tool, args, identity, provisioning);
}

function authorizeMoneyMove(profile, tool, args, expectedUid, identity) {
  const { alias, exchange, role } = profile;
  if (!ROLE_POLICIES[role].moneyTools.includes(tool)) return roleDenied(profile, tool);
  if (args.account !== alias) return deny('WRONG_ACCOUNT', `arguments.account must be "${alias}"`);
  if (!UID_SOURCES[exchange]) {
    return deny(
      'UID_NOT_VERIFIABLE',
      `${exchangeLabel(exchange)} has no key read, so fundkit cannot bind this key to an account UID; ` +
        'it forwards no money move on this venue. Use the exchange UI (manual sheet).',
    );
  }
  const identityProblem = checkIdentity(profile, identity);
  if (identityProblem) return identityProblem;
  if (typeof expectedUid !== 'string' || expectedUid.length === 0) {
    return deny('UID_REQUIRED', `name the account UID from the setup record as "uid" for this ${tool}`);
  }
  if (expectedUid !== identity.uid) {
    return deny(
      'UID_MISMATCH',
      `${alias}'s key check shows UID ${identity.uid}, not ${expectedUid}: this is not the recorded account; stop`,
    );
  }
  return allow('money');
}

function checkIdentity({ alias, exchange }, identity) {
  if (identity.conflict) {
    return deny(
      'ACCOUNT_CONFLICT',
      `two ${exchange} profiles of this session showed different UIDs; one Doppler config is one ` +
        `account per exchange, so fundkit holds every account-bound call on ${exchange}`,
    );
  }
  if (!identity.uid) {
    const source = UID_SOURCES[exchange];
    return deny(
      'KEY_CHECK_REQUIRED',
      `run the ${exchangeLabel(exchange)} key check on ${alias} first: call_implicit_get ` +
        `{"exchange":"${exchange}","account":"${alias}","method":"${source.method}"}`,
    );
  }
  return null;
}

function authorizeGenericRead(profile, tool, args, identity, provisioning) {
  const { exchange, role } = profile;
  const method = String(args.method ?? '');
  if (!method) return deny('BAD_ARGUMENTS', `${tool} needs arguments.method`);
  if (args.exchange === undefined) return deny('BAD_ARGUMENTS', `${tool} needs arguments.exchange`);

  const purpose =
    tool === 'call_implicit_get'
      ? implicitPurpose(exchange, method)
      : readMethodPurpose(exchange, role, method);
  if (!purpose) return roleDenied(profile, `${tool} ${method}`);

  const allowedPurposes =
    tool === 'call_implicit_get'
      ? ROLE_POLICIES[role].implicitPurposes
      : ['read', 'recipient', 'provisioning'];
  if (!allowedPurposes.includes(purpose)) return roleDenied(profile, `${tool} ${method}`);
  if (purpose === 'provisioning' && role !== 'deposit-only') return roleDenied(profile, `${tool} ${method}`);

  if (purpose === 'provisioning' && !provisioning.has(exchange)) {
    return deny(
      'PROVISIONING_NOT_AUTHORIZED',
      `${exchangeLabel(exchange)}'s address read may create an address. The operator allows it for this ` +
        `session only by starting it with --allow-provisioning ${exchange} (and the setup record line)`,
    );
  }
  const accountBound = purpose === 'recipient' || purpose === 'provisioning';
  if (accountBound && UID_SOURCES[exchange]) {
    const identityProblem = checkIdentity(profile, identity);
    if (identityProblem) return identityProblem;
  }
  const uidSource = UID_SOURCES[exchange];
  const capturesUid =
    tool === 'call_implicit_get' && uidSource?.method === method ? uidSource.field : undefined;
  return allow(purpose, capturesUid ? { capturesUid } : {});
}

function collectField(value, field, found) {
  if (Array.isArray(value)) {
    for (const item of value) collectField(item, field, found);
  } else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (key === field && (typeof inner === 'string' || typeof inner === 'number') && String(inner) !== '') {
        found.add(String(inner));
      } else {
        collectField(inner, field, found);
      }
    }
  }
}

/**
 * The account UID in a successful key-check tool result, or null when the result is an error,
 * has no such field, or names more than one distinct value.
 */
export function extractUid(result, field) {
  if (!result || result.isError) return null;
  const text = result.content?.find((part) => part.type === 'text')?.text;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const found = new Set();
  collectField(body, field, found);
  return found.size === 1 ? [...found][0] : null;
}

/** A plain-language summary of a role, returned when a profile connects. */
export function describeRole(role) {
  const policy = ROLE_POLICIES[role];
  return { forwards: policy.summary, moneyTools: [...policy.moneyTools] };
}

/** Venue restrictions the agent must surface to the user (references/recipients.md). */
export function venueScopeNotes(exchange) {
  const notes = [];
  if (!UID_SOURCES[exchange]) {
    notes.push(
      `${exchangeLabel(exchange)} has no key read: account identity and key rights come only from the ` +
        'setup record, and fundkit forwards no withdraw or transfer on it.',
    );
  } else {
    const { method, field } = UID_SOURCES[exchange];
    notes.push(`UID binding: ${method} field ${field}; money moves name that UID as "uid".`);
  }
  if (exchange === 'gate' || exchange === 'mexc') {
    notes.push(
      `${exchangeLabel(exchange)}'s key read shows no key permissions: the rights come from the setup record.`,
    );
  }
  if (PROVISIONING_READ_METHODS[exchange]) {
    notes.push(
      `The ${exchangeLabel(exchange)} address read may create an address: forwarded only with ` +
        `--allow-provisioning ${exchange} on the session.`,
    );
  }
  if (exchange === 'bitget' || exchange === 'kucoin') notes.push('Classic accounts only; UTA holds.');
  return notes;
}
