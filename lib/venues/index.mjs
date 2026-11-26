// Native venue adapters: the exact reads behind fundkit_deposit_address and the transfer tools.
//
// Each adapter works through `read(tool, args)`, which calls one ccxt-mcp tool on a session
// profile (the session daemon still decides every call by the profile's role) and returns the
// envelope's `data`. Every check that fails throws a hold: an error with `hold: true`, a code
// and the exact reason. Nothing here guesses a field, derives one from another, or asks the
// user to look anything up. Rules and field meanings: references/recipients.md and
// references/exchanges.md.

import { codedError } from '../util.mjs';
import { NETWORKS, addressShapeOk, contractSuffixMatches, sameContract } from './networks.mjs';
import { parseDecimal, stepFromDecimals } from './decimal.mjs';

export function hold(code, detail, extra = {}) {
  return codedError(code, detail, { hold: true, ...extra });
}

function memoValue(raw, { field, venue }) {
  if (raw === undefined) {
    throw hold('MEMO_FIELD_MISSING', `${venue} returned no ${field} field; the response is incomplete`);
  }
  if (typeof raw !== 'string') throw hold('MEMO_FIELD_INVALID', `${venue} ${field} is not a string`);
  if (raw.length > 0 && raw.trim().length === 0) {
    throw hold('MEMO_FIELD_INVALID', `${venue} ${field} is whitespace`);
  }
  return raw === '' ? null : raw;
}

function checkAddress(network, address, venue) {
  if (!addressShapeOk(network, address)) {
    throw hold('ADDRESS_INVALID', `${venue} returned an address that is not a ${network.label} address`);
  }
  if (sameContract(network, address)) {
    throw hold('ADDRESS_IS_CONTRACT', `${venue} returned the USDT token contract, not a deposit address`);
  }
}

function only(rows, what) {
  if (rows.length === 0) throw hold('NO_ROW', `no ${what}`);
  if (rows.length > 1) {
    throw hold('AMBIGUOUS_ROWS', `${rows.length} rows for ${what}; exactly one is required`);
  }
  return rows[0];
}

// ---------------------------------------------------------------------------------- Binance

