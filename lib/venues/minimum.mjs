// The destination's deposit minimum and the amounts it is checked against.
//
// Fundkit sets no deposit minimum of its own, for any of the nine destinations. A minimum has a
// basis:
// - `venue`: the destination venue's own published field for that coin and chain (Bybit
//   `depositMin`, or a `depositMin` Binance supplies on its network row), enforced on the
//   conservative credit whatever its value, 0 included;
// - `venue-unpublished`: the venue's healthy lookup for that chain publishes none. The venue
//   minimum is recorded as unknown (never 0), any positive credit qualifies, and the plan carries
//   a non-binding recommendation of at least 1 USDT. That figure is advice only: it is never
//   compared with an amount, never a threshold and never a guarantee of the credit.
// A field that is present but not an exact decimal holds, and so does an unhealthy read or
// contrary evidence; none of them is ever reported as "not published".
// Rules: references/deposit-minimum.md.

import { formatDecimal, parseDecimal } from './decimal.mjs';
import { hold } from './hold.mjs';

export const VENUE_BASIS = 'venue';
export const UNPUBLISHED_BASIS = 'venue-unpublished';

/** The nine supported destinations; every one follows the same rule. */
export const DESTINATIONS = Object.freeze({
  binance: 'Binance',
  bybit: 'Bybit',
  okx: 'OKX',
  bitget: 'Bitget',
  gate: 'Gate',
  kucoin: 'KuCoin',
  mexc: 'MEXC',
  bingx: 'BingX',
  whitebit: 'WhiteBIT',
});

/** fundkit supports USDT only. */
export const COINS = Object.freeze(['USDT']);

/**
 * The advice shown wherever a destination's minimum is unknown: the address and QR, a wallet
 * top-up sheet, the transfer plan and its card. A recommendation only, never a check.
 */
export const RECOMMENDATION = Object.freeze({ value: '1', coin: 'USDT' });
export const UNPUBLISHED_ADVICE =
  'The exchange has not published a minimum for this network. ' +
  `Fundkit recommends depositing at least ${RECOMMENDATION.value} ${RECOMMENDATION.coin}.`;
/** The same advice in a transfer plan: in the chat summary before the card, and on the card. */
export const UNKNOWN_NOTICE =
  'Destination deposit minimum unknown. ' +
  `Fundkit recommends depositing at least ${RECOMMENDATION.value} ${RECOMMENDATION.coin}.`;
export const UNREADABLE_ADVICE =
  "The exchange's minimum for this network could not be read, so Fundkit does not know it. " +
  `Fundkit recommends depositing at least ${RECOMMENDATION.value} ${RECOMMENDATION.coin}.`;

function scope(exchange, coin) {
  if (!COINS.includes(coin)) {
    throw hold('UNSUPPORTED_COIN', `fundkit supports USDT only, not ${JSON.stringify(coin ?? null)}`);
  }
  const venue = DESTINATIONS[exchange];
  if (!venue) throw hold('VENUE_NOT_SUPPORTED', `${exchange} is not a supported destination`);
  return venue;
}

/** The plan's minimum record for a venue's own value. */
export function venueMinimum(units, field, coin) {
  const value = formatDecimal(units);
  return { value, coin, basis: VENUE_BASIS, field, venueMinimum: value };
}

/**
 * The plan's minimum record when the venue publishes none: unknown, never 0. `uninterpreted`
 * names fields the venue returned whose meaning it does not document (bound into the plan so a
 * change makes it stale, never treated as the minimum).
 */
export function unpublishedMinimum({ venue, coin, networkLabel, field, uninterpreted }) {
  return {
    value: null,
    coin,
    basis: UNPUBLISHED_BASIS,
    field,
    venueMinimum: 'unknown',
    notice: UNKNOWN_NOTICE,
    advice: UNPUBLISHED_ADVICE,
    statement:
      `${venue} publishes no deposit minimum for ${coin} on ${networkLabel}. ` +
      'Fundkit sets no minimum of its own; any positive credit qualifies and the credit is not guaranteed.',
    ...(uninterpreted ? { uninterpreted } : {}),
  };
}

/**
 * The destination minimum from one healthy venue read:
 * - `published.present` false (the venue's row has no minimum field): unknown, `depositMin` null;
 * - present and an exact nonnegative decimal (0 included): the venue's own minimum;
 * - present otherwise (null, empty, text, negative): hold, never "unknown".
 * Returns `{ depositMin, minimum }` with `depositMin` in units, or null when unknown.
 */
