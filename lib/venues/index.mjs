// Native venue adapters: the exact reads behind fundkit_deposit_address and the transfer tools.
//
// Each adapter works through `read(tool, args)`, which calls one ccxt-mcp tool on a session
// profile (the session daemon still decides every call by the profile's role) and returns the
// envelope's `data`. Every check that fails throws a hold: an error with `hold: true`, a code
// and the exact reason. Nothing here guesses a field, derives one from another, or asks the
// user to look anything up. Rules and field meanings: references/recipients.md and
// references/exchanges.md.
//
// `token` is a chain with one coin's reference contract (networks.mjs `tokenOn`): every request,
// contract check, balance, fee asset and withdrawal below uses `token.coin`, never a default.

import {
  NETWORKS,
  addressShapeOk,
  contractSuffixMatches,
  isTokenContract,
  sameContract,
} from './networks.mjs';
import { parseDecimal, stepFromDecimals } from './decimal.mjs';
import { hold } from './hold.mjs';
import { resolveMinimum } from './minimum.mjs';

export { hold };

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

function checkAddress(token, address, venue) {
  if (!addressShapeOk(token, address)) {
    throw hold('ADDRESS_INVALID', `${venue} returned an address that is not a ${token.label} address`);
  }
  if (isTokenContract(token.code, address)) {
    throw hold('ADDRESS_IS_CONTRACT', `${venue} returned a token contract, not a deposit address`);
  }
}

