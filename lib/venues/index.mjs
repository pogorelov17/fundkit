// Native venue adapters: the exact reads behind fundkit_deposit_address and the transfer tools.
//
// Each adapter works through `read(tool, args)`, which calls one ccxt-mcp tool on a session
// profile (the session daemon still decides every call by the profile's role) and returns the
// envelope's `data`. Every check that fails throws a hold: an error with `hold: true`, a code
// and the exact reason. Nothing here guesses a field, derives one from another, or asks the
// user to look anything up. Rules and field meanings: references/recipients.md and
// references/exchanges.md.
//
// fundkit supports USDT only: every read below asks for USDT, and an answer for another coin
// holds. The native tools refuse any other coin before a session or a read.

import { NETWORKS, addressShapeOk, contractSuffixMatches, sameContract } from './networks.mjs';
import { parseDecimal, stepFromDecimals } from './decimal.mjs';
import { hold } from './hold.mjs';
import { describeMinimum, resolveMinimum } from './minimum.mjs';

export { hold };

const COIN = 'USDT';
const BINANCE_MIN_FIELD = 'Binance networkList depositMin';
const BYBIT_MIN_FIELD = 'Bybit chains[].depositMin';

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
    throw hold('ADDRESS_IS_CONTRACT', `${venue} returned the USDT network contract, not a deposit address`);
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
      args: [COIN],
      includeInfo: true,
    });
    if (data?.info?.coin !== COIN) {
      throw hold(
        'BAD_RESPONSE',
        `the Binance network list is for ${data?.info?.coin ?? 'no coin'}, not USDT`,
      );
    }
    const rows = (data?.info?.networkList ?? []).filter((row) => row?.network === network.ids.binance);
    const row = only(rows, `Binance USDT network ${network.ids.binance} in networkList`);
    if (row.coin !== undefined && row.coin !== COIN) {
      throw hold('BAD_RESPONSE', `the Binance ${network.ids.binance} row is for ${row.coin}, not USDT`);
    }
    if (!sameContract(network, row.contractAddress)) {
      throw hold(
        'CONTRACT_MISMATCH',
        `Binance ${network.ids.binance} contract is not the USDT ${network.label} contract`,
      );
    }
    return { row };
  },

  async recipient(read, alias, network) {
    const { row } = await this.networkRow(read, alias, network);
    if (row.depositEnable !== true) {
      throw hold('DEPOSIT_DISABLED', `Binance has USDT deposits on ${network.ids.binance} disabled now`);
    }
    const gated = await read('call_read_method', {
      exchange: 'binance',
      account: alias,
      method: 'fetchDepositAddress',
      args: [COIN],
      params: { network: network.code },
      includeInfo: true,
    });
    if (gated?.network !== network.code) {
      throw hold(
        'WRONG_CHAIN',
        `Binance answered for network ${gated?.network ?? 'none'}, not ${network.code}`,
      );
    }
    if (gated?.currency !== undefined && gated.currency !== COIN) {
      throw hold('WRONG_COIN', `Binance answered for ${gated.currency}, not USDT`);
    }
    const raw = await read('call_implicit_get', {
      exchange: 'binance',
      account: alias,
      method: 'sapiGetCapitalDepositAddressList',
      params: { coin: COIN, network: network.ids.binance },
    });
    if (!Array.isArray(raw)) throw hold('BAD_RESPONSE', 'Binance address list is not a list');
    const current = only(
      raw.filter((entry) => entry?.isDefault === 1),
      'default Binance deposit address (isDefault: 1)',
    );
    if (current.coin !== undefined && current.coin !== COIN) {
      throw hold('WRONG_COIN', `the Binance address row is for ${current.coin}, not USDT`);
    }
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
      depositMinimum: describeMinimum({
        exchange: 'binance',
        coin: COIN,
        networkLabel: network.label,
        published: { present: Object.hasOwn(row, 'depositMin'), value: row.depositMin },
        field: BINANCE_MIN_FIELD,
      }),
    };
  },

  /**
   * B's deposit facts. Binance's reference names no deposit minimum on the network row, so:
   * - a `depositMin` on the row, if Binance ever supplies one, is the venue's minimum and is
   *   enforced whatever its value (0 included); an unreadable one holds;
   * - otherwise the minimum is unknown on every chain and Fundkit sets none of its own, only
   *   when the row is healthy: `busy` holds. `depositDust` has only an example value in the
   *   reference and no documented meaning, so it is never the minimum: an unreadable value
   *   holds (the row is not healthy), a readable one is bound into the plan and a credit at or
   *   below it holds as contrary evidence (checkDestinationMinimum).
   * The recipient has been read and verified before this is called.
   */
  async destination(read, alias, network) {
    const { row } = await this.networkRow(read, alias, network);
    if (row.depositEnable !== true) {
      throw hold('DEPOSIT_DISABLED', `Binance has USDT deposits on ${network.ids.binance} disabled now`);
    }
    const present = Object.hasOwn(row, 'depositMin');
    let contrary = null;
    if (!present) {
      if (row.busy === true) {
        throw hold(
          'DESTINATION_BUSY',
          `Binance marks USDT deposits on ${network.ids.binance} busy now, so the route is not planned`,
        );
      }
      if (row.depositDust !== undefined && row.depositDust !== null) {
        const units = parseDecimal(row.depositDust);
        if (units === null) {
          throw hold(
            'DESTINATION_FIELD_UNREADABLE',
            `Binance depositDust for USDT on ${network.ids.binance} is not an exact decimal ` +
              `(${JSON.stringify(row.depositDust)}), so the network row is not healthy`,
          );
        }
        contrary = { units, field: 'Binance networkList depositDust', raw: row.depositDust };
      }
    }
    const { depositMin, minimum } = resolveMinimum({
      exchange: 'binance',
      coin: COIN,
      networkLabel: network.label,
      published: { present, value: row.depositMin },
      field: BINANCE_MIN_FIELD,
      uninterpreted: contrary ? { 'Binance networkList depositDust': row.depositDust } : undefined,
    });
    return {
      depositEnabled: true,
      depositFee: this.depositFee,
      inboundCap: null,
      depositMin,
      minimum,
      contrary,
    };
  },

  async source(read, alias, network) {
    const { row } = await this.networkRow(read, alias, network);
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
      feeAsset: COIN,
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
      code: COIN,
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
      args: [COIN],
      includeInfo: true,
    });
    const info = data?.info;
    if (info?.coin !== COIN) {
      throw hold('BAD_RESPONSE', `the Bybit coin info is for ${info?.coin ?? 'no coin'}, not USDT`);
    }
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
    const depositMinimum = describeMinimum({
      exchange: 'bybit',
      coin: COIN,
      networkLabel: network.label,
      published: { present: Object.hasOwn(row, 'depositMin'), value: row.depositMin },
      field: BYBIT_MIN_FIELD,
    });
    const gated = await read('call_read_method', {
      exchange: 'bybit',
      account: alias,
      method: 'fetchDepositAddressesByNetwork',
      args: [COIN],
      params: { network: network.code },
      includeInfo: true,
    });
    const keys = Object.keys(gated ?? {});
    if (keys.length !== 1 || keys[0] !== network.code) {
      throw hold('WRONG_CHAIN', `Bybit answered for ${keys.join(', ') || 'no network'}, not ${network.code}`);
    }
    const gatedCurrency = gated[network.code].currency;
    if (gatedCurrency !== undefined && gatedCurrency !== COIN) {
      throw hold('WRONG_COIN', `Bybit answered for ${gatedCurrency}, not USDT`);
    }
    const info = gated[network.code].info ?? {};
    const raw = await read('call_implicit_get', {
      exchange: 'bybit',
      account: alias,
      method: 'privateGetV5AssetDepositQueryAddress',
      params: { coin: COIN, chainType: info.chain },
    });
    if (raw?.retCode !== 0 || raw.result?.coin !== COIN) {
      throw hold('BAD_RESPONSE', `Bybit address response is not USDT or retCode is not 0`);
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
      depositMinimum,
    };
  },

  /**
   * B's deposit facts. Bybit publishes `depositMin` per chain: present, it is enforced whatever its
   * value (0 included) and an unreadable one holds; absent from an otherwise healthy row, the
   * minimum is unknown, Fundkit sets none and the plan is read again before submission.
   */
  async destination(read, alias, network, recipient) {
    const { row } = await this.coinInfo(read, alias, network);
    if (String(row.chainDeposit) !== '1') {
      throw hold('DEPOSIT_DISABLED', `Bybit has USDT deposits on ${network.ids.bybit} suspended now`);
    }
    if (recipient?.batchReleaseLimit !== '-1') {
      throw hold(
        'INBOUND_CAP',
        `Bybit caps credited deposits on ${network.ids.bybit} (batchReleaseLimit ${JSON.stringify(recipient?.batchReleaseLimit)}); ` +
          'the remaining allowance is not readable, so no transfer is planned',
      );
    }
    const { depositMin, minimum } = resolveMinimum({
      exchange: 'bybit',
      coin: COIN,
      networkLabel: network.label,
      published: { present: Object.hasOwn(row, 'depositMin'), value: row.depositMin },
      field: BYBIT_MIN_FIELD,
    });
    return {
      depositEnabled: true,
      depositFee: this.depositFee,
      depositMin,
      minimum,
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
      feeAsset: COIN,
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
      code: COIN,
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