export function resolveMinimum({ exchange, coin, networkLabel, published, field, uninterpreted }) {
  const venue = scope(exchange, coin);
  if (published.present) {
    const units = parseDecimal(published.value);
    if (units === null) {
      throw hold(
        'DESTINATION_MINIMUM_UNREADABLE',
        `${venue} ${field} for ${coin} on ${networkLabel} is present but not an exact decimal ` +
          `(${JSON.stringify(published.value ?? null)}), so no minimum is assumed`,
      );
    }
    return { depositMin: units, minimum: venueMinimum(units, field, coin) };
  }
  return {
    depositMin: null,
    minimum: unpublishedMinimum({ venue, coin, networkLabel, field, uninterpreted }),
  };
}

/**
 * The minimum as the address-only flow shows it, from the network row that flow already reads.
 * It never throws and never blocks the address or QR: no amount is involved.
 */
export function describeMinimum({ exchange, coin, networkLabel, published, field }) {
  const venue = DESTINATIONS[exchange] ?? exchange;
  if (!published.present) {
    return { status: 'unpublished', venueMinimum: 'unknown', field, advice: UNPUBLISHED_ADVICE };
  }
  const units = parseDecimal(published.value);
  if (units === null) {
    return {
      status: 'unreadable',
      venueMinimum: 'unknown',
      field,
      detail: `${venue} ${field} is present but not an exact decimal (${JSON.stringify(published.value ?? null)})`,
      advice: UNREADABLE_ADVICE,
    };
  }
  const value = formatDecimal(units);
  return {
    status: 'published',
    value,
    coin,
    field,
    venueMinimum: value,
    text: `${venue} publishes a deposit minimum of ${value} ${coin} on ${networkLabel} (${field}).`,
  };
}

/** Whether a plan's destination minimum is unknown (and so is read again before submission). */
export function minimumUnknown(plan) {
  return plan?.destination?.minimum?.basis === UNPUBLISHED_BASIS;
}

/**
 * What leaves the source and what arrives, in exact units. `on top`: the fee is added to the
 * debit; any other model is treated as possibly taken from the amount, so the conservative
 * credit subtracts it. The destination's deposit fee is always subtracted.
 */
export function transferAmounts({ amount, fee, feeModel, depositFee }) {
  const onTop = feeModel === 'on top';
  return {
    debit: { min: onTop ? amount + fee : amount, max: amount + fee },
    credit: { min: onTop ? amount - depositFee : amount - fee - depositFee, max: amount - depositFee },
  };
}

/**
 * Hold unless the conservative credit is positive and, where the venue publishes a minimum,
 * reaches it (inclusive). An unknown minimum adds no threshold, and the 1 USDT recommendation
 * is never compared. `destination.contrary` (`{ units, field, raw }`): a venue field whose
 * meaning is undocumented; a credit at or below it holds as contrary evidence, never as a
 * minimum. The coin is the plan's coin; every message names it.
 */
export function checkDestinationMinimum(creditMin, destination, venueLabel, coin) {
  const credit = formatDecimal(creditMin);
  if (creditMin <= 0n) {
    throw hold(
      'CREDIT_NOT_POSITIVE',
      `the expected credit after fees is ${credit} ${coin}, so nothing would arrive`,
    );
  }
  const unknown = destination.minimum?.basis === UNPUBLISHED_BASIS;
  if (destination.depositMin === null || destination.depositMin === undefined) {
    if (!unknown) {
      throw hold(
        'DESTINATION_MINIMUM_UNDOCUMENTED',
        destination.depositMinReason ?? `${venueLabel} names no deposit minimum`,
      );
    }
    const contrary = destination.contrary;
    if (contrary && creditMin <= contrary.units) {
      throw hold(
        'DESTINATION_MINIMUM_CONTRARY',
        `${venueLabel} reports ${contrary.field} ${JSON.stringify(contrary.raw)} and the expected credit after ` +
          `fees is ${credit} ${coin}; ${venueLabel} documents no meaning for that field, so it is not the ` +
          'minimum, but fundkit does not send at or below it',
      );
    }
    return;
  }
  if (creditMin >= destination.depositMin) return;
  const min = formatDecimal(destination.depositMin);
  throw hold(
    'BELOW_DEPOSIT_MIN',
    `${venueLabel} credits deposits from ${min} ${coin}; the expected credit after fees is ${credit} ${coin}`,
  );
}

/** A plan minimum record as the chat summary shows it (the card adds its label to a known one). */
export function minimumText(minimum, coin = minimum.coin) {
  if (minimum.basis === UNPUBLISHED_BASIS) return minimum.notice;
  return `${minimum.value} ${coin}, venue minimum (${minimum.field})`;
}