const binance = {
  exchange: 'binance',
  label: 'Binance',
  supportedNetworks: ['TRC20', 'BEP20', 'ERC20', 'TON'],
  depositFee: {
    value: '0',
    source: 'https://www.binance.com/en/fee/cryptoFee ("Binance does not charge deposit fees.")',
  },

  async keyCheck(read, alias) {
    const data = await read('call_implicit_get', {
      exchange: 'binance',
      account: alias,
      method: 'sapiGetAccountApiRestrictions',
    });
    if (data?.enableReading !== true) {
      throw hold('KEY_CANNOT_READ', 'the Binance key check shows enableReading is not true');
    }
    return {
      method: 'sapiGetAccountApiRestrictions',
      rights: {
        enableReading: data.enableReading,
        enableWithdrawals: data.enableWithdrawals ?? null,
        enableInternalTransfer: data.enableInternalTransfer ?? null,
        ipRestrict: data.ipRestrict ?? null,
      },
    };
  },

  /** Whether the key check shows the right a withdrawal needs (the exchange refuses it otherwise). */
  canWithdraw(keyFacts) {
    return keyFacts?.rights?.enableWithdrawals === true;
  },

  async networkRow(read, alias, network) {
    const data = await read('call_read_method', {
      exchange: 'binance',
      account: alias,
      method: 'fetchDepositWithdrawFee',
      args: ['USDT'],
      includeInfo: true,
    });
    const rows = (data?.info?.networkList ?? []).filter((row) => row?.network === network.ids.binance);
    const row = only(rows, `Binance USDT network ${network.ids.binance} in networkList`);
    if (!sameContract(network, row.contractAddress)) {
      throw hold(
        'CONTRACT_MISMATCH',
        `Binance ${network.ids.binance} contract is not the USDT ${network.label} contract`,
      );
    }
    return row;
  },

  async recipient(read, alias, network) {
    const row = await this.networkRow(read, alias, network);
    if (row.depositEnable !== true) {
      throw hold('DEPOSIT_DISABLED', `Binance has USDT deposits on ${network.ids.binance} disabled now`);
    }
    const gated = await read('call_read_method', {
      exchange: 'binance',
      account: alias,
      method: 'fetchDepositAddress',
      args: ['USDT'],
      params: { network: network.code },
      includeInfo: true,
    });
    if (gated?.network !== network.code) {
      throw hold(
        'WRONG_CHAIN',
        `Binance answered for network ${gated?.network ?? 'none'}, not ${network.code}`,
      );
    }
    const raw = await read('call_implicit_get', {
      exchange: 'binance',
      account: alias,
      method: 'sapiGetCapitalDepositAddressList',
      params: { coin: 'USDT', network: network.ids.binance },
    });
    if (!Array.isArray(raw)) throw hold('BAD_RESPONSE', 'Binance address list is not a list');
    const current = only(
      raw.filter((entry) => entry?.isDefault === 1),
      'default Binance deposit address (isDefault: 1)',
    );
    const memo = memoValue(current.tag, { field: 'tag', venue: 'Binance' });
    checkAddress(network, current.address, 'Binance');
    if (current.address !== gated.info?.address || (current.tag ?? null) !== (gated.info?.tag ?? null)) {
      throw hold('READS_DISAGREE', 'Binance gated and raw address reads disagree');
    }
    return {
      address: current.address,
      memo,
      venueNetwork: network.ids.binance,
      reads: ['fetchDepositWithdrawFee', 'fetchDepositAddress', 'sapiGetCapitalDepositAddressList'],
      lands: 'Spot (Binance typical; the response names no wallet)',
    };
  },

  async destination(read, alias, network) {
    const row = await this.networkRow(read, alias, network);
    if (row.depositEnable !== true) {
      throw hold('DEPOSIT_DISABLED', `Binance has USDT deposits on ${network.ids.binance} disabled now`);
    }
    return {
      depositEnabled: true,
      depositFee: this.depositFee,
      depositMin: null,
      depositMinReason:
        'Binance documents no API deposit minimum (depositDust has no documented meaning), so fundkit ' +
        'cannot confirm the credit clears it',
      inboundCap: null,
    };
  },

  async source(read, alias, network) {
    const row = await this.networkRow(read, alias, network);
    if (row.withdrawEnable !== true) {
      throw hold('WITHDRAW_DISABLED', `Binance has USDT withdrawals on ${network.ids.binance} disabled now`);
    }
    const fee = parseDecimal(row.withdrawFee);
    const min = parseDecimal(row.withdrawMin);
    const max = parseDecimal(row.withdrawMax);
    const step = parseDecimal(row.withdrawIntegerMultiple);
    if (fee === null || min === null || step === null || step === 0n) {
      throw hold(
        'SOURCE_FIELDS',
        'Binance withdrawFee, withdrawMin or withdrawIntegerMultiple is missing or not exact',
      );
    }
    const wallets = [];
    for (const [wallet, walletType] of [
      ['spot', 0],
      ['funding', 1],
    ]) {
      let free = null;
      try {
        const balance = await read('call_read_method', {
          exchange: 'binance',
          account: alias,
          method: 'fetchBalance',
          params: { type: wallet },
        });
        free = parseDecimal(balance?.USDT?.free ?? 0);
      } catch {
        // An unreadable wallet is reported as such and never chosen.
      }
      wallets.push({ wallet, walletType, free });
    }
    return {
      fee,
      feeAsset: 'USDT',
      feeModel: 'unconfirmed',
      min,
      max,
      step,
      wallets,
      fields: 'networkList withdrawEnable, withdrawFee, withdrawMin, withdrawMax, withdrawIntegerMultiple',
    };
  },

  withdrawArgs({ alias, amount, recipient, network, wallet }) {
    return {
      account: alias,
      code: 'USDT',
      amount,
      address: recipient.address,
      ...(recipient.memo ? { tag: recipient.memo } : {}),
      network: network.code,
      params: { walletType: wallet.walletType },
    };
  },
};