/** The free balance of the token's coin in a fetchBalance answer (absent: 0), in units. */
function freeOf(balance, coin) {
  return parseDecimal(balance?.[coin]?.free ?? 0);
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

  async networkRow(read, alias, token) {
    const data = await read('call_read_method', {
      exchange: 'binance',
      account: alias,
      method: 'fetchDepositWithdrawFee',
      args: [token.coin],
      includeInfo: true,
    });
    if (data?.info?.coin !== token.coin) {
      throw hold(
        'BAD_RESPONSE',
        `the Binance network list is for ${data?.info?.coin ?? 'no coin'}, not ${token.coin}`,
      );
    }
    const rows = (data?.info?.networkList ?? []).filter((row) => row?.network === token.ids.binance);
    const row = only(rows, `Binance ${token.coin} network ${token.ids.binance} in networkList`);
    if (row.coin !== undefined && row.coin !== token.coin) {
      throw hold(
        'BAD_RESPONSE',
        `the Binance ${token.ids.binance} row is for ${row.coin}, not ${token.coin}`,
      );
    }
    if (!sameContract(token, row.contractAddress)) {
      throw hold(
        'CONTRACT_MISMATCH',
        `Binance ${token.ids.binance} contract is not the ${token.coin} ${token.label} contract`,
      );
    }
    return { row };
  },

  async recipient(read, alias, token) {
    const { row } = await this.networkRow(read, alias, token);
    if (row.depositEnable !== true) {
      throw hold(
        'DEPOSIT_DISABLED',
        `Binance has ${token.coin} deposits on ${token.ids.binance} disabled now`,
      );
    }
    const gated = await read('call_read_method', {
      exchange: 'binance',
      account: alias,
      method: 'fetchDepositAddress',
      args: [token.coin],
      params: { network: token.code },
      includeInfo: true,
    });
    if (gated?.network !== token.code) {
      throw hold(
        'WRONG_CHAIN',
        `Binance answered for network ${gated?.network ?? 'none'}, not ${token.code}`,
      );
    }
    if (gated?.currency !== undefined && gated.currency !== token.coin) {
      throw hold('WRONG_COIN', `Binance answered for ${gated.currency}, not ${token.coin}`);
    }
    const raw = await read('call_implicit_get', {
      exchange: 'binance',
      account: alias,
      method: 'sapiGetCapitalDepositAddressList',
      params: { coin: token.coin, network: token.ids.binance },
    });
    if (!Array.isArray(raw)) throw hold('BAD_RESPONSE', 'Binance address list is not a list');
    const current = only(
      raw.filter((entry) => entry?.isDefault === 1),
      'default Binance deposit address (isDefault: 1)',
    );
    if (current.coin !== undefined && current.coin !== token.coin) {
      throw hold('WRONG_COIN', `the Binance address row is for ${current.coin}, not ${token.coin}`);
    }
    const memo = memoValue(current.tag, { field: 'tag', venue: 'Binance' });
    checkAddress(token, current.address, 'Binance');
    if (current.address !== gated.info?.address || (current.tag ?? null) !== (gated.info?.tag ?? null)) {
      throw hold('READS_DISAGREE', 'Binance gated and raw address reads disagree');
    }
    return {
      address: current.address,
      memo,
      venueNetwork: token.ids.binance,
      reads: ['fetchDepositWithdrawFee', 'fetchDepositAddress', 'sapiGetCapitalDepositAddressList'],
      lands: 'Spot (Binance typical; the response names no wallet)',
    };
  },

  /**
   * B's deposit facts. Binance's reference names no deposit minimum on the network row
   * (`depositDust` has only an example value), so:
   * - a `depositMin` on the row, if Binance ever supplies one, is the venue's minimum and is
   *   applied whatever its value (0 included); an unreadable one holds;
   * - otherwise Fundkit's operator fallback (one unit of the coin) applies on every chain, only
   *   when the row is healthy and nothing contradicts it: `busy` holds, and `depositDust` is
   *   never a minimum, only a reason not to assume one (unreadable or above the fallback holds).
   * The recipient has been read and verified before this is called.
   */
  async destination(read, alias, token) {
    const { row } = await this.networkRow(read, alias, token);
    if (row.depositEnable !== true) {
      throw hold(
        'DEPOSIT_DISABLED',
        `Binance has ${token.coin} deposits on ${token.ids.binance} disabled now`,
      );
    }
    const present = Object.hasOwn(row, 'depositMin');
    if (!present && row.busy === true) {
      throw hold(
        'DESTINATION_BUSY',
        `Binance marks ${token.coin} deposits on ${token.ids.binance} busy now, so no minimum is assumed`,
      );
    }
    const { depositMin, minimum } = resolveMinimum({
      exchange: 'binance',
      coin: token.coin,
      networkLabel: token.label,
      published: { present, value: row.depositMin },
      field: 'Binance networkList depositMin',
      contrary: (floor) => {
        if (row.depositDust === undefined || row.depositDust === null) return null;
        const dust = parseDecimal(row.depositDust);
        return dust === null || dust > floor
          ? `Binance depositDust ${JSON.stringify(row.depositDust)}`
          : null;
      },
    });
    return { depositEnabled: true, depositFee: this.depositFee, inboundCap: null, depositMin, minimum };
  },

  async source(read, alias, token) {
    const { row } = await this.networkRow(read, alias, token);
    if (row.withdrawEnable !== true) {
      throw hold(
        'WITHDRAW_DISABLED',
        `Binance has ${token.coin} withdrawals on ${token.ids.binance} disabled now`,
      );
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
        free = freeOf(balance, token.coin);
      } catch {
        // An unreadable wallet is reported as such and never chosen.
      }
      wallets.push({ wallet, walletType, free });
    }
    return {
      fee,
      feeAsset: token.coin,
      feeModel: 'unconfirmed',
      min,
      max,
      step,
      wallets,
      fields: 'networkList withdrawEnable, withdrawFee, withdrawMin, withdrawMax, withdrawIntegerMultiple',
    };
  },

  withdrawArgs({ alias, amount, recipient, token, wallet }) {
    return {
      account: alias,
      code: token.coin,
      amount,
      address: recipient.address,
      ...(recipient.memo ? { tag: recipient.memo } : {}),
      network: token.code,
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

  async coinInfo(read, alias, token) {
    const data = await read('call_read_method', {
      exchange: 'bybit',
      account: alias,
      method: 'fetchDepositWithdrawFee',
      args: [token.coin],
      includeInfo: true,
    });
    const info = data?.info;
    if (info?.coin !== token.coin) {
      throw hold('BAD_RESPONSE', `the Bybit coin info is for ${info?.coin ?? 'no coin'}, not ${token.coin}`);
    }
    const row = only(
      (info?.chains ?? []).filter((chain) => chain?.chain === token.ids.bybit),
      `Bybit ${token.coin} chain ${token.ids.bybit} in coin info`,
    );
    if (!sameContract(token, row.contractAddress)) {
      throw hold(
        'CONTRACT_MISMATCH',
        `Bybit ${token.ids.bybit} contract is not the ${token.coin} ${token.label} contract`,
      );
    }
    return { info, row };
  },

  async recipient(read, alias, token, keyFacts) {
    if (keyFacts?.rights?.isMaster !== true) {
      throw hold(
        'KEY_NOT_MAIN_ACCOUNT',
        'Bybit gives deposit addresses only to main-account keys (isMaster is not true)',
      );
    }
    const { row } = await this.coinInfo(read, alias, token);
    if (String(row.chainDeposit) !== '1') {
      throw hold('DEPOSIT_DISABLED', `Bybit has ${token.coin} deposits on ${token.ids.bybit} suspended now`);
    }
    const gated = await read('call_read_method', {
      exchange: 'bybit',
      account: alias,
      method: 'fetchDepositAddressesByNetwork',
      args: [token.coin],
      params: { network: token.code },
      includeInfo: true,
    });
    const keys = Object.keys(gated ?? {});
    if (keys.length !== 1 || keys[0] !== token.code) {
      throw hold('WRONG_CHAIN', `Bybit answered for ${keys.join(', ') || 'no network'}, not ${token.code}`);
    }
    const gatedCurrency = gated[token.code].currency;
    if (gatedCurrency !== undefined && gatedCurrency !== token.coin) {
      throw hold('WRONG_COIN', `Bybit answered for ${gatedCurrency}, not ${token.coin}`);
    }
    const info = gated[token.code].info ?? {};
    const raw = await read('call_implicit_get', {
      exchange: 'bybit',
      account: alias,
      method: 'privateGetV5AssetDepositQueryAddress',
      params: { coin: token.coin, chainType: info.chain },
    });
    if (raw?.retCode !== 0 || raw.result?.coin !== token.coin) {
      throw hold('BAD_RESPONSE', `Bybit address response is not ${token.coin} or retCode is not 0`);
    }
    const entry = only(raw.result.chains ?? [], `Bybit ${token.coin} address on ${token.ids.bybit}`);
    if (entry.chain !== token.ids.bybit) {
      throw hold('WRONG_CHAIN', `Bybit raw row is for ${entry.chain}, not ${token.ids.bybit}`);
    }
    for (const field of ['chain', 'addressDeposit', 'tagDeposit', 'contractAddress']) {
      if (entry[field] !== info[field]) {
        throw hold('READS_DISAGREE', `Bybit gated and raw reads disagree on ${field}`);
      }
    }
    if (!contractSuffixMatches(token, entry.contractAddress)) {
      throw hold(
        'CONTRACT_MISMATCH',
        `Bybit address row contract suffix does not end the ${token.coin} ${token.label} contract`,
      );
    }
    const memo = memoValue(entry.tagDeposit, { field: 'tagDeposit', venue: 'Bybit' });
    checkAddress(token, entry.addressDeposit, 'Bybit');
    return {
      address: entry.addressDeposit,
      memo,
      venueNetwork: token.ids.bybit,
      batchReleaseLimit: entry.batchReleaseLimit,
      reads: [
        'fetchDepositWithdrawFee',
        'fetchDepositAddressesByNetwork',
        'privateGetV5AssetDepositQueryAddress',
      ],
      lands: 'Funding (Bybit)',
    };
  },

  /**
   * B's deposit facts. Bybit publishes `depositMin` per chain: present, it is applied whatever its
   * value (0 included) and an unreadable one holds; absent from an otherwise healthy row, Fundkit's
   * operator fallback (one unit of the coin) applies and the plan is read again before submission.
   */
  async destination(read, alias, token, recipient) {
    const { row } = await this.coinInfo(read, alias, token);
    if (String(row.chainDeposit) !== '1') {
      throw hold('DEPOSIT_DISABLED', `Bybit has ${token.coin} deposits on ${token.ids.bybit} suspended now`);
    }
    if (recipient?.batchReleaseLimit !== '-1') {
      throw hold(
        'INBOUND_CAP',
        `Bybit caps credited deposits on ${token.ids.bybit} (batchReleaseLimit ${JSON.stringify(recipient?.batchReleaseLimit)}); ` +
          'the remaining allowance is not readable, so no transfer is planned',
      );
    }
    const { depositMin, minimum } = resolveMinimum({
      exchange: 'bybit',
      coin: token.coin,
      networkLabel: token.label,
      published: { present: Object.hasOwn(row, 'depositMin'), value: row.depositMin },
      field: 'Bybit chains[].depositMin',
    });
    return {
      depositEnabled: true,
      depositFee: this.depositFee,
      depositMin,
      minimum,
      inboundCap: 'unlimited (-1)',
    };
  },

  async source(read, alias, token) {
    const { info, row } = await this.coinInfo(read, alias, token);
    if (String(row.chainWithdraw) !== '1') {
      throw hold(
        'WITHDRAW_DISABLED',
        `Bybit has ${token.coin} withdrawals on ${token.ids.bybit} suspended now`,
      );
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
      feeAsset: token.coin,
      feeModel: 'on top',
      min,
      max,
      step,
      wallets: [{ wallet: 'funding', accountType: 'FUND', free: freeOf(balance, token.coin) }],
      fields:
        'coin info chains[] chainWithdraw, withdrawFee, withdrawPercentageFee, withdrawMin, minAccuracy; remainAmount',
    };
  },

  withdrawArgs({ alias, amount, recipient, token, wallet }) {
    return {
      account: alias,
      code: token.coin,
      amount,
      address: recipient.address,
      ...(recipient.memo ? { tag: recipient.memo } : {}),
      network: token.code,
      params: { accountType: wallet.accountType },
    };
  },
};

export const NATIVE_VENUES = Object.freeze({ binance, bybit });

export function nativeVenue(exchange) {
  return NATIVE_VENUES[exchange] ?? null;
}

export { NETWORKS };