// ---------------------------------------------------------------------------------- Bybit

const bybit = {
  exchange: 'bybit',
  label: 'Bybit',
  supportedNetworks: ['TRC20', 'BEP20', 'ERC20', 'TON'],
  depositFee: {
    value: '0',
    source:
      'https://www.bybit.com/en/help-center/article/Bybit-Fees-You-Need-to-Know (no fee on on-chain deposits)',
  },

  async keyCheck(read, alias) {
    const data = await read('call_implicit_get', {
      exchange: 'bybit',
      account: alias,
      method: 'privateGetV5UserQueryApi',
    });
    if (data?.retCode !== 0 || !data.result) {
      throw hold('KEY_CHECK_FAILED', `Bybit key check answered retCode ${data?.retCode}`);
    }
    const { readOnly, permissions, isMaster, ips } = data.result;
    return { method: 'privateGetV5UserQueryApi', rights: { readOnly, permissions, isMaster, ips } };
  },

  canWithdraw(keyFacts) {
    const wallet = keyFacts?.rights?.permissions?.Wallet;
    return keyFacts?.rights?.readOnly === 0 && Array.isArray(wallet) && wallet.includes('Withdraw');
  },

  async coinInfo(read, alias, network) {
    const data = await read('call_read_method', {
      exchange: 'bybit',
      account: alias,
      method: 'fetchDepositWithdrawFee',
      args: ['USDT'],
      includeInfo: true,
    });
    const info = data?.info;
    const row = only(
      (info?.chains ?? []).filter((chain) => chain?.chain === network.ids.bybit),
      `Bybit USDT chain ${network.ids.bybit} in coin info`,
    );
    if (!sameContract(network, row.contractAddress)) {
      throw hold(
        'CONTRACT_MISMATCH',
        `Bybit ${network.ids.bybit} contract is not the USDT ${network.label} contract`,
      );
    }
    return { info, row };
  },

  async recipient(read, alias, network, keyFacts) {
    if (keyFacts?.rights?.isMaster !== true) {
      throw hold(
        'KEY_NOT_MAIN_ACCOUNT',
        'Bybit gives deposit addresses only to main-account keys (isMaster is not true)',
      );
    }
    const { row } = await this.coinInfo(read, alias, network);
    if (String(row.chainDeposit) !== '1') {
      throw hold('DEPOSIT_DISABLED', `Bybit has USDT deposits on ${network.ids.bybit} suspended now`);
    }
    const gated = await read('call_read_method', {
      exchange: 'bybit',
      account: alias,
      method: 'fetchDepositAddressesByNetwork',
      args: ['USDT'],
      params: { network: network.code },
      includeInfo: true,
    });
    const keys = Object.keys(gated ?? {});
    if (keys.length !== 1 || keys[0] !== network.code) {
      throw hold('WRONG_CHAIN', `Bybit answered for ${keys.join(', ') || 'no network'}, not ${network.code}`);
    }
    const info = gated[network.code].info ?? {};
    const raw = await read('call_implicit_get', {
      exchange: 'bybit',
      account: alias,
      method: 'privateGetV5AssetDepositQueryAddress',
      params: { coin: 'USDT', chainType: info.chain },
    });
    if (raw?.retCode !== 0 || raw.result?.coin !== 'USDT') {
      throw hold('BAD_RESPONSE', 'Bybit address response is not USDT or retCode is not 0');
    }
    const entry = only(raw.result.chains ?? [], `Bybit USDT address on ${network.ids.bybit}`);
    if (entry.chain !== network.ids.bybit) {
      throw hold('WRONG_CHAIN', `Bybit raw row is for ${entry.chain}, not ${network.ids.bybit}`);
    }
    for (const field of ['chain', 'addressDeposit', 'tagDeposit', 'contractAddress']) {
      if (entry[field] !== info[field]) {
        throw hold('READS_DISAGREE', `Bybit gated and raw reads disagree on ${field}`);
      }
    }
    if (!contractSuffixMatches(network, entry.contractAddress)) {
      throw hold(
        'CONTRACT_MISMATCH',
        `Bybit address row contract suffix does not end the USDT ${network.label} contract`,
      );
    }
    const memo = memoValue(entry.tagDeposit, { field: 'tagDeposit', venue: 'Bybit' });
    checkAddress(network, entry.addressDeposit, 'Bybit');
    return {
      address: entry.addressDeposit,
      memo,
      venueNetwork: network.ids.bybit,
      batchReleaseLimit: entry.batchReleaseLimit,
      reads: [
        'fetchDepositWithdrawFee',
        'fetchDepositAddressesByNetwork',
        'privateGetV5AssetDepositQueryAddress',
      ],
      lands: 'Funding (Bybit)',
    };
  },

  async destination(read, alias, network, recipient) {
    const { row } = await this.coinInfo(read, alias, network);
    if (String(row.chainDeposit) !== '1') {
      throw hold('DEPOSIT_DISABLED', `Bybit has USDT deposits on ${network.ids.bybit} suspended now`);
    }
    const min = parseDecimal(row.depositMin);
    if (min === null) {
      throw hold('DESTINATION_MINIMUM_UNREADABLE', 'Bybit depositMin is missing or not exact');
    }
    if (recipient?.batchReleaseLimit !== '-1') {
      throw hold(
        'INBOUND_CAP',
        `Bybit caps credited deposits on ${network.ids.bybit} (batchReleaseLimit ${JSON.stringify(recipient?.batchReleaseLimit)}); ` +
          'the remaining allowance is not readable, so no transfer is planned',
      );
    }
    return {
      depositEnabled: true,
      depositFee: this.depositFee,
      depositMin: min,
      inboundCap: 'unlimited (-1)',
    };
  },

  async source(read, alias, network) {
    const { info, row } = await this.coinInfo(read, alias, network);
    if (String(row.chainWithdraw) !== '1') {
      throw hold('WITHDRAW_DISABLED', `Bybit has USDT withdrawals on ${network.ids.bybit} suspended now`);
    }
    const percentage = parseDecimal(row.withdrawPercentageFee ?? '0');
    if (percentage === null || percentage !== 0n) {
      throw hold(
        'FEE_NOT_EXACT',
        'Bybit charges a percentage withdrawal fee on this chain, so the fee is not exact',
      );
    }
    const fee = parseDecimal(row.withdrawFee);
    const min = parseDecimal(row.withdrawMin);
    const max = parseDecimal(info?.remainAmount);
    const step = stepFromDecimals(row.minAccuracy);
    if (fee === null || min === null || step === null) {
      throw hold('SOURCE_FIELDS', 'Bybit withdrawFee, withdrawMin or minAccuracy is missing or not exact');
    }
    const balance = await read('call_read_method', {
      exchange: 'bybit',
      account: alias,
      method: 'fetchBalance',
      params: { type: 'funding' },
    });
    return {
      fee,
      feeAsset: 'USDT',
      feeModel: 'on top',
      min,
      max,
      step,
      wallets: [{ wallet: 'funding', accountType: 'FUND', free: parseDecimal(balance?.USDT?.free ?? 0) }],
      fields:
        'coin info chains[] chainWithdraw, withdrawFee, withdrawPercentageFee, withdrawMin, minAccuracy; remainAmount',
    };
  },

  withdrawArgs({ alias, amount, recipient, network, wallet }) {
    return {
      account: alias,
      code: 'USDT',
      amount,
      address: recipient.address,
      ...(recipient.memo ? { tag: recipient.memo } : {}),
      network: network.code,
      params: { accountType: wallet.accountType },
    };
  },
};

export const NATIVE_VENUES = Object.freeze({ binance, bybit });

export function nativeVenue(exchange) {
  return NATIVE_VENUES[exchange] ?? null;
}

export { NETWORKS };
